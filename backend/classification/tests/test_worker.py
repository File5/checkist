"""One batch of a claimed run (``worker.process_batch``) with every fake scenario. Fake only."""
import threading
from datetime import timedelta
from unittest.mock import patch

from django.test import TestCase, override_settings, tag

from classification import demo, queue, runner, services
from classification.classifier import FakeClassifier
from classification.models import (
    ClassificationAttempt, ClassificationRun, CreatedCategory, CreatedGenericProduct, ProductClassification,
)
from classification.tests.factories import (
    CATALOG_MODELS, CHEESE, KEFIR_A, MILK, TOAST, generic_of, product, record, snapshot,
)
from classification.worker import process_batch
from recognition.providers.base import ProviderError
from recognition.queue import db_now


def attempts(run):
    return list(run.attempts.order_by("batch", "ordinal").values_list("batch", "ordinal", "status", "error_code"))


def drain(classifier, **options):
    """Claim and process batches until the queue is empty; the status after every batch."""
    statuses = []
    while (run := queue.claim_run()) is not None:
        statuses.append(process_batch(run, classifier=classifier, **options).status)
        if len(statuses) > 20:
            raise AssertionError("the run never ends")
    return statuses


@tag("integration")
@override_settings(RECEIPT_OCR_PROVIDER="fake", RECEIPT_OCR_MAX_ATTEMPTS=2, PRODUCT_CLASSIFICATION_BATCH_SIZE=25)
class WorkerTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def setUp(self):
        pause = patch.object(runner, "_wait")  # the 2–3 s pause between attempts
        self.wait = pause.start()
        self.addCleanup(pause.stop)

    def queued(self, *names):
        run, created = services.request_run(
            trigger="manual", product_ids=[product(name).pk for name in names] if names else None)
        self.assertTrue(created)
        return run

    def one(self, scenario, *names):
        """One batch of a fresh run through the fake scenario; the run after it."""
        self.queued(*names)
        return process_batch(queue.claim_run(), classifier=FakeClassifier(scenario))

    def assertNothingSuggested(self, before):
        self.assertEqual(snapshot(*CATALOG_MODELS), before)
        self.assertEqual(ProductClassification.objects.count(), 0)
        self.assertEqual((CreatedGenericProduct.objects.count(), CreatedCategory.objects.count()), (0, 0))


class ScenarioTests(WorkerTestCase):
    @override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=4)
    def test_mixed_run_goes_batch_by_batch_to_the_demo_result(self):
        run = self.queued()
        self.assertEqual(drain(FakeClassifier("mixed")), ["queued", "queued", "succeeded"])
        run.refresh_from_db()
        expected = demo.EXPECTED
        self.assertEqual((run.status, run.cursor, run.requested_count), ("succeeded", 10, expected["candidates"]))
        self.assertEqual(
            (run.applied_count, run.unknown_count, run.skipped_count), (expected["pending"], expected["unknown"], 0))
        self.assertEqual(run.stats, {"unknown": 1})
        self.assertEqual((run.error_code, run.recoveries, run.run_token), ("", 0, None))
        self.assertEqual(attempts(run), [(1, 1, "succeeded", ""), (2, 1, "succeeded", ""), (3, 1, "succeeded", "")])
        self.assertEqual(
            [len(ids) for ids in run.attempts.order_by("batch").values_list("product_ids", flat=True)], [4, 4, 2])
        pending = ProductClassification.objects.filter(status="pending", run=run)
        self.assertEqual(pending.count(), expected["pending"])
        self.assertEqual(pending.values("suggested_generic_ref").distinct().count(), expected["groups"])
        self.assertEqual(
            (CreatedGenericProduct.objects.count(), CreatedCategory.objects.count()),
            (expected["created_generics"], expected["created_categories"]),
        )
        self.assertEqual((generic_of(MILK), generic_of(KEFIR_A), generic_of(CHEESE)), ("Молоко", "Кефир", "Сыр"))
        self.assertEqual((record(MILK).provider, record(MILK).model), ("fake", ""))

    def test_existing_product(self):
        run = self.one("existing")
        self.assertEqual((run.status, run.applied_count, run.unknown_count, run.skipped_count), ("succeeded", 10, 0, 0))
        self.assertEqual(set(ProductClassification.objects.values_list("suggested_generic_name", flat=True)), {"Молоко"})
        self.assertEqual((CreatedGenericProduct.objects.count(), CreatedCategory.objects.count()), (0, 0))

    def test_new_category(self):
        run = self.one("new_category", MILK, TOAST)
        self.assertEqual((run.status, run.applied_count), ("succeeded", 2))
        self.assertEqual((generic_of(MILK), generic_of(TOAST)), ("Тестовый продукт", "Тестовый продукт"))
        self.assertEqual(
            list(CreatedCategory.objects.order_by("pk").values_list("name", "state")),
            [("Тестовая категория", "provisional"), ("Тестовая подкатегория", "provisional")],
        )
        self.assertEqual(list(CreatedGenericProduct.objects.values_list("name", "state")), [("Тестовый продукт", "provisional")])

    def test_unknown_is_a_success_that_changes_nothing(self):
        before = snapshot(*CATALOG_MODELS)
        run = self.one("unknown")
        self.assertEqual((run.status, run.applied_count, run.unknown_count, run.skipped_count), ("succeeded", 0, 10, 0))
        self.assertEqual(attempts(run), [(1, 1, "succeeded", "")])
        self.assertNothingSuggested(before)

    def test_retryable_failure_is_repeated_then_fails_the_run(self):
        before = snapshot(*CATALOG_MODELS)
        run = self.one("provider_error")
        self.assertEqual((run.status, run.error_code, run.cursor), ("failed", "provider_unavailable", 0))
        self.assertEqual(attempts(run), [(1, 1, "failed", "provider_unavailable"), (1, 2, "failed", "provider_unavailable")])
        self.assertEqual(self.wait.call_count, 1)
        self.assertNothingSuggested(before)
        self.assertIsNone(queue.claim_run())  # a failed run is not taken again

    @override_settings(RECEIPT_OCR_MAX_ATTEMPTS=1)
    def test_attempt_limit_is_the_recognition_setting(self):
        run = self.one("provider_error")
        self.assertEqual(attempts(run), [(1, 1, "failed", "provider_unavailable")])
        self.assertEqual((run.status, self.wait.call_count), ("failed", 0))

    def test_second_attempt_may_succeed(self):
        class Flaky(FakeClassifier):
            calls = 0

            def classify(self, request, context):
                self.calls += 1
                if self.calls == 1:
                    raise ProviderError("network_unavailable")
                return super().classify(request, context)

        self.queued(MILK)
        run = process_batch(queue.claim_run(), classifier=Flaky("mixed"))
        self.assertEqual((run.status, run.applied_count), ("succeeded", 1))
        self.assertEqual(attempts(run), [(1, 1, "failed", "network_unavailable"), (1, 2, "succeeded", "")])

    def test_failure_without_retry(self):
        before = snapshot(*CATALOG_MODELS)
        run = self.one("auth_failure")
        self.assertEqual((run.status, run.error_code), ("failed", "auth_required"))
        self.assertEqual(attempts(run), [(1, 1, "failed", "auth_required")])
        self.assertEqual(self.wait.call_count, 0)
        self.assertNothingSuggested(before)

    def test_invalid_answer_fails_the_run_and_keeps_the_text_private(self):
        before = snapshot(*CATALOG_MODELS)
        for scenario in ("invalid_output", "foreign_product", "missing_product"):
            with self.subTest(scenario=scenario):
                run = self.one(scenario)
                self.assertEqual((run.status, run.error_code, run.cursor), ("failed", "invalid_output", 0))
                self.assertEqual(attempts(run), [(1, 1, "failed", "invalid_output")])  # never repeated
                attempt = run.attempts.get()
                self.assertIn('"schema_version"', attempt.invalid_output_text)
                self.assertIsNone(attempt.raw_payload)
                self.assertNothingSuggested(before)
        self.assertEqual(self.wait.call_count, 0)

    def test_service_target_drops_every_item(self):
        before = snapshot(*CATALOG_MODELS)
        run = self.one("service_target")
        self.assertEqual((run.status, run.applied_count, run.skipped_count), ("succeeded", 0, 10))
        self.assertEqual(run.stats, {"service_target": 10})
        self.assertNothingSuggested(before)

    def test_rejected_variant_is_not_applied_again(self):
        self.one("mixed", MILK)
        rejected = record(MILK)
        services.reject(rejected.pk, version=rejected.version)
        run = self.one("rejected_again", MILK)
        self.assertEqual((run.status, run.applied_count, run.stats), ("succeeded", 0, {"rejected_before": 1}))
        self.assertEqual(generic_of(MILK), "Не разобрано")
        self.assertEqual(ProductClassification.objects.filter(status="pending").count(), 0)

    @override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=4)
    def test_batches_applied_before_a_failure_stay_applied(self):
        run = self.queued()
        self.assertEqual(process_batch(queue.claim_run(), classifier=FakeClassifier("mixed")).status, "queued")
        applied = list(ProductClassification.objects.order_by("pk").values_list("pk", "status"))
        self.assertEqual(len(applied), 4)
        after = process_batch(queue.claim_run(), classifier=FakeClassifier("auth_failure"))
        self.assertEqual((after.pk, after.status, after.error_code, after.cursor), (run.pk, "failed", "auth_required", 4))
        self.assertEqual(after.applied_count, 4)
        self.assertEqual(list(ProductClassification.objects.order_by("pk").values_list("pk", "status")), applied)
        self.assertEqual(generic_of(MILK), "Молоко")

    def test_confirmed_and_meaningful_products_are_not_touched_by_another_run(self):
        self.one("mixed", MILK, KEFIR_A)
        confirmed = record(MILK)
        services.confirm(confirmed.pk, version=confirmed.version, generic_id=confirmed.suggested_generic_ref)
        before = snapshot(*CATALOG_MODELS)
        records = ProductClassification.objects.count()
        # A manual run for the same products: none is a candidate any more.
        self.assertEqual(
            services.request_run(trigger="manual", product_ids=[product(MILK).pk, product(KEFIR_A).pk]), (None, False))
        run = self.one("new_category")  # everything that is still unclassified
        self.assertNotIn(product(MILK).pk, run.product_ids)
        self.assertNotIn(product(KEFIR_A).pk, run.product_ids)
        self.assertEqual((generic_of(MILK), generic_of(KEFIR_A)), ("Молоко", "Кефир"))
        self.assertEqual(ProductClassification.objects.count(), records + run.applied_count)
        self.assertEqual(
            [row for row in snapshot(*CATALOG_MODELS)["Product"] if row["name"] in (MILK, KEFIR_A)],
            [row for row in before["Product"] if row["name"] in (MILK, KEFIR_A)],
        )


class LeaseAndStopTests(WorkerTestCase):
    def test_model_call_starts_with_a_renewed_lease(self):
        seen = []

        class Watching(FakeClassifier):
            def classify(self, request, context):
                response = super().classify(request, context)
                seen.append(ClassificationRun.objects.get(status="running").lease_expires_at - db_now())
                return response

        self.queued(MILK)
        run = queue.claim_run()
        ClassificationRun.objects.filter(pk=run.pk).update(lease_expires_at=db_now() + timedelta(seconds=5))
        with override_settings(PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS=180):
            self.assertEqual(process_batch(run, classifier=Watching("mixed")).status, "succeeded")
        self.assertGreater(seen[0], timedelta(seconds=200))

    def test_stopped_worker_returns_the_run_to_the_queue(self):
        before = snapshot(*CATALOG_MODELS)
        entered = threading.Event()
        self.queued(MILK, TOAST)
        run = process_batch(
            queue.claim_run(), classifier=FakeClassifier("pause", entered=entered), is_stopped=entered.is_set)
        self.assertEqual((run.status, run.cursor, run.recoveries, run.error_code), ("queued", 0, 0, ""))
        self.assertEqual((run.run_token, run.lease_expires_at), (None, None))
        self.assertEqual(attempts(run), [(1, 1, "failed", "cancelled")])  # not repeated
        self.assertEqual(self.wait.call_count, 0)
        self.assertNothingSuggested(before)
        # The next worker executes the same batch.
        again = process_batch(queue.claim_run(), classifier=FakeClassifier("mixed"))
        self.assertEqual((again.pk, again.status, again.applied_count), (run.pk, "succeeded", 2))

    def test_run_closed_by_somebody_else_stops_the_call_and_is_left_alone(self):
        before = snapshot(*CATALOG_MODELS)
        self.queued(MILK)
        run = queue.claim_run()
        queue.fail_run(run, "worker_lost")  # e.g. ``suggest`` closed a run whose lease expired
        after = process_batch(run, classifier=FakeClassifier("mixed"))
        self.assertEqual((after.status, after.error_code), ("failed", "worker_lost"))
        self.assertNothingSuggested(before)

    def test_unexpected_error_and_ctrl_c_leave_the_run_to_the_caller(self):
        for error, code in ((RuntimeError("PRIVATE"), "internal_error"), (KeyboardInterrupt(), "worker_lost")):
            with self.subTest(error=type(error).__name__):
                self.queued(MILK)
                run = queue.claim_run()
                with patch.object(FakeClassifier, "classify", side_effect=error), self.assertRaises(type(error)):
                    process_batch(run, classifier=FakeClassifier("mixed"))
                run.refresh_from_db()
                self.assertEqual(run.status, "running")
                self.assertEqual(attempts(run), [(1, 1, "failed", code)])
                self.assertEqual(ClassificationAttempt.objects.filter(status="running").count(), 0)
                queue.fail_run(run, code)
