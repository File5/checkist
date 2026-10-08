import json
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from django.test import TestCase, tag

from api.tests import factories
from api.tests.merge_factories import demo_groups, product
from merges import demo
from api.tests.factories import observe
from catalog.units import Unit
from receipts.models import Receipt, ReceiptDiscount, ReceiptLine
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line
from stores.models import Store

D = Decimal
INVALID = {"code": "invalid_parameter", "message": "Некорректные параметры запроса."}
NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}
TOTAL_KEYS = {"count", "min", "max", "avg", "first", "last", "change_percent"}
BUCKET_KEYS = {"period_start", "count", "min", "max", "avg", "last"}


def url(product):
    return f"/api/products/{getattr(product, 'pk', product)}/prices/summary/"


def bucket(period_start, count, low, high=None, avg=None, last=None):
    """Интервал; без ``high``, ``avg`` и ``last`` все цены интервала равны ``low``."""
    return {
        "period_start": period_start, "count": count, "min": low, "max": high or low,
        "avg": avg or low, "last": last or high or low,
    }


class SummaryTestCase(TestCase):
    def get(self, product, **query):
        return self.client.get(url(product), query)

    def body(self, product, **query):
        response = self.get(product, **query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def groups(self, product, **query):
        return self.body(product, **query)["groups"]

    def group(self, product, **query):
        (group,) = self.groups(product, **query)
        return group


@tag("integration")
class PriceSummaryTests(SummaryTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = factories.save_samples()
        cls.lidl_milk, cls.shop_milk = cls.data.lidl_milk, cls.data.shop_milk
        cls.lidl, cls.shop = cls.data.lidl_store, cls.data.shop_store
        cls.berlin = Store.objects.create(
            merchant=cls.lidl.merchant, country_id="DE", city="Berlin",
            address_raw="Teststraße 1, 10115 Berlin", timezone="Europe/Berlin",
        )
        cls.product_brief = {"id": cls.lidl_milk.pk, "name": samples.MILK, "base_unit": "l"}
        cls.lidl_total = {
            "count": 6, "min": "1.0500", "max": "1.0900", "avg": "1.0567",
            "first": {"price": "1.0500", "purchased_on": "2026-06-02"},
            "last": {"price": "1.0900", "purchased_on": "2026-10-01"},
            "change_percent": "3.81",
        }

    def new_product(self, name="Молоко 1 л", package=("1", Unit.L)):
        return factories.make_product(self.data.milk, name, package=package)

    # --- тело ответа ---

    def test_exact_body_by_month(self):
        response = self.get(self.lidl_milk, interval="month")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {
            "product": self.product_brief, "price": "paid", "group_by": "country", "interval": "month",
            "groups": [{
                "country": "DE", "currency": "EUR", "unit": "pcs",
                "total": self.lidl_total,
                "buckets": [
                    bucket("2026-06-01", 4, "1.0500"), bucket("2026-07-01", 1, "1.0500"),
                    bucket("2026-10-01", 1, "1.0900"),
                ],
            }],
        })

    def test_exact_body_with_defaults(self):
        self.assertEqual(self.body(self.lidl_milk), {
            "product": self.product_brief, "price": "paid", "group_by": "country", "interval": "none",
            "groups": [{"country": "DE", "currency": "EUR", "unit": "pcs", "total": self.lidl_total, "buckets": []}],
        })

    def test_exact_body_of_normalized_price(self):
        self.assertEqual(self.body(self.shop_milk, price="normalized", interval="day"), {
            "product": {"id": self.shop_milk.pk, "name": samples.SHOP_MILK_NAME, "base_unit": "l"},
            "price": "normalized", "group_by": "country", "interval": "day",
            "skipped_without_normalized": 0,
            "groups": [{
                "country": "RU", "currency": "RUB", "unit": "l",
                "total": {
                    "count": 1, "min": "130.5882", "max": "130.5882", "avg": "130.5882",
                    "first": {"price": "130.5882", "purchased_on": "2026-09-28"},
                    "last": {"price": "130.5882", "purchased_on": "2026-09-28"},
                    "change_percent": None,
                },
                "buckets": [bucket("2026-09-28", 1, "130.5882")],
            }],
        })

    def test_product_without_observations(self):
        product = self.new_product("Молоко без покупок")
        for query in ({}, {"interval": "month"}, {"group_by": "store"}, {"group_by": "none", "interval": "day"}):
            with self.subTest(query=query):
                self.assertEqual(self.groups(product, **query), [])
        self.assertEqual(self.body(product, price="normalized"), {
            "product": {"id": product.pk, "name": "Молоко без покупок", "base_unit": "l"},
            "price": "normalized", "group_by": "country", "interval": "none",
            "skipped_without_normalized": 0, "groups": [],
        })

    # --- group_by ---

    def three_stores(self):
        product = self.new_product()
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.00")
        observe(product, self.lidl, "EUR", date(2026, 7, 8), "1.20")
        observe(product, self.berlin, "EUR", date(2026, 7, 3), "0.90")
        observe(product, self.shop, "RUB", date(2026, 7, 2), "100.00")
        return product

    def test_group_by_country(self):
        de, ru = self.groups(self.three_stores(), group_by="country")
        self.assertEqual(
            {key: de[key] for key in ("country", "currency", "unit")},
            {"country": "DE", "currency": "EUR", "unit": "pcs"},
        )
        self.assertEqual(de["total"], {
            "count": 3, "min": "0.9000", "max": "1.2000", "avg": "1.0333",
            "first": {"price": "1.0000", "purchased_on": "2026-07-01"},
            "last": {"price": "1.2000", "purchased_on": "2026-07-08"},
            "change_percent": "20.00",
        })
        self.assertEqual((ru["country"], ru["currency"], ru["total"]["count"]), ("RU", "RUB", 1))
        self.assertEqual(set(de), {"country", "currency", "unit", "total", "buckets"})

    def test_group_by_store(self):
        groups = self.groups(self.three_stores(), group_by="store")
        self.assertEqual([group["store"]["id"] for group in groups], sorted([self.shop.pk, self.lidl.pk, self.berlin.pk]))
        by_store = {group["store"]["id"]: group for group in groups}
        self.assertEqual(by_store[self.lidl.pk]["store"], {
            "id": self.lidl.pk, "name": "Lidl", "city": "Lindau", "address": "Kemptener Straße 17, 88131 Lindau",
            "country": "DE", "timezone": "Europe/Berlin",
        })
        self.assertEqual(by_store[self.shop.pk]["store"]["name"], "Магазин «Елена»")
        self.assertEqual(set(by_store[self.lidl.pk]), {"store", "currency", "unit", "total", "buckets"})
        self.assertEqual(by_store[self.lidl.pk]["total"], {
            "count": 2, "min": "1.0000", "max": "1.2000", "avg": "1.1000",
            "first": {"price": "1.0000", "purchased_on": "2026-07-01"},
            "last": {"price": "1.2000", "purchased_on": "2026-07-08"},
            "change_percent": "20.00",
        })
        self.assertEqual(by_store[self.berlin.pk]["total"]["count"], 1)
        self.assertEqual(by_store[self.berlin.pk]["total"]["change_percent"], None)

    def test_group_by_none(self):
        eur, rub = self.groups(self.three_stores(), group_by="none")
        self.assertEqual(set(eur), {"currency", "unit", "total", "buckets"})
        self.assertEqual((eur["currency"], eur["unit"], eur["total"]["count"]), ("EUR", "pcs", 3))
        self.assertEqual((rub["currency"], rub["total"]["count"], rub["total"]["avg"]), ("RUB", 1, "100.0000"))

    def test_two_currencies_are_two_groups_and_no_common_aggregate(self):
        factories.second_currency(self.data)  # shop_milk в том же магазине RU, чек в EUR по 1,20
        for group_by in ("country", "store", "none"):
            with self.subTest(group_by=group_by):
                body = self.body(self.shop_milk, group_by=group_by, interval="month")
                self.assertEqual(set(body), {"product", "price", "group_by", "interval", "groups"})
                eur, rub = body["groups"]
                self.assertEqual((eur["currency"], rub["currency"]), ("EUR", "RUB"))
                for group in (eur, rub):
                    self.assertEqual(group["total"]["count"], 1)
                self.assertEqual((eur["total"]["avg"], rub["total"]["avg"]), ("1.2000", "111.0000"))
                self.assertEqual((eur["total"]["min"], rub["total"]["max"]), ("1.2000", "111.0000"))
                self.assertEqual(eur["buckets"], [bucket("2026-07-01", 1, "1.2000")])
                self.assertEqual(rub["buckets"], [bucket("2026-09-01", 1, "111.0000")])
                if group_by == "store":
                    self.assertEqual([group["store"]["id"] for group in (eur, rub)], [self.shop.pk] * 2)

    def test_different_units_are_different_groups(self):
        product = self.new_product("Молоко на розлив и в пакете")
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.50")  # штука по литру
        observe(product, self.lidl, "EUR", date(2026, 7, 2), "1.10", quantity="2", unit=Unit.L)
        observe(product, self.lidl, "EUR", date(2026, 7, 3), "0.0012", quantity="500", unit=Unit.ML)
        groups = self.groups(product)
        self.assertEqual([(g["unit"], g["total"]["count"], g["total"]["avg"]) for g in groups], [
            ("l", 1, "1.1000"), ("ml", 1, "0.0012"), ("pcs", 1, "1.5000"),
        ])
        # Нормализованная цена у всех трёх — за литр: одна группа.
        normalized = self.group(product, price="normalized")
        self.assertEqual((normalized["unit"], normalized["total"]["count"]), ("l", 3))
        self.assertEqual((normalized["total"]["min"], normalized["total"]["max"]), ("1.1000", "1.5000"))

    def test_different_normalized_units_are_different_groups(self):
        product = self.new_product("Сыр 500 г", package=("500", Unit.G))
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "2.00")  # 4,00 за кг
        observe(product, self.lidl, "EUR", date(2026, 7, 2), "3.00", quantity="2", unit=Unit.L)  # 3,00 за л
        body = self.body(product, price="normalized")
        self.assertEqual(body["skipped_without_normalized"], 0)
        self.assertEqual([(g["unit"], g["total"]["avg"]) for g in body["groups"]], [("kg", "4.0000"), ("l", "3.0000")])

    # --- interval ---

    def test_interval_none_has_no_buckets(self):
        self.assertEqual(self.group(self.lidl_milk, interval="none")["buckets"], [])

    def test_interval_day(self):
        observe(self.lidl_milk, self.lidl, "EUR", date(2026, 6, 2), "1.15", at=time(20, 0))  # тот же день, позже
        group = self.group(self.lidl_milk, interval="day", date_to="2026-06-17")
        self.assertEqual(group["buckets"], [
            bucket("2026-06-02", 2, "1.0500", "1.1500", "1.1000"),
            bucket("2026-06-09", 1, "1.0500"),
            bucket("2026-06-17", 1, "1.0500"),
        ])

    def test_interval_week_starts_on_monday(self):
        self.assertEqual(date(2026, 6, 29).weekday(), 0)
        # Воскресенье относится к неделе, начавшейся в понедельник 22 июня.
        observe(self.lidl_milk, self.lidl, "EUR", date(2026, 6, 28), "1.00")
        group = self.group(self.lidl_milk, interval="week")
        self.assertEqual(group["buckets"], [
            bucket("2026-06-01", 1, "1.0500"),  # вторник 02.06
            bucket("2026-06-08", 1, "1.0500"),  # вторник 09.06
            bucket("2026-06-15", 1, "1.0500"),  # среда 17.06
            bucket("2026-06-22", 1, "1.0000"),  # воскресенье 28.06
            bucket("2026-06-29", 1, "1.0500"),  # понедельник 29.06
            bucket("2026-07-06", 1, "1.0500"),  # понедельник 06.07
            bucket("2026-09-28", 1, "1.0900"),  # четверг 01.10
        ])
        for item in group["buckets"]:
            self.assertEqual(date.fromisoformat(item["period_start"]).weekday(), 0)

    def test_interval_month_spans_years(self):
        product = self.new_product()
        observe(product, self.lidl, "EUR", date(2025, 12, 31), "1.00")
        observe(product, self.lidl, "EUR", date(2026, 1, 1), "1.10")
        observe(product, self.lidl, "EUR", date(2026, 1, 31), "1.30")
        self.assertEqual(self.group(product, interval="month")["buckets"], [
            bucket("2025-12-01", 1, "1.0000"),
            bucket("2026-01-01", 2, "1.1000", "1.3000", "1.2000"),
        ])

    def test_interval_uses_local_date_of_receipt(self):
        # 00:30 в Берлине 1 июля — 22:30 UTC 30 июня: интервал считается по дате чека.
        product = self.new_product()
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.00", at=time(0, 30))
        for interval, start in (("day", "2026-07-01"), ("month", "2026-07-01"), ("week", "2026-06-29")):
            with self.subTest(interval=interval):
                self.assertEqual(self.group(product, interval=interval)["buckets"], [bucket(start, 1, "1.0000")])

    def test_buckets_of_groups_are_separate(self):
        groups = self.groups(self.three_stores(), group_by="store", interval="month")
        by_store = {group["store"]["id"]: group["buckets"] for group in groups}
        self.assertEqual(by_store[self.lidl.pk], [bucket("2026-07-01", 2, "1.0000", "1.2000", "1.1000")])
        self.assertEqual(by_store[self.berlin.pk], [bucket("2026-07-01", 1, "0.9000")])
        self.assertEqual(by_store[self.shop.pk], [bucket("2026-07-01", 1, "100.0000")])

    # --- price ---

    def test_price_paid_list_and_normalized(self):
        product = self.new_product("Молоко 2 л", package=("2", Unit.L))
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "2.00", discount="0.50")
        observe(product, self.lidl, "EUR", date(2026, 7, 2), "2.40")
        expected = {
            # (min, max, avg, first, last, change_percent)
            "paid": ("pcs", "1.5000", "2.4000", "1.9500", "1.5000", "2.4000", "60.00"),
            "list": ("pcs", "2.0000", "2.4000", "2.2000", "2.0000", "2.4000", "20.00"),
            "normalized": ("l", "0.7500", "1.2000", "0.9750", "0.7500", "1.2000", "60.00"),
        }
        for price, (unit, low, high, avg, first, last, change) in expected.items():
            with self.subTest(price=price):
                body = self.body(product, price=price, interval="month")
                (group,) = body["groups"]
                self.assertEqual(body["price"], price)
                self.assertEqual(group["unit"], unit)
                self.assertEqual(group["total"], {
                    "count": 2, "min": low, "max": high, "avg": avg,
                    "first": {"price": first, "purchased_on": "2026-07-01"},
                    "last": {"price": last, "purchased_on": "2026-07-02"},
                    "change_percent": change,
                })
                self.assertEqual(group["buckets"], [bucket("2026-07-01", 2, low, high, avg)])
                self.assertEqual("skipped_without_normalized" in body, price == "normalized")
        self.assertEqual(self.body(product)["price"], "paid")

    def test_receipt_discount_is_not_in_price(self):
        product = self.new_product()
        line = observe(product, self.lidl, "EUR", date(2026, 7, 1), "2.00")
        ReceiptDiscount.objects.create(receipt=line.receipt, line=None, position=1, name="Rabatt", amount=D("1.00"))
        self.assertEqual(self.group(product)["total"]["avg"], "2.0000")

    def test_skipped_without_normalized(self):
        body = self.body(self.lidl_milk, price="normalized")  # фасовка не задана
        self.assertEqual((body["skipped_without_normalized"], body["groups"]), (6, []))

        product = self.new_product()
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.30")
        observe(product, self.lidl, "EUR", date(2026, 7, 2), "9.00", unit=Unit.M)  # метры не приводятся
        observe(product, self.lidl, "EUR", date(2026, 7, 3), "9.50", unit=Unit.M)
        body = self.body(product, price="normalized", interval="day")
        self.assertEqual(body["skipped_without_normalized"], 2)
        (group,) = body["groups"]
        self.assertEqual((group["unit"], group["total"]["count"], group["total"]["max"]), ("l", 1, "1.3000"))
        self.assertEqual(group["buckets"], [bucket("2026-07-01", 1, "1.3000")])
        # Фильтры действуют и на число пропущенных.
        self.assertEqual(self.body(product, price="normalized", date_to="2026-07-02")["skipped_without_normalized"], 1)
        self.assertNotIn("skipped_without_normalized", self.body(product, price="paid"))

    # --- агрегаты ---

    def test_avg_is_not_weighted_by_quantity_and_rounds_half_up(self):
        product = self.new_product()
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.0000")
        observe(product, self.lidl, "EUR", date(2026, 7, 2), "1.0001", quantity="10000")
        total = self.group(product)["total"]
        self.assertEqual(total["avg"], "1.0001")  # 1,00005 -> вверх, а не к чётному
        observe(product, self.lidl, "EUR", date(2026, 7, 3), "4.0000", quantity="10")
        # Простое среднее (1 + 1,0001 + 4) / 3 = 2,00003…; взвешенное по количеству было бы около 1,003.
        self.assertEqual(self.group(product)["total"]["avg"], "2.0000")

    def change(self, *prices):
        product = self.new_product(f"Молоко {len(prices)} {'-'.join(prices)}")
        for day, price in enumerate(prices, start=1):
            observe(product, self.lidl, "EUR", date(2026, 7, day), price)
        return self.group(product)["total"]["change_percent"]

    def test_change_percent(self):
        self.assertEqual(self.change("1.05", "1.05", "1.09"), "3.81")
        self.assertEqual(self.change("1.00", "0.75"), "-25.00")
        self.assertEqual(self.change("1.00", "5.00", "1.00"), "0.00")
        self.assertEqual(self.change("3.00", "4.00"), "33.33")
        self.assertEqual(self.change("0.80", "0.93"), "16.25")
        self.assertEqual(self.change("8.00", "8.01"), "0.13")  # 0,125 -> вверх
        self.assertEqual(self.change("0.01", "10.00"), "99900.00")

    def test_change_percent_is_null_for_single_observation(self):
        self.assertIsNone(self.change("1.05"))

    def test_change_percent_is_null_when_first_is_zero(self):
        self.assertIsNone(self.change("0.00", "1.00"))
        self.assertIsNone(self.change("0.00", "0.00"))
        self.assertEqual(self.change("1.00", "0.00"), "-100.00")

    def test_first_and_last_follow_observed_at_then_receipt_and_position(self):
        product = self.new_product()
        on = date(2026, 7, 1)
        first = factories.make_receipt(self.lidl, "EUR", on)
        second = factories.make_receipt(self.lidl, "EUR", on)
        # Один момент: порядок задают чек и позиция, а не порядок вставки.
        make_line(second, product=product, position=2, unit_price=D("4"), amount=D("4"))
        make_line(second, product=product, position=1, unit_price=D("3"), amount=D("3"))
        make_line(first, product=product, position=2, unit_price=D("2"), amount=D("2"))
        make_line(first, product=product, position=1, unit_price=D("1"), amount=D("1"))
        group = self.group(product, interval="day")
        self.assertEqual(group["total"]["first"], {"price": "1.0000", "purchased_on": "2026-07-01"})
        self.assertEqual(group["total"]["last"], {"price": "4.0000", "purchased_on": "2026-07-01"})
        self.assertEqual(group["total"]["change_percent"], "300.00")
        self.assertEqual(group["buckets"], [bucket("2026-07-01", 4, "1.0000", "4.0000", "2.5000")])

    def test_last_of_bucket_is_latest_and_not_maximum(self):
        product = self.new_product()
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "3.00", at=time(9, 0))
        observe(product, self.lidl, "EUR", date(2026, 7, 20), "1.00", at=time(9, 0))
        observe(product, self.lidl, "EUR", date(2026, 7, 10), "2.00", at=time(9, 0))
        observe(product, self.lidl, "EUR", date(2026, 8, 5), "5.00")
        group = self.group(product, interval="month")
        self.assertEqual(group["buckets"], [
            bucket("2026-07-01", 3, "1.0000", "3.0000", "2.0000", last="1.0000"),
            bucket("2026-08-01", 1, "5.0000"),
        ])
        self.assertEqual(group["total"]["first"]["price"], "3.0000")
        self.assertEqual(group["total"]["last"], {"price": "5.0000", "purchased_on": "2026-08-05"})

    def test_first_and_last_follow_moment_across_time_zones(self):
        # Алматы, 01:00 1 июля — раньше по UTC, чем Берлин, 23:30 30 июня: последнее наблюдение
        # группы лежит не в последнем интервале.
        product = self.new_product()
        almaty = observe(product, self.data.dns_store, "EUR", date(2026, 7, 1), "2.00", at=time(1, 0))
        berlin = observe(product, self.lidl, "EUR", date(2026, 6, 30), "3.00", at=time(23, 30))
        self.assertLess(almaty.receipt.purchased_at, berlin.receipt.purchased_at)
        group = self.group(product, group_by="none", interval="month")
        self.assertEqual(group["total"]["first"], {"price": "2.0000", "purchased_on": "2026-07-01"})
        self.assertEqual(group["total"]["last"], {"price": "3.0000", "purchased_on": "2026-06-30"})
        self.assertEqual(group["total"]["change_percent"], "50.00")
        self.assertEqual(group["buckets"], [bucket("2026-06-01", 1, "3.0000"), bucket("2026-07-01", 1, "2.0000")])

    # --- что не входит в цены ---

    def test_only_product_lines_of_sale_receipts_with_positive_quantity(self):
        product = self.new_product("Молоко для исключений")
        on = date(2026, 7, 1)
        observe(product, self.lidl, "EUR", on, "1.00")
        observe(product, self.lidl, "EUR", on, "0.25", kind=ReceiptLine.Kind.DEPOSIT)
        observe(product, self.lidl, "EUR", on, "0.25", quantity="-1", kind=ReceiptLine.Kind.DEPOSIT_RETURN)
        observe(product, self.lidl, "EUR", on, "3.00", kind=ReceiptLine.Kind.SERVICE)
        observe(product, self.lidl, "EUR", on, "7.00", quantity="-1")  # отрицательное количество
        refund = factories.make_receipt(self.lidl, "EUR", on, operation=Receipt.Operation.REFUND)
        make_line(refund, product=product)
        self.assertEqual(ReceiptLine.objects.filter(product=product).count(), 6)
        for price in ("paid", "list", "normalized"):
            with self.subTest(price=price):
                group = self.group(product, price=price, interval="day")
                self.assertEqual(group["total"]["count"], 1)
                self.assertEqual((group["total"]["min"], group["total"]["max"]), ("1.0000", "1.0000"))
                self.assertEqual(group["buckets"], [bucket("2026-07-01", 1, "1.0000")])
        self.assertEqual(self.body(product, price="normalized")["skipped_without_normalized"], 0)

    # --- фильтры ---

    def test_date_filters_are_inclusive(self):
        def count(**query):
            return self.group(self.lidl_milk, **query)["total"]["count"]

        self.assertEqual(count(date_from="2026-06-17"), 4)
        self.assertEqual(count(date_to="2026-06-17"), 3)
        self.assertEqual(count(date_from="2026-06-09", date_to="2026-06-29"), 3)
        total = self.group(self.lidl_milk, date_from="2026-06-09", date_to="2026-06-29")["total"]
        self.assertEqual((total["first"]["purchased_on"], total["last"]["purchased_on"]), ("2026-06-09", "2026-06-29"))
        self.assertIsNone(self.group(self.lidl_milk, date_from="2026-10-01", date_to="2026-10-01")["total"]["change_percent"])

    def test_date_window_without_purchases(self):
        for query in ({}, {"interval": "day"}, {"price": "normalized"}, {"group_by": "store"}):
            with self.subTest(query=query):
                response = self.get(self.lidl_milk, date_from="2026-08-01", date_to="2026-08-31", **query)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["groups"], [])

    def test_country_currency_and_store_filters(self):
        product = self.three_stores()
        observe(product, self.shop, "EUR", date(2026, 7, 5), "1.40")

        def found(**query):
            return [
                (group["country"], group["currency"], group["total"]["count"])
                for group in self.groups(product, **query)
            ]

        self.assertEqual(found(), [("DE", "EUR", 3), ("RU", "EUR", 1), ("RU", "RUB", 1)])
        self.assertEqual(found(country="DE"), [("DE", "EUR", 3)])
        self.assertEqual(found(country="ru"), [("RU", "EUR", 1), ("RU", "RUB", 1)])
        self.assertEqual(found(country="KZ"), [])
        self.assertEqual(found(currency="EUR"), [("DE", "EUR", 3), ("RU", "EUR", 1)])
        self.assertEqual(found(currency="RUB"), [("RU", "RUB", 1)])
        self.assertEqual(found(store=self.berlin.pk), [("DE", "EUR", 1)])
        self.assertEqual(found(store=self.shop.pk), [("RU", "EUR", 1), ("RU", "RUB", 1)])
        # В сочетании.
        self.assertEqual(found(country="RU", currency="EUR"), [("RU", "EUR", 1)])
        self.assertEqual(found(country="DE", currency="EUR", store=self.lidl.pk), [("DE", "EUR", 2)])
        self.assertEqual(
            found(country="DE", currency="EUR", store=self.lidl.pk, date_from="2026-07-02", date_to="2026-07-31"),
            [("DE", "EUR", 1)],
        )
        self.assertEqual(found(country="DE", store=self.shop.pk), [])
        self.assertEqual(found(country="DE", currency="RUB"), [])

    def test_unknown_parameters_are_ignored(self):
        body = self.body(self.lidl_milk, format="xml", ordering="x", page_size=0, foo="bar")
        self.assertEqual(body["groups"][0]["total"]["count"], 6)

    # --- ошибки ---

    def invalid(self, fields, **query):
        response = self.get(self.lidl_milk, **query)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": {**INVALID, "fields": fields}})

    def test_invalid_parameters(self):
        date_message = ["Ожидается дата ГГГГ-ММ-ДД."]
        cases = [
            ({"date_from": "02.06.2026"}, {"date_from": date_message}),
            ({"date_from": "2026-13-01"}, {"date_from": date_message}),
            ({"date_to": "2026-6-2"}, {"date_to": date_message}),
            ({"date_from": "2026-07-01", "date_to": "2026-06-30"}, {"date_from": ["Должна быть не позже date_to."]}),
            ({"country": "ZZ"}, {"country": ["Неизвестный код страны."]}),
            ({"country": "D"}, {"country": ["Ожидается код страны из двух букв."]}),
            ({"currency": "ZZZ"}, {"currency": ["Неизвестный код валюты."]}),
            ({"currency": "EURO"}, {"currency": ["Ожидается код валюты из трёх букв."]}),
            ({"store": 10**9}, {"store": ["Магазин не найден."]}),
            ({"store": "lidl"}, {"store": ["Ожидается целое положительное число."]}),
            ({"group_by": "city"}, {"group_by": ["Допустимые значения: country, store, none."]}),
            ({"interval": "year"}, {"interval": ["Допустимые значения: none, day, week, month."]}),
            ({"interval": "DAY"}, {"interval": ["Допустимые значения: none, day, week, month."]}),
            ({"price": "avg"}, {"price": ["Допустимые значения: paid, list, normalized."]}),
        ]
        for query, fields in cases:
            with self.subTest(query=query):
                self.invalid(fields, **query)

    def test_all_invalid_parameters_are_reported_together(self):
        self.invalid(
            {
                "date_to": ["Ожидается дата ГГГГ-ММ-ДД."], "country": ["Неизвестный код страны."],
                "currency": ["Неизвестный код валюты."], "store": ["Магазин не найден."],
                "group_by": ["Допустимые значения: country, store, none."],
                "interval": ["Допустимые значения: none, day, week, month."],
                "price": ["Допустимые значения: paid, list, normalized."],
            },
            date_to="x", country="ZZ", currency="ZZZ", store=10**9, group_by="x", interval="x", price="x",
        )

    def test_unknown_product(self):
        for product in (10**9, 2**63, 10**30):
            with self.subTest(product=product):
                response = self.get(product)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), NOT_FOUND)
        self.assertEqual(self.get(10**9, interval="year").status_code, 404)

    # --- доступ ---

    def test_anonymous_get_without_credentials(self):
        response = self.client.get(url(self.lidl_milk), HTTP_AUTHORIZATION="Bearer invalid")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.head(url(self.lidl_milk)).status_code, 200)

    def test_write_methods_are_not_allowed(self):
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(url(self.lidl_milk), {}, content_type="application/json")
                self.assertEqual(response.status_code, 405)
                self.assertEqual(response.json(), {
                    "error": {"code": "method_not_allowed", "message": "Метод не поддерживается."},
                })

    def test_only_json(self):
        response = self.client.get(url(self.lidl_milk), HTTP_ACCEPT="text/html")
        self.assertEqual(response.status_code, 406)
        self.assertEqual(response.json()["error"]["code"], "not_acceptable")

    # --- запросы и чувствительные поля ---

    def test_query_count(self):
        product = self.three_stores()
        cases = [
            ({}, 2),  # товар и одна сводка
            ({"interval": "day"}, 2),
            ({"group_by": "none", "interval": "week", "price": "list"}, 2),
            ({"group_by": "store", "interval": "month"}, 3),  # + магазины групп одним запросом
            ({"price": "normalized", "interval": "month"}, 3),  # + число пропущенных
            ({"group_by": "store", "price": "normalized"}, 4),
            # + проверка страны, валюты и магазина по справочникам
            ({"country": "DE", "currency": "EUR", "store": self.lidl.pk, "date_from": "2026-01-01"}, 5),
        ]
        for query, queries in cases:
            with self.subTest(query=query):
                with self.assertNumQueries(queries):
                    self.assertTrue(self.groups(product, **query))

    def test_query_count_does_not_depend_on_number_of_observations(self):
        product = self.new_product()
        stores = [self.lidl, self.berlin, self.shop, self.data.dns_store]
        for day in range(1, 21):
            observe(product, stores[day % 4], "EUR", date(2026, 7, day), f"1.{day:02}")
        with self.assertNumQueries(3):
            groups = self.groups(product, group_by="store", interval="day")
        self.assertEqual(len(groups), 4)
        self.assertEqual(sum(len(group["buckets"]) for group in groups), 20)

    def test_invalid_request_does_not_read_lines(self):
        with self.assertNumQueries(1):  # только товар
            self.assertEqual(self.get(self.lidl_milk, interval="year").status_code, 400)

    def test_no_sensitive_receipt_fields(self):
        Receipt.objects.update(raw_text="RAW-TEXT-OF-RECEIPT")
        for product in (self.lidl_milk, self.shop_milk, self.data.ssd):
            for group_by in ("country", "store", "none"):
                with self.subTest(product=product.name, group_by=group_by):
                    body = self.body(product, group_by=group_by, interval="day")
                    self.assertEqual(set(body), {"product", "price", "group_by", "interval", "groups"})
                    for group in body["groups"]:
                        self.assertEqual(set(group["total"]), TOTAL_KEYS)
                        self.assertEqual(set(group["total"]["first"]), {"price", "purchased_on"})
                        self.assertEqual(set(group["total"]["last"]), {"price", "purchased_on"})
                        for item in group["buckets"]:
                            self.assertEqual(set(item), BUCKET_KEYS)
                        if group_by == "store":
                            self.assertEqual(
                                set(group["store"]), {"id", "name", "city", "address", "country", "timezone"},
                            )
                    text = json.dumps(body, ensure_ascii=False)
                    for secret in (
                        "RAW-TEXT-OF-RECEIPT", "Соколов", "420500000000", "ДНС КАЗАХСТАН", "210140004940",
                        "DE813389027", "Иванова", "7382440900170413", "1443445223777",
                        samples.LIDL_REGISTER_SERIAL, "475298/12", "synthetic-", "безналичными",
                    ):
                        self.assertNotIn(secret, text)

    def test_decimals_are_strings(self):
        group = self.group(self.lidl_milk, interval="month")
        for key in ("min", "max", "avg", "change_percent"):
            self.assertIsInstance(group["total"][key], str)
        self.assertIsInstance(group["total"]["count"], int)
        for item in group["buckets"]:
            self.assertRegex(item["avg"], r"^\d+\.\d{4}$")
            self.assertRegex(item["last"], r"^\d+\.\d{4}$")


@tag("integration")
class PriceSummaryRangeTests(SummaryTestCase):
    """Потолок 1000 интервалов: товар с покупкой в каждый из 1001 дня подряд."""

    DAYS = 1001
    START = date(2024, 1, 1)

    @classmethod
    def setUpTestData(cls):
        data = factories.save_samples()
        cls.product = factories.make_product(data.milk, "Молоко каждый день", package=("1", Unit.L))
        days = [cls.START + timedelta(days=offset) for offset in range(cls.DAYS)]
        owner = local_user()
        receipts = Receipt.objects.bulk_create([
            Receipt(
                owner=owner, store=data.lidl_store, currency_id="EUR", operation=Receipt.Operation.SALE,
                purchased_at=datetime.combine(day, time(12, 0), tzinfo=timezone.utc), purchased_on=day,
                receipt_number=f"range-{offset}", total=D("1.00"),
            )
            for offset, day in enumerate(days)
        ])
        ReceiptLine.objects.bulk_create([
            ReceiptLine(
                receipt=receipt, position=1, kind=ReceiptLine.Kind.PRODUCT, raw_name="Молоко", product=cls.product,
                quantity=D("1"), unit=Unit.PCS, unit_price=D("1.00"), amount=D("1.00"),
            )
            for receipt in receipts
        ])
        cls.store, cls.last_day = data.lidl_store, days[-1]

    def assert_too_large(self, **query):
        response = self.get(self.product, **query)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": {
            "code": "range_too_large",
            "message": "Слишком большой диапазон: сузьте даты или укрупните интервал.",
        }})

    def test_more_than_1000_intervals(self):
        self.assert_too_large(interval="day")
        self.assert_too_large(interval="day", group_by="none", price="normalized")

    def test_exactly_1000_intervals(self):
        day_before_last = (self.last_day - timedelta(days=1)).isoformat()
        group = self.group(self.product, interval="day", date_to=day_before_last)
        self.assertEqual(len(group["buckets"]), 1000)
        self.assertEqual(group["total"]["count"], 1000)
        self.assertEqual(group["buckets"][0]["period_start"], self.START.isoformat())
        self.assertEqual(group["buckets"][-1]["period_start"], day_before_last)

    def test_narrower_dates_or_coarser_interval_fit(self):
        group = self.group(self.product, interval="day", date_from="2024-02-01", date_to="2024-02-29")
        self.assertEqual(len(group["buckets"]), 29)
        week = self.group(self.product, interval="week")
        self.assertEqual(len(week["buckets"]), 143)  # 1001 день с понедельника 01.01.2024 = ровно 143 недели
        self.assertEqual(sum(item["count"] for item in week["buckets"]), self.DAYS)
        month = self.group(self.product, interval="month")
        self.assertEqual(len(month["buckets"]), 33)  # январь 2024 — сентябрь 2026
        self.assertEqual(month["total"]["count"], self.DAYS)
        self.assertEqual(self.group(self.product, interval="none")["total"]["count"], self.DAYS)

    def test_limit_counts_intervals_of_all_groups(self):
        # Вторая валюта в те же дни: 600 + 600 интервалов в двух группах — больше 1000 суммарно.
        days = [self.START + timedelta(days=offset) for offset in range(600)]
        owner = local_user()
        receipts = Receipt.objects.bulk_create([
            Receipt(
                owner=owner, store=self.store, currency_id="RUB", operation=Receipt.Operation.SALE,
                purchased_at=datetime.combine(day, time(13, 0), tzinfo=timezone.utc), purchased_on=day,
                receipt_number=f"range-rub-{offset}", total=D("90.00"),
            )
            for offset, day in enumerate(days)
        ])
        ReceiptLine.objects.bulk_create([
            ReceiptLine(
                receipt=receipt, position=1, kind=ReceiptLine.Kind.PRODUCT, raw_name="Молоко", product=self.product,
                quantity=D("1"), unit=Unit.PCS, unit_price=D("90.00"), amount=D("90.00"),
            )
            for receipt in receipts
        ])
        last_of_600 = days[-1].isoformat()
        self.assert_too_large(interval="day", date_to=last_of_600)
        eur, rub = self.groups(self.product, interval="day", date_to=days[499].isoformat())
        self.assertEqual((len(eur["buckets"]), len(rub["buckets"])), (500, 500))
        self.assertEqual(len(self.group(self.product, interval="day", date_to=last_of_600, currency="RUB")["buckets"]), 600)


# --- ожидающее слияние дублей: поглощённые товары скрыты, формы ответов прежние ---
MERGE_PIZZA = demo.GROUPS[1]


@tag("integration")
class PendingMergePriceSummaryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo_groups()
        cls.target = product(MERGE_PIZZA[0])
        cls.absorbed = [product(name).pk for name in MERGE_PIZZA[1:]]

    def test_surviving_product_summarises_every_purchase_of_the_group(self):
        with self.assertNumQueries(2):  # товар и сводка — как без слияния
            response = self.client.get(f"/api/products/{self.target.pk}/prices/summary/")
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual(set(body), {"product", "price", "group_by", "interval", "groups"})
        self.assertEqual(len(body["groups"]), 1)
        group = body["groups"][0]
        self.assertEqual((group["country"], group["currency"], group["unit"]), ("DE", "EUR", "pcs"))
        self.assertEqual(group["total"]["count"], 4)
        self.assertEqual(group["total"]["first"], {"price": "3.4900", "purchased_on": "2026-06-09"})
        self.assertEqual(group["total"]["last"], {"price": "3.4900", "purchased_on": "2026-10-01"})

    def test_absorbed_product_is_not_found(self):
        for pk in self.absorbed:
            with self.subTest(pk=pk), self.assertNumQueries(1):  # только товар
                response = self.client.get(f"/api/products/{pk}/prices/summary/")
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"error": {"code": "not_found", "message": "Не найдено."}})
