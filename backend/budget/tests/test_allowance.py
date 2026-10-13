"""«Можно тратить в день» (``budget.allowance.daily``), общий бюджет месяца и его API, поиск трат по сумме.

Сегодня в тестах — 13 октября 2026: в месяце осталось 19 дней, включая сегодня. Данные вымышленные.
"""
from datetime import date, datetime
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from django.test import TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import TwoUsers, accounts_mode, local_single_mode, make_user
from budget import allowance, history
from budget.dashboard import Month
from budget.models import BudgetLimit, MonthlyBudget
from catalog.models import Category
from rates.models import Rate
from receipts import manual
from receipts.models import Receipt
from receipts.ownership import local_user
from recurring.models import RecurringPayment

D = Decimal
TODAY = date(2026, 10, 13)
OCTOBER = Month(2026, 10)
LONG_AGO = datetime(2026, 1, 1, 12, tzinfo=ZoneInfo("Asia/Almaty"))
MONTH_URL = "/api/budget/month/"
DASHBOARD = "/api/dashboard/"


def spend(owner, category, total, on, currency="KZT", **body):
    return manual.create(owner, {"total": str(total), "currency": currency, "category": category.pk,
                                 "purchased_on": on.isoformat(), **body})


def today(day=TODAY):
    """«Сегодня» сервера: вью, ``budget.history`` и ``budget.allowance`` читают один ``django.utils.timezone``."""
    return mock.patch("django.utils.timezone.localdate", return_value=day)


@tag("integration")
@local_single_mode()
class DailyTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = local_user()
        cls.food = Category.objects.create(name="Демо-еда")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)
        cls.home = Category.objects.create(name="Демо-дом")
        cls.rent = Category.objects.create(name="Демо-аренда", parent=cls.home)
        spend(cls.owner, cls.food, "30000", date(2026, 10, 2))
        spend(cls.owner, cls.home, "70000", date(2026, 10, 5))
        spend(cls.owner, cls.food, "999999", date(2026, 9, 30))  # прошлый месяц не считается

    def daily(self, **kwargs):
        return allowance.daily(self.owner, OCTOBER, today=TODAY, **kwargs)

    def limit(self, category, amount, currency="KZT"):
        return BudgetLimit.objects.create(user=self.owner, category=category, currency_id=currency, amount=D(amount))

    def test_nothing_without_budget_limits_and_income(self):
        self.assertIsNone(self.daily())

    def test_only_the_current_month(self):
        self.limit(self.food, "100000")
        self.assertIsNone(allowance.daily(self.owner, Month(2026, 9), today=TODAY))
        self.assertIsNone(allowance.daily(self.owner, Month(2026, 11), today=TODAY))
        self.assertIsNotNone(allowance.daily(self.owner, date(2026, 10, 31), today=TODAY))

    def test_limits_of_the_top_level(self):
        # Лимит подкатегории при лимите предка — часть его; без лимита предка — входит сам (как limit_total).
        self.limit(self.food, "150000")
        self.limit(self.dairy, "20000")
        self.limit(self.rent, "100000")
        value = self.daily()
        self.assertEqual((value.basis, value.amount, value.spent, value.unpaid, value.days_left),
                         ("limits", D("250000.00"), D("100000.00"), D("0.00"), 19))
        self.assertEqual((value.per_day, value.overspent), (D("7894.73"), None))  # 150 000 / 19, вниз до копейки

    def test_budget_wins_over_limits(self):
        self.limit(self.food, "150000")
        with today():
            history.set_budget({"household": None, "user": self.owner}, "KZT", D("500000"))
        value = self.daily()
        self.assertEqual((value.basis, value.amount, value.per_day), ("budget", D("500000"), D("21052.63")))

    def test_removed_budget_falls_back_to_limits(self):
        self.limit(self.food, "150000")
        with today():
            history.set_budget({"household": None, "user": self.owner}, "KZT", D("500000"))
            history.set_budget({"household": None, "user": self.owner}, "KZT", None)
        self.assertEqual(self.daily().basis, "limits")

    def test_income_only_without_budget_and_limits(self):
        value = self.daily(income=D("400000"))
        self.assertEqual((value.basis, value.amount, value.per_day), ("income", D("400000"), D("15789.47")))
        self.limit(self.food, "150000")
        self.assertEqual(self.daily(income=D("400000")).basis, "limits")

    def test_overspent_instead_of_a_negative_day(self):
        self.limit(self.food, "60000")
        value = self.daily()
        self.assertEqual((value.per_day, value.overspent), (None, D("40000.00")))

    def test_unpaid_recurring_payments_are_set_aside(self):
        self.limit(self.food, "200000")
        rent = RecurringPayment.objects.create(user=self.owner, name="Демо-аренда", category=self.rent, currency_id="KZT",
                                               amount=D("50000"), due_day=25)
        sub = RecurringPayment.objects.create(user=self.owner, name="Демо-подписка", category=self.food, currency_id="USD",
                                              amount=D("10"), due_day=20)
        RecurringPayment.objects.filter(pk__in=[rent.pk, sub.pk]).update(created_at=LONG_AGO)
        Rate.objects.create(currency="USD", day=TODAY, value=D("500"))
        value = self.daily()
        self.assertEqual((value.unpaid, value.unpaid_count), (D("55000.00"), 2))
        self.assertEqual(value.per_day, D("2368.42"))  # (200 000 − 100 000 − 55 000) / 19

    def test_other_currencies_at_the_rate_of_their_day(self):
        Rate.objects.create(currency="USD", day=date(2026, 10, 3), value=D("480"))
        Rate.objects.create(currency="USD", day=TODAY, value=D("500"))
        spend(self.owner, self.food, "10", date(2026, 10, 3), currency="USD")
        self.limit(self.food, "100", currency="USD")  # лимит другой валюты — по сегодняшнему курсу
        value = self.daily()
        self.assertEqual((value.currency, value.amount, value.spent), ("KZT", D("50000.00"), D("104800.00")))
        self.assertEqual(value.overspent, D("54800.00"))


@tag("integration")
@accounts_mode()
class MonthBudgetApiTests(TwoUsers, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.family = Household.objects.create(name="Демо-семья")
        cls.partner = make_user("demo-partner")
        Membership.objects.create(user=cls.first, household=cls.family, role="head")
        Membership.objects.create(user=cls.partner, household=cls.family, role="member")
        cls.food = Category.objects.create(name="Демо-еда")

    def post(self, account, body):
        with today():
            return self.client_of(account).post(MONTH_URL, body, format="json")

    def get(self, account, url=MONTH_URL, day=TODAY):
        with today(day):
            response = self.client_of(account).get(url)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_family_shares_one_budget(self):
        self.assertEqual(self.get(self.first), {"amount": None, "currency": None, "base_currency": "KZT"})
        response = self.post(self.partner, {"amount": "650000"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {"amount": "650000.00", "currency": "KZT", "base_currency": "KZT"})
        self.assertEqual(self.get(self.first)["amount"], "650000.00")
        self.assertEqual(self.get(self.second)["amount"], None)  # чужая семья
        row = MonthlyBudget.objects.get()
        self.assertEqual((row.household_id, row.user_id, row.effective_month, row.changed_by_id),
                         (self.family.pk, None, date(2026, 10, 1), self.partner.pk))

    def test_a_later_month_keeps_the_past_one(self):
        self.post(self.first, {"amount": "650000"})
        with today(date(2026, 11, 2)):
            self.client_of(self.first).post(MONTH_URL, {"amount": "700000"}, format="json")
            self.assertEqual(self.client_of(self.first).delete(MONTH_URL).status_code, 204)
        self.assertEqual(self.get(self.first, day=date(2026, 11, 2))["amount"], None)
        october = self.get(self.first, f"{DASHBOARD}?month=2026-10", day=date(2026, 11, 2))
        self.assertEqual(october["budget"], {"amount": "650000.00", "currency": "KZT", "spent": "0.00"})
        self.assertIsNone(october["allowance"])  # прошлый месяц
        self.assertIsNone(self.get(self.first, f"{DASHBOARD}?month=2026-09", day=date(2026, 11, 2))["budget"])
        self.assertEqual(list(MonthlyBudget.objects.order_by("effective_month").values_list("amount", flat=True)),
                         [D("650000.00"), None])

    def test_invalid_bodies(self):
        for body, fields in (({}, {"amount": ["Обязательное поле."]}),
                             ({"amount": "0"}, {"amount": ["Сумма больше нуля, не больше двух знаков после запятой."]}),
                             ({"amount": "1.234"}, {"amount": ["Сумма больше нуля, не больше двух знаков после запятой."]}),
                             ({"amount": "10", "currency": "USD"}, {"currency": ["Неизвестное поле."]})):
            response = self.post(self.first, body)
            self.assertEqual(response.status_code, 400, body)
            self.assertEqual(response.json()["error"]["fields"], fields)
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_removing_nothing_writes_nothing(self):
        with today():
            self.assertEqual(self.client_of(self.first).delete(MONTH_URL).status_code, 204)
        self.assertFalse(MonthlyBudget.objects.exists())

    def test_anonymous(self):
        self.assertEqual(APIClient().get(MONTH_URL).status_code, 401)

    def test_dashboard_budget_and_allowance(self):
        spend(self.partner, self.food, "120000", date(2026, 10, 4))
        hidden = spend(self.first, self.food, "50000", date(2026, 10, 5))
        Receipt.objects.filter(pk=hidden.pk).update(hidden=True)  # скрытый платёж не считается ни у кого
        self.post(self.first, {"amount": "500000"})
        body = self.get(self.partner, DASHBOARD)
        self.assertEqual(body["budget"], {"amount": "500000.00", "currency": "KZT", "spent": "120000.00"})
        self.assertEqual(body["allowance"], {
            "currency": "KZT", "basis": "budget", "amount": "500000.00", "spent": "120000.00", "unpaid": "0.00",
            "unpaid_count": 0, "days_left": 19, "per_day": "20000.00", "overspent": None,
        })
        self.assertIsNone(self.get(self.second, DASHBOARD)["allowance"])
