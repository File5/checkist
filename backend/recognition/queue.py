"""PostgreSQL queue. Pass the returned version to the next worker write.

All result/import writes must occur inside fenced_job(), on the same connection.
The lock spans the domain import and linkage commit; never keep it during OCR.
Direct ORM/SQL writes bypass this service's fencing and lifecycle guarantees.
"""
import re
import uuid
from contextlib import contextmanager
from datetime import timedelta

from django.conf import settings
from django.db import connection, transaction
from django.db.models import Max

from .models import ProcessingJob, ReceiptImage, RecognitionAttempt, SourcePhoto
from .statuses import (
    ACTIVE_JOB_STATUSES, EXECUTING_JOB_STATUSES, TERMINAL_IMAGE_STATUSES,
    TERMINAL_JOB_STATUSES, AttemptPhase, AttemptStatus, ImageStatus, ImportEffect, JobStage, JobStatus,
)


class QueueError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class FenceLost(QueueError):
    def __init__(self):
        super().__init__("fence_lost")


def db_now():
    # clock_timestamp, not transaction_timestamp: leases must use current DB time.
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


def _error_code(value):
    if not isinstance(value, str) or (value and not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", value)):
        raise QueueError("invalid_error_code")
    return value


def create_job(photo, *, retry_of=None):
    """create_job(photo: SourcePhoto|int, *, retry_of=None) -> (job, created).

    Serializes on the photo; exact repeats reuse an active job. Completed file
    replay should be handled by the API using the photo's latest job.
    """
    photo_id = getattr(photo, "pk", photo)
    with transaction.atomic():
        SourcePhoto.objects.select_for_update().get(pk=photo_id)
        retry_id = getattr(retry_of, "pk", retry_of)
        if retry_id is not None:
            previous = ProcessingJob.objects.get(pk=retry_id)
            if previous.photo_id != photo_id or previous.status not in {JobStatus.FAILED, JobStatus.PARTIAL_SUCCEEDED, JobStatus.CANCELLED}:
                raise QueueError("job_not_retryable")
        active = ProcessingJob.objects.filter(photo_id=photo_id, status__in=ACTIVE_JOB_STATUSES).first()
        if active:
            return active, False
        return ProcessingJob.objects.create(photo_id=photo_id, retry_of_id=retry_id, available_at=db_now()), True


def create_retry(job_id):
    """create_retry(job_id: int) -> (new_job, created); terminal failed/partial/cancelled only."""
    previous = ProcessingJob.objects.get(pk=job_id)
    if previous.status not in {JobStatus.FAILED, JobStatus.PARTIAL_SUCCEEDED, JobStatus.CANCELLED}:
        raise QueueError("job_not_retryable")
    return create_job(previous.photo_id, retry_of=previous)


def claim_job(*, lease_seconds=None):
    """claim_job(*, lease_seconds=None) -> ProcessingJob|None. One executing job in v1.

    A short transaction advisory lock serializes global capacity checks without
    a WorkerSlot table. Worker startup/process supervision belongs to the host command.
    """
    lease_seconds = _lease_seconds(lease_seconds)
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_xact_lock(1128811347, 1)")
            if not cursor.fetchone()[0]:
                return None
        now = db_now()
        if ProcessingJob.objects.filter(status__in=EXECUTING_JOB_STATUSES).exists():
            return None  # recovery must fence expired work before another claim.
        job = ProcessingJob.objects.select_for_update(skip_locked=True).filter(
            status=JobStatus.QUEUED, available_at__lte=now,
        ).order_by("available_at", "id").first()
        if job is None:
            return None
        if job.processing_deadline_at and job.processing_deadline_at <= now:
            _terminalize(job, JobStatus.FAILED, "timeout", now)
            return None
        job.status = JobStatus.RUNNING
        job.stage = JobStage.PREPARE
        job.version += 1
        job.run_token = uuid.uuid4()
        job.claim_count += 1
        job.started_at = job.started_at or now
        job.processing_deadline_at = job.processing_deadline_at or now + timedelta(seconds=settings.RECEIPT_OCR_JOB_TIMEOUT_SECONDS)
        job.heartbeat_at = now
        job.lease_expires_at = now + timedelta(seconds=lease_seconds)
        job.save()
        return job


def _lease_seconds(value):
    value = settings.RECEIPT_OCR_LEASE_SECONDS if value is None else value
    if type(value) is not int or not 1 <= value <= 300:
        raise QueueError("invalid_lease")
    return value


@contextmanager
def fenced_job(job_id, run_token, version, *, allow_cancel=False, allow_timeout=False):
    """Lock and yield a live job for an atomic result/import write, or raise FenceLost.

    Increment job.version and save after public changes; propagate that version
    to subsequent calls. heartbeat does not increment it. Cancellation does.
    """
    with transaction.atomic():
        job = ProcessingJob.objects.select_for_update().get(pk=job_id)
        statuses = EXECUTING_JOB_STATUSES if allow_cancel else (JobStatus.RUNNING,)
        try:
            token = uuid.UUID(str(run_token))
        except (ValueError, TypeError, AttributeError):
            raise FenceLost() from None
        now = db_now()
        if (job.status not in statuses or job.run_token != token or job.version != version
                or job.lease_expires_at <= now or (not allow_timeout and job.processing_deadline_at <= now)):
            raise FenceLost()
        yield job


def heartbeat(job_id, run_token, version, *, lease_seconds=None):
    """heartbeat(...) -> job; renew only an unexpired matching fence, including cancel_requested."""
    lease_seconds = _lease_seconds(lease_seconds)
    with fenced_job(job_id, run_token, version, allow_cancel=True, allow_timeout=True) as job:
        now = db_now()
        job.heartbeat_at = now
        job.lease_expires_at = now + timedelta(seconds=lease_seconds)
        job.save(update_fields=["heartbeat_at", "lease_expires_at"])
        return job


def request_cancel(job_id):
    """request_cancel(job_id) -> job. Idempotent for cancel_requested/cancelled."""
    with transaction.atomic():
        job = ProcessingJob.objects.select_for_update().get(pk=job_id)
        if job.status in {JobStatus.CANCEL_REQUESTED, JobStatus.CANCELLED}:
            return job
        if job.status in TERMINAL_JOB_STATUSES:
            raise QueueError("job_terminal")
        now = db_now()
        job.cancel_requested_at = now
        if job.status == JobStatus.QUEUED:
            _terminalize(job, JobStatus.CANCELLED, "", now)
        else:
            job.status = JobStatus.CANCEL_REQUESTED
            job.version += 1
            job.save(update_fields=["status", "cancel_requested_at", "version"])
        return job


def update_progress(job_id, run_token, version, *, stage=None, detected_count=None, current_position=None):
    """Update stage/count/current position under fence; returns the new job version."""
    with fenced_job(job_id, run_token, version) as job:
        if stage is not None:
            if stage not in JobStage.values or stage in {JobStage.WAITING, JobStage.FINISHED}:
                raise QueueError("invalid_stage")
            job.stage = stage
        if detected_count is not None:
            if type(detected_count) is not int or not 0 <= detected_count <= 10:
                raise QueueError("invalid_progress")
            if job.detected_count is not None and job.detected_count != detected_count:
                raise QueueError("invalid_progress")
            job.detected_count = detected_count
        if current_position is not None and (type(current_position) is not int or job.detected_count is None or not 1 <= current_position <= job.detected_count):
            raise QueueError("invalid_progress")
        job.current_position = current_position
        job.version += 1
        job.save()
        return job


def refresh_progress(job):
    """Recompute image outcomes on an already fenced/locked job (no save)."""
    images = list(job.images.all())  # <=10, one bounded query.
    job.completed_count = sum(image.status in TERMINAL_IMAGE_STATUSES for image in images)
    job.imported_count = sum(image.import_effect == ImportEffect.CREATED for image in images)
    job.reused_count = sum(image.import_effect in {ImportEffect.LINKED, ImportEffect.UPDATED} for image in images)
    job.review_count = sum(
        image.status == ImageStatus.NEEDS_REVIEW
        or (image.status in {ImageStatus.IMPORTED, ImageStatus.REUSED, ImageStatus.UPDATED} and bool(image.issues))
        for image in images
    )
    job.failed_count = sum(image.status == ImageStatus.FAILED for image in images)
    job.cancelled_count = sum(image.status == ImageStatus.CANCELLED for image in images)
    return images


def _terminalize(job, status, error_code, now):
    pending = job.images.filter(status__in=[ImageStatus.PENDING, ImageStatus.RUNNING])
    if status in {JobStatus.CANCELLED, JobStatus.FAILED}:
        if status == JobStatus.CANCELLED:
            pending.update(status=ImageStatus.CANCELLED)
        else:
            pending.update(status=ImageStatus.FAILED, issues=[{
                "code": error_code or "worker_lost", "field": "/", "message": "Обработка изображения не завершена.",
            }])
    job.attempts.filter(status=AttemptStatus.RUNNING).update(
        status=AttemptStatus.CANCELLED if status == JobStatus.CANCELLED else AttemptStatus.FAILED,
        error_code=error_code, finished_at=now,
    )
    refresh_progress(job)
    job.status = status
    job.stage = JobStage.FINISHED
    job.finished_at = now
    job.current_position = None
    job.error_code = _error_code(error_code)
    job.run_token = job.heartbeat_at = job.lease_expires_at = None
    job.version += 1
    job.save()


def finish_job(job_id, run_token, version, *, status, error_code=""):
    """finish_job(..., status=terminal, error_code='') -> job; cancellation must be acknowledged after tree stop."""
    if status not in TERMINAL_JOB_STATUSES:
        raise QueueError("invalid_status")
    with fenced_job(job_id, run_token, version, allow_cancel=status == JobStatus.CANCELLED, allow_timeout=True) as job:
        if status == JobStatus.CANCELLED and job.status != JobStatus.CANCEL_REQUESTED:
            raise QueueError("cancel_not_requested")
        images = refresh_progress(job)
        if status in {JobStatus.SUCCEEDED, JobStatus.PARTIAL_SUCCEEDED}:
            if (not images or job.detected_count != len(images) or any(image.status not in TERMINAL_IMAGE_STATUSES for image in images)
                    or job.attempts.filter(status=AttemptStatus.RUNNING).exists()):
                raise QueueError("incomplete_results")
            success = all(image.status in {ImageStatus.IMPORTED, ImageStatus.REUSED, ImageStatus.UPDATED} and not image.issues for image in images)
            usable = any(image.import_effect != ImportEffect.NONE or (image.status == ImageStatus.NEEDS_REVIEW and image.normalized_result is not None) for image in images)
            if (status == JobStatus.SUCCEEDED and not success) or (status == JobStatus.PARTIAL_SUCCEEDED and (success or not usable)):
                raise QueueError("invalid_outcome")
        _terminalize(job, status, error_code, db_now())
        return job


def recover_expired_jobs(*, limit=100):
    """recover_expired_jobs(*, limit=100) -> list[job]; fences expired attempts, no OCR invocation."""
    if type(limit) is not int or not 1 <= limit <= 1000:
        raise QueueError("invalid_limit")
    recovered = []
    with transaction.atomic():
        now = db_now()
        jobs = ProcessingJob.objects.select_for_update(skip_locked=True).filter(
            status__in=EXECUTING_JOB_STATUSES, lease_expires_at__lte=now,
        ).order_by("lease_expires_at", "id")[:limit]
        for job in jobs:
            if job.status == JobStatus.CANCEL_REQUESTED:
                _terminalize(job, JobStatus.CANCELLED, "", now)
            elif job.processing_deadline_at <= now or job.claim_count >= settings.RECEIPT_OCR_MAX_ATTEMPTS:
                _terminalize(job, JobStatus.FAILED, "timeout" if job.processing_deadline_at <= now else "worker_lost", now)
            else:
                _requeue(job, now)
            recovered.append(job)
    return recovered


def _requeue(job, now):
    job.attempts.filter(status=AttemptStatus.RUNNING).update(status=AttemptStatus.FAILED, error_code="worker_lost", finished_at=now)
    job.images.filter(status=ImageStatus.RUNNING).update(status=ImageStatus.PENDING)
    job.status = JobStatus.QUEUED
    job.stage = JobStage.WAITING
    job.current_position = None
    job.available_at = now
    job.run_token = job.heartbeat_at = job.lease_expires_at = None
    job.version += 1
    job.save()


def release_job(job_id, run_token, version):
    """Graceful worker stop, after its process tree stopped; preserves user cancellation."""
    with fenced_job(job_id, run_token, version, allow_cancel=True, allow_timeout=True) as job:
        now = db_now()
        if job.status == JobStatus.CANCEL_REQUESTED:
            _terminalize(job, JobStatus.CANCELLED, "", now)
        else:
            _requeue(job, now)
        return job


def save_image_result(job_id, run_token, version, image_id, *, status, normalized_result=None, issues=None, receipt=None, import_effect=ImportEffect.NONE):
    """Persist normalized result/linkage under fence; returns (image, updated_job).

    For domain imports, wrap this call and all Receipt writes in fenced_job() so
    cancellation and recovery cannot interleave with commit. Terminal images are immutable.
    """
    if status not in ImageStatus.values or status == ImageStatus.PENDING or import_effect not in ImportEffect.values:
        raise QueueError("invalid_status")
    if issues is not None and not isinstance(issues, list):
        raise QueueError("invalid_issues")
    if normalized_result is not None and not isinstance(normalized_result, dict):
        raise QueueError("invalid_result")
    with fenced_job(job_id, run_token, version, allow_timeout=status in {ImageStatus.FAILED, ImageStatus.CANCELLED}) as job:
        image = ReceiptImage.objects.select_for_update().get(pk=image_id, job=job, photo_id=job.photo_id)
        if image.status in TERMINAL_IMAGE_STATUSES:
            raise QueueError("image_terminal")
        receipt_id = getattr(receipt, "pk", receipt)
        if (import_effect != ImportEffect.NONE) != (receipt_id is not None):
            raise QueueError("invalid_import_effect")
        expected_effect = {ImageStatus.IMPORTED: ImportEffect.CREATED, ImageStatus.REUSED: ImportEffect.LINKED, ImageStatus.UPDATED: ImportEffect.UPDATED}
        if ((status in expected_effect and import_effect != expected_effect[status])
                or (status in {ImageStatus.RUNNING, ImageStatus.FAILED, ImageStatus.CANCELLED} and import_effect != ImportEffect.NONE)
                or (image.clipped and import_effect != ImportEffect.NONE)):
            raise QueueError("invalid_import_effect")
        image.status = status
        image.normalized_result = normalized_result
        image.issues = issues or []
        image.receipt_id = receipt_id
        image.import_effect = import_effect
        if receipt_id is not None:
            image.outcome_snapshot = {"receipt_id": receipt_id}
        image.save()
        refresh_progress(job)
        job.version += 1
        job.save()
        return image, job


def start_attempt(job_id, run_token, version, *, phase, image_id=None, provider, model="", provider_version="", cli_version="", prompt_version="", schema_version, input_sha256):
    """start_attempt(...) -> attempt; ordinal persists across recovery, version unchanged (private write)."""
    with fenced_job(job_id, run_token, version) as job:
        if phase not in AttemptPhase.values or (phase == AttemptPhase.DETECT) != (image_id is None):
            raise QueueError("invalid_phase")
        if image_id is not None:
            image = ReceiptImage.objects.get(pk=image_id, job=job, photo_id=job.photo_id)
            if image.status in TERMINAL_IMAGE_STATUSES:
                raise QueueError("image_terminal")
        previous = job.attempts.filter(phase=phase, image_id=image_id)
        if previous.filter(status=AttemptStatus.RUNNING).exists():
            raise QueueError("attempt_running")
        ordinal = (previous.aggregate(value=Max("ordinal"))["value"] or 0) + 1
        if ordinal > settings.RECEIPT_OCR_MAX_ATTEMPTS:
            raise QueueError("attempt_limit")
        return RecognitionAttempt.objects.create(
            job=job, image_id=image_id, phase=phase, ordinal=ordinal, run_token=job.run_token,
            provider=provider, model=model, provider_version=provider_version, cli_version=cli_version,
            prompt_version=prompt_version, schema_version=schema_version, input_sha256=input_sha256, started_at=db_now(),
        )


def finish_attempt(job_id, run_token, version, attempt_id, *, status, raw_payload=None, error_code="", invalid_output_text=""):
    """finish_attempt(...) -> attempt; immutable after finishing; raw output remains private."""
    if status not in {AttemptStatus.SUCCEEDED, AttemptStatus.FAILED, AttemptStatus.CANCELLED}:
        raise QueueError("invalid_status")
    with fenced_job(job_id, run_token, version, allow_cancel=status == AttemptStatus.CANCELLED, allow_timeout=status != AttemptStatus.SUCCEEDED) as job:
        attempt = RecognitionAttempt.objects.select_for_update().get(pk=attempt_id, job=job, run_token=job.run_token)
        if attempt.status != AttemptStatus.RUNNING:
            raise QueueError("attempt_terminal")
        attempt.status = status
        attempt.raw_payload = raw_payload
        attempt.error_code = _error_code(error_code)
        attempt.invalid_output_text = invalid_output_text[:65536]
        attempt.finished_at = db_now()
        attempt.save()
        return attempt
