"""Демо-данные статистики: состав, повторный вызов, предохранитель и точные числа.

Числа получены расчётами С1–С3 через их HTTP-эндпоинты и зафиксированы здесь: по ним
потом собираются эталоны ``api/tests/fixtures/stats``. Изменение ``receipts/demo.py``
меняет их — тогда правятся и ожидания, и эталоны.
"""
import io
import json
from datetime import UTC, date
from decimal import Decimal
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import SimpleTestCase, TestCase, override_settings, tag
from rest_framework.test import APIClient

from catalog.models import Brand, Category, GenericProduct, Product
from merges.models import ProductMerge
from receipts import demo
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.ownership import LOCAL_USERNAME
from receipts.validation import validate_receipt
from stores.models import Merchant, Store

D = Decimal
MODELS = (
    Category, GenericProduct, Brand, Product, Merchant, Store, Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax,
    ProductAlias,
)
SEEDED = {"created": True, "merchants": 3, "products": 39, "receipts": 466, "lines": 5604, "discounts": 151}
SPENDING = "/api/stats/spending/"
SERIES = "/api/stats/receipts/series/"
COMPARE = "/api/stats/receipts/compare/"
User = get_user_model()
# Главный вопрос демо: 2020 год против января — сентября 2026.
PERIODS = "base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-09-30"
KIND = ReceiptLine.Kind


def snapshot():
    return {model.__name__: list(model.objects.order_by("pk").values()) for model in MODELS}


def users():
    return list(User.objects.order_by("pk").values())


def run_command(name, *args):
    out = io.StringIO()
    call_command(name, *args, stdout=out)
    return json.loads(out.getvalue())


def bucket(count, total, avg, median, lines, per_receipt, per_line):
    return {
        "receipts_count": count, "total": total, "avg_receipt": avg, "median_receipt": median,
        "lines_count": lines, "lines_per_receipt": per_receipt, "paid_per_line": per_line,
    }


class PlanTests(SimpleTestCase):
    def test_database_guard(self):
        for name in ("test_checkist_qa", "checkist_qa", "checkist_qa_c4", "test_x"):
            self.assertTrue(demo.allowed_database(name), name)
        for name in ("checkist_dev", "checkist", "checkist_qa-x", "prod_test_x", "", None):
            self.assertFalse(demo.allowed_database(name), name)

    def test_plan_is_deterministic_and_consistent(self):
        sales = demo.build_receipts()
        self.assertEqual(sales, demo.build_receipts())
        self.assertEqual(len(sales), SEEDED["receipts"])
        self.assertEqual(len({sale.number for sale in sales}), len(sales))
        self.assertEqual({sale.on.year for sale in sales}, set(range(2019, 2027)))
        self.assertEqual(max(sale.on for sale in sales), date(2026, 9, 24))
        for sale in sales:
            for line in sale.lines:
                self.assertEqual(line.amount, demo._round(line.quantity * line.unit_price), sale.number)
                self.assertLessEqual(line.discount, abs(line.amount), sale.number)
            paid = sum(line.amount - line.discount for line in sale.lines)
            paid -= sale.receipt_discount[1] if sale.receipt_discount else 0
            self.assertEqual(sale.total, paid + (sale.tax[2] if sale.tax else 0), sale.number)

    def test_catalog_names_are_fictional_and_unique(self):
        names = [item.name for item in demo.items()]
        self.assertEqual(len(names), len(set(names)))
        self.assertEqual(len(names), SEEDED["products"])
        for name in names:
            self.assertRegex(name, r"^(Demo|Демо) ")
        for spec in demo.STORES.values():
            self.assertRegex(spec["tax_id"], r"^DEMOSTATS\d{4}$")
            self.assertIn("вымышлен", spec["legal_name"])
        for pool in (demo.DE_POOL, demo.KZ_POOL):
            for year in range(demo.FIRST_YEAR, demo.LAST_YEAR + 1):
                size = sum(item.since <= year for item in pool)
                # Сдвиг обходит весь ассортимент, а чек не берёт товар дважды.
                self.assertNotEqual(size % demo.POOL_STEP, 0)
        self.assertTrue(set(item.generic for item in demo.items()) <= set(demo.GENERICS))


@tag("integration")
class CommandTests(TestCase):
    def test_seed_is_idempotent(self):
        self.assertEqual(run_command("seed_stats_demo"), SEEDED)
        seeded = snapshot()
        self.assertEqual(run_command("seed_stats_demo"), {"created": False})
        self.assertEqual(demo.seed_demo(), {"created": False})
        self.assertEqual(snapshot(), seeded)

    def test_every_demo_receipt_belongs_to_local(self):
        # Запись могла остаться от миграции: демо обязано создать её само и ровно одну.
        User.objects.filter(username=LOCAL_USERNAME).delete()
        self.assertEqual(run_command("seed_stats_demo"), SEEDED)
        local = User.objects.get(username=LOCAL_USERNAME)
        self.assertEqual((local.is_active, local.is_staff, local.is_superuser), (True, False, False))
        self.assertFalse(local.has_usable_password())
        self.assertEqual(Receipt.objects.count(), SEEDED["receipts"])
        self.assertEqual(set(Receipt.objects.values_list("owner_id", flat=True)), {local.pk})
        people = users()
        self.assertEqual(run_command("seed_stats_demo"), {"created": False})
        self.assertEqual(users(), people)

    def test_seed_keeps_an_existing_local_user(self):
        User.objects.filter(username=LOCAL_USERNAME).delete()
        local = User.objects.create_user(LOCAL_USERNAME, password="demo-local-password-1", is_staff=True)
        people = users()
        self.assertEqual(demo.seed_demo(), SEEDED)
        self.assertEqual(users(), people)
        self.assertEqual(set(Receipt.objects.values_list("owner_id", flat=True)), {local.pk})

    def test_seed_refuses_a_non_test_database(self):
        before = snapshot()
        User.objects.filter(username=LOCAL_USERNAME).delete()
        for name in ("checkist_dev", "checkist"):
            with patch.dict(settings.DATABASES["default"], {"NAME": name}), self.assertRaises(CommandError):
                call_command("seed_stats_demo", stdout=io.StringIO())
            with patch.dict(settings.DATABASES["default"], {"NAME": name}), self.assertRaises(demo.DemoError):
                demo.seed_demo()
        self.assertEqual(snapshot(), before)
        self.assertFalse(Merchant.objects.filter(tax_id__startswith="DEMOSTATS").exists())
        # Отказ не заводит и владельца.
        self.assertFalse(User.objects.filter(username=LOCAL_USERNAME).exists())

    def test_merge_demo_after_stats_demo(self):
        demo.seed_demo()
        # Названия демо статистики не похожи друг на друга: слияние дублей их не трогает.
        self.assertEqual(run_command("product_merges", "detect", "--dry-run")["created"], 0)
        self.assertTrue(run_command("seed_product_merge_demo")["created"])
        self.assertEqual(run_command("product_merges", "detect", "--dry-run")["created"], 7)
        self.assertEqual(run_command("seed_stats_demo"), {"created": False})
        self.assertFalse(ProductMerge.objects.exists())

    def test_stats_demo_after_merge_demo(self):
        self.assertTrue(run_command("seed_product_merge_demo")["created"])
        merged = Product.objects.count()
        self.assertEqual(run_command("seed_stats_demo"), SEEDED)
        self.assertEqual(Product.objects.count(), merged + SEEDED["products"])
        self.assertEqual(run_command("product_merges", "detect", "--dry-run")["created"], 7)
        self.assertEqual(run_command("seed_product_merge_demo"), {"created": False})
        # Оба демо отдают чеки одной записи ``local``.
        local = User.objects.get(username=LOCAL_USERNAME)
        self.assertEqual(set(Receipt.objects.values_list("owner_id", flat=True)), {local.pk})


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class DemoNumbersTests(TestCase):
    maxDiff = None

    @classmethod
    def setUpTestData(cls):
        cls.seeded = demo.seed_demo()

    def setUp(self):
        self.client = APIClient()

    def get(self, url):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def product(self, name):
        return Product.objects.get(name=name)

    def test_composition(self):
        self.assertEqual(self.seeded, SEEDED)
        stores = list(Store.objects.select_related("merchant").order_by("pk"))
        self.assertEqual(
            [(store.name, store.country_id, store.merchant.tax_id) for store in stores],
            [("Zahlenfrisch", "DE", "DEMOSTATS0001"), ("Beispielkorb", "DE", "DEMOSTATS0002"),
             ("Статмаркет", "KZ", "DEMOSTATS0003")],
        )
        self.assertEqual(
            {(store.country_id, currency) for store in stores for currency in
             store.receipts.values_list("currency_id", flat=True).distinct()},
            {("DE", "EUR"), ("KZ", "KZT")},
        )
        self.assertEqual(
            sorted(Category.objects.values_list("name", "parent__name")),
            sorted(demo.CATEGORIES, key=lambda row: (row[0], row[1] or "")),
        )
        self.assertEqual(GenericProduct.objects.count(), len(demo.GENERICS))
        self.assertEqual(Product.objects.filter(generic__name=demo.UNASSIGNED).count(), 17)
        self.assertEqual(Product.objects.filter(generic__name="Молоко").count(), 3)
        self.assertEqual(Product.objects.exclude(package_unit="").count(), 18)
        self.assertEqual(ProductAlias.objects.count(), 65)

        lines = ReceiptLine.objects
        self.assertEqual(
            {kind: lines.filter(kind=kind).count() for kind in KIND.values},
            {KIND.PRODUCT: 5312, KIND.SERVICE: 23, KIND.DEPOSIT: 177, KIND.DEPOSIT_RETURN: 92},
        )
        self.assertEqual(lines.filter(kind=KIND.PRODUCT, product=None).count(), 155)
        self.assertEqual(lines.exclude(kind=KIND.PRODUCT).exclude(product=None).count(), 0)
        self.assertEqual(lines.filter(kind=KIND.DEPOSIT, parent__kind=KIND.PRODUCT).count(), 177)
        self.assertEqual(lines.filter(unit="kg").count(), 396)
        self.assertEqual(lines.filter(discount_amount__gt=0).count(), 94)
        self.assertEqual(ReceiptDiscount.objects.exclude(line=None).count(), 94)
        self.assertEqual(ReceiptDiscount.objects.filter(line=None).count(), 57)

        refund = Receipt.objects.get(operation=Receipt.Operation.REFUND)
        self.assertEqual((refund.purchased_on, refund.total, refund.currency_id), (date(2026, 3, 14), D("-7.14"), "EUR"))
        net = Receipt.objects.get(prices_include_tax=False)
        tax = ReceiptTax.objects.get()
        self.assertEqual((net.purchased_on, net.store.name, net.total), (date(2026, 5, 18), "Beispielkorb", D("52.14")))
        self.assertEqual((tax.receipt_id, tax.net, tax.tax, tax.gross), (net.pk, D("48.73"), D("3.41"), D("52.14")))
        self.assertEqual(tax.tax_rate.rate, D("7.00"))
        # Ночной чек: локально первое января 2026, по UTC — ещё 2025 год.
        night = Receipt.objects.get(store__country="KZ", purchased_on=date(2026, 1, 1))
        self.assertEqual(night.purchased_at.astimezone(UTC).date(), date(2025, 12, 31))

    def test_receipts_are_consistent(self):
        receipts = Receipt.objects.select_related("store").filter(receipt_number__startswith=demo.RECEIPT_PREFIX)
        self.assertEqual(receipts.count(), SEEDED["receipts"])
        for receipt in receipts:
            self.assertEqual(validate_receipt(receipt), [], receipt.receipt_number)

    def test_spending_totals_by_currency(self):
        body = self.get(f"{SPENDING}?limit=50")
        blocks = {block["currency"]: block for block in body["currencies"]}
        self.assertEqual(list(blocks), ["EUR", "KZT"])
        self.assertEqual(blocks["EUR"]["totals"], {
            "receipts_count": 373, "receipts_total": "13041.07", "lines_paid": "13083.66", "difference": "-42.59",
        })
        self.assertEqual(blocks["KZT"]["totals"], {
            "receipts_count": 93, "receipts_total": "438091.92", "lines_paid": "439741.92", "difference": "-1650.00",
        })

        def rows(block):
            return [
                (item["kind"], item["name"], item["amount"], item["share_percent"], item["lines_count"])
                for item in block["items"]
            ]

        self.assertEqual(rows(blocks["EUR"]), [
            ("category", "Продукты питания", "5590.75", "42.73", 2240),
            ("category", "Не разобрано", "5184.91", "39.63", 1832),
            ("category", "Бытовая химия", "1767.78", "13.51", 533),
            ("unmatched", None, "336.88", "2.57", 124),
            ("service", None, "75.84", "0.58", 23),
            ("deposit", None, "127.50", "0.97", 269),
        ])
        self.assertEqual(rows(blocks["KZT"]), [
            ("category", "Продукты питания", "281279.92", "63.96", 321),
            ("category", "Не разобрано", "143033.00", "32.53", 231),
            ("unmatched", None, "15429.00", "3.51", 31),
        ])
        for block in blocks.values():
            self.assertIsNone(block["other"])
            self.assertEqual(sum(D(item["amount"]) for item in block["items"]), D(block["totals"]["lines_paid"]))
            self.assertEqual(
                D(block["totals"]["lines_paid"]) + D(block["totals"]["difference"]), D(block["totals"]["receipts_total"]),
            )
        self.assertEqual(
            [item["unassigned"] for item in blocks["EUR"]["items"]], [False, True, False, False, False, False],
        )

    def test_spending_drill_down_and_other_groupings(self):
        food = Category.objects.get(name="Продукты питания")
        body = self.get(f"{SPENDING}?category={food.pk}&currency=EUR")
        self.assertEqual(body["parent"], {"id": food.pk, "name": food.name, "path": [{"id": food.pk, "name": food.name}]})
        self.assertEqual(
            [(item["name"], item["direct"], item["amount"]) for item in body["currencies"][0]["items"]],
            [("Молочные продукты", False, "2143.07"), ("Продукты питания", True, "1428.00"),
             ("Овощи и фрукты", False, "1325.00"), ("Хлеб", False, "694.68")],
        )
        generics = self.get(f"{SPENDING}?group_by=generic&currency=EUR&limit=5")["currencies"][0]
        self.assertEqual(
            [(item["name"], item["amount"]) for item in generics["items"] if item["kind"] == "generic"],
            [("Не разобрано", "5184.91"), ("Курица", "1213.44"), ("Стиральное средство", "1012.70"),
             ("Сыр", "928.99"), ("Хлеб", "694.68")],
        )
        self.assertEqual(generics["other"], {"count": 9, "amount": "3508.72", "share_percent": "26.82"})
        products = self.get(f"{SPENDING}?group_by=product&currency=EUR&limit=3")["currencies"][0]
        self.assertEqual(
            [(item["name"], item["amount"], item["quantity"], item["unit"]) for item in products["items"][:3]],
            [("Demo Hähnchenbrust 600g", "1213.44", "173.000", "pcs"),
             ("Demo Bohnenkaffee gemahlen", "1133.69", "175.000", "pcs"),
             ("Demo Waschmittel 1,35L", "1012.70", "181.000", "pcs")],
        )
        self.assertEqual(products["other"], {"count": 25, "amount": "9183.61", "share_percent": "70.19"})
        stores = self.get(f"{SPENDING}?group_by=store")["currencies"]
        self.assertEqual(
            [(item["name"], item["amount"], item["receipts_count"]) for block in stores for item in block["items"]],
            [("Zahlenfrisch", "9667.68", 280), ("Beispielkorb", "3373.39", 93), ("Статмаркет", "438091.92", 93)],
        )
        year = self.get(f"{SPENDING}?date_from=2026-01-01&date_to=2026-12-31")["currencies"]
        self.assertEqual(
            [(block["currency"], block["totals"]) for block in year],
            [("EUR", {"receipts_count": 37, "receipts_total": "1638.94", "lines_paid": "1640.53",
                      "difference": "-1.59"}),
             ("KZT", {"receipts_count": 9, "receipts_total": "67312.93", "lines_paid": "67462.93",
                      "difference": "-150.00"})],
        )

    def test_average_receipt_by_year(self):
        body = self.get(f"{SERIES}?interval=year")
        blocks = {block["currency"]: block for block in body["currencies"]}
        self.assertEqual({code: block["refunds_excluded"] for code, block in blocks.items()}, {"EUR": 1, "KZT": 0})
        euro = {item["period_start"][:4]: item for item in blocks["EUR"]["buckets"]}
        self.assertEqual(
            [(year, item["receipts_count"], item["avg_receipt"], item["lines_per_receipt"]) for year, item in euro.items()],
            [("2019", 48, "26.04", "11.00"), ("2020", 48, "27.01", "11.50"), ("2021", 48, "29.92", "12.00"),
             ("2022", 48, "33.23", "12.50"), ("2023", 48, "38.01", "13.00"), ("2024", 48, "40.53", "13.50"),
             ("2025", 48, "42.81", "14.00"), ("2026", 36, "45.72", "14.67")],
        )
        self.assertEqual(euro["2020"], {
            "period_start": "2020-01-01", **bucket(48, "1296.41", "27.01", "27.28", 552, "11.50", "2.3486"),
        })
        self.assertEqual(euro["2026"], {
            "period_start": "2026-01-01", **bucket(36, "1646.08", "45.72", "45.52", 528, "14.67", "3.1176"),
        })
        tenge = {item["period_start"][:4]: item for item in blocks["KZT"]["buckets"]}
        self.assertEqual(tenge["2020"], {
            "period_start": "2020-01-01", **bucket(12, "36651.51", "3054.29", "2892.32", 66, "5.50", "555.3259"),
        })
        self.assertEqual(tenge["2026"], {
            "period_start": "2026-01-01", **bucket(9, "67312.93", "7479.21", "7836.00", 67, "7.44", "1004.6706"),
        })
        months = self.get(f"{SERIES}?currency=EUR")["currencies"][0]["buckets"]
        self.assertEqual(len(months), 93)
        self.assertEqual({item["receipts_count"] for item in months}, {4})

    def test_average_receipt_decomposition(self):
        body = self.get(f"{COMPARE}?{PERIODS}&limit=3")
        blocks = {block["currency"]: block for block in body["currencies"]}
        euro = blocks["EUR"]
        self.assertEqual(euro["base"], {
            "receipts_count": 48, "months": "12.02", "receipts_per_month": "3.99", "refunds_excluded": 0,
            "total": "1296.41", "avg_receipt": "27.01", "median_receipt": "27.28",
            "lines_count": 552, "lines_per_receipt": "11.50", "paid_per_line": "2.3486",
        })
        self.assertEqual(euro["current"], {
            "receipts_count": 36, "months": "8.97", "receipts_per_month": "4.01", "refunds_excluded": 1,
            "total": "1646.08", "avg_receipt": "45.72", "median_receipt": "45.52",
            "lines_count": 528, "lines_per_receipt": "14.67", "paid_per_line": "3.1176",
        })
        self.assertEqual(euro["change"], {"avg_receipt": "18.71", "avg_receipt_percent": "69.27"})
        self.assertEqual(euro["effects"], {
            "quantity": "8.65", "price": "7.39", "mix": "2.67", "price_per_line": "10.06",
            "quantity_percent": "46.23", "price_percent": "39.50", "mix_percent": "14.27",
        })
        self.assertEqual(euro["price_index"], {
            "fisher": "1.2404", "laspeyres": "1.2403", "paasche": "1.2405", "matched_products": 24,
            "coverage_base_percent": "96.97", "coverage_current_percent": "79.05",
        })
        self.assertEqual(euro["products_total"], 24)
        self.assertEqual(
            [(item["product"]["name"], item["unit"], item["base"]["price"], item["current"]["price"],
              item["price_change_percent"]) for item in euro["products"]],
            [("Demo Hähnchenbrust 600g", "pcs", "6.1700", "7.8661", "27.49"),
             ("Demo Gouda Scheiben 400g", "pcs", "3.0768", "3.8653", "25.62"),
             ("Demo Küchenrolle", "pcs", "2.7208", "3.3106", "21.68")],
        )
        tenge = blocks["KZT"]
        self.assertEqual(tenge["change"], {"avg_receipt": "4424.92", "avg_receipt_percent": "144.88"})
        self.assertEqual(tenge["effects"], {
            "quantity": "1516.66", "price": "2822.60", "mix": "85.66", "price_per_line": "2908.26",
            "quantity_percent": "34.28", "price_percent": "63.79", "mix_percent": "1.94",
        })
        self.assertEqual(tenge["price_index"], {
            "fisher": "1.7853", "laspeyres": "1.7926", "paasche": "1.7780", "matched_products": 11,
            "coverage_base_percent": "95.89", "coverage_current_percent": "97.04",
        })
        for block in blocks.values():
            effects = block["effects"]
            self.assertEqual(
                D(effects["quantity"]) + D(effects["price"]) + D(effects["mix"]), D(block["change"]["avg_receipt"]),
            )
            self.assertEqual(D(effects["price"]) + D(effects["mix"]), D(effects["price_per_line"]))

        nord = Store.objects.get(name="Zahlenfrisch")
        one = self.get(f"{COMPARE}?{PERIODS}&store={nord.pk}")["currencies"]
        self.assertEqual([block["currency"] for block in one], ["EUR"])
        self.assertEqual(
            (one[0]["base"]["avg_receipt"], one[0]["current"]["avg_receipt"], one[0]["price_index"]["fisher"]),
            ("27.01", "45.14", "1.2402"),
        )
        self.assertEqual(one[0]["effects"]["quantity"], "8.59")
        self.assertEqual((one[0]["effects"]["price"], one[0]["effects"]["mix"]), ("7.38", "2.16"))

    def test_milk_price_series_in_two_countries(self):
        milk = self.product("Demo Frischmilch 1,5% 1L")

        def rows(body):
            return [
                (entry["role"], entry["product"]["name"], entry["store"] and entry["store"]["name"], entry["country"],
                 entry["currency"], entry["unit"], entry["comparable"], entry["observations"], len(entry["points"]),
                 entry["points"][0]["avg"], entry["points"][-1]["last"])
                for entry in body["series"]
            ]

        paid = self.get(f"/api/products/{milk.pk}/prices/series/")
        self.assertEqual(paid["generic"], {"id": milk.generic_id, "name": "Молоко", "base_unit": "l"})
        self.assertEqual(paid["similar"], {"status": "ok", "products_total": 2, "products_shown": 2})
        self.assertEqual(rows(paid), [
            ("own", "Demo Frischmilch 1,5% 1L", "Zahlenfrisch", "DE", "EUR", "pcs", False, 279, 93, "0.7900", "1.0700"),
            ("similar", "Demo Landmilch 3,5% 1L", None, "DE", "EUR", "pcs", False, 93, 93, "0.9400", "1.2500"),
            ("similar", "Демо Молоко 2,5% 1 л", None, "KZ", "KZT", "pcs", False, 93, 93, "340.0000", "695.0000"),
        ])
        normalized = self.get(f"/api/products/{milk.pk}/prices/series/?price=normalized")
        self.assertEqual(normalized["skipped_without_normalized"], 0)
        self.assertEqual(
            [(row[3], row[4], row[5], row[6]) for row in rows(normalized)],
            [("DE", "EUR", "l", True), ("DE", "EUR", "l", True), ("KZ", "KZT", "l", True)],
        )
        # Товар общего ассортимента — своя линия на каждый магазин; яблоки весовые, цена уже за кг.
        apples = self.get(f"/api/products/{self.product('Demo Äpfel lose').pk}/prices/series/?price=normalized")
        self.assertEqual(
            [(row[0], row[1], row[2], row[3], row[5], row[6], row[7], row[9], row[10]) for row in rows(apples)],
            [("own", "Demo Äpfel lose", "Zahlenfrisch", "DE", "kg", True, 130, "2.4906", "3.1657"),
             ("own", "Demo Äpfel lose", "Beispielkorb", "DE", "kg", True, 44, "2.6415", "3.3617"),
             ("similar", "Демо Яблоки весовые", None, "KZ", "kg", True, 45, "480.0000", "959.0000")],
        )
        unassigned = self.get(f"/api/products/{self.product('Demo Butterkeks').pk}/prices/series/")
        self.assertEqual(unassigned["similar"], {"status": "generic_unassigned", "products_total": 0, "products_shown": 0})
        self.assertEqual({entry["role"] for entry in unassigned["series"]}, {"own"})
