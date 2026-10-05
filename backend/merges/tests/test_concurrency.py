import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.db import connection, connections, transaction
from django.test import TransactionTestCase, tag

from catalog.models import Product
from merges import demo, services
from merges.models import ProductMerge
from merges.tests.factories import MAULTASCHEN, PIZZA, ZIMBO, add_product, pending_group, product, snapshot
from receipts.models import ReceiptLine
from recognition.importer import IMPORT_LOCK


def outcome(call):
    try:
        return call()
    except services.MergeError as error:
        return error


class ConcurrencyTestCase(TransactionTestCase):
    """Real PostgreSQL connections: one per thread, no outer test transaction."""

    def setUp(self):
        demo.seed_demo()
        services.detect()

    def with_first_paused(self, first, second):
        """Run ``first`` in another connection, stop it inside its transaction, then run ``second``."""
        entered, release = threading.Event(), threading.Event()
        state = threading.local()
        original = services._absorb

        def paused(*args, **kwargs):
            if getattr(state, "pause", False):
                state.pause = False
                entered.set()
                if not release.wait(10):
                    raise AssertionError("The first operation was never released")
            return original(*args, **kwargs)

        def run_first():
            state.pause = True
            try:
                return outcome(first)
            finally:
                connections.close_all()

        with patch.object(services, "_absorb", paused), ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(run_first)
            try:
                self.assertTrue(entered.wait(5), "The first operation did not reach its transaction")
                second_result = outcome(second)
            finally:
                release.set()
            return future.result(timeout=10), second_result

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
                        self.release.wait(15)
                finally:
                    connections.close_all()

            def __exit__(self, *exc):
                self.release.set()
                self.future.result(timeout=10)
                self.pool.shutdown()

        return Holder()


@tag("integration")
class RaceTests(ConcurrencyTestCase):
    def test_two_confirms(self):
        group = pending_group(PIZZA[0])
        target = group.target_ref

        def confirm():
            return services.confirm(group.pk, version=1, target_product_id=target)

        def second():
            # The import mutex is held by the first confirm: an import would be told "busy" too.
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [IMPORT_LOCK])
                self.assertFalse(cursor.fetchone()[0])
            return confirm()

        first_result, second_result = self.with_first_paused(confirm, second)
        self.assertIsInstance(second_result, services.MergeBusy)
        self.assertEqual(second_result.code, "merge_busy")
        self.assertEqual((first_result.pk, first_result.status), (group.pk, "confirmed"))
        self.assertEqual(list(Product.objects.filter(name__in=PIZZA).values_list("pk", flat=True)), [target])
        self.assertEqual(ReceiptLine.objects.filter(product_id=target).count(), 4)
        before = snapshot()
        # The retry the client makes by hand is an ordinary repeat.
        self.assertEqual(confirm().status, "confirmed")
        self.assertEqual(snapshot(), before)

    def test_confirm_against_cancel(self):
        group = pending_group(PIZZA[0])
        first_result, second_result = self.with_first_paused(
            lambda: services.confirm(group.pk, version=1, target_product_id=group.target_ref),
            lambda: services.cancel(group.pk),
        )
        self.assertEqual(first_result.status, "confirmed")
        self.assertIsInstance(second_result, services.MergeBusy)
        before = snapshot()
        with self.assertRaises(services.MergeResolved):
            services.cancel(group.pk)
        self.assertEqual(snapshot(), before)
        self.assertFalse(Product.objects.filter(name=PIZZA[1]).exists())

    def test_cancel_against_confirm(self):
        group = pending_group(PIZZA[0])
        first_result, second_result = self.with_first_paused(
            lambda: services.cancel(group.pk),
            lambda: services.confirm(group.pk, version=1, target_product_id=group.target_ref),
        )
        self.assertEqual(first_result.status, "cancelled")
        self.assertIsInstance(second_result, services.MergeBusy)
        before = snapshot()
        with self.assertRaises(services.MergeResolved):
            services.confirm(group.pk, version=1, target_product_id=group.target_ref)
        self.assertEqual(snapshot(), before)
        for name in PIZZA:
            self.assertEqual(set(ReceiptLine.objects.filter(product=product(name)).values_list("raw_name", flat=True)), {name})

    def test_exclude_against_exclude(self):
        group = pending_group(MAULTASCHEN[0])
        first_result, second_result = self.with_first_paused(
            lambda: services.exclude(group.pk, version=1, product_id=product(MAULTASCHEN[2]).pk),
            lambda: services.exclude(group.pk, version=1, product_id=product(MAULTASCHEN[1]).pk),
        )
        self.assertEqual((first_result.status, first_result.version), ("pending", 2))
        self.assertIsInstance(second_result, services.MergeBusy)
        # The second client retries with the version it read before: the set has changed.
        with self.assertRaises(services.MergeChanged):
            services.exclude(group.pk, version=1, product_id=product(MAULTASCHEN[1]).pk)
        self.assertEqual(ProductMerge.objects.get(pk=group.pk).version, 2)

    def test_busy_import_mutex_refuses_every_operation(self):
        pizza, zimbo, maultaschen = (pending_group(names[0]) for names in (PIZZA, ZIMBO, MAULTASCHEN))
        add_product("Steinhof,PizzaSpezial")
        before = snapshot()
        operations = {
            "detect": lambda: services.detect(),
            "confirm": lambda: services.confirm(pizza.pk, version=1, target_product_id=pizza.target_ref),
            "cancel": lambda: services.cancel(zimbo.pk),
            "exclude": lambda: services.exclude(maultaschen.pk, version=1, product_id=product(MAULTASCHEN[1]).pk),
            "cancel_pending": services.cancel_pending,
        }
        with self.hold(lambda cursor: cursor.execute("SELECT pg_advisory_xact_lock(%s)", [IMPORT_LOCK])):
            for name, operation in operations.items():
                with self.subTest(operation=name):
                    started = time.monotonic()
                    self.assertIsInstance(outcome(operation), services.MergeBusy)
                    self.assertLess(time.monotonic() - started, 1.5)  # try-lock: no waiting
            # Reading stays available.
            self.assertEqual(services.detect(dry_run=True).extended, 1)
            self.assertEqual(len(services.describe(services.groups())), 7)
            self.assertEqual(snapshot(), before)
        self.assertEqual(snapshot(), before)
        self.assertEqual(services.detect().extended, 1)

    def test_locked_receipt_line_gives_busy_after_the_statement_timeout(self):
        group = pending_group(PIZZA[0])
        line = ReceiptLine.objects.filter(raw_name=PIZZA[2]).order_by("pk").first()
        before = snapshot()
        with self.hold(lambda cursor: cursor.execute(
            "SELECT id FROM receipts_receiptline WHERE id = %s FOR UPDATE", [line.pk],
        )):
            started = time.monotonic()
            result = outcome(lambda: services.cancel(group.pk))
            elapsed = time.monotonic() - started
        self.assertIsInstance(result, services.MergeBusy)
        self.assertGreater(elapsed, 1.5)  # waited for statement_timeout=2000 ms
        self.assertLess(elapsed, 6)
        self.assertEqual(snapshot(), before)
        self.assertEqual(services.cancel(group.pk).status, "cancelled")

    def test_operation_inside_a_transaction_holding_the_mutex(self):
        """The importer calls detect under its own import mutex: the lock is re-entrant per session."""
        add_product("Steinhof,PizzaSpezial")
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [IMPORT_LOCK])
                self.assertTrue(cursor.fetchone()[0])
            self.assertEqual(services.detect(product_ids=[product("Steinhof,PizzaSpezial").pk]).extended, 1)


@tag("integration")
class FailureTests(ConcurrencyTestCase):
    """A failure in the middle of an operation leaves no trace."""

    def assert_unchanged_after(self, target, operation):
        before = snapshot()
        with patch.object(services, target, side_effect=RuntimeError("boom")), self.assertRaises(RuntimeError):
            operation()
        self.assertEqual(snapshot(), before)

    def test_confirm(self):
        group = pending_group(PIZZA[0])
        self.assert_unchanged_after(
            "_resolve", lambda: services.confirm(
                group.pk, version=1, target_product_id=product(PIZZA[2]).pk, name_product_id=product(PIZZA[1]).pk,
            ),
        )
        self.assertEqual(Product.objects.filter(name__in=PIZZA).count(), 3)

    def test_cancel(self):
        group = pending_group(PIZZA[0])
        self.assert_unchanged_after("_resolve", lambda: services.cancel(group.pk))
        self.assert_unchanged_after("_reject", lambda: services.cancel(group.pk))

    def test_exclude(self):
        group = pending_group(MAULTASCHEN[0])
        excluded = product(MAULTASCHEN[0]).pk
        self.assert_unchanged_after("_reject", lambda: services.exclude(group.pk, version=1, product_id=excluded))
        two = pending_group(ZIMBO[0])
        self.assert_unchanged_after(
            "_resolve", lambda: services.exclude(two.pk, version=1, product_id=product(ZIMBO[1]).pk),
        )

    def test_detect_creates_all_groups_or_none(self):
        services.cancel_pending()
        ProductMerge.objects.all().delete()  # drops the rejections' group link only
        from merges.models import ProductMergeRejection

        ProductMergeRejection.objects.all().delete()
        before = snapshot()
        original, calls = services._absorb, []

        def failing(*args, **kwargs):
            calls.append(1)
            if len(calls) == 4:
                raise RuntimeError("boom")
            return original(*args, **kwargs)

        with patch.object(services, "_absorb", failing), self.assertRaises(RuntimeError):
            services.detect()
        self.assertEqual(len(calls), 4)
        self.assertEqual(snapshot(), before)
        self.assertEqual(services.detect().created, 7)

    def test_cancel_pending_stops_at_the_first_failure_and_keeps_earlier_groups_cancelled(self):
        original, calls = services._resolve, []

        def failing(*args, **kwargs):
            calls.append(1)
            if len(calls) == 3:
                raise RuntimeError("boom")
            return original(*args, **kwargs)

        with patch.object(services, "_resolve", failing), self.assertRaises(RuntimeError):
            services.cancel_pending()
        # Each group is its own transaction: two are cancelled, the rest is intact and can be retried.
        self.assertEqual(ProductMerge.objects.filter(status="cancelled").count(), 2)
        self.assertEqual(ProductMerge.objects.filter(status="pending").count(), 5)
        self.assertEqual(len(services.cancel_pending()), 5)
