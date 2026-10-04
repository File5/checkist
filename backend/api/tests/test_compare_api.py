from datetime import date
from decimal import Decimal

from django.db import connection
from django.test import TestCase, tag
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from api.tests import factories
from api.tests.factories import make_product, observe
from catalog.models import Category, GenericProduct
from catalog.units import BaseUnit, Unit

D = Decimal
LITRE = ("1", Unit.L)
INVALID = {"code": "invalid_parameter", "message": "Некорректные параметры запроса."}
NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}
RATES = {"target_currency": "EUR", "rates": "RUB:0.0098,KZT:0.0018"}


def alternatives_url(product):
    return f"/api/products/{getattr(product, 'pk', product)}/alternatives/"


def comparison_url(generic):
    return f"/api/generic-products/{getattr(generic, 'pk', generic)}/comparison/"


def save_milk():
    """Образцы и ещё два товара «Молоко»: три страны, три валюты.

    ``shop_milk`` — RU, RUB, 130,5882 за литр; ``lidl_milk`` — DE, EUR, без фасовки;
    ``bio`` — DE, EUR, 1,29 и 1,39 за литр; ``kz_milk`` — KZ, KZT, 520 за литр.
    """
    data = factories.save_samples()
    data.bio = make_product(data.milk, "Bio Milch 1 l", package=LITRE)
    observe(data.bio, data.lidl_store, "EUR", date(2026, 7, 5), "1.29")
    observe(data.bio, data.lidl_store, "EUR", date(2026, 8, 5), "1.39")
    data.kz_milk = make_product(data.milk, "Сүт 1 л", package=LITRE)
    observe(data.kz_milk, data.dns_store, "KZT", date(2026, 8, 1), "520.00")
    return data


class CompareTestCase(TestCase):
    client_class = APIClient

    def get(self, url, **query):
        response = self.client.get(url, query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def assertInvalid(self, url, query, fields):
        response = self.client.get(url, query)
        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(response.json(), {"error": {**INVALID, "fields": fields}})

    @staticmethod
    def by_id(body):
        return {result["product"]["id"]: result for result in body["results"]}

    @staticmethod
    def ids(body):
        return [result["product"]["id"] for result in body["results"]]

    def offer(self, body, product, country=None, currency=None):
        """Единственное предложение товара либо предложение пары «страна, валюта»."""
        offers = [
            offer for offer in self.by_id(body)[product.pk]["offers"]
            if country in (None, offer["country"]) and currency in (None, offer["currency"])
        ]
        self.assertEqual(len(offers), 1, offers)
        return offers[0]


@tag("integration")
class ComparisonBodyTests(CompareTestCase):
    """Точное тело ответа на образцах: три страны, три валюты."""

    maxDiff = None

    @classmethod
    def setUpTestData(cls):
        cls.data = data = save_milk()
        cls.shop = {"id": data.shop_store.pk, "name": "Магазин «Елена»", "city": "Кемерово", "country": "RU"}
        cls.lidl = {"id": data.lidl_store.pk, "name": "Lidl", "city": "Lindau", "country": "DE"}
        cls.dns = {"id": data.dns_store.pk, "name": "DNS", "city": "Алматы", "country": "KZ"}

    def products(self, base=None):
        data = self.data
        return {
            "shop_milk": {
                "id": data.shop_milk.pk, "name": "Молоко Фермерское 2,5% 850мл пэт", "brand": None,
                "package": {"quantity": "850.000", "unit": "ml"}, "is_base": base == data.shop_milk,
            },
            "bio": {
                "id": data.bio.pk, "name": "Bio Milch 1 l", "brand": None,
                "package": {"quantity": "1.000", "unit": "l"}, "is_base": base == data.bio,
            },
            "kz_milk": {
                "id": data.kz_milk.pk, "name": "Сүт 1 л", "brand": None,
                "package": {"quantity": "1.000", "unit": "l"}, "is_base": base == data.kz_milk,
            },
            "lidl_milk": {
                "id": data.lidl_milk.pk, "name": "GQ EgSB H-Milch 1,5%", "brand": None,
                "package": None, "is_base": base == data.lidl_milk,
            },
        }

    def groups(self):
        return [
            {"country": "DE", "currency": "EUR", "products_with_price": 1,
             "min": "1.3900", "max": "1.3900", "avg": "1.3900"},
            {"country": "KZ", "currency": "KZT", "products_with_price": 1,
             "min": "520.0000", "max": "520.0000", "avg": "520.0000"},
            {"country": "RU", "currency": "RUB", "products_with_price": 1,
             "min": "130.5882", "max": "130.5882", "avg": "130.5882"},
        ]

    def offers(self):
        """Предложения без пересчёта и без исходного товара."""
        return {
            "shop_milk": {
                "country": "RU", "currency": "RUB", "observations": 1,
                "last": {"normalized_price": "130.5882", "paid_unit_price": "111.0000",
                         "purchased_on": "2026-09-28", "store": self.shop},
                "min": "130.5882", "max": "130.5882", "avg": "130.5882",
                "rank_in_group": 1, "diff_to_base_percent": None, "converted": None,
            },
            "bio": {
                "country": "DE", "currency": "EUR", "observations": 2,
                "last": {"normalized_price": "1.3900", "paid_unit_price": "1.3900",
                         "purchased_on": "2026-08-05", "store": self.lidl},
                "min": "1.2900", "max": "1.3900", "avg": "1.3400",
                "rank_in_group": 1, "diff_to_base_percent": None, "converted": None,
            },
            "kz_milk": {
                "country": "KZ", "currency": "KZT", "observations": 1,
                "last": {"normalized_price": "520.0000", "paid_unit_price": "520.0000",
                         "purchased_on": "2026-08-01", "store": self.dns},
                "min": "520.0000", "max": "520.0000", "avg": "520.0000",
                "rank_in_group": 1, "diff_to_base_percent": None, "converted": None,
            },
            "lidl_milk": {
                "country": "DE", "currency": "EUR", "observations": 6,
                "last": {"normalized_price": None, "paid_unit_price": "1.0900",
                         "purchased_on": "2026-10-01", "store": self.lidl},
                "min": None, "max": None, "avg": None,
                "rank_in_group": None, "diff_to_base_percent": None, "converted": None,
                "not_comparable_reason": "no_package",
            },
        }

    def test_alternatives_body(self):
        products, offers = self.products(base=self.data.shop_milk), self.offers()
        offers["shop_milk"]["diff_to_base_percent"] = "0.00"
        self.assertEqual(self.get(alternatives_url(self.data.shop_milk)), {
            "base": {"id": self.data.shop_milk.pk, "name": "Молоко Фермерское 2,5% 850мл пэт"},
            "generic": {"id": self.data.milk.pk, "name": "Молоко", "base_unit": "l"},
            "unit": "l",
            "conversion": None,
            "groups": self.groups(),
            "count": 4, "page": 1, "page_size": 50, "pages": 1,
            "results": [
                {"product": products[name], "offers": [offers[name]]}
                for name in ("shop_milk", "bio", "kz_milk", "lidl_milk")
            ],
        })

    def test_comparison_body(self):
        products, offers = self.products(), self.offers()
        self.assertEqual(self.get(comparison_url(self.data.milk)), {
            "base": None,
            "generic": {"id": self.data.milk.pk, "name": "Молоко", "base_unit": "l"},
            "unit": "l",
            "conversion": None,
            "groups": self.groups(),
            "count": 4, "page": 1, "page_size": 50, "pages": 1,
            "results": [
                {"product": products[name], "offers": [offers[name]]}
                for name in ("bio", "shop_milk", "kz_milk", "lidl_milk")
            ],
        })

    def test_alternatives_body_with_rates(self):
        products, offers = self.products(base=self.data.shop_milk), self.offers()
        # 130.5882 * 0.0098 = 1.27976436; 520 * 0.0018 = 0.936; EUR — целевая, курс 1.
        offers["shop_milk"].update(
            diff_to_base_percent="0.00", rank_overall=2,
            converted={"currency": "EUR", "last": "1.2798", "min": "1.2798", "max": "1.2798", "avg": "1.2798"},
        )
        # (1.39 - 1.27976436) / 1.27976436 = 8.6137…%
        offers["bio"].update(
            diff_to_base_percent="8.61", rank_overall=3,
            converted={"currency": "EUR", "last": "1.3900", "min": "1.2900", "max": "1.3900", "avg": "1.3400"},
        )
        # (0.936 - 1.27976436) / 1.27976436 = -26.8615…%
        offers["kz_milk"].update(
            diff_to_base_percent="-26.86", rank_overall=1,
            converted={"currency": "EUR", "last": "0.9360", "min": "0.9360", "max": "0.9360", "avg": "0.9360"},
        )
        offers["lidl_milk"]["rank_overall"] = None
        body = self.get(alternatives_url(self.data.shop_milk), **RATES)
        self.assertEqual(body, {
            "base": {"id": self.data.shop_milk.pk, "name": "Молоко Фермерское 2,5% 850мл пэт"},
            "generic": {"id": self.data.milk.pk, "name": "Молоко", "base_unit": "l"},
            "unit": "l",
            "conversion": {
                "target_currency": "EUR", "rates": {"RUB": "0.0098", "KZT": "0.0018"}, "source": "request",
            },
            "overall": {"currency": "EUR", "offers_with_price": 3, "min": "0.9360"},
            "groups": self.groups(),
            "count": 4, "page": 1, "page_size": 50, "pages": 1,
            "results": [
                {"product": products[name], "offers": [offers[name]]}
                for name in ("shop_milk", "bio", "kz_milk", "lidl_milk")
            ],
        })
        # not_comparable_reason — последним ключом, как в контракте.
        self.assertEqual(list(body["results"][3]["offers"][0])[-2:], ["rank_overall", "not_comparable_reason"])

    def test_comparison_with_rates_has_no_diff(self):
        body = self.get(comparison_url(self.data.milk), **RATES)
        self.assertEqual(body["overall"], {"currency": "EUR", "offers_with_price": 3, "min": "0.9360"})
        for result in body["results"]:
            for offer in result["offers"]:
                self.assertIsNone(offer["diff_to_base_percent"])
        self.assertEqual(self.offer(body, self.data.kz_milk)["rank_overall"], 1)

    def test_currency_without_rate_is_not_converted(self):
        body = self.get(alternatives_url(self.data.shop_milk), target_currency="EUR", rates="RUB:0.0098")
        self.assertEqual(
            body["conversion"], {"target_currency": "EUR", "rates": {"RUB": "0.0098"}, "source": "request"},
        )
        self.assertEqual(body["overall"], {"currency": "EUR", "offers_with_price": 2, "min": "1.2798"})
        kz = self.offer(body, self.data.kz_milk)
        self.assertIsNone(kz["converted"])
        self.assertIsNone(kz["rank_overall"])
        self.assertIsNone(kz["diff_to_base_percent"])
        self.assertEqual(kz["rank_in_group"], 1)
        self.assertEqual(self.offer(body, self.data.shop_milk)["rank_overall"], 1)
        self.assertEqual(self.offer(body, self.data.bio)["rank_overall"], 2)

    def test_target_currency_without_rates(self):
        body = self.get(alternatives_url(self.data.shop_milk), target_currency="eur")
        self.assertEqual(body["conversion"], {"target_currency": "EUR", "rates": {}, "source": "request"})
        self.assertEqual(body["overall"], {"currency": "EUR", "offers_with_price": 1, "min": "1.3900"})
        self.assertEqual(
            self.offer(body, self.data.bio)["converted"],
            {"currency": "EUR", "last": "1.3900", "min": "1.2900", "max": "1.3900", "avg": "1.3400"},
        )
        self.assertEqual(self.offer(body, self.data.bio)["rank_overall"], 1)
        # Исходный товар в рублях без курса: отклонение между валютами не считается.
        self.assertIsNone(self.offer(body, self.data.bio)["diff_to_base_percent"])
        self.assertIsNone(self.offer(body, self.data.shop_milk)["converted"])

    def test_overall_is_empty_when_nothing_is_converted(self):
        body = self.get(alternatives_url(self.data.shop_milk), target_currency="RUB", country="DE")
        self.assertEqual(body["overall"], {"currency": "RUB", "offers_with_price": 0, "min": None})

    def test_without_rates_there_is_no_overall(self):
        body = self.get(alternatives_url(self.data.shop_milk))
        self.assertNotIn("overall", body)
        self.assertNotIn("rank_overall", body["results"][0]["offers"][0])

    def test_base_in_another_currency(self):
        body = self.get(alternatives_url(self.data.bio))
        self.assertEqual(self.ids(body), [
            self.data.bio.pk, self.data.shop_milk.pk, self.data.kz_milk.pk, self.data.lidl_milk.pk,
        ])
        self.assertEqual(self.offer(body, self.data.bio)["diff_to_base_percent"], "0.00")
        self.assertIsNone(self.offer(body, self.data.shop_milk)["diff_to_base_percent"])
        # Та же валюта, но цены за литр нет: сравнивать нечего.
        self.assertIsNone(self.offer(body, self.data.lidl_milk)["diff_to_base_percent"])

    def test_not_comparable_base_stays_first(self):
        body = self.get(alternatives_url(self.data.lidl_milk))
        self.assertEqual(self.ids(body), [
            self.data.lidl_milk.pk, self.data.bio.pk, self.data.shop_milk.pk, self.data.kz_milk.pk,
        ])
        self.assertTrue(body["results"][0]["product"]["is_base"])
        for result in body["results"]:
            for offer in result["offers"]:
                self.assertIsNone(offer["diff_to_base_percent"])

    # --- страна и окно дат ---

    def test_country_filter(self):
        body = self.get(alternatives_url(self.data.shop_milk), country="de")
        self.assertEqual(body["groups"], self.groups()[:1])
        self.assertEqual(body["count"], 4)
        # Исходный товар, сравнимый, затем товары без сравнимых цен по name, id.
        self.assertEqual(self.ids(body), [
            self.data.shop_milk.pk, self.data.bio.pk, self.data.lidl_milk.pk, self.data.kz_milk.pk,
        ])
        results = self.by_id(body)
        self.assertEqual(results[self.data.shop_milk.pk]["offers"], [])
        self.assertEqual(results[self.data.shop_milk.pk]["not_comparable_reason"], "no_observations")
        self.assertEqual(results[self.data.kz_milk.pk]["offers"], [])
        self.assertEqual(results[self.data.bio.pk]["offers"], [self.offers()["bio"]])
        self.assertEqual(results[self.data.lidl_milk.pk]["offers"], [self.offers()["lidl_milk"]])

    def test_country_list(self):
        body = self.get(comparison_url(self.data.milk), country="RU, kz")
        self.assertEqual(body["groups"], self.groups()[1:])
        self.assertEqual(self.ids(body), [
            self.data.shop_milk.pk, self.data.kz_milk.pk, self.data.bio.pk, self.data.lidl_milk.pk,
        ])
        self.assertEqual(self.offer(body, self.data.shop_milk), self.offers()["shop_milk"])
        self.assertEqual(self.by_id(body)[self.data.bio.pk]["offers"], [])

    def test_date_window(self):
        body = self.get(comparison_url(self.data.milk), date_from="2026-07-01", date_to="2026-07-31")
        self.assertEqual(body["groups"], [
            {"country": "DE", "currency": "EUR", "products_with_price": 1,
             "min": "1.2900", "max": "1.2900", "avg": "1.2900"},
        ])
        self.assertEqual(self.offer(body, self.data.bio), {
            "country": "DE", "currency": "EUR", "observations": 1,
            "last": {"normalized_price": "1.2900", "paid_unit_price": "1.2900",
                     "purchased_on": "2026-07-05", "store": self.lidl},
            "min": "1.2900", "max": "1.2900", "avg": "1.2900",
            "rank_in_group": 1, "diff_to_base_percent": None, "converted": None,
        })
        lidl_milk = self.offer(body, self.data.lidl_milk)
        self.assertEqual(lidl_milk["observations"], 1)
        self.assertEqual(lidl_milk["last"]["purchased_on"], "2026-07-06")
        self.assertEqual(lidl_milk["last"]["paid_unit_price"], "1.0500")
        # Товар без наблюдений в окне остаётся в ответе.
        self.assertEqual(self.by_id(body)[self.data.shop_milk.pk], {
            "product": self.products()["shop_milk"], "offers": [], "not_comparable_reason": "no_observations",
        })

    def test_date_bounds_are_inclusive(self):
        for query, observations in (
            ({"date_from": "2026-08-05"}, 1), ({"date_to": "2026-07-05"}, 1),
            ({"date_from": "2026-07-05", "date_to": "2026-08-05"}, 2),
        ):
            with self.subTest(query=query):
                body = self.get(comparison_url(self.data.milk), **query)
                self.assertEqual(self.offer(body, self.data.bio)["observations"], observations)

    def test_window_without_observations(self):
        body = self.get(alternatives_url(self.data.shop_milk), date_to="2020-01-01")
        self.assertEqual(body["groups"], [])
        self.assertEqual(body["count"], 4)
        self.assertEqual(self.ids(body)[0], self.data.shop_milk.pk)
        for result in body["results"]:
            self.assertEqual(result["offers"], [])
            self.assertEqual(result["not_comparable_reason"], "no_observations")

    # --- ошибки параметров ---

    def test_invalid_filters(self):
        url = alternatives_url(self.data.shop_milk)
        cases = [
            ({"country": "XX"}, {"country": ["Неизвестный код страны."]}),
            ({"country": "RUS"}, {"country": ["Ожидаются коды стран из двух букв через запятую."]}),
            ({"date_from": "01.07.2026"}, {"date_from": ["Ожидается дата ГГГГ-ММ-ДД."]}),
            ({"date_from": "2026-08-01", "date_to": "2026-07-01"}, {"date_from": ["Должна быть не позже date_to."]}),
            ({"scope": "brand"}, {"scope": ["Допустимые значения: generic, category."]}),
            ({"scope": "brand", "page": "0"}, {
                "scope": ["Допустимые значения: generic, category."], "page": ["Ожидается целое число от 1."],
            }),
        ]
        for query, fields in cases:
            with self.subTest(query=query):
                self.assertInvalid(url, query, fields)

    def test_invalid_rates(self):
        pairs = "Ожидаются пары «код валюты:курс» через запятую, например RUB:0.0098."
        eleven = ",".join(f"A{letter}A:1" for letter in "ABCDEFGHIJK")
        cases = [
            ("RUB:0", "Курс должен быть больше нуля."),
            ("RUB:0.0000", "Курс должен быть больше нуля."),
            ("RUB:-0.0098", pairs),
            ("RUB:abc", pairs),
            ("мусор", pairs),
            ("RUB:1e-2", pairs),
            ("RUB:NaN", pairs),
            ("RUB", pairs),
            (eleven, "Не больше 10 курсов."),
            ("USD:0.9", "Неизвестный код валюты."),
            ("RUB:0.0098,XXX:1", "Неизвестный код валюты."),
            ("RUB:0.0098,RUB:0.01", "Валюта указана больше одного раза."),
            ("EUR:1", "Курс целевой валюты не задаётся: он равен 1."),
        ]
        for url in (alternatives_url(self.data.shop_milk), comparison_url(self.data.milk)):
            for rates, message in cases:
                with self.subTest(url=url, rates=rates):
                    self.assertInvalid(url, {"target_currency": "EUR", "rates": rates}, {"rates": [message]})

    def test_rates_require_target_currency(self):
        self.assertInvalid(
            alternatives_url(self.data.shop_milk), {"rates": "RUB:0.0098"},
            {"target_currency": ["Обязателен вместе с rates."]},
        )

    def test_invalid_target_currency(self):
        url = comparison_url(self.data.milk)
        self.assertInvalid(url, {"target_currency": "USD"}, {"target_currency": ["Неизвестный код валюты."]})
        self.assertInvalid(
            url, {"target_currency": "euro", "rates": "RUB:0.0098"},
            {"target_currency": ["Ожидается код валюты из трёх букв."]},
        )

    def test_unknown_parameters_are_ignored(self):
        self.assertEqual(
            self.get(alternatives_url(self.data.shop_milk), unknown="1", ordering="price"),
            self.get(alternatives_url(self.data.shop_milk)),
        )
        # scope — параметр только /alternatives/: у сравнения он неизвестен.
        self.assertEqual(
            self.get(comparison_url(self.data.milk), scope="brand"), self.get(comparison_url(self.data.milk)),
        )

    # --- пагинация ---

    def test_pages(self):
        url = alternatives_url(self.data.shop_milk)
        first = self.get(url, page_size="3")
        self.assertEqual({key: first[key] for key in ("count", "page", "page_size", "pages")},
                         {"count": 4, "page": 1, "page_size": 3, "pages": 2})
        self.assertEqual(self.ids(first), [self.data.shop_milk.pk, self.data.bio.pk, self.data.kz_milk.pk])
        second = self.get(url, page_size="3", page="2")
        self.assertEqual(self.ids(second), [self.data.lidl_milk.pk])
        self.assertEqual(second["page"], 2)
        # Сводка и места считаются по всему набору, а не по странице.
        self.assertEqual(second["groups"], self.groups())
        self.assertEqual(second["base"], first["base"])

    def test_page_size_limits(self):
        url = comparison_url(self.data.milk)
        for value in ("0", "101", "abc", "-1"):
            with self.subTest(page_size=value):
                self.assertInvalid(url, {"page_size": value}, {"page_size": ["Допустимо от 1 до 100."]})
        self.assertEqual(self.get(url, page_size="100")["page_size"], 100)
        self.assertEqual(self.get(url, page_size="1")["pages"], 4)

    def test_page_out_of_range(self):
        for url in (alternatives_url(self.data.shop_milk), comparison_url(self.data.milk)):
            with self.subTest(url=url):
                response = self.client.get(url, {"page": "2"})
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {
                    "error": {"code": "page_out_of_range", "message": "Страница за пределами диапазона."},
                })

    # --- доступ и объекты ---

    def test_not_found(self):
        for url in (
            alternatives_url(999_999), comparison_url(999_999), alternatives_url(0),
            alternatives_url(10**30), comparison_url(10**30),
        ):
            with self.subTest(url=url):
                response = self.client.get(url)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), NOT_FOUND)

    def test_not_found_precedes_parameter_errors(self):
        response = self.client.get(alternatives_url(999_999), {"page_size": "0"})
        self.assertEqual(response.status_code, 404)

    def test_anonymous_get(self):
        for url in (alternatives_url(self.data.shop_milk), comparison_url(self.data.milk)):
            with self.subTest(url=url):
                response = APIClient().get(url)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response["Content-Type"], "application/json")

    def test_write_methods_are_not_allowed(self):
        for url in (alternatives_url(self.data.shop_milk), comparison_url(self.data.milk)):
            for method in ("post", "put", "patch", "delete"):
                with self.subTest(url=url, method=method):
                    response = getattr(self.client, method)(url, {}, format="json")
                    self.assertEqual(response.status_code, 405)
                    self.assertEqual(response.json(), {
                        "error": {"code": "method_not_allowed", "message": "Метод не поддерживается."},
                    })

    def test_private_fields_are_not_exposed(self):
        content = self.client.get(alternatives_url(self.data.shop_milk)).content.decode()
        for name in ("raw_text", "fiscal", "legal_name", "tax_id", "receipt_number", "shift_number", "register_code"):
            self.assertNotIn(name, content)
        self.assertNotIn(self.data.shop_store.merchant.legal_name, content)
        self.assertNotIn(self.data.shop_store.merchant.tax_id, content)


@tag("integration")
class ScopeTests(CompareTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = data = save_milk()
        dairy = data.milk.category
        kefir = GenericProduct.objects.create(name="Кефир", category=dairy, base_unit=BaseUnit.L)
        cheese = GenericProduct.objects.create(name="Сыр", category=dairy, base_unit=BaseUnit.KG)
        # Потомок категории и чужая категория в scope=category не входят.
        child = Category.objects.create(name="Йогурты", parent=dairy)
        yogurt = GenericProduct.objects.create(name="Йогурт", category=child, base_unit=BaseUnit.L)
        cls.kefir = make_product(kefir, "Кефир 1 л", package=LITRE)
        cls.cheese = make_product(cheese, "Сыр 200 г", package=("200", Unit.G))
        cls.yogurt = make_product(yogurt, "Йогурт 1 л", package=LITRE)
        observe(cls.kefir, data.shop_store, "RUB", date(2026, 9, 1), "90.00")
        observe(cls.cheese, data.shop_store, "RUB", date(2026, 9, 2), "150.00")
        observe(cls.yogurt, data.shop_store, "RUB", date(2026, 9, 3), "80.00")

    def test_generic_scope_is_default(self):
        default = self.get(alternatives_url(self.data.shop_milk))
        self.assertEqual(default, self.get(alternatives_url(self.data.shop_milk), scope="generic"))
        self.assertEqual(self.ids(default), [
            self.data.shop_milk.pk, self.data.bio.pk, self.data.kz_milk.pk, self.data.lidl_milk.pk,
        ])
        self.assertEqual(self.offer(default, self.data.shop_milk)["rank_in_group"], 1)

    def test_category_scope(self):
        body = self.get(alternatives_url(self.data.shop_milk), scope="category")
        self.assertEqual(body["generic"], {"id": self.data.milk.pk, "name": "Молоко", "base_unit": "l"})
        self.assertEqual(body["unit"], "l")
        self.assertEqual(body["count"], 6)
        # Исходный; сравнимые по name, id; несравнимые по name, id.
        self.assertEqual(self.ids(body), [
            self.data.shop_milk.pk, self.data.bio.pk, self.kefir.pk, self.data.kz_milk.pk,
            self.data.lidl_milk.pk, self.cheese.pk,
        ])
        kefir = self.offer(body, self.kefir)
        self.assertEqual(kefir["rank_in_group"], 1)
        self.assertEqual(kefir["last"]["normalized_price"], "90.0000")
        self.assertEqual(kefir["diff_to_base_percent"], "-31.08")  # (90 - 130.5882) / 130.5882
        self.assertNotIn("not_comparable_reason", kefir)
        self.assertEqual(self.offer(body, self.data.shop_milk)["rank_in_group"], 2)

    def test_category_scope_compares_only_same_base_unit(self):
        body = self.get(alternatives_url(self.data.shop_milk), scope="category")
        # Цена сыра — за килограмм: с литрами не сравнивается и в сводку не входит.
        self.assertEqual(self.offer(body, self.cheese), {
            "country": "RU", "currency": "RUB", "observations": 1,
            "last": {
                "normalized_price": None, "paid_unit_price": "150.0000", "purchased_on": "2026-09-02",
                "store": {
                    "id": self.data.shop_store.pk, "name": "Магазин «Елена»", "city": "Кемерово", "country": "RU",
                },
            },
            "min": None, "max": None, "avg": None,
            "rank_in_group": None, "diff_to_base_percent": None, "converted": None,
            "not_comparable_reason": "unit_mismatch",
        })
        self.assertIn(
            {"country": "RU", "currency": "RUB", "products_with_price": 2,
             "min": "90.0000", "max": "130.5882", "avg": "110.2941"},
            body["groups"],
        )

    def test_category_scope_from_another_unit(self):
        body = self.get(alternatives_url(self.cheese), scope="category", target_currency="RUB")
        self.assertEqual(body["unit"], "kg")
        self.assertEqual(body["generic"]["name"], "Сыр")
        self.assertEqual(self.ids(body)[0], self.cheese.pk)
        cheese = self.offer(body, self.cheese)
        self.assertEqual(cheese["last"]["normalized_price"], "750.0000")
        self.assertEqual((cheese["rank_in_group"], cheese["rank_overall"]), (1, 1))
        self.assertEqual(body["overall"], {"currency": "RUB", "offers_with_price": 1, "min": "750.0000"})
        for product in (self.data.shop_milk, self.kefir, self.data.bio):
            offer = self.offer(body, product)
            self.assertEqual(offer["not_comparable_reason"], "unit_mismatch")
            self.assertIsNone(offer["converted"])
            self.assertIsNone(offer["rank_overall"])
        # Без фасовки цены за единицу нет вовсе — причина та же, что и при совпадении единиц.
        self.assertEqual(self.offer(body, self.data.lidl_milk)["not_comparable_reason"], "no_package")

    def test_comparison_ignores_scope(self):
        body = self.get(comparison_url(self.data.milk), scope="category")
        self.assertEqual(body["count"], 4)


@tag("integration")
class RankAndReasonTests(CompareTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = data = factories.save_samples()
        cls.generic = GenericProduct.objects.create(name="Сок", category=data.milk.category, base_unit=BaseUnit.L)

    def juice(self, name, price=None, *, store=None, currency="EUR", on=date(2026, 7, 1), package=LITRE, **fields):
        product = make_product(self.generic, name, package=package)
        if price is not None:
            observe(product, store or self.data.lidl_store, currency, on, price, **fields)
        return product

    def test_equal_prices_share_rank(self):
        a, b, c, d = (
            self.juice(name, price) for name, price in (("A", "1.00"), ("B", "1.00"), ("C", "1.50"), ("D", "0.90"))
        )
        other = self.juice("E", "50.00", store=self.data.shop_store, currency="RUB")
        body = self.get(comparison_url(self.generic))
        ranks = {pk: result["offers"][0]["rank_in_group"] for pk, result in self.by_id(body).items()}
        self.assertEqual(ranks, {d.pk: 1, a.pk: 2, b.pk: 2, c.pk: 4, other.pk: 1})
        self.assertEqual(body["groups"], [
            {"country": "DE", "currency": "EUR", "products_with_price": 4,
             "min": "0.9000", "max": "1.5000", "avg": "1.1000"},
            {"country": "RU", "currency": "RUB", "products_with_price": 1,
             "min": "50.0000", "max": "50.0000", "avg": "50.0000"},
        ])

    def test_rank_uses_last_price_within_window(self):
        a, b = self.juice("A", "1.00"), self.juice("B", "1.20")
        observe(a, self.data.lidl_store, "EUR", date(2026, 8, 1), "1.40")
        body = self.get(comparison_url(self.generic))
        self.assertEqual(self.offer(body, a)["rank_in_group"], 2)
        self.assertEqual(self.offer(body, b)["rank_in_group"], 1)
        body = self.get(comparison_url(self.generic), date_to="2026-07-31")
        self.assertEqual(self.offer(body, a)["rank_in_group"], 1)
        self.assertEqual(self.offer(body, b)["rank_in_group"], 2)

    def test_overall_rank_with_equal_converted_prices(self):
        a = self.juice("A", "2.00")
        b = self.juice("B", "200.00", store=self.data.shop_store, currency="RUB")
        c = self.juice("C", "3.00")
        body = self.get(alternatives_url(a), target_currency="EUR", rates="RUB:0.01")
        self.assertEqual(self.offer(body, a)["rank_overall"], 1)
        self.assertEqual(self.offer(body, b)["rank_overall"], 1)
        self.assertEqual(self.offer(body, c)["rank_overall"], 3)
        self.assertEqual(self.offer(body, b)["diff_to_base_percent"], "0.00")
        self.assertEqual(self.offer(body, c)["diff_to_base_percent"], "50.00")
        self.assertEqual(body["overall"], {"currency": "EUR", "offers_with_price": 3, "min": "2.0000"})

    def test_reasons(self):
        no_package = self.juice("Без фасовки", "0.89", package=None)
        grams = self.juice("Сухой сок 500 г", "1.50", package=("500", Unit.G))
        metres = self.juice("Сок на метры", "1.10", package=None, unit=Unit.M, quantity="2")
        empty = self.juice("Не покупали")
        fine = self.juice("Обычный", "1.00")
        body = self.get(comparison_url(self.generic))
        self.assertEqual(self.ids(body), [fine.pk, no_package.pk, empty.pk, metres.pk, grams.pk])
        self.assertEqual(self.offer(body, no_package)["not_comparable_reason"], "no_package")
        self.assertEqual(self.offer(body, grams)["not_comparable_reason"], "unit_mismatch")
        self.assertEqual(self.offer(body, metres)["not_comparable_reason"], "unit_mismatch")
        self.assertNotIn("not_comparable_reason", self.offer(body, fine))
        self.assertNotIn("not_comparable_reason", self.by_id(body)[fine.pk])
        self.assertEqual(self.by_id(body)[empty.pk], {
            "product": {"id": empty.pk, "name": "Не покупали", "brand": None,
                        "package": {"quantity": "1.000", "unit": "l"}, "is_base": False},
            "offers": [], "not_comparable_reason": "no_observations",
        })
        for product in (no_package, grams, metres):
            offer = self.offer(body, product)
            self.assertEqual(
                [offer[key] for key in ("min", "max", "avg", "rank_in_group", "diff_to_base_percent", "converted")],
                [None] * 6,
            )
            self.assertIsNone(offer["last"]["normalized_price"])
        self.assertEqual(self.offer(body, grams)["last"]["paid_unit_price"], "1.5000")

    def test_factory_cases_of_milk(self):
        mismatch = factories.unit_mismatch(self.data).product
        piece = factories.piece_without_package(self.data).product
        body = self.get(alternatives_url(self.data.shop_milk))
        self.assertEqual(self.offer(body, mismatch)["not_comparable_reason"], "unit_mismatch")
        self.assertEqual(self.offer(body, piece)["not_comparable_reason"], "no_package")
        self.assertEqual(self.offer(body, self.data.lidl_milk)["not_comparable_reason"], "no_package")

    def test_mixed_observations_use_last_comparable(self):
        # Штучные продажи литровой упаковки и одна продажа на вес: цена за кг с литрами несравнима.
        product = self.juice("Смешанный", "1.00")
        observe(product, self.data.lidl_store, "EUR", date(2026, 8, 1), "5.00", unit=Unit.KG)
        offer = self.offer(self.get(comparison_url(self.generic)), product)
        self.assertEqual(offer["observations"], 2)
        self.assertEqual((offer["min"], offer["max"], offer["avg"]), ("1.0000", "1.0000", "1.0000"))
        self.assertEqual(offer["last"]["normalized_price"], "1.0000")
        self.assertEqual(offer["last"]["purchased_on"], "2026-07-01")
        self.assertEqual(offer["rank_in_group"], 1)
        self.assertNotIn("not_comparable_reason", offer)

    def test_two_currencies_of_one_product(self):
        factories.second_currency(self.data)  # shop_milk: RU, EUR, 1.4118 за литр
        bio = make_product(self.data.milk, "Bio Milch 1 l", package=LITRE)
        observe(bio, self.data.lidl_store, "EUR", date(2026, 8, 5), "1.39")
        body = self.get(alternatives_url(self.data.shop_milk))
        offers = self.by_id(body)[self.data.shop_milk.pk]["offers"]
        self.assertEqual([(offer["country"], offer["currency"]) for offer in offers], [("RU", "EUR"), ("RU", "RUB")])
        self.assertEqual([offer["diff_to_base_percent"] for offer in offers], ["0.00", "0.00"])
        self.assertEqual(offers[0]["last"]["normalized_price"], "1.4118")
        # Валюта совпала с одной из валют исходного товара: (1.39 - 1.4118) / 1.4118.
        self.assertEqual(self.offer(body, bio)["diff_to_base_percent"], "-1.54")
        # Страны разные — группы разные, цены двух валют не смешаны.
        self.assertEqual(body["groups"], [
            {"country": "DE", "currency": "EUR", "products_with_price": 1,
             "min": "1.3900", "max": "1.3900", "avg": "1.3900"},
            {"country": "RU", "currency": "EUR", "products_with_price": 1,
             "min": "1.4118", "max": "1.4118", "avg": "1.4118"},
            {"country": "RU", "currency": "RUB", "products_with_price": 1,
             "min": "130.5882", "max": "130.5882", "avg": "130.5882"},
        ])

    def test_base_reference_is_latest_price_in_currency(self):
        base = self.juice("База", "2.00", on=date(2026, 7, 1))
        observe(base, self.data.shop_store, "EUR", date(2026, 8, 1), "4.00")  # та же валюта, другая страна, позже
        other = self.juice("Другой", "3.00")
        body = self.get(alternatives_url(base))
        self.assertEqual(self.offer(body, other)["diff_to_base_percent"], "-25.00")
        self.assertEqual(self.offer(body, base, "DE")["diff_to_base_percent"], "-50.00")
        self.assertEqual(self.offer(body, base, "RU")["diff_to_base_percent"], "0.00")

    def test_percent_rounds_half_up(self):
        base = self.juice("База", "2.00")
        # 100 упаковок по 2.0101: (2.0101 - 2) / 2 = 0.505 % — половина округляется вверх.
        up = self.juice("Чуть дороже", "2.0101", quantity="100")
        down = self.juice("Чуть дешевле", "1.9899", quantity="100")
        body = self.get(alternatives_url(base))
        self.assertEqual(self.offer(body, up)["last"]["normalized_price"], "2.0101")
        self.assertEqual(self.offer(body, up)["diff_to_base_percent"], "0.51")
        self.assertEqual(self.offer(body, down)["diff_to_base_percent"], "-0.51")

    def test_zero_base_price_gives_no_percent(self):
        base = self.juice("Бесплатно", "1.00", discount="1.00")
        other = self.juice("Платно", "1.00")
        body = self.get(alternatives_url(base))
        self.assertEqual(self.offer(body, base)["last"]["normalized_price"], "0.0000")
        self.assertIsNone(self.offer(body, base)["diff_to_base_percent"])
        self.assertIsNone(self.offer(body, other)["diff_to_base_percent"])
        self.assertEqual(self.offer(body, base)["rank_in_group"], 1)

    def test_brand_is_returned(self):
        ssd = self.data.ssd
        body = self.get(alternatives_url(ssd))
        self.assertEqual(body["results"][0]["product"]["brand"], {"id": ssd.brand_id, "name": "Samsung"})
        self.assertEqual(body["unit"], "pcs")
        self.assertEqual(self.offer(body, ssd)["not_comparable_reason"], "no_package")

    # --- пустые данные ---

    def test_generic_without_products(self):
        self.assertEqual(self.get(comparison_url(self.generic), **RATES), {
            "base": None,
            "generic": {"id": self.generic.pk, "name": "Сок", "base_unit": "l"},
            "unit": "l",
            "conversion": {
                "target_currency": "EUR", "rates": {"RUB": "0.0098", "KZT": "0.0018"}, "source": "request",
            },
            "overall": {"currency": "EUR", "offers_with_price": 0, "min": None},
            "groups": [],
            "count": 0, "page": 1, "page_size": 50, "pages": 0,
            "results": [],
        })

    def test_single_product_without_observations(self):
        product = self.juice("Не покупали")
        self.assertEqual(self.get(alternatives_url(product)), {
            "base": {"id": product.pk, "name": "Не покупали"},
            "generic": {"id": self.generic.pk, "name": "Сок", "base_unit": "l"},
            "unit": "l",
            "conversion": None,
            "groups": [],
            "count": 1, "page": 1, "page_size": 50, "pages": 1,
            "results": [{
                "product": {"id": product.pk, "name": "Не покупали", "brand": None,
                            "package": {"quantity": "1.000", "unit": "l"}, "is_base": True},
                "offers": [], "not_comparable_reason": "no_observations",
            }],
        })

    # --- число запросов ---

    def measure(self, url, **query):
        """Запрос не должен зависеть от числа товаров: число запросов до и после добавления двадцати."""
        with CaptureQueriesContext(connection) as before:
            self.get(url, **query)
        for number in range(10):
            self.juice(f"Сравнимый {number}", "1.10", on=date(2026, 7, 2))
            self.juice(f"Без фасовки {number}", "0.80", package=None)
        with CaptureQueriesContext(connection) as after:
            body = self.get(url, **query)
        self.assertGreaterEqual(body["count"], 23)
        self.assertEqual(len(after), len(before))
        return len(after)

    def seed(self):
        base = self.juice("База", "1.00")
        self.juice("Сравнимый", "1.20", store=self.data.shop_store, currency="RUB")
        self.juice("Несравнимый", "0.90", package=None)
        return base

    def test_alternatives_query_count(self):
        # Товар; состав набора; сводка групп; последние сравнимые цены; товары страницы;
        # последние наблюдения несравнимых предложений.
        self.assertEqual(self.measure(alternatives_url(self.seed())), 6)

    def test_comparison_query_count(self):
        self.seed()
        self.assertEqual(self.measure(comparison_url(self.generic)), 6)

    def test_query_count_with_all_parameters(self):
        # Ещё три: справочник стран, целевая валюта, валюты курсов.
        count = self.measure(
            alternatives_url(self.seed()), scope="category", country="DE,RU", date_from="2026-01-01",
            date_to="2026-12-31", page_size="100", **RATES,
        )
        self.assertEqual(count, 9)

    def test_fixed_queries(self):
        base = self.seed()
        with self.assertNumQueries(6):
            self.get(alternatives_url(base))
        with self.assertNumQueries(6):
            self.get(comparison_url(self.generic))
