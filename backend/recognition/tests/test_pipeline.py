import hashlib
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from tempfile import TemporaryDirectory
from threading import Event
from unittest.mock import patch

from django.db import connection, connections
from django.test import TransactionTestCase, override_settings, tag

from catalog.models import Product
from receipts.models import Receipt, ReceiptLine
from recognition import queue, storage
from recognition.demo import seed_demo
from recognition.importer import import_receipt
from recognition.models import ProcessingJob, ReceiptImage
from recognition.pipeline import JobPipeline, process_job
from recognition.providers.base import ProviderError
from recognition.providers.fake import FakeProvider
from stores.models import Country, Currency


def threaded_process(job, provider):
    try:
        return process_job(job, provider=provider)
    finally:
        connections.close_all()


class PipelineEnvironment(TransactionTestCase):
    def setUp(self):
        self.media = TemporaryDirectory(prefix="checkist-c4-test-")
        self.addCleanup(self.media.cleanup)
        override = override_settings(MEDIA_ROOT=self.media.name, RECEIPT_OCR_PROVIDER="fake")
        override.enable()
        self.addCleanup(override.disable)
        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        self.single, self.double = seed_demo()

    def new_job(self, path=None):
        with (path or self.double).open("rb") as stream:
            self.photo, _ = storage.accept_upload(stream)
        job, _ = queue.create_job(self.photo)
        return job

    def process(self, scenario="success2", provider=None):
        self.new_job()
        self.job = queue.claim_job()
        return process_job(self.job, provider=provider or FakeProvider(scenario))

    def expire(self, job):
        ProcessingJob.objects.filter(pk=job.pk).update(lease_expires_at=queue.db_now() - timedelta(seconds=1))


@tag("integration")
class PipelineTests(PipelineEnvironment):
    def test_two_receipts_lines_files_and_attempts(self):
        result = self.process()
        self.assertEqual((result.status, result.detected_count, result.completed_count, result.imported_count), ("succeeded", 2, 2, 2))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (2, 6, 5))
        self.assertEqual([str(r.total) for r in Receipt.objects.order_by("total")], ["4.42", "6.00"])
        self.assertEqual(list(result.attempts.order_by("pk").values_list("phase", "status")), [("detect", "succeeded"), ("recognize", "succeeded"), ("recognize", "succeeded")])
        for image in result.images.all():
            self.assertTrue(storage.media_path(image.file.name).is_file())
            self.assertEqual(image.sha256, hashlib.sha256(storage.media_path(image.file.name).read_bytes()).hexdigest())
            self.assertIsNotNone(image.normalized_result)
            self.assertEqual(image.issues, [])

    def test_repeat_same_photo_reuses_receipts_products_and_lines(self):
        first = self.process()
        ids = list(first.images.order_by("position").values_list("receipt_id", flat=True))
        photo_id = first.photo_id
        second = self.process()
        self.assertEqual(second.photo_id, photo_id)
        self.assertEqual((second.imported_count, second.reused_count), (0, 2))
        self.assertEqual(list(second.images.order_by("position").values_list("receipt_id", flat=True)), ids)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (2, 6, 5))

    def test_partial_retains_incomplete_normalized_result(self):
        result = self.process("partial_success")
        self.assertEqual((result.status, result.imported_count, result.review_count), ("partial_succeeded", 1, 1))
        second = result.images.get(position=2)
        self.assertEqual(second.status, "needs_review")
        self.assertIsNone(second.normalized_result["lines"][0]["quantity"])
        self.assertTrue(second.issues)
        self.assertEqual(Receipt.objects.count(), 1)

    def test_all_semantically_invalid_results_are_retained_for_review(self):
        result = self.process("inconsistent_total")
        self.assertEqual((result.status, result.review_count), ("partial_succeeded", 2))
        self.assertEqual(Receipt.objects.count(), 0)
        self.assertTrue(all(image.normalized_result and image.issues for image in result.images.all()))

    def test_one_crop_provider_failure_does_not_stop_next_crop(self):
        class FirstFails(FakeProvider):
            def recognize(self, crop, run):
                if crop.position == 1:
                    raise ProviderError("auth_required")
                return super().recognize(crop, run)
        result = self.process(provider=FirstFails())
        self.assertEqual((result.status, result.imported_count, result.failed_count), ("partial_succeeded", 1, 1))
        self.assertEqual(result.images.get(position=1).issues[0]["code"], "auth_required")
        self.assertEqual(Receipt.objects.get().total, 6)

    def test_no_receipts(self):
        result = self.process("no_receipts")
        self.assertEqual((result.status, result.error_code, result.detected_count), ("failed", "no_receipts", 0))
        self.assertEqual((Receipt.objects.count(), ReceiptImage.objects.count()), (0, 0))

    def test_too_many_receipts_is_not_truncated_or_retried(self):
        result = self.process("too_many_receipts")
        self.assertEqual((result.status, result.error_code), ("failed", "too_many_receipts"))
        self.assertEqual(result.attempts.count(), 1)
        self.assertEqual(result.images.count(), 0)

    def test_provider_auth_failure_has_no_retry(self):
        result = self.process("provider_auth_failure")
        self.assertEqual((result.status, result.error_code), ("failed", "auth_required"))
        self.assertEqual(result.attempts.count(), 1)

    def test_retryable_failure_has_exactly_one_extra_attempt(self):
        with patch.object(JobPipeline, "_retry_delay", return_value=0):
            result = self.process("provider_error")
        self.assertEqual((result.status, result.error_code), ("failed", "provider_unavailable"))
        self.assertEqual(list(result.attempts.values_list("ordinal", flat=True)), [1, 2])

    def test_transient_detect_and_recognize_can_succeed_on_retry(self):
        class Transient(FakeProvider):
            def __init__(self):
                super().__init__()
                self.called = set()

            def detect(self, image, run):
                self.assert_autocommit()
                if "detect" not in self.called:
                    self.called.add("detect")
                    raise ProviderError("network_unavailable")
                return super().detect(image, run)

            def recognize(self, crop, run):
                self.assert_autocommit()
                if crop.position not in self.called:
                    self.called.add(crop.position)
                    raise ProviderError("rate_limited", retry_after=2)
                return super().recognize(crop, run)

            @staticmethod
            def assert_autocommit():
                if connection.in_atomic_block:
                    raise AssertionError("Provider called inside a DB transaction")
        with patch.object(JobPipeline, "_retry_delay", return_value=0):
            result = self.process(provider=Transient())
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.attempts.count(), 6)

    def test_schema_failure_is_not_retried(self):
        result = self.process("malformed_schema")
        self.assertEqual((result.status, result.error_code), ("failed", "invalid_output"))
        self.assertEqual(result.attempts.count(), 1)

    def test_overlap_keeps_private_detect_for_review_and_imports_nothing(self):
        class Overlap(FakeProvider):
            def detect(self, image, run):
                result = super().detect(image, run)
                return replace(result, receipts=(result.receipts[0], replace(result.receipts[0], id=2)))
        result = self.process(provider=Overlap())
        self.assertEqual((result.status, result.error_code), ("failed", "geometry_requires_review"))
        self.assertIsNotNone(result.attempts.get().raw_payload)
        self.assertEqual(Receipt.objects.count(), 0)

    def test_clipped_crop_is_preserved_but_not_imported(self):
        class Clipped(FakeProvider):
            def detect(self, image, run):
                result = super().detect(image, run)
                return replace(result, receipts=(replace(result.receipts[0], clipped=True), result.receipts[1]))
        result = self.process(provider=Clipped())
        self.assertEqual((result.status, result.imported_count, result.review_count), ("partial_succeeded", 1, 1))
        self.assertEqual(result.images.get(position=1).status, "needs_review")

    def test_cancel_queued_is_never_claimed(self):
        job = self.new_job()
        cancelled = queue.request_cancel(job.pk)
        self.assertEqual(cancelled.status, "cancelled")
        self.assertIsNone(queue.claim_job())
        self.assertTrue(storage.media_path(self.photo.original_file.name).is_file())

    def test_cancel_during_detect(self):
        entered = Event()
        self.new_job()
        job = queue.claim_job()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(threaded_process, job, FakeProvider("pause_detect", entered=entered))
            self.assertTrue(entered.wait(5))
            queue.request_cancel(job.pk)
            result = future.result(5)
        self.assertEqual(result.status, "cancelled")
        self.assertEqual(result.attempts.get().status, "cancelled")
        self.assertEqual(Receipt.objects.count(), 0)

    def test_cancel_second_recognize_preserves_immediately_visible_first(self):
        entered = Event()
        class PauseSecond(FakeProvider):
            def recognize(self, crop, run):
                if crop.position == 2:
                    return FakeProvider("pause_recognize", entered=entered).recognize(crop, run)
                return super().recognize(crop, run)
        self.new_job()
        job = queue.claim_job()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(threaded_process, job, PauseSecond())
            self.assertTrue(entered.wait(5))
            self.assertEqual(Receipt.objects.count(), 1)
            before = ProcessingJob.objects.get(pk=job.pk)
            self.assertEqual((before.stage, before.current_position, before.imported_count), ("recognize", 2, 1))
            queue.request_cancel(job.pk)
            result = future.result(5)
        self.assertEqual((result.status, result.imported_count, result.cancelled_count), ("cancelled", 1, 1))
        self.assertEqual(Receipt.objects.count(), 1)

    def test_cancel_immediately_before_import_is_fenced(self):
        def cancelled_import(image, observation, **kwargs):
            queue.request_cancel(image.job_id)
            return import_receipt(image, observation, **kwargs)
        with patch("recognition.pipeline.import_receipt", side_effect=cancelled_import):
            result = self.process()
        self.assertEqual(result.status, "cancelled")
        self.assertEqual((Receipt.objects.count(), Product.objects.count()), (0, 0))

    def test_cancel_after_last_import_sees_terminal_job(self):
        def cancel_after_import(image, observation, **kwargs):
            result = import_receipt(image, observation, **kwargs)
            if image.position == 2:
                with self.assertRaisesMessage(queue.QueueError, "job_terminal"):
                    queue.request_cancel(image.job_id)
            return result
        with patch("recognition.pipeline.import_receipt", side_effect=cancel_after_import):
            result = self.process()
        self.assertEqual((result.status, Receipt.objects.count()), ("succeeded", 2))

    def test_crop_storage_failure_does_not_stop_other_crop(self):
        original = storage.media_path
        def missing(name):
            if name.startswith("crops/") and "/1-" in name:
                raise storage.StorageError()
            return original(name)
        with patch("recognition.pipeline.storage.media_path", side_effect=missing):
            result = self.process()
        self.assertEqual((result.status, result.imported_count, result.failed_count), ("partial_succeeded", 1, 1))

    def test_provider_ignoring_cancel_cannot_publish_late_result(self):
        class Late(FakeProvider):
            def detect(inner, image, run):
                result = super().detect(image, run)
                queue.request_cancel(self.job.pk)
                return result
        result = self.process(provider=Late())
        self.assertEqual(result.status, "cancelled")
        self.assertEqual(result.images.count(), 0)
        self.assertEqual(Receipt.objects.count(), 0)

    def test_expired_lease_recovers_without_redetect_or_reimport(self):
        class Interrupted(FakeProvider):
            def recognize(self, crop, run):
                if crop.position == 2:
                    raise KeyboardInterrupt
                return super().recognize(crop, run)
        self.new_job()
        job = queue.claim_job()
        with self.assertRaises(KeyboardInterrupt):
            process_job(job, provider=Interrupted())
        first_id = Receipt.objects.get().pk
        self.expire(job)
        queue.recover_expired_jobs()
        resumed = queue.claim_job()
        with patch.object(JobPipeline, "_retry_delay", return_value=0):
            result = process_job(resumed, provider=FakeProvider())
        self.assertEqual((result.status, result.claim_count), ("succeeded", 2))
        self.assertEqual(result.attempts.filter(phase="detect").count(), 1)
        self.assertEqual(result.images.get(position=1).receipt_id, first_id)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (2, 6, 5))

    def test_crash_after_recognition_reuses_saved_observation(self):
        self.new_job()
        job = queue.claim_job()
        with patch("recognition.pipeline.import_receipt", side_effect=KeyboardInterrupt), self.assertRaises(KeyboardInterrupt):
            process_job(job, provider=FakeProvider())
        self.expire(job)
        queue.recover_expired_jobs()
        resumed = queue.claim_job()
        result = process_job(resumed, provider=FakeProvider())
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(result.attempts.count(), 3)

    @override_settings(RECEIPT_OCR_JOB_TIMEOUT_SECONDS=1)
    def test_overall_budget_keeps_success_and_fails_remaining_crop(self):
        class TimeoutSecond(FakeProvider):
            def recognize(self, crop, run):
                if crop.position == 2:
                    while True:
                        run.check()
                        time.sleep(0.02)
                return super().recognize(crop, run)
        result = self.process(provider=TimeoutSecond())
        self.assertEqual((result.status, result.error_code, result.imported_count, result.failed_count), ("partial_succeeded", "timeout", 1, 1))

    def test_lease_loss_rejects_late_output(self):
        class Lost(FakeProvider):
            def detect(inner, image, run):
                result = super().detect(image, run)
                self.expire(self.job)
                queue.recover_expired_jobs()
                return result
        with self.assertRaises(queue.FenceLost):
            self.process(provider=Lost())
        self.assertEqual(Receipt.objects.count(), 0)
        self.assertEqual(ProcessingJob.objects.get(pk=self.job.pk).status, "queued")
