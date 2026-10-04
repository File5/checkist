import json
from datetime import date, time
from decimal import Decimal

from django.test import TestCase, tag

from api.tests import factories
from api.tests.factories import observe
from catalog.units import Unit
from receipts.models import Receipt, ReceiptDiscount, ReceiptLine
from receipts.tests import samples
from receipts.tests.test_models import make_line
from stores.models import Store

D = Decimal
INVALID = {"code": "invalid_parameter", "message": "Некорректные параметры запроса."}
NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}
POINT_KEYS = {
    "observed_at", "purchased_on", "store", "currency", "quantity", "unit", "list_unit_price", "paid_unit_price",
    "discount_amount", "normalized_price", "normalized_unit", "comparable", "receipt_id", "position",
}


def url(product):
    return f"/api/products/{getattr(product, 'pk', product)}/prices/"


def second_lidl_store(data):
    """Второй магазин того же продавца в Германии."""
    return Store.objects.create(
        merchant=data.lidl_store.merchant, country_id="DE", city="Berlin",
        address_raw="Teststraße 1, 10115 Berlin", timezone="Europe/Berlin",
    )


@tag("integration")
class PricePointsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = factories.save_samples()
        cls.lidl_milk, cls.shop_milk = cls.data.lidl_milk, cls.data.shop_milk

    def get(self, product, **query):
        return self.client.get(url(product), query)

    def results(self, product, **query):
        response = self.get(product, **query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()["results"]

    def invalid(self, fields, **query):
        response = self.get(self.lidl_milk, **query)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), {"error": {**INVALID, "fields": fields}})

    # --- тело ответа ---

    def lidl_point(self, receipt, observed_at, position, **fields):
        store = self.data.lidl_store
        return {
            "observed_at": observed_at, "purchased_on": receipt.purchased_on.isoformat(),
            "store": {"id": store.pk, "name": "Lidl", "city": "Lindau", "country": "DE"},
            "currency": "EUR", "quantity": "1.000", "unit": "pcs",
            "list_unit_price": "1.0500", "paid_unit_price": "1.0500", "discount_amount": "0.00",
            "normalized_price": None, "normalized_unit": None, "comparable": False,
            "receipt_id": receipt.pk, "position": position, **fields,
        }

    def test_exact_body_of_lidl_milk(self):
        lidl = self.data.lidl
        response = self.get(self.lidl_milk)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {
            "product": {"id": self.lidl_milk.pk, "name": samples.MILK, "base_unit": "l"},
            "count": 6, "page": 1, "page_size": 200, "pages": 1,
            "results": [
                self.lidl_point(lidl[0], "2026-06-02T09:50:00Z", 2),
                self.lidl_point(lidl[1], "2026-06-09T16:36:00Z", 4),
                self.lidl_point(lidl[2], "2026-06-17T13:40:00Z", 1),
                self.lidl_point(lidl[3], "2026-06-29T14:02:00Z", 5),
                self.lidl_point(lidl[4], "2026-07-06T14:28:00Z", 1, quantity="2.000"),
                self.lidl_point(lidl[5], "2026-10-01T16:59:00Z", 1, list_unit_price="1.0900", paid_unit_price="1.0900"),
            ],
        })

    def test_exact_body_of_shop_milk_with_normalized_price(self):
        store = self.data.shop_store
        self.assertEqual(self.get(self.shop_milk).json(), {
            "product": {"id": self.shop_milk.pk, "name": samples.SHOP_MILK_NAME, "base_unit": "l"},
            "count": 1, "page": 1, "page_size": 200, "pages": 1,
            "results": [{
                "observed_at": "2026-09-28T06:58:00Z", "purchased_on": "2026-09-28",
                # Вывески у продавца нет — название магазина; юридическое имя наружу не идёт.
                "store": {"id": store.pk, "name": "Магазин «Елена»", "city": "Кемерово", "country": "RU"},
                "currency": "RUB", "quantity": "1.000", "unit": "pcs",
                "list_unit_price": "111.0000", "paid_unit_price": "111.0000", "discount_amount": "0.00",
                "normalized_price": "130.5882", "normalized_unit": "l", "comparable": True,
                "receipt_id": self.data.shop.pk, "position": 1,
            }],
        })

    def test_normalized_unit_other_than_base_unit_is_not_comparable(self):
        line = factories.unit_mismatch(self.data)  # цена за кг у продукта с base_unit = л
        (point,) = self.results(line.product)
        self.assertEqual(
            (point["normalized_price"], point["normalized_unit"], point["comparable"]), ("3.0000", "kg", False),
        )

    def test_weighed_line_and_line_discount(self):
        product = factories.make_product(self.data.milk, "Молоко на розлив")
        observe(
            product, self.data.lidl_store, "EUR", date(2026, 7, 1), "2.00",
            quantity="0.5", unit=Unit.L, discount="0.25",
        )
        (point,) = self.results(product)
        self.assertEqual({key: point[key] for key in (
            "quantity", "unit", "list_unit_price", "paid_unit_price", "discount_amount",
            "normalized_price", "normalized_unit", "comparable",
        )}, {
            "quantity": "0.500", "unit": "l", "list_unit_price": "2.0000", "paid_unit_price": "1.5000",
            "discount_amount": "0.25", "normalized_price": "1.5000", "normalized_unit": "l", "comparable": True,
        })

    def test_receipt_discount_is_not_in_price(self):
        line = observe(self.lidl_milk, self.data.lidl_store, "EUR", date(2026, 7, 1), "2.00")
        ReceiptDiscount.objects.create(receipt=line.receipt, line=None, position=1, name="Rabatt", amount=D("1.00"))
        (point,) = self.results(self.lidl_milk, date_from="2026-07-01", date_to="2026-07-01")
        self.assertEqual((point["paid_unit_price"], point["discount_amount"]), ("2.0000", "0.00"))

    def test_product_without_observations(self):
        product = factories.make_product(self.data.milk, "Молоко без покупок")
        response = self.get(product)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "product": {"id": product.pk, "name": "Молоко без покупок", "base_unit": "l"},
            "count": 0, "page": 1, "page_size": 200, "pages": 0, "results": [],
        })

    # --- что не входит в цены ---

    def test_only_product_lines_of_sale_receipts_with_positive_quantity(self):
        product = factories.make_product(self.data.milk, "Молоко для исключений")
        store, on = self.data.lidl_store, date(2026, 7, 1)
        kept = observe(product, store, "EUR", on, "1.00")
        observe(product, store, "EUR", on, "0.25", kind=ReceiptLine.Kind.DEPOSIT)
        observe(product, store, "EUR", on, "0.25", quantity="-1", kind=ReceiptLine.Kind.DEPOSIT_RETURN)
        observe(product, store, "EUR", on, "3.00", kind=ReceiptLine.Kind.SERVICE)
        observe(product, store, "EUR", on, "1.00", quantity="-1")  # отрицательное количество
        refund = factories.make_receipt(store, "EUR", on, operation=Receipt.Operation.REFUND)
        make_line(refund, product=product)
        self.assertEqual(ReceiptLine.objects.filter(product=product).count(), 6)
        self.assertEqual([point["receipt_id"] for point in self.results(product)], [kept.receipt_id])

    def test_other_products_and_unmatched_lines_are_not_included(self):
        self.assertEqual(self.get(self.shop_milk).json()["count"], 1)
        self.assertEqual(self.get(self.data.ssd).json()["count"], 1)

    # --- фильтры ---

    def dates(self, **query):
        return [point["purchased_on"] for point in self.results(self.lidl_milk, **query)]

    def test_date_filters_are_inclusive(self):
        self.assertEqual(self.dates(date_from="2026-06-17"), ["2026-06-17", "2026-06-29", "2026-07-06", "2026-10-01"])
        self.assertEqual(self.dates(date_to="2026-06-17"), ["2026-06-02", "2026-06-09", "2026-06-17"])
        self.assertEqual(self.dates(date_from="2026-06-09", date_to="2026-06-29"), ["2026-06-09", "2026-06-17", "2026-06-29"])
        self.assertEqual(self.dates(date_from="2026-06-09", date_to="2026-06-09"), ["2026-06-09"])

    def test_date_window_without_purchases(self):
        response = self.get(self.lidl_milk, date_from="2026-08-01", date_to="2026-08-31")
        self.assertEqual(response.status_code, 200)
        self.assertEqual((response.json()["count"], response.json()["results"]), (0, []))

    def test_date_filter_uses_local_date_of_receipt(self):
        # 00:30 в Берлине 1 июля — это 22:30 UTC 30 июня; фильтр идёт по дате чека.
        observe(self.lidl_milk, self.data.lidl_store, "EUR", date(2026, 7, 1), "1.00", at=time(0, 30))
        (point,) = self.results(self.lidl_milk, date_from="2026-07-01", date_to="2026-07-01")
        self.assertEqual((point["observed_at"], point["purchased_on"]), ("2026-06-30T22:30:00Z", "2026-07-01"))
        self.assertNotIn("2026-07-01", self.dates(date_to="2026-06-30"))

    def test_country_filter(self):
        observe(self.lidl_milk, self.data.shop_store, "RUB", date(2026, 8, 1), "90.00")
        self.assertEqual(len(self.results(self.lidl_milk, country="DE")), 6)
        self.assertEqual(self.dates(country="RU"), ["2026-08-01"])
        self.assertEqual(self.dates(country="ru"), ["2026-08-01"])  # регистр не важен
        self.assertEqual(self.dates(country="KZ"), [])  # страна есть в справочнике, покупок нет

    def test_currency_filter(self):
        factories.second_currency(self.data)  # shop_milk в том же магазине, чек в EUR
        self.assertEqual([p["currency"] for p in self.results(self.shop_milk)], ["EUR", "RUB"])
        self.assertEqual([p["currency"] for p in self.results(self.shop_milk, currency="EUR")], ["EUR"])
        self.assertEqual([p["currency"] for p in self.results(self.shop_milk, currency="rub")], ["RUB"])
        self.assertEqual(self.results(self.shop_milk, currency="KZT"), [])

    def test_store_filter(self):
        other = second_lidl_store(self.data)
        observe(self.lidl_milk, other, "EUR", date(2026, 8, 1), "0.99")
        self.assertEqual(self.dates(store=other.pk), ["2026-08-01"])
        self.assertEqual(len(self.dates(store=self.data.lidl_store.pk)), 6)
        self.assertEqual(self.dates(store=self.data.dns_store.pk), [])  # магазин есть, покупок нет

    def test_filters_combine(self):
        other = second_lidl_store(self.data)
        observe(self.lidl_milk, other, "EUR", date(2026, 6, 10), "0.99")
        observe(self.lidl_milk, other, "RUB", date(2026, 6, 11), "90.00")
        observe(self.lidl_milk, self.data.shop_store, "EUR", date(2026, 6, 12), "1.10")
        query = {"date_from": "2026-06-05", "date_to": "2026-06-20", "country": "DE", "currency": "EUR"}
        self.assertEqual(self.dates(**query), ["2026-06-09", "2026-06-10", "2026-06-17"])
        self.assertEqual(self.dates(**query, store=other.pk), ["2026-06-10"])
        self.assertEqual(self.dates(**query, store=self.data.shop_store.pk), [])

    def test_unknown_parameters_are_ignored(self):
        self.assertEqual(len(self.results(self.lidl_milk, format="xml", foo="bar", interval="year")), 6)

    def test_empty_parameters_are_absent(self):
        self.assertEqual(len(self.results(self.lidl_milk, date_from="", country=" ", store="", page_size="")), 6)

    # --- сортировка и пагинация ---

    def test_ordering(self):
        ascending = self.dates(ordering="observed_at")
        self.assertEqual(ascending, self.dates())
        self.assertEqual(ascending[0], "2026-06-02")
        self.assertEqual(self.dates(ordering="-observed_at"), ascending[::-1])

    def test_order_is_stable_for_equal_observed_at(self):
        product = factories.make_product(self.data.milk, "Молоко в один момент")
        store, on = self.data.lidl_store, date(2026, 7, 1)
        first = factories.make_receipt(store, "EUR", on)
        second = factories.make_receipt(store, "EUR", on)
        self.assertEqual(first.purchased_at, second.purchased_at)
        # Создаются в обратном порядке: порядок ответа не должен совпасть с порядком вставки.
        make_line(second, product=product, position=2)
        make_line(second, product=product, position=1)
        make_line(first, product=product, position=3)
        earlier = observe(product, store, "EUR", date(2026, 6, 30), "1.00")
        tied = [(first.pk, 3), (second.pk, 1), (second.pk, 2)]

        def order(**query):
            return [(point["receipt_id"], point["position"]) for point in self.results(product, **query)]

        self.assertEqual(order(), [(earlier.receipt_id, 1), *tied])
        # Вторичные ключи — receipt_id, position — по возрастанию при обоих направлениях.
        self.assertEqual(order(ordering="-observed_at"), [*tied, (earlier.receipt_id, 1)])
        self.assertEqual(order(page_size=2, page=1) + order(page_size=2, page=2), [(earlier.receipt_id, 1), *tied])

    def test_pagination(self):
        body = self.get(self.lidl_milk, page_size=4, page=2).json()
        self.assertEqual({key: body[key] for key in ("count", "page", "page_size", "pages")}, {
            "count": 6, "page": 2, "page_size": 4, "pages": 2,
        })
        self.assertEqual([point["purchased_on"] for point in body["results"]], ["2026-07-06", "2026-10-01"])
        self.assertEqual(self.get(self.lidl_milk, page_size=500).json()["page_size"], 500)
        self.assertNotIn("next", body)
        self.assertNotIn("previous", body)

    def test_page_out_of_range(self):
        for query in ({"page": 2}, {"page": 3, "page_size": 3}, {"page": 10**18}):
            with self.subTest(query=query):
                response = self.get(self.lidl_milk, **query)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {
                    "error": {"code": "page_out_of_range", "message": "Страница за пределами диапазона."},
                })

    # --- ошибки ---

    def test_invalid_parameters(self):
        date_message = ["Ожидается дата ГГГГ-ММ-ДД."]
        cases = [
            ({"date_from": "02.06.2026"}, {"date_from": date_message}),
            ({"date_from": "2026-02-30"}, {"date_from": date_message}),
            ({"date_to": "2026-6-2"}, {"date_to": date_message}),
            ({"date_to": "tomorrow"}, {"date_to": date_message}),
            ({"date_from": "2026-07-01", "date_to": "2026-06-30"}, {"date_from": ["Должна быть не позже date_to."]}),
            ({"country": "ZZ"}, {"country": ["Неизвестный код страны."]}),
            ({"country": "DEU"}, {"country": ["Ожидается код страны из двух букв."]}),
            ({"country": "DE,RU"}, {"country": ["Ожидается код страны из двух букв."]}),
            ({"currency": "ZZZ"}, {"currency": ["Неизвестный код валюты."]}),
            ({"currency": "EU"}, {"currency": ["Ожидается код валюты из трёх букв."]}),
            ({"store": 10**9}, {"store": ["Магазин не найден."]}),
            ({"store": "lidl"}, {"store": ["Ожидается целое положительное число."]}),
            ({"store": 0}, {"store": ["Ожидается целое положительное число."]}),
            ({"store": 2**63}, {"store": ["Ожидается целое положительное число."]}),
            ({"ordering": "price"}, {"ordering": ["Допустимые значения: observed_at, -observed_at."]}),
            ({"page": 0}, {"page": ["Ожидается целое число от 1."]}),
            ({"page": "x"}, {"page": ["Ожидается целое число от 1."]}),
            ({"page_size": 0}, {"page_size": ["Допустимо от 1 до 500."]}),
            ({"page_size": 501}, {"page_size": ["Допустимо от 1 до 500."]}),
            ({"page_size": -1}, {"page_size": ["Допустимо от 1 до 500."]}),
        ]
        for query, fields in cases:
            with self.subTest(query=query):
                self.invalid(fields, **query)

    def test_all_invalid_parameters_are_reported_together(self):
        self.invalid(
            {
                "date_from": ["Ожидается дата ГГГГ-ММ-ДД."], "country": ["Неизвестный код страны."],
                "currency": ["Неизвестный код валюты."], "store": ["Магазин не найден."],
                "ordering": ["Допустимые значения: observed_at, -observed_at."],
                "page_size": ["Допустимо от 1 до 500."],
            },
            date_from="x", country="ZZ", currency="ZZZ", store=10**9, ordering="x", page_size=501,
        )

    def test_error_does_not_echo_value(self):
        response = self.get(self.lidl_milk, country="<script>", date_from="DROP TABLE")
        self.assertEqual(response.status_code, 400)
        self.assertNotIn("script", response.content.decode())
        self.assertNotIn("DROP", response.content.decode())

    def test_unknown_product(self):
        for product in (10**9, 2**63 - 1, 2**63, 10**30):
            with self.subTest(product=product):
                response = self.get(product)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), NOT_FOUND)
        # Товара нет — 404, даже если параметры тоже недопустимы.
        self.assertEqual(self.get(10**9, page_size=0).status_code, 404)

    def test_malformed_path_is_not_found(self):
        for path in ("/api/products/abc/prices/", "/api/products/-1/prices/", "/api/products//prices/"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), NOT_FOUND)

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
        self.assertEqual(ReceiptLine.objects.filter(product=self.lidl_milk).count(), 6)

    def test_only_json(self):
        response = self.client.get(url(self.lidl_milk), HTTP_ACCEPT="text/html")
        self.assertEqual(response.status_code, 406)
        self.assertEqual(response.json()["error"]["code"], "not_acceptable")

    # --- запросы и чувствительные поля ---

    def test_query_count_does_not_depend_on_number_of_points(self):
        with self.assertNumQueries(3):  # товар, COUNT, страница
            self.assertEqual(len(self.results(self.shop_milk)), 1)
        with self.assertNumQueries(3):
            self.assertEqual(len(self.results(self.lidl_milk)), 6)
        other = second_lidl_store(self.data)
        for day in range(1, 11):
            observe(self.lidl_milk, other, "EUR", date(2026, 8, day), "1.00")
        with self.assertNumQueries(3):
            self.assertEqual(len(self.results(self.lidl_milk)), 16)

    def test_query_count_with_filters(self):
        query = {
            "date_from": "2026-06-01", "date_to": "2026-12-31", "country": "DE", "currency": "EUR",
            "store": self.data.lidl_store.pk, "ordering": "-observed_at", "page_size": 2, "page": 2,
        }
        with self.assertNumQueries(6):  # товар, страна, валюта, магазин, COUNT, страница
            self.assertEqual(len(self.results(self.lidl_milk, **query)), 2)

    def test_invalid_request_does_not_read_lines(self):
        with self.assertNumQueries(1):  # только товар
            self.assertEqual(self.get(self.lidl_milk, page_size=0).status_code, 400)

    def test_no_sensitive_receipt_fields(self):
        Receipt.objects.update(raw_text="RAW-TEXT-OF-RECEIPT")
        for product in (self.lidl_milk, self.shop_milk, self.data.ssd):
            with self.subTest(product=product.name):
                body = self.get(product).json()
                for point in body["results"]:
                    self.assertEqual(set(point), POINT_KEYS)
                    self.assertEqual(set(point["store"]), {"id", "name", "city", "country"})
                self.assertEqual(set(body), {"product", "count", "page", "page_size", "pages", "results"})
                self.assertEqual(set(body["product"]), {"id", "name", "base_unit"})
                text = json.dumps(body, ensure_ascii=False)
                for secret in (
                    "RAW-TEXT-OF-RECEIPT", "Соколов", "420500000000", "ДНС КАЗАХСТАН", "210140004940",
                    "DE813389027", "Иванова", "7382440900170413", "1443445223777", samples.LIDL_REGISTER_SERIAL,
                    "475298/12", "synthetic-", "безналичными",
                ):
                    self.assertNotIn(secret, text)
