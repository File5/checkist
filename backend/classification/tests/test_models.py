import io
import uuid
from datetime import timedelta

from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from django.test import TestCase, TransactionTestCase, override_settings, tag
from django.utils import timezone

from catalog.models import Category, GenericProduct, Product
from classification import demo, services
from classification.models import (
    ClassificationAttempt, ClassificationRejection, ClassificationRun, CreatedCategory, CreatedGenericProduct,
    ProductClassification,
)
from classification.tests.factories import (
    CATALOG_MODELS, CHEESE, CLASSIFICATION_MODELS, DOMAIN_MODELS, JUICE, KEFIR_A, MILK, generic, product, record,
    snapshot, suggest,
)

CLASSIFICATION_TABLES = {model._meta.db_table for model in CLASSIFICATION_MODELS}


def running_fields(now=None):
    now = now or timezone.now()
    return {
        "status": "running", "run_token": uuid.uuid4(), "heartbeat_at": now, "started_at": now,
        "lease_expires_at": now + timedelta(seconds=60),
    }


@tag("integration")
class ConstraintTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()
        suggest()

    def assertRejected(self, constraint, operation):
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            operation()
        self.assertIn(constraint, str(caught.exception))

    def test_pending_record_is_unresolved_and_a_resolved_one_is_not(self):
        pending = ProductClassification.objects.filter(pk=record(MILK).pk)
        name = "classification_record_pending_unresolved"
        self.assertRejected(name, lambda: pending.update(resolved_at=timezone.now()))
        self.assertRejected(name, lambda: pending.update(resolution="confirmed"))
        for status in ("confirmed", "rejected", "superseded"):
            self.assertRejected(name, lambda: pending.update(status=status, active_product=None))
            self.assertRejected(name, lambda: pending.update(
                status=status, active_product=None, resolved_at=timezone.now()))
            self.assertRejected(name, lambda: pending.update(status=status, active_product=None, resolution="other"))
        pending.update(status="confirmed", active_product=None, resolved_at=timezone.now(), resolution="confirmed")
        self.assertRejected(name, lambda: pending.update(resolved_at=None))
        self.assertRejected(name, lambda: pending.update(resolution=""))

    def test_only_a_pending_record_holds_its_product(self):
        pending = ProductClassification.objects.filter(pk=record(MILK).pk)
        self.assertRejected("classification_record_active_pending", lambda: pending.update(
            status="confirmed", resolution="confirmed", resolved_at=timezone.now()))
        # The reverse is allowed on purpose: a pending record may briefly outlive its product.
        pending.update(active_product=None)
        self.assertEqual(pending.get().status, "pending")

    def test_one_pending_record_per_product(self):
        first = record(MILK)
        values = {
            field.attname: getattr(first, field.attname)
            for field in ProductClassification._meta.concrete_fields if field.attname != "id"
        }
        self.assertRejected("active_product_id", lambda: ProductClassification.objects.create(**values))
        # History is not limited: resolved records of the same product pile up.
        values.update(active_product_id=None, status="rejected", resolution="rejected", resolved_at=timezone.now())
        ProductClassification.objects.create(**values)
        ProductClassification.objects.create(**values)
        self.assertEqual(ProductClassification.objects.filter(product_ref=first.product_ref).count(), 3)

    def test_one_queued_and_one_running_run(self):
        ClassificationRun.objects.all().delete()
        ClassificationRun.objects.create(trigger="manual", scope="all")
        self.assertRejected("classification_run_one_queued", lambda: ClassificationRun.objects.create(
            trigger="import", scope="products"))
        ClassificationRun.objects.create(trigger="manual", scope="all", **running_fields())
        self.assertRejected("classification_run_one_running", lambda: ClassificationRun.objects.create(
            trigger="command", scope="all", **running_fields()))
        # Finished runs are not limited.
        for status in ("succeeded", "failed", "cancelled", "succeeded"):
            ClassificationRun.objects.create(trigger="manual", scope="all", status=status, finished_at=timezone.now())
        self.assertEqual(ClassificationRun.objects.count(), 6)

    def test_only_a_running_run_is_owned(self):
        ClassificationRun.objects.all().delete()
        name = "classification_run_ownership_check"
        for missing in ("run_token", "heartbeat_at", "lease_expires_at"):
            self.assertRejected(name, lambda: ClassificationRun.objects.create(
                trigger="manual", scope="all", **{**running_fields(), missing: None}))
        queued = ClassificationRun.objects.create(trigger="manual", scope="all")
        for field, value in (("run_token", uuid.uuid4()), ("heartbeat_at", timezone.now()),
                             ("lease_expires_at", timezone.now())):
            self.assertRejected(name, lambda: ClassificationRun.objects.filter(pk=queued.pk).update(**{field: value}))
        self.assertRejected(name, lambda: ClassificationRun.objects.filter(pk=queued.pk).update(
            status="succeeded", finished_at=timezone.now(), run_token=uuid.uuid4()))

    def test_finished_time_goes_with_a_final_status(self):
        ClassificationRun.objects.all().delete()
        name = "classification_run_finished_check"
        queued = ClassificationRun.objects.filter(pk=ClassificationRun.objects.create(trigger="manual", scope="all").pk)
        self.assertRejected(name, lambda: queued.update(finished_at=timezone.now()))
        for status in ("succeeded", "failed", "cancelled"):
            self.assertRejected(name, lambda: queued.update(status=status))
        self.assertRejected(name, lambda: queued.update(finished_at=timezone.now(), **running_fields()))

    def test_created_journal_state_goes_with_its_time(self):
        for model, name in ((CreatedGenericProduct, "classification_created_generic_state_check"),
                            (CreatedCategory, "classification_created_category_state_check")):
            journal = model.objects.filter(pk=model.objects.filter(state="provisional").first().pk)
            self.assertRejected(name, lambda: journal.update(resolved_at=timezone.now()))
            for state in ("kept", "removed"):
                self.assertRejected(name, lambda: journal.update(state=state))
            for state in ("kept", "removed"):
                self.assertEqual(journal.update(state=state, resolved_at=timezone.now()), 1)
                self.assertRejected(name, lambda: journal.update(resolved_at=None))

    def test_rejection_and_attempt_are_unique(self):
        milk = product(MILK)
        ClassificationRejection.objects.create(product=milk, generic_key="сыр", generic_name="Сыр")
        self.assertRejected("classification_rejection_product_key_uniq", lambda: ClassificationRejection.objects.create(
            product=milk, generic_key="сыр", generic_name="СЫР"))
        ClassificationRejection.objects.create(product=product(CHEESE), generic_key="сыр", generic_name="Сыр")
        run = ClassificationRun.objects.latest("pk")
        ClassificationAttempt.objects.create(run=run, batch=9, ordinal=1, input_sha256="0" * 64)
        self.assertRejected("classification_attempt_run_batch_ordinal_uniq", lambda: ClassificationAttempt.objects.create(
            run=run, batch=9, ordinal=1, input_sha256="0" * 64))
        ClassificationAttempt.objects.create(run=run, batch=9, ordinal=2, input_sha256="0" * 64)

    def test_enumerations_of_the_contract(self):
        self.assertEqual(ProductClassification.Status.values, ["pending", "confirmed", "rejected", "superseded"])
        self.assertEqual(ProductClassification.Resolution.values, [
            "confirmed", "other", "rejected", "cancelled", "changed", "merged", "product_removed",
        ])
        self.assertEqual(ClassificationRun.Status.values, ["queued", "running", "succeeded", "failed", "cancelled"])
        self.assertEqual(ClassificationRun.Trigger.values, ["manual", "import", "command"])
        self.assertEqual(ClassificationRun.Scope.values, ["all", "products"])


@tag("integration")
class CatalogFreedomTests(TestCase):
    """Foreign keys to the catalog never stand in the way of its editing or deletion."""

    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()
        suggest()

    def test_deleting_a_product_keeps_its_pending_record_without_the_product(self):
        entry = record(JUICE)
        services.reject(record(CHEESE).pk, version=1)
        cheese = product(CHEESE)
        self.assertEqual(ClassificationRejection.objects.filter(product=cheese).count(), 1)
        product(JUICE).delete()
        cheese.delete()
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.active_product_id, entry.product_ref > 0), ("pending", None, True))
        self.assertEqual(entry.product_name, JUICE)
        # The rejection memory goes with the product; the record that caused it stays.
        self.assertFalse(ClassificationRejection.objects.exists())
        self.assertEqual(record(CHEESE).status, "rejected")

    def test_deleting_a_generic_product_or_a_category_keeps_the_snapshots(self):
        entry = record(JUICE)
        journal = CreatedGenericProduct.objects.get(name="Сок")
        category_journal = CreatedCategory.objects.get(name="Напитки")
        Product.objects.filter(name=JUICE).update(generic=generic("Молоко"))
        GenericProduct.objects.filter(name="Сок").delete()
        Category.objects.filter(name="Напитки").delete()
        entry.refresh_from_db()
        journal.refresh_from_db()
        category_journal.refresh_from_db()
        self.assertEqual((entry.suggested_generic_id, entry.suggested_generic_name), (None, "Сок"))
        self.assertEqual(entry.suggested_generic_ref, journal.generic_ref)
        self.assertEqual((journal.generic_id, journal.name, journal.state), (None, "Сок", "provisional"))
        self.assertEqual((category_journal.category_id, category_journal.name), (None, "Напитки"))

    def test_deleting_a_run_keeps_its_records_and_drops_its_attempts(self):
        run = ClassificationRun.objects.get()
        self.assertEqual(run.attempts.count(), 1)
        run.delete()
        self.assertEqual(ProductClassification.objects.filter(run__isnull=True).count(), 9)
        self.assertEqual(CreatedGenericProduct.objects.filter(run__isnull=True).count(), 6)
        self.assertFalse(ClassificationAttempt.objects.exists())

    def test_migration_touches_only_new_tables(self):
        migration = MigrationLoader(connection).get_migration("classification", "0001_initial")
        # No dependency on merges: there is no foreign key to it, and with one
        # `migrate merges zero` would silently drop these tables with pending records in them.
        self.assertEqual(sorted(migration.dependencies), [("catalog", "0001_initial"), ("receipts", "0001_initial")])
        created = {
            operation.name.lower() for operation in migration.operations if type(operation).__name__ == "CreateModel"
        }
        self.assertEqual(created, {model._meta.model_name for model in CLASSIFICATION_MODELS})
        self.assertLessEqual(
            {type(operation).__name__ for operation in migration.operations},
            {"CreateModel", "AddConstraint", "AddIndex"},
        )
        for operation in migration.operations:
            if type(operation).__name__ in ("AddConstraint", "AddIndex"):
                self.assertIn(operation.model_name, created)
        self.assertEqual(
            [name for app, name in MigrationLoader(connection).disk_migrations if app == "classification"],
            ["0001_initial"],
        )


@tag("integration")
@override_settings(RECEIPT_OCR_PROVIDER="fake")
class ClassificationMigrationTests(TransactionTestCase):
    def tables(self):
        return CLASSIFICATION_TABLES & set(connection.introspection.table_names())

    def test_cancel_pending_then_reverse_and_reapply(self):
        demo.seed_demo()
        before = snapshot(*DOMAIN_MODELS)
        suggest()
        # A confirmed suggestion and a human's own choice survive the rollback as ordinary catalog records.
        services.confirm(record(MILK).pk, version=1, generic_id=generic("Молоко").pk)
        services.confirm(record(KEFIR_A).pk, version=1, generic_id=generic("Кефир").pk)
        services.reject(record(CHEESE).pk, version=1)
        call_command("product_classifications", "cancel-pending", stdout=io.StringIO())
        kept = snapshot(*DOMAIN_MODELS)
        self.assertEqual({row["name"] for row in kept["GenericProduct"]}, {"Не разобрано", "Молоко", "Кефир"})
        self.assertEqual(kept["Category"], before["Category"])
        self.assertEqual(
            {row["name"]: row["generic_id"] for row in kept["Product"]},
            {row["name"]: row["generic_id"] for row in before["Product"]} | {
                MILK: generic("Молоко").pk, KEFIR_A: generic("Кефир").pk,
            },
        )
        self.assertEqual(self.tables(), CLASSIFICATION_TABLES)
        try:
            MigrationExecutor(connection).migrate([("classification", None)])
            self.assertEqual(self.tables(), set())
            self.assertEqual(snapshot(*DOMAIN_MODELS), kept)
        finally:
            MigrationExecutor(connection).migrate([("classification", "0001_initial")])
        self.assertEqual(self.tables(), CLASSIFICATION_TABLES)
        self.assertTrue(all(not model.objects.exists() for model in CLASSIFICATION_MODELS))
        self.assertEqual(snapshot(*DOMAIN_MODELS), kept)
        # The history is gone with the tables: the remaining products are candidates again.
        self.assertEqual(services.candidates().count(), 8)
        run = suggest()
        self.assertEqual((run.applied_count, run.unknown_count), (7, 1))
        self.assertEqual(generic("Кефир").products.count(), 2)
        services.cancel_pending()
        self.assertEqual(snapshot(*CATALOG_MODELS), {name: kept[name] for name in snapshot(*CATALOG_MODELS)})

    def test_reverse_without_cancel_pending_leaves_products_in_the_suggested_generics(self):
        """Documented limit of the rollback: run ``product_classifications cancel-pending`` first."""
        demo.seed_demo()
        suggest()
        applied = snapshot(*DOMAIN_MODELS)
        try:
            MigrationExecutor(connection).migrate([("classification", None)])
            self.assertEqual(self.tables(), set())
            self.assertEqual(snapshot(*DOMAIN_MODELS), applied)
        finally:
            MigrationExecutor(connection).migrate([("classification", "0001_initial")])
        self.assertEqual(snapshot(*DOMAIN_MODELS), applied)
        # Nothing remembers that the values were suggestions: there is nothing to undo.
        self.assertEqual(services.cancel_pending()["cancelled"], [])
        self.assertEqual(product(JUICE).generic.name, "Сок")
