import hashlib
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch

from django.db import connection, connections
from django.test import SimpleTestCase, TransactionTestCase, override_settings, tag
from django.utils import timezone
from PIL import Image

from catalog.models import Product
from receipts.models import Receipt, ReceiptLine
from recognition import queue, storage
from recognition.demo import seed_demo
from recognition.dto import PreparedImage
from recognition.images import ImageError
from recognition.importer import import_receipt
from recognition.models import ProcessingJob, ReceiptImage
from recognition.pipeline import JobPipeline, process_job
from recognition.providers.base import ProviderError
from recognition.providers.fake import FakeProvider, detection_payload
from recognition.schema_validation import validate_detection
from recognition.statuses import AttemptPhase
from stores.models import Country, Currency


def six_receipt_detection(image):
    """Detect geometry from the 2880x2160 six-paper response of 05.10.2026."""
    papers = (
        ((60, 328, 541, 1808), ((75, 382), (467, 328), (541, 1778), (60, 1808)), -4),
        ((544, 382, 996, 1730), ((567, 387), (982, 384), (994, 1713), (553, 1730)), -1),
        ((976, 333, 1443, 1791), ((1034, 333), (1431, 350), (1440, 1786), (1014, 1791)), 1),
        ((1434, 372, 1878, 1756), ((1457, 374), (1863, 402), (1875, 1754), (1437, 1750)), 1),
        ((1878, 410, 2313, 1426), ((1878, 410), (2278, 423), (2313, 1419), (1886, 1426)), 0),
        ((2321, 423, 2773, 1791), ((2341, 426), (2724, 428), (2742, 1788), (2324, 1769)), 2),
    )
    data = detection_payload(image, 0)
    data["receipt_count"] = len(papers)
    for position, (box, quad, rotation) in enumerate(papers, 1):
        x1, y1, x2, y2 = box
        data["receipts"].append({
            "id": position,
            "bbox": dict(x_min=x1 / 2880, y_min=y1 / 2160, x_max=x2 / 2880, y_max=y2 / 2160),
            "quad": [dict(x=x / 2880, y=y / 2160) for x, y in quad],
            "rotation_degrees": rotation, "confidence": 0.96, "clipped": False,
        })
    return validate_detection(data, width=image.width, height=image.height)


class PipelineDetectionTests(SimpleTestCase):
    def setUp(self):
        now = timezone.now()
        job = SimpleNamespace(run_token="detect-geometry", processing_deadline_at=now + timedelta(minutes=1))
        with patch("recognition.pipeline.queue.db_now", return_value=now):
            self.pipeline = JobPipeline(job, None)
        self.image = PreparedImage(Path("synthetic.png"), "a" * 64, 2880, 2160)

    def validate_boxes(self, boxes):
        data = detection_payload(self.image, 0)
        data["receipt_count"] = len(boxes)
        for position, (x1, y1, x2, y2) in enumerate(boxes, 1):
            data["receipts"].append({
                "id": position, "bbox": dict(x_min=x1, y_min=y1, x_max=x2, y_max=y2),
                "quad": [dict(x=x1, y=y1), dict(x=x2, y=y1), dict(x=x2, y=y2), dict(x=x1, y=y2)],
                "rotation_degrees": 0, "confidence": 1, "clipped": False,
            })
        detection = validate_detection(data, width=self.image.width, height=self.image.height)
        return self.pipeline._validate(AttemptPhase.DETECT, detection, self.image)

    def test_real_six_receipt_geometry_passes_without_changing_quads_or_rotations(self):
        detection = six_receipt_detection(self.image)
        validated = self.pipeline._validate(AttemptPhase.DETECT, detection, self.image)
        self.assertEqual(validated.receipt_count, 6)
        self.assertEqual(len(validated.receipts), 6)
        self.assertEqual(validated, detection)

    def test_disjoint_and_touching_boxes_pass(self):
        first = (.1, .1, .4, .4)
        for second in ((.5, .1, .8, .4), (.4, .1, .7, .4), (.1, .4, .4, .7),
                       (.4, .4, .7, .7), (.1, .5, .4, .8)):
            with self.subTest(second=second):
                self.assertEqual(self.validate_boxes((first, second)).receipt_count, 2)

    def test_nine_and_twenty_pixel_overlap_pass_in_either_order(self):
        for overlap in (9, 20):
            first = (100 / 2880, 100 / 2160, 550 / 2880, 1500 / 2160)
            second = ((550 - overlap) / 2880, 100 / 2160, (1000 - overlap) / 2880, 1500 / 2160)
            for boxes in ((first, second), (second, first)):
                with self.subTest(overlap=overlap, boxes=boxes):
                    self.assertEqual(self.validate_boxes(boxes).receipt_count, 2)

    def test_ten_percent_boundary_is_inclusive(self):
        # Binary-exact coordinates give an exact 10% area overlap at .34375.
        first = (.0625, .125, .375, .875)
        for start, allowed in ((.34375 + 1e-6, True), (.34375, True), (.34375 - 1e-6, False)):
            second = (start, .125, start + .3125, .875)
            for boxes in ((first, second), (second, first)):
                with self.subTest(start=start, boxes=boxes):
                    if allowed:
                        self.assertEqual(self.validate_boxes(boxes).receipt_count, 2)
                    else:
                        with self.assertRaises(ImageError) as error:
                            self.validate_boxes(boxes)
                        self.assertEqual(error.exception.code, "geometry_requires_review")

    def test_overlap_uses_area_in_both_axes(self):
        boxes = ((.1, .1, .5, .5), (.3, .48, .7, .88))
        self.assertEqual(self.validate_boxes(boxes).receipt_count, 2)

    def test_duplicate_nearly_duplicate_nested_and_substantial_overlap_are_rejected(self):
        cases = (
            ((.1, .1, .5, .9), (.1, .1, .5, .9)),
            ((.1, .1, .5, .9), (.11, .11, .51, .91)),
            ((0, 0, 1, 1), (.1, .1, .2, .2)),
            ((0, 0, 1, 1), (0, 0, .1, .1)),
            # Only 0.6% of the larger box, but 30% of the smaller one.
            ((.1, .1, .2, .2), (.17, .05, .8, .8)),
        )
        for first, second in cases:
            for boxes in ((first, second), (second, first)):
                with self.subTest(boxes=boxes):
                    with self.assertRaises(ImageError) as error:
                        self.validate_boxes(boxes)
                    self.assertEqual(error.exception.code, "geometry_requires_review")


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

    def test_duplicate_boxes_keep_private_detect_for_review_and_create_no_crops(self):
        class Overlap(FakeProvider):
            def detect(self, image, run):
                result = super().detect(image, run)
                return replace(result, receipts=(result.receipts[0], replace(result.receipts[0], id=2)))
        result = self.process(provider=Overlap())
        self.assertEqual((result.status, result.error_code), ("failed", "geometry_requires_review"))
        self.assertIsNotNone(result.attempts.get().raw_payload)
        self.assertEqual(result.images.count(), 0)
        self.assertEqual(Receipt.objects.count(), 0)

    def test_small_overlap_creates_and_recognizes_all_six_crops(self):
        class SixPapers(FakeProvider):
            def detect(self, image, run):
                run.check()
                return six_receipt_detection(image)

        path = Path(self.media.name) / "six-source.png"
        with Image.new("RGB", (2880, 2160), "white") as image:
            image.save(path)
        self.new_job(path)
        self.job = queue.claim_job()
        result = process_job(self.job, provider=SixPapers())
        self.assertEqual((result.status, result.detected_count, result.completed_count), ("succeeded", 6, 6))
        self.assertEqual(result.images.count(), 6)
        self.assertEqual(result.attempts.filter(phase="recognize", status="succeeded").count(), 6)
        expected = six_receipt_detection(PreparedImage(path, "a" * 64, 2880, 2160))
        for image, receipt in zip(result.images.order_by("position"), expected.receipts, strict=True):
            self.assertEqual(image.bbox, receipt.bbox.to_dict())
            self.assertEqual(image.quad, [point.to_dict() for point in receipt.quad])
            self.assertEqual(image.rotation_degrees, receipt.rotation_degrees)
            self.assertTrue(storage.media_path(image.file.name).is_file())
            self.assertIsNotNone(image.normalized_result)

    def test_clipped_readable_crop_imports_with_nonblocking_notice(self):
        class Clipped(FakeProvider):
            def detect(self, image, run):
                result = super().detect(image, run)
                return replace(result, receipts=(replace(result.receipts[0], clipped=True), result.receipts[1]))
        result = self.process(provider=Clipped())
        self.assertEqual((result.status, result.imported_count, result.review_count), ("succeeded", 2, 0))
        image = result.images.get(position=1)
        self.assertEqual(image.status, "imported")
        self.assertEqual(image.issues[0]["code"], "clipped")
        self.assertEqual(image.receipt.lines.count(), 4)

    def test_clipped_crop_with_unreadable_core_still_requires_review(self):
        class Clipped(FakeProvider):
            def detect(self, image, run):
                result = super().detect(image, run)
                return replace(result, receipts=(replace(result.receipts[0], clipped=True), result.receipts[1]))

            def recognize(self, image, run):
                result = super().recognize(image, run)
                return replace(result, total=None, fields=tuple(
                    replace(f, status="unreadable") if f.path == "/total" else f for f in result.fields
                )) if image.position == 1 else result

        result = self.process(provider=Clipped())
        self.assertEqual((result.status, result.imported_count, result.review_count), ("partial_succeeded", 1, 1))
        image = result.images.get(position=1)
        self.assertEqual(image.status, "needs_review")
        self.assertIsNone(image.receipt_id)

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
