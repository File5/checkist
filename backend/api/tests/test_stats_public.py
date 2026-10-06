"""Эталонные JSON статистики для клиента: полные HTTP-ответы на демо ``seed_stats_demo``.

Файлы ``fixtures/stats/*.json`` — тела ответов без изменений: по ним клиент проверяет
свои runtime-схемы. Запрос каждого эталона — в ``EXAMPLES``. Счётчики id перед демо
сброшены, поэтому id в эталонах те же, что на свежей базе после ``migrate`` и
``seed_stats_demo``: категория «Продукты питания» — 1, обобщённый продукт «Молоко» — 1,
его товары — 1, 2, 3, магазины — 1, 2, 3.
"""
import json
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.test_stats_spending import absorb
from catalog.models import Category, GenericProduct, Product
from merges import services
from receipts import basket, demo
from stores.models import Store

D = Decimal
FIXTURES = Path(__file__).resolve().parent / "fixtures/stats"
SPENDING = "/api/stats/spending/"
SERIES = "/api/stats/receipts/series/"
COMPARE = "/api/stats/receipts/compare/"
PRICES = "/api/products/{}/prices/series/"
# Главный вопрос демо: 2020 год против января — сентября 2026.
PERIODS = "base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-09-30"
FOOD, DAIRY, MILK_GENERIC = 1, 2, 1
MILK, OTHER_MILK, KZ_MILK, APPLES, COOKIES = 1, 2, 3, 6, 11
NORD, SUED, KZ = 1, 2, 3
# Счётчик интервалов уменьшен: на демо 1000 интервалов не набрать.
SMALL_RANGE = "error-range-too-large.json"
FORBIDDEN = "error-permission-denied.json"

# Имя эталона: (запрос, HTTP-статус).
EXAMPLES = {
    # Траты: категории, drill-down, обобщённые продукты, товары, магазины.
    "spending-category.json": (SPENDING, 200),
    "spending-category-drilldown.json": (f"{SPENDING}?category={FOOD}&currency=EUR", 200),
    "spending-generic.json": (f"{SPENDING}?group_by=generic&currency=EUR&limit=5", 200),
    "spending-product.json": (f"{SPENDING}?group_by=product&limit=3&date_from=2026-01-01&date_to=2026-09-30", 200),
    "spending-store.json": (f"{SPENDING}?group_by=store", 200),
    # Фильтр generic: receipts_total и difference — null.
    "spending-generic-filter.json": (f"{SPENDING}?generic={MILK_GENERIC}&group_by=product", 200),
    # День с одним чеком возврата: отрицательная сумма, доли нет.
    "spending-refund-day.json": (f"{SPENDING}?date_from=2026-03-14&date_to=2026-03-14", 200),
    "spending-empty.json": (f"{SPENDING}?date_from=2018-01-01&date_to=2018-12-31", 200),
    # Походы по времени.
    "series-year.json": (f"{SERIES}?interval=year", 200),
    "series-month.json": (f"{SERIES}?currency=EUR&date_from=2026-01-01&date_to=2026-09-30", 200),
    "series-empty.json": (f"{SERIES}?date_to=2018-12-31", 200),
    # Разложение изменения среднего чека.
    "compare-2020-2026.json": (f"{COMPARE}?{PERIODS}&limit=5", 200),
    # Два дня в разных магазинах без общих товаров: индекса цен нет, цены и состав не разделены.
    "compare-no-matched-products.json": (
        f"{COMPARE}?base_from=2020-01-04&base_to=2020-01-04&current_from=2026-02-18&current_to=2026-02-18"
        "&currency=EUR", 200,
    ),
    # Походы только в текущем периоде: effects — null.
    "compare-one-sided.json": (
        f"{COMPARE}?base_from=2018-01-01&base_to=2018-12-31&current_from=2026-09-01&current_to=2026-09-30"
        "&currency=KZT", 200,
    ),
    "compare-empty.json": (
        f"{COMPARE}?base_from=2017-01-01&base_to=2017-12-31&current_from=2018-01-01&current_to=2018-12-31", 200,
    ),
    # Ряды цен: «Молоко» в двух странах, весовые яблоки в двух магазинах.
    "price-series-milk-paid.json": (f"{PRICES.format(MILK)}?date_from=2025-01-01", 200),
    "price-series-milk-normalized.json": (f"{PRICES.format(MILK)}?price=normalized&date_from=2025-01-01", 200),
    "price-series-apples-normalized.json": (f"{PRICES.format(APPLES)}?price=normalized&date_from=2026-01-01", 200),
    "price-series-unassigned.json": (f"{PRICES.format(COOKIES)}?date_from=2026-01-01", 200),
    "price-series-similar-none.json": (
        f"{PRICES.format(MILK)}?similar=none&interval=week&date_from=2026-09-01", 200,
    ),
    "price-series-empty.json": (f"{PRICES.format(MILK)}?date_to=2018-12-31", 200),
    # Ошибки.
    "error-invalid-parameter.json": (
        f"{SPENDING}?date_from=2026-13-01&country=de1&currency=E&store=99&group_by=brand&category=x&limit=0", 400,
    ),
    "error-required-parameter.json": (COMPARE, 400),
    "error-periods-overlap.json": (
        f"{COMPARE}?base_from=2020-01-01&base_to=2026-01-01&current_from=2026-01-01&current_to=2026-09-30", 400,
    ),
    SMALL_RANGE: (f"{SERIES}?interval=week", 400),
    FORBIDDEN: (SPENDING, 403),
    "error-not-found.json": (PRICES.format(999999), 404),
}
# Закрытые поля демо: юридическое название, налоговый номер, номер чека.
PRIVATE = ("вымышлен", "DEMOSTATS", demo.RECEIPT_PREFIX)


def expected(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def restart_ids(*models):
    """Объекты демо получают id с 1, как на свежей базе: эталоны сравниваются целиком."""
    with connection.cursor() as cursor:
        for model in models:
            cursor.execute("SELECT setval(pg_get_serial_sequence(%s, 'id'), 1, false)", [model._meta.db_table])


def spending_identities(test, body):
    """``Σ items + other = lines_paid``; ``lines_paid + difference = receipts_total``; доли — от положительных."""
    for block in body["currencies"]:
        totals, other = block["totals"], block["other"]
        parts = [D(item["amount"]) for item in block["items"]] + ([D(other["amount"])] if other else [])
        test.assertEqual(sum(parts), D(totals["lines_paid"]))
        if totals["receipts_total"] is None:
            test.assertIsNone(totals["difference"])
        else:
            test.assertEqual(D(totals["lines_paid"]) + D(totals["difference"]), D(totals["receipts_total"]))
        positive = sum(part for part in parts if part > 0)
        for part in (*block["items"], *([other] if other else [])):
            if D(part["amount"]) <= 0:
                test.assertIsNone(part["share_percent"])
            else:
                share = (D(part["amount"]) * 100 / positive).quantize(D("0.01"), rounding="ROUND_HALF_UP")
                test.assertEqual(D(part["share_percent"]), share)


def compare_identities(test, body):
    """``quantity + price + mix = change``; без индекса цен — ``quantity + price_per_line = change``."""
    for block in body["currencies"]:
        effects, index, change = block["effects"], block["price_index"], block["change"]["avg_receipt"]
        if change is not None:
            test.assertEqual(D(block["current"]["avg_receipt"]) - D(block["base"]["avg_receipt"]), D(change))
        if effects is None:
            continue
        test.assertEqual(D(effects["quantity"]) + D(effects["price_per_line"]), D(change))
        if index is None:
            test.assertEqual((effects["price"], effects["mix"]), (None, None))
            test.assertEqual((block["products"], block["products_total"]), ([], 0))
        else:
            test.assertEqual(D(effects["quantity"]) + D(effects["price"]) + D(effects["mix"]), D(change))
            test.assertEqual(D(effects["price"]) + D(effects["mix"]), D(effects["price_per_line"]))
            test.assertEqual(index["matched_products"], block["products_total"])


class PublicExampleFilesTests(SimpleTestCase):
    def test_files_are_the_documented_set(self):
        self.assertEqual({path.name for path in FIXTURES.glob("*")}, set(EXAMPLES))

    def test_examples_are_utf8_lf_json(self):
        for path in sorted(FIXTURES.glob("*.json")):
            with self.subTest(name=path.name):
                raw = path.read_bytes()
                self.assertNotIn(b"\r", raw)
                self.assertEqual(
                    raw.decode("utf-8"), json.dumps(json.loads(raw), ensure_ascii=False, indent=2) + "\n",
                )

    def test_examples_have_no_private_fields(self):
        for name in EXAMPLES:
            text = (FIXTURES / name).read_text(encoding="utf-8")
            for private in (*PRIVATE, "legal_name", "tax_id", "raw_text", "fiscal", "receipt_number"):
                self.assertNotIn(private, text, name)

    def test_identities_in_examples(self):
        for name in EXAMPLES:
            with self.subTest(name=name):
                if name.startswith("spending-"):
                    spending_identities(self, expected(name))
                elif name.startswith("compare-"):
                    compare_identities(self, expected(name))

    def test_examples_cover_the_optional_shapes(self):
        """Клиентские схемы проверяются на этих файлах: в них должны быть и значения, и ``null``."""
        main = expected("compare-2020-2026.json")["currencies"]
        self.assertEqual([block["currency"] for block in main], ["EUR", "KZT"])
        self.assertTrue(all(block["effects"]["mix"] and block["price_index"] and block["products"] for block in main))
        unmatched = expected("compare-no-matched-products.json")["currencies"][0]
        self.assertIsNone(unmatched["price_index"])
        self.assertIsNotNone(unmatched["effects"]["price_per_line"])
        one_sided = expected("compare-one-sided.json")["currencies"][0]
        self.assertEqual((one_sided["base"]["receipts_count"], one_sided["effects"]), (0, None))
        self.assertIsNone(one_sided["base"]["avg_receipt"])

        kinds = {item["kind"] for block in expected("spending-category.json")["currencies"] for item in block["items"]}
        self.assertEqual(kinds, {"category", "unmatched", "service", "deposit"})
        drill = expected("spending-category-drilldown.json")
        self.assertEqual(drill["parent"]["id"], FOOD)
        self.assertIn(True, [item["direct"] for item in drill["currencies"][0]["items"]])
        self.assertIsNotNone(expected("spending-generic.json")["currencies"][0]["other"])
        self.assertIsNotNone(expected("spending-product.json")["currencies"][0]["items"][0]["quantity"])
        self.assertIn("city", expected("spending-store.json")["currencies"][0]["items"][0])
        self.assertIsNone(expected("spending-generic-filter.json")["currencies"][0]["totals"]["receipts_total"])
        self.assertIsNone(expected("spending-refund-day.json")["currencies"][0]["items"][0]["share_percent"])

        statuses = {
            name: expected(name)["similar"]["status"] for name in EXAMPLES if name.startswith("price-series-")
        }
        self.assertEqual(set(statuses.values()), {"ok", "disabled", "generic_unassigned", "none"})
        paid, normalized = expected("price-series-milk-paid.json"), expected("price-series-milk-normalized.json")
        self.assertEqual({entry["comparable"] for entry in paid["series"]}, {False})
        self.assertEqual({entry["comparable"] for entry in normalized["series"]}, {True})
        self.assertEqual({entry["currency"] for entry in paid["series"]}, {"EUR", "KZT"})
        self.assertEqual([entry["store"] is None for entry in paid["series"]], [False, True, True])
        for name in ("spending-empty.json", "series-empty.json", "compare-empty.json"):
            self.assertEqual(expected(name)["currencies"], [], name)
        self.assertEqual(expected("price-series-empty.json")["series"], [])
        codes = {name: expected(name)["error"]["code"] for name in EXAMPLES if name.startswith("error-")}
        self.assertEqual(
            set(codes.values()), {"invalid_parameter", "range_too_large", "permission_denied", "not_found"},
        )


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class PublicExamplesTests(TestCase):
    maxDiff = None

    @classmethod
    def setUpTestData(cls):
        restart_ids(Category, GenericProduct, Product, Store)
        demo.seed_demo()

    def setUp(self):
        self.client = APIClient()

    def fetch(self, name):
        path, status = EXAMPLES[name]
        if name == FORBIDDEN:
            with self.settings(ALLOW_LOCAL_RECOGNITION_API=False):
                response = self.client.get(path)
        elif name == SMALL_RANGE:
            with patch.object(basket, "MAX_BUCKETS", 5):
                response = self.client.get(path)
        else:
            response = self.client.get(path)
        self.assertEqual(response.status_code, status, response.content)
        if path.startswith("/api/stats/"):
            self.assertEqual(response["Cache-Control"], "no-store")
        return response

    def get(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def assert_examples(self):
        for name in EXAMPLES:
            with self.subTest(name=name):
                response = self.fetch(name)
                for private in PRIVATE:
                    self.assertNotIn(private, response.content.decode("utf-8"))
                self.assertEqual(response.json(), expected(name))

    def test_autovacuum_is_disabled_in_the_test_database(self):
        """Иначе фоновая очистка посреди класса обнуляет оценки планировщика, и запросы по демо не успевают."""
        with connection.cursor() as cursor:
            cursor.execute(
                "SELECT relname FROM pg_class WHERE relname IN ('receipts_receipt', 'receipts_receiptline')"
                " AND reloptions @> ARRAY['autovacuum_enabled=false'] ORDER BY relname"
            )
            self.assertEqual([row[0] for row in cursor.fetchall()], ["receipts_receipt", "receipts_receiptline"])

    def test_demo_ids_are_those_of_a_fresh_database(self):
        self.assertEqual(Category.objects.get(name="Продукты питания").pk, FOOD)
        self.assertEqual(Category.objects.get(name="Молочные продукты").pk, DAIRY)
        self.assertEqual(GenericProduct.objects.get(name="Молоко").pk, MILK_GENERIC)
        self.assertEqual(
            list(Product.objects.filter(pk__in=(MILK, OTHER_MILK, KZ_MILK, APPLES, COOKIES)).values_list("pk", "name")),
            [(MILK, "Demo Frischmilch 1,5% 1L"), (OTHER_MILK, "Demo Landmilch 3,5% 1L"),
             (KZ_MILK, "Демо Молоко 2,5% 1 л"), (APPLES, "Demo Äpfel lose"), (COOKIES, "Demo Butterkeks")],
        )
        self.assertEqual(
            list(Store.objects.order_by("pk").values_list("pk", "name")),
            [(NORD, "Zahlenfrisch"), (SUED, "Beispielkorb"), (KZ, "Статмаркет")],
        )

    def test_public_examples_match_actual_http_responses(self):
        self.assert_examples()

    def test_statistics_require_the_local_flag_but_price_series_do_not(self):
        with self.settings(ALLOW_LOCAL_RECOGNITION_API=False):
            for path in (SPENDING, f"{SERIES}?interval=year", f"{COMPARE}?{PERIODS}"):
                response = self.client.get(path)
                self.assertEqual((response.status_code, response.json()), (403, expected(FORBIDDEN)), path)
            name = "price-series-milk-paid.json"
            self.assertEqual(self.get(EXAMPLES[name][0]), expected(name))

    def test_spending_identities_hold_across_filters(self):
        queries = [""]
        for group_by in ("category", "generic", "product", "store"):
            for extra in (
                "", "&limit=1", "&limit=50", "&currency=EUR", "&country=KZ", f"&store={NORD},{KZ}",
                f"&category={FOOD}", f"&category={DAIRY}&limit=2", f"&generic={MILK_GENERIC}",
                "&date_from=2026-03-01&date_to=2026-03-31", "&date_from=2026-05-18&date_to=2026-05-18",
                "&date_to=2019-01-31",
            ):
                queries.append(f"group_by={group_by}{extra}")
        for query in queries:
            with self.subTest(query=query):
                body = self.get(f"{SPENDING}?{query}")
                self.assertTrue(body["currencies"])
                spending_identities(self, body)

    def test_spending_groupings_agree_with_each_other(self):
        """Одни и те же строки, разрезанные по-разному, дают одну сумму; у магазинов — сумму чеков."""
        march = "date_from=2026-03-01&date_to=2026-03-31"
        for period in ("", march):
            totals = [
                [(block["currency"], block["totals"])
                 for block in self.get(f"{SPENDING}?group_by={group_by}&{period}")["currencies"]]
                for group_by in ("category", "generic", "product")
            ]
            self.assertEqual(totals[0], totals[1])
            self.assertEqual(totals[0], totals[2])
            stores = self.get(f"{SPENDING}?group_by=store&{period}")["currencies"]
            self.assertEqual(
                [(block["currency"], block["totals"]["lines_paid"], block["totals"]["difference"]) for block in stores],
                [(currency, found["receipts_total"], "0.00") for currency, found in totals[0]],
            )
        # Скидка на весь чек и налог сверх цен видны только разницей: чек 18 мая 2026 с ценами без налога.
        net = self.get(f"{SPENDING}?date_from=2026-05-18&date_to=2026-05-18")["currencies"][0]["totals"]
        self.assertEqual(net, {
            "receipts_count": 1, "receipts_total": "52.14", "lines_paid": "48.73", "difference": "3.41",
        })
        # Внутри категории: подкатегории и её собственные товары дают её сумму в корне.
        root = self.get(f"{SPENDING}?currency=EUR")["currencies"][0]["items"]
        food = next(item for item in root if item["id"] == FOOD)
        inside = self.get(f"{SPENDING}?category={FOOD}&currency=EUR")["currencies"][0]
        self.assertEqual(inside["totals"]["lines_paid"], food["amount"])
        self.assertEqual(sum(item["lines_count"] for item in inside["items"]), food["lines_count"])

    def test_compare_identities_hold_across_periods_and_stores(self):
        halves = "base_from=2022-01-01&base_to=2022-06-30&current_from=2022-07-01&current_to=2022-12-31"
        reverse = "base_from=2019-01-01&base_to=2019-12-31&current_from=2020-01-01&current_to=2020-01-31"
        queries = [PERIODS, halves, reverse]
        queries += [f"{PERIODS}&store={store}" for store in (NORD, SUED, KZ)]
        queries += [f"{halves}&country=DE", f"{halves}&currency=KZT&limit=1", f"{PERIODS}&limit=100"]
        for year in range(2019, 2026):
            queries.append(
                f"base_from={year}-01-01&base_to={year}-12-31&current_from={year + 1}-01-01&current_to={year + 1}-12-31"
            )
        for query in queries:
            with self.subTest(query=query):
                body = self.get(f"{COMPARE}?{query}")
                self.assertTrue(body["currencies"])
                self.assertTrue(all(block["effects"] for block in body["currencies"]))
                compare_identities(self, body)

    def test_compare_sides_are_the_series_buckets_of_the_same_years(self):
        years = {
            block["currency"]: {bucket["period_start"]: bucket for bucket in block["buckets"]}
            for block in self.get(f"{SERIES}?interval=year")["currencies"]
        }
        whole = "base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-12-31"
        for block in self.get(f"{COMPARE}?{whole}")["currencies"]:
            for side, start in (("base", "2020-01-01"), ("current", "2026-01-01")):
                bucket = dict(years[block["currency"]][start])
                del bucket["period_start"]
                found = {key: block[side][key] for key in bucket}
                self.assertEqual(found, bucket, (block["currency"], side))
        # В 2020 году возвратов нет: сумма походов равна сумме всех чеков в тратах.
        spent = self.get(f"{SPENDING}?date_from=2020-01-01&date_to=2020-12-31")["currencies"]
        self.assertEqual(
            [(block["currency"], block["totals"]["receipts_total"]) for block in spent],
            [(currency, buckets["2020-01-01"]["total"]) for currency, buckets in years.items()],
        )

    def test_series_buckets_are_consistent(self):
        for interval in ("month", "week", "quarter", "year"):
            body = self.get(f"{SERIES}?interval={interval}")
            self.assertEqual([block["currency"] for block in body["currencies"]], ["EUR", "KZT"])
            for block in body["currencies"]:
                starts = [bucket["period_start"] for bucket in block["buckets"]]
                self.assertEqual(starts, sorted(set(starts)))
                self.assertEqual(sum(bucket["receipts_count"] for bucket in block["buckets"]),
                                 {"EUR": 372, "KZT": 93}[block["currency"]])
                for bucket in block["buckets"]:
                    count, total, lines = bucket["receipts_count"], D(bucket["total"]), bucket["lines_count"]
                    self.assertEqual(D(bucket["avg_receipt"]), (total / count).quantize(D("0.01"), "ROUND_HALF_UP"))
                    self.assertEqual(
                        D(bucket["lines_per_receipt"]), (D(lines) / count).quantize(D("0.01"), "ROUND_HALF_UP"),
                    )
                    self.assertEqual(
                        D(bucket["paid_per_line"]), (total / lines).quantize(D("0.0001"), "ROUND_HALF_UP"),
                    )

    def test_pending_merge_hides_the_absorbed_product_and_cancel_restores_the_numbers(self):
        """Строки поглощённого товара считаются у оставляемого; отмена группы возвращает суммы."""
        by_product = f"{SPENDING}?group_by=product&currency=EUR&limit=50"
        before = self.get(by_product)["currencies"][0]
        amounts = {item["id"]: D(item["amount"]) for item in before["items"]}
        group = absorb(Product.objects.get(pk=MILK), Product.objects.get(pk=OTHER_MILK))

        merged = self.get(by_product)["currencies"][0]
        found = {item["id"]: item for item in merged["items"]}
        self.assertNotIn(OTHER_MILK, found)
        self.assertEqual(D(found[MILK]["amount"]), amounts[MILK] + amounts[OTHER_MILK])
        self.assertEqual(merged["totals"], before["totals"])
        spending_identities(self, {"currencies": [merged]})
        compared = self.get(f"{COMPARE}?{PERIODS}&currency=EUR&limit=100")
        compare_identities(self, compared)
        ids = [pair["product"]["id"] for pair in compared["currencies"][0]["products"]]
        self.assertIn(MILK, ids)
        self.assertNotIn(OTHER_MILK, ids)
        self.assertEqual(compared["currencies"][0]["products_total"], 23)
        # В рядах цен: поглощённый — не «похожий», его магазин стал вторым рядом оставляемого.
        series = self.get(PRICES.format(MILK))
        self.assertEqual(
            [(entry["role"], entry["product"]["id"], entry["store"] and entry["store"]["id"], entry["observations"])
             for entry in series["series"]],
            [("own", MILK, NORD, 279), ("own", MILK, SUED, 93), ("similar", KZ_MILK, None, 93)],
        )
        self.assertEqual(series["similar"], {"status": "ok", "products_total": 1, "products_shown": 1})
        self.assertEqual(self.client.get(PRICES.format(OTHER_MILK)).status_code, 404)
        hidden = Product.objects.get(pk=OTHER_MILK).name
        for path in (SPENDING, by_product, f"{SPENDING}?group_by=generic", f"{COMPARE}?{PERIODS}&limit=100",
                     PRICES.format(MILK), PRICES.format(KZ_MILK)):
            self.assertNotIn(hidden, self.client.get(path).content.decode("utf-8"), path)

        services.cancel(group.pk)
        self.assertEqual(self.get(by_product)["currencies"][0], before)
        self.assert_examples()
