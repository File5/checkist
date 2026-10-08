from datetime import date, datetime, timezone
from decimal import Decimal

from django.apps import apps as global_apps
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection, transaction
from django.db.migrations.autodetector import MigrationAutodetector
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.recorder import MigrationRecorder
from django.db.migrations.state import ProjectState
from django.test import SimpleTestCase, TransactionTestCase, tag

from receipts.models import Receipt
from stores.models import Country, Currency, Merchant, Store

# Все названия, адреса и номера вымышленные.

User = get_user_model()

BEFORE = [("receipts", "0002_alter_receipttax_options")]
OWNER_MIGRATIONS = ["0003_receipt_owner", "0004_assign_local_owner", "0005_receipt_owner_required"]
PURCHASED_AT = datetime(2026, 3, 14, 11, 30, tzinfo=timezone.utc)
PURCHASED_ON = date(2026, 3, 14)
FISCAL_KEY = "xa:0000000000000001:101"


def names(operations):
    return [type(operation).__name__ for operation in operations]


class ReceiptOwnerMigrationStructureTests(SimpleTestCase):
    """Чтение файлов миграций, без базы."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.loader = MigrationLoader(None)

    def migration(self, name):
        return self.loader.get_migration("receipts", name)

    def test_models_and_migrations_agree(self):
        """То же, что ``makemigrations --check --dry-run``, но только для ``receipts``."""
        changes = MigrationAutodetector(
            self.loader.project_state(), ProjectState.from_apps(global_apps),
        ).changes(graph=self.loader.graph)
        self.assertEqual(changes.get("receipts", []), [])

    def test_owner_migrations_follow_each_other(self):
        previous = "0002_alter_receipttax_options"
        for name in OWNER_MIGRATIONS:
            self.assertIn(("receipts", previous), self.migration(name).dependencies, name)
            previous = name

    def test_nullable_column_and_index_come_first(self):
        migration = self.migration("0003_receipt_owner")
        self.assertEqual(names(migration.operations), ["RunSQL", "AddField", "AddIndex", "RunSQL"])
        field = migration.operations[1].field
        self.assertTrue(field.null)
        self.assertEqual(field.remote_field.related_name, "receipts")
        self.assertEqual(migration.operations[2].index.name, "receipts_rcpt_owner_on_idx")
        self.assertEqual(migration.operations[2].index.fields, ["owner", "purchased_on"])

    def test_data_migration_depends_on_final_auth_user_and_reverses_as_noop(self):
        migration = self.migration("0004_assign_local_owner")
        self.assertIn(("auth", "0012_alter_user_first_name_max_length"), migration.dependencies)
        self.assertEqual(names(migration.operations), ["RunPython"])
        operation = migration.operations[0]
        self.assertTrue(operation.reversible)
        self.assertIs(operation.reverse_code, type(operation).noop)

    def test_new_constraints_are_added_before_old_ones_are_removed(self):
        migration = self.migration("0005_receipt_owner_required")
        kinds = names(migration.operations)
        self.assertEqual(
            kinds,
            ["RunSQL", "AlterField", "AddConstraint", "AddConstraint", "AddConstraint",
             "RemoveConstraint", "RemoveConstraint", "RemoveConstraint", "RunSQL"],
        )
        self.assertFalse(migration.operations[1].field.null)
        self.assertFalse(migration.operations[1].field.has_default())
        self.assertEqual(
            [operation.constraint.name for operation in migration.operations[2:5]],
            ["receipts_receipt_owner_fiscal_key_uniq", "receipts_receipt_owner_store_number_uniq",
             "receipts_receipt_owner_store_time_total_uniq"],
        )
        self.assertEqual(
            [operation.name for operation in migration.operations[5:8]],
            ["receipts_receipt_fiscal_key_uniq", "receipts_receipt_store_number_uniq",
             "receipts_receipt_store_time_total_uniq"],
        )

    def test_statement_timeout_is_lifted_in_both_directions(self):
        for name in ("0003_receipt_owner", "0005_receipt_owner_required"):
            first, last = self.migration(name).operations[0], self.migration(name).operations[-1]
            self.assertEqual(first.sql, "SET LOCAL statement_timeout = 0", name)
            self.assertEqual(first.reverse_sql, "", name)
            self.assertEqual(last.sql, "", name)
            self.assertEqual(last.reverse_sql, "SET LOCAL statement_timeout = 0", name)


@tag("integration")
class ReceiptOwnerMigrationTests(TransactionTestCase):
    def setUp(self):
        # Что бы ни случилось в тесте, схема возвращается к последним миграциям до очистки таблиц.
        self.addCleanup(self.migrate_to_latest)
        self.country = Country.objects.create(code="XA", name="Тестовая страна")
        self.currency = Currency.objects.create(code="XTS", name="Тестовая валюта")
        self.merchant = Merchant.objects.create(country=self.country, legal_name="ТОО «Тестовый продавец»")
        self.store = Store.objects.create(
            merchant=self.merchant, country=self.country,
            address_raw="г. Тестоград, ул. Примерная, 1", timezone="Europe/Berlin",
        )

    def migrate_to_latest(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def migrate_before(self):
        """Откатывает ``receipts`` до состояния без владельца; возвращает историческую модель чека."""
        executor = MigrationExecutor(connection)
        executor.migrate(BEFORE)
        return MigrationExecutor(connection).loader.project_state(BEFORE).apps.get_model("receipts", "Receipt")

    def drop_local(self):
        """Убирает запись, оставленную миграцией при создании тестовой базы.

        Только до отката схемы: удаление пользователя обходит его чеки по текущей модели.
        """
        User.objects.filter(username="local").delete()

    def applied(self):
        return {name for app, name in MigrationRecorder(connection).applied_migrations() if app == "receipts"}

    def values(self, **fields):
        values = dict(
            store_id=self.store.pk, currency_id=self.currency.pk, operation="sale",
            purchased_at=PURCHASED_AT, purchased_on=PURCHASED_ON, total=Decimal("10.00"),
        )
        values.update(fields)
        return values

    def test_receipts_without_owner_go_to_local(self):
        self.drop_local()
        OldReceipt = self.migrate_before()
        self.assertFalse(self.applied() & set(OWNER_MIGRATIONS))
        ids = sorted([
            OldReceipt.objects.create(**self.values(fiscal_key=FISCAL_KEY)).pk,
            OldReceipt.objects.create(**self.values(receipt_number="5", shift_number="139", register_code="1")).pk,
            OldReceipt.objects.create(**self.values(total=Decimal("12.00"))).pk,
        ])
        before = list(OldReceipt.objects.order_by("pk").values())

        self.migrate_to_latest()

        self.assertTrue(set(OWNER_MIGRATIONS) <= self.applied())
        local = User.objects.get(username="local")
        self.assertTrue(local.is_active)
        self.assertFalse(local.is_staff)
        self.assertFalse(local.is_superuser)
        self.assertFalse(local.has_usable_password())
        self.assertFalse(local.user_permissions.exists())
        self.assertEqual(sorted(Receipt.objects.values_list("pk", flat=True)), ids)
        self.assertEqual(set(Receipt.objects.values_list("owner_id", flat=True)), {local.pk})
        after = list(Receipt.objects.order_by("pk").values())
        for row in after:
            self.assertEqual(row.pop("owner_id"), local.pk)
        self.assertEqual(after, before)
        # Прежние глобальные запреты действуют в пределах владельца.
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            Receipt.objects.create(owner=local, **self.values(fiscal_key=FISCAL_KEY, total=Decimal("99.00")))
        self.assertIn("receipts_receipt_owner_fiscal_key_uniq", str(caught.exception))

    def test_empty_database_gets_local_user(self):
        self.drop_local()
        self.migrate_before()
        self.migrate_to_latest()
        local = User.objects.get(username="local")
        self.assertFalse(local.has_usable_password())
        self.assertFalse(Receipt.objects.exists())

    def test_existing_local_user_is_not_changed(self):
        self.drop_local()
        OldReceipt = self.migrate_before()
        existing = User.objects.create_user(
            "local", password="vymyshlennyi-parol-17", is_staff=True, is_active=False,
        )
        snapshot = User.objects.filter(pk=existing.pk).values().get()
        receipt_id = OldReceipt.objects.create(**self.values()).pk

        self.migrate_to_latest()

        self.assertEqual(User.objects.filter(username="local").count(), 1)
        self.assertEqual(User.objects.filter(pk=existing.pk).values().get(), snapshot)
        self.assertTrue(User.objects.get(pk=existing.pk).check_password("vymyshlennyi-parol-17"))
        self.assertEqual(Receipt.objects.get(pk=receipt_id).owner_id, existing.pk)

    def test_reverse_and_reapply_keep_receipts_and_single_local_user(self):
        local = User.objects.get_or_create(username="local")[0]
        receipt = Receipt.objects.create(owner=local, **self.values(fiscal_key=FISCAL_KEY))
        before = Receipt.objects.filter(pk=receipt.pk).values().get()

        OldReceipt = self.migrate_before()

        self.assertFalse(self.applied() & set(OWNER_MIGRATIONS))
        self.assertNotIn("owner_id", OldReceipt.objects.filter(pk=receipt.pk).values().get())
        # Обратный ход данных — noop: пользователь остаётся.
        self.assertTrue(User.objects.filter(pk=local.pk).exists())
        # Прежнее глобальное ограничение снова на месте.
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            OldReceipt.objects.create(**self.values(fiscal_key=FISCAL_KEY, total=Decimal("99.00")))
        self.assertIn("receipts_receipt_fiscal_key_uniq", str(caught.exception))

        self.migrate_to_latest()

        self.assertEqual(User.objects.filter(username="local").count(), 1)
        self.assertEqual(Receipt.objects.filter(pk=receipt.pk).values().get(), before)

    def assert_reverse_refused(self, **fields):
        first = User.objects.create_user("vladelec-odin")
        second = User.objects.create_user("vladelec-dva")
        ids = sorted(Receipt.objects.create(owner=owner, **self.values(**fields)).pk for owner in (first, second))
        applied = self.applied()

        with self.assertRaises(IntegrityError):
            MigrationExecutor(connection).migrate(BEFORE)

        # Без частичного результата: миграции числятся применёнными, владельцы и новые запреты на месте.
        self.assertEqual(self.applied(), applied)
        self.assertTrue(set(OWNER_MIGRATIONS) <= applied)
        self.assertEqual(
            sorted(Receipt.objects.values_list("pk", "owner_id")), sorted(zip(ids, (first.pk, second.pk))),
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            Receipt.objects.create(owner=first, **self.values(**fields))
        with self.assertRaises(IntegrityError), transaction.atomic():
            Receipt.objects.create(**self.values(**fields, total=Decimal("77.00")))  # владелец обязателен

    def test_reverse_is_refused_when_two_owners_share_a_fiscal_key(self):
        self.assert_reverse_refused(fiscal_key=FISCAL_KEY)

    def test_reverse_is_refused_when_two_owners_share_a_number(self):
        self.assert_reverse_refused(receipt_number="5", shift_number="139", register_code="1")

    def test_reverse_is_refused_when_two_owners_share_store_time_and_total(self):
        self.assert_reverse_refused()
