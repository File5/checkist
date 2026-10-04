from django.test import TestCase, tag

from api.tests import factories
from catalog.models import Category
from receipts.models import Receipt

INTEGER = "Ожидается целое положительное число."
SEARCH = "Ожидается от 2 до 100 символов."
PAGE = "Ожидается целое число от 1."
PAGE_SIZE = "Допустимо от 1 до 200."
ORDERING = "Допустимые значения: name, -name, last_observed_at, -last_observed_at."
EMPTY_PAGE = {"count": 0, "page": 1, "page_size": 50, "pages": 0, "results": []}

PAGED = ("/api/stores/", "/api/brands/", "/api/generic-products/", "/api/products/")
LISTS = ("/api/countries/", "/api/categories/", *PAGED)


@tag("integration")
class CatalogAccessTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = data = factories.save_samples()
        Receipt.objects.filter(pk=data.shop.pk).update(raw_text="RAW-TEXT-MARKER")
        category = Category.objects.get(name="Молочные продукты")
        cls.urls = (
            *LISTS,
            f"/api/categories/{category.pk}/",
            f"/api/generic-products/{data.milk.pk}/",
            *(f"/api/products/{product.pk}/" for product in (data.shop_milk, data.lidl_milk, data.ssd)),
        )

    def test_anonymous_get_ignores_authorization_and_unknown_parameters(self):
        for url in self.urls:
            for headers in ({}, {"HTTP_AUTHORIZATION": "Bearer invalid-token"}):
                with self.subTest(url=url, headers=headers):
                    response = self.client.get(f"{url}?unknown=1", **headers)
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response["Content-Type"], "application/json")

    def test_head_and_options_are_allowed(self):
        for url in self.urls:
            with self.subTest(url=url):
                self.assertEqual(self.client.head(url).status_code, 200)
                self.assertEqual(self.client.options(url).status_code, 200)

    def test_write_methods_are_405(self):
        for url in self.urls:
            for method in ("post", "put", "patch", "delete"):
                with self.subTest(url=url, method=method):
                    response = getattr(self.client, method)(url)
                    self.assertEqual(response.status_code, 405)
                    self.assertEqual(response.json(), {
                        "error": {"code": "method_not_allowed", "message": "Метод не поддерживается."},
                    })
                    self.assertEqual(response["Allow"], "GET, HEAD, OPTIONS")

    def test_html_accept_is_406(self):
        for url in self.urls:
            with self.subTest(url=url):
                response = self.client.get(url, HTTP_ACCEPT="text/html")
                self.assertEqual(response.status_code, 406)
                self.assertEqual(response.json(), {
                    "error": {"code": "not_acceptable", "message": "Доступен только JSON."},
                })

    def test_path_without_trailing_slash_redirects(self):
        response = self.client.get("/api/products")
        self.assertEqual((response.status_code, response["Location"]), (301, "/api/products/"))

    def test_responses_have_no_private_fields(self):
        merchants = [self.data.shop_store.merchant, self.data.dns_store.merchant, self.data.lidl_store.merchant]
        private = [
            "legal_name", "tax_id", "raw_text", "fiscal", "extra", "receipt_number", "shift_number", "register_code",
            "RAW-TEXT-MARKER", "Иванова", "Соколов", "ДНС КАЗАХСТАН",
            *(merchant.tax_id for merchant in merchants),
            self.data.shop.fiscal["fn"], self.data.dns.fiscal["fp"],
        ]
        self.assertTrue(all(private))
        for url in self.urls:
            text = self.client.get(url).content.decode()
            for value in private:
                with self.subTest(url=url, value=value):
                    self.assertNotIn(value, text)


@tag("integration")
class CatalogEmptyDatabaseTests(TestCase):
    """Только сиды: страны и валюты есть, магазинов, каталога и чеков нет."""

    def test_lists(self):
        for url in LISTS:
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json(), EMPTY_PAGE if url in PAGED else {"results": []})

    def test_all_countries_without_stores(self):
        self.assertEqual(self.client.get("/api/countries/?all=1").json(), {"results": [
            {"code": code, "name": name, "currencies": [], "stores_count": 0, "products_count": 0}
            for code, name in (("DE", "Германия"), ("KZ", "Казахстан"), ("RU", "Россия"))
        ]})

    def test_second_page_of_empty_list_is_out_of_range(self):
        for url in PAGED:
            with self.subTest(url=url):
                response = self.client.get(f"{url}?page=2")
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "page_out_of_range"))

    def test_objects_are_not_found(self):
        for url in ("/api/categories/1/", "/api/generic-products/1/", "/api/products/1/"):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {"error": {"code": "not_found", "message": "Не найдено."}})

    def test_non_numeric_object_key_is_not_found(self):
        for url in ("/api/categories/abc/", "/api/generic-products/-1/", "/api/products/1.5/"):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "not_found"))


@tag("integration")
class CatalogInvalidParameterTests(TestCase):
    def assert_invalid(self, url, fields):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 400, url)
        self.assertEqual(response.json(), {"error": {
            "code": "invalid_parameter", "message": "Некорректные параметры запроса.", "fields": fields,
        }})

    def test_each_parameter(self):
        long_query = "я" * 101
        cases = [
            ("/api/countries/?all=2", {"all": ["Ожидается 1 или 0."]}),
            ("/api/countries/?all=true", {"all": ["Ожидается 1 или 0."]}),
            ("/api/stores/?country=FR", {"country": ["Неизвестный код страны."]}),
            ("/api/stores/?country=DEU", {"country": ["Ожидается код страны из двух букв."]}),
            ("/api/stores/?q=a", {"q": [SEARCH]}),
            ("/api/brands/?q=a", {"q": [SEARCH]}),
            (f"/api/brands/?q={long_query}", {"q": [SEARCH]}),
            ("/api/categories/?q=a", {"q": [SEARCH]}),
            (f"/api/categories/?q={long_query}", {"q": [SEARCH]}),
            ("/api/generic-products/?category=abc", {"category": [INTEGER]}),
            ("/api/generic-products/?category=0", {"category": [INTEGER]}),
            ("/api/generic-products/?q=a", {"q": [SEARCH]}),
            ("/api/products/?q=a", {"q": [SEARCH]}),
            (f"/api/products/?q={long_query}", {"q": [SEARCH]}),
            ("/api/products/?category=abc", {"category": [INTEGER]}),
            ("/api/products/?category=-1", {"category": [INTEGER]}),
            ("/api/products/?generic=1.5", {"generic": [INTEGER]}),
            ("/api/products/?generic=0", {"generic": [INTEGER]}),
            ("/api/products/?brand=abc", {"brand": [INTEGER]}),
            (f"/api/products/?brand={2**63}", {"brand": [INTEGER]}),
            ("/api/products/?country=FR", {"country": ["Неизвестный код страны."]}),
            ("/api/products/?country=D", {"country": ["Ожидается код страны из двух букв."]}),
            ("/api/products/?has_prices=yes", {"has_prices": ["Ожидается 1 или 0."]}),
            ("/api/products/?ordering=price", {"ordering": [ORDERING]}),
            ("/api/products/?ordering=id", {"ordering": [ORDERING]}),
        ]
        for url, fields in cases:
            with self.subTest(url=url):
                self.assert_invalid(url, fields)

    def test_page_parameters_of_every_paginated_list(self):
        cases = [
            ("page=0", {"page": [PAGE]}),
            ("page=abc", {"page": [PAGE]}),
            ("page_size=0", {"page_size": [PAGE_SIZE]}),
            ("page_size=201", {"page_size": [PAGE_SIZE]}),
            ("page_size=abc", {"page_size": [PAGE_SIZE]}),
        ]
        for url in PAGED:
            for query, fields in cases:
                with self.subTest(url=url, query=query):
                    self.assert_invalid(f"{url}?{query}", fields)

    def test_all_errors_are_reported_at_once(self):
        self.assert_invalid(
            "/api/products/?q=a&category=x&generic=x&brand=x&country=FR&has_prices=2&ordering=price&page=0&page_size=0",
            {
                "q": [SEARCH], "category": [INTEGER], "generic": [INTEGER], "brand": [INTEGER],
                "country": ["Неизвестный код страны."], "has_prices": ["Ожидается 1 или 0."],
                "ordering": [ORDERING], "page": [PAGE], "page_size": [PAGE_SIZE],
            },
        )

    def test_boundary_values_are_accepted(self):
        for url in ("/api/products/?page_size=200&page=1", "/api/products/?q=" + "я" * 100, "/api/products/?q=ab"):
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)
