from django.test import TestCase, tag

from api.tests import factories
from api.tests.merge_factories import demo_groups
from merges import demo
from catalog.models import Category, GenericProduct
from catalog.units import BaseUnit
from receipts.tests import samples


def node(category, depth, path, children, generics, products, total):
    return {
        "id": category.pk, "name": category.name, "parent_id": category.parent_id, "depth": depth,
        "path": [{"id": item.pk, "name": item.name} for item in path],
        "children_count": children, "generic_products_count": generics,
        "products_count": products, "products_total": total,
    }


@tag("integration")
class CategoryTreeTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        samples.save_catalog()
        cls.food = Category.objects.get(name="Продукты питания")
        cls.dairy = Category.objects.get(name="Молочные продукты")
        cls.electronics = Category.objects.get(name="Электроника")
        cls.food_node = node(cls.food, 0, [cls.food], 1, 0, 0, 2)
        cls.dairy_node = node(cls.dairy, 1, [cls.food, cls.dairy], 0, 1, 2, 2)
        cls.electronics_node = node(cls.electronics, 0, [cls.electronics], 0, 1, 1, 1)

    def results(self, query=""):
        response = self.client.get(f"/api/categories/{query}")
        self.assertEqual(response.status_code, 200)
        return response.json()["results"]

    def test_exact_body_in_depth_first_order(self):
        with self.assertNumQueries(3):
            response = self.client.get("/api/categories/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"results": [self.food_node, self.dairy_node, self.electronics_node]})

    def test_category_without_products(self):
        empty = Category.objects.create(name="Пустая", parent=self.electronics)
        self.assertIn(node(empty, 1, [self.electronics, empty], 0, 0, 0, 0), self.results())

    def test_siblings_are_ordered_by_name(self):
        for name in ("Яйца", "Бакалея"):
            Category.objects.create(name=name, parent=self.food)
        self.assertEqual(
            [row["name"] for row in self.results()],
            ["Продукты питания", "Бакалея", "Молочные продукты", "Яйца", "Электроника"],
        )

    def test_totals_include_all_descendants(self):
        cheese = Category.objects.create(name="Сыры", parent=self.dairy)
        generic = GenericProduct.objects.create(name="Сыр", category=cheese, base_unit=BaseUnit.KG)
        factories.make_product(generic, "Сыр твёрдый")
        rows = {row["id"]: row for row in self.results()}
        self.assertEqual(
            [(rows[pk]["products_count"], rows[pk]["products_total"]) for pk in (self.food.pk, self.dairy.pk, cheese.pk)],
            [(0, 3), (2, 3), (1, 1)],
        )

    def test_search_keeps_matches_and_their_ancestors(self):
        cases = [
            ("?q=молоч", [self.food_node, self.dairy_node]),
            ("?q=ЭЛЕКТР", [self.electronics_node]),
            ("?q=продукты", [self.food_node, self.dairy_node]),  # оба названия содержат слово
            ("?q=питания", [self.food_node]),  # потомки совпавшего узла не добавляются
            ("?q=нет такого", []),
            ("?q=", [self.food_node, self.dairy_node, self.electronics_node]),
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.results(query), expected)

    def test_cycle_does_not_loop(self):
        cycle = factories.category_cycle()
        a = node(cycle.a, 0, [cycle.a], 1, 0, 0, 0)
        b = node(cycle.b, 0, [cycle.b], 0, 0, 0, 0)
        child = node(cycle.child, 1, [cycle.a, cycle.child], 0, 0, 0, 0)
        self.assertEqual((a["parent_id"], b["parent_id"]), (cycle.b.pk, cycle.a.pk))
        self.assertEqual(
            self.results(), [self.food_node, self.dairy_node, a, child, b, self.electronics_node],
        )
        self.assertEqual(self.results("?q=под циклом"), [a, child])
        detail = self.client.get(f"/api/categories/{cycle.a.pk}/").json()
        self.assertEqual(detail, {**a, "children": [child], "generic_products": []})

    def test_query_count_does_not_grow_with_tree_size(self):
        parent = self.electronics
        for number in range(30):
            parent = Category.objects.create(name=f"Уровень {number:02}", parent=parent)
        with self.assertNumQueries(3):
            self.assertEqual(len(self.results()), 33)
        with self.assertNumQueries(4):
            self.client.get(f"/api/categories/{parent.pk}/")

    def test_detail(self):
        milk = GenericProduct.objects.get(name="Молоко")
        with self.assertNumQueries(4):
            response = self.client.get(f"/api/categories/{self.dairy.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            **self.dairy_node,
            "children": [],
            "generic_products": [{"id": milk.pk, "name": "Молоко", "base_unit": "l", "products_count": 2}],
        })
        self.assertEqual(self.client.get(f"/api/categories/{self.food.pk}/").json(), {
            **self.food_node, "children": [self.dairy_node], "generic_products": [],
        })

    def test_detail_generic_products_are_ordered_by_name(self):
        kefir = GenericProduct.objects.create(name="Кефир", category=self.dairy, base_unit=BaseUnit.L)
        body = self.client.get(f"/api/categories/{self.dairy.pk}/").json()
        self.assertEqual(body["generic_products"][0], {"id": kefir.pk, "name": "Кефир", "base_unit": "l", "products_count": 0})
        self.assertEqual([row["name"] for row in body["generic_products"]], ["Кефир", "Молоко"])
        self.assertEqual(body["generic_products_count"], 2)

    def test_detail_not_found(self):
        missing = max(Category.objects.values_list("pk", flat=True)) + 1000
        for pk in (missing, 0, 10**30):
            with self.subTest(pk=pk):
                response = self.client.get(f"/api/categories/{pk}/")
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"error": {"code": "not_found", "message": "Не найдено."}})


# --- ожидающее слияние дублей: поглощённые товары скрыты, формы ответов прежние ---
@tag("integration")
class PendingMergeCategoriesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo_groups()
        cls.category = Category.objects.get(name=demo.SERVICE_GENERIC_NAME)

    def test_tree_counters_skip_absorbed_products(self):
        with self.assertNumQueries(3):
            body = self.client.get("/api/categories/").json()
        node = next(item for item in body["results"] if item["id"] == self.category.pk)
        self.assertEqual((node["products_count"], node["products_total"], node["generic_products_count"]), (23, 23, 3))

    def test_detail_counters_skip_absorbed_products(self):
        with self.assertNumQueries(4):
            body = self.client.get(f"/api/categories/{self.category.pk}/").json()
        self.assertEqual((body["products_count"], body["products_total"]), (23, 23))
        self.assertEqual(
            {generic["name"]: generic["products_count"] for generic in body["generic_products"]},
            {demo.SERVICE_GENERIC_NAME: 22, demo.MILK_GENERIC: 1, demo.OTHER_MILK_GENERIC: 0},
        )
        self.assertEqual(set(body["generic_products"][0]), {"id", "name", "base_unit", "products_count"})
