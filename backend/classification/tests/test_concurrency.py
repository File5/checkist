import threading
from concurrent.futures import ThreadPoolExecutor

from django.db import DatabaseError, connection, connections, transaction
from django.test import TransactionTestCase, override_settings, tag

from catalog.admin import CATEGORY_TREE_LOCK
from catalog.models import Category, GenericProduct, Product
from classification import demo, queue, services
from classification.models import ClassificationRejection, ClassificationRun, ProductClassification
from classification.tests.factories import (
    CHEESE, JUICE, KEFIR_A, KEFIR_B, MILK, SAUSAGE_A, SAUSAGE_B, UNKNOWN, add_product, apply, existing, generic,
    generic_of, new, product, record, snapshot, suggest,
)
from merges import services as merges
from merges.models import ProductMerge
from recognition.importer import IMPORT_LOCK


def import_lock(cursor):
    cursor.execute("SELECT pg_advisory_xact_lock(%s)", [IMPORT_LOCK])


def tree_lock(cursor):
    cursor.execute("SELECT pg_advisory_xact_lock(%s, %s)", CATEGORY_TREE_LOCK)


class ConcurrencyTestCase(TransactionTestCase):
    """Real PostgreSQL connections: one per thread, no outer test transaction."""

    def setUp(self):
        demo.seed_demo()
        suggest()

    def hold(self, lock):
        """Context: another connection holds ``lock(cursor)`` inside an open transaction."""
        test = self

        class Holder:
            def __enter__(self):
                self.held, self.release = threading.Event(), threading.Event()
                self.pool = ThreadPoolExecutor(max_workers=1)
                self.future = self.pool.submit(self.run)
                test.assertTrue(self.held.wait(5), "The other connection did not take the lock")
                return self

            def run(self):
                try:
                    with transaction.atomic(), connection.cursor() as cursor:
                        lock(cursor)
                        self.held.set()
                        self.release.wait(30)
                finally:
                    connections.close_all()

            def __exit__(self, *exc):
                self.release.set()
                self.future.result(timeout=10)
                self.pool.shutdown()

        return Holder()

    def assertBusy(self, call):
        before = snapshot()
        with self.assertRaises(services.ClassificationBusy) as caught:
            call()
        self.assertEqual(caught.exception.code, "classification_busy")
        self.assertEqual(snapshot(), before)


@tag("integration")
class ImportLockTests(ConcurrencyTestCase):
    def operations(self):
        milk, juice = record(MILK), record(JUICE)
        return {
            "confirm": lambda: services.confirm(milk.pk, version=1, generic_id=milk.suggested_generic_ref),
            "choose another": lambda: services.confirm(juice.pk, version=1, generic_id=generic("Молоко").pk),
            "reject": lambda: services.reject(juice.pk, version=1),
            "confirm many": lambda: services.confirm_many([(milk.pk, 1), (juice.pk, 1)]),
            "reconcile": services.reconcile,
            "cancel pending": services.cancel_pending,
            "request manual": lambda: services.request_run(trigger="manual"),
            "request command": lambda: services.request_run(trigger="command"),
            "start run": services.start_run,
            "apply": lambda: apply(new(UNKNOWN, "Лимонад", ("Напитки",), "l")),
        }

    def test_busy_import_mutex_refuses_every_operation_without_changes(self):
        with self.hold(import_lock):
            for name, call in self.operations().items():
                with self.subTest(operation=name):
                    self.assertBusy(call)
        # Nothing was retried behind the caller's back: the same calls go through now.
        self.assertEqual(self.operations()["confirm"]().status, "confirmed")
        self.assertEqual(self.operations()["reject"]().status, "rejected")
        self.assertEqual(self.operations()["apply"]().applied, 1)

    def test_queueing_from_an_import_does_not_take_the_mutex(self):
        fresh = add_product("Demo Neu")
        with self.hold(import_lock):
            run, created = services.request_run(trigger="import", product_ids=[fresh.pk])
        self.assertEqual((created, run.status, run.product_ids), (True, "queued", [fresh.pk]))

    def test_step_after_a_merge_runs_inside_the_merge_transaction(self):
        """The merge already holds the mutex: its own session takes it again without waiting."""
        twin = add_product(KEFIR_A + ".")
        original = product(KEFIR_A)
        merges.detect()
        group = ProductMerge.objects.get(status="pending")
        merges.confirm(group.pk, version=group.version, target_product_id=twin.pk)
        entry = record(KEFIR_A + ".")
        self.assertEqual((entry.status, entry.product_ref, entry.origin_product_ref, entry.version), (
            "pending", twin.pk, original.pk, 2))
        # And while another session holds the mutex the merge itself is told "busy"; nothing moves.
        third = add_product(KEFIR_A + "..")
        merges.detect()
        group = ProductMerge.objects.get(status="pending")
        before = snapshot()
        with self.hold(import_lock), self.assertRaises(merges.MergeBusy):
            merges.confirm(group.pk, version=group.version, target_product_id=third.pk)
        self.assertEqual(snapshot(), before)

    def test_busy_merge_leaves_the_rejection_memory_of_the_duplicate_in_place(self):
        twin = add_product(KEFIR_A + ".")
        original = product(KEFIR_A)
        apply(new(twin, "Сыр", ("Продукты питания", "Молочные продукты"), "kg"))
        services.reject(record(KEFIR_A + ".").pk, version=1)
        memory = list(ClassificationRejection.objects.order_by("pk").values())
        self.assertEqual([row["product_id"] for row in memory], [twin.pk])
        merges.detect()
        group = ProductMerge.objects.get(status="pending")
        before = snapshot()
        with self.hold(import_lock), self.assertRaises(merges.MergeBusy):
            merges.confirm(group.pk, version=group.version, target_product_id=original.pk)
        self.assertEqual(snapshot(), before)
        self.assertEqual(list(ClassificationRejection.objects.order_by("pk").values()), memory)
        # The same call goes through once the mutex is free, and the transfer with it.
        merges.confirm(group.pk, version=group.version, target_product_id=original.pk)
        self.assertEqual(
            list(ClassificationRejection.objects.order_by("pk").values()), [{**memory[0], "product_id": original.pk}],
        )


@tag("integration")
class TreeLockTests(ConcurrencyTestCase):
    def test_operations_that_delete_a_category_are_refused(self):
        juice = record(JUICE)
        with self.hold(tree_lock):
            # The rejected «Сок» would take the created root «Напитки» with it.
            self.assertBusy(lambda: services.reject(juice.pk, version=1))
            self.assertBusy(lambda: services.confirm(juice.pk, version=1, generic_id=generic("Молоко").pk))
            Product.objects.filter(name=JUICE).update(generic=generic("Молоко"))
            # The reconciliation outcome is not saved either: the whole transaction is refused.
            self.assertBusy(lambda: services.reject(juice.pk, version=1))
            self.assertBusy(services.reconcile)
            self.assertBusy(lambda: services.request_run(trigger="manual"))
            Product.objects.filter(name=JUICE).update(generic=generic("Сок"))
        self.assertEqual((record(JUICE).status, generic_of(JUICE)), ("pending", "Сок"))
        self.assertTrue(Category.objects.filter(name="Напитки").exists())
        self.assertEqual(services.reject(juice.pk, version=1).status, "rejected")
        self.assertFalse(Category.objects.filter(name="Напитки").exists())

    def test_operations_that_create_a_category_are_refused(self):
        fresh = add_product("Demo Neu")
        with self.hold(tree_lock):
            self.assertBusy(lambda: apply(new(UNKNOWN, "Пельмени", ("Заморозка",), "kg")))
            # The item applied before the refused one is rolled back with the whole batch.
            self.assertBusy(lambda: apply(
                existing(UNKNOWN, generic("Молоко")), new(fresh, "Сметана", ("Новая",), "kg"),
            ))
        self.assertFalse(Category.objects.filter(name__in=("Заморозка", "Новая")).exists())
        self.assertEqual(generic_of(UNKNOWN), "Не разобрано")

    def test_operations_without_category_changes_go_through(self):
        with self.hold(tree_lock):
            milk = record(MILK)
            self.assertEqual(
                services.confirm(milk.pk, version=1, generic_id=milk.suggested_generic_ref).status, "confirmed",
            )
            # «Колбаса» stays for the other pending record, «Сыр» lives in a category that existed before.
            self.assertEqual(services.reject(record(SAUSAGE_A).pk, version=1).status, "rejected")
            self.assertEqual(services.reject(record(CHEESE).pk, version=1).status, "rejected")
            self.assertEqual(
                services.confirm(record(KEFIR_A).pk, version=1, generic_id=generic("Молоко").pk).resolution, "other",
            )
            self.assertEqual(apply(new(UNKNOWN, "Творог", ("Продукты питания", "Молочные продукты"), "kg")).applied, 1)
            self.assertEqual(services.reconcile(), 0)
            self.assertTrue(services.request_run(trigger="manual")[1])
        self.assertFalse(GenericProduct.objects.filter(name="Сыр").exists())

    def test_cancel_pending_stops_at_the_busy_record_and_keeps_the_earlier_ones(self):
        """Each record is its own transaction: the refused one is rolled back, the rest waits for a repeat."""
        with self.hold(tree_lock):
            with self.assertRaises(services.ClassificationBusy):
                services.cancel_pending()
            statuses = dict(ProductClassification.objects.values_list("product_name", "status"))
            # Up to the first record whose cleanup deletes a created category («Мясные продукты»).
            self.assertEqual(
                {name: statuses[name] for name in (MILK, KEFIR_A, KEFIR_B, CHEESE, SAUSAGE_A, SAUSAGE_B, JUICE)},
                {MILK: "rejected", KEFIR_A: "rejected", KEFIR_B: "rejected", CHEESE: "rejected",
                 SAUSAGE_A: "rejected", SAUSAGE_B: "pending", JUICE: "pending"},
            )
            self.assertEqual(generic_of(SAUSAGE_B), "Колбаса")
            self.assertTrue(Category.objects.filter(name="Мясные продукты").exists())
        result = services.cancel_pending()
        self.assertEqual((len(result["cancelled"]), result["removed_categories"]), (4, 4))
        self.assertFalse(ProductClassification.objects.filter(status="pending").exists())
        self.assertEqual(set(GenericProduct.objects.values_list("name", flat=True)), {"Не разобрано", "Молоко"})


@tag("integration")
class RowLockTests(ConcurrencyTestCase):
    def test_row_held_by_another_writer_ends_as_busy_after_the_statement_timeout(self):
        juice = product(JUICE)

        def product_row(cursor):
            cursor.execute("SELECT 1 FROM catalog_product WHERE id = %s FOR UPDATE", [juice.pk])

        entry = record(JUICE)
        with self.hold(product_row):
            self.assertBusy(lambda: services.reject(entry.pk, version=1))
        self.assertEqual(services.reject(entry.pk, version=1).status, "rejected")

    def test_run_row_is_not_needed_for_decisions(self):
        run = ClassificationRun.objects.get()

        def run_row(cursor):
            cursor.execute("SELECT 1 FROM classification_classificationrun WHERE id = %s FOR UPDATE", [run.pk])

        with self.hold(run_row):
            milk = record(MILK)
            self.assertEqual(
                services.confirm(milk.pk, version=1, generic_id=milk.suggested_generic_ref).status, "confirmed",
            )


@tag("integration")
class QueuedRunOfAllCandidatesTests(ConcurrencyTestCase):
    """An import and the worker meet at the single queued run of all candidates."""

    def setUp(self):
        super().setUp()
        self.queued, created = services.request_run(trigger="manual")
        self.assertTrue(created)
        self.assertEqual((self.queued.scope, self.queued.product_ids), ("all", [product(UNKNOWN).pk]))
        self.fresh = add_product("Demo Neu")

    def run_row(self, cursor):
        cursor.execute("SELECT 1 FROM classification_classificationrun WHERE id = %s FOR UPDATE", [self.queued.pk])

    def state(self):
        return ClassificationRun.objects.filter(pk=self.queued.pk).values().get()

    def test_import_extends_the_run_while_another_session_holds_the_mutex(self):
        with self.hold(import_lock):
            run, created = services.request_run(trigger="import", product_ids=[self.fresh.pk])
        self.assertEqual((run.pk, created, run.scope, run.version), (self.queued.pk, False, "all", 2))
        self.assertEqual((run.product_ids, run.requested_count), ([product(UNKNOWN).pk, self.fresh.pk], 2))

    @override_settings(PRODUCT_CLASSIFICATION_RUN_LIMIT=1)
    def test_count_of_the_remaining_does_not_take_the_mutex_either(self):
        with self.hold(import_lock):
            run, created = services.request_run(trigger="import", product_ids=[self.fresh.pk])
        self.assertEqual((run.pk, created, run.product_ids), (self.queued.pk, False, self.queued.product_ids))
        self.assertEqual((run.requested_count, run.remaining_count, run.version), (1, 1, 2))

    def test_worker_skips_the_run_an_import_holds_and_claims_it_extended(self):
        with self.hold(self.run_row):
            self.assertIsNone(queue.claim_run())
        services.request_run(trigger="import", product_ids=[self.fresh.pk])
        claimed = queue.claim_run()
        self.assertEqual((claimed.pk, claimed.status, claimed.scope), (self.queued.pk, "running", "all"))
        self.assertEqual(claimed.product_ids, [product(UNKNOWN).pk, self.fresh.pk])

    def test_import_waiting_for_the_run_row_fails_after_the_statement_timeout_and_changes_nothing(self):
        before = self.state()
        with self.hold(self.run_row):
            with self.assertRaises(DatabaseError) as caught:
                services.request_run(trigger="import", product_ids=[self.fresh.pk])
            self.assertIn(caught.exception.__cause__.sqlstate, services.BUSY_SQLSTATES)
        self.assertEqual(self.state(), before)
        # The product is not lost: the next import of it (or a manual run) adds it.
        run, _created = services.request_run(trigger="import", product_ids=[self.fresh.pk])
        self.assertEqual((run.pk, run.product_ids[-1], run.version), (self.queued.pk, self.fresh.pk, 2))
