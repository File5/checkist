from datetime import date, datetime, timezone
from decimal import Decimal

from django.db.models import Value
from django.test import SimpleTestCase, TestCase, tag

from catalog.models import Category, GenericProduct, Product
from receipts import spending
from receipts.models import Receipt
from receipts.spending import Collected, Item, LineRow, ProductInfo, ReceiptRow
from receipts.tests import samples
from receipts.tests.test_models import make_line

D = Decimal


class Tree:
    """Дерево категорий без БД: ``{id: (name, parent_id)}``."""

    def __init__(self, nodes):
        self.nodes = nodes

    def name(self, pk):
        return self.nodes[pk][0]

    def parent_id(self, pk):
        return self.nodes[pk][1]

    def path_ids(self, pk):
        path = []
        while pk is not None:
            path.insert(0, pk)
            pk = self.nodes[pk][1]
        return path

    def descendant_ids(self, pk):
        return [node for node in self.nodes if pk in self.path_ids(node)]


TREE = Tree({
    1: ("Продукты питания", None), 2: ("Молочные продукты", 1), 3: ("Сыры", 2), 4: ("Хлеб", 1),
    5: ("Бытовая химия", None), 9: ("Не разобрано", None), 8: ("Не разобрано", 5),
})
PRODUCTS = {
    10: ProductInfo("Молоко 1 л", 100, "Молоко", 2),
    11: ProductInfo("Сыр твёрдый", 101, "Сыр", 3),
    12: ProductInfo("Батон", 102, "Хлеб", 4),
    13: ProductInfo("Мыло", 103, "Мыло", 5),
    14: ProductInfo("ARTIKEL 77", 109, "Не разобрано", 9),
    15: ProductInfo("Набор продуктов", 104, "Наборы", 1),
    16: ProductInfo("Молоко 2 л", 100, "Молоко", 2),
}
STORES = {
    1: {"name": "Демо А", "city": "Musterstadt", "country": "DE"},
    2: {"name": "Демо Б", "city": "Beispielort", "country": "DE"},
}


def line(receipt, product, paid, *, kind="product", unit="pcs", currency="EUR", store=1, lines=1, quantity="1"):
    return LineRow(currency, receipt, store, product, kind, unit, D(paid), lines, D(quantity))


def data(lines, receipts=None):
    """``receipts`` по умолчанию — чеки с итогом, равным сумме их строк."""
    if receipts is None:
        sums = {}
        for row in lines:
            found = sums.setdefault((row.currency, row.store_id), {})
            found[row.receipt_id] = found.get(row.receipt_id, D("0.00")) + row.paid
        receipts = [
            ReceiptRow(currency, store, len(found), sum(found.values())) for (currency, store), found in sums.items()
        ]
    return Collected(lines, receipts, PRODUCTS)


def brief(block):
    return [(item.kind, item.id, item.amount) for item in block.items]


BASKET = [
    line(1, 10, "3.00", quantity="2"), line(1, 11, "4.50"), line(1, 12, "1.50"), line(1, 13, "3.00"),
    line(1, 14, "0.95"), line(1, 15, "7.00"), line(1, None, "1.20"),
    line(1, None, "4.00", kind="service"), line(1, None, "0.25", kind="deposit"),
    line(2, 10, "1.50"), line(2, None, "-0.25", kind="deposit_return", quantity="-1"),
]


class SummarizeTests(SimpleTestCase):
    def one(self, lines, receipts=None, **options):
        options.setdefault("tree", TREE)
        blocks = spending.summarize(data(lines, receipts), **options)
        self.assertEqual(len(blocks), 1)
        return blocks[0]

    def assert_identities(self, block):
        other = block.other.amount if block.other else D(0)
        self.assertEqual(sum(item.amount for item in block.items) + other, block.lines_paid)
        if block.receipts_total is not None:
            self.assertEqual(block.lines_paid + block.difference, block.receipts_total)

    def test_roots_with_descendants_and_special_items(self):
        block = self.one(BASKET, [ReceiptRow("EUR", 1, 2, D("26.15"))])
        self.assertEqual(brief(block), [
            ("category", 1, D("17.50")), ("category", 5, D("3.00")), ("category", 9, D("0.95")),
            ("unmatched", None, D("1.20")), ("service", None, D("4.00")), ("deposit", None, D("0.00")),
        ])
        food, chemistry, unassigned, unmatched, service, deposit = block.items
        self.assertEqual((food.name, food.direct, food.unassigned), ("Продукты питания", False, False))
        self.assertEqual((food.lines_count, food.receipts_count), (5, 2))
        self.assertTrue(unassigned.unassigned)
        self.assertFalse(chemistry.unassigned)
        self.assertEqual((unmatched.id, unmatched.name, unmatched.unassigned), (None, None, False))
        self.assertEqual((deposit.lines_count, deposit.receipts_count, deposit.share_percent), (2, 2, None))
        self.assertIsNone(food.quantity)
        self.assertIsNone(food.unit)
        self.assertEqual((block.receipts_count, block.receipts_total), (2, D("26.15")))
        self.assertEqual((block.lines_paid, block.difference), (D("26.65"), D("-0.50")))
        self.assertIsNone(block.other)
        self.assert_identities(block)
        # Доли — от суммы положительных: 17.50 + 3.00 + 0.95 + 1.20 + 4.00 = 26.65.
        self.assertEqual(
            [item.share_percent for item in block.items],
            [D("65.67"), D("11.26"), D("3.56"), D("4.50"), D("15.01"), None],
        )

    def test_drill_down_direct_children_and_direct_item(self):
        block = self.one(BASKET, category=1)
        self.assertEqual(
            brief(block), [("category", 2, D("9.00")), ("category", 1, D("7.00")), ("category", 4, D("1.50"))],
        )
        dairy, direct, bread = block.items
        self.assertEqual((direct.name, direct.direct), ("Продукты питания", True))
        self.assertFalse(dairy.direct)
        self.assertFalse(bread.direct)
        self.assertEqual((dairy.lines_count, dairy.receipts_count), (3, 2))
        # С фильтром: только товары категории, сумма чеков неизвестна.
        self.assertEqual((block.receipts_count, block.receipts_total, block.difference), (2, None, None))
        self.assertEqual(block.lines_paid, D("17.50"))
        self.assert_identities(block)

    def test_drill_down_into_leaf_and_unassigned(self):
        leaf = self.one(BASKET, category=3)
        self.assertEqual(brief(leaf), [("category", 3, D("4.50"))])
        self.assertTrue(leaf.items[0].direct)
        unassigned = self.one(BASKET, category=9)
        self.assertEqual((unassigned.items[0].direct, unassigned.items[0].unassigned), (True, True))
        self.assertEqual(spending.summarize(data(BASKET), tree=TREE, category=8), [])

    def test_only_root_category_named_unassigned_is_unassigned(self):
        products = {**PRODUCTS, 17: ProductInfo("Порошок", 105, "Порошки", 8)}
        collected = Collected([line(1, 17, "2.00")], [ReceiptRow("EUR", 1, 1, D("2.00"))], products)
        item = spending.summarize(collected, tree=TREE, category=5)[0].items[0]
        self.assertEqual((item.id, item.name, item.unassigned), (8, "Не разобрано", False))

    def test_group_by_generic(self):
        block = self.one(BASKET + [line(3, 16, "2.50")], group_by="generic")
        self.assertEqual(
            brief(block)[:3], [("generic", 100, D("7.00")), ("generic", 104, D("7.00")), ("generic", 101, D("4.50"))],
        )
        self.assertEqual([item.name for item in block.items[:2]], ["Молоко", "Наборы"])
        self.assertEqual([item.id for item in block.items if item.unassigned], [109])
        self.assertEqual([item.kind for item in block.items[-3:]], ["unmatched", "service", "deposit"])
        self.assert_identities(block)

    def test_generic_filter_keeps_only_its_products(self):
        block = self.one(BASKET + [line(3, 16, "2.50")], group_by="product", generic=100)
        self.assertEqual(brief(block), [("product", 10, D("4.50")), ("product", 16, D("2.50"))])
        self.assertEqual((block.receipts_count, block.receipts_total, block.difference), (3, None, None))
        self.assertEqual(spending.summarize(data(BASKET), group_by="product", generic=555), [])
        # Фильтры складываются по «И».
        self.assertEqual(spending.summarize(data(BASKET), tree=TREE, group_by="product", generic=100, category=5), [])
        both = self.one(BASKET, group_by="category", generic=100, category=1)
        self.assertEqual(brief(both), [("category", 2, D("4.50"))])
        roots = self.one(BASKET, group_by="category", generic=100)
        self.assertEqual(brief(roots), [("category", 1, D("4.50"))])

    def test_group_by_product_quantity_only_for_one_unit(self):
        lines = [
            line(1, 10, "3.00", quantity="2"), line(2, 10, "1.50", quantity="1.000"),
            line(1, 12, "1.50", quantity="1"), line(2, 12, "2.40", unit="kg", quantity="0.800"),
            line(1, 99, "5.00"), line(1, None, "1.00"),
        ]
        block = self.one(lines, group_by="product")
        milk, bread, unmatched = block.items
        self.assertEqual((milk.id, milk.name, milk.quantity, milk.unit), (10, "Молоко 1 л", D("3.000"), "pcs"))
        self.assertEqual((bread.amount, bread.quantity, bread.unit), (D("3.90"), None, None))
        self.assertFalse(milk.unassigned)
        # Товар, которого нет в каталоге, — как несопоставленная строка.
        self.assertEqual((unmatched.kind, unmatched.amount, unmatched.lines_count), ("unmatched", D("6.00"), 2))
        self.assertIsNone(unmatched.quantity)

    def test_group_by_store_uses_receipt_totals(self):
        lines = BASKET + [line(5, 10, "9.00", store=2)]
        receipts = [ReceiptRow("EUR", 1, 2, D("26.15")), ReceiptRow("EUR", 2, 3, D("40.00"))]
        block = self.one(lines, receipts, group_by="store", stores=STORES)
        self.assertEqual(brief(block), [("store", 2, D("40.00")), ("store", 1, D("26.15"))])
        second, first = block.items
        self.assertEqual((first.name, first.extra), ("Демо А", {"city": "Musterstadt", "country": "DE"}))
        self.assertEqual((first.lines_count, first.receipts_count), (11, 2))
        self.assertEqual((second.lines_count, second.receipts_count), (1, 3))
        self.assertEqual((block.receipts_count, block.receipts_total), (5, D("66.15")))
        self.assertEqual((block.lines_paid, block.difference), (D("66.15"), D("0.00")))
        self.assert_identities(block)

    def test_group_by_store_without_lines_and_with_filter(self):
        receipts = [ReceiptRow("EUR", 1, 1, D("5.00")), ReceiptRow("EUR", 2, 1, D("7.00"))]
        empty = self.one([], receipts, group_by="store", stores=STORES)
        self.assertEqual(brief(empty), [("store", 2, D("7.00")), ("store", 1, D("5.00"))])
        self.assertEqual([item.lines_count for item in empty.items], [0, 0])
        filtered = self.one(BASKET + [line(5, 13, "9.00", store=2)], group_by="store", stores=STORES, category=1)
        self.assertEqual(brief(filtered), [("store", 1, D("17.50"))])
        self.assertEqual((filtered.items[0].receipts_count, filtered.receipts_total), (2, None))

    def test_receipts_without_lines_still_make_a_block(self):
        block = self.one([], [ReceiptRow("EUR", 1, 2, D("12.00"))])
        self.assertEqual((block.items, block.other), ([], None))
        self.assertEqual((block.receipts_count, block.lines_paid, block.difference), (2, D("0.00"), D("12.00")))

    def test_currencies_are_separate_blocks_in_code_order(self):
        lines = [
            line(1, 10, "5.00", currency="KZT", store=2), line(2, 10, "1.50"), line(3, 13, "70.00", currency="RUB"),
        ]
        blocks = spending.summarize(data(lines), tree=TREE)
        self.assertEqual([block.currency for block in blocks], ["EUR", "KZT", "RUB"])
        self.assertEqual([block.lines_paid for block in blocks], [D("1.50"), D("5.00"), D("70.00")])
        self.assertEqual([block.items[0].share_percent for block in blocks], [D("100.00")] * 3)

    def test_refund_keeps_its_sign(self):
        lines = [line(1, 10, "3.00"), line(2, 10, "-1.50", quantity="-1"), line(3, 13, "-2.00", quantity="-1")]
        block = self.one(lines, [ReceiptRow("EUR", 1, 3, D("-0.50"))])
        self.assertEqual(brief(block), [("category", 1, D("1.50")), ("category", 5, D("-2.00"))])
        self.assertEqual([item.share_percent for item in block.items], [D("100.00"), None])
        self.assertEqual((block.lines_paid, block.difference), (D("-0.50"), D("0.00")))

    def test_empty(self):
        self.assertEqual(spending.summarize(Collected([], [], {}), tree=TREE), [])


class FoldTests(SimpleTestCase):
    def items(self, *amounts):
        return [Item("product", pk, f"Товар {pk}", D(amount), 1, 1) for pk, amount in enumerate(amounts, 1)]

    def test_limit_folds_the_rest_into_other(self):
        special = [Item("deposit", None, None, D("-1.00"), 1, 1), Item("unmatched", None, None, D("10.00"), 1, 1)]
        items, other = spending.fold(self.items("5.00", "40.00", "20.00", "15.00", "10.00"), special, 2)
        self.assertEqual(
            [(item.kind, item.amount) for item in items],
            [("product", D("40.00")), ("product", D("20.00")), ("unmatched", D("10.00")), ("deposit", D("-1.00"))],
        )
        self.assertEqual((other.count, other.amount), (3, D("30.00")))
        # Положительные: 40 + 20 + 10 + прочее 30 = 100.
        self.assertEqual([item.share_percent for item in items], [D("40.00"), D("20.00"), D("10.00"), None])
        self.assertEqual(other.share_percent, D("30.00"))

    def test_no_other_when_everything_fits(self):
        items, other = spending.fold(self.items("1.00", "2.00"), [], 2)
        self.assertEqual([item.amount for item in items], [D("2.00"), D("1.00")])
        self.assertIsNone(other)

    def test_order_amount_then_name_then_id(self):
        regular = [
            Item("product", 7, "Б", D("1.00"), 1, 1), Item("product", 9, "А", D("1.00"), 1, 1),
            Item("product", 3, "А", D("1.00"), 1, 1), Item("product", 1, "Я", D("2.00"), 1, 1),
        ]
        items, _ = spending.fold(regular, [], 10)
        self.assertEqual([item.id for item in items], [1, 3, 9, 7])

    def test_negative_other_has_no_share_and_is_not_in_the_base(self):
        items, other = spending.fold(self.items("8.00", "2.00", "-3.00", "-1.00"), [], 2)
        self.assertEqual((other.count, other.amount, other.share_percent), (2, D("-4.00"), None))
        self.assertEqual([item.share_percent for item in items], [D("80.00"), D("20.00")])

    def test_nothing_positive_means_no_shares(self):
        items, other = spending.fold(self.items("0.00", "-2.00"), [Item("deposit", None, None, D("-0.25"), 1, 1)], 1)
        self.assertEqual([item.share_percent for item in items], [None, None])
        self.assertIsNone(other.share_percent)

    def test_share_rounds_half_up(self):
        items, _ = spending.fold(self.items("1.00", "1.00", "1.00", "5.00"), [], 10)
        self.assertEqual([item.share_percent for item in items], [D("62.50"), D("12.50"), D("12.50"), D("12.50")])
        items, _ = spending.fold(self.items("2.00", "1.00"), [], 10)
        self.assertEqual([item.share_percent for item in items], [D("66.67"), D("33.33")])


@tag("integration")
class CollectTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.store = samples.lidl_store()
        cls.other_store = samples.dns_store()
        cls.category = Category.objects.create(name="Демо-категория")
        cls.generic = GenericProduct.objects.create(name="Демо-продукт", category=cls.category, base_unit="pcs")
        cls.milk = Product.objects.create(generic=cls.generic, name="Демо-молоко")
        cls.bread = Product.objects.create(generic=cls.generic, name="Демо-хлеб")
        cls.first = cls.receipt(cls.store, "EUR", "first", "9.00")
        make_line(cls.first, position=1, product=cls.milk, quantity=D("2"), amount=D("3.00"), unit_price=D("1.5"))
        make_line(cls.first, position=2, product=cls.milk, amount=D("1.50"), discount_amount=D("0.30"))
        make_line(cls.first, position=3, product=cls.milk, unit="l", amount=D("1.10"))
        make_line(cls.first, position=4, amount=D("0.70"))
        make_line(cls.first, position=5, kind="deposit", amount=D("0.25"))
        cls.second = cls.receipt(cls.store, "EUR", "second", "2.00", operation=Receipt.Operation.REFUND)
        make_line(cls.second, position=1, product=cls.bread, quantity=D("-1"), amount=D("-2.00"))
        cls.third = cls.receipt(cls.other_store, "KZT", "third", "500.00")

    @staticmethod
    def receipt(store, currency, number, total, operation=Receipt.Operation.SALE):
        return Receipt.objects.create(
            store=store, currency_id=currency, operation=operation, total=D(total),
            purchased_on=date(2026, 3, 14), purchased_at=datetime(2026, 3, 14, 11, 30, tzinfo=timezone.utc),
            receipt_number=f"spending-{number}",
        )

    def test_rows_products_and_totals(self):
        with self.assertNumQueries(3):
            found = spending.collect(Receipt.objects.all())
        eur, store = "EUR", self.store.pk
        self.assertCountEqual(found.lines, [
            LineRow(eur, self.first.pk, store, self.milk.pk, "product", "pcs", D("4.20"), 2, D("3.000")),
            LineRow(eur, self.first.pk, store, self.milk.pk, "product", "l", D("1.10"), 1, D("1.000")),
            LineRow(eur, self.first.pk, store, None, "product", "pcs", D("0.70"), 1, D("1.000")),
            LineRow(eur, self.first.pk, store, None, "deposit", "pcs", D("0.25"), 1, D("1.000")),
            LineRow(eur, self.second.pk, store, self.bread.pk, "product", "pcs", D("-2.00"), 1, D("-1.000")),
        ])
        self.assertCountEqual(found.receipts, [
            ReceiptRow(eur, store, 2, D("11.00")), ReceiptRow("KZT", self.other_store.pk, 1, D("500.00")),
        ])
        info = ProductInfo("Демо-молоко", self.generic.pk, "Демо-продукт", self.category.pk)
        self.assertEqual(found.products, {self.milk.pk: info, self.bread.pk: info._replace(name="Демо-хлеб")})

    def test_receipt_queryset_limits_lines_and_totals(self):
        found = spending.collect(Receipt.objects.filter(pk=self.second.pk))
        self.assertEqual([row.receipt_id for row in found.lines], [self.second.pk])
        self.assertEqual(found.receipts, [ReceiptRow("EUR", self.store.pk, 1, D("2.00"))])
        self.assertEqual(list(found.products), [self.bread.pk])
        empty = spending.collect(Receipt.objects.none())
        self.assertEqual((empty.lines, empty.receipts, empty.products), ([], [], {}))

    def test_product_ref_replaces_the_product_of_a_line(self):
        found = spending.collect(Receipt.objects.all(), Value(self.bread.pk))
        self.assertEqual({row.product_id for row in found.lines}, {self.bread.pk})
        self.assertEqual(list(found.products), [self.bread.pk])

    def test_query_count_does_not_grow_with_data(self):
        for number in range(30):
            receipt = self.receipt(self.store, "EUR", f"many-{number}", "1.00")
            product = Product.objects.create(generic=self.generic, name=f"Демо-товар {number}")
            make_line(receipt, position=1, product=product, amount=D("1.00"))
        with self.assertNumQueries(3):
            found = spending.collect(Receipt.objects.all())
        self.assertEqual(len(found.products), 32)
