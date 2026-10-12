"""``budget.BudgetLimit``: ограничения БД, проверка формы, админка, откат миграции."""
from decimal import Decimal

from django.contrib import admin
from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.models.deletion import ProtectedError
from django.test import TestCase, TransactionTestCase, tag

from accounts.models import Household
from api.tests.accounts_helpers import make_user
from budget.admin import BudgetLimitAdmin
from budget.models import BudgetLimit
from catalog.models import Category

D = Decimal


@tag("integration")
class BudgetLimitModelTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = make_user("synthetic-budget-user")
        cls.family = Household.objects.create(name="Демо-семья бюджета")
        cls.food = Category.objects.create(name="Демо-продукты")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)

    def make(self, **fields):
        fields.setdefault("category", self.food)
        fields.setdefault("currency_id", "KZT")
        fields.setdefault("amount", D("100.00"))
        return BudgetLimit.objects.create(**fields)

    def assert_rejected(self, **fields):
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.make(**fields)

    def test_exactly_one_owner(self):
        self.assert_rejected()
        self.assert_rejected(user=self.user, household=self.family)
        self.make(user=self.user)
        self.make(household=self.family)

    def test_amount_positive(self):
        self.assert_rejected(user=self.user, amount=D("0.00"))
        self.assert_rejected(user=self.user, amount=D("-1.00"))

    def test_unique_per_owner_category_currency(self):
        self.make(user=self.user)
        self.assert_rejected(user=self.user)
        self.make(user=self.user, currency_id="EUR")
        self.make(household=self.family)
        self.assert_rejected(household=self.family)
        other = make_user("synthetic-budget-other")
        self.make(user=other)

    def test_clean_checks_owner_and_amount(self):
        limit = BudgetLimit(category=self.dairy, currency_id="KZT", amount=D("0"))
        with self.assertRaises(ValidationError) as caught:
            limit.clean()
        self.assertEqual(set(caught.exception.message_dict), {"household", "amount"})
        BudgetLimit(user=self.user, category=self.food, currency_id="KZT", amount=D("1")).clean()
        # Подкатегория — тоже: лимит задаётся категории любого уровня.
        BudgetLimit(user=self.user, category=self.dairy, currency_id="KZT", amount=D("1")).clean()

    def test_category_with_limit_cannot_be_deleted(self):
        # PROTECT: the classification cleanup must not silently take a family's limit away with its category.
        temporary = Category.objects.create(name="Демо-временная")
        self.make(user=self.user, category=temporary)
        with self.assertRaises(ProtectedError), transaction.atomic():
            temporary.delete()
        self.assertTrue(BudgetLimit.objects.filter(category_id=temporary.pk).exists())

    def test_admin_registered(self):
        self.assertIsInstance(admin.site._registry[BudgetLimit], BudgetLimitAdmin)


@tag("integration")
class BudgetMigrationTests(TransactionTestCase):
    """``budget.0001_initial`` откатывается и применяется снова."""

    def test_rollback_and_reapply(self):
        executor = MigrationExecutor(connection)
        executor.migrate([("budget", None)])
        self.assertNotIn("budget_budgetlimit", connection.introspection.table_names())
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes("budget"))
        self.assertIn("budget_budgetlimit", connection.introspection.table_names())
