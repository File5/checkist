from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from django.test import SimpleTestCase, TestCase, tag

from api import common
from api.common import CategoryLimitExceeded, CategoryTree
from api.tests import factories
from catalog.models import Brand, Category, Product
from catalog.units import Unit
from config.exceptions import ObjectNotFound
from stores.models import Store

D = Decimal


class NumberTests(SimpleTestCase):
    def test_places(self):
        self.assertEqual(common.price(D("130.58823529")), "130.5882")
        self.assertEqual(common.price(D("1.05")), "1.0500")
        self.assertEqual(common.amount(D("0")), "0.00")
        self.assertEqual(common.quantity(D("850")), "850.000")
        self.assertEqual(common.percent(D("3.8095")), "3.81")
        self.assertEqual(common.price(189490), "189490.0000")

    def test_rounding_is_half_up(self):
        # Банковское округление дало бы 0.12 и 2.9932.
        self.assertEqual(common.amount(D("0.125")), "0.13")
        self.assertEqual(common.price(D("2.99325")), "2.9933")
        self.assertEqual(common.percent(D("-0.005")), "-0.01")

    def test_none_stays_none(self):
        for function in (common.price, common.amount, common.quantity, common.percent):
            self.assertIsNone(function(None))

    def test_float_is_rejected(self):
        for value in (1.05, True):
            with self.subTest(value=value), self.assertRaises(TypeError):
                common.price(value)

    def test_utc_datetime(self):
        berlin = timezone(timedelta(hours=2))
        self.assertEqual(common.utc_datetime(datetime(2026, 6, 2, 18, 12, tzinfo=berlin)), "2026-06-02T16:12:00Z")
        self.assertEqual(
            common.utc_datetime(datetime(2026, 6, 14, 9, 31, tzinfo=timezone.utc)), "2026-06-14T09:31:00Z",
        )
        self.assertIsNone(common.utc_datetime(None))

    def test_iso_date(self):
        self.assertEqual(common.iso_date(date(2026, 6, 2)), "2026-06-02")
        self.assertIsNone(common.iso_date(None))


class CategoryTreeTests(SimpleTestCase):
    """Дерево из строк ``(id, name, parent_id)`` — без БД."""

    def test_paths_depths_and_order(self):
        tree = CategoryTree([(1, "Продукты", None), (2, "Молочные", 1), (3, "Бакалея", 1), (4, "Сыр", 2), (5, "Авто", None)])
        self.assertEqual(tree.path(4), [{"id": 1, "name": "Продукты"}, {"id": 2, "name": "Молочные"}, {"id": 4, "name": "Сыр"}])
        self.assertEqual(tree.category(2), {
            "id": 2, "name": "Молочные", "path": [{"id": 1, "name": "Продукты"}, {"id": 2, "name": "Молочные"}],
        })
        self.assertEqual([tree.depth(pk) for pk in (1, 2, 4, 5)], [0, 1, 2, 0])
        self.assertEqual(tree.roots(), [5, 1])  # по названию: «Авто», «Продукты»
        self.assertEqual(tree.children(1), [3, 2])  # «Бакалея», «Молочные»
        self.assertEqual(tree.ordered_ids(), [5, 1, 3, 2, 4])
        self.assertEqual(sorted(tree.descendant_ids(1)), [1, 2, 3, 4])
        self.assertEqual(tree.descendant_ids(4), [4])
        self.assertEqual((len(tree), 4 in tree, 99 in tree), (5, True, False))

    def test_siblings_with_equal_names_are_ordered_by_id(self):
        tree = CategoryTree([(3, "Х", None), (1, "Х", None), (2, "Х", None)])
        self.assertEqual(tree.roots(), [1, 2, 3])

    def test_cycle_nodes_are_roots_and_walks_terminate(self):
        # 1 -> 2 -> 3 -> 1 — цикл; 4 висит под 2; 5 — обычный корень с потомком 6.
        tree = CategoryTree([(1, "А", 3), (2, "Б", 1), (3, "В", 2), (4, "Г", 2), (5, "Д", None), (6, "Е", 5)])
        for pk in (1, 2, 3):
            self.assertEqual((tree.path_ids(pk), tree.depth(pk)), ([pk], 0))
        self.assertEqual(tree.parent_id(1), 3)  # как в БД
        self.assertEqual(tree.path_ids(4), [2, 4])
        self.assertEqual(tree.roots(), [1, 2, 3, 5])
        self.assertEqual(tree.children(2), [4])
        self.assertEqual(tree.descendant_ids(1), [1])
        self.assertEqual(sorted(tree.descendant_ids(2)), [2, 4])
        self.assertEqual(tree.ordered_ids(), [1, 2, 4, 3, 5, 6])

    def test_self_parent_and_missing_parent(self):
        tree = CategoryTree([(1, "Сам себе", 1), (2, "Сирота", 99), (3, "Под сиротой", 2)])
        self.assertEqual(tree.path_ids(1), [1])
        self.assertEqual(tree.path_ids(3), [2, 3])
        self.assertEqual(tree.roots(), [1, 2])
        self.assertEqual(tree.parent_id(2), 99)

    def test_deep_chain_does_not_recurse(self):
        size = 5000
        tree = CategoryTree([(pk, f"Узел {pk}", pk - 1 if pk > 1 else None) for pk in range(1, size + 1)])
        self.assertEqual(tree.depth(size), size - 1)
        self.assertEqual(len(tree.ordered_ids()), size)
        self.assertEqual(len(tree.descendant_ids(1)), size)

    def test_empty_tree(self):
        tree = CategoryTree([])
        self.assertEqual((tree.roots(), tree.ordered_ids(), len(tree)), ([], [], 0))


@tag("integration")
class ObjectTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = factories.save_samples()

    def test_store_name_rule(self):
        # Lidl: есть вывеска. Магазин в RU: вывески нет, есть название.
        self.assertEqual(common.store_name(self.data.lidl_store), "Lidl")
        self.assertEqual(common.store_name(self.data.shop_store), "Магазин «Елена»")
        nameless = Store.objects.create(
            merchant=self.data.shop_store.merchant, country_id="RU", address_raw="г. Тестоград, ул. Примерная, 1",
            timezone="Europe/Moscow",
        )
        self.assertEqual(common.store_name(nameless), f"Магазин №{nameless.pk}")

    def test_store_objects_have_no_merchant_details(self):
        store = Store.objects.select_related("merchant").get(pk=self.data.shop_store.pk)
        with self.assertNumQueries(0):
            full, brief = common.store_object(store), common.store_brief(store)
        self.assertEqual(full, {
            "id": store.pk, "name": "Магазин «Елена»", "city": "Кемерово", "address": store.address_raw,
            "country": "RU", "timezone": "Asia/Novokuznetsk",
        })
        self.assertEqual(brief, {"id": store.pk, "name": "Магазин «Елена»", "city": "Кемерово", "country": "RU"})
        merchant = store.merchant
        for secret in (merchant.legal_name, merchant.tax_id, "Соколов"):
            self.assertNotIn(secret, str(full) + str(brief))

    def test_brief_objects(self):
        samsung = Brand.objects.get(name="Samsung")
        self.assertEqual(common.brand_brief(samsung), {"id": samsung.pk, "name": "Samsung"})
        self.assertIsNone(common.brand_brief(None))
        self.assertEqual(common.package(self.data.shop_milk), {"quantity": "850.000", "unit": "ml"})
        self.assertIsNone(common.package(self.data.lidl_milk))
        half = factories.make_product(self.data.milk, "Молоко 0,449 л", package=("0.449", Unit.L))
        self.assertEqual(common.package(half), {"quantity": "0.449", "unit": "l"})
        self.assertEqual(
            common.generic_brief(self.data.milk), {"id": self.data.milk.pk, "name": "Молоко", "base_unit": "l"},
        )

    def test_get_or_404(self):
        products = Product.objects.select_related("generic")
        self.assertEqual(common.get_or_404(products, self.data.ssd.pk), self.data.ssd)
        for pk in (self.data.ssd.pk + 1000, 2**63, 10**30):
            with self.subTest(pk=pk), self.assertRaises(ObjectNotFound):
                common.get_or_404(products, pk)

    def test_category_tree_is_one_query(self):
        with self.assertNumQueries(1):
            tree = CategoryTree.load()
            dairy = self.data.milk.category_id
            category = tree.category(dairy)
            tree.ordered_ids()
        food = Category.objects.get(name="Продукты питания")
        self.assertEqual(category, {
            "id": dairy, "name": "Молочные продукты",
            "path": [{"id": food.pk, "name": "Продукты питания"}, {"id": dairy, "name": "Молочные продукты"}],
        })
        self.assertEqual(sorted(tree.descendant_ids(food.pk)), sorted([food.pk, dairy]))

    def test_category_cycle_from_database(self):
        cycle = factories.category_cycle()
        tree = CategoryTree.load()
        self.assertEqual(tree.path(cycle.a.pk), [{"id": cycle.a.pk, "name": "Цикл А"}])
        self.assertEqual(tree.path_ids(cycle.b.pk), [cycle.b.pk])
        self.assertEqual(tree.path_ids(cycle.child.pk), [cycle.a.pk, cycle.child.pk])
        self.assertEqual(tree.parent_id(cycle.a.pk), cycle.b.pk)
        self.assertEqual(len(tree.ordered_ids()), Category.objects.count())

    def test_category_limit(self):
        self.assertEqual(len(CategoryTree.load(limit=3)), 3)
        with self.assertRaises(CategoryLimitExceeded):
            CategoryTree.load(limit=2)
