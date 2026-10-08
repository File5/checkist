import uuid

from django.apps import apps as global_apps
from django.contrib.auth import get_user_model
from django.db import IntegrityError, connection, transaction
from django.db.migrations.autodetector import MigrationAutodetector
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.recorder import MigrationRecorder
from django.db.migrations.state import ProjectState
from django.test import SimpleTestCase, TransactionTestCase, tag

from recognition.models import ProcessingJob, SourcePhoto

User = get_user_model()

BEFORE = [("recognition", "0001_initial")]
OWNER_MIGRATIONS = ["0002_sourcephoto_owner", "0003_assign_local_owner", "0004_sourcephoto_owner_required"]
SHA256 = "a" * 64


def names(operations):
    return [type(operation).__name__ for operation in operations]


def values(**fields):
    result = dict(
        original_file=f"originals/{uuid.uuid4()}/source.png", sha256=uuid.uuid4().hex * 2,
        content_type="image/png", bytes=100, raw_width=100, raw_height=200, width=100, height=200,
    )
    result.update(fields)
    return result


class PhotoOwnerMigrationStructureTests(SimpleTestCase):
    """Reads the migration files only, no database."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.loader = MigrationLoader(None)

    def migration(self, name):
        return self.loader.get_migration("recognition", name)

    def test_models_and_migrations_agree(self):
        """The same as ``makemigrations --check --dry-run``, for ``recognition`` only."""
        changes = MigrationAutodetector(
            self.loader.project_state(), ProjectState.from_apps(global_apps),
        ).changes(graph=self.loader.graph)
        self.assertEqual(changes.get("recognition", []), [])

    def test_owner_migrations_follow_each_other(self):
        previous = "0001_initial"
        for name in OWNER_MIGRATIONS:
            self.assertIn(("recognition", previous), self.migration(name).dependencies, name)
            previous = name

    def test_owner_migrations_do_not_depend_on_receipt_owner_migrations(self):
        for name in OWNER_MIGRATIONS:
            apps = {app for app, _name in self.migration(name).dependencies}
            self.assertNotIn("receipts", apps, name)

    def test_nullable_column_and_index_come_first(self):
        migration = self.migration("0002_sourcephoto_owner")
        self.assertEqual(names(migration.operations), ["RunSQL", "AddField", "AddIndex", "RunSQL"])
        field = migration.operations[1].field
        self.assertTrue(field.null)
        self.assertEqual(field.remote_field.related_name, "source_photos")
        self.assertEqual(migration.operations[2].index.name, "rec_photo_owner_created_idx")
        self.assertEqual(migration.operations[2].index.fields, ["owner", "created_at", "id"])

    def test_data_migration_depends_on_final_auth_user_and_reverses_as_noop(self):
        migration = self.migration("0003_assign_local_owner")
        self.assertIn(("auth", "0012_alter_user_first_name_max_length"), migration.dependencies)
        self.assertEqual(names(migration.operations), ["RunPython"])
        operation = migration.operations[0]
        self.assertTrue(operation.reversible)
        self.assertIs(operation.reverse_code, type(operation).noop)

    def test_new_constraint_is_added_before_global_uniqueness_is_dropped(self):
        migration = self.migration("0004_sourcephoto_owner_required")
        self.assertEqual(
            names(migration.operations), ["RunSQL", "AlterField", "AddConstraint", "AlterField", "RunSQL"],
        )
        owner, constraint, sha256 = migration.operations[1:4]
        self.assertEqual(owner.name, "owner")
        self.assertFalse(owner.field.null)
        self.assertFalse(owner.field.has_default())
        self.assertEqual(constraint.constraint.name, "rec_photo_owner_sha256_uniq")
        self.assertEqual(tuple(constraint.constraint.fields), ("owner", "sha256"))
        self.assertEqual(sha256.name, "sha256")
        self.assertFalse(sha256.field.unique)

    def test_statement_timeout_is_lifted_in_both_directions(self):
        for name in ("0002_sourcephoto_owner", "0004_sourcephoto_owner_required"):
            first, last = self.migration(name).operations[0], self.migration(name).operations[-1]
            self.assertEqual(first.sql, "SET LOCAL statement_timeout = 0", name)
            self.assertEqual(first.reverse_sql, "", name)
            self.assertEqual(last.sql, "", name)
            self.assertEqual(last.reverse_sql, "SET LOCAL statement_timeout = 0", name)


@tag("integration")
class PhotoOwnerMigrationTests(TransactionTestCase):
    def setUp(self):
        # Whatever happens in a test, the schema is back at the latest migrations before the flush.
        self.addCleanup(self.migrate_to_latest)

    def migrate_to_latest(self):
        executor = MigrationExecutor(connection)
        executor.migrate(executor.loader.graph.leaf_nodes())

    def migrate_before(self):
        """Rolls ``recognition`` back to the state without an owner; returns the historical models."""
        executor = MigrationExecutor(connection)
        executor.migrate(BEFORE)
        return MigrationExecutor(connection).loader.project_state(BEFORE).apps

    def drop_local(self):
        """Removes the row left by the migration of the test database.

        Only before the rollback: deleting a user walks its photos by the current model.
        """
        User.objects.filter(username="local").delete()

    def applied(self):
        return {name for app, name in MigrationRecorder(connection).applied_migrations() if app == "recognition"}

    def test_photos_without_owner_go_to_local(self):
        self.drop_local()
        old = self.migrate_before()
        OldPhoto, OldJob = old.get_model("recognition", "SourcePhoto"), old.get_model("recognition", "ProcessingJob")
        self.assertFalse(self.applied() & set(OWNER_MIGRATIONS))
        first = OldPhoto.objects.create(**values(sha256=SHA256))
        second = OldPhoto.objects.create(**values())
        job_id = OldJob.objects.create(photo_id=first.pk).pk
        before = list(OldPhoto.objects.order_by("pk").values())

        self.migrate_to_latest()

        self.assertTrue(set(OWNER_MIGRATIONS) <= self.applied())
        local = User.objects.get(username="local")
        self.assertTrue(local.is_active)
        self.assertFalse(local.is_staff)
        self.assertFalse(local.is_superuser)
        self.assertFalse(local.has_usable_password())
        self.assertFalse(local.user_permissions.exists())
        self.assertEqual(sorted(SourcePhoto.objects.values_list("pk", flat=True)), sorted([first.pk, second.pk]))
        after = list(SourcePhoto.objects.order_by("pk").values())
        for row in after:
            self.assertEqual(row.pop("owner_id"), local.pk)
        self.assertEqual(after, before)
        self.assertEqual(ProcessingJob.objects.get(pk=job_id).photo_id, first.pk)
        # The former global ban now holds within the owner.
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            SourcePhoto.objects.create(owner=local, **values(sha256=SHA256))
        self.assertIn("rec_photo_owner_sha256_uniq", str(caught.exception))

    def test_empty_database_gets_local_user(self):
        self.drop_local()
        self.migrate_before()
        self.migrate_to_latest()
        local = User.objects.get(username="local")
        self.assertFalse(local.has_usable_password())
        self.assertFalse(SourcePhoto.objects.exists())

    def test_existing_local_user_is_not_changed(self):
        self.drop_local()
        old = self.migrate_before()
        existing = User.objects.create_user(
            "local", password="synthetic-password-17", is_staff=True, is_active=False,
        )
        snapshot = User.objects.filter(pk=existing.pk).values().get()
        photo_id = old.get_model("recognition", "SourcePhoto").objects.create(**values()).pk

        self.migrate_to_latest()

        self.assertEqual(User.objects.filter(username="local").count(), 1)
        self.assertEqual(User.objects.filter(pk=existing.pk).values().get(), snapshot)
        self.assertTrue(User.objects.get(pk=existing.pk).check_password("synthetic-password-17"))
        self.assertEqual(SourcePhoto.objects.get(pk=photo_id).owner_id, existing.pk)

    def test_reverse_and_reapply_keep_photos_and_single_local_user(self):
        local = User.objects.get_or_create(username="local")[0]
        photo = SourcePhoto.objects.create(owner=local, **values(sha256=SHA256))
        before = SourcePhoto.objects.filter(pk=photo.pk).values().get()

        OldPhoto = self.migrate_before().get_model("recognition", "SourcePhoto")

        self.assertFalse(self.applied() & set(OWNER_MIGRATIONS))
        self.assertNotIn("owner_id", OldPhoto.objects.filter(pk=photo.pk).values().get())
        # The reverse of the data step is a noop: the user stays.
        self.assertTrue(User.objects.filter(pk=local.pk).exists())
        # The former global uniqueness of sha256 is back.
        with self.assertRaises(IntegrityError), transaction.atomic():
            OldPhoto.objects.create(**values(sha256=SHA256))

        self.migrate_to_latest()

        self.assertEqual(User.objects.filter(username="local").count(), 1)
        self.assertEqual(SourcePhoto.objects.filter(pk=photo.pk).values().get(), before)

    def test_reverse_is_refused_when_two_owners_have_the_same_file(self):
        first = User.objects.create_user("synthetic-owner-one")
        second = User.objects.create_user("synthetic-owner-two")
        ids = sorted(SourcePhoto.objects.create(owner=owner, **values(sha256=SHA256)).pk for owner in (first, second))
        applied = self.applied()

        with self.assertRaises(IntegrityError):
            MigrationExecutor(connection).migrate(BEFORE)

        # Nothing partial: the migrations are still applied, the owners and the new ban are in place.
        self.assertEqual(self.applied(), applied)
        self.assertTrue(set(OWNER_MIGRATIONS) <= applied)
        self.assertEqual(
            sorted(SourcePhoto.objects.values_list("pk", "owner_id")), sorted(zip(ids, (first.pk, second.pk))),
        )
        with self.assertRaises(IntegrityError), transaction.atomic():
            SourcePhoto.objects.create(owner=first, **values(sha256=SHA256))
        with self.assertRaises(IntegrityError), transaction.atomic():
            SourcePhoto.objects.create(**values())  # the owner is still required
