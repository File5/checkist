from datetime import date
from urllib.parse import urlencode

from django.http import QueryDict
from django.test import SimpleTestCase, TestCase, tag

from api.params import Params
from config.exceptions import InvalidParameter
from receipts.tests import samples
from stores.models import Store


def parse(query, call):
    """Разобрать один параметр: ``(значение, ошибки)``."""
    params = Params(QueryDict(query))
    return call(params), params.errors


class ParamsTests(SimpleTestCase):
    def assert_value(self, query, call, expected):
        self.assertEqual(parse(query, call), (expected, {}))

    def assert_error(self, query, call, errors, value=None):
        self.assertEqual(parse(query, call), (value, errors))

    # --- целые ---

    def test_integer(self):
        for query, expected in (("id=1", 1), ("id=42", 42), ("id=%2007%20", 7), (f"id={2**63 - 1}", 2**63 - 1)):
            with self.subTest(query=query):
                self.assert_value(query, lambda params: params.integer("id"), expected)

    def test_integer_absent_or_empty_is_default(self):
        for query in ("", "id=", "id=%20", "other=5"):
            with self.subTest(query=query):
                self.assert_value(query, lambda params: params.integer("id"), None)
                self.assert_value(query, lambda params: params.integer("id", default=9), 9)

    def test_integer_invalid(self):
        for value in ("0", "-1", "abc", "1.5", "1e3", "+1", "1 2", "٣", str(2**63), "9" * 30):
            with self.subTest(value=value):
                self.assert_error(
                    urlencode({"id": value}),
                    lambda params: params.integer("id"),
                    {"id": ["Ожидается целое положительное число."]},
                )

    def test_integer_custom_range(self):
        self.assert_value("n=0", lambda params: params.integer("n", minimum=0, maximum=10), 0)
        self.assert_error(
            "n=11", lambda params: params.integer("n", minimum=0, maximum=10, message="От 0 до 10."),
            {"n": ["От 0 до 10."]},
        )

    # --- булевы ---

    def test_boolean(self):
        self.assert_value("has_prices=1", lambda params: params.boolean("has_prices"), True)
        self.assert_value("has_prices=0", lambda params: params.boolean("has_prices"), False)
        self.assert_value("", lambda params: params.boolean("has_prices"), None)
        self.assert_value("", lambda params: params.boolean("all", default=False), False)

    def test_boolean_invalid(self):
        for value in ("true", "false", "yes", "2", "-1", "01"):
            with self.subTest(value=value):
                self.assert_error(
                    f"has_prices={value}", lambda params: params.boolean("has_prices"),
                    {"has_prices": ["Ожидается 1 или 0."]},
                )

    # --- перечисления ---

    def test_choice(self):
        intervals = ("none", "day", "week", "month")
        self.assert_value("interval=week", lambda params: params.choice("interval", intervals, default="none"), "week")
        self.assert_value("", lambda params: params.choice("interval", intervals, default="none"), "none")
        self.assert_value(
            "ordering=-name", lambda params: params.choice("ordering", ("name", "-name"), default="name"), "-name",
        )

    def test_choice_invalid(self):
        for name, choices, value in (
            ("ordering", ("name", "-name"), "price"),
            ("interval", ("none", "day", "week", "month"), "year"),
            ("group_by", ("country", "store", "none"), "city"),
            ("price", ("paid", "list", "normalized"), "PAID"),
            ("scope", ("generic", "category"), "all"),
        ):
            with self.subTest(name=name):
                self.assert_error(
                    f"{name}={value}", lambda params: params.choice(name, choices, default=choices[0]),
                    {name: [f"Допустимые значения: {', '.join(choices)}."]}, value=choices[0],
                )

    # --- поиск ---

    def test_search(self):
        self.assert_value("q=ab", lambda params: params.search(), "ab")
        self.assert_value("q=%20%20молоко%20", lambda params: params.search(), "молоко")
        self.assert_value("q=" + "я" * 100, lambda params: params.search(), "я" * 100)
        self.assert_value("q=", lambda params: params.search(), None)
        self.assert_value("q=%20%20", lambda params: params.search(), None)

    def test_search_invalid_length(self):
        for value in ("a", "%20a%20", "я" * 101):
            with self.subTest(value=value):
                self.assert_error(f"q={value}", lambda params: params.search(), {"q": ["Ожидается от 2 до 100 символов."]})

    # --- даты ---

    def test_date(self):
        self.assert_value("date_from=2026-06-02", lambda params: params.date("date_from"), date(2026, 6, 2))
        self.assert_value("date_from=2024-02-29", lambda params: params.date("date_from"), date(2024, 2, 29))
        self.assert_value("", lambda params: params.date("date_from"), None)

    def test_date_invalid(self):
        for value in (
            "2026-02-30", "2026-13-01", "02.06.2026", "2026-6-2", "20260602", "2026-06-02T10:00:00",
            "2026-W23-1", "yesterday", "0000-01-01",
        ):
            with self.subTest(value=value):
                self.assert_error(
                    f"date_from={value}", lambda params: params.date("date_from"),
                    {"date_from": ["Ожидается дата ГГГГ-ММ-ДД."]},
                )

    def test_date_range(self):
        june_2, june_9 = date(2026, 6, 2), date(2026, 6, 9)
        self.assert_value("date_from=2026-06-02&date_to=2026-06-09", lambda params: params.date_range(), (june_2, june_9))
        self.assert_value("date_from=2026-06-02&date_to=2026-06-02", lambda params: params.date_range(), (june_2, june_2))
        self.assert_value("date_to=2026-06-09", lambda params: params.date_range(), (None, june_9))
        self.assert_value("", lambda params: params.date_range(), (None, None))

    def test_date_range_reversed(self):
        self.assert_error(
            "date_from=2026-06-09&date_to=2026-06-02", lambda params: params.date_range(),
            {"date_from": ["Должна быть не позже date_to."]}, value=(date(2026, 6, 9), date(2026, 6, 2)),
        )

    def test_date_range_reports_each_invalid_date(self):
        self.assert_error(
            "date_from=x&date_to=y", lambda params: params.date_range(),
            {"date_from": ["Ожидается дата ГГГГ-ММ-ДД."], "date_to": ["Ожидается дата ГГГГ-ММ-ДД."]},
            value=(None, None),
        )

    # --- коды: формат проверяется до обращения к справочнику ---

    def test_code_format_is_checked_without_database(self):
        cases = [
            ("country=DEU", lambda params: params.country(), "Ожидается код страны из двух букв.", None),
            ("country=1", lambda params: params.country(), "Ожидается код страны из двух букв.", None),
            ("country=DE,RU", lambda params: params.country(), "Ожидается код страны из двух букв.", None),
            ("currency=EU", lambda params: params.currency(), "Ожидается код валюты из трёх букв.", None),
            ("currency=€€€", lambda params: params.currency(), "Ожидается код валюты из трёх букв.", None),
            ("country=DE,,RU", lambda params: params.countries(), "Ожидаются коды стран из двух букв через запятую.", []),
            ("country=DE;RU", lambda params: params.countries(), "Ожидаются коды стран из двух букв через запятую.", []),
        ]
        for query, call, message, value in cases:
            with self.subTest(query=query):
                self.assert_error(query, call, {query.split("=")[0]: [message]}, value=value)

    def test_too_many_countries(self):
        codes = ",".join(f"A{letter}" for letter in "ABCDEFGHIJKLMNOPQRSTU")
        self.assertEqual(len(codes.split(",")), 21)
        self.assert_error(f"country={codes}", lambda params: params.countries(), {"country": ["Не больше 20 значений."]}, value=[])

    def test_absent_codes(self):
        self.assert_value("", lambda params: params.country(), None)
        self.assert_value("", lambda params: params.currency(), None)
        self.assert_value("country=", lambda params: params.countries(), [])

    # --- сбор ошибок ---

    def test_check_raises_all_errors_at_once(self):
        params = Params(QueryDict("page_size=0&date_from=x&ordering=price&q=a&has_prices=да&unknown=1"))
        params.page()
        params.date_range()
        params.choice("ordering", ("name", "-name"), default="name")
        params.search()
        params.boolean("has_prices")
        params.error("rates", "Не больше 10 курсов.")
        with self.assertRaises(InvalidParameter) as raised:
            params.check()
        self.assertEqual(raised.exception.fields, {
            "page_size": ["Допустимо от 1 до 200."],
            "date_from": ["Ожидается дата ГГГГ-ММ-ДД."],
            "ordering": ["Допустимые значения: name, -name."],
            "q": ["Ожидается от 2 до 100 символов."],
            "has_prices": ["Ожидается 1 или 0."],
            "rates": ["Не больше 10 курсов."],
        })
        self.assertEqual((raised.exception.status_code, raised.exception.code), (400, "invalid_parameter"))

    def test_check_passes_without_errors_and_ignores_unknown_parameters(self):
        params = Params(QueryDict("unknown=1&format=html&page=2"))
        self.assertEqual(params.page().page, 2)
        params.check()

    def test_messages_do_not_echo_the_value(self):
        params = Params(QueryDict("date_from=<script>&ordering=<script>&id=<script>"))
        params.date("date_from")
        params.choice("ordering", ("name",))
        params.integer("id")
        self.assertNotIn("script", str(params.errors))

    def test_last_repeated_value_wins_and_raw_strips(self):
        params = Params(QueryDict("page=1&page=3&q=%20x%20"))
        self.assertEqual(params.page().page, 3)
        self.assertEqual(params.raw("q"), "x")
        self.assertIsNone(params.raw("missing"))


@tag("integration")
class ReferenceParamsTests(TestCase):
    """Коды стран и валют — по сид-справочникам: KZ, RU, DE и KZT, RUB, EUR."""

    def test_country(self):
        with self.assertNumQueries(1):
            self.assertEqual(parse("country=DE", lambda params: params.country()), ("DE", {}))
        self.assertEqual(parse("country=de", lambda params: params.country()), ("DE", {}))

    def test_unknown_country(self):
        self.assertEqual(
            parse("country=FR", lambda params: params.country()), (None, {"country": ["Неизвестный код страны."]}),
        )

    def test_countries(self):
        with self.assertNumQueries(1):
            self.assertEqual(parse("country=RU,DE,kz", lambda params: params.countries()), (["RU", "DE", "KZ"], {}))
        self.assertEqual(parse("country=DE, RU ,DE", lambda params: params.countries()), (["DE", "RU"], {}))
        self.assertEqual(parse("country=DE", lambda params: params.countries()), (["DE"], {}))

    def test_one_unknown_country_in_list(self):
        self.assertEqual(
            parse("country=DE,FR", lambda params: params.countries()), ([], {"country": ["Неизвестный код страны."]}),
        )

    def test_absent_codes_do_not_query(self):
        with self.assertNumQueries(0):
            self.assertEqual(parse("", lambda params: params.countries()), ([], {}))
            self.assertEqual(parse("", lambda params: params.currency()), (None, {}))
            self.assertEqual(parse("country=X1", lambda params: params.country())[0], None)

    def test_currency(self):
        with self.assertNumQueries(1):
            self.assertEqual(parse("currency=EUR", lambda params: params.currency()), ("EUR", {}))
        self.assertEqual(parse("target=kzt", lambda params: params.currency("target")), ("KZT", {}))

    def test_unknown_currency(self):
        self.assertEqual(
            parse("currency=USD", lambda params: params.currency()), (None, {"currency": ["Неизвестный код валюты."]}),
        )

    def test_object_id(self):
        store = samples.lidl_store()
        call = lambda params: params.object_id("store", Store.objects.all(), message="Магазин не найден.")  # noqa: E731
        with self.assertNumQueries(1):
            self.assertEqual(parse(f"store={store.pk}", call), (store.pk, {}))
        self.assertEqual(parse(f"store={store.pk + 1000}", call), (None, {"store": ["Магазин не найден."]}))
        self.assertEqual(parse("store=abc", call), (None, {"store": ["Ожидается целое положительное число."]}))
        with self.assertNumQueries(0):
            self.assertEqual(parse("", call), (None, {}))
