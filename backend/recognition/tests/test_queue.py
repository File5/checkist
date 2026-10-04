import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier, Event

from django.db import close_old_connections, connection, transaction
from django.test import TestCase, TransactionTestCase, tag

from recognition.models import ProcessingJob, RecognitionAttempt
from recognition.queue import (
    FenceLost, QueueError, claim_job, create_job, create_retry, db_now, fenced_job, finish_attempt,
    finish_job, heartbeat, recover_expired_jobs, release_job, request_cancel, save_image_result,
    start_attempt, update_progress,
)
from .test_models import make_image, make_photo, make_receipt


def fence(job):
    return job.pk, job.run_token, job.version


@tag("integration")
class QueueTests(TestCase):
    def setUp(self):
        self.photo = make_photo()
        self.job, _ = create_job(self.photo)

    def claim(self):
        return claim_job()

    def expire(self, job, **fields):
        ProcessingJob.objects.filter(pk=job.pk).update(lease_expires_at=db_now() - timedelta(seconds=1), **fields)

    def test_create_reuses_active_job(self):
        job, created = create_job(self.photo)
        self.assertFalse(created)
        self.assertEqual(job.pk, self.job.pk)

    def test_claim_lease_heartbeat_and_global_capacity(self):
        job = self.claim()
        self.assertEqual((job.status, job.claim_count, job.version), ("running", 1, 2))
        self.assertIsNotNone(job.run_token)
        self.assertGreater(job.lease_expires_at, job.heartbeat_at)
        self.assertIsNotNone(job.processing_deadline_at)
        updated = heartbeat(*fence(job))
        self.assertEqual(updated.version, job.version)
        self.assertGreaterEqual(updated.lease_expires_at, job.lease_expires_at)
        create_job(make_photo())
        self.assertIsNone(claim_job())

    def test_cancel_queued_immediate_idempotent(self):
        job = request_cancel(self.job.pk)
        self.assertEqual((job.status, job.stage), ("cancelled", "finished"))
        self.assertIsNotNone(job.finished_at)
        self.assertIsNone(job.run_token)
        self.assertEqual(request_cancel(job.pk).version, job.version)
        self.assertIsNone(claim_job())

    def test_cancel_running_fences_late_output_preserves_original(self):
        job = self.claim()
        cancelled = request_cancel(job.pk)
        self.assertEqual(cancelled.status, "cancel_requested")
        with self.assertRaises(FenceLost):
            finish_job(*fence(job), status="failed")
        with self.assertRaises(FenceLost):
            heartbeat(*fence(job))
        with self.assertRaises(FenceLost), fenced_job(*fence(cancelled)):
            self.fail("Cancellation should reject result writes")
        done = finish_job(*fence(cancelled), status="cancelled")
        self.assertEqual(done.status, "cancelled")
        self.assertTrue(type(self.photo).objects.filter(pk=self.photo.pk).exists())

    def test_finish_failure_terminal_and_retry_is_new_job(self):
        job = self.claim()
        done = finish_job(*fence(job), status="failed", error_code="auth_required")
        with self.assertRaises(QueueError):
            request_cancel(done.pk)
        retry, created = create_retry(done.pk)
        self.assertTrue(created)
        self.assertNotEqual(retry.pk, done.pk)
        self.assertEqual(retry.retry_of_id, done.pk)
        self.assertEqual(retry.claim_count, 0)
        repeat, created = create_retry(done.pk)
        self.assertFalse(created)
        self.assertEqual(repeat.pk, retry.pk)
        with self.assertRaises(QueueError):
            create_retry(retry.pk)

    def test_progress_and_partial_result(self):
        job = update_progress(*fence(self.claim()), stage="crop", detected_count=2)
        first = make_image(job)
        second = make_image(job, position=2)
        receipt = make_receipt()
        first, job = save_image_result(*fence(job), first.pk, status="imported", receipt=receipt, import_effect="created")
        second, job = save_image_result(*fence(job), second.pk, status="needs_review", normalized_result={"total": None}, issues=[{"code": "missing_total"}])
        self.assertEqual((job.completed_count, job.imported_count, job.review_count), (2, 1, 1))
        done = finish_job(*fence(job), status="partial_succeeded")
        self.assertEqual(done.completed_count, 2)
        self.assertIsNone(done.current_position)
        with self.assertRaises(FenceLost):
            save_image_result(*fence(job), second.pk, status="failed")

    def test_success_requires_complete_clean_results(self):
        job = update_progress(*fence(self.claim()), detected_count=1)
        image = make_image(job)
        with self.assertRaises(QueueError):
            finish_job(*fence(job), status="succeeded")
        image, job = save_image_result(*fence(job), image.pk, status="reused", receipt=make_receipt(), import_effect="linked")
        self.assertEqual(finish_job(*fence(job), status="succeeded").status, "succeeded")
        with self.assertRaises(QueueError):
            create_retry(job.pk)

    def test_invalid_progress_and_fences(self):
        job = self.claim()
        for kwargs in ({"detected_count": 11}, {"detected_count": True}, {"stage": "finished"}, {"current_position": 1}):
            with self.subTest(kwargs=kwargs), self.assertRaises(QueueError):
                update_progress(*fence(job), **kwargs)
        for token, version in ((uuid.uuid4(), job.version), (job.run_token, job.version - 1), ("invalid", job.version)):
            with self.subTest(token=token, version=version), self.assertRaises(FenceLost):
                heartbeat(job.pk, token, version)

    def test_expired_owner_cannot_renew_or_write(self):
        job = self.claim()
        self.expire(job)
        with self.assertRaises(FenceLost):
            heartbeat(*fence(job))
        with self.assertRaises(FenceLost):
            finish_job(*fence(job), status="failed")

    def test_recovery_retains_finished_images_and_attempt_budget(self):
        job = update_progress(*fence(self.claim()), detected_count=2)
        image = make_image(job)
        unfinished = make_image(job, position=2, status="running")
        image, job = save_image_result(*fence(job), image.pk, status="needs_review", normalized_result={"total": None})
        attempt = start_attempt(*fence(job), phase="recognize", image_id=unfinished.pk, provider="fake", schema_version="1", input_sha256=unfinished.sha256)
        deadline = job.processing_deadline_at
        self.expire(job)
        self.assertEqual(recover_expired_jobs()[0].status, "queued")
        image.refresh_from_db()
        unfinished.refresh_from_db()
        attempt.refresh_from_db()
        self.assertEqual((image.status, unfinished.status, attempt.status), ("needs_review", "pending", "failed"))
        new = self.claim()
        self.assertNotEqual(new.run_token, job.run_token)
        self.assertEqual(new.processing_deadline_at, deadline)
        with self.assertRaises(FenceLost):
            finish_attempt(*fence(job), attempt.pk, status="succeeded", raw_payload={})
        again = start_attempt(*fence(new), phase="recognize", image_id=unfinished.pk, provider="fake", schema_version="1", input_sha256=unfinished.sha256)
        self.assertEqual(again.ordinal, 2)
        self.expire(new)
        self.assertEqual(recover_expired_jobs()[0].error_code, "worker_lost")

    def test_recovery_cancel_never_requeues(self):
        job = self.claim()
        cancelled = request_cancel(job.pk)
        self.expire(cancelled)
        self.assertEqual(recover_expired_jobs()[0].status, "cancelled")
        self.assertIsNone(claim_job())

    def test_deadline_exhaustion_fences_results_and_recovery_fails(self):
        job = self.claim()
        ProcessingJob.objects.filter(pk=job.pk).update(processing_deadline_at=db_now() - timedelta(seconds=1))
        with self.assertRaises(FenceLost), fenced_job(*fence(job)):
            self.fail("Expired budget must reject writes")
        self.expire(job)
        self.assertEqual(recover_expired_jobs()[0].error_code, "timeout")

    def test_attempt_result_is_fenced_and_immutable(self):
        job = self.claim()
        attempt = start_attempt(*fence(job), phase="detect", provider="fake", schema_version="1", input_sha256=self.photo.sha256)
        with self.assertRaises(QueueError):
            start_attempt(*fence(job), phase="detect", provider="fake", schema_version="1", input_sha256=self.photo.sha256)
        result = finish_attempt(*fence(job), attempt.pk, status="failed", error_code="invalid_output", invalid_output_text="x" * 70000)
        self.assertEqual(len(result.invalid_output_text), 65536)
        with self.assertRaises(QueueError):
            finish_attempt(*fence(job), attempt.pk, status="succeeded")

    def test_budget_expiry_keeps_review_and_records_unfinished_failure(self):
        job = update_progress(*fence(self.claim()), detected_count=2)
        review = make_image(job)
        pending = make_image(job, position=2)
        _, job = save_image_result(*fence(job), review.pk, status="needs_review", normalized_result={"total": None})
        attempt = start_attempt(*fence(job), phase="recognize", image_id=pending.pk, provider="fake", schema_version="1", input_sha256=pending.sha256)
        ProcessingJob.objects.filter(pk=job.pk).update(processing_deadline_at=db_now() - timedelta(seconds=1))
        finish_attempt(*fence(job), attempt.pk, status="failed", error_code="timeout")
        _, job = save_image_result(*fence(job), pending.pk, status="failed", issues=[{"code": "timeout"}])
        job = finish_job(*fence(job), status="partial_succeeded", error_code="timeout")
        self.assertEqual((job.completed_count, job.review_count, job.failed_count), (2, 1, 1))

    def test_import_effect_and_clipped_images_cannot_bypass_validation(self):
        job = update_progress(*fence(self.claim()), detected_count=1)
        image = make_image(job, clipped=True)
        with self.assertRaises(QueueError):
            save_image_result(*fence(job), image.pk, status="imported")
        with self.assertRaises(QueueError):
            save_image_result(*fence(job), image.pk, status="imported", receipt=make_receipt(), import_effect="created")
        image.refresh_from_db()
        self.assertEqual(image.status, "pending")

    def test_recovery_failed_images_include_safe_reason(self):
        job = update_progress(*fence(self.claim()), detected_count=1)
        image = make_image(job)
        self.expire(job, claim_count=2)
        recover_expired_jobs()
        image.refresh_from_db()
        self.assertEqual(image.status, "failed")
        self.assertEqual(image.issues[0]["code"], "worker_lost")

    def test_release_respects_cancel(self):
        job = self.claim()
        self.assertEqual(release_job(*fence(job)).status, "queued")
        job = request_cancel(self.claim().pk)
        self.assertEqual(release_job(*fence(job)).status, "cancelled")


@tag("integration")
class QueueConcurrencyTests(TransactionTestCase):
    def run_connected(self, callback):
        close_old_connections()
        try:
            return callback()
        finally:
            connection.close()

    def test_two_claimers_only_one_owner(self):
        create_job(make_photo())
        create_job(make_photo())
        barrier = Barrier(2)
        def claim():
            barrier.wait(timeout=5)
            return claim_job()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.run_connected, claim) for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual(sum(job is not None for job in results), 1)
        self.assertEqual(ProcessingJob.objects.filter(status="running").count(), 1)

    def test_claim_skips_locked_candidate(self):
        first, _ = create_job(make_photo())
        second, _ = create_job(make_photo())
        with ThreadPoolExecutor(max_workers=1) as pool, transaction.atomic():
            ProcessingJob.objects.select_for_update().get(pk=first.pk)
            claimed = pool.submit(self.run_connected, claim_job).result(timeout=10)
        self.assertEqual(claimed.pk, second.pk)

    def test_concurrent_creation_returns_one_job(self):
        photo = make_photo()
        barrier = Barrier(2)
        def create():
            barrier.wait(timeout=5)
            return create_job(photo.pk)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.run_connected, create) for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual(len({job.pk for job, _ in results}), 1)
        self.assertEqual(sum(created for _, created in results), 1)

    def test_import_commit_before_cancel_preserves_result(self):
        create_job(make_photo())
        job = update_progress(*fence(claim_job()), detected_count=1)
        image = make_image(job)
        imported = Event()
        can_commit = Event()
        def import_result():
            with fenced_job(*fence(job)):
                receipt = make_receipt()
                _, updated = save_image_result(*fence(job), image.pk, status="imported", receipt=receipt, import_effect="created")
                imported.set()
                if not can_commit.wait(timeout=5):
                    raise RuntimeError("Commit gate timeout")
            return updated
        with ThreadPoolExecutor(max_workers=2) as pool:
            writer = pool.submit(self.run_connected, import_result)
            self.assertTrue(imported.wait(timeout=5))
            cancel = pool.submit(self.run_connected, lambda: request_cancel(job.pk))
            can_commit.set()
            writer.result(timeout=10)
            cancelled = cancel.result(timeout=10)
        image.refresh_from_db()
        self.assertEqual((cancelled.status, cancelled.imported_count, image.status), ("cancel_requested", 1, "imported"))
        finish_job(*fence(cancelled), status="cancelled")
        image.refresh_from_db()
        self.assertIsNotNone(image.receipt_id)

    def test_cancel_before_import_rolls_back_all_domain_writes(self):
        create_job(make_photo())
        job = claim_job()
        request_cancel(job.pk)
        from receipts.models import Receipt
        before = Receipt.objects.count()
        def late_import():
            with fenced_job(*fence(job)):
                make_receipt()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with self.assertRaises(FenceLost):
                pool.submit(self.run_connected, late_import).result(timeout=10)
        self.assertEqual(Receipt.objects.count(), before)
