from django.test import TestCase, tag

from api.tests import factories
from catalog.models import Brand
from receipts.tests import samples
from stores.models import Country, Merchant, Store


def page(results, **fields):
    return {"count": len(results), "page": 1, "page_size": 50, "pages": 1 if results else 0, "results": results, **fields}


def store_json(store, name, receipts_count):
    return {
        "id": store.pk, "name": name, "city": store.city, "address": store.address_raw,
        "country": store.country_id, "timezone": store.timezone, "receipts_count": receipts_count,
    }


@tag("integration")
class CountriesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = factories.save_samples()

    def test_exact_body(self):
        with self.assertNumQueries(4):
            response = self.client.get("/api/countries/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"results": [
            {"code": "DE", "name": "Германия", "currencies": ["EUR"], "stores_count": 1, "products_count": 1},
            {"code": "KZ", "name": "Казахстан", "currencies": ["KZT"], "stores_count": 1, "products_count": 1},
            {"code": "RU", "name": "Россия", "currencies": ["RUB"], "stores_count": 1, "products_count": 1},
        ]})

    def test_all_adds_countries_without_stores(self):
        Country.objects.create(code="FR", name="Франция")
        france = {"code": "FR", "name": "Франция", "currencies": [], "stores_count": 0, "products_count": 0}
        for query in ("", "?all=0"):
            with self.subTest(query=query):
                codes = [row["code"] for row in self.client.get(f"/api/countries/{query}").json()["results"]]
                self.assertEqual(codes, ["DE", "KZ", "RU"])
        results = self.client.get("/api/countries/?all=1").json()["results"]
        self.assertEqual([row["code"] for row in results], ["DE", "FR", "KZ", "RU"])
        self.assertEqual(results[1], france)

    def test_currencies_come_from_receipts_and_are_sorted(self):
        factories.second_currency(self.data)
        results = {row["code"]: row for row in self.client.get("/api/countries/").json()["results"]}
        self.assertEqual(results["RU"]["currencies"], ["EUR", "RUB"])
        self.assertEqual(results["RU"]["products_count"], 1)

    def test_products_count_is_distinct_matched_products_with_observations(self):
        factories.unit_mismatch(self.data)  # второй товар в Lidl
        factories.make_product(self.data.milk, "Без наблюдений")
        results = {row["code"]: row for row in self.client.get("/api/countries/").json()["results"]}
        self.assertEqual(results["DE"]["products_count"], 2)
        self.assertEqual(results["DE"]["stores_count"], 1)


@tag("integration")
class StoresTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = factories.save_samples()

    def names(self, query=""):
        return [row["name"] for row in self.client.get(f"/api/stores/{query}").json()["results"]]

    def test_exact_body(self):
        data = self.data
        with self.assertNumQueries(2):
            response = self.client.get("/api/stores/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), page([
            store_json(data.dns_store, "DNS", 1),
            store_json(data.lidl_store, "Lidl", 6),
            store_json(data.shop_store, "Магазин «Елена»", 1),
        ]))
        lidl = response.json()["results"][1]
        self.assertEqual(
            (lidl["city"], lidl["address"], lidl["country"], lidl["timezone"]),
            ("Lindau", "Kemptener Straße 17, 88131 Lindau", "DE", "Europe/Berlin"),
        )

    def test_filters(self):
        cases = [
            ("?country=DE", ["Lidl"]),
            ("?country=de", ["Lidl"]),
            ("?q=lid", ["Lidl"]),  # вывеска
            ("?q=ЕЛЕНА", ["Магазин «Елена»"]),  # название магазина, без учёта регистра
            ("?q=lindau", ["Lidl"]),  # город
            ("?q=алмат", ["DNS"]),
            ("?q=нет такого", []),
            ("?country=DE&q=li", ["Lidl"]),
            ("?country=RU&q=li", []),
            ("?unknown=1", ["DNS", "Lidl", "Магазин «Елена»"]),
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.names(query), expected)

    def test_legal_name_is_not_searched(self):
        self.assertEqual(self.names("?q=Соколов"), [])
        self.assertEqual(self.names("?q=ДНС КАЗАХСТАН"), [])

    def test_name_fallback_and_stable_order(self):
        second_lidl = Store.objects.create(
            merchant=self.data.lidl_store.merchant, country_id="DE", city="Köln",
            address_raw="Teststraße 1, 50667 Köln", timezone="Europe/Berlin",
        )
        merchant = Merchant.objects.create(country_id="DE", legal_name="Mustermann Einzelhandel")
        unnamed = Store.objects.create(
            merchant=merchant, country_id="DE", city="Köln", address_raw="Teststraße 2, 50667 Köln",
            timezone="Europe/Berlin",
        )
        results = self.client.get("/api/stores/?country=DE").json()["results"]
        self.assertEqual(
            [(row["id"], row["name"], row["receipts_count"]) for row in results],
            [(self.data.lidl_store.pk, "Lidl", 6), (second_lidl.pk, "Lidl", 0), (unnamed.pk, f"Магазин №{unnamed.pk}", 0)],
        )

    def test_pagination(self):
        first = self.client.get("/api/stores/?page_size=2").json()
        self.assertEqual((first["count"], first["page"], first["page_size"], first["pages"]), (3, 1, 2, 2))
        self.assertEqual([row["name"] for row in first["results"]], ["DNS", "Lidl"])
        second = self.client.get("/api/stores/?page_size=2&page=2").json()
        self.assertEqual([row["name"] for row in second["results"]], ["Магазин «Елена»"])
        response = self.client.get("/api/stores/?page_size=2&page=3")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "page_out_of_range"))


@tag("integration")
class BrandsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        samples.save_catalog()
        cls.samsung = Brand.objects.get(name="Samsung")
        cls.acme = Brand.objects.create(name="Acme", manufacturer="Acme GmbH")

    def test_exact_body(self):
        with self.assertNumQueries(2):
            response = self.client.get("/api/brands/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), page([
            {"id": self.acme.pk, "name": "Acme", "manufacturer": "Acme GmbH", "products_count": 0},
            {"id": self.samsung.pk, "name": "Samsung", "manufacturer": "", "products_count": 1},
        ]))

    def test_search(self):
        for query, expected in (("?q=SAMS", ["Samsung"]), ("?q=ac", ["Acme"]), ("?q=zz", [])):
            with self.subTest(query=query):
                names = [row["name"] for row in self.client.get(f"/api/brands/{query}").json()["results"]]
                self.assertEqual(names, expected)

    def test_pagination(self):
        body = self.client.get("/api/brands/?page_size=1&page=2").json()
        self.assertEqual((body["count"], body["pages"], [row["name"] for row in body["results"]]), (2, 2, ["Samsung"]))
        response = self.client.get("/api/brands/?page_size=1&page=3")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "page_out_of_range"))
