from datetime import date, datetime, time
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.db import OperationalError
from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.factories import make_product, make_receipt
from api.tests.test_stats_spending import _Lines, absorb
from catalog.models import Brand, Category, GenericProduct
from merges import services
from receipts import basket
from receipts.models import Receipt, ReceiptLine
from receipts.tests import samples

D = Decimal
SERIES = "/api/stats/receipts/series/"
COMPARE = "/api/stats/receipts/compare/"
PERIODS = "base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-12-31"
REFUND = Receipt.Operation.REFUND


def basket_data():
    """Походы в Lidl (EUR) в 2020 и 2026 годах и один в ДНС (KZT) в 2026; названия вымышленные.

    2020: три чека 10.00 + 6.00 + 8.00, семь товарных строк, один возврат.
    2026: два чека 20.00 + 30.00, восемь товарных строк, один возврат.
    Совпали «молоко, шт» 1.00 → 1.50, «молоко, л» 1.60 → 2.00, «хлеб, шт» 2.50 → 3.00.
    """
    lidl, dns = samples.lidl_store(), samples.dns_store()
    category = Category.objects.create(name="Продукты питания")

    def product(name):
        generic = GenericProduct.objects.create(name=name, category=category, base_unit="pcs")
        return make_product(generic, f"Демо-{name.lower()}")

    milk, bread, cheese, juice = product("Молоко"), product("Хлеб"), product("Сыр"), product("Сок")

    first = make_receipt(lidl, "EUR", date(2020, 1, 6), total=D("10.00"))  # понедельник
    lines = _Lines(first)
    lines.add(milk, "2.00", quantity="2")
    lines.add(bread, "3.00", discount_amount=D("0.50"))
    lines.add(cheese, "4.00")
    lines.add(None, "1.50", raw_name="UNBEKANNT")
    second = make_receipt(lidl, "EUR", date(2020, 1, 12), at=time(23, 30), total=D("6.00"))  # воскресенье
    lines = _Lines(second)
    lines.add(milk, "1.00")
    lines.add(bread, "5.00", quantity="2")
    lines.add(None, "0.25", kind="deposit", raw_name="Pfand")
    third = make_receipt(lidl, "EUR", date(2020, 2, 3), total=D("8.00"))
    lines = _Lines(third)
    lines.add(milk, "0.80", quantity="0.5", unit="l")
    lines.add(None, "7.20", kind="service", raw_name="Доставка")
    old_refund = make_receipt(lidl, "EUR", date(2020, 3, 1), total=D("-1.00"), operation=REFUND)
    _Lines(old_refund).add(milk, "-1.00", quantity="-1")

    fourth = make_receipt(lidl, "EUR", date(2026, 3, 2), total=D("20.00"))
    lines = _Lines(fourth)
    lines.add(milk, "3.00", quantity="2")
    lines.add(bread, "3.00")
    lines.add(juice, "5.00", quantity="2")
    lines.add(None, "4.00", raw_name="UNBEKANNT")
    fifth = make_receipt(lidl, "EUR", date(2026, 3, 20), total=D("30.00"))
    lines = _Lines(fifth)
    lines.add(milk, "6.00", quantity="4")
    lines.add(bread, "9.60", quantity="3", discount_amount=D("0.60"))
    lines.add(juice, "2.50")
    lines.add(milk, "2.00", unit="l")
    lines.add(None, "-0.25", quantity="-1", kind="deposit_return", raw_name="Pfandrückgabe")
    new_refund = make_receipt(lidl, "EUR", date(2026, 4, 1), total=D("-3.00"), operation=REFUND)
    _Lines(new_refund).add(bread, "-3.00", quantity="-1")
    # 01:00 в Алматы — ещё 1 марта по UTC: в интервал чек входит по локальной дате.
    kzt = make_receipt(dns, "KZT", date(2026, 3, 2), at=time(1, 0), total=D("900.00"))
    _Lines(kzt).add(milk, "900.00")
    return SimpleNamespace(
        lidl=lidl, dns=dns, category=category, milk=milk, bread=bread, cheese=cheese, juice=juice,
        first=first, second=second, third=third, fourth=fourth, fifth=fifth, kzt=kzt,
    )


def bucket(start, count, total, avg, median, lines, per_receipt, per_line):
    return {
        "period_start": start, "receipts_count": count, "total": total, "avg_receipt": avg,
        "median_receipt": median, "lines_count": lines, "lines_per_receipt": per_receipt, "paid_per_line": per_line,
    }


class _StatsTestCase(TestCase):
    maxDiff = None
    url = None

    @classmethod
    def setUpTestData(cls):
        cls.data = basket_data()

    def setUp(self):
        self.client = APIClient()

    def get(self, query=""):
        response = self.client.get(f"{self.url}?{query}")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def eur(self, query=""):
        return next(block for block in self.get(query)["currencies"] if block["currency"] == "EUR")

    def assert_invalid(self, query, fields):
        response = self.client.get(f"{self.url}?{query}")
        self.assertEqual(response.status_code, 400, response.content)
        error = response.json()["error"]
        self.assertEqual((error["code"], error["fields"]), ("invalid_parameter", fields))

    def assert_denied(self, response):
        self.assertEqual(response.status_code, 403, response.content)
        self.assertEqual(response.json()["error"]["code"], "permission_denied")
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertNotIn("currencies", response.content.decode())

    def check_access(self, query=""):
        url = f"{self.url}?{query}"
        with self.settings(ALLOW_LOCAL_RECOGNITION_API=False):
            self.assert_denied(self.client.get(url))
            self.assert_denied(self.client.get(self.url + "?interval=x&limit=0"))
        with self.settings(DEBUG=False):
            self.assert_denied(self.client.get(url))
        self.assert_denied(self.client.get(url, REMOTE_ADDR="10.0.0.5"))
        self.assert_denied(self.client.get(url, REMOTE_ADDR="10.0.0.5", HTTP_X_FORWARDED_FOR="127.0.0.1"))
        self.assertEqual(self.client.get(url, REMOTE_ADDR="::1").status_code, 200)

    def check_methods(self, query=""):
        url = f"{self.url}?{query}"
        self.assertEqual(self.client.head(url).status_code, 200)
        self.assertEqual(self.client.options(url).status_code, 200)
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                ours = getattr(self.client, method)(url)
                theirs = getattr(self.client, method)("/api/receipts/")
                self.assertEqual((ours.status_code, ours.json()), (theirs.status_code, theirs.json()))
                self.assertIn(ours.status_code, (403, 405))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count()), (8, 21))
        for path in (self.url + "extra/", "/api/stats/receipts/", "/api/stats/receipts/unknown/"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "not_found"))
        self.assertEqual(self.client.get(self.url.rstrip("/")).status_code, 301)
        response = self.client.get(url, HTTP_ACCEPT="text/html")
        theirs = self.client.get("/api/receipts/", HTTP_ACCEPT="text/html")
        self.assertEqual((response.status_code, response.json()), (theirs.status_code, theirs.json()))

    def check_hidden_fields(self, query=""):
        content = self.client.get(f"{self.url}?{query}").content.decode()
        for hidden in ("legal_name", "tax_id", "address", "raw_text", "fiscal", "receipt_number"):
            self.assertNotIn(f'"{hidden}"', content)
        self.assertNotIn(self.data.lidl.merchant.tax_id, content)


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class ReceiptSeriesAPITests(_StatsTestCase):
    url = SERIES

    # --- форма ответа ---

    def test_full_response_by_month(self):
        response = self.client.get(SERIES)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response.json(), {
            "interval": "month", "date_from": None, "date_to": None,
            "currencies": [
                {"currency": "EUR", "refunds_excluded": 2, "buckets": [
                    bucket("2020-01-01", 2, "16.00", "8.00", "8.00", 6, "3.00", "2.6667"),
                    bucket("2020-02-01", 1, "8.00", "8.00", "8.00", 1, "1.00", "8.0000"),
                    bucket("2026-03-01", 2, "50.00", "25.00", "25.00", 8, "4.00", "6.2500"),
                ]},
                {"currency": "KZT", "refunds_excluded": 0, "buckets": [
                    bucket("2026-03-01", 1, "900.00", "900.00", "900.00", 1, "1.00", "900.0000"),
                ]},
            ],
        })

    def test_intervals(self):
        def starts(interval):
            return [entry["period_start"] for entry in self.eur(f"interval={interval}")["buckets"]]

        # 6 и 12 января 2020 — понедельник и воскресенье одной недели; 20 марта 2026 — пятница.
        self.assertEqual(starts("week"), ["2020-01-06", "2020-02-03", "2026-03-02", "2026-03-16"])
        self.assertEqual(starts("month"), ["2020-01-01", "2020-02-01", "2026-03-01"])
        self.assertEqual(starts("quarter"), ["2020-01-01", "2026-01-01"])
        self.assertEqual(starts("year"), ["2020-01-01", "2026-01-01"])
        body = self.get("interval=year")
        self.assertEqual(body["interval"], "year")
        self.assertEqual(body["currencies"][0]["buckets"], [
            bucket("2020-01-01", 3, "24.00", "8.00", "8.00", 7, "2.33", "3.4286"),
            bucket("2026-01-01", 2, "50.00", "25.00", "25.00", 8, "4.00", "6.2500"),
        ])
        self.assertEqual(self.eur("interval=week")["buckets"][0],
                         bucket("2020-01-06", 2, "16.00", "8.00", "8.00", 6, "3.00", "2.6667"))

    def test_week_starts_on_monday_across_a_year_boundary(self):
        # 1 января 2021 — пятница: неделя началась 28 декабря 2020; 4 января — следующий понедельник.
        for day in (date(2020, 12, 28), date(2021, 1, 1), date(2021, 1, 3), date(2021, 1, 4)):
            make_receipt(self.data.lidl, "EUR", day, total=D("1.00"))
        found = self.eur("interval=week&date_from=2020-12-01&date_to=2021-01-31")["buckets"]
        self.assertEqual([(entry["period_start"], entry["receipts_count"]) for entry in found],
                         [("2020-12-28", 3), ("2021-01-04", 1)])

    def test_only_sales_are_visits(self):
        block = self.eur()
        self.assertEqual(block["refunds_excluded"], 2)
        # Возвраты 1 марта 2020 и 1 апреля 2026 своих интервалов не дают и суммы не уменьшают.
        self.assertNotIn("2020-03-01", [entry["period_start"] for entry in block["buckets"]])
        self.assertEqual(sum(D(entry["total"]) for entry in block["buckets"]), D("74.00"))
        self.assertEqual(self.eur("date_from=2026-01-01")["refunds_excluded"], 1)
        # Валюта, где есть только возвраты, блока не даёт.
        self.assertEqual(self.get("date_from=2020-03-01&date_to=2020-03-01")["currencies"], [])
        make_receipt(self.data.lidl, "KZT", date(2020, 3, 1), total=D("-5.00"), operation=REFUND)
        self.assertEqual(self.get(f"store={self.data.lidl.pk}&currency=KZT")["currencies"], [])

    def test_lines_are_product_lines_with_positive_quantity(self):
        receipt = make_receipt(self.data.lidl, "EUR", date(2024, 5, 1), total=D("3.00"))
        lines = _Lines(receipt)
        lines.add(self.data.milk, "-1.00", quantity="-1")  # сторно внутри продажи — не позиция
        lines.add(None, "0.25", kind="deposit", raw_name="Pfand")
        lines.add(None, "3.75", kind="service", raw_name="Доставка")
        found = self.eur("date_from=2024-01-01&date_to=2024-12-31")["buckets"]
        self.assertEqual(found, [bucket("2024-05-01", 1, "3.00", "3.00", "3.00", 0, "0.00", None)])
        lines.add(None, "1.00", raw_name="UNBEKANNT")  # несопоставленная строка товара — позиция
        found = self.eur("date_from=2024-01-01&date_to=2024-12-31")["buckets"]
        self.assertEqual((found[0]["lines_count"], found[0]["paid_per_line"]), (1, "3.0000"))

    def test_median_is_percentile_cont(self):
        def median(*totals):
            Receipt.objects.filter(purchased_on__year=2023).delete()
            for number, total in enumerate(totals):
                make_receipt(self.data.lidl, "EUR", date(2023, 6, 1 + number), total=D(total))
            (found,) = self.eur("date_from=2023-01-01&date_to=2023-12-31")["buckets"]
            return found["median_receipt"]

        self.assertEqual(median("10.00", "40.00", "20.00"), "20.00")
        self.assertEqual(median("10.00", "40.00", "20.00", "25.00"), "22.50")
        # Середина 10.01 и 10.02 — 10.015: до двух знаков по ROUND_HALF_UP, без потерь double.
        self.assertEqual(median("10.02", "10.01"), "10.02")
        self.assertEqual(median("0.01", "0.02"), "0.02")
        self.assertEqual(median("-10.02", "-10.01"), "-10.02")
        self.assertEqual(median("999999999999.98", "999999999999.99"), "999999999999.99")
        self.assertEqual(median("1.00", "1.00", "1.00", "100.00"), "1.00")

    # --- период, фильтры ---

    def test_period_bounds_are_inclusive_local_dates(self):
        body = self.get("date_from=2020-01-12&date_to=2020-02-03")
        self.assertEqual((body["date_from"], body["date_to"]), ("2020-01-12", "2020-02-03"))
        (block,) = body["currencies"]
        self.assertEqual([(entry["period_start"], entry["total"]) for entry in block["buckets"]],
                         [("2020-01-01", "6.00"), ("2020-02-01", "8.00")])
        self.assertEqual(block["refunds_excluded"], 0)
        self.assertEqual(self.get("date_from=2020-01-13&date_to=2020-02-02")["currencies"], [])
        # Чек KZT: 2 марта 01:00 местного времени, 1 марта по UTC.
        kzt = self.get("date_from=2026-03-02&date_to=2026-03-02&interval=week&currency=KZT")["currencies"]
        self.assertEqual([entry["period_start"] for entry in kzt[0]["buckets"]], ["2026-03-02"])
        whole = self.get("interval=week")
        with self.settings(TIME_ZONE="Asia/Tokyo"):
            self.assertEqual(self.get("interval=week"), whole)

    def test_filters(self):
        data = self.data
        self.assertEqual([block["currency"] for block in self.get("country=kz")["currencies"]], ["KZT"])
        self.assertEqual([block["currency"] for block in self.get("currency=eur")["currencies"]], ["EUR"])
        self.assertEqual(self.get("country=DE&currency=KZT")["currencies"], [])
        self.assertEqual([block["currency"] for block in self.get(f"store={data.dns.pk}")["currencies"]], ["KZT"])
        both = self.get(f"store={data.dns.pk},{data.lidl.pk}")
        self.assertEqual([block["currency"] for block in both["currencies"]], ["EUR", "KZT"])
        self.assertEqual(self.get("country=RU")["currencies"], [])
        self.assertEqual(self.get("date_from=&country=%20&store=&interval=&unknown=1&limit=x"), self.get())

    def test_one_currency_per_block_even_in_one_store(self):
        receipt = make_receipt(self.data.lidl, "KZT", date(2026, 3, 3), total=D("700.00"))
        _Lines(receipt).add(self.data.milk, "700.00")
        eur, kzt = self.get(f"store={self.data.lidl.pk}&interval=year&date_from=2026-01-01")["currencies"]
        self.assertEqual((eur["buckets"][0]["total"], kzt["buckets"][0]["total"]), ("50.00", "700.00"))

    # --- пределы, запросы ---

    def test_range_too_large(self):
        with patch("receipts.basket.MAX_BUCKETS", 4):
            self.assertEqual(sum(len(block["buckets"]) for block in self.get()["currencies"]), 4)
            response = self.client.get(f"{SERIES}?interval=week")  # 4 интервала EUR + 1 KZT
            self.assertEqual(response.status_code, 400, response.content)
            self.assertEqual(response.json()["error"]["code"], "range_too_large")
            self.assertNotIn("fields", response.json()["error"])
            self.assertEqual(len(self.eur("interval=week&currency=EUR")["buckets"]), 4)

    def test_range_limit_is_1000_intervals(self):
        self.assertEqual(basket.MAX_BUCKETS, 1000)
        days = [date.fromordinal(date(1990, 1, 1).toordinal() + 7 * number) for number in range(1001)]  # понедельники
        Receipt.objects.bulk_create([
            Receipt(
                store=self.data.lidl, currency_id="EUR", operation="sale", total=D("1.00"), purchased_on=day,
                purchased_at=datetime.combine(day, time(12, 0), tzinfo=ZoneInfo("Europe/Berlin")),
                receipt_number=f"range-{number}",
            )
            for number, day in enumerate(days)
        ])
        response = self.client.get(f"{SERIES}?date_to={days[-1]}&interval=week")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (400, "range_too_large"))
        self.assertEqual(len(self.eur(f"date_to={days[-2]}&interval=week")["buckets"]), 1000)
        self.assertEqual(len(self.eur(f"date_from={days[1]}&date_to={days[-1]}&interval=week")["buckets"]), 1000)
        self.assertLess(len(self.eur(f"date_to={days[-1]}&interval=month")["buckets"]), 1000)

    def test_query_count_is_constant(self):
        data = self.data
        filters = f"country=DE&currency=EUR&store={data.lidl.pk}&date_from=2020-01-01&date_to=2026-12-31"
        cases = (("", 3), ("interval=week", 3), ("interval=year", 3), (filters, 6), ("country=RU", 4))

        def measure():
            for query, expected in cases:
                with self.subTest(query=query), self.assertNumQueries(expected):
                    self.get(query)

        measure()
        for number in range(30):
            receipt = make_receipt(data.lidl, "EUR", date(2021 + number % 4, 1 + number % 12, 5), total=D("2.00"))
            lines = _Lines(receipt)
            lines.add(make_product(data.milk.generic, f"Демо-товар {number}"), "1.50")
            lines.add(None, "0.50", raw_name="UNBEKANNT")
        measure()
        self.assertGreater(len(self.eur()["buckets"]), 10)

    # --- ошибки и доступ ---

    def test_invalid_parameters(self):
        cases = (
            ("interval=day", {"interval": ["Допустимые значения: month, week, quarter, year."]}),
            ("interval=none", {"interval": ["Допустимые значения: month, week, quarter, year."]}),
            ("date_from=2026-13-01", {"date_from": ["Ожидается дата ГГГГ-ММ-ДД."]}),
            ("date_from=2026-03-02&date_to=2026-03-01", {"date_from": ["Должна быть не позже date_to."]}),
            ("country=ZZ", {"country": ["Неизвестный код страны."]}),
            ("currency=EU", {"currency": ["Ожидается код валюты из трёх букв."]}),
            ("store=999999", {"store": ["Магазин не найден."]}),
            ("store=1,,2", {"store": ["Ожидаются целые положительные числа через запятую."]}),
        )
        for query, fields in cases:
            with self.subTest(query=query):
                self.assert_invalid(query, fields)
        self.assert_invalid("interval=x&date_to=y&country=ZZ&currency=1&store=a", {
            "interval": ["Допустимые значения: month, week, quarter, year."],
            "date_to": ["Ожидается дата ГГГГ-ММ-ДД."], "country": ["Неизвестный код страны."],
            "currency": ["Ожидается код валюты из трёх букв."],
            "store": ["Ожидаются целые положительные числа через запятую."],
        })

    def test_access_is_local_only(self):
        self.check_access()

    def test_methods_and_unknown_paths_follow_the_local_api(self):
        self.check_methods()
        self.check_hidden_fields()

    def test_database_failure_is_a_safe_503(self):
        with patch("api.views.stats_receipts.basket.series", side_effect=OperationalError("PRIVATE DSN")):
            response = self.client.get(SERIES)
        self.assertEqual(response.status_code, 503, response.content)
        self.assertEqual(response.json()["error"]["code"], "database_unavailable")
        self.assertNotIn("PRIVATE", response.content.decode())
        self.assertEqual(response["Cache-Control"], "no-store")


def side(count, months, per_month, refunds, total, avg, median, lines, per_receipt, per_line):
    return {
        "receipts_count": count, "months": months, "receipts_per_month": per_month, "refunds_excluded": refunds,
        "total": total, "avg_receipt": avg, "median_receipt": median,
        "lines_count": lines, "lines_per_receipt": per_receipt, "paid_per_line": per_line,
    }


def matched(product, unit, base, current, percent):
    keys = ("price", "quantity", "amount")
    return {
        "product": {"id": product.pk, "name": product.name}, "unit": unit,
        "base": dict(zip(keys, base)), "current": dict(zip(keys, current)), "price_change_percent": percent,
    }


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class ReceiptCompareAPITests(_StatsTestCase):
    url = COMPARE

    def get(self, query=PERIODS):
        return super().get(query)

    def eur(self, query=PERIODS):
        return super().eur(query)

    def assert_identities(self, block):
        effects = block["effects"]
        self.assertEqual(D(block["current"]["avg_receipt"]) - D(block["base"]["avg_receipt"]),
                         D(block["change"]["avg_receipt"]))
        if effects["price"] is not None:
            self.assertEqual(D(effects["quantity"]) + D(effects["price"]) + D(effects["mix"]),
                             D(block["change"]["avg_receipt"]))
            self.assertEqual(D(effects["price"]) + D(effects["mix"]), D(effects["price_per_line"]))
        self.assertEqual(D(effects["quantity"]) + D(effects["price_per_line"]), D(block["change"]["avg_receipt"]))

    # --- форма ответа ---

    def test_full_response(self):
        data = self.data
        response = self.client.get(f"{COMPARE}?{PERIODS}")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        body = response.json()
        self.assertEqual(body, {
            "base": {"date_from": "2020-01-01", "date_to": "2020-12-31"},
            "current": {"date_from": "2026-01-01", "date_to": "2026-12-31"},
            "currencies": [
                {
                    "currency": "EUR",
                    # a 8.00 → 25.00; n 7/3 → 4; p 24/7 → 6.25.
                    "base": side(3, "12.02", "0.25", 1, "24.00", "8.00", "8.00", 7, "2.33", "3.4286"),
                    "current": side(2, "11.99", "0.17", 1, "50.00", "25.00", "25.00", 8, "4.00", "6.2500"),
                    "change": {"avg_receipt": "17.00", "avg_receipt_percent": "212.50"},
                    # количество (4 − 7/3) × (24/7 + 6.25) / 2 = 8.0655; цены 19/6 × 24/7 × (I − 1) = 3.2025.
                    "effects": {"quantity": "8.07", "price": "3.20", "mix": "5.73", "price_per_line": "8.93",
                                "quantity_percent": "47.47", "price_percent": "18.82", "mix_percent": "33.71"},
                    # Лас = 14.5 / 11.3; Пааше = 23 / 17.6; покрытие 11.30 из 16.80 и 23.00 из 34.50.
                    "price_index": {"fisher": "1.2949", "laspeyres": "1.2832", "paasche": "1.3068",
                                    "matched_products": 3,
                                    "coverage_base_percent": "67.26", "coverage_current_percent": "66.67"},
                    "products": [
                        matched(data.milk, "pcs", ("1.0000", "3.000", "3.00"), ("1.5000", "6.000", "9.00"), "50.00"),
                        matched(data.bread, "pcs", ("2.5000", "3.000", "7.50"), ("3.0000", "4.000", "12.00"), "20.00"),
                        matched(data.milk, "l", ("1.6000", "0.500", "0.80"), ("2.0000", "1.000", "2.00"), "25.00"),
                    ],
                    "products_total": 3,
                },
                {
                    "currency": "KZT",
                    "base": side(0, "12.02", "0.00", 0, "0.00", None, None, 0, None, None),
                    "current": side(1, "11.99", "0.08", 0, "900.00", "900.00", "900.00", 1, "1.00", "900.0000"),
                    "change": {"avg_receipt": None, "avg_receipt_percent": None},
                    "effects": None, "price_index": None, "products": [], "products_total": 0,
                },
            ],
        })
        self.assert_identities(body["currencies"][0])

    def test_negative_change(self):
        swapped = "base_from=2026-01-01&base_to=2026-12-31&current_from=2027-01-01&current_to=2027-12-31"
        for receipt in Receipt.objects.filter(purchased_on__year=2020, operation="sale"):
            Receipt.objects.filter(pk=receipt.pk).update(purchased_on=receipt.purchased_on.replace(year=2027))
        block = self.eur(swapped)
        self.assertEqual(block["change"], {"avg_receipt": "-17.00", "avg_receipt_percent": "-68.00"})
        self.assertEqual(block["effects"], {
            "quantity": "-8.07", "price": "-4.51", "mix": "-4.42", "price_per_line": "-8.93",
            "quantity_percent": "47.47", "price_percent": "26.53", "mix_percent": "26.00",
        })
        self.assertEqual(block["price_index"]["fisher"], "0.7722")
        self.assertEqual((block["price_index"]["laspeyres"], block["price_index"]["paasche"]), ("0.7652", "0.7793"))
        self.assertEqual([entry["price_change_percent"] for entry in block["products"]], ["-33.33", "-16.67", "-20.00"])
        self.assertEqual((block["base"]["refunds_excluded"], block["current"]["refunds_excluded"]), (1, 0))
        self.assert_identities(block)

    def test_zero_change(self):
        again = make_receipt(self.data.lidl, "EUR", date(2021, 5, 1), total=D("8.00"))
        _Lines(again).add(self.data.milk, "8.00", quantity="8")
        block = self.eur("base_from=2020-02-01&base_to=2020-02-29&current_from=2021-01-01&current_to=2021-12-31")
        self.assertEqual(block["change"], {"avg_receipt": "0.00", "avg_receipt_percent": "0.00"})
        self.assertEqual(block["effects"], {
            "quantity": "0.00", "price": None, "mix": None, "price_per_line": "0.00",
            "quantity_percent": None, "price_percent": None, "mix_percent": None,
        })
        # «молоко, л» и «молоко, шт» — разные ключи: совпавших товаров нет.
        self.assertIsNone(block["price_index"])

    def test_no_receipts_in_one_period(self):
        block = self.eur("base_from=2019-01-01&base_to=2019-12-31&current_from=2020-01-01&current_to=2020-12-31")
        self.assertEqual(block["base"], side(0, "11.99", "0.00", 0, "0.00", None, None, 0, None, None))
        self.assertEqual(block["current"]["receipts_count"], 3)
        self.assertEqual(block["change"], {"avg_receipt": None, "avg_receipt_percent": None})
        self.assertEqual((block["effects"], block["price_index"], block["products"], block["products_total"]),
                         (None, None, [], 0))
        empty = self.get("base_from=2018-01-01&base_to=2018-12-31&current_from=2019-01-01&current_to=2019-12-31")
        self.assertEqual(empty["currencies"], [])
        # Только возвраты в обоих периодах — блока нет.
        refunds = self.get("base_from=2020-03-01&base_to=2020-03-31&current_from=2026-04-01&current_to=2026-04-30")
        self.assertEqual(refunds["currencies"], [])

    def test_no_product_lines(self):
        # Февраль 2020 — одна товарная строка; чек без товарных строк в 2022.
        bare = make_receipt(self.data.lidl, "EUR", date(2022, 5, 1), total=D("12.00"))
        _Lines(bare).add(None, "12.00", kind="service", raw_name="Доставка")
        block = self.eur("base_from=2020-02-01&base_to=2020-02-29&current_from=2022-01-01&current_to=2022-12-31")
        self.assertEqual(block["change"], {"avg_receipt": "4.00", "avg_receipt_percent": "50.00"})
        self.assertEqual((block["effects"], block["price_index"], block["products"]), (None, None, []))
        self.assertEqual((block["current"]["lines_count"], block["current"]["lines_per_receipt"],
                          block["current"]["paid_per_line"]), (0, "0.00", None))

    def test_no_matched_products(self):
        other = make_receipt(self.data.lidl, "EUR", date(2022, 5, 1), total=D("12.00"))
        lines = _Lines(other)
        lines.add(self.data.juice, "6.00", quantity="3")
        lines.add(None, "6.00", raw_name="UNBEKANNT")
        block = self.eur("base_from=2020-01-01&base_to=2020-12-31&current_from=2022-01-01&current_to=2022-12-31")
        self.assertEqual(block["change"], {"avg_receipt": "4.00", "avg_receipt_percent": "50.00"})
        # количество (2 − 7/3) × (24/7 + 6) / 2 = −1.5714; цена позиции — остаток.
        self.assertEqual(block["effects"], {
            "quantity": "-1.57", "price": None, "mix": None, "price_per_line": "5.57",
            "quantity_percent": "-39.25", "price_percent": None, "mix_percent": None,
        })
        self.assertEqual((block["price_index"], block["products"], block["products_total"]), (None, [], 0))
        self.assert_identities(block)

    def test_one_matched_product(self):
        block = self.eur("base_from=2020-02-01&base_to=2020-02-29&current_from=2026-03-20&current_to=2026-03-20")
        self.assertEqual(block["price_index"], {
            "fisher": "1.2500", "laspeyres": "1.2500", "paasche": "1.2500", "matched_products": 1,
            "coverage_base_percent": "100.00", "coverage_current_percent": "10.26",
        })
        self.assertEqual(block["products"], [
            matched(self.data.milk, "l", ("1.6000", "0.500", "0.80"), ("2.0000", "1.000", "2.00"), "25.00"),
        ])
        # a 8.00 → 30.00; n 1 → 4; p 8 → 7.5: количество 3 × 7.75, цены 2.5 × 8 × 0.25.
        self.assertEqual(block["effects"], {
            "quantity": "23.25", "price": "5.00", "mix": "-6.25", "price_per_line": "-1.25",
            "quantity_percent": "105.68", "price_percent": "22.73", "mix_percent": "-28.41",
        })
        self.assert_identities(block)

    # --- что считается ---

    def test_only_sales_and_positive_product_lines(self):
        data = self.data
        before = self.eur()
        # Возврат в периоде меняет только refunds_excluded.
        refund = make_receipt(data.lidl, "EUR", date(2026, 5, 1), total=D("-9.00"), operation=REFUND)
        _Lines(refund).add(data.milk, "-9.00", quantity="-9")
        after = self.eur()
        self.assertEqual(after["current"]["refunds_excluded"], 2)
        self.assertEqual({**after, "current": {**after["current"], "refunds_excluded": 1}}, before)
        # Сторно внутри продажи — не позиция и в цену товара не входит.
        lines = _Lines(data.fifth)
        lines.position = 5
        lines.add(data.milk, "-1.50", quantity="-1")
        self.assertEqual(self.eur(), after)

    def test_period_bounds_are_inclusive_local_dates(self):
        exact = self.eur("base_from=2020-01-06&base_to=2020-02-03&current_from=2026-03-02&current_to=2026-03-20")
        self.assertEqual((exact["base"]["receipts_count"], exact["current"]["receipts_count"]), (3, 2))
        self.assertEqual((exact["base"]["months"], exact["current"]["months"]), ("0.95", "0.62"))
        self.assertEqual((exact["base"]["receipts_per_month"], exact["current"]["receipts_per_month"]),
                         ("3.15", "3.20"))
        self.assertEqual(exact["base"]["refunds_excluded"], 0)
        inner = self.eur("base_from=2020-01-07&base_to=2020-02-02&current_from=2026-03-03&current_to=2026-03-19")
        self.assertEqual((inner["base"]["receipts_count"], inner["current"]["receipts_count"]), (1, 0))
        day = self.get("base_from=2026-03-01&base_to=2026-03-01&current_from=2026-03-02&current_to=2026-03-02")
        self.assertEqual([(block["currency"], block["base"]["receipts_count"], block["current"]["receipts_count"],
                           block["current"]["months"]) for block in day["currencies"]],
                         [("EUR", 0, 1, "0.03"), ("KZT", 0, 1, "0.03")])
        whole = self.get()
        with self.settings(TIME_ZONE="Asia/Tokyo"):
            self.assertEqual(self.get(), whole)

    def test_filters(self):
        data = self.data
        self.assertEqual([block["currency"] for block in self.get(f"{PERIODS}&country=kz")["currencies"]], ["KZT"])
        self.assertEqual([block["currency"] for block in self.get(f"{PERIODS}&currency=eur")["currencies"]], ["EUR"])
        self.assertEqual(self.get(f"{PERIODS}&country=DE&currency=KZT")["currencies"], [])
        self.assertEqual([block["currency"] for block in self.get(f"{PERIODS}&store={data.dns.pk}")["currencies"]],
                         ["KZT"])
        self.assertEqual(self.get(f"{PERIODS}&store={data.lidl.pk},{data.dns.pk}"), self.get())
        self.assertEqual(self.get(f"{PERIODS}&country=&store=%20&limit=&unknown=1&interval=x"), self.get())

    def test_currencies_are_never_mixed(self):
        data = self.data
        old = make_receipt(data.lidl, "KZT", date(2020, 6, 1), total=D("450.00"))
        _Lines(old).add(data.milk, "450.00")
        eur, kzt = self.get(f"{PERIODS}&store={data.lidl.pk},{data.dns.pk}")["currencies"]
        self.assertEqual(eur, self.eur())
        self.assertEqual(kzt["change"], {"avg_receipt": "450.00", "avg_receipt_percent": "100.00"})
        self.assertEqual(kzt["price_index"]["fisher"], "2.0000")
        self.assertEqual(kzt["effects"], {
            "quantity": "0.00", "price": "450.00", "mix": "0.00", "price_per_line": "450.00",
            "quantity_percent": "0.00", "price_percent": "100.00", "mix_percent": "0.00",
        })

    def test_products_limit_and_order(self):
        data = self.data
        self.assertEqual([entry["product"]["id"] for entry in self.eur(f"{PERIODS}&limit=2")["products"]],
                         [data.milk.pk, data.bread.pk])
        limited = self.eur(f"{PERIODS}&limit=1")
        self.assertEqual((len(limited["products"]), limited["products_total"]), (1, 3))
        self.assertEqual(limited["effects"], self.eur()["effects"])
        self.assertEqual(self.eur(f"{PERIODS}&limit=100")["products"], self.eur()["products"])
        # Равная разница сумм: по названию, затем id.
        generic = data.milk.generic
        twins = [make_product(generic, "Демо-яблоко", brand=Brand.objects.create(name=name))
                 for name in ("Демо-сад Б", "Демо-сад А")]
        early = make_product(generic, "Демо-айва")
        for on, amount in ((date(2020, 7, 1), "10.00"), (date(2026, 7, 1), "30.00")):
            lines = _Lines(make_receipt(data.lidl, "EUR", on, total=D("0.00")))
            for product in (*twins, early):
                lines.add(product, amount)
        found = self.eur()["products"]
        self.assertEqual([entry["product"]["id"] for entry in found[:3]], [early.pk, twins[0].pk, twins[1].pk])
        self.assertLess(twins[0].pk, twins[1].pk)

    # --- слитые товары ---

    def test_absorbed_product_is_counted_at_the_target(self):
        data = self.data
        duplicate = make_product(data.juice.generic, "Демо-молоко дубль")
        receipt = make_receipt(data.lidl, "EUR", date(2026, 3, 25), total=D("0.00"))
        _Lines(receipt).add(duplicate, "3.00", quantity="2")
        before = self.eur()
        self.assertEqual(before["price_index"]["matched_products"], 3)
        group = absorb(data.milk, duplicate)

        block = self.eur()
        milk = next(entry for entry in block["products"]
                    if entry["product"]["id"] == data.milk.pk and entry["unit"] == "pcs")
        # 6 шт за 9.00 и 2 шт дубля за 3.00 — одна цена оставляемого товара.
        self.assertEqual(milk["current"], {"price": "1.5000", "quantity": "8.000", "amount": "12.00"})
        self.assertEqual((block["products_total"], block["current"]["lines_count"]), (3, 9))
        self.assertEqual(block["base"], before["base"])
        self.assertEqual(block["current"], before["current"])
        self.assertNotEqual(block["price_index"], before["price_index"])
        self.assertGreater(D(block["price_index"]["coverage_current_percent"]),
                           D(before["price_index"]["coverage_current_percent"]))
        self.assert_identities(block)
        content = self.client.get(f"{COMPARE}?{PERIODS}").content.decode()
        self.assertNotIn(duplicate.name, content)
        self.assertNotIn(f'"id":{duplicate.pk}' + ",", content)

        # Дубль куплен и в базовом периоде: сам по себе он совпал бы, слитый — нет отдельной записи.
        old = make_receipt(data.lidl, "EUR", date(2020, 6, 1), total=D("0.00"))
        _Lines(old).add(duplicate, "1.00")
        merged = self.eur()
        self.assertEqual(merged["products_total"], 3)
        self.assertEqual(next(entry for entry in merged["products"] if entry["unit"] == "pcs"
                              and entry["product"]["id"] == data.milk.pk)["base"]["quantity"], "4.000")
        services.cancel(group.pk)
        apart = self.eur()
        self.assertEqual(apart["products_total"], 4)
        self.assertIn(duplicate.pk, [entry["product"]["id"] for entry in apart["products"]])

    # --- запросы ---

    def test_query_count_is_constant(self):
        data = self.data
        absorb(data.milk, make_product(data.milk.generic, "Демо-молоко дубль"))
        filters = f"{PERIODS}&country=DE&currency=EUR&store={data.lidl.pk}&limit=5"
        nothing = "base_from=2018-01-01&base_to=2018-12-31&current_from=2019-01-01&current_to=2019-12-31"
        # Без совпавших товаров запроса названий нет.
        cases = ((PERIODS, 3), (filters, 6), (f"{PERIODS}&limit=100", 3), (nothing, 2))

        def measure():
            for query, expected in cases:
                with self.subTest(query=query), self.assertNumQueries(expected):
                    self.get(query)

        measure()
        for number in range(30):
            product = make_product(data.milk.generic, f"Демо-товар {number}")
            for on in (date(2020, 1 + number % 12, 15), date(2026, 1 + number % 12, 15)):
                lines = _Lines(make_receipt(data.lidl, "EUR", on, total=D("2.00")))
                lines.add(product, "1.50")
                lines.add(None, "0.50", raw_name="UNBEKANNT")
        measure()
        block = self.eur(f"{PERIODS}&limit=100")
        self.assertEqual((len(block["products"]), block["products_total"]), (33, 33))
        self.assert_identities(block)

    # --- ошибки и доступ ---

    def test_all_four_dates_are_required(self):
        required = ["Обязательный параметр."]
        self.assert_invalid("", {
            "base_from": required, "base_to": required, "current_from": required, "current_to": required,
        })
        self.assert_invalid("base_from=2020-01-01&base_to=&current_from=%20&current_to=2026-12-31",
                            {"base_to": required, "current_from": required})
        self.assert_invalid("date_from=2020-01-01&date_to=2020-12-31&base_from=2020-01-01&base_to=2020-12-31",
                            {"current_from": required, "current_to": required})
        self.assert_invalid("base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01",
                            {"current_to": required})

    def test_periods_must_not_overlap(self):
        overlap = {"current_from": ["Периоды не должны пересекаться."]}
        for current in ("2020-12-31", "2020-06-01", "2020-01-01", "2019-01-01"):
            with self.subTest(current_from=current):
                self.assert_invalid(
                    f"base_from=2020-01-01&base_to=2020-12-31&current_from={current}&current_to=2026-12-31", overlap,
                )
        # Текущий период целиком раньше базового — тоже отказ.
        self.assert_invalid("base_from=2026-01-01&base_to=2026-12-31&current_from=2020-01-01&current_to=2020-12-31",
                            overlap)
        adjacent = self.get("base_from=2020-01-01&base_to=2020-12-31&current_from=2021-01-01&current_to=2026-12-31")
        self.assertEqual(adjacent["current"], {"date_from": "2021-01-01", "date_to": "2026-12-31"})
        # Ошибка самих дат важнее: пересечение по ним не проверяется.
        self.assert_invalid("base_from=2020-12-31&base_to=2020-01-01&current_from=2019-01-01&current_to=2019-12-31",
                            {"base_from": ["Должна быть не позже base_to."]})
        self.assert_invalid("base_from=2020-01-01&base_to=2020-12-31&current_from=2020-06-01&current_to=x",
                            {"current_to": ["Ожидается дата ГГГГ-ММ-ДД."]})

    def test_invalid_parameters(self):
        cases = (
            ("base_from=01.01.2020", {"base_from": ["Ожидается дата ГГГГ-ММ-ДД."]}),
            ("current_to=2026-02-30", {"current_to": ["Ожидается дата ГГГГ-ММ-ДД."]}),
            ("current_from=2027-01-01", {"current_from": ["Должна быть не позже current_to."]}),
            ("country=ZZ", {"country": ["Неизвестный код страны."]}),
            ("currency=ZZZ", {"currency": ["Неизвестный код валюты."]}),
            ("store=999999", {"store": ["Магазин не найден."]}),
            ("limit=0", {"limit": ["Допустимо от 1 до 100."]}),
            ("limit=101", {"limit": ["Допустимо от 1 до 100."]}),
            ("limit=x", {"limit": ["Допустимо от 1 до 100."]}),
        )
        for query, fields in cases:
            with self.subTest(query=query):
                self.assert_invalid(f"{PERIODS}&{query}", fields)
        self.assert_invalid("base_from=x&current_to=2026-12-31&country=ZZ&store=a&limit=0", {
            "base_from": ["Ожидается дата ГГГГ-ММ-ДД."], "base_to": ["Обязательный параметр."],
            "current_from": ["Обязательный параметр."], "country": ["Неизвестный код страны."],
            "store": ["Ожидаются целые положительные числа через запятую."], "limit": ["Допустимо от 1 до 100."],
        })

    def test_access_is_local_only(self):
        self.check_access(PERIODS)

    def test_methods_and_unknown_paths_follow_the_local_api(self):
        self.check_methods(PERIODS)
        self.check_hidden_fields(PERIODS)

    def test_database_failure_is_a_safe_503(self):
        with patch("api.views.stats_receipts.basket.collect", side_effect=OperationalError("PRIVATE DSN")):
            response = self.client.get(f"{COMPARE}?{PERIODS}")
        self.assertEqual(response.status_code, 503, response.content)
        self.assertEqual(response.json()["error"]["code"], "database_unavailable")
        self.assertNotIn("PRIVATE", response.content.decode())
        self.assertEqual(response["Cache-Control"], "no-store")
