"""``/api/goals/``: цели, взносы, прогресс и прогноз, видимость общей и личной цели в семье.

Сегодня в тестах — 13 октября 2026. Люди и суммы вымышленные.
"""
from datetime import date, timedelta
from decimal import Decimal
from unittest import mock

from django.test import TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership, Profile
from api.tests.accounts_helpers import NOT_AUTHENTICATED, NOT_FOUND, accounts_mode, local_single_mode, make_user, signed_in
from goals import services
from goals.models import Contribution, Goal
from rates.models import Rate
from receipts.ownership import local_user
from stores.models import Currency

URL = "/api/goals/"
TODAY = date(2026, 10, 13)


def today(day=TODAY):
    return mock.patch("api.views.goals.timezone.localdate", return_value=day)


def fields(response):
    return response.json()["error"]["fields"]


@tag("integration")
@local_single_mode()
class GoalApiTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def create(self, **body):
        response = self.client.post(URL, {"name": "Отпуск", "amount": "600000", **body}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def contribute(self, goal_id, **body):
        with today():
            response = self.client.post(f"{URL}{goal_id}/contributions/", body, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def test_goal_contributions_progress_and_forecast(self):
        with today():
            goal = self.create(deadline="2027-04-30")
        self.assertEqual((goal["currency"], goal["shared"], goal["owner"]["username"], goal["saved"], goal["percent"]),
                         ("KZT", False, "local", "0.00", 0))
        self.assertEqual((goal["pace"], goal["need_per_month"], goal["contributions"], goal["people"]),
                         (None, "85714.29", [], [{"username": "local", "display_name": "local"}]))
        # Двумя месяцами раньше и в этом месяце: темп — по взносам с первого (2 месяца), не больше трёх.
        self.contribute(goal["id"], amount="50000", date="2026-09-10")
        detail = self.contribute(goal["id"], amount="70000", date="2026-10-10", note="Премия")
        self.assertEqual((detail["saved"], detail["percent"], detail["remaining"], detail["reached"]),
                         ("120000.00", 20, "480000.00", False))
        self.assertEqual(detail["pace"], {"per_month": "60000.00", "months_left": 8})
        # До 30 апреля 199 дней — 7 месяцев: 480 000 / 7.
        self.assertEqual(detail["need_per_month"], "68571.43")
        self.assertEqual([(item["date"], item["amount"], item["note"], item["user"]["username"]) for item in detail["contributions"]],
                         [("2026-10-10", "70000.00", "Премия", "local"), ("2026-09-10", "50000.00", "", "local")])
        # Взнос старше трёх месяцев в темп не входит; делитель — три месяца.
        self.contribute(goal["id"], amount="30000", date="2026-06-01")
        with today():
            listed = self.client.get(URL).json()
        self.assertEqual((listed["base_currency"], listed["household"], listed["today"]), ("KZT", False, "2026-10-13"))
        item = listed["results"][0]
        self.assertEqual((item["saved"], item["contributions_count"], item["pace"]),
                         ("150000.00", 3, {"per_month": "40000.00", "months_left": 12}))
        self.assertNotIn("contributions", item)

    def test_edit_and_delete_contribution_and_goal(self):
        goal = self.create()
        detail = self.contribute(goal["id"], amount="1000")
        item = detail["contributions"][0]
        self.assertEqual(item["date"], "2026-10-13")
        url = f"{URL}{goal['id']}/contributions/{item['id']}/"
        with today():
            changed = self.client.patch(url, {"amount": "2500,50", "date": "2026-10-01"}, format="json").json()
        self.assertEqual((changed["saved"], changed["contributions"][0]["date"]), ("2500.50", "2026-10-01"))
        removed = self.client.delete(url)
        self.assertEqual((removed.status_code, removed.json()["saved"], removed.json()["contributions"]), (200, "0.00", []))
        patched = self.client.patch(f"{URL}{goal['id']}/", {"name": "Машина", "amount": "1000", "deadline": None}, format="json")
        self.assertEqual((patched.json()["name"], patched.json()["amount"], patched.json()["deadline"]), ("Машина", "1000.00", None))
        self.contribute(goal["id"], amount="1500")
        with today():
            reached = self.client.get(f"{URL}{goal['id']}/").json()
        self.assertEqual((reached["reached"], reached["percent"], reached["remaining"], reached["pace"]["months_left"]),
                         (True, 150, "0.00", None))
        self.assertEqual(self.client.delete(f"{URL}{goal['id']}/").status_code, 204)
        self.assertFalse(Contribution.objects.exists())
        self.assertEqual(self.client.get(f"{URL}{goal['id']}/").json(), NOT_FOUND)

    def test_contribution_in_another_currency_goes_by_the_rate_of_its_day(self):
        Rate.objects.create(currency="USD", day=date(2026, 10, 1), value=Decimal("500.00"), quant=1)
        goal = self.create(amount="1000", currency="USD")
        detail = self.contribute(goal["id"], amount="50000", currency="KZT", date="2026-10-02")
        self.assertEqual((detail["currency"], detail["saved"], detail["excluded"]), ("USD", "100.00", []))
        # Без курса на тот день — отдельно, в «накоплено» не входит.
        detail = self.contribute(goal["id"], amount="10000", currency="KZT", date="2026-01-02")
        self.assertEqual((detail["saved"], detail["excluded"]), ("100.00", [{"currency": "KZT", "amount": "10000.00"}]))

    def test_refusals(self):
        cases = [
            ({}, {"name", "amount"}),
            ({"name": " ", "amount": "0"}, {"name", "amount"}),
            ({"name": "Отпуск", "amount": "1", "currency": "XXX", "deadline": "13.10.2026", "x": 1}, {"currency", "deadline", "x"}),
            ({"name": "Отпуск", "amount": "1", "shared": True}, {"shared"}),
        ]
        for body, names in cases:
            with self.subTest(body=body):
                response = self.client.post(URL, body, format="json")
                self.assertEqual((response.status_code, set(fields(response))), (400, names))
        goal = self.create()
        bad = self.client.post(f"{URL}{goal['id']}/contributions/", {"amount": "-1", "user": "nobody", "date": "x"}, format="json")
        self.assertEqual(set(fields(bad)), {"amount", "user", "date"})
        self.assertEqual(set(fields(self.client.patch(f"{URL}{goal['id']}/", {}, format="json"))), {"body"})
        self.assertFalse(Contribution.objects.exists())


@tag("integration")
class ServiceTests(TestCase):
    def test_pace_months_and_deadline(self):
        self.assertEqual([services.months(days) for days in (0, 1, 30, 31, 91, 199)], [1, 1, 1, 2, 3, 7])
        kzt = Currency.objects.get(pk="KZT")
        goal = Goal.objects.create(user=local_user(), name="Демо", amount=Decimal("1000"), currency=kzt,
                                   deadline=TODAY - timedelta(days=1))
        Contribution.objects.create(goal=goal, amount=Decimal("100"), currency=kzt, date=TODAY - timedelta(days=200))
        result = services.progress([goal], TODAY)[goal.pk]
        # Взносов за три месяца нет — прогноза нет; срок прошёл.
        self.assertEqual((result.saved, result.pace, result.months_left, result.need, result.overdue),
                         (Decimal("100.00"), None, None, None, True))


@tag("integration")
@accounts_mode()
class GoalVisibilityTests(TestCase):
    """Семья: Андрей — главный, Лиза и Иван — члены; Ольга без семьи, Пётр — из другой семьи."""

    @classmethod
    def setUpTestData(cls):
        cls.andrey, cls.liza, cls.ivan = make_user("andrey"), make_user("liza"), make_user("ivan")
        cls.olga, cls.petr = make_user("olga"), make_user("petr")
        family = Household.objects.create(name="Вымышленная семья")
        Membership.objects.create(household=family, user=cls.andrey, role="head")
        Membership.objects.create(household=family, user=cls.liza, role="member")
        Membership.objects.create(household=family, user=cls.ivan, role="member")
        other = Household.objects.create(name="Другая семья")
        Membership.objects.create(household=other, user=cls.petr, role="head")
        Profile.objects.create(user=cls.andrey, default_currency_id="USD")
        cls.family = family

    def post(self, account, **body):
        response = signed_in(account).post(URL, {"name": "Цель", "amount": "1000", **body}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def listed(self, account):
        return [item["name"] for item in signed_in(account).get(URL).json()["results"]]

    def test_personal_goal_is_seen_by_its_owner_and_the_head_only(self):
        mine = self.post(self.liza, name="Курсы Лизы")
        self.assertEqual(Goal.objects.get(pk=mine["id"]).user, self.liza)
        # Основная валюта семьи — главного (USD).
        self.assertEqual(mine["currency"], "USD")
        url = f"{URL}{mine['id']}/"
        for account in (self.liza, self.andrey):
            with self.subTest(account=account.username):
                self.assertEqual(signed_in(account).get(url).json()["name"], "Курсы Лизы")
                self.assertIn("Курсы Лизы", self.listed(account))
        for account in (self.ivan, self.olga, self.petr):
            with self.subTest(account=account.username):
                client = signed_in(account)
                self.assertEqual(client.get(url).json(), NOT_FOUND)
                self.assertEqual(client.patch(url, {"name": "x"}, format="json").json(), NOT_FOUND)
                self.assertEqual(client.post(f"{url}contributions/", {"amount": "1"}, format="json").json(), NOT_FOUND)
                self.assertEqual(client.delete(url).json(), NOT_FOUND)
                self.assertNotIn("Курсы Лизы", self.listed(account))
        # Главный видит и вносит; личную цель главного Лиза не видит.
        added = signed_in(self.andrey).post(f"{url}contributions/", {"amount": "10", "user": "liza"}, format="json").json()
        self.assertEqual(added["contributions"][0]["user"], {"username": "liza", "display_name": "liza"})
        head = self.post(self.andrey, name="Подарок Лизе")
        self.assertEqual(signed_in(self.liza).get(f"{URL}{head['id']}/").json(), NOT_FOUND)

    def test_shared_goal_is_seen_and_edited_by_the_whole_family(self):
        shared = self.post(self.ivan, name="Отпуск", shared=True)
        self.assertEqual((shared["shared"], shared["owner"], shared["created_by"]["username"]), (True, None, "ivan"))
        self.post(self.liza, name="Курсы Лизы")
        for account in (self.andrey, self.liza, self.ivan):
            with self.subTest(account=account.username):
                self.assertEqual(signed_in(account).get(f"{URL}{shared['id']}/").json()["name"], "Отпуск")
        # Сначала общие, затем личные.
        self.assertEqual(self.listed(self.liza), ["Отпуск", "Курсы Лизы"])
        changed = signed_in(self.liza).patch(f"{URL}{shared['id']}/", {"amount": "2000"}, format="json")
        self.assertEqual(changed.json()["amount"], "2000.00")
        for account in (self.olga, self.petr):
            self.assertEqual(signed_in(account).get(f"{URL}{shared['id']}/").json(), NOT_FOUND)
        # Общая → личная того, кто переключил; без семьи общей не бывает.
        personal = signed_in(self.liza).patch(f"{URL}{shared['id']}/", {"shared": False}, format="json").json()
        self.assertEqual((personal["shared"], personal["owner"]["username"]), (False, "liza"))
        self.assertEqual(signed_in(self.ivan).get(f"{URL}{shared['id']}/").json(), NOT_FOUND)
        refused = signed_in(self.olga).post(URL, {"name": "Своё", "amount": "1", "shared": True}, format="json")
        self.assertEqual(set(fields(refused)), {"shared"})
        self.assertEqual(self.listed(self.olga), [])
        foreign = signed_in(self.andrey).post(f"{URL}{personal['id']}/contributions/", {"amount": "1", "user": "olga"}, format="json")
        self.assertEqual(set(fields(foreign)), {"user"})

    def test_sign_in_is_required(self):
        client = APIClient()
        for response in (client.get(URL), client.post(URL, {"name": "x", "amount": "1"}, format="json")):
            self.assertEqual((response.status_code, response.json()), (401, NOT_AUTHENTICATED))
