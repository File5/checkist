"""Курс на дату, запасной курс прошлых дней, кросс-курс через тенге, основная валюта семьи, ленивая догрузка.

Курсы — из образца ответа Нацбанка за 09.10.2026 (``fixtures``); сеть не нужна: загрузка подменена.
"""
from datetime import date, timedelta
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.test import TestCase, override_settings, tag

from accounts.models import Household, Membership, Profile
from api.tests.accounts_helpers import accounts_mode, local_single_mode, make_user
from rates import convert, nbrk, services
from rates.models import Rate
from receipts.ownership import local_user

D = Decimal
FRIDAY = date(2026, 10, 9)
SAMPLE = nbrk.parse((Path(__file__).resolve().parent / "fixtures/nbrk-2026-10-09.xml").read_bytes())
LOCMEM = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache", "LOCATION": "rates-tests"}}


def store_sample(day=FRIDAY, **changes):
    """Курсы образца на ``day``; ``changes`` — ``{код: тенге}`` вместо значений образца."""
    items = [item._replace(value=D(changes[item.currency])) if item.currency in changes else item for item in SAMPLE]
    services.store(day, items)


@tag("integration")
class ConverterTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        store_sample()
        store_sample(date(2026, 10, 1), USD="480.00")

    def test_rate_of_the_day_and_quant(self):
        found = convert.converter("KZT", [("USD", FRIDAY), ("UZS", FRIDAY), ("AMD", FRIDAY)])
        self.assertEqual(found.convert(D("20.00"), "USD", FRIDAY), D("8978.80"))
        self.assertEqual(found.convert(D("1000"), "UZS", FRIDAY), D("38.00"))  # 3.8 тенге за 100 сумов
        self.assertEqual(found.convert(D("100"), "AMD", FRIDAY), D("124.70"))  # 12.47 тенге за 10 драмов
        self.assertEqual(found.convert(D("150.00"), "KZT", FRIDAY), D("150.00"))

    def test_a_day_without_a_rate_takes_the_last_published_one(self):
        found = convert.converter("KZT", [("USD", day) for day in (date(2026, 10, 5), FRIDAY, date(2026, 10, 12))])
        self.assertEqual(found.convert(D("20"), "USD", date(2026, 10, 5)), D("9600.00"))  # курс 1 октября
        self.assertEqual(found.rate_day("USD", date(2026, 10, 12)), FRIDAY)
        self.assertEqual(found.convert(D("20"), "USD", date(2026, 10, 12)), D("8978.80"))

    def test_too_old_or_missing_rate_is_unknown(self):
        old = FRIDAY + timedelta(days=convert.STALE_DAYS + 1)
        found = convert.converter("KZT", [("USD", old), ("USD", date(2026, 9, 30)), ("GBP", FRIDAY)])
        self.assertIsNone(found.convert(D("20"), "USD", old))  # дыра больше недели — не подменяется
        self.assertIsNone(found.convert(D("20"), "USD", date(2026, 9, 30)))  # раньше первого курса
        self.assertIsNone(found.convert(D("20"), "GBP", FRIDAY))  # в образце фунта нет
        self.assertEqual(found.convert(D("20"), "USD", FRIDAY + timedelta(days=convert.STALE_DAYS)), D("8978.80"))

    def test_cross_rate_goes_through_tenge(self):
        rub = convert.converter("RUB", [("USD", FRIDAY), ("KZT", FRIDAY)])
        # 20 $ × 448.94 ₸ / 5.26 ₸ за рубль = 1706.996… ₽
        self.assertEqual(rub.convert(D("20"), "USD", FRIDAY), D("1707.00"))
        self.assertEqual(rub.convert(D("526.00"), "KZT", FRIDAY), D("100.00"))
        usd = convert.converter("USD", [("KZT", FRIDAY)])
        self.assertEqual(usd.convert(D("8978.80"), "KZT", FRIDAY), D("20.00"))
        self.assertEqual(usd.convert(D("-448.94"), "KZT", FRIDAY), D("-1.00"))  # возврат — со своим знаком

    def test_one_query_for_every_currency_and_day_none_without_other_currencies(self):
        with self.assertNumQueries(1):
            found = convert.converter("RUB", [("USD", FRIDAY), ("EUR", date(2026, 10, 3)), ("KZT", date(2026, 10, 2))])
        with self.assertNumQueries(0):
            self.assertEqual(found.convert(D("5.26"), "EUR", date(2026, 10, 3)), D("502.05"))  # курсы 1 октября: 5.26 € × 502.05 ₸ / 5.26 ₸
            self.assertEqual(convert.converter("KZT", [("KZT", FRIDAY)]).convert(D("5"), "KZT", FRIDAY), D("5"))
            self.assertEqual(convert.converter("KZT", []).base, "KZT")


@tag("integration")
@accounts_mode()
class BaseCurrencyTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        store_sample()
        cls.head, cls.member, cls.alone = make_user("rates-head"), make_user("rates-member"), make_user("rates-alone")
        family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=cls.head, household=family, role=Membership.Role.HEAD)
        Membership.objects.create(user=cls.member, household=family, role=Membership.Role.MEMBER)
        Profile.objects.create(user=cls.head, default_currency_id="USD")
        Profile.objects.create(user=cls.member, default_currency_id="RUB")

    def test_the_head_chooses_for_the_family(self):
        with self.assertNumQueries(1):
            self.assertEqual(convert.base_currency(self.member), "USD")
        self.assertEqual(convert.base_currency(self.head), "USD")

    def test_without_a_family_or_a_choice(self):
        self.assertEqual(convert.base_currency(self.alone), "KZT")
        Profile.objects.create(user=self.alone, default_currency_id="EUR")
        self.assertEqual(convert.base_currency(self.alone), "EUR")
        Membership.objects.filter(user=self.head).update(role=Membership.Role.MEMBER)  # семья без главного
        self.assertEqual(convert.base_currency(self.member), "RUB")
        self.assertEqual(convert.base_currency(None), "KZT")

    def test_changing_the_head_currency_changes_the_family_base(self):
        Profile.objects.filter(user=self.head).update(default_currency_id="KZT")
        self.assertEqual(convert.base_currency(self.member), "KZT")
        Profile.objects.filter(user=self.head).update(default_currency=None)
        self.assertEqual(convert.base_currency(self.member), "KZT")

    def test_to_base(self):
        with self.assertNumQueries(2):  # основная валюта и курсы
            self.assertEqual(convert.to_base(D("5260.00"), "KZT", FRIDAY, self.member), D("11.72"))
        self.assertEqual(convert.to_base(D("20.00"), "USD", FRIDAY, self.member), D("20.00"))
        self.assertIsNone(convert.to_base(D("20.00"), "GBP", FRIDAY, self.member))
        self.assertEqual(convert.to_base(D("20.00"), "USD", FRIDAY, self.alone), D("8978.80"))

    @local_single_mode()
    def test_local_single_reads_the_local_user_in_the_same_query(self):
        Profile.objects.create(user=local_user(), default_currency_id="EUR")
        request = mock.Mock()
        with self.assertNumQueries(1):
            self.assertEqual(convert.request_base_currency(request), "EUR")


@tag("integration")
@override_settings(CACHES=LOCMEM, RATES_AUTO_FETCH=True)
class LazyFetchTests(TestCase):
    """Недостающий недавний день догружается во время расчёта — не чаще раза в паузу и до первой ошибки."""

    TODAY = date(2026, 10, 12)

    def setUp(self):
        from django.core.cache import cache

        cache.clear()
        store_sample()  # последний загруженный день — пятница
        allowed = mock.patch("rates.services.auto_fetch_allowed", return_value=True)
        today = mock.patch("rates.services.timezone.localdate", return_value=self.TODAY)
        allowed.start(), today.start()
        self.addCleanup(allowed.stop)
        self.addCleanup(today.stop)

    def test_a_missing_recent_day_is_fetched_once_then_used(self):
        fresh = [item._replace(value=D("452.00")) if item.currency == "USD" else item for item in SAMPLE]
        with mock.patch("rates.services.nbrk.fetch", return_value=fresh) as fetch:
            found = convert.converter("KZT", [("USD", self.TODAY)])
            self.assertEqual(found.convert(D("10"), "USD", self.TODAY), D("4520.00"))
            self.assertEqual([call.args[0] for call in fetch.call_args_list], [self.TODAY])
            convert.converter("KZT", [("USD", self.TODAY - timedelta(days=1))])
            self.assertEqual(fetch.call_count, 1)  # пауза: второй раз не ходит
        self.assertTrue(Rate.objects.filter(day=self.TODAY, currency="USD").exists())

    def test_a_failure_keeps_the_last_known_rate(self):
        with mock.patch("rates.services.nbrk.fetch", side_effect=nbrk.FetchError("down")) as fetch:
            found = convert.converter("KZT", [("USD", self.TODAY - timedelta(days=1)), ("USD", self.TODAY)])
        self.assertEqual(fetch.call_count, 1)  # до первой ошибки
        self.assertEqual(found.convert(D("10"), "USD", self.TODAY), D("4489.40"))

    def test_old_days_and_future_days_are_left_to_the_command(self):
        with mock.patch("rates.services.nbrk.fetch") as fetch:
            convert.converter("KZT", [("USD", date(2026, 9, 1)), ("USD", self.TODAY + timedelta(days=3))])
        fetch.assert_not_called()

    def test_off_by_setting(self):
        with mock.patch("rates.services.auto_fetch_allowed", return_value=False), \
                mock.patch("rates.services.nbrk.fetch") as fetch:
            convert.converter("KZT", [("USD", self.TODAY)])
        fetch.assert_not_called()


class AutoFetchAllowedTests(TestCase):
    def test_never_in_a_test_database_nor_when_switched_off(self):
        self.assertFalse(services.auto_fetch_allowed())  # имя тестовой базы — test_…
        with override_settings(RATES_AUTO_FETCH=False), \
                mock.patch.dict("rates.services.connection.settings_dict", {"NAME": "checkist"}):
            self.assertFalse(services.auto_fetch_allowed())
        with override_settings(RATES_AUTO_FETCH=True), \
                mock.patch.dict("rates.services.connection.settings_dict", {"NAME": "checkist"}):
            self.assertTrue(services.auto_fetch_allowed())
