"""``/api/goals/``: цели, взносы, прогресс и прогноз, видимость общей и личной цели в семье.

Сегодня в тестах — 13 октября 2026. Люди и суммы вымышленные.
"""
import time
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


@tag("integration")
@local_single_mode()
class DepositApiTests(TestCase):
    """Депозит 12 % с ежемесячной капитализацией: 100 000 внесено 15 января, сегодня — 1 марта 2026."""

    def setUp(self):
        self.client = APIClient()

    def post(self, url, body, day=date(2026, 3, 1)):
        with today(day):
            return self.client.post(url, body, format="json")

    def test_deposit_interest_forecast_and_reconciliation(self):
        created = self.post(URL, {"name": "Kaspi Депозит", "amount": "200000", "deadline": "2027-03-01", "kind": "deposit",
                                  "rate": "12"})
        goal = created.json()
        self.assertEqual((created.status_code, goal["kind"], goal["rate"], goal["capitalization"], goal["series"]),
                         (201, "deposit", "12.00", "monthly", []))
        detail = self.post(f"{URL}{goal['id']}/contributions/", {"amount": "100000", "date": "2026-01-15"}).json()
        # 100 000 × (1 + 17d) × (1 + 28d), d = 12 / 100 / 365 — 17 дней января, 1 февраля и 1 марта капитализация.
        self.assertEqual((detail["saved"], detail["percent"], detail["remaining"]), ("101484.60", 50, "98515.40"))
        # Темп — 100 000 за два месяца с первого взноса; с процентами 1 % в месяц до 200 000 — два месяца.
        self.assertEqual(detail["pace"], {"per_month": "50000.00", "months_left": 2})
        # До срока 12 месяцев: (200 000 − 101 484,60 × 1,01¹²) / ((1,01¹² − 1) / 0,01).
        self.assertEqual(detail["need_per_month"], "6752.97")
        self.assertEqual(detail["deposit"], {
            "deposits": "100000.00", "interest": "1484.60", "in_a_year": "114355.38",
            "at_deadline": {"total": "748480.53", "interest": "48480.53"}, "by_interest": False})
        self.assertEqual([(point["month"], point["total"], point["forecast"]) for point in detail["series"][:4]],
                         [("2026-01", "100558.90", False), ("2026-02", "101484.60", False), ("2026-03", "101484.60", False),
                          ("2026-04", "152499.44", True)])
        self.assertEqual((len(detail["series"]), detail["series"][-1]["deposits"]), (15, "700000.00"))

        url = f"{URL}{goal['id']}/reconcile/"
        up = self.post(url, {"balance": "101600"}).json()
        self.assertEqual((up["saved"], up["deposit"]["interest"], up["contributions_count"], up["pace"]["per_month"]),
                         ("101600.00", "1600.00", 1, "50000.00"))
        item = up["contributions"][0]
        self.assertEqual((item["kind"], item["amount"], item["date"]), ("interest", "115.40", "2026-03-01"))
        down = self.post(url, {"balance": "101500,00", "date": "2026-03-01"}).json()
        self.assertEqual((down["saved"], down["contributions"][0]["amount"]), ("101500.00", "-100.00"))
        # Дальше — от сверенного остатка: месяц спустя 101 500 × (1 + 31d).
        with today(date(2026, 4, 1)):
            later = self.client.get(f"{URL}{goal['id']}/").json()
        self.assertEqual(later["saved"], "102534.46")
        # Сверку не правят, только удаляют.
        edit = f"{URL}{goal['id']}/contributions/{item['id']}/"
        with today():
            self.assertEqual(set(fields(self.client.patch(edit, {"amount": "1"}, format="json"))), {"kind"})
            self.assertEqual(self.client.delete(edit).json()["contributions"][0]["amount"], "-100.00")

    def test_interest_alone_reaches_the_goal_and_saving_keeps_rate_zero(self):
        goal = self.post(URL, {"name": "Подушка", "amount": "110000", "deadline": "2027-03-01", "kind": "deposit",
                               "rate": "12", "capitalization": "none"}).json()
        detail = self.post(f"{URL}{goal['id']}/contributions/", {"amount": "100000", "date": "2026-03-01"}).json()
        # Без капитализации за год: 100 000 + 12 × 1 000 = 112 000 ≥ 110 000.
        self.assertEqual((detail["need_per_month"], detail["deposit"]["by_interest"], detail["deposit"]["in_a_year"]),
                         ("0.00", True, "112000.00"))
        # Копилка: ставка хранится, но не считается; графика и блока депозита нет.
        with today(date(2026, 3, 1)):
            saving = self.client.patch(f"{URL}{goal['id']}/", {"kind": "saving"}, format="json").json()
        self.assertEqual((saving["kind"], saving["rate"], saving["deposit"], saving["series"], saving["need_per_month"]),
                         ("saving", "12.00", None, None, "833.33"))

    def test_refusals(self):
        cases = [
            ({"kind": "deposit"}, {"rate"}),
            ({"kind": "deposit", "rate": "101", "capitalization": "daily"}, {"rate", "capitalization"}),
            ({"kind": "bond", "rate": "-1"}, {"kind", "rate"}),
        ]
        for body, names in cases:
            with self.subTest(body=body):
                response = self.post(URL, {"name": "Депозит", "amount": "1000", **body})
                self.assertEqual((response.status_code, set(fields(response))), (400, names))
        saving = self.post(URL, {"name": "Копилка", "amount": "1000"}).json()
        self.assertEqual(set(fields(self.client.patch(f"{URL}{saving['id']}/", {"kind": "deposit"}, format="json"))), {"rate"})
        self.assertEqual(set(fields(self.post(f"{URL}{saving['id']}/reconcile/", {"balance": "1"}))), {"kind"})
        deposit = self.post(URL, {"name": "Депозит", "amount": "1000", "kind": "deposit", "rate": "0"}).json()
        url = f"{URL}{deposit['id']}/reconcile/"
        self.assertEqual(set(fields(self.post(url, {"balance": "0", "date": "2026-03-02", "x": 1}))), {"balance", "date", "x"})
        # Взносов по эту дату нет — сверять не с чем.
        self.assertEqual(fields(self.post(url, {"balance": "10"}))["date"], ["По эту дату взносов нет — сверять не с чем."])
        self.assertFalse(Contribution.objects.exists())

    def test_dates_stay_in_a_sane_window_and_the_count_is_fast(self):
        # Сегодня 1 марта 2026: срок — не дальше 1 марта 2076, даты — не раньше 2000 года.
        body = {"name": "Депозит", "amount": "100000000", "kind": "deposit", "rate": "12"}
        self.assertEqual(set(fields(self.post(URL, {**body, "deadline": "2076-03-02"}))), {"deadline"})
        goal = self.post(URL, {**body, "deadline": "2076-03-01"}).json()
        gifts = f"{URL}{goal['id']}/contributions/"
        self.assertEqual(set(fields(self.post(gifts, {"amount": "1", "date": "1999-12-31"}))), {"date"})
        self.assertEqual(set(fields(self.post(gifts, {"amount": "1", "date": "2076-03-02"}))), {"date"})
        self.assertEqual(set(fields(self.post(f"{URL}{goal['id']}/reconcile/", {"balance": "1", "date": "1999-12-31"}))), {"date"})
        self.assertEqual(self.post(gifts, {"amount": "1000", "date": "2000-01-01"}).status_code, 201)
        self.assertEqual(self.post(gifts, {"amount": "1000", "date": "2026-02-01"}).status_code, 201)
        # 26 лет начисления и 50 лет прогноза — шаги по месяцам, а не по дням.
        started = time.perf_counter()
        services.progress([Goal.objects.get(pk=goal["id"])], date(2026, 3, 1))
        self.assertLess(time.perf_counter() - started, 0.2)
        with today(date(2026, 3, 1)):
            detail = self.client.get(f"{URL}{goal['id']}/").json()
            listed = self.client.get(URL).json()
        self.assertEqual((len(detail["series"]), listed["results"][0]["saved"]), (315 + 60, detail["saved"]))
