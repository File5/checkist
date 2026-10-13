"""Итоги в основной валюте семьи: Главная, лимиты, статистика, «Траты» и карточка чека.

Октябрь 2026: 10 000 ₸, 20 $ (9 октября, 448.94), 10 € (суббота 10-го — курс пятницы 502.05) и 5 £ —
фунта в курсах нет, трата «без курса». Сентябрь: 1 000 ₸ и 10 $ по 470. Март: 1 000 ₽ без курса.
Лимиты: 30 000 ₸ на еду и прежний 50 $ на транспорт. «Сегодня» сервера — 12 октября.
"""
from datetime import date
from decimal import Decimal
from unittest import mock

from django.test import TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership, Profile
from api.tests.accounts_helpers import accounts_mode, local_single_mode, make_user, signed_in
from budget.models import BudgetLimit
from catalog.models import Category
from rates.tests.test_convert import store_sample
from receipts import manual
from receipts.ownership import local_user

D = Decimal
TODAY = date(2026, 10, 12)


def spend(owner, category, total, on, currency):
    return manual.create(owner, {"total": total, "currency": currency, "category": category.pk,
                                 "purchased_on": on.isoformat()})


class FixtureMixin:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        store_sample()  # 9 октября
        store_sample(date(2026, 9, 25), USD="470.00")
        owner = cls.owner()
        cls.food = Category.objects.create(name="Демо-еда")
        cls.transport = Category.objects.create(name="Демо-транспорт")
        cls.fun = Category.objects.create(name="Демо-досуг")
        spend(owner, cls.food, "10000", date(2026, 10, 9), "KZT")
        cls.usd = spend(owner, cls.food, "20", date(2026, 10, 9), "USD")
        spend(owner, cls.fun, "10", date(2026, 10, 10), "EUR")
        cls.gbp = spend(owner, cls.food, "5", date(2026, 10, 11), "GBP")
        spend(owner, cls.food, "10", date(2026, 9, 25), "USD")
        spend(owner, cls.food, "1000", date(2026, 9, 20), "KZT")
        spend(owner, cls.food, "1000", date(2026, 3, 1), "RUB")
        holder = cls.holder(owner)
        cls.food_limit = BudgetLimit.objects.create(**holder, category=cls.food, currency_id="KZT", amount=D("30000"))
        # Заведён до правила «только в основной валюте»: читается и показывается пересчитанным.
        cls.usd_limit = BudgetLimit.objects.create(**holder, category=cls.transport, currency_id="USD", amount=D("50"))

    @classmethod
    def holder(cls, owner):
        return {"user": owner}


def localdate():
    return mock.patch("django.utils.timezone.localdate", return_value=TODAY)


@tag("integration")
@local_single_mode()
class InBaseTests(FixtureMixin, TestCase):
    @classmethod
    def owner(cls):
        return local_user()

    def get(self, path):
        with localdate():
            response = APIClient().get(path)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_dashboard_adds_every_currency_at_the_rate_of_its_day(self):
        body = self.get("/api/dashboard/?month=2026-10")
        self.assertEqual([block["currency"] for block in body["currencies"]], ["EUR", "GBP", "KZT", "USD"])
        self.assertEqual(body["base_currency"], "KZT")
        base = body["base"]
        self.assertEqual({key: base[key] for key in ("currency", "spent", "previous_spent", "limit_total", "limited_spent")}, {
            "currency": "KZT", "spent": "23999.30", "previous_spent": "5700.00",
            # 50 $ по курсу 12 октября (последний — 9-го): 22 447 ₸.
            "limit_total": "52447.00", "limited_spent": "18978.80",
        })
        self.assertEqual([(row["name"], row["spent"], row["limit"], row["limit_id"]) for row in base["categories"]], [
            ("Демо-еда", "18978.80", "30000.00", self.food_limit.pk),
            ("Демо-досуг", "5020.50", None, None),
            ("Демо-транспорт", "0.00", "22447.00", self.usd_limit.pk),
        ])
        self.assertEqual(body["excluded"], [{"currency": "GBP", "receipts_count": 1, "total": "5.00"}])
        recent = {row["id"]: (row["total"], row["currency"], row["base_total"]) for row in body["recent"]}
        self.assertEqual(recent[self.usd.pk], ("20.00", "USD", "8978.80"))
        self.assertEqual(recent[self.gbp.pk], ("5.00", "GBP", None))

    def test_a_month_with_only_spends_without_a_rate(self):
        body = self.get("/api/dashboard/?month=2026-03")
        self.assertEqual(body["excluded"], [{"currency": "RUB", "receipts_count": 1, "total": "1000.00"}])
        self.assertEqual((body["base"]["spent"], body["base"]["limit_total"]), ("0.00", "30000.00"))
        # Курса доллара на март нет: прежний лимит остаётся в своей валюте, в итог основной не входит.
        self.assertEqual([(row["name"], row["limit"]) for row in body["base"]["categories"]], [("Демо-еда", "30000.00")])

    def test_dashboard_query_count_does_not_grow_with_other_currencies(self):
        def count():
            from django.db import connection
            from django.test.utils import CaptureQueriesContext

            with localdate(), CaptureQueriesContext(connection) as queries:
                self.assertEqual(APIClient().get("/api/dashboard/?month=2026-10").status_code, 200)
            return len(queries)

        before = count()
        for day in range(1, 12):
            spend(local_user(), self.fun, "3", date(2026, 10, day), ("USD", "EUR", "RUB", "UZS")[day % 4])
        self.assertEqual(count(), before)

    def test_stats_spending_and_category_spends(self):
        body = self.get("/api/stats/spending/?date_from=2026-10-01&date_to=2026-10-31")
        self.assertEqual(body["base"]["totals"], {"receipts_count": 3, "receipts_total": "23999.30",
                                                  "lines_paid": "23999.30", "difference": "0.00"})
        self.assertEqual([(item["name"], item["amount"]) for item in body["base"]["items"]],
                         [("Демо-еда", "18978.80"), ("Демо-досуг", "5020.50")])
        self.assertEqual(body["excluded"], [{"currency": "GBP", "receipts_count": 1, "total": "5.00"}])
        food = self.get(f"/api/stats/category-spends/?category={self.food.pk}&month=2026-10")
        self.assertEqual(food["base"]["total"], "18978.80")
        items = {item["receipt_id"]: item for item in food["base"]["items"]}
        self.assertEqual(
            {key: items[self.usd.pk][key] for key in ("currency", "original_amount", "category_amount", "receipt_total")},
            {"currency": "USD", "original_amount": "20.00", "category_amount": "8978.80", "receipt_total": "8978.80"})
        self.assertEqual(food["excluded"], [{"currency": "GBP", "receipts_count": 1, "total": "5.00"}])

    def test_trends_in_base(self):
        monthly = self.get("/api/stats/trends/monthly/?month=2026-10&months=2")
        self.assertEqual([month["total"] for month in monthly["base"]["months"]], ["5700.00", "23999.30"])
        self.assertEqual(monthly["excluded"], [{"currency": "GBP", "receipts_count": 1, "total": "5.00"}])
        category = self.get(f"/api/stats/trends/category/?month=2026-10&months=2&category={self.food.pk}")
        self.assertEqual([month["amount"] for month in category["base"]["months"]], ["5700.00", "18978.80"])
        limits = self.get("/api/stats/trends/limits/?month=2026-10&months=2")
        self.assertEqual([(row["category"]["name"], row["currency"], row["amount"]) for row in limits["limits"]],
                         [("Демо-еда", "KZT", "30000.00"), ("Демо-транспорт", "USD", "50.00")])
        self.assertEqual(
            [(row["currency"], row["amount"], [month["limit"] for month in row["months"]]) for row in limits["base_limits"]],
            [("KZT", "30000.00", ["30000.00", "30000.00"]),
             # сентябрь — по курсу 30-го (последний — 25-го, 470), октябрь — сегодняшнему (9-го)
             ("KZT", "22447.00", ["23500.00", "22447.00"])])
        self.assertEqual(limits["base_limits"][0]["months"][1]["spent"], "18978.80")

    def test_receipt_series_and_compare(self):
        series = self.get("/api/stats/receipts/series/?date_from=2026-09-01")
        self.assertEqual([(bucket["period_start"], bucket["receipts_count"], bucket["total"], bucket["median_receipt"])
                          for bucket in series["base"]["buckets"]],
                         [("2026-09-01", 2, "5700.00", "2850.00"), ("2026-10-01", 3, "23999.30", "8978.80")])
        self.assertEqual(series["excluded"], [{"currency": "GBP", "receipts_count": 1, "total": "5.00"}])
        compare = self.get("/api/stats/receipts/compare/?base_from=2026-09-01&base_to=2026-09-30"
                           "&current_from=2026-10-01&current_to=2026-10-31")
        block = compare["in_base"]
        self.assertEqual((block["currency"], block["base"]["receipts_count"], block["current"]["receipts_count"]),
                         ("KZT", 2, 3))
        self.assertEqual((block["base"]["avg_receipt"], block["current"]["avg_receipt"]), ("2850.00", "7999.77"))
        self.assertEqual(compare["base"], {"date_from": "2026-09-01", "date_to": "2026-09-30"})

    def test_spends_list_and_receipt_keep_the_original_amount(self):
        listed = {item["id"]: item for item in self.get("/api/receipts/?page_size=50")["results"]}
        self.assertEqual({key: listed[self.usd.pk][key] for key in ("total", "currency", "base_currency", "base_total")},
                         {"total": "20.00", "currency": "USD", "base_currency": "KZT", "base_total": "8978.80"})
        self.assertIsNone(listed[self.gbp.pk]["base_total"])
        detail = self.get(f"/api/receipts/{self.usd.pk}/")
        self.assertEqual((detail["total"], detail["base_currency"], detail["base_total"]), ("20.00", "KZT", "8978.80"))

    def test_limits_only_in_the_base_currency(self):
        client = APIClient()
        refused = client.post("/api/budget/limits/", {"category_id": self.fun.pk, "currency": "USD", "amount": "10"},
                              format="json")
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["error"]["fields"], {"currency": ["Лимиты задаются в основной валюте семьи — KZT."]})
        with localdate():
            listed = {row["id"]: row for row in client.get("/api/budget/limits/").json()["results"]}
        self.assertEqual({key: listed[self.usd_limit.pk][key] for key in ("amount", "currency", "base_currency", "base_amount")},
                         {"amount": "50.00", "currency": "USD", "base_currency": "KZT", "base_amount": "22447.00"})
        url = f"/api/budget/limits/{self.usd_limit.pk}/"
        self.assertEqual(client.patch(url, {"amount": "60"}, format="json").status_code, 400)
        moved = client.patch(url, {"amount": "25000", "currency": "KZT"}, format="json")
        self.assertEqual(moved.status_code, 200, moved.content)
        self.assertEqual((moved.json()["currency"], moved.json()["amount"]), ("KZT", "25000.00"))
        self.assertEqual(client.delete(f"/api/budget/limits/{self.food_limit.pk}/").status_code, 204)


@tag("integration")
@accounts_mode()
class FamilyBaseTests(FixtureMixin, TestCase):
    """Основная валюта семьи — выбор главного: у члена семьи итоги и лимиты в долларах."""

    @classmethod
    def owner(cls):
        cls.head, cls.member = make_user("base-head"), make_user("base-member")
        family = cls.family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=cls.head, household=family, role=Membership.Role.HEAD)
        Membership.objects.create(user=cls.member, household=family, role=Membership.Role.MEMBER)
        Profile.objects.create(user=cls.head, default_currency_id="USD")
        Profile.objects.create(user=cls.member, default_currency_id="KZT")
        return cls.member

    @classmethod
    def holder(cls, owner):
        return {"household": cls.family}

    def test_member_sees_the_family_in_the_head_currency(self):
        client = signed_in(self.member)
        with localdate():
            body = client.get("/api/dashboard/?month=2026-10").json()
        self.assertEqual((body["base_currency"], body["base"]["currency"]), ("USD", "USD"))
        # 10 000 ₸ / 448.94 = 22.27 $; 20 $; 10 € × 502.05 / 448.94 = 11.18 $
        self.assertEqual(body["base"]["spent"], "53.45")
        self.assertEqual(body["base"]["limit_total"], "116.82")  # 30 000 ₸ / 448.94 + 50 $
        settings = client.get("/api/me/settings/").json()
        self.assertEqual((settings["default_currency"], settings["base_currency"]), ("KZT", "USD"))
        refused = client.post("/api/budget/limits/", {"category_id": self.fun.pk, "currency": "KZT", "amount": "10"},
                              format="json")
        self.assertEqual(refused.json()["error"]["fields"], {"currency": ["Лимиты задаются в основной валюте семьи — USD."]})
        Profile.objects.filter(user=self.head).update(default_currency_id="KZT")
        with localdate():
            self.assertEqual(client.get("/api/dashboard/?month=2026-10").json()["base"]["spent"], "23999.30")
