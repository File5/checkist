"""Границы Decimal и удаления между запросами на настоящем Postgres."""
from datetime import date
from decimal import Decimal

import psycopg
from django.db import connection
from django.test import TestCase, TransactionTestCase, tag
from rest_framework.test import APIClient

from api.tests.factories import make_product, observe, save_samples
from catalog.models import Category, GenericProduct
from catalog.units import Unit
from receipts.models import Receipt, ReceiptLine
from receipts.prices import price_summary
from stores.models import Country, Currency, Merchant, Store

D = Decimal
MAX_RATE = "999999999999.999999999999"
MAX_NORMALIZED = "999999999999990000000.0000"
MAX_CONVERTED = "999999999999989999999999000000000.0000"


@tag("integration")
class DecimalBoundaryTests(TestCase):
    client_class = APIClient

    @classmethod
    def setUpTestData(cls):
        cls.data = save_samples()

    def body(self, url, **query):
        response = self.client.get(url, query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def boundary_product(self):
        product = make_product(self.data.milk, "Граница Decimal", package=("0.001", Unit.ML))
        line = observe(product, self.data.shop_store, "RUB", date(2026, 11, 1), "9999999999.00")
        # amount/quantity независимо разрешены моделями; validate_receipt даёт предупреждения.
        line.quantity, line.amount = D("0.001"), D("999999999999.99")
        line.unit_price = D("9999999999.9999")
        line.full_clean()
        line.save(update_fields=["quantity", "amount", "unit_price"])
        return product, line

    def assert_conversion(self, url, product, rate, normalized, converted):
        body = self.body(url, target_currency="EUR", rates=f"RUB:{rate}", date_from="2026-11-01")
        result = next(row for row in body["results"] if row["product"]["id"] == product.pk)
        (offer,) = result["offers"]
        self.assertEqual(offer["last"]["normalized_price"], normalized)
        self.assertEqual(offer["converted"], {
            "currency": "EUR", "last": converted, "min": converted, "max": converted, "avg": converted,
        })
        self.assertEqual(body["overall"]["min"], converted)
        self.assertEqual(body["overall"]["offers_with_price"], 1)
        self.assertEqual(offer["rank_overall"], 1)

    def review_product(self):
        product = make_product(self.data.milk, "Регрессия ревью", package=("0.001", Unit.ML))
        observe(product, self.data.shop_store, "RUB", date(2026, 11, 1), "9999999999.00").full_clean()
        return product

    def test_review_boundary_alternatives(self):
        product = self.review_product()
        self.assert_conversion(
            f"/api/products/{product.pk}/alternatives/", product, "999999999999",
            "9999999999000000.0000", "9999999998990000000001000000.0000",
        )

    def test_review_boundary_comparison(self):
        product = self.review_product()
        self.assert_conversion(
            f"/api/generic-products/{product.generic_id}/comparison/", product, "999999999999",
            "9999999999000000.0000", "9999999998990000000001000000.0000",
        )

    def test_full_model_and_rate_boundaries(self):
        product, _ = self.boundary_product()
        for url in (
            f"/api/products/{product.pk}/alternatives/",
            f"/api/generic-products/{product.generic_id}/comparison/",
        ):
            with self.subTest(url=url):
                self.assert_conversion(url, product, MAX_RATE, MAX_NORMALIZED, MAX_CONVERTED)

    def test_negative_paid_price_at_discount_boundary(self):
        product, line = self.boundary_product()
        line.amount, line.discount_amount = D("0.00"), D("999999999999.99")
        line.full_clean()
        line.save(update_fields=["amount", "discount_amount"])
        for url in (
            f"/api/products/{product.pk}/alternatives/",
            f"/api/generic-products/{product.generic_id}/comparison/",
        ):
            with self.subTest(url=url):
                self.assert_conversion(url, product, MAX_RATE, "-" + MAX_NORMALIZED, "-" + MAX_CONVERTED)

    def test_percent_between_extreme_converted_prices(self):
        product, _ = self.boundary_product()
        base = make_product(self.data.milk, "База малого курса", package=("100", Unit.L))
        observe(base, self.data.shop_store, "KZT", date(2026, 11, 1), "0.01")
        body = self.body(
            f"/api/products/{base.pk}/alternatives/", target_currency="EUR",
            rates=f"RUB:{MAX_RATE},KZT:0.000000000001", date_from="2026-11-01",
        )
        result = next(row for row in body["results"] if row["product"]["id"] == product.pk)
        self.assertEqual(
            result["offers"][0]["diff_to_base_percent"],
            "999999999999989999999999000000000000009999999999900.00",
        )

    def test_normalized_history_and_summary_boundaries(self):
        product, _ = self.boundary_product()
        # Половина последнего знака в среднем и большой процент динамики.
        observe(product, self.data.shop_store, "RUB", date(2026, 10, 1), "0.00")
        small = observe(product, self.data.shop_store, "RUB", date(2026, 10, 2), "0.01")
        small.quantity = D("100000000.000")
        small.save(update_fields=["quantity"])
        points = self.body(f"/api/products/{product.pk}/prices/")["results"]
        self.assertEqual(points[-1]["normalized_price"], MAX_NORMALIZED)
        for interval in ("none", "month", "day"):
            with self.subTest(interval=interval):
                (group,) = self.body(
                    f"/api/products/{product.pk}/prices/summary/", price="normalized", interval=interval,
                    date_from="2026-10-02",
                )["groups"]
                self.assertEqual(group["total"]["min"], "0.0001")
                self.assertEqual(group["total"]["max"], MAX_NORMALIZED)
                self.assertEqual(group["total"]["avg"], "499999999999995000000.0001")
                self.assertEqual(group["total"]["change_percent"], "999999999999989999999999900.00")


@tag("integration")
class ConcurrentReceiptDeletionTests(TransactionTestCase):
    """Autocommit позволяет чтению видеть commit второго соединения; runner делает flush."""

    client_class = APIClient

    def setUp(self):
        Country.objects.get_or_create(code="RU", defaults={"name": "Тестовая страна"})
        Currency.objects.get_or_create(code="RUB", defaults={"name": "Тестовая валюта"})
        merchant = Merchant.objects.create(country_id="RU", legal_name="Тестовый продавец")
        self.store = Store.objects.create(
            merchant=merchant, country_id="RU", address_raw="Тестовый адрес", timezone="UTC",
        )
        category = Category.objects.create(name="Тестовая категория")
        self.generic = GenericProduct.objects.create(name="Тестовый продукт", category=category, base_unit=Unit.L)
        self.product = make_product(self.generic, "Исчезающий чек", package=("1", Unit.L))
        self.line = observe(self.product, self.store, "RUB", date(2026, 11, 2), "100")
        self.delete_at = 1
        self.survivor = make_product(self.generic, "Сохранившийся чек", package=("1", Unit.L))
        observe(self.survivor, self.store, "RUB", date(2026, 11, 2), "200")

    def delete_before_last_query(self, execute, sql, params, many, context):
        if "SELECT DISTINCT" in sql and "receipts_receiptline" in sql:
            self.last_queries += 1
        if not self.fired and self.last_queries == self.delete_at:
            self.fired = True
            cfg = connection.settings_dict  # NAME — тестовая БД runner, не исходная QA-БД.
            with psycopg.connect(
                host=cfg["HOST"], port=cfg["PORT"], dbname=cfg["NAME"],
                user=cfg["USER"], password=cfg["PASSWORD"], connect_timeout=2,
                options="-c statement_timeout=2000",
            ) as other:
                self.assertNotEqual(other.info.backend_pid, connection.connection.info.backend_pid)
                with other.cursor() as cursor:
                    cursor.execute("DELETE FROM receipts_receiptline WHERE receipt_id=%s", (self.line.receipt_id,))
                    self.assertEqual(cursor.rowcount, 1)
                    cursor.execute("DELETE FROM receipts_receipt WHERE id=%s", (self.line.receipt_id,))
                    self.assertEqual(cursor.rowcount, 1)
        return execute(sql, params, many, context)

    def during_deletion(self, read):
        self.assertTrue(connection.get_autocommit())
        self.fired = False
        self.last_queries = 0
        with connection.execute_wrapper(self.delete_before_last_query):
            result = read()
        self.assertTrue(self.fired, "Не выполнено удаление между запросами")
        self.assertFalse(Receipt.objects.filter(pk=self.line.receipt_id).exists())
        self.assertFalse(ReceiptLine.objects.filter(pk=self.line.pk).exists())
        return result

    def body(self, url, **query):
        response = self.during_deletion(lambda: self.client.get(url, query))
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_price_summary_omits_disappeared_group(self):
        with self.assertNumQueries(2):
            self.fired = False
            self.last_queries = 0
            with connection.execute_wrapper(self.delete_before_last_query):
                summary = price_summary([self.product, self.survivor])
        self.assertTrue(self.fired)
        self.assertNotIn(self.product.pk, summary)
        self.assertEqual(summary[self.survivor.pk][0].last.normalized_price, D("200.0000"))

    def test_product_detail(self):
        body = self.body(f"/api/products/{self.product.pk}/")
        self.assertEqual((body["prices"], body["last_observed_at"], body["stores"]), ([], None, []))

    def test_product_list(self):
        body = self.body("/api/products/")
        rows = {row["id"]: row for row in body["results"]}
        self.assertEqual((rows[self.product.pk]["prices"], rows[self.product.pk]["last_observed_at"]), ([], None))
        self.assertEqual(rows[self.survivor.pk]["prices"][0]["last"]["normalized_price"], "200.0000")

    def assert_comparison(self, url):
        body = self.body(url)
        rows = {row["product"]["id"]: row for row in body["results"]}
        self.assertEqual(rows[self.product.pk]["offers"], [])
        self.assertEqual(rows[self.product.pk]["not_comparable_reason"], "no_observations")
        self.assertEqual(rows[self.survivor.pk]["offers"][0]["rank_in_group"], 1)
        self.assertEqual(body["groups"], [{
            "country": "RU", "currency": "RUB", "products_with_price": 1,
            "min": "200.0000", "max": "200.0000", "avg": "200.0000",
        }])

    def test_alternatives_comparable(self):
        self.assert_comparison(f"/api/products/{self.product.pk}/alternatives/")

    def test_comparison_comparable(self):
        self.assert_comparison(f"/api/generic-products/{self.generic.pk}/comparison/")

    def test_alternatives_without_package(self):
        self.delete_at = 2  # После запроса сравнимых цен, перед last несравнимого предложения.
        self.product.package_quantity, self.product.package_unit = None, ""
        self.product.save(update_fields=["package_quantity", "package_unit"])
        self.assert_comparison(f"/api/products/{self.product.pk}/alternatives/")

    def test_comparison_without_package(self):
        self.delete_at = 2
        self.product.package_quantity, self.product.package_unit = None, ""
        self.product.save(update_fields=["package_quantity", "package_unit"])
        self.assert_comparison(f"/api/generic-products/{self.generic.pk}/comparison/")

    def test_last_deletion_leaves_earlier_observation(self):
        observe(self.product, self.store, "RUB", date(2026, 11, 1), "50")
        body = self.body(f"/api/products/{self.product.pk}/")
        self.assertEqual(body["prices"][0]["last"]["normalized_price"], "50.0000")
        self.assertEqual(body["prices"][0]["last"]["purchased_on"], "2026-11-01")

    def assert_empty_comparison(self, url):
        Receipt.objects.filter(lines__product=self.survivor).delete()
        body = self.body(url, target_currency="RUB")
        self.assertEqual(body["groups"], [])
        self.assertEqual(body["overall"], {"currency": "RUB", "offers_with_price": 0, "min": None})
        self.assertTrue(all(row["offers"] == [] for row in body["results"]))

    def test_alternatives_omit_only_disappeared_group(self):
        self.assert_empty_comparison(f"/api/products/{self.product.pk}/alternatives/")

    def test_comparison_omit_only_disappeared_group(self):
        self.assert_empty_comparison(f"/api/generic-products/{self.generic.pk}/comparison/")

    def test_prices_summary(self):
        body = self.body(f"/api/products/{self.product.pk}/prices/summary/", interval="month", price="normalized")
        self.assertEqual(body["groups"], [])

    def test_generic_detail(self):
        body = self.body(f"/api/generic-products/{self.generic.pk}/")
        self.assertEqual(body["countries"], ["RU"])  # Сохранилось наблюдение другого товара.

    def test_generic_list(self):
        body = self.body("/api/generic-products/")
        self.assertEqual(body["results"][0]["countries"], ["RU"])
