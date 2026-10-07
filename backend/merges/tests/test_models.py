import io

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from django.test import TestCase, TransactionTestCase, tag
from django.utils import timezone

from merges import demo, services
from merges.models import (
    ProductMerge, ProductMergeAlias, ProductMergeLine, ProductMergeMember, ProductMergeRejection,
)
from merges.tests.factories import DOMAIN_MODELS, MERGE_MODELS, PIZZA, ZIMBO, ids, pending_group, product, snapshot
from receipts.models import ProductAlias, ReceiptLine

MERGE_TABLES = {model._meta.db_table for model in MERGE_MODELS}
LATEST = [("merges", "0002_actor_fields")]


@tag("integration")
class ConstraintTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()
        services.detect()

    def assertRejected(self, constraint, operation):
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            operation()
        self.assertIn(constraint, str(caught.exception))

    def test_pending_group_has_no_resolution_time_and_a_resolved_one_has(self):
        group = pending_group(PIZZA[0])
        self.assertRejected("merges_productmerge_pending_unresolved", lambda: ProductMerge.objects.filter(
            pk=group.pk).update(resolved_at=timezone.now()))
        for status in ("confirmed", "cancelled"):
            self.assertRejected("merges_productmerge_pending_unresolved", lambda: ProductMerge.objects.filter(
                pk=group.pk).update(status=status))
        for status in ("confirmed", "cancelled"):
            ProductMerge.objects.filter(pk=group.pk).update(status=status, resolved_at=timezone.now())
        self.assertRejected("merges_productmerge_pending_unresolved", lambda: ProductMerge.objects.filter(
            pk=group.pk).update(resolved_at=None))

    def test_product_is_in_a_group_once(self):
        group = pending_group(PIZZA[0])
        self.assertRejected("merges_member_group_product_uniq", lambda: ProductMergeMember.objects.create(
            group=group, product_ref=group.target_ref, role="source", state="excluded", name="x"))

    def test_product_is_active_in_one_pending_group(self):
        other = pending_group(ZIMBO[0])
        taken = product(PIZZA[1])
        self.assertRejected("active_product_id", lambda: ProductMergeMember.objects.create(
            group=other, product_ref=taken.pk, active_product=taken, role="source", name="x"))

    def test_group_has_one_active_target(self):
        group = pending_group(PIZZA[0])
        self.assertRejected("merges_member_group_target_uniq", lambda: group.members.filter(
            role="source").update(role="target"))
        # An excluded former target does not count.
        group.members.filter(role="target").update(state="excluded")
        group.members.filter(product_ref=product(PIZZA[1]).pk).update(role="target")

    def test_journal_entries_are_unique(self):
        line = ProductMergeLine.objects.first()
        alias = ProductMergeAlias.objects.first()
        self.assertRejected("merges_line_member_line_uniq", lambda: ProductMergeLine.objects.create(
            member=line.member, line=line.line))
        self.assertRejected("merges_alias_member_alias_uniq", lambda: ProductMergeAlias.objects.create(
            member=alias.member, alias=alias.alias))

    def test_rejection_is_an_ordered_unique_pair(self):
        low, high = sorted(ids(demo.FALSE_PAIR))
        ProductMergeRejection.objects.create(product_low_id=low, product_high_id=high)
        self.assertRejected("merges_rejection_pair_uniq", lambda: ProductMergeRejection.objects.create(
            product_low_id=low, product_high_id=high))
        self.assertRejected("merges_rejection_low_lt_high", lambda: ProductMergeRejection.objects.create(
            product_low_id=high, product_high_id=low))
        self.assertRejected("merges_rejection_low_lt_high", lambda: ProductMergeRejection.objects.create(
            product_low_id=low, product_high_id=low))

    def test_cascades(self):
        group = pending_group(PIZZA[0])
        services.cancel(group.pk)
        self.assertEqual(ProductMergeRejection.objects.filter(group=group).count(), 3)
        gone = product(PIZZA[2])
        gone.delete()
        self.assertEqual(ProductMergeRejection.objects.filter(group=group).count(), 1)
        ProductMerge.objects.filter(pk=group.pk).delete()
        self.assertEqual(ProductMergeRejection.objects.filter(group__isnull=True).count(), 1)
        # Deleting a receipt line or an alias takes its journal entries along.
        other = pending_group(ZIMBO[0])
        lines = ProductMergeLine.objects.filter(member__group=other)
        self.assertEqual(lines.count(), 3)
        ReceiptLine.objects.filter(raw_name=ZIMBO[1]).delete()
        ProductAlias.objects.filter(raw_name=ZIMBO[1]).delete()
        self.assertEqual(lines.count(), 2)
        self.assertEqual(ProductMergeAlias.objects.filter(member__group=other).count(), 1)

    def test_migration_touches_only_new_tables(self):
        migration = MigrationLoader(connection).get_migration("merges", "0001_initial")
        self.assertEqual(sorted(migration.dependencies), [("catalog", "0001_initial"), ("receipts", "0001_initial")])
        created = {
            operation.name.lower() for operation in migration.operations if type(operation).__name__ == "CreateModel"
        }
        self.assertEqual(created, {model._meta.model_name for model in MERGE_MODELS})
        self.assertEqual(
            {type(operation).__name__ for operation in migration.operations}, {"CreateModel", "AddConstraint"},
        )
        for operation in migration.operations:
            if type(operation).__name__ == "AddConstraint":
                self.assertIn(operation.model_name, created)

    def test_actor_is_empty_by_default_and_a_deleted_user_clears_it(self):
        group = pending_group(PIZZA[0])
        low, high = sorted(ids(demo.FALSE_PAIR))
        rejection = ProductMergeRejection.objects.create(product_low_id=low, product_high_id=high)
        self.assertFalse(ProductMerge.objects.filter(resolved_by__isnull=False).exists())
        self.assertEqual((group.resolved_by_id, rejection.created_by_id), (None, None))
        actor = get_user_model().objects.create_user("journal-actor")
        ProductMerge.objects.filter(pk=group.pk).update(resolved_by=actor)
        ProductMergeRejection.objects.filter(pk=rejection.pk).update(created_by=actor)
        before = snapshot(*MERGE_MODELS)
        self.assertEqual(
            [row["resolved_by_id"] for row in before["ProductMerge"] if row["id"] == group.pk], [actor.pk],
        )
        actor.delete()
        cleared = {"ProductMerge": "resolved_by_id", "ProductMergeRejection": "created_by_id"}
        # Nothing but the reference changes: the journal outlives the account.
        self.assertEqual(snapshot(*MERGE_MODELS), {
            name: [row | {cleared[name]: None} if name in cleared else row for row in rows]
            for name, rows in before.items()
        })

    def test_actor_migration_only_adds_empty_references(self):
        migration = MigrationLoader(connection).get_migration(*LATEST[0])
        self.assertEqual(migration.dependencies[0], ("merges", "0001_initial"))
        self.assertEqual(len(migration.dependencies), 2)
        self.assertEqual({type(operation).__name__ for operation in migration.operations}, {"AddField"})
        self.assertEqual(
            [(operation.model_name, operation.name) for operation in migration.operations],
            [("productmerge", "resolved_by"), ("productmergerejection", "created_by")],
        )
        for operation in migration.operations:
            self.assertTrue(operation.field.null)
            self.assertEqual(operation.field.remote_field.on_delete.__name__, "SET_NULL")
            self.assertEqual(operation.field.remote_field.related_name, "+")
        self.assertEqual(
            sorted(name for app, name in MigrationLoader(connection).disk_migrations if app == "merges"),
            ["0001_initial", LATEST[0][1]],
        )


@tag("integration")
class MergesMigrationTests(TransactionTestCase):
    def tables(self):
        return MERGE_TABLES & set(connection.introspection.table_names())

    def test_cancel_pending_reverse_and_reapply_keep_domain_data(self):
        demo.seed_demo()
        before = snapshot(*DOMAIN_MODELS)
        self.assertEqual(services.detect().created, 7)
        self.assertNotEqual(snapshot(ReceiptLine, ProductAlias), {k: before[k] for k in ("ReceiptLine", "ProductAlias")})
        call_command("product_merges", "cancel-pending", stdout=io.StringIO())
        self.assertEqual(snapshot(*DOMAIN_MODELS), before)
        self.assertEqual(self.tables(), MERGE_TABLES)
        try:
            MigrationExecutor(connection).migrate([("merges", None)])
            self.assertEqual(self.tables(), set())
            self.assertEqual(snapshot(*DOMAIN_MODELS), before)
        finally:
            MigrationExecutor(connection).migrate(LATEST)
        self.assertEqual(self.tables(), MERGE_TABLES)
        self.assertTrue(all(not model.objects.exists() for model in MERGE_MODELS))
        self.assertEqual(snapshot(*DOMAIN_MODELS), before)
        # The journal and the rejections are gone with the tables: detection starts over.
        self.assertEqual(services.detect().created, 7)
        self.assertEqual(len(services.cancel_pending()), 7)
        self.assertEqual(snapshot(*DOMAIN_MODELS), before)

    def test_reverse_without_cancel_pending_leaves_groups_merged(self):
        """Documented limit of the rollback: run ``product_merges cancel-pending`` first."""
        demo.seed_demo()
        services.detect()
        merged = snapshot(*DOMAIN_MODELS)
        try:
            MigrationExecutor(connection).migrate([("merges", None)])
            self.assertEqual(snapshot(*DOMAIN_MODELS), merged)
            self.assertFalse(ReceiptLine.objects.filter(product__name__in=PIZZA[1:]).exists())
        finally:
            MigrationExecutor(connection).migrate(LATEST)
        self.assertEqual(snapshot(*DOMAIN_MODELS), merged)
        self.assertFalse(ProductMerge.objects.exists())

