"""Демо «длинных хвостов» статистики: состав, предохранители, счётчики и пара запросов состава.

Запрос A — траты без ``limit`` (сервер берёт 10), запрос B — тот же с наибольшим допустимым
``limit``, но не больше ``WIDE_LIMIT``: тесты верны и до, и после подъёма границы до 500.
"""
import io
import json
from collections import defaultdict
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import SimpleTestCase, TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.views.stats_spending import MAX_LIMIT
from catalog.models import Category, GenericProduct, Product
from receipts import demo, tail_demo
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.ownership import LOCAL_USERNAME
from receipts.validation import validate_receipt
from stores.models import Merchant, Store

D = Decimal
MODELS = (Category, GenericProduct, Product, Merchant, Store, Receipt, ReceiptLine)
SEEDED = {
    "created": True, "merchants": 14, "categories": 27, "generics": 52, "products": 535, "receipts": 56,
    "lines": 557,
}
COMMAND = "seed_stats_tail_demo"
IDS = {"food": 1, "negative_category": 10, "negative_generic": 17}  # как на свежей базе
# (всего, показано, в «Прочем», строк состава при limit=500, остаток при limit=500, особые)
ALL_SPECIAL = ["unmatched", "service", "deposit"]
COUNTERS = {
    "Категории, верхний уровень": ("EUR", 14, 10, 4, 4, 0, ALL_SPECIAL),
    "Категории внутри «Продукты питания»": ("EUR", 14, 10, 4, 4, 0, []),
    "Магазины": ("EUR", 13, 10, 3, 3, 0, []),
    "Обобщённые продукты": ("EUR", 52, 10, 42, 42, 0, ALL_SPECIAL),
    "Товары: элементов больше лимита": ("EUR", 520, 10, 510, 490, 20, ALL_SPECIAL),
    "Обобщённые продукты внутри «Продукты питания»": ("EUR", 27, 10, 17, 17, 0, []),
    "Товары внутри «Сладости»: отрицательная сумма в хвосте": ("EUR", 20, 10, 10, 10, 0, []),
    "Товары обобщённого продукта «Шоколад»: «Прочего» нет": ("EUR", 10, 10, 0, 0, 0, []),
    "Товары, второй блок валюты": ("KZT", 15, 10, 5, 5, 0, ["unmatched"]),
}
WIDE = min(MAX_LIMIT, tail_demo.WIDE_LIMIT)
User = get_user_model()


def snapshot():
    return {model.__name__: list(model.objects.order_by("pk").values()) for model in MODELS}


def run_command():
    out = io.StringIO()
    call_command(COMMAND, stdout=out)
    return json.loads(out.getvalue())


def counts(result):
    return {key: result[key] for key in SEEDED if key in result}


class PlanTests(SimpleTestCase):
    def test_plan_is_deterministic_and_consistent(self):
        sales = tail_demo.build_receipts()
        self.assertEqual(sales, tail_demo.build_receipts())
        self.assertEqual(len(sales), SEEDED["receipts"])
        self.assertEqual(sum(len(sale.lines) for sale in sales), SEEDED["lines"])
        self.assertEqual(len({sale.number for sale in sales}), len(sales))
        self.assertEqual(len({(sale.store, sale.on) for sale in sales}), len(sales))
        outside = [sale for sale in sales if not tail_demo.PERIOD[0] <= sale.on <= tail_demo.PERIOD[1]]
        self.assertEqual([(sale.on, sale.operation) for sale in outside], [(date(2024, 12, 20), demo.SALE)])
        self.assertEqual(
            [(sale.on, sale.total) for sale in sales if sale.operation == demo.REFUND],
            [(date(2025, 12, 5), D("-33.99"))],
        )
        for sale in sales:
            for line in sale.lines:
                self.assertEqual(line.amount, line.quantity * line.unit_price, sale.number)
                self.assertEqual(line.discount, 0, sale.number)
            self.assertEqual(sale.total, sum(line.amount for line in sale.lines), sale.number)
            self.assertIsNone(sale.receipt_discount)
            self.assertIsNone(sale.tax)

    def test_catalog_and_stores_are_fictional_and_unique(self):
        goods = tail_demo.goods()
        names = [good.name for good in goods]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(len(names), SEEDED["products"])
        for name in names:
            self.assertRegex(name, r"^Демо ")
        tree = tail_demo.generics()
        self.assertEqual(len(tree), SEEDED["generics"])
        self.assertEqual(len({name.casefold() for name in tree}), len(tree))
        self.assertTrue({good.generic for good in goods} <= set(tree))
        paths = {(root, None) for root, _sub in tree.values()} | {path for path in tree.values() if path[1]}
        self.assertEqual(len(paths), SEEDED["categories"])
        stores = tail_demo.stores()
        self.assertEqual(len(stores), SEEDED["merchants"])
        self.assertEqual(len({spec["tax_id"] for spec in stores.values()}), len(stores))
        for spec in stores.values():
            self.assertRegex(spec["tax_id"], r"^DEMOTAIL\d{4}$")
            self.assertIn("вымышлен", spec["legal_name"])
        self.assertEqual(
            [spec["currency"] for spec in stores.values()].count("EUR"), tail_demo.EUR_STORES,
        )

    def test_amounts_of_the_period_are_distinct(self):
        # Порядок элементов однозначен без сравнения названий: суммы каждой разбивки разные.
        goods = {good.name: good for good in tail_demo.goods()}
        tree = tail_demo.generics()
        product, generic, root, sub, store = (defaultdict(D) for _ in range(5))
        for sale in tail_demo.build_receipts():
            if sale.store == tail_demo.KZ or not tail_demo.PERIOD[0] <= sale.on <= tail_demo.PERIOD[1]:
                continue
            store[sale.store] += sale.total
            for line in sale.lines:
                if line.item is None:
                    continue
                top, child = tree[goods[line.item].generic]
                product[line.item] += line.amount
                generic[goods[line.item].generic] += line.amount
                root[top] += line.amount
                if top == tail_demo.FOOD:
                    sub[child] += line.amount
        sizes = {"product": 520, "generic": 52, "root": 14, "sub": 14, "store": 13}
        for name, amounts in (("product", product), ("generic", generic), ("root", root), ("sub", sub), ("store", store)):
            self.assertEqual(len(amounts), sizes[name], name)
            self.assertEqual(len(set(amounts.values())), len(amounts), name)
        # Отрицательная сумма только у одного товара; его продукт, категории и магазин положительны.
        self.assertEqual({name: amount for name, amount in product.items() if amount <= 0}, {
            tail_demo.NEGATIVE: D("-22.66"),
        })
        for amounts in (generic, root, sub, store):
            self.assertGreater(min(amounts.values()), 0)
        prices = [good.price for good in tail_demo.kz_goods()]
        self.assertEqual(len(set(prices)), len(prices))

    def test_checks(self):
        found = tail_demo.checks(IDS)
        self.assertEqual({
            entry["title"]: (
                entry["currency"], entry["items"], entry["shown"], entry["other"], entry["tail_rows"],
                entry["tail_other"], entry["special"],
            )
            for entry in found
        }, COUNTERS)
        period = "date_from=2025-01-01&date_to=2025-12-31"
        self.assertEqual([entry["screen"] for entry in found], [
            f"/stats?{period}&currency=EUR",
            f"/stats?{period}&currency=EUR&category=1",
            f"/stats?{period}&currency=EUR&group_by=store",
            f"/stats?{period}&currency=EUR&group_by=generic",
            f"/stats?{period}&currency=EUR&group_by=product",
            f"/stats?{period}&currency=EUR&group_by=generic&category=1",
            f"/stats?{period}&currency=EUR&group_by=product&category=10",
            f"/stats?{period}&currency=EUR&group_by=product&generic=17",
            f"/stats?{period}&group_by=product",
        ])
        for entry in found:
            self.assertEqual(entry["api"], entry["screen"].replace("/stats?", "/api/stats/spending/?"))


@tag("integration")
class CommandTests(TestCase):
    def test_seed_is_idempotent(self):
        first = run_command()
        self.assertEqual(counts(first), SEEDED)
        self.assertEqual(first["period"], {"date_from": "2025-01-01", "date_to": "2025-12-31"})
        seeded = snapshot()
        again = run_command()
        self.assertEqual(again, {"created": False, **{key: first[key] for key in first if key not in SEEDED}})
        self.assertEqual(tail_demo.seed_tail_demo(), again)
        self.assertEqual(snapshot(), seeded)

    def test_summary_names_real_records(self):
        result = tail_demo.seed_tail_demo()
        negative = Product.objects.get(name=tail_demo.NEGATIVE)
        self.assertEqual(result["negative_product"], {"id": negative.pk, "name": negative.name, "amount": "-22.66"})
        self.assertEqual(result["checks"], tail_demo.checks({
            "food": Category.objects.get(name=tail_demo.FOOD, parent=None).pk,
            "negative_category": negative.generic.category_id,
            "negative_generic": negative.generic_id,
        }))
        self.assertEqual(negative.generic.category.name, tail_demo.NEGATIVE_SUB)

    def test_every_demo_receipt_belongs_to_local(self):
        # Запись могла остаться от миграции: демо обязано создать её само и ровно одну.
        User.objects.filter(username=LOCAL_USERNAME).delete()
        self.assertEqual(counts(tail_demo.seed_tail_demo()), SEEDED)
        local = User.objects.get(username=LOCAL_USERNAME)
        self.assertEqual((local.is_active, local.is_staff, local.is_superuser), (True, False, False))
        self.assertFalse(local.has_usable_password())
        self.assertEqual(Receipt.objects.count(), SEEDED["receipts"])
        self.assertEqual(set(Receipt.objects.values_list("owner_id", flat=True)), {local.pk})

    def test_seed_refuses_a_non_test_database(self):
        before = snapshot()
        User.objects.filter(username=LOCAL_USERNAME).delete()
        for name in ("checkist_dev", "checkist"):
            with patch.dict(settings.DATABASES["default"], {"NAME": name}), self.assertRaises(CommandError):
                call_command(COMMAND, stdout=io.StringIO())
            with patch.dict(settings.DATABASES["default"], {"NAME": name}), self.assertRaises(demo.DemoError):
                tail_demo.seed_tail_demo()
        self.assertEqual(snapshot(), before)
        # Отказ не заводит и владельца.
        self.assertFalse(User.objects.filter(username=LOCAL_USERNAME).exists())

    def test_seed_refuses_a_database_with_other_data(self):
        # Счётчики верны только без посторонних данных: демо статистики в той же базе — отказ.
        demo.seed_demo()
        before = snapshot()
        with self.assertRaisesMessage(CommandError, "empty QA database"):
            call_command(COMMAND, stdout=io.StringIO())
        with self.assertRaises(demo.DemoError):
            tail_demo.seed_tail_demo()
        self.assertEqual(snapshot(), before)
        self.assertFalse(Merchant.objects.filter(tax_id__startswith=tail_demo.TAX_PREFIX).exists())

    def test_one_category_is_enough_to_refuse(self):
        Category.objects.create(name="Посторонняя")
        with self.assertRaises(demo.DemoError):
            tail_demo.seed_tail_demo()
        self.assertFalse(Receipt.objects.exists())


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class TailNumbersTests(TestCase):
    maxDiff = None

    @classmethod
    def setUpTestData(cls):
        cls.seeded = tail_demo.seed_tail_demo()

    def setUp(self):
        self.client = APIClient()

    def get(self, url):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def block(self, url, currency):
        return next(block for block in self.get(url)["currencies"] if block["currency"] == currency)

    def pair(self, entry):
        """Блоки запросов A и B проверки ``entry``."""
        return self.block(entry["api"], entry["currency"]), self.block(f"{entry['api']}&limit={WIDE}", entry["currency"])

    @staticmethod
    def regular(block):
        return [item for item in block["items"] if item["id"] is not None]

    def check(self, title):
        return next(entry for entry in self.seeded["checks"] if entry["title"] == title)

    def test_composition(self):
        self.assertEqual(counts(self.seeded), SEEDED)
        self.assertEqual(Category.objects.filter(parent=None).count(), 14)
        self.assertEqual(Category.objects.filter(parent__name=tail_demo.FOOD).count(), 13)
        self.assertEqual(Product.objects.filter(generic__name=demo.UNASSIGNED).count(), 15)
        self.assertEqual(
            {store.country_id: store.receipts.values_list("currency_id", flat=True).distinct().get()
             for store in Store.objects.all()},
            {"DE": "EUR", "KZ": "KZT"},
        )
        self.assertEqual(Store.objects.filter(country="DE").count(), 13)
        kind = ReceiptLine.Kind
        self.assertEqual(
            {value: ReceiptLine.objects.filter(kind=value).count() for value in kind.values},
            {kind.PRODUCT: 551, kind.SERVICE: 2, kind.DEPOSIT: 3, kind.DEPOSIT_RETURN: 1},
        )
        self.assertEqual(ReceiptLine.objects.filter(kind=kind.PRODUCT, product=None).count(), 14)
        self.assertEqual(ReceiptLine.objects.filter(kind=kind.DEPOSIT, parent__kind=kind.PRODUCT).count(), 3)
        self.assertEqual(Receipt.objects.filter(operation=Receipt.Operation.REFUND).count(), 1)
        for model in (ReceiptDiscount, ReceiptTax, ProductAlias):
            self.assertFalse(model.objects.exists(), model.__name__)

    def test_receipts_are_consistent(self):
        receipts = Receipt.objects.select_related("store").filter(receipt_number__startswith=tail_demo.RECEIPT_PREFIX)
        self.assertEqual(receipts.count(), SEEDED["receipts"])
        for receipt in receipts:
            self.assertEqual(validate_receipt(receipt), [], receipt.receipt_number)

    def test_totals_of_the_period_and_of_the_whole_history(self):
        period = "date_from=2025-01-01&date_to=2025-12-31"
        blocks = {block["currency"]: block["totals"] for block in self.get(f"/api/stats/spending/?{period}")["currencies"]}
        self.assertEqual(blocks, {
            "EUR": {"receipts_count": 53, "receipts_total": "11013.48", "lines_paid": "11013.48", "difference": "0.00"},
            "KZT": {"receipts_count": 2, "receipts_total": "7025.00", "lines_paid": "7025.00", "difference": "0.00"},
        })
        # Покупка до периода: без фильтра по датам отрицательной суммы у товара нет.
        whole = self.block("/api/stats/spending/?currency=EUR", "EUR")["totals"]
        self.assertEqual((whole["receipts_count"], whole["lines_paid"]), (54, "11047.47"))
        negative = Product.objects.get(name=tail_demo.NEGATIVE)
        rows = self.block(f"/api/stats/spending/?currency=EUR&group_by=product&generic={negative.generic_id}", "EUR")
        self.assertEqual(
            [(item["amount"], item["share_percent"] is None) for item in rows["items"] if item["id"] == negative.pk],
            [("11.33", False)],
        )
        self.assertGreater(min(D(item["amount"]) for item in rows["items"]), 0)

    def test_counters_of_every_check(self):
        self.assertEqual(len(self.seeded["checks"]), len(COUNTERS))
        for entry in self.seeded["checks"]:
            with self.subTest(entry["title"]):
                first, wide = self.pair(entry)
                shown = self.regular(first)
                self.assertEqual(len(shown), entry["shown"])
                self.assertEqual(first["other"]["count"] if first["other"] else 0, entry["other"])
                self.assertEqual(
                    [item["kind"] for item in first["items"] if item["id"] is None], entry["special"],
                )
                rows = min(entry["items"], WIDE)
                self.assertEqual(len(self.regular(wide)), rows)
                self.assertEqual(wide["other"]["count"] if wide["other"] else 0, entry["items"] - rows)
                if WIDE >= tail_demo.WIDE_LIMIT:
                    self.assertEqual(len(self.regular(wide)) - len(shown), entry["tail_rows"])
                    self.assertEqual(wide["other"]["count"] if wide["other"] else 0, entry["tail_other"])
                # Порядок однозначен: суммы обычных элементов строго убывают.
                amounts = [D(item["amount"]) for item in self.regular(wide)]
                self.assertEqual(amounts, sorted(set(amounts), reverse=True))

    def test_tail_identities_of_every_check(self):
        for entry in self.seeded["checks"]:
            with self.subTest(entry["title"]):
                first, wide = self.pair(entry)
                shown = self.regular(first)
                self.assertEqual(first["totals"], wide["totals"])
                self.assertEqual(
                    [(item["id"], item["amount"]) for item in shown],
                    [(item["id"], item["amount"]) for item in self.regular(wide)[:len(shown)]],
                )
                tail = self.regular(wide)[len(shown):]
                rest = wide["other"] or {"count": 0, "amount": "0.00"}
                if first["other"] is None:
                    self.assertEqual((tail, wide["other"]), ([], None))
                    continue
                self.assertEqual(len(tail) + rest["count"], first["other"]["count"])
                self.assertEqual(sum(D(item["amount"]) for item in tail) + D(rest["amount"]), D(first["other"]["amount"]))

    def test_whole_product_tail_keeps_the_negative_product_inside_the_rest(self):
        entry = self.check("Товары: элементов больше лимита")
        first, wide = self.pair(entry)
        self.assertEqual(first["other"], {"count": 510, "amount": "10581.66", "share_percent": "96.08"})
        self.assertNotIn(self.seeded["negative_product"]["id"], [item["id"] for item in self.regular(wide)])
        if WIDE < tail_demo.WIDE_LIMIT:
            return
        self.assertEqual(wide["other"], {"count": 20, "amount": "46.31", "share_percent": "0.42"})
        # Отрицательный товар внутри остатка: базы долей двух запросов равны.
        shown = len(self.regular(first))
        self.assertEqual(
            [item["share_percent"] for item in self.regular(first)],
            [item["share_percent"] for item in self.regular(wide)[:shown]],
        )

    def test_negative_product_row_changes_the_share_base(self):
        entry = self.check("Товары внутри «Сладости»: отрицательная сумма в хвосте")
        first, wide = self.pair(entry)
        self.assertEqual(first["totals"]["lines_paid"], "420.11")
        self.assertEqual(first["other"], {"count": 10, "amount": "113.82", "share_percent": "27.09"})
        self.assertIsNone(wide["other"])
        last = self.regular(wide)[-1]
        self.assertEqual(
            (last["id"], last["name"], last["amount"], last["share_percent"], last["quantity"]),
            (self.seeded["negative_product"]["id"], tail_demo.NEGATIVE, "-22.66", None, "-2.000"),
        )
        self.assertEqual([item["amount"] for item in self.regular(wide) if D(item["amount"]) <= 0], ["-22.66"])
        # A делит на 420,11 (хвост одной чистой суммой), B — на 442,77 (только положительные строки).
        top_first, top_wide = self.regular(first)[0], self.regular(wide)[0]
        self.assertEqual((top_first["amount"], top_first["share_percent"]), ("35.62", "8.48"))
        self.assertEqual((top_wide["amount"], top_wide["share_percent"]), ("35.62", "8.04"))

    def test_second_currency_block(self):
        entry = self.check("Товары, второй блок валюты")
        body = self.get(entry["api"])
        self.assertEqual([block["currency"] for block in body["currencies"]], ["EUR", "KZT"])
        tenge = body["currencies"][1]
        self.assertEqual(tenge["other"], {"count": 5, "amount": "1350.00", "share_percent": "19.22"})
        self.assertEqual(
            [(item["name"], item["amount"]) for item in tenge["items"][:2]],
            [("Демо Новинка Алматы 02", "690.00"), ("Демо Хлеб Алматы 03", "655.00")],
        )
        self.assertEqual(body["currencies"][0]["other"]["count"], 510)
