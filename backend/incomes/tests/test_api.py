"""Доходы: ``/api/incomes/``, видимость в семье, итоги месяца, «Динамика», разбор словами, регулярный доход.

Сегодня в тестах — 13 октября 2026. Данные вымышленные; модель не вызывается (fake).
"""
from datetime import date, datetime
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from django.test import TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_FOUND, TwoUsers, accounts_mode, local_single_mode, make_user
from budget.dashboard import Month
from catalog.models import Category
from incomes import services
from incomes.models import Income, IncomeCategory
from rates.models import Rate
from receipts import manual, manual_parse
from receipts.ownership import local_user
from recurring import services as recurring
from recurring.models import RecurringPayment

D = Decimal
URL = "/api/incomes/"
TODAY = date(2026, 10, 13)
LONG_AGO = datetime(2026, 1, 1, 12, tzinfo=ZoneInfo("Asia/Almaty"))


def built_in(name):
    # TransactionTestCase других приложений может стереть строки миграции: категория заводится заново.
    return IncomeCategory.objects.get_or_create(name=name, household=None, user=None)[0]


def income(owner, amount, on, category="Зарплата", currency="KZT"):
    return Income.objects.create(owner=owner, received_on=on, amount=D(amount), currency_id=currency,
                                 category=built_in(category))


def today(day=TODAY):
    return mock.patch("django.utils.timezone.localdate", return_value=day)


@tag("integration")
@accounts_mode()
class FamilyIncomeTests(TwoUsers, TestCase):
    """``first`` — главный, ``third`` — член семьи, ``second`` — вне её."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three", first_name="Лиза")
        cls.family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=cls.first, household=cls.family, role="head")
        Membership.objects.create(user=cls.third, household=cls.family)
        cls.head_salary = income(cls.first, "650000", date(2026, 10, 5))
        cls.liza_salary = income(cls.third, "300000", date(2026, 10, 6))
        cls.outsider = income(cls.second, "999", date(2026, 10, 6))
        cls.food = Category.objects.create(name="Демо-продукты")
        manual.create(cls.third, {"total": "200000", "currency": "KZT", "category": cls.food.pk,
                                  "purchased_on": "2026-10-07"})

    def month(self, account, month="2026-10"):
        response = self.client_of(account).get(URL, {"month": month})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_member_sees_own_records_and_the_family_total(self):
        data = self.month(self.third)
        self.assertEqual([row["id"] for row in data["results"]], [self.liza_salary.pk])
        self.assertEqual((data["family_total"], data["base_currency"]), ("950000.00", "KZT"))
        self.assertEqual(self.client_of(self.third).get(f"{URL}{self.head_salary.pk}/").json(), NOT_FOUND)
        response = self.client_of(self.third, csrf=True).patch(f"{URL}{self.head_salary.pk}/", {"amount": "1"}, format="json")
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.client_of(self.third, csrf=True).delete(f"{URL}{self.head_salary.pk}/").status_code, 404)
        self.assertTrue(Income.objects.filter(pk=self.head_salary.pk, amount=D("650000")).exists())

    def test_head_sees_every_record_of_the_family(self):
        data = self.month(self.first)
        self.assertEqual([row["id"] for row in data["results"]], [self.liza_salary.pk, self.head_salary.pk])
        self.assertEqual(data["results"][0]["owner_name"], "Лиза")
        self.assertEqual(self.client_of(self.first).get(f"{URL}{self.liza_salary.pk}/").status_code, 200)

    def test_outsider_sees_nothing_of_the_family(self):
        data = self.month(self.second)
        self.assertEqual(([row["id"] for row in data["results"]], data["family_total"]), ([self.outsider.pk], "999.00"))
        self.assertEqual(self.client_of(self.second).get(f"{URL}{self.liza_salary.pk}/").json(), NOT_FOUND)
        self.assertEqual(self.month(self.second, "2026-09")["family_total"], None)

    def test_summary_of_the_month(self):
        response = self.client_of(self.third).get(f"{URL}summary/", {"month": "2026-10"})
        self.assertEqual(response.json(), {"month": "2026-10", "base_currency": "KZT", "income": "950000.00",
                                           "spent": "200000.00", "saved": "750000.00", "saved_percent": "78.95",
                                           "excluded": []})
        empty = self.client_of(self.third).get(f"{URL}summary/", {"month": "2026-09"}).json()
        self.assertEqual((empty["income"], empty["spent"], empty["saved"], empty["saved_percent"]),
                         (None, "0.00", None, None))

    def test_month_income_for_the_daily_allowance(self):
        self.assertEqual(services.month_income(self.third, Month(2026, 10)), D("950000.00"))
        self.assertEqual(services.month_income(self.first, date(2026, 10, 20)), D("950000.00"))
        self.assertIsNone(services.month_income(self.first, Month(2026, 9)))

    def test_trends_line(self):
        with today():
            response = self.client_of(self.third).get("/api/stats/trends/incomes/", {"months": 2})
        self.assertEqual(response.status_code, 200, response.content)
        data = response.json()
        self.assertEqual((data["months"], data["month_from"], data["month_to"]), (2, "2026-09", "2026-10"))
        self.assertEqual(data["items"], [
            {"month": "2026-09", "income": None, "spent": "0.00", "saved": None, "saved_percent": None},
            {"month": "2026-10", "income": "950000.00", "spent": "200000.00", "saved": "750000.00",
             "saved_percent": "78.95"},
        ])
        self.assertEqual(self.client_of(self.third).get("/api/stats/trends/incomes/", {"months": 99}).status_code, 400)

    def test_stats_tab_shows_the_family_total_and_the_categories_one_may_see(self):
        income(self.first, "50000", date(2026, 9, 20), category="Подработка")

        def stats(account, **params):
            with today():
                response = self.client_of(account).get("/api/stats/incomes/", params or {"months": 2})
            self.assertEqual(response.status_code, 200, response.content)
            return response.json()

        def rows(data):
            return data["categories_scope"], [(row["name"], row["total"]) for row in data["categories"]]

        member = stats(self.third)
        self.assertEqual({key: member[key] for key in ("months", "month_from", "month_to", "base_currency", "income",
                                                       "spent", "saved", "saved_percent", "excluded")},
                         {"months": 2, "month_from": "2026-09", "month_to": "2026-10", "base_currency": "KZT",
                          "income": "1000000.00", "spent": "200000.00", "saved": "800000.00", "saved_percent": "80.00",
                          "excluded": []})
        # Член семьи видит общий доход семьи, а разбивку по категориям — только своих записей.
        self.assertEqual(rows(member), ("own", [("Зарплата", "300000.00")]))
        self.assertEqual(member["categories"][0]["id"], built_in("Зарплата").pk)
        head = stats(self.first)
        self.assertEqual((head["income"], rows(head)), ("1000000.00", ("family", [("Зарплата", "950000.00"),
                                                                                  ("Подработка", "50000.00")])))
        outsider = stats(self.second)
        self.assertEqual((outsider["income"], outsider["spent"], rows(outsider)),
                         ("999.00", "0.00", ("family", [("Зарплата", "999.00")])))
        empty = stats(self.third, **{"from": "2026-01", "to": "2026-02"})
        self.assertEqual((empty["income"], empty["saved"], empty["saved_percent"], rows(empty)),
                         (None, None, None, ("own", [])))
        refused = self.client_of(self.third).get("/api/stats/incomes/", {"from": "2026-10", "months": 2})
        self.assertEqual(refused.status_code, 400)

    def test_own_categories_belong_to_the_family(self):
        response = self.client_of(self.third, csrf=True).post(f"{URL}categories/", {"name": "Аренда гаража"}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        own = response.json()
        self.assertEqual((own["name"], own["built_in"]), ("Аренда гаража", False))
        again = self.client_of(self.first, csrf=True).post(f"{URL}categories/", {"name": "аренда ГАРАЖА"}, format="json")
        self.assertEqual(again.json()["id"], own["id"])
        names = [row["name"] for row in self.client_of(self.first).get(f"{URL}categories/").json()["results"]]
        self.assertEqual(names[:6], ["Зарплата", "Подработка", "Подарки", "Кэшбэк и проценты", "Продажа вещей", "Прочее"])
        self.assertIn("Аренда гаража", names)
        outsider = self.client_of(self.second)
        self.assertNotIn("Аренда гаража", [row["name"] for row in outsider.get(f"{URL}categories/").json()["results"]])
        refused = self.client_of(self.second, csrf=True).post(URL, {"amount": "1", "category": own["id"]}, format="json")
        self.assertEqual((refused.status_code, list(refused.json()["error"]["fields"])), (400, ["category"]))


@tag("integration")
@local_single_mode()
class IncomeLocalTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.salary = built_in("Зарплата")

    def test_crud_with_defaults_and_validation(self):
        with today():
            response = self.client.post(URL, {"amount": "650 000".replace(" ", ""), "category": self.salary.pk}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertEqual({key: body[key] for key in ("received_on", "amount", "currency", "category", "note", "base_amount")},
                         {"received_on": "2026-10-13", "amount": "650000.00", "currency": "KZT",
                          "category": {"id": self.salary.pk, "name": "Зарплата"}, "note": "", "base_amount": "650000.00"})
        changed = self.client.patch(f"{URL}{body['id']}/", {"amount": "640000.50", "note": " аванс "}, format="json").json()
        self.assertEqual((changed["amount"], changed["note"]), ("640000.50", "аванс"))
        refused = self.client.post(URL, {"amount": "0", "currency": "XXX", "received_on": "2026-02-30", "x": 1}, format="json")
        self.assertEqual(set(refused.json()["error"]["fields"]), {"amount", "currency", "category", "received_on", "x"})
        self.assertEqual(self.client.delete(f"{URL}{body['id']}/").status_code, 204)
        self.assertFalse(Income.objects.exists())

    def test_income_of_another_currency_counts_by_the_rate_of_its_day(self):
        Rate.objects.create(currency="USD", day=date(2026, 10, 5), value=D("480.00"))
        income(local_user(), "100", date(2026, 10, 6), currency="USD")
        income(local_user(), "5", date(2026, 10, 6), currency="EUR")  # курса нет — в итог не входит
        self.assertEqual(services.month_income(local_user(), Month(2026, 10)), D("48000.00"))
        data = self.client.get(f"{URL}summary/", {"month": "2026-10"}).json()
        self.assertEqual((data["income"], data["excluded"]), ("48000.00", [{"currency": "EUR", "total": "5.00"}]))

    def test_stats_tab_counts_the_categories_in_the_base_currency(self):
        Rate.objects.create(currency="USD", day=date(2026, 10, 5), value=D("480.00"))
        income(local_user(), "650000", date(2026, 10, 5))
        income(local_user(), "100", date(2026, 10, 6), category="Подработка", currency="USD")
        income(local_user(), "5", date(2026, 10, 6), currency="EUR")  # курса нет — ни в итог, ни в разбивку
        with today():
            data = self.client.get("/api/stats/incomes/", {"from": "2026-10", "to": "2026-10"}).json()
        self.assertEqual((data["income"], data["categories_scope"], data["excluded"]),
                         ("698000.00", "family", [{"currency": "EUR", "total": "5.00"}]))
        self.assertEqual([(row["name"], row["total"]) for row in data["categories"]],
                         [("Зарплата", "650000.00"), ("Подработка", "48000.00")])

    def test_parse_understands_a_salary(self):
        built_in("Подработка")
        row = self.client.post("/api/receipts/manual/parse/", {"text": "зарплата 650 000"}, format="json").json()
        manual_parse.execute(manual_parse.claim(), parser=manual_parse.FakeTextParser())
        draft = self.client.get(f"/api/receipts/manual/parse/{row['id']}/").json()["draft"]
        self.assertEqual((draft["kind"], draft["total"], draft["category"]), ("income", "650000", self.salary.pk))
        saved = self.client.post(URL, {"amount": draft["total"], "currency": draft["currency"], "category": draft["category"],
                                       "received_on": draft["purchased_on"], "note": draft["note"]}, format="json")
        self.assertEqual(saved.status_code, 201, saved.content)


@tag("integration")
@local_single_mode()
class RecurringIncomeTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.salary = built_in("Зарплата")

    def create(self, **body):
        with mock.patch("api.views.recurring.timezone.localdate", return_value=TODAY):
            response = self.client.post("/api/recurring/", {"name": "Зарплата", "category_id": self.salary.pk,
                                                            "currency": "KZT", "amount": "650000", "due_day": 10,
                                                            "kind": "income", **body}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        RecurringPayment.objects.filter(pk=response.json()["id"]).update(created_at=LONG_AGO)
        return response.json()

    def month(self):
        with mock.patch("api.views.recurring.timezone.localdate", return_value=TODAY):
            return self.client.get("/api/recurring/").json()

    def test_salary_template_is_received_by_an_income_of_its_category(self):
        template = self.create(store_name="Работодатель")
        self.assertEqual((template["kind"], template["category"]["name"], template["store"]), ("income", "Зарплата", None))
        row = self.month()["payments"][0]
        self.assertEqual((row["state"], row["paid"]), ("overdue", None))
        self.assertEqual(self.month()["totals"], [])  # доход не «осталось оплатить»
        income(local_user(), "600000", date(2026, 10, 9))  # сумму поправили — всё равно та же зарплата
        row = self.month()["payments"][0]
        self.assertEqual((row["state"], row["paid"]["receipt_id"], row["paid"]["total"]), ("paid", None, "600000.00"))
        # «Можно тратить в день» читает только платежи.
        self.assertEqual(recurring.unpaid(local_user(), Month(2026, 9), today=TODAY), [])
        decision = self.client.post(f"/api/recurring/{template['id']}/decision/",
                                    {"month": "2026-09", "decision": "skipped"}, format="json")
        self.assertEqual(decision.status_code, 404)

    def test_income_of_another_category_is_not_the_salary(self):
        self.create()
        income(local_user(), "650000", date(2026, 10, 9), category="Подарки")
        self.assertEqual(self.month()["payments"][0]["state"], "overdue")

    def test_kind_and_category_are_checked(self):
        with mock.patch("api.views.recurring.timezone.localdate", return_value=TODAY):
            wrong = self.client.post("/api/recurring/", {"name": "З", "category_id": 999999999, "currency": "KZT",
                                                         "amount": "1", "due_day": 1, "kind": "income"}, format="json")
            self.assertEqual(list(wrong.json()["error"]["fields"]), ["category_id"])
            bad = self.client.post("/api/recurring/", {"name": "З", "category_id": self.salary.pk, "currency": "KZT",
                                                       "amount": "1", "due_day": 1, "kind": "gift"}, format="json")
            self.assertIn("kind", bad.json()["error"]["fields"])
        template = self.create()
        changed = self.client.patch(f"/api/recurring/{template['id']}/", {"kind": "spend"}, format="json")
        self.assertEqual(list(changed.json()["error"]["fields"]), ["kind"])


@tag("integration")
@accounts_mode()
class RecurringIncomeFamilyTests(TwoUsers, TestCase):
    """Шаблон дохода члена семьи видят он и главный; другой член семьи — нет."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=cls.first, household=family, role="head")
        Membership.objects.create(user=cls.third, household=family)
        Membership.objects.create(user=cls.second, household=family)
        cls.template = RecurringPayment.objects.create(
            household=family, kind="income", name="Зарплата Лизы", income_category=built_in("Зарплата"),
            currency_id="KZT", amount=D("300000"), due_day=5, created_by=cls.third)

    def names(self, account):
        return [row["name"] for row in self.client_of(account).get("/api/recurring/").json()["payments"]]

    def test_template_is_private_like_the_records(self):
        self.assertEqual(self.names(self.third), ["Зарплата Лизы"])
        self.assertEqual(self.names(self.first), ["Зарплата Лизы"])
        self.assertEqual(self.names(self.second), [])
        self.assertEqual(self.client_of(self.second).get(f"/api/recurring/{self.template.pk}/").status_code, 404)
