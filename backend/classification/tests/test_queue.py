"""The run queue of the host worker: claim, lease, batch outcome, stop, recovery. Fake only."""
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.db import IntegrityError
from django.test import TestCase, override_settings, tag

from classification import demo, queue, services
from classification.models import ClassificationAttempt, ClassificationRun, ProductClassification
from classification.runner import BatchResult
from classification.tests.factories import JUICE, KEFIR_A, MILK, SOAP, TOAST, UNKNOWN, product
from recognition.queue import db_now


def result(consumed=0, error_code=""):
    return BatchResult(request=None, consumed=consumed, error_code=error_code)


def expire(run):
    ClassificationRun.objects.filter(pk=run.pk).update(lease_expires_at=db_now() - timedelta(seconds=1))


def attempt(run, **fields):
    return ClassificationAttempt.objects.create(run=run, batch=1, ordinal=1, input_sha256="0" * 64, **fields)


@tag("integration")
@override_settings(RECEIPT_OCR_PROVIDER="fake", PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS=180)
class QueueTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def ids(self, *names):
        return [product(name).pk for name in names]

    def queued(self, *names, trigger="manual"):
        run, created = services.request_run(trigger=trigger, product_ids=self.ids(*names) if names else None)
        self.assertTrue(created)
        return run

    def claimed(self, *names, **options):
        self.queued(*names, **options)
        return queue.claim_run()

    def state(self, run):
        run.refresh_from_db()
        return run.status, run.cursor, run.error_code


class ClaimTests(QueueTestCase):
    def test_empty_queue(self):
        self.assertIsNone(queue.claim_run())

    def test_claim_makes_the_queued_run_running_with_a_lease(self):
        queued = self.queued()
        before = db_now()
        run = queue.claim_run()
        self.assertEqual((run.pk, run.status, run.version), (queued.pk, "running", queued.version + 1))
        self.assertIsInstance(run.run_token, uuid.UUID)
        self.assertEqual(run.started_at, run.heartbeat_at)
        self.assertEqual(run.lease_expires_at - run.heartbeat_at, timedelta(seconds=240))  # timeout + 60 s
        self.assertGreaterEqual(run.heartbeat_at, before)
        self.assertEqual((run.cursor, run.recoveries, run.finished_at), (0, 0, None))
        self.assertIsNone(queue.claim_run())  # nothing else waits

    def test_nothing_is_claimed_while_another_run_executes(self):
        running = services.start_run(product_ids=self.ids(MILK))  # the suggest command
        self.queued(TOAST, trigger="import")
        self.assertIsNone(queue.claim_run())
        services.finish_run(running)
        self.assertEqual(queue.claim_run().product_ids, self.ids(TOAST))

    def test_heartbeat_renews_only_the_owned_lease(self):
        run = self.claimed()
        ClassificationRun.objects.filter(pk=run.pk).update(lease_expires_at=db_now() + timedelta(seconds=1))
        renewed = queue.heartbeat(run)
        self.assertGreater(renewed.lease_expires_at - db_now(), timedelta(seconds=230))
        self.assertEqual(renewed.version, run.version)  # private write: the public version stays
        stale = ClassificationRun.objects.get(pk=run.pk)
        stale.run_token = uuid.uuid4()
        with self.assertRaises(queue.RunLost):
            queue.heartbeat(stale)
        queue.fail_run(run, "timeout")
        with self.assertRaises(queue.RunLost):
            queue.heartbeat(run)


@override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=2)
class BatchOutcomeTests(QueueTestCase):
    def test_products_left_put_the_run_back_in_the_queue(self):
        run = self.claimed()
        total = len(run.product_ids)
        after = queue.finish_batch(run, result(consumed=2))
        self.assertEqual((after.status, after.cursor, after.error_code), ("queued", 2, ""))
        self.assertEqual((after.run_token, after.heartbeat_at, after.lease_expires_at, after.finished_at), (None,) * 4)
        self.assertEqual(after.version, run.version + 1)
        again = queue.claim_run()
        self.assertEqual((again.pk, again.cursor, again.started_at), (run.pk, 2, run.started_at))
        self.assertNotEqual(again.run_token, run.run_token)
        self.assertEqual(len(again.product_ids), total)

    def test_last_batch_succeeds(self):
        run = self.claimed(MILK, TOAST)
        after = queue.finish_batch(run, result(consumed=2))
        self.assertEqual((after.status, after.cursor, after.error_code), ("succeeded", 2, ""))
        self.assertIsNotNone(after.finished_at)
        self.assertIsNone(after.run_token)
        self.assertIsNone(queue.claim_run())

    def test_cursor_never_passes_the_products(self):
        run = self.claimed(MILK)
        self.assertEqual(self.state(queue.finish_batch(run, result(consumed=25))), ("succeeded", 1, ""))

    def test_failed_model_call_fails_the_run_with_its_code(self):
        for code in ("provider_unavailable", "auth_required", "invalid_output", "timeout", "input_too_large"):
            with self.subTest(code=code):
                run = self.claimed(MILK, TOAST, JUICE)
                after = queue.finish_batch(run, result(error_code=code))
                self.assertEqual((after.status, after.cursor, after.error_code), ("failed", 0, code))
                self.assertIsNotNone(after.finished_at)

    def test_batch_that_consumed_nothing_cannot_repeat_forever(self):
        run = self.claimed(MILK, TOAST, JUICE)
        self.assertEqual(self.state(queue.finish_batch(run, result())), ("failed", 0, "internal_error"))

    def test_fail_run_closes_running_attempts(self):
        run = self.claimed(MILK)
        left = attempt(run)
        after = queue.fail_run(run, "internal_error")
        self.assertEqual((after.status, after.error_code), ("failed", "internal_error"))
        left.refresh_from_db()
        self.assertEqual((left.status, left.error_code, left.finished_at is not None), ("failed", "internal_error", True))

    def test_closed_run_is_lost_for_every_transition(self):
        run = self.claimed(MILK, TOAST, JUICE)
        queue.fail_run(run, "auth_required")
        before = ClassificationRun.objects.filter(pk=run.pk).values().get()
        for operation in (
            lambda: queue.finish_batch(run, result(consumed=2)), lambda: queue.fail_run(run, "timeout"),
            lambda: queue.release_run(run), lambda: queue.heartbeat(run),
        ):
            with self.assertRaises(queue.RunLost):
                operation()
        self.assertEqual(ClassificationRun.objects.filter(pk=run.pk).values().get(), before)

    def test_claim_of_another_token_is_lost(self):
        run = self.claimed(MILK, TOAST, JUICE)
        queue.release_run(run)
        current = queue.claim_run()
        with self.assertRaises(queue.RunLost):
            queue.finish_batch(run, result(consumed=2))  # the old claim
        self.assertEqual(self.state(current), ("running", 0, ""))


class StopTests(QueueTestCase):
    def test_release_requeues_without_counting_a_recovery(self):
        run = self.claimed(MILK, TOAST)
        left = attempt(run)
        after = queue.release_run(run)
        self.assertEqual((after.status, after.cursor, after.recoveries, after.error_code), ("queued", 0, 0, ""))
        self.assertEqual((after.run_token, after.heartbeat_at, after.lease_expires_at), (None, None, None))
        left.refresh_from_db()
        self.assertEqual((left.status, left.error_code), ("failed", "worker_lost"))
        self.assertEqual(queue.claim_run().pk, run.pk)


class RecoveryTests(QueueTestCase):
    def test_live_lease_is_not_recovered(self):
        run = self.claimed(MILK)
        self.assertEqual(queue.recover_expired_runs(), [])
        self.assertEqual(self.state(run), ("running", 0, ""))

    def test_expired_lease_requeues_twice_then_fails_as_worker_lost(self):
        self.queued(MILK, TOAST)
        for recoveries in (1, 2):
            run = queue.claim_run()
            left = ClassificationAttempt.objects.create(
                run=run, batch=recoveries, ordinal=1, input_sha256="0" * 64)
            expire(run)
            (recovered,) = queue.recover_expired_runs()
            self.assertEqual((recovered.pk, recovered.status, recovered.recoveries), (run.pk, "queued", recoveries))
            self.assertEqual((recovered.run_token, recovered.lease_expires_at, recovered.cursor), (None, None, 0))
            left.refresh_from_db()
            self.assertEqual((left.status, left.error_code), ("failed", "worker_lost"))
            self.assertEqual(queue.recover_expired_runs(), [])
        run = queue.claim_run()
        expire(run)
        (recovered,) = queue.recover_expired_runs()
        self.assertEqual((recovered.status, recovered.error_code, recovered.recoveries), ("failed", "worker_lost", 2))
        self.assertIsNotNone(recovered.finished_at)
        self.assertIsNone(queue.claim_run())

    def test_recovered_batch_skips_what_the_lost_claim_already_applied(self):
        from classification.classifier import FakeClassifier
        from classification.worker import process_batch

        run = self.claimed(MILK, KEFIR_A)
        # The lost claim applied the batch and died before moving the cursor.
        from classification import runner
        runner.run_batch(run.product_ids, classifier=FakeClassifier("mixed"), run=run)
        self.assertEqual(ProductClassification.objects.count(), 2)
        expire(run)
        queue.recover_expired_runs()
        after = process_batch(queue.claim_run(), classifier=FakeClassifier("mixed"))
        self.assertEqual((after.status, after.cursor, after.applied_count), ("succeeded", 2, 2))
        self.assertEqual(after.stats, {"not_eligible": 2})
        self.assertEqual(ProductClassification.objects.count(), 2)

    def test_expired_command_run_fails_when_a_started_run_waits(self):
        # The worker's run waits between batches; a crashed ``suggest`` run cannot take its place.
        with override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=1):
            waiting = queue.finish_batch(self.claimed(MILK, TOAST), result(consumed=1))
        command = services.start_run(product_ids=self.ids(JUICE))
        expire(command)
        (recovered,) = queue.recover_expired_runs()
        self.assertEqual((recovered.pk, recovered.status, recovered.error_code), (command.pk, "failed", "worker_lost"))
        self.assertEqual(self.state(waiting), ("queued", 1, ""))


@override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=1)
class AbsorbTests(QueueTestCase):
    """An import may queue its own run while a batch executes; only one run may wait."""

    def test_run_queued_during_the_batch_joins_the_requeued_one(self):
        run = self.claimed(MILK, TOAST)
        other, created = services.request_run(trigger="import", product_ids=self.ids(TOAST, JUICE, SOAP))
        self.assertTrue(created)
        after = queue.finish_batch(run, result(consumed=1))
        self.assertEqual((after.pk, after.status, after.cursor, after.trigger), (run.pk, "queued", 1, "manual"))
        self.assertEqual(after.product_ids, self.ids(MILK, TOAST, JUICE, SOAP))  # TOAST is not added twice
        self.assertEqual((after.requested_count, after.remaining_count), (4, 0))
        self.assertFalse(ClassificationRun.objects.filter(pk=other.pk).exists())
        self.assertEqual(ClassificationRun.objects.count(), 1)

    def test_last_batch_leaves_the_other_run_waiting(self):
        run = self.claimed(MILK)
        other, _created = services.request_run(trigger="import", product_ids=self.ids(JUICE))
        self.assertEqual(self.state(queue.finish_batch(run, result(consumed=1))), ("succeeded", 1, ""))
        self.assertEqual(queue.claim_run().pk, other.pk)

    def test_release_and_recovery_absorb_too(self):
        run = self.claimed(MILK)
        services.request_run(trigger="import", product_ids=self.ids(JUICE))
        after = queue.release_run(run)
        self.assertEqual((after.status, after.product_ids), ("queued", self.ids(MILK, JUICE)))
        run = queue.claim_run()
        services.request_run(trigger="import", product_ids=self.ids(SOAP))
        expire(run)
        (recovered,) = queue.recover_expired_runs()
        self.assertEqual((recovered.status, recovered.recoveries), ("queued", 1))
        self.assertEqual(recovered.product_ids, self.ids(MILK, JUICE, SOAP))
        self.assertEqual(ClassificationRun.objects.count(), 1)

    @override_settings(PRODUCT_CLASSIFICATION_RUN_LIMIT=3)
    def test_absorbed_products_beyond_the_limit_are_counted_as_remaining(self):
        run = self.claimed(MILK, TOAST)
        services.request_run(trigger="import", product_ids=self.ids(JUICE, SOAP, UNKNOWN))
        after = queue.finish_batch(run, result(consumed=1))
        self.assertEqual(after.product_ids, self.ids(MILK, TOAST, JUICE))
        self.assertEqual((after.requested_count, after.remaining_count), (3, 2))

    def test_lost_race_for_the_queued_place_is_repeated(self):
        run = self.claimed(MILK, TOAST)
        original, calls = queue._requeue, []

        def racing(row, now):
            calls.append(row.pk)
            if len(calls) == 1:
                raise IntegrityError("classification_run_one_queued")
            return original(row, now)

        with patch.object(queue, "_requeue", racing):
            after = queue.finish_batch(run, result(consumed=1))
        self.assertEqual((after.status, after.cursor, len(calls)), ("queued", 1, 2))

    def test_persistent_conflict_is_not_hidden(self):
        run = self.claimed(MILK, TOAST)
        with patch.object(queue, "_requeue", side_effect=IntegrityError("x")) as requeue, \
                self.assertRaises(IntegrityError):
            queue.finish_batch(run, result(consumed=1))
        self.assertEqual(requeue.call_count, queue.REQUEUE_ATTEMPTS)
        self.assertEqual(self.state(run), ("running", 0, ""))


@override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=1)
class RequestBetweenBatchesTests(QueueTestCase):
    """``request_run`` on a run that waits between batches keeps what its cursor passed."""

    def test_import_adds_only_behind_the_cursor(self):
        ids = self.ids(TOAST, JUICE, SOAP)
        run = queue.finish_batch(self.claimed(TOAST, JUICE, SOAP, trigger="import"), result(consumed=2))
        self.assertEqual((run.status, run.cursor, run.product_ids), ("queued", 2, sorted(ids)))
        low = self.ids(MILK)  # a lower id than everything in the run
        self.assertLess(low[0], min(ids))
        again, created = services.request_run(trigger="import", product_ids=low + ids[:1])
        self.assertEqual((again.pk, created), (run.pk, False))
        done, tail = sorted(ids)[:2], sorted(set(sorted(ids)[2:]) | set(low))
        self.assertEqual((again.cursor, again.product_ids), (2, done + tail))
        self.assertEqual(again.requested_count, 4)
        # The next batch takes the first product behind the cursor.
        claimed = queue.claim_run()
        self.assertEqual(claimed.product_ids[claimed.cursor], tail[0])

    def test_manual_run_widens_behind_the_cursor(self):
        run = queue.finish_batch(self.claimed(TOAST, JUICE, trigger="import"), result(consumed=1))
        done = run.product_ids[:1]
        widened, created = services.request_run(trigger="manual")
        self.assertEqual((widened.pk, created, widened.scope, widened.cursor), (run.pk, False, "all", 1))
        candidates = list(services.candidates().values_list("pk", flat=True))
        self.assertEqual(widened.product_ids, done + [pk for pk in candidates if pk not in done])
        self.assertEqual(widened.requested_count, len(widened.product_ids))
        self.assertEqual(len(widened.product_ids), len(set(widened.product_ids)))
