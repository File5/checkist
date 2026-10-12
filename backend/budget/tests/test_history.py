"""Журнал лимитов: записи при создании, смене и удалении (API и админка), сумма в месяце,
``limits/`` «Динамики» и дашборд прошлого месяца по журналу, ``/api/budget/limits/history/``,
посевная миграция.

Данные вымышленные; модель распознавания не вызывается.
"""
from datetime import date, datetime, timedelta
from datetime import timezone as dt_timezone
from decimal import Decimal
from types import SimpleNamespace
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TestCase, TransactionTestCase, tag
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_AUTHENTICATED, TwoUsers, accounts_mode, local_single_mode, make_user
from budget import history
from budget.models import BudgetLimit, BudgetLimitChange
from budget.tests.test_dashboard_api import spend
from catalog.models import Category
from receipts.ownership import local_user
from stores.models import Currency

D = Decimal
LIMITS = "/api/budget/limits/"
HISTORY = "/api/budget/limits/history/"
TRENDS = "/api/stats/trends/limits/"
DASHBOARD = "/api/dashboard/"


def moment(year, month, day=15):
    return datetime(year, month, day, 12, tzinfo=dt_timezone.utc)


def at(when):
    """Время сервера для записи журнала."""
    return mock.patch("budget.history.timezone.now", return_value=when)


def rows(**filters):
    return list(BudgetLimitChange.objects.filter(**filters).order_by("changed_at", "pk").values_list(
        "category_id", "currency_id", "old_amount", "new_amount", "effective_month"))


def change(limit_owner, category, currency, old, new, month, *, by=None, when=None):
    """Запись журнала с заданным месяцем: прошлое без машины времени."""
    return BudgetLimitChange.objects.create(
        **limit_owner, category=category, currency_id=currency, old_amount=None if old is None else D(old),
        new_amount=None if new is None else D(new), changed_by=by, changed_at=when or moment(month.year, month.month),
        effective_month=month)


class ResolutionTests(SimpleTestCase):
    """Сумма в месяце — последняя запись не позже месяца; без журнала — текущая сумма."""

    def entry(self, pk, month, new, old=None, category=1, currency="KZT", day=15):
        return SimpleNamespace(pk=pk, category_id=category, currency_id=currency, old_amount=old, new_amount=new,
                               effective_month=month, changed_at=datetime(month.year, month.month, day),
                               category=SimpleNamespace(name="Демо"))

    def test_amount_at_and_series(self):
        june, july, august, september = (date(2026, m, 1) for m in (6, 7, 8, 9))
        changes = [
            self.entry(3, august, D("150"), D("120"), day=2),
            self.entry(1, june, D("100")),
            self.entry(2, june, D("120"), D("100"), day=20),  # тот же месяц: последняя запись решает
            self.entry(4, september, None, D("150")),
        ]
        ordered = history._ordered(changes)[(1, "KZT")]
        self.assertEqual([history.amount_at(ordered, month) for month in (date(2026, 5, 1), june, july, august, september)],
                         [None, D("120"), D("120"), D("150"), None])
        (row,) = history.series([], changes, [july, august, september])
        self.assertEqual((row.limit, row.amounts), (None, [D("120"), D("150"), None]))
        self.assertEqual(row.changed, {august: (D("120"), D("150")), september: (D("150"), None)})
        # Удалён до окна — пары нет; без журнала — текущая сумма во всех месяцах.
        self.assertEqual(history.series([], changes, [date(2026, 10, 1)]), [])
        legacy = SimpleNamespace(pk=9, category_id=2, currency_id="EUR", amount=D("5"))
        (only,) = history.series([legacy], [], [june, july])
        self.assertEqual((only.limit, only.amounts, only.changed), (legacy, [D("5"), D("5")], {}))

    def test_limits_at(self):
        june, august = date(2026, 6, 1), date(2026, 8, 1)
        current = SimpleNamespace(pk=7, category_id=1, currency_id="KZT", amount=D("150"),
                                  category=SimpleNamespace(name="Демо"))
        changes = [self.entry(1, june, D("100")), self.entry(2, august, D("150"), D("100")),
                   self.entry(3, june, D("40"), category=2), self.entry(4, august, None, D("40"), category=2)]
        july = history.limits_at([current], changes, date(2026, 7, 1))
        self.assertEqual([(item.pk, item.category_id, item.amount) for item in july], [(7, 1, D("100")), (None, 2, D("40"))])
        self.assertEqual([(item.pk, item.amount) for item in history.limits_at([current], changes, august)], [(7, D("150"))])
        self.assertEqual(history.limits_at([current], changes, date(2026, 5, 1)), [])


class CategoriesMixin:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.food = Category.objects.create(name="Демо-продукты")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)
        cls.transport = Category.objects.create(name="Демо-транспорт")


@tag("integration")
@local_single_mode()
class WritePathTests(CategoriesMixin, TestCase):
    """API пишет журнал в одной транзакции с лимитом."""

    def setUp(self):
        self.client = APIClient()

    def test_create_update_delete_write_changes(self):
        with at(moment(2026, 7, 3)):
            created = self.client.post(LIMITS, {"category_id": self.food.pk, "currency": "KZT", "amount": "120000"},
                                       format="json").json()
        url = f"{LIMITS}{created['id']}/"
        with at(moment(2026, 8, 10)):
            self.client.patch(url, {"amount": "150000"}, format="json")
            self.client.patch(url, {"amount": "150000.00"}, format="json")  # та же сумма — без записи
        with at(moment(2026, 9, 1)):
            self.assertEqual(self.client.delete(url).status_code, 204)
        self.assertEqual(rows(), [
            (self.food.pk, "KZT", None, D("120000.00"), date(2026, 7, 1)),
            (self.food.pk, "KZT", D("120000.00"), D("150000.00"), date(2026, 8, 1)),
            (self.food.pk, "KZT", D("150000.00"), None, date(2026, 9, 1)),
        ])
        self.assertEqual(set(BudgetLimitChange.objects.values_list("user", "household", "changed_by")),
                         {(local_user().pk, None, local_user().pk)})

    def test_move_to_another_category_is_delete_and_create(self):
        created = self.client.post(LIMITS, {"category_id": self.food.pk, "currency": "KZT", "amount": "100"},
                                   format="json").json()
        self.client.patch(f"{LIMITS}{created['id']}/", {"category_id": self.transport.pk, "amount": "90"}, format="json")
        self.assertEqual([row[:4] for row in rows()], [
            (self.food.pk, "KZT", None, D("100.00")),
            (self.food.pk, "KZT", D("100.00"), None),
            (self.transport.pk, "KZT", None, D("90.00")),
        ])

    def test_refused_save_writes_nothing(self):
        self.client.post(LIMITS, {"category_id": self.food.pk, "currency": "KZT", "amount": "100"}, format="json")
        other = self.client.post(LIMITS, {"category_id": self.transport.pk, "currency": "KZT", "amount": "5"},
                                 format="json").json()
        before = BudgetLimitChange.objects.count()
        duplicate = self.client.post(LIMITS, {"category_id": self.food.pk, "currency": "KZT", "amount": "7"}, format="json")
        moved = self.client.patch(f"{LIMITS}{other['id']}/", {"category_id": self.food.pk}, format="json")
        self.assertEqual((duplicate.status_code, moved.status_code), (400, 400))
        self.assertEqual(BudgetLimitChange.objects.count(), before)
        self.assertEqual(self.client.delete(f"{LIMITS}999999/").status_code, 404)
        self.assertEqual(BudgetLimitChange.objects.count(), before)


@tag("integration")
@accounts_mode()
class AdminWritePathTests(CategoriesMixin, TestCase):
    """Админка — тот же сервис: добавление, правка, удаление и массовое удаление пишут журнал."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.admin = get_user_model().objects.create_superuser("synthetic-admin", password="unused-password-123")
        cls.owner = make_user("synthetic-user-one")

    def setUp(self):
        self.client.force_login(self.admin)

    def form(self, category, amount):
        return {"household": "", "user": self.owner.pk, "category": category.pk, "currency": "KZT", "amount": amount}

    def test_admin_paths(self):
        base = "/admin/budget/budgetlimit/"
        self.assertEqual(self.client.post(f"{base}add/", self.form(self.food, "100")).status_code, 302)
        limit = BudgetLimit.objects.get()
        self.assertEqual(self.client.post(f"{base}{limit.pk}/change/", self.form(self.food, "130")).status_code, 302)
        self.assertEqual(self.client.post(f"{base}{limit.pk}/delete/", {"post": "yes"}).status_code, 302)
        second = BudgetLimit.objects.create(user=self.owner, category=self.transport, currency_id="KZT", amount=D("5"))
        bulk = self.client.post(base, {"action": "delete_selected", "_selected_action": [second.pk], "post": "yes"})
        self.assertEqual(bulk.status_code, 302)
        self.assertFalse(BudgetLimit.objects.exists())
        self.assertEqual([row[:4] for row in rows()], [
            (self.food.pk, "KZT", None, D("100.00")),
            (self.food.pk, "KZT", D("100.00"), D("130.00")),
            (self.food.pk, "KZT", D("130.00"), None),
            (self.transport.pk, "KZT", D("5.00"), None),
        ])
        self.assertEqual(set(BudgetLimitChange.objects.values_list("user", "changed_by")), {(self.owner.pk, self.admin.pk)})
        # Журнал в админке — только чтение.
        entry = BudgetLimitChange.objects.first()
        self.assertEqual(self.client.get("/admin/budget/budgetlimitchange/").status_code, 200)
        self.assertEqual(self.client.get("/admin/budget/budgetlimitchange/add/").status_code, 403)
        page = self.client.get(f"/admin/budget/budgetlimitchange/{entry.pk}/change/")
        self.assertEqual(page.status_code, 200)
        self.assertNotContains(page, 'name="_save"')


class TrendsFixtureMixin(CategoriesMixin):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        owner = cls.fixture_owner()
        for total, on in (("100", date(2026, 6, 5)), ("100", date(2026, 7, 5)), ("150", date(2026, 8, 5)),
                          ("90", date(2026, 9, 5))):
            spend(owner, cls.dairy, total, on)


@tag("integration")
@local_single_mode()
class TrendsAndDashboardTests(TrendsFixtureMixin, TestCase):
    @classmethod
    def fixture_owner(cls):
        return local_user()

    def setUp(self):
        owner = {"user": local_user()}
        # Продукты: 200 с июня, 100 с августа; транспорт удалён в сентябре; молочное заведено в октябре.
        self.food_limit = BudgetLimit.objects.create(**owner, category=self.food, currency_id="KZT", amount=D("100"))
        change(owner, self.food, "KZT", None, "200", date(2026, 6, 1))
        change(owner, self.food, "KZT", "200", "100", date(2026, 8, 1))
        change(owner, self.transport, "KZT", None, "50", date(2026, 5, 1))
        change(owner, self.transport, "KZT", "50", None, date(2026, 9, 1))
        self.dairy_limit = BudgetLimit.objects.create(**owner, category=self.dairy, currency_id="KZT", amount=D("80"))
        change(owner, self.dairy, "KZT", None, "80", date(2026, 10, 1))

    def test_trends_use_each_months_limit(self):
        body = APIClient().get(f"{TRENDS}?from=2026-06&to=2026-09").json()
        food, dairy, transport = body["limits"]
        self.assertEqual((food["id"], food["amount"]), (self.food_limit.pk, "100.00"))
        self.assertEqual([(m["limit"], m["spent"], m["percent"], m["change"]) for m in food["months"]], [
            ("200.00", "100.00", "50.00", {"old": None, "new": "200.00"}),
            ("200.00", "100.00", "50.00", None),
            ("100.00", "150.00", "150.00", {"old": "200.00", "new": "100.00"}),
            ("100.00", "90.00", "90.00", None),
        ])
        # Молочное заведено после окна: строка есть, лимита в месяцах нет.
        self.assertEqual((dairy["id"], [(m["limit"], m["percent"]) for m in dairy["months"]]),
                         (self.dairy_limit.pk, [(None, None)] * 4))
        # Удалённый транспорт: строка без id и текущей суммы, лимит до сентября.
        self.assertEqual((transport["id"], transport["amount"]), (None, None))
        self.assertEqual([(m["limit"], m["percent"], m["change"]) for m in transport["months"]], [
            ("50.00", "0.00", None), ("50.00", "0.00", None), ("50.00", "0.00", None),
            (None, None, {"old": "50.00", "new": None}),
        ])
        # Окно после удаления транспорта — его строки нет.
        later = APIClient().get(f"{TRENDS}?from=2026-10&to=2026-10").json()
        self.assertEqual([row["category"]["id"] for row in later["limits"]], [self.food.pk, self.dairy.pk])

    def dashboard(self, month):
        with mock.patch("api.views.budget.timezone.localdate", return_value=date(2026, 10, 12)):
            response = APIClient().get(f"{DASHBOARD}?month={month}")
        self.assertEqual(response.status_code, 200, response.content)
        (kzt,) = response.json()["currencies"]
        return kzt

    def test_dashboard_past_month_shows_that_months_limits(self):
        july = self.dashboard("2026-07")
        self.assertEqual(july["limit_total"], "250.00")  # продукты 200 + транспорт 50
        self.assertEqual([(row["name"], row["limit"], row["limit_id"]) for row in july["categories"]], [
            ("Демо-продукты", "200.00", self.food_limit.pk), ("Демо-транспорт", "50.00", None)])
        self.assertEqual(july["categories"][0]["children"][0]["limit"], None)  # молочное — с октября
        september = self.dashboard("2026-09")
        self.assertEqual([(row["name"], row["limit"]) for row in september["categories"]], [("Демо-продукты", "100.00")])
        october = self.dashboard("2026-10")  # текущий — нынешние лимиты
        self.assertEqual((october["limit_total"], october["categories"][0]["children"][0]["limit"]), ("100.00", "80.00"))
        self.assertEqual(self.dashboard("2026-11")["limit_total"], "100.00")  # будущий — тоже нынешние

    def test_query_counts_do_not_grow_with_changes(self):
        def count(url):
            with mock.patch("api.views.budget.timezone.localdate", return_value=date(2026, 10, 12)), \
                    CaptureQueriesContext(connection) as queries:
                self.assertEqual(APIClient().get(url).status_code, 200)
            return len(queries)

        urls = (f"{TRENDS}?from=2026-06&to=2026-09", f"{DASHBOARD}?month=2026-07", f"{HISTORY}?from=2026-01&to=2026-10")
        before = [count(url) for url in urls]
        owner = {"user": local_user()}
        for number in range(12):
            category = Category.objects.create(name=f"Демо-категория {number}", parent=self.food)
            change(owner, category, "KZT", None, "10", date(2026, 6, 1), by=local_user())
            # Одна валюта: число валют — своя переменная запросов дашборда (основная валюта профиля).
            change(owner, category, "KZT", "10", "11", date(2026, 7, 1), by=local_user())
            change(owner, category, "KZT", "11", "12", date(2026, 8, 1), by=local_user())
        self.assertEqual([count(url) for url in urls], before)
        self.assertEqual(before[2], 4)  # категории, пользователь local, лимиты, журнал


@tag("integration")
@local_single_mode()
class HistoryAPITests(TrendsFixtureMixin, TestCase):
    @classmethod
    def fixture_owner(cls):
        return local_user()

    def get(self, query="", status=200):
        with mock.patch("api.views.budget_history.timezone.localdate", return_value=date(2026, 10, 12)):
            response = APIClient().get(f"{HISTORY}?{query}")
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def test_changes_and_series(self):
        local = local_user()
        local.first_name = "Андрей"
        local.save(update_fields=["first_name"])
        with at(moment(2026, 7, 3)):
            created = APIClient().post(LIMITS, {"category_id": self.dairy.pk, "currency": "KZT", "amount": "120000"},
                                       format="json").json()
        with at(moment(2026, 9, 20)):
            APIClient().patch(f"{LIMITS}{created['id']}/", {"amount": "150000"}, format="json")
        with at(moment(2026, 10, 2)):
            eur = APIClient().post(LIMITS, {"category_id": self.food.pk, "currency": "EUR", "amount": "50"},
                                   format="json").json()
            APIClient().delete(f"{LIMITS}{eur['id']}/")
        body = self.get("from=2026-07&to=2026-10")
        self.assertEqual((body["months"], body["month_from"], body["month_to"]), (4, "2026-07", "2026-10"))
        self.assertEqual([(c["kind"], c["currency"], c["old_amount"], c["new_amount"], c["change_percent"], c["effective_month"])
                          for c in body["changes"]], [
            ("deleted", "EUR", "50.00", None, None, "2026-10"),
            ("created", "EUR", None, "50.00", None, "2026-10"),
            ("changed", "KZT", "120000.00", "150000.00", "25.00", "2026-09"),
            ("created", "KZT", None, "120000.00", None, "2026-07"),
        ])
        latest = body["changes"][2]
        self.assertEqual(latest["changed_by"], {"username": "local", "display_name": "Андрей"})
        self.assertEqual(latest["changed_at"], "2026-09-20T12:00:00Z")
        self.assertEqual(latest["category"], {"id": self.dairy.pk, "name": "Демо-молочное", "path": [
            {"id": self.food.pk, "name": "Демо-продукты"}, {"id": self.dairy.pk, "name": "Демо-молочное"}]})
        self.assertEqual([(s["category"]["id"], s["currency"], s["limit_id"], s["amount"], [m["amount"] for m in s["months"]])
                          for s in body["series"]], [
            (self.food.pk, "EUR", None, None, [None, None, None, None]),
            (self.dairy.pk, "KZT", created["id"], "150000.00", ["120000.00", "120000.00", "150000.00", "150000.00"]),
        ][1:])  # EUR создан и удалён в одном месяце — суммы ни в одном месяце нет, ряда нет
        # Окно и фильтры.
        self.assertEqual(len(self.get("from=2026-08&to=2026-09")["changes"]), 1)
        self.assertEqual([c["currency"] for c in self.get("from=2026-07&to=2026-10&currency=eur")["changes"]], ["EUR", "EUR"])
        only_dairy = self.get(f"from=2026-07&to=2026-10&category={self.dairy.pk}")
        self.assertEqual(({c["category"]["id"] for c in only_dairy["changes"]}, len(only_dairy["series"])), ({self.dairy.pk}, 1))
        self.assertEqual(self.get(f"category={self.food.pk}&currency=KZT")["changes"], [])
        default = self.get()
        self.assertEqual((default["months"], default["month_to"]), (12, "2026-10"))
        change({"user": local}, self.food, "KZT", None, "10", date(2024, 2, 1))
        older = self.get()
        self.assertEqual((older["months"], older["month_from"], len(older["changes"])), (33, "2024-02", 5))
        change({"user": local}, self.food, "KZT", "10", "11", date(2019, 1, 1))
        self.assertEqual((self.get()["months"], self.get()["month_from"]), (60, "2021-11"))

    def test_invalid_params(self):
        fields = self.get("currency=EURO&category=abc&from=2026-13", status=400)["error"]["fields"]
        self.assertEqual(set(fields), {"currency", "category", "from"})
        self.assertEqual(APIClient().post(HISTORY, {}, format="json").status_code, 405)


@tag("integration")
@accounts_mode()
class FamilyVisibilityTests(TrendsFixtureMixin, TwoUsers, TestCase):
    """Журнал семьи видят все её члены; ``second`` вне семьи — только свой."""

    @classmethod
    def fixture_owner(cls):
        cls.third = make_user("synthetic-user-three")
        cls.family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=cls.family)
        return cls.third

    def test_family_shares_history_outsider_does_not(self):
        family_client = self.client_of(self.first, csrf=True)
        created = family_client.post(LIMITS, {"category_id": self.food.pk, "currency": "KZT", "amount": "100"},
                                     format="json").json()
        third = self.client_of(self.third, csrf=True)
        self.assertEqual(third.patch(f"{LIMITS}{created['id']}/", {"amount": "120"}, format="json").status_code, 200)
        self.client_of(self.second, csrf=True).post(
            LIMITS, {"category_id": self.food.pk, "currency": "KZT", "amount": "7"}, format="json")
        entry = BudgetLimitChange.objects.filter(household=self.family).order_by("pk").first()
        self.assertEqual((entry.user_id, entry.changed_by_id), (None, self.first.pk))
        for account in (self.first, self.third):
            changes = self.client_of(account).get(HISTORY).json()["changes"]
            self.assertEqual([(c["changed_by"]["username"], c["new_amount"]) for c in changes],
                             [("synthetic-user-three", "120.00"), ("synthetic-user-one", "100.00")])
        own = self.client_of(self.second).get(HISTORY).json()
        self.assertEqual([c["new_amount"] for c in own["changes"]], ["7.00"])
        self.assertEqual([s["amount"] for s in own["series"]], ["7.00"])
        self.assertEqual(APIClient().get(HISTORY).json(), NOT_AUTHENTICATED)


@tag("integration")
class SeedMigrationTests(TransactionTestCase):
    """``budget.0003_seed_limit_changes``: одна запись «создан» на лимит, месяц ``created_at``; откат — пусто."""

    BEFORE = ("budget", "0002_budgetlimitchange")
    SEED = ("budget", "0003_seed_limit_changes")

    def setUp(self):
        self.addCleanup(self.migrate, None)
        self.currency = Currency.objects.create(code="XTS", name="Тестовая валюта")
        self.owner = make_user("synthetic-migration-user")
        self.category = Category.objects.create(name="Демо-миграция")

    def migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.migrate([target] if target else executor.loader.graph.leaf_nodes())

    def test_seed_and_rollback(self):
        self.migrate(self.BEFORE)
        limit = BudgetLimit.objects.create(user=self.owner, category=self.category, currency=self.currency, amount=D("120"))
        created = moment(2026, 3, 31) - timedelta(hours=1)
        BudgetLimit.objects.filter(pk=limit.pk).update(created_at=created, amount=D("150"))
        self.migrate(self.SEED)
        self.assertEqual(list(BudgetLimitChange.objects.values_list(
            "user_id", "category_id", "currency_id", "old_amount", "new_amount", "changed_by", "changed_at", "effective_month")),
            [(self.owner.pk, self.category.pk, "XTS", None, D("150.00"), None, created, date(2026, 3, 1))])
        self.migrate(self.BEFORE)
        self.assertFalse(BudgetLimitChange.objects.exists())
