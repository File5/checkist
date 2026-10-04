from urllib.parse import quote, urlencode

from django.http import QueryDict
from django.test import SimpleTestCase, TestCase, tag

from api.params import Params
from api.rates import parse_conversion
from api.tests.factories import save_samples
from config.exceptions import InvalidParameter
from stores.models import Store

CONTROL_MESSAGE = "Управляющие символы недопустимы."
CONTROLS = tuple(chr(code) for code in (*range(0x20), *range(0x7F, 0xA0)))
SEARCH_URLS = (
    "/api/products/", "/api/stores/", "/api/brands/", "/api/generic-products/", "/api/categories/",
)


def insert_control(value, control):
    return (control + value, value[:1] + control + value[1:], value + control)


class QueryControlParamsTests(SimpleTestCase):
    def assert_control_error(self, params, name):
        with self.assertRaises(InvalidParameter) as raised:
            params.check()
        self.assertEqual(raised.exception.code, "invalid_parameter")
        self.assertEqual(raised.exception.status_code, 400)
        self.assertEqual(raised.exception.fields, {name: [CONTROL_MESSAGE]})

    def test_search_rejects_nul_at_every_position(self):
        for value in ("\x00a", "a\x00b", "ab\x00", "\x00"):
            with self.subTest(value=repr(value)):
                params = Params(QueryDict(urlencode({"q": value})))
                self.assertIsNone(params.search())
                self.assert_control_error(params, "q")

    def test_search_rejects_c0_c1_before_trimming(self):
        for control in CONTROLS:
            for value in (*insert_control("мол", control), control):
                with self.subTest(value=repr(value)):
                    params = Params({"q": value})
                    self.assertIsNone(params.search())
                    self.assert_control_error(params, "q")

    def test_other_parsers_reject_controls_without_sql(self):
        cases = (
            ("country", "DE", lambda p: p.country()),
            ("country", "DE,RU", lambda p: p.countries()),
            ("currency", "EUR", lambda p: p.currency()),
            ("target_currency", "EUR", lambda p: p.currency("target_currency")),
            ("category", "1", lambda p: p.integer("category")),
            ("generic", "1", lambda p: p.integer("generic")),
            ("brand", "1", lambda p: p.integer("brand")),
            ("store", "1", lambda p: p.object_id("store", Store.objects.all())),
            ("all", "1", lambda p: p.boolean("all")),
            ("has_prices", "1", lambda p: p.boolean("has_prices")),
            ("ordering", "name", lambda p: p.choice("ordering", ("name", "-name"))),
            ("interval", "month", lambda p: p.choice("interval", ("none", "day", "week", "month"))),
            ("group_by", "country", lambda p: p.choice("group_by", ("country", "store", "none"))),
            ("price", "paid", lambda p: p.choice("price", ("paid", "list", "normalized"))),
            ("scope", "generic", lambda p: p.choice("scope", ("generic", "category"))),
            ("date_from", "2026-06-02", lambda p: p.date_range()),
            ("date_to", "2026-06-02", lambda p: p.date_range()),
            ("page", "1", lambda p: p.page()),
            ("page_size", "50", lambda p: p.page()),
        )
        for name, valid, parse in cases:
            for control in CONTROLS:
                for value in insert_control(valid, control):
                    with self.subTest(name=name, value=repr(value)):
                        params = Params({name: value})
                        parse(params)
                        self.assert_control_error(params, name)

    def test_conversion_rejects_controls_without_sql(self):
        for name, valid in (("target_currency", "EUR"), ("rates", "RUB:0.0098")):
            for control in CONTROLS:
                for value in insert_control(valid, control):
                    with self.subTest(name=name, value=repr(value)):
                        params = Params({name: value})
                        self.assertIsNone(parse_conversion(params))
                        self.assert_control_error(params, name)

    def test_repeated_raw_does_not_duplicate_errors(self):
        params = Params({"target_currency": "EUR\x00"})
        params.currency("target_currency")
        self.assertIsNone(params.raw("target_currency"))
        self.assert_control_error(params, "target_currency")

    def test_last_value_and_unknown_parameters_keep_their_semantics(self):
        params = Params(QueryDict("q=%00a&q=%D0%BC%D0%BE%D0%BB&unknown=%00"))
        self.assertEqual(params.search(), "мол")
        params.check()
        params = Params(QueryDict("q=ab&q=%00a"))
        self.assertIsNone(params.search())
        self.assert_control_error(params, "q")


class InvalidQueryAssertions:
    def assert_control_response(self, url, name):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 400, url)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {"error": {
            "code": "invalid_parameter", "message": "Некорректные параметры запроса.",
            "fields": {name: [CONTROL_MESSAGE]},
        }})


@tag("integration")
class EmptySearchControlTests(InvalidQueryAssertions, TestCase):
    """Списки отвергают опасный поиск даже на пустой БД, без SQL."""

    def test_nul_search_returns_400_before_sql(self):
        for url in SEARCH_URLS:
            for value in ("\x00a", "a\x00b", "ab\x00"):
                with self.subTest(url=url, value=repr(value)), self.assertNumQueries(0):
                    self.assert_control_response(url + "?" + urlencode({"q": value}), "q")

    def test_other_control_search_returns_400_before_sql(self):
        for url in SEARCH_URLS:
            for control in ("\x01", "\t", "\n", "\r", "\x1f", "\x7f", "\x85", "\x9f"):
                for value in insert_control("мол", control):
                    with self.subTest(url=url, value=repr(value)), self.assertNumQueries(0):
                        self.assert_control_response(url + "?" + urlencode({"q": value}), "q")

    def test_ordinary_search_still_succeeds(self):
        for url in SEARCH_URLS:
            with self.subTest(url=url):
                response = self.client.get(url, {"q": " мол "})
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["results"], [])


@tag("integration")
class QueryControlEndpointTests(InvalidQueryAssertions, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = save_samples()

    def test_known_parameters_reject_controls(self):
        product = self.data.shop_milk.pk
        generic = self.data.milk.pk
        dates = {"date_from": "2026-06-02", "date_to": "2026-10-01"}
        page = {"page": "1", "page_size": "50"}
        history = {**dates, "country": "RU", "currency": "RUB", "store": str(self.data.shop_store.pk)}
        comparison = {**dates, **page, "country": "DE,RU", "target_currency": "EUR", "rates": "RUB:0.0098"}
        cases = (
            ("/api/countries/", {"all": "1"}),
            ("/api/stores/", {**page, "country": "RU", "q": "мол"}),
            ("/api/brands/", {**page, "q": "мол"}),
            ("/api/categories/", {"q": "мол"}),
            ("/api/generic-products/", {**page, "category": "1", "q": "мол"}),
            ("/api/products/", {
                **page, "category": "1", "generic": str(generic), "brand": "1", "country": "RU",
                "has_prices": "1", "ordering": "name", "q": "мол",
            }),
            (f"/api/products/{product}/prices/", {**history, **page, "ordering": "observed_at"}),
            (f"/api/products/{product}/prices/summary/", {
                **history, "group_by": "country", "interval": "month", "price": "paid",
            }),
            (f"/api/products/{product}/alternatives/", {**comparison, "scope": "generic"}),
            (f"/api/generic-products/{generic}/comparison/", comparison),
        )
        for url, parameters in cases:
            for name, valid in parameters.items():
                for control in ("\x00", "\t", "\n", "\x7f", "\x85"):
                    for value in insert_control(valid, control):
                        query = {name: value}
                        if name == "rates":
                            query["target_currency"] = "EUR"
                        with self.subTest(url=url, name=name, value=repr(value)):
                            self.assert_control_response(url + "?" + urlencode(query), name)

    def test_nul_path_identifiers_are_json_404(self):
        for path in (
            "categories/{pk}/", "generic-products/{pk}/", "products/{pk}/", "products/{pk}/prices/",
            "products/{pk}/prices/summary/", "products/{pk}/alternatives/", "generic-products/{pk}/comparison/",
        ):
            for value in insert_control("1", "\x00"):
                url = "/api/" + path.format(pk=quote(value))
                with self.subTest(url=url), self.assertNumQueries(0):
                    response = self.client.get(url)
                    self.assertEqual(response.status_code, 404)
                    self.assertEqual(response.json(), {"error": {"code": "not_found", "message": "Не найдено."}})

    def test_utf8_search_still_finds_products_and_categories(self):
        expected = {
            "/api/products/": [self.data.shop_milk.pk],
            "/api/generic-products/": [self.data.milk.pk],
            "/api/categories/": [self.data.milk.category.parent_id, self.data.milk.category_id],
        }
        for url, ids in expected.items():
            with self.subTest(url=url):
                response = self.client.get(url, {"q": "мол"})
                self.assertEqual(response.status_code, 200)
                self.assertEqual([item["id"] for item in response.json()["results"]], ids)
