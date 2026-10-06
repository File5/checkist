"""The host worker's second kind of work: one batch of a product classification run.

A recognition job always comes first. Fake provider and fake classifier only.
"""
import io
import os
from datetime import timedelta
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import OperationalError, connection
from django.test import SimpleTestCase, override_settings, tag

from catalog.models import Product
from classification import demo, runner, services
from classification import queue as classification_queue
from classification.classifier import FAKE_SCENARIO_ENV, FAKE_SCENARIOS, FakeClassifier
from classification.codex import CodexClassifier
from classification.models import ClassificationRun, CreatedCategory, CreatedGenericProduct, ProductClassification
from classification.tests.factories import CATALOG_MODELS, MILK, TOAST, generic_of, product, snapshot
from receipts.models import Receipt, ReceiptLine
from recognition import queue
from recognition.management.commands import recognition_worker
from recognition.management.commands.recognition_worker import Command, SlotWatch, build_classifier, worker_slot
from recognition.models import ProcessingJob
from recognition.providers.base import ProviderError

from .test_pipeline import PipelineEnvironment

WORKER = "recognition.management.commands.recognition_worker"


@tag("integration")
@override_settings(
    PRODUCT_CLASSIFICATION_AUTO_SUGGEST=False, PRODUCT_MERGE_AUTO_DETECT=False, RECEIPT_OCR_MAX_ATTEMPTS=2,
    PRODUCT_CLASSIFICATION_BATCH_SIZE=25,
)
class WorkerClassificationEnvironment(PipelineEnvironment):
    def setUp(self):
        super().setUp()
        self.scratch = TemporaryDirectory(prefix="checkist-c2-scratch-")
        self.addCleanup(self.scratch.cleanup)
        override = override_settings(RECEIPT_OCR_TEMP_ROOT=self.scratch.name)
        override.enable()
        self.addCleanup(override.disable)
        pause = patch.object(runner, "_wait")  # the 2–3 s pause between attempts
        pause.start()
        self.addCleanup(pause.stop)

    def worker(self, **options):
        """One ``--once`` pass; what the command printed after the ready line."""
        output = io.StringIO()
        options.setdefault("fake_scenario", "success2")
        call_command("recognition_worker", once=True, stdout=output, **options)
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[0], "Recognition worker ready.")
        return lines[1:]

    def queued(self, *names):
        run, created = services.request_run(
            trigger="manual", product_ids=[product(name).pk for name in names] if names else None)
        self.assertTrue(created)
        return run

    def state(self, run):
        run.refresh_from_db()
        return run.status, run.cursor, run.error_code

    def job_state(self, job):
        return ProcessingJob.objects.filter(pk=job.pk).values().get()


class AlternationTests(WorkerClassificationEnvironment):
    def test_recognition_job_comes_before_a_run_and_once_is_one_unit(self):
        demo.seed_demo()
        run = self.queued()
        job = self.new_job()
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [f"Job {job.pk}: succeeded"])
        self.assertEqual(self.state(run), ("queued", 0, ""))
        self.assertEqual(run.attempts.count(), 0)
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [f"Classification run {run.pk}: succeeded"])
        self.assertEqual(self.state(run), ("succeeded", 10, ""))
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [])  # nothing left

    @override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=4)
    def test_once_is_one_batch_and_a_new_job_goes_between_batches(self):
        demo.seed_demo()
        run = self.queued()
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [f"Classification run {run.pk}: queued"])
        self.assertEqual(self.state(run), ("queued", 4, ""))
        job = self.new_job()  # arrives while the run waits between batches
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [f"Job {job.pk}: succeeded"])
        self.assertEqual(self.state(run), ("queued", 4, ""))
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [f"Classification run {run.pk}: queued"])
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [f"Classification run {run.pk}: succeeded"])
        run.refresh_from_db()
        self.assertEqual((run.cursor, run.applied_count, run.unknown_count), (10, 9, 1))
        self.assertEqual(ProductClassification.objects.filter(status="pending").count(), demo.EXPECTED["pending"])
        self.assertEqual(
            (CreatedGenericProduct.objects.count(), CreatedCategory.objects.count()),
            (demo.EXPECTED["created_generics"], demo.EXPECTED["created_categories"]),
        )

    def test_empty_queues_exit_without_writes(self):
        self.assertEqual(self.worker(), [])
        self.assertEqual((ProcessingJob.objects.count(), ClassificationRun.objects.count()), (0, 0))

    def test_every_fake_scenario_through_the_worker(self):
        demo.seed_demo()
        clean = snapshot(*CATALOG_MODELS)
        expected = {
            "mixed": ("succeeded", "", 9, 1, 0), "existing": ("succeeded", "", 10, 0, 0),
            "new_category": ("succeeded", "", 10, 0, 0), "unknown": ("succeeded", "", 0, 10, 0),
            "service_target": ("succeeded", "", 0, 0, 10), "provider_error": ("failed", "provider_unavailable", 0, 0, 0),
            "auth_failure": ("failed", "auth_required", 0, 0, 0), "invalid_output": ("failed", "invalid_output", 0, 0, 0),
            "foreign_product": ("failed", "invalid_output", 0, 0, 0),
            "missing_product": ("failed", "invalid_output", 0, 0, 0),
        }
        for scenario, outcome in expected.items():
            with self.subTest(scenario=scenario):
                run = self.queued()
                self.assertEqual(
                    self.worker(classification_fake_scenario=scenario), [f"Classification run {run.pk}: {outcome[0]}"])
                run.refresh_from_db()
                self.assertEqual(
                    (run.status, run.error_code, run.applied_count, run.unknown_count, run.skipped_count), outcome)
                self.assertEqual(run.attempts.count(), 2 if scenario == "provider_error" else 1)
                self.assertEqual(ProductClassification.objects.filter(run=run).count(), outcome[2])
                if not outcome[2]:
                    self.assertEqual(snapshot(*CATALOG_MODELS), clean)
                services.cancel_pending()  # back to the clean catalog for the next scenario
                self.assertEqual(snapshot(*CATALOG_MODELS), clean)

    def test_environment_selects_the_scenario_and_the_option_overrides_it(self):
        demo.seed_demo()
        with patch.dict(os.environ, {FAKE_SCENARIO_ENV: "unknown"}):
            run = self.queued(MILK)
            self.worker()
            self.assertEqual((run.applied_count, self.state(run)[0], run.unknown_count), (0, "succeeded", 1))
            run = self.queued(MILK)
            self.worker(classification_fake_scenario="mixed")
            run.refresh_from_db()
            self.assertEqual((run.applied_count, generic_of(MILK)), (1, "Молоко"))

    def test_model_is_asked_outside_any_transaction(self):
        demo.seed_demo()
        seen = []

        class Watching(FakeClassifier):
            def classify(self, request, context):
                seen.append((connection.in_atomic_block, ClassificationRun.objects.get(status="running").pk))
                return super().classify(request, context)

        run = self.queued(MILK)
        with patch(f"{WORKER}.get_classifier", return_value=Watching("mixed")):
            self.worker()
        self.assertEqual(seen, [(False, run.pk)])  # and the run is visible as running: the claim is committed


class StopAndFailureTests(WorkerClassificationEnvironment):
    def test_ctrl_c_during_a_batch_requeues_the_run(self):
        demo.seed_demo()
        before = snapshot(*CATALOG_MODELS)
        run = self.queued(MILK, TOAST)
        with patch.object(FakeClassifier, "classify", side_effect=KeyboardInterrupt):
            self.assertEqual(self.worker(), ["Recognition worker stopped; active work released."])
        run.refresh_from_db()
        self.assertEqual((run.status, run.cursor, run.recoveries, run.run_token), ("queued", 0, 0, None))
        self.assertEqual(list(run.attempts.values_list("status", "error_code")), [("failed", "worker_lost")])
        self.assertEqual(snapshot(*CATALOG_MODELS), before)
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [f"Classification run {run.pk}: succeeded"])
        run.refresh_from_db()
        self.assertEqual((run.applied_count, run.recoveries), (2, 0))

    def test_unexpected_error_fails_the_run_and_the_worker_goes_on(self):
        demo.seed_demo()
        before = snapshot(*CATALOG_MODELS)
        run = self.queued(MILK)
        jobs = []

        class Broken(FakeClassifier):
            def classify(inner, request, context):
                jobs.append(self.new_job())  # a recognition job arrives during the batch
                raise RuntimeError("PRIVATE DETAIL")

        claims = []
        original = classification_queue.claim_run

        def claim():
            claims.append(1)
            if len(claims) > 1:
                raise KeyboardInterrupt  # ends the loop once the job has been processed
            return original()

        output = io.StringIO()
        with patch(f"{WORKER}.get_classifier", return_value=Broken("mixed")), \
                patch.object(classification_queue, "claim_run", claim), \
                self.assertLogs(WORKER, level="ERROR") as logs:
            call_command("recognition_worker", fake_scenario="success2", stdout=output)
        self.assertEqual(logs.output, [f"ERROR:{WORKER}:Product classification batch failed: RuntimeError"])
        self.assertEqual(output.getvalue().splitlines(), [
            "Recognition worker ready.", f"Classification run {run.pk}: failed", f"Job {jobs[0].pk}: succeeded",
            "Recognition worker stopped; active work released.",
        ])
        self.assertEqual(self.state(run), ("failed", 0, "internal_error"))
        self.assertEqual(list(run.attempts.values_list("status", "error_code")), [("failed", "internal_error")])
        self.assertEqual(snapshot(*CATALOG_MODELS)["GenericProduct"], before["GenericProduct"])
        self.assertEqual(ProductClassification.objects.count(), 0)
        self.assertEqual(Receipt.objects.count(), 3 + 2)  # the demo receipts and the two of the job

    def test_unavailable_database_stops_the_worker_and_the_lease_recovers_the_run(self):
        demo.seed_demo()
        run = self.queued(MILK)
        with patch(f"{WORKER}.process_batch", side_effect=OperationalError("PRIVATE")), \
                self.assertRaisesMessage(CommandError, "database is unavailable"):
            self.worker()
        self.assertEqual(self.state(run), ("running", 0, ""))
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [])  # the lease is alive: nothing to claim
        ClassificationRun.objects.filter(pk=run.pk).update(lease_expires_at=queue.db_now() - timedelta(seconds=1))
        self.assertEqual(self.worker(classification_fake_scenario="mixed"), [f"Classification run {run.pk}: succeeded"])
        run.refresh_from_db()
        self.assertEqual((run.recoveries, run.applied_count), (1, 1))

    def test_lost_slot_stops_the_model_call_and_the_worker(self):
        demo.seed_demo()
        before = snapshot(*CATALOG_MODELS)
        run = self.queued(MILK)
        with patch(f"{WORKER}.SlotWatch", return_value=lambda: True):
            self.assertEqual(
                self.worker(classification_fake_scenario="pause"), [f"Classification run {run.pk}: queued"])
        run.refresh_from_db()
        self.assertEqual((run.status, run.recoveries, run.run_token), ("queued", 0, None))
        self.assertEqual(list(run.attempts.values_list("status", "error_code")), [("failed", "cancelled")])
        self.assertEqual(snapshot(*CATALOG_MODELS), before)

    def test_slot_watch_reports_a_lost_session_and_stays_lost(self):
        with worker_slot() as slot:
            watch = SlotWatch(slot, interval=0)
            self.assertFalse(watch())
            slot.close()
            self.assertTrue(watch())
            self.assertTrue(watch())
        with worker_slot() as slot:
            rare = SlotWatch(slot, interval=3600)
            slot.close()
            self.assertFalse(rare())  # polled at most once per interval


@override_settings(PRODUCT_CLASSIFICATION_AUTO_SUGGEST=True)
class AutoSuggestThroughWorkerTests(WorkerClassificationEnvironment):
    def products(self):
        return sorted(set(ReceiptLine.objects.filter(kind="product", product__isnull=False).values_list(
            "product_id", flat=True)))

    def generics(self):
        return dict(Product.objects.values_list("pk", "generic__name"))

    def test_import_queues_a_run_and_the_next_pass_suggests(self):
        job = self.new_job()
        self.assertEqual(self.worker(classification_fake_scenario="new_category"), [f"Job {job.pk}: succeeded"])
        run = ClassificationRun.objects.get()
        self.assertEqual((run.status, run.trigger, run.scope, run.product_ids), ("queued", "import", "products", self.products()))
        self.assertEqual((Receipt.objects.count(), len(run.product_ids)), (2, 5))
        self.assertEqual(set(self.generics().values()), {"Не разобрано"})
        finished = self.job_state(job)
        self.assertEqual(
            self.worker(classification_fake_scenario="new_category"), [f"Classification run {run.pk}: succeeded"])
        run.refresh_from_db()
        self.assertEqual((run.applied_count, ProductClassification.objects.filter(status="pending").count()), (5, 5))
        self.assertEqual(set(self.generics().values()), {"Тестовый продукт"})
        self.assertEqual(self.job_state(job), finished)

    def test_failed_suggestion_changes_neither_the_job_nor_the_receipts(self):
        for scenario, code in (
            ("auth_failure", "auth_required"), ("provider_error", "provider_unavailable"),
            ("invalid_output", "invalid_output"),
        ):
            with self.subTest(scenario=scenario):
                job = self.new_job()
                self.worker(classification_fake_scenario=scenario)
                finished = self.job_state(job)
                self.assertIn(finished["status"], ("succeeded",))
                receipts = list(Receipt.objects.order_by("pk").values())
                lines = list(ReceiptLine.objects.order_by("pk").values())
                catalog = snapshot(*CATALOG_MODELS)
                run = ClassificationRun.objects.get(status="queued")
                self.assertEqual(
                    self.worker(classification_fake_scenario=scenario), [f"Classification run {run.pk}: failed"])
                self.assertEqual(self.state(run), ("failed", 0, code))
                self.assertEqual(self.job_state(job), finished)
                self.assertEqual(list(Receipt.objects.order_by("pk").values()), receipts)
                self.assertEqual(list(ReceiptLine.objects.order_by("pk").values()), lines)
                self.assertEqual(snapshot(*CATALOG_MODELS), catalog)
                self.assertEqual(ProductClassification.objects.count(), 0)

    def test_repeated_photo_does_not_touch_suggested_and_confirmed_products(self):
        self.new_job()
        self.worker(classification_fake_scenario="new_category")
        self.worker(classification_fake_scenario="new_category")
        confirmed = ProductClassification.objects.order_by("pk").first()
        services.confirm(confirmed.pk, version=confirmed.version, generic_id=confirmed.suggested_generic_ref)
        catalog = snapshot(*CATALOG_MODELS)
        records = list(ProductClassification.objects.order_by("pk").values())
        again = self.new_job()  # the same photo
        self.assertEqual(self.worker(classification_fake_scenario="existing"), [f"Job {again.pk}: succeeded"])
        self.assertEqual((Receipt.objects.count(), ClassificationRun.objects.count()), (2, 1))
        self.assertEqual(self.worker(classification_fake_scenario="existing"), [])
        self.assertEqual(snapshot(*CATALOG_MODELS), catalog)
        self.assertEqual(list(ProductClassification.objects.order_by("pk").values()), records)


class StartupTests(SimpleTestCase):
    def test_parser_accepts_every_classification_scenario(self):
        parser = Command().create_parser("manage.py", "recognition_worker")
        for name in FAKE_SCENARIOS:
            self.assertEqual(parser.parse_args(["--classification-fake-scenario", name]).classification_fake_scenario, name)
        self.assertIsNone(parser.parse_args([]).classification_fake_scenario)

    @override_settings(RECEIPT_OCR_PROVIDER="fake")
    def test_fake_classifier_by_option_and_environment_without_fallback(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(FAKE_SCENARIO_ENV, None)
            self.assertEqual(build_classifier().scenario, "mixed")
            self.assertEqual(build_classifier(fake_scenario="unknown").scenario, "unknown")
            os.environ[FAKE_SCENARIO_ENV] = "no_such_scenario"
            with self.assertRaisesMessage(CommandError, "Product classification provider configuration is invalid."):
                build_classifier()

    @override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_MODEL="demo-model")
    def test_real_provider_never_gets_a_fake_scenario(self):
        with self.assertRaisesMessage(CommandError, "--classification-fake-scenario requires RECEIPT_OCR_PROVIDER=fake."):
            build_classifier(fake_scenario="mixed")
        classifier = build_classifier()
        self.assertIsInstance(classifier, CodexClassifier)
        self.assertEqual((classifier.name, classifier.model), ("codex_cli", "demo-model"))
        with patch.object(recognition_worker, "get_classifier", side_effect=ProviderError("configuration_error")), \
                self.assertRaisesMessage(CommandError, "Product classification provider configuration is invalid."):
            build_classifier()
