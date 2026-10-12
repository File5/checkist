"""``GET /api/dashboard/``: суммы месяца на небольшом наборе, лимиты, последние траты, видимость.

Данные вымышленные; модель распознавания не вызывается.
"""
from datetime import date, time
from decimal import Decimal
from unittest import mock

from django.db import connection
from django.test import SimpleTestCase, TestCase, tag
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api import common
from api.tests.accounts_helpers import TwoUsers, accounts_mode, local_single_mode, make_user
from api.tests.factories import make_product, make_receipt
from budget.dashboard import Month, days_left
from budget.models import BudgetLimit
from catalog.models import Category, GenericProduct
from catalog.units import BaseUnit
from receipts import manual
from receipts.models import ReceiptLine
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line

D = Decimal
DASHBOARD = "/api/dashboard/"


class MonthTests(SimpleTestCase):
    def test_bounds_previous_and_days_left(self):
        self.assertEqual((Month(2026, 2).first, Month(2026, 2).last), (date(2026, 2, 1), date(2026, 2, 28)))
        self.assertEqual(Month(2026, 1).previous(), Month(2025, 12))
        self.assertEqual(Month(2026, 10).label(), "2026-10")
        self.assertEqual(days_left(Month(2026, 10), date(2026, 10, 12)), 20)
        self.assertEqual(days_left(Month(2026, 10), date(2026, 10, 31)), 1)
        self.assertEqual(days_left(Month(2026, 9), date(2026, 10, 12)), 0)
        self.assertEqual(days_left(Month(2026, 11), date(2026, 10, 12)), 0)


def spend(owner, category, total, on, currency="KZT", **body):
    return manual.create(owner, {"total": total, "currency": currency, "category": category.pk,
                                 "purchased_on": on.isoformat(), **body})


class FixtureMixin:
    """Октябрь 2026: фото-чек и ручные траты в KZT, трата в EUR, сентябрь — прошлый месяц."""

    owner = None

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        owner = cls.fixture_owner()
        cls.food = Category.objects.create(name="Демо-продукты")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)
        cls.cafe = Category.objects.create(name="Демо-кафе")
        cls.coffee = Category.objects.create(name="Демо-кофейни", parent=cls.cafe)
        cls.transport = Category.objects.create(name="Демо-транспорт")
        cls.unassigned, _ = Category.objects.get_or_create(name="Не разобрано", parent=None)
        milk = make_product(GenericProduct.objects.create(name="Демо-молоко", category=cls.dairy, base_unit=BaseUnit.L),
                            "Демо-молоко 1 л")
        bread = make_product(
            GenericProduct.objects.create(name="Демо-новое", category=cls.unassigned, base_unit=BaseUnit.PCS), "Демо-хлеб")
        cls.store = samples.lidl_store()
        cls.photo = make_receipt(cls.store, "KZT", date(2026, 10, 5), owner=owner, total=D("1000.00"))
        make_line(cls.photo, position=1, product=milk, amount=D("600.00"), discount_amount=D("50.00"))
        make_line(cls.photo, position=2, raw_name="Нечитаемое", amount=D("200.00"))
        make_line(cls.photo, position=3, product=bread, amount=D("100.00"))
        make_line(cls.photo, position=4, kind=ReceiptLine.Kind.SERVICE, raw_name="Пакет", amount=D("150.00"))
        cls.coffee_spend = spend(owner, cls.coffee, "450", date(2026, 10, 10), note="Капучино")
        cls.euro = spend(owner, cls.food, "12.50", date(2026, 10, 3), currency="EUR")
        spend(owner, cls.food, "2000", date(2026, 9, 30))
        spend(owner, cls.cafe, "1", date(2026, 11, 1))
        spend(owner, cls.cafe, "7", date(2026, 8, 31))
        cls.limits = cls.fixture_limits(owner)

    @classmethod
    def fixture_limits(cls, owner, **holder):
        holder = holder or {"user": owner}
        return {
            "food": BudgetLimit.objects.create(**holder, category=cls.food, currency_id="KZT", amount=D("120000")),
            "transport": BudgetLimit.objects.create(**holder, category=cls.transport, currency_id="KZT", amount=D("30000")),
            "euro": BudgetLimit.objects.create(**holder, category=cls.food, currency_id="EUR", amount=D("100")),
        }


@tag("integration")
@local_single_mode()
class DashboardNumbersTests(FixtureMixin, TestCase):
    @classmethod
    def fixture_owner(cls):
        return local_user()

    def get(self, query="?month=2026-10", today=date(2027, 1, 15)):
        # «Сегодня» сервера фиксировано: от него зависят месяц по умолчанию и days_left.
        with mock.patch("api.views.budget.timezone.localdate", return_value=today):
            response = APIClient().get(DASHBOARD + query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_month_numbers(self):
        body = self.get()
        self.assertEqual((body["month"], body["previous_month"], body["days_left"]), ("2026-10", "2026-09", 0))
        self.assertEqual(body["members"], ["local"])
        self.assertEqual(body["people"], [{"username": "local", "display_name": "local"}])
        eur, kzt = body["currencies"]  # по коду валюты
        self.assertEqual(eur, {
            "currency": "EUR", "spent": "12.50", "previous_spent": "0.00", "limit_total": "100.00",
            "limited_spent": "12.50",
            "categories": [{"category_id": self.food.pk, "name": "Демо-продукты", "spent": "12.50",
                            "limit": "100.00", "limit_id": self.limits["euro"].pk, "children": []}],
        })
        self.assertEqual(
            {key: kzt[key] for key in ("currency", "spent", "previous_spent", "limit_total")},
            {"currency": "KZT", "spent": "1450.00", "previous_spent": "2000.00", "limit_total": "150000.00"})
        self.assertEqual([(row["name"], row["spent"], row["limit"], row["limit_id"]) for row in kzt["categories"]], [
            ("Демо-продукты", "550.00", "120000.00", self.limits["food"].pk),  # молоко со скидкой, свёрнуто в корень
            ("Демо-кафе", "450.00", None, None),  # ручная трата в дочерней категории
            ("Не разобрано", "100.00", None, None),
            ("Демо-транспорт", "0.00", "30000.00", self.limits["transport"].pk),
        ])
        # Общий лимит сравнивается только с категориями под лимитом: 550 + 0, а не все 1 450.
        self.assertEqual(kzt["limited_spent"], "550.00")
        self.assertEqual(kzt["categories"][0]["category_id"], self.food.pk)
        self.assertEqual([row["children"] for row in kzt["categories"]], [[], [], [], []])

    def test_previous_month_and_empty_month(self):
        september = self.get("?month=2026-09")
        kzt = september["currencies"][1]
        self.assertEqual((september["previous_month"], kzt["spent"], kzt["previous_spent"]), ("2026-08", "2000.00", "7.00"))
        self.assertEqual([currency["currency"] for currency in september["currencies"]], ["EUR", "KZT"])
        self.assertEqual(september["currencies"][0]["spent"], "0.00")
        BudgetLimit.objects.all().delete()
        self.assertEqual(self.get("?month=2025-01")["currencies"], [])

    def test_current_month_by_default(self):
        body = self.get("", today=date(2026, 10, 12))
        self.assertEqual((body["month"], body["days_left"]), ("2026-10", 20))

    def test_recent(self):
        recent = self.get()["recent"]
        self.assertEqual(len(recent), 6)
        self.assertEqual(recent[0]["purchased_on"], "2026-11-01")
        photo = next(row for row in recent if row["id"] == self.photo.pk)
        self.assertEqual(photo, {
            "id": self.photo.pk, "source": "photo", "title": common.store_name(self.store),
            "category_name": "Демо-продукты", "owner": "local", "owner_name": "local", "purchased_on": "2026-10-05",
            "total": "1000.00", "currency": "KZT", "lines_count": 4,
        })
        coffee = next(row for row in recent if row["id"] == self.coffee_spend.pk)
        self.assertEqual((coffee["source"], coffee["title"], coffee["category_name"], coffee["lines_count"]),
                         ("manual", "Капучино", "Демо-кафе", 1))
        euro = next(row for row in recent if row["id"] == self.euro.pk)
        self.assertEqual(euro["title"], "Демо-продукты")
        dates = [row["purchased_on"] for row in recent]
        self.assertEqual(dates, sorted(dates, reverse=True))

    def test_recent_category_follows_the_merge_survivor_like_the_categories_block(self):
        from api.tests.test_stats_spending import absorb

        stray = make_product(
            GenericProduct.objects.create(name="Демо-латте", category=self.coffee, base_unit=BaseUnit.PCS), "Демо-латте")
        survivor = make_product(
            GenericProduct.objects.create(name="Демо-проезд", category=self.transport, base_unit=BaseUnit.PCS),
            "Демо-проезд")
        absorb(survivor, stray)
        receipt = make_receipt(self.store, "KZT", date(2026, 10, 20), owner=local_user(), total=D("300.00"))
        make_line(receipt, position=1, product=stray, amount=D("300.00"))
        body = self.get()
        kzt = body["currencies"][1]
        self.assertEqual(next(row for row in kzt["categories"] if row["category_id"] == self.transport.pk)["spent"],
                         "300.00")
        row = next(row for row in body["recent"] if row["id"] == receipt.pk)
        self.assertEqual(row["category_name"], "Демо-транспорт")

    def test_recent_is_limited_to_ten(self):
        for day in range(1, 8):
            spend(local_user(), self.cafe, "1", date(2026, 7, day))
        self.assertEqual(len(self.get()["recent"]), 10)

    def test_query_count_does_not_grow(self):
        with CaptureQueriesContext(connection) as before:
            self.get()
        for day in range(1, 8):
            spend(local_user(), self.coffee, "3", date(2026, 10, day), note="Ещё")
        with CaptureQueriesContext(connection) as after:
            self.get()
        self.assertEqual(len(after), len(before))

    def test_invalid_month(self):
        for value in ("2026-13", "2026-1", "26-10", "2026-10-01", "1900-01", "abcd-ef"):
            response = APIClient().get(f"{DASHBOARD}?month={value}")
            self.assertEqual(response.status_code, 400, value)
            self.assertEqual(response.json()["error"]["fields"], {"month": ["Месяц в формате ГГГГ-ММ."]})

    def test_post_not_allowed(self):
        self.assertEqual(APIClient().post(DASHBOARD, {}, format="json").status_code, 405)


@tag("integration")
@accounts_mode()
class DashboardFamilyTests(FixtureMixin, TwoUsers, TestCase):
    """Чеки и лимиты ``first`` видит ``third`` из той же семьи; ``second`` — нет."""

    @classmethod
    def fixture_owner(cls):
        cls.third = make_user("synthetic-user-three")
        cls.family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=cls.family)
        return cls.third

    @classmethod
    def fixture_limits(cls, owner, **holder):
        return super().fixture_limits(owner, household=cls.family)

    def get(self, account):
        response = self.client_of(account).get(DASHBOARD + "?month=2026-10")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_family_member_sees_family_month(self):
        spend(self.first, self.cafe, "50", date(2026, 10, 11))
        self.first.first_name = "Андрей"
        self.first.save(update_fields=["first_name"])
        body = self.get(self.first)
        self.assertEqual(body["members"], ["synthetic-user-one", "synthetic-user-three"])
        self.assertEqual(body["people"], [{"username": "synthetic-user-one", "display_name": "Андрей"},
                                          {"username": "synthetic-user-three", "display_name": "synthetic-user-three"}])
        self.assertEqual({(row["owner"], row["owner_name"]) for row in body["recent"]},
                         {("synthetic-user-one", "Андрей"), ("synthetic-user-three", "synthetic-user-three")})
        kzt = body["currencies"][1]
        self.assertEqual((kzt["spent"], kzt["limit_total"]), ("1500.00", "150000.00"))
        self.assertEqual({row["owner"] for row in body["recent"]}, {"synthetic-user-one", "synthetic-user-three"})

    def test_outsider_sees_only_own(self):
        spend(self.second, self.cafe, "70", date(2026, 10, 11))
        BudgetLimit.objects.create(user=self.second, category=self.cafe, currency_id="KZT", amount=D("500"))
        body = self.get(self.second)
        self.assertEqual(body["members"], ["synthetic-user-two"])
        self.assertEqual(body["currencies"], [{
            "currency": "KZT", "spent": "70.00", "previous_spent": "0.00", "limit_total": "500.00",
            "limited_spent": "70.00",
            "categories": [{"category_id": self.cafe.pk, "name": "Демо-кафе", "spent": "70.00", "limit": "500.00",
                            "limit_id": BudgetLimit.objects.get(user=self.second).pk, "children": []}],
        }])
        self.assertEqual([row["owner"] for row in body["recent"]], ["synthetic-user-two"])


@tag("integration")
@local_single_mode()
class DashboardSubLimitsTests(FixtureMixin, TestCase):
    """Лимиты подкатегорий: строки в ``children`` корня, траты потомков входят в предка."""

    @classmethod
    def fixture_owner(cls):
        return local_user()

    @classmethod
    def fixture_limits(cls, owner, **holder):
        limits = super().fixture_limits(owner, **holder)
        cls.cheese = Category.objects.create(name="Демо-сыр", parent=cls.dairy)
        cls.bakery = Category.objects.create(name="Демо-выпечка", parent=cls.food)
        spend(owner, cls.cheese, "70", date(2026, 10, 7))
        spend(owner, cls.bakery, "30", date(2026, 10, 8))
        limits["cheese"] = BudgetLimit.objects.create(user=owner, category=cls.cheese, currency_id="KZT", amount=D("50"))
        limits["coffee"] = BudgetLimit.objects.create(user=owner, category=cls.coffee, currency_id="KZT", amount=D("400"))
        limits["coffee_eur"] = BudgetLimit.objects.create(
            user=owner, category=cls.coffee, currency_id="EUR", amount=D("5"))
        return limits

    def get(self):
        with mock.patch("api.views.budget.timezone.localdate", return_value=date(2027, 1, 15)):
            response = APIClient().get(DASHBOARD + "?month=2026-10")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_nested_children_roll_up_descendants(self):
        eur, kzt = self.get()["currencies"]
        # Вложенный лимит — часть лимита предка: «Демо-сыр» под лимитом «Демо-продукты» в сумму не входит,
        # «Демо-кофейни» без лимита у предка — входит.
        self.assertEqual(kzt["limit_total"], "150400.00")
        # Траты тех же категорий: «Демо-продукты» 650 (сыр внутри) + «Демо-кофейни» 450.
        self.assertEqual(kzt["limited_spent"], "1100.00")
        food, cafe, unassigned, transport = kzt["categories"]
        self.assertEqual((food["name"], food["spent"], food["limit"]), ("Демо-продукты", "650.00", "120000.00"))
        # «Демо-выпечка» без лимита и без лимитов внутри в карточку не попадает; «Демо-молочное» — предок лимита.
        self.assertEqual(food["children"], [{
            "category_id": self.dairy.pk, "name": "Демо-молочное", "spent": "620.00", "limit": None, "limit_id": None,
            "children": [{"category_id": self.cheese.pk, "name": "Демо-сыр", "spent": "70.00", "limit": "50.00",
                          "limit_id": self.limits["cheese"].pk, "children": []}],
        }])
        self.assertEqual((cafe["name"], cafe["spent"], cafe["limit"]), ("Демо-кафе", "450.00", None))
        self.assertEqual(cafe["children"], [{
            "category_id": self.coffee.pk, "name": "Демо-кофейни", "spent": "450.00", "limit": "400.00",
            "limit_id": self.limits["coffee"].pk, "children": []}])
        self.assertEqual((unassigned["children"], transport["children"]), ([], []))
        # Корень без трат в валюте появляется ради лимита подкатегории — с нулём.
        self.assertEqual(eur["limit_total"], "105.00")
        self.assertEqual(eur["limited_spent"], "12.50")
        self.assertEqual([(row["name"], row["spent"], row["limit"]) for row in eur["categories"]],
                         [("Демо-продукты", "12.50", "100.00"), ("Демо-кафе", "0.00", None)])
        self.assertEqual(eur["categories"][1]["children"], [{
            "category_id": self.coffee.pk, "name": "Демо-кофейни", "spent": "0.00", "limit": "5.00",
            "limit_id": self.limits["coffee_eur"].pk, "children": []}])

    def test_query_count_does_not_depend_on_sub_limits(self):
        with CaptureQueriesContext(connection) as before:
            self.get()
        extra = Category.objects.create(name="Демо-латте", parent=self.coffee)
        BudgetLimit.objects.create(user=local_user(), category=extra, currency_id="KZT", amount=D("10"))
        BudgetLimit.objects.create(user=local_user(), category=self.bakery, currency_id="KZT", amount=D("10"))
        with CaptureQueriesContext(connection) as after:
            body = self.get()
        self.assertEqual(len(after), len(before))
        cafe = body["currencies"][1]["categories"][1]
        self.assertEqual([row["name"] for row in cafe["children"][0]["children"]], ["Демо-латте"])
