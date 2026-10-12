"""Миграция ``receipts.0006_manual_expense``: значения прежних чеков, условия дедупликации, откат."""
from datetime import date, datetime, timezone
from decimal import Decimal

from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase, tag

from receipts.models import Receipt
from receipts.ownership import local_user
from stores.models import Country, Currency, Merchant, Store

LATEST = ("receipts", "0006_manual_expense")
BEFORE = ("receipts", "0005_receipt_owner_required")


@tag("integration")
class ManualExpenseMigrationTests(TransactionTestCase):
    def setUp(self):
        self.addCleanup(self.migrate, None)
        # TransactionTestCase очищает таблицы: справочники — свои, как в test_owner_migration.
        country = Country.objects.create(code="XA", name="Тестовая страна")
        self.currency = Currency.objects.create(code="XTS", name="Тестовая валюта")
        merchant = Merchant.objects.create(country=country, legal_name="ТОО «Тестовый продавец»")
        self.store = Store.objects.create(merchant=merchant, country=country, address_raw="ул. Примерная, 1",
                                          timezone="Europe/Berlin")

    def migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.migrate([target] if target else executor.loader.graph.leaf_nodes())

    def receipt(self, **fields):
        fields.setdefault("store", self.store)
        return Receipt.objects.create(
            owner=local_user(), currency=self.currency, operation="sale",
            purchased_at=datetime(2026, 10, 1, 9, tzinfo=timezone.utc), purchased_on=date(2026, 10, 1),
            total=Decimal("3.00"), **fields,
        )

    def test_rollback_and_reapply_keep_photo_receipts(self):
        receipt = self.receipt(receipt_number="1")
        self.migrate(BEFORE)
        with connection.cursor() as cursor:
            columns = {column.name for column in connection.introspection.get_table_description(cursor, "receipts_receipt")}
        self.assertNotIn("source", columns)
        self.migrate(LATEST)
        self.assertEqual(Receipt.objects.filter(pk=receipt.pk).values_list("source", "note").get(), ("photo", ""))

    def test_rollback_is_refused_while_manual_spends_exist(self):
        self.receipt(source="manual", store=None)
        with self.assertRaisesMessage(RuntimeError, "source=manual"):
            self.migrate(BEFORE)
        self.assertEqual(Receipt.objects.filter(source="manual").count(), 1)

    def test_sql_conditions_name_the_source(self):
        out = []

        class Collect:
            def write(self, text):
                out.append(text)

        call_command("sqlmigrate", "receipts", "0006", stdout=Collect())
        sql = "".join(out)
        for name in ("receipts_receipt_owner_fiscal_key_uniq", "receipts_receipt_owner_store_number_uniq",
                     "receipts_receipt_owner_store_time_total_uniq"):
            statement = next(line for line in sql.splitlines() if "CREATE UNIQUE INDEX" in line and name in line)
            self.assertIn("\"source\" = 'photo'", statement)
        self.assertIn('ALTER COLUMN "store_id" DROP NOT NULL', sql)
