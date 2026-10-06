"""One leased job, with durable per-crop results and no provider calls in atomic.

The caller renews the lease independently. is_stopped is a fail-closed signal
from that heartbeat, not a user cancellation request. Ctrl+C propagates after
the provider's supervisor has stopped its tree; the command releases the job.
"""
import hashlib
import math
import random
import time

from django.conf import settings

from . import queue, storage
from .dto import DetectionResult, PreparedImage, PreparedReceiptImage, ReceiptObservation
from .images import ImageError, validate_geometry
from .importer import ImportBusy, import_receipt
from .models import ProcessingJob
from .providers.base import ERRORS, ProviderError, RunContext
from .providers.factory import get_provider
from .schema_validation import SchemaValidationError, validate_detection, validate_observation
from .statuses import (
    AttemptPhase, AttemptStatus, ImageStatus, ImportEffect, JobStage, JobStatus,
    TERMINAL_IMAGE_STATUSES,
)


MAX_RECEIPT_BBOX_OVERLAP_FRACTION = 0.10


def _issue(code):
    return {"code": code, "field": "/", "message": "Не удалось завершить обработку изображения."}


def _digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


class JobPipeline:
    def __init__(self, job, provider, *, is_stopped=lambda: False):
        self.job, self.provider, self.is_stopped = job, provider, is_stopped
        self.token = job.run_token
        remaining = (job.processing_deadline_at - queue.db_now()).total_seconds()
        self.run = RunContext(
            deadline=time.monotonic() + max(0, remaining), is_cancelled=self._cancelled,
            run_id=str(self.token),
        )

    @property
    def fence(self):
        return self.job.pk, self.token, self.job.version

    def _current(self):
        return ProcessingJob.objects.get(pk=self.job.pk)

    def _cancelled(self):
        if self.is_stopped():
            raise queue.FenceLost()
        current = self._current()
        if current.run_token != self.token or current.lease_expires_at is None or current.lease_expires_at <= queue.db_now():
            raise queue.FenceLost()
        if current.status == JobStatus.CANCEL_REQUESTED:
            self.job = current  # cancellation increments the public version
            return True
        if current.status != JobStatus.RUNNING or current.version != self.job.version:
            raise queue.FenceLost()
        return False

    def _stage(self, stage, *, position=None, count=None):
        self.run.check()
        self.job = queue.update_progress(
            *self.fence, stage=stage, current_position=position, detected_count=count,
        )

    def _wait(self, seconds):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            self.run.check()
            time.sleep(min(0.05, max(0, until - time.monotonic())))
        self.run.check()

    def _retry_delay(self, error):
        if not error.retryable:
            return None
        delay = error.retry_after
        if delay is None:
            delay = random.uniform(2, 3)
        if type(delay) not in (int, float) or not math.isfinite(delay) or delay < 0 or delay > 30:
            return None
        delay = max(2, delay)
        return delay if time.monotonic() + delay < self.run.deadline else None

    def _validate(self, phase, result, prepared):
        if phase == AttemptPhase.DETECT:
            if not isinstance(result, DetectionResult):
                raise ProviderError("invalid_output")
            if result.receipt_count > settings.RECEIPT_IMAGE_MAX_RECEIPTS:
                raise ProviderError("invalid_output", reason="too_many_receipts")
            value = validate_detection(result.to_dict(), width=prepared.width, height=prepared.height)
            boxes = []
            for receipt in value.receipts:
                box, _, _ = validate_geometry(receipt.bbox.to_dict(), [p.to_dict() for p in receipt.quad], receipt.rotation_degrees)
                # Loose axis-aligned boxes of adjacent papers may overlap a little.
                # Above 10% of the smaller box, keep detect for review to avoid
                # mixed crops. The smaller area also rejects duplicates/containment.
                area = (box["x_max"] - box["x_min"]) * (box["y_max"] - box["y_min"])
                for old in boxes:
                    overlap_width = max(0, min(box["x_max"], old["x_max"]) - max(box["x_min"], old["x_min"]))
                    overlap_height = max(0, min(box["y_max"], old["y_max"]) - max(box["y_min"], old["y_min"]))
                    old_area = (old["x_max"] - old["x_min"]) * (old["y_max"] - old["y_min"])
                    if overlap_width * overlap_height > MAX_RECEIPT_BBOX_OVERLAP_FRACTION * min(area, old_area):
                        raise ImageError("geometry_requires_review")
                boxes.append(box)
            return value
        if not isinstance(result, ReceiptObservation):
            raise ProviderError("invalid_output")
        return validate_observation(result.to_dict())

    def _invoke(self, phase, prepared, *, image=None):
        self.run.check()
        previous = list(self.job.attempts.filter(phase=phase, image_id=image.pk if image else None).order_by("ordinal"))
        # Resume a valid committed extraction when a crash preceded crop/import.
        for attempt in reversed(previous):
            if attempt.status == AttemptStatus.SUCCEEDED:
                value = (validate_detection(attempt.raw_payload, width=prepared.width, height=prepared.height)
                         if phase == AttemptPhase.DETECT else validate_observation(attempt.raw_payload))
                return self._validate(phase, value, prepared)
        maximum = settings.RECEIPT_OCR_MAX_ATTEMPTS
        last_error = None
        if previous:
            code = previous[-1].error_code
            if code == "too_many_receipts":
                raise ProviderError("invalid_output", reason=code)
            if code == "geometry_requires_review":
                raise ImageError(code)
            last_error = ProviderError(code if code in ERRORS else "provider_unavailable")
            # worker_lost is an interrupted invocation, not a semantic failure.
            if code != "worker_lost" and not last_error.retryable:
                raise last_error
        while len(previous) < maximum:
            if last_error:
                delay = self._retry_delay(last_error)
                if delay is None:
                    raise last_error
                self._wait(delay)
            self.run.check()
            attempt = queue.start_attempt(
                *self.fence, phase=phase, image_id=image.pk if image else None,
                provider=settings.RECEIPT_OCR_PROVIDER,
                model=settings.RECEIPT_OCR_MODEL if settings.RECEIPT_OCR_PROVIDER == "codex_cli" else "",
                provider_version="1", cli_version=getattr(self.provider, "cli_version", ""),
                prompt_version="2" if phase == AttemptPhase.DETECT else "5",
                schema_version="1" if phase == AttemptPhase.DETECT else "2",
                input_sha256=prepared.sha256,
            )
            previous.append(attempt)
            payload = None
            try:
                seconds = (settings.RECEIPT_OCR_DETECT_TIMEOUT_SECONDS if phase == AttemptPhase.DETECT
                           else settings.RECEIPT_OCR_RECOGNIZE_TIMEOUT_SECONDS)
                context = self.run.limited(seconds)
                context = RunContext(deadline=context.deadline, is_cancelled=self._cancelled, run_id=str(attempt.pk))
                result = (self.provider.detect(prepared, context) if phase == AttemptPhase.DETECT
                          else self.provider.recognize(prepared, context))
                context.check()  # a provider ignoring cancellation cannot commit a late result
                if isinstance(result, (DetectionResult, ReceiptObservation)):
                    payload = result.to_dict()
                result = self._validate(phase, result, prepared)
                queue.finish_attempt(*self.fence, attempt.pk, status=AttemptStatus.SUCCEEDED, raw_payload=payload)
                return result
            except SchemaValidationError:
                error = ProviderError("invalid_output")
            except ImageError as error:
                queue.finish_attempt(*self.fence, attempt.pk, status=AttemptStatus.FAILED, raw_payload=payload, error_code=error.code)
                raise
            except ProviderError as problem:
                error = problem
            if error.code == "cancelled":
                raise error  # acknowledge only after the supervisor has stopped
            queue.finish_attempt(
                *self.fence, attempt.pk, status=AttemptStatus.FAILED, raw_payload=payload,
                error_code=error.reason or error.code, invalid_output_text=error.private_output or "",
            )
            last_error = error
        raise last_error or ProviderError("provider_unavailable")

    def _recognize(self, image):
        self._stage(JobStage.RECOGNIZE, position=image.position)
        if image.status == ImageStatus.PENDING:
            image, self.job = queue.save_image_result(*self.fence, image.pk, status=ImageStatus.RUNNING)
        try:
            prepared = PreparedReceiptImage(storage.media_path(image.file.name), image.sha256, image.width, image.height,
                                            position=image.position, rotation_degrees=image.rotation_degrees)
            observation = self._invoke(AttemptPhase.RECOGNIZE, prepared, image=image)
            self._stage(JobStage.VALIDATE, position=image.position)
            # Domain validation and preservation of incomplete results belong
            # to the importer; do not discard a valid nullable observation.
            self._stage(JobStage.IMPORT, position=image.position)
            for ordinal in range(3):
                self.run.check()
                try:
                    result = import_receipt(
                        image, observation, run_token=self.token, version=self.job.version, on_saved=self._finalize_import,
                    )
                    self.job.version = result.job_version
                    return
                except ImportBusy:
                    if ordinal == 2:
                        image, self.job = queue.save_image_result(
                            *self.fence, image.pk, status=ImageStatus.NEEDS_REVIEW,
                            normalized_result=observation.to_dict(), issues=[_issue("import_busy")],
                        )
                    else:
                        self._wait(0.2 * (ordinal + 1))
        except ProviderError as error:
            if error.code == "cancelled":
                raise
            self.run.check()  # budget expiry/cancel is handled for all unfinished crops
            _, self.job = queue.save_image_result(*self.fence, image.pk, status=ImageStatus.FAILED, issues=[_issue(error.reason or error.code)])
        except (storage.StorageError, ImageError, SchemaValidationError) as error:
            self.run.check()
            _, self.job = queue.save_image_result(
                *self.fence, image.pk, status=ImageStatus.FAILED, issues=[_issue(getattr(error, "code", "invalid_output"))],
            )

    def _finalize_import(self, job):
        self.job = job
        if job.images.count() == job.detected_count and not job.images.exclude(status__in=TERMINAL_IMAGE_STATUSES).exists():
            return self._outcome()
        return job

    def _outcome(self, error_code=""):
        images = list(self.job.images.order_by("position"))
        success = images and all(image.status in {ImageStatus.IMPORTED, ImageStatus.REUSED, ImageStatus.UPDATED} for image in images)
        usable = any(image.import_effect != ImportEffect.NONE or (image.status == ImageStatus.NEEDS_REVIEW and image.normalized_result is not None) for image in images)
        complete = self.job.detected_count == len(images)
        status = JobStatus.SUCCEEDED if success and complete else JobStatus.PARTIAL_SUCCEEDED if usable and complete else JobStatus.FAILED
        if status == JobStatus.FAILED and not error_code:
            error_code = next((issue["code"] for image in images for issue in image.issues), "no_receipts")
        self.job = queue.finish_job(*self.fence, status=status, error_code=error_code)
        return self.job

    def process(self):
        try:
            self._stage(JobStage.PREPARE)
            photo, self.job = storage.prepare_photo(*self.fence)
            self.run.check()
            path = storage.media_path(photo.upright_file.name)
            prepared = PreparedImage(path, _digest(path), photo.width, photo.height)
            self._stage(JobStage.DETECT)
            detected = self._invoke(AttemptPhase.DETECT, prepared)
            self._stage(JobStage.CROP, count=detected.receipt_count)
            if not detected.receipts:
                return self._outcome("no_receipts")
            for position, receipt in enumerate(detected.receipts, 1):
                self._stage(JobStage.CROP, position=position)
                existing = self.job.images.filter(position=position).first()
                if existing is not None:
                    # Recovery does not decode/write already committed crops.
                    if (existing.bbox != receipt.bbox.to_dict() or existing.quad != [p.to_dict() for p in receipt.quad]
                            or existing.rotation_degrees != receipt.rotation_degrees or existing.clipped != receipt.clipped):
                        raise ImageError("geometry_requires_review")
                    continue
                _, self.job = storage.save_crop(
                    *self.fence, position, receipt.bbox.to_dict(), quad=[p.to_dict() for p in receipt.quad],
                    rotation_degrees=receipt.rotation_degrees, clipped=receipt.clipped,
                )
            for image in self.job.images.order_by("position"):
                self.run.check()
                if image.status not in TERMINAL_IMAGE_STATUSES:
                    self._recognize(image)
                    if self.job.status in {JobStatus.SUCCEEDED, JobStatus.PARTIAL_SUCCEEDED, JobStatus.FAILED}:
                        return self.job
            self.run.check()
            return self._outcome()
        except (ProviderError, ImageError, storage.StorageError, SchemaValidationError, queue.FenceLost) as error:
            current = self._current()
            if current.run_token != self.token:
                raise queue.FenceLost() from None
            self.job = current
            if current.status == JobStatus.CANCEL_REQUESTED:
                # Provider/supervisor has returned (and therefore stopped its
                # tree). Cancellation's new version may now be acknowledged.
                self.job = queue.finish_job(*self.fence, status=JobStatus.CANCELLED)
                return self.job
            if isinstance(error, queue.FenceLost) or self.is_stopped():
                raise queue.FenceLost() from None
            code = (error.reason or error.code) if isinstance(error, ProviderError) else getattr(error, "code", "invalid_output")
            for image in self.job.images.exclude(status__in=TERMINAL_IMAGE_STATUSES):
                _, self.job = queue.save_image_result(*self.fence, image.pk, status=ImageStatus.FAILED, issues=[_issue(code)])
            return self._outcome(code)


def process_job(job, *, provider=None, is_stopped=lambda: False):
    """Process a claimed ProcessingJob. FenceLost/DB errors stop the worker."""
    return JobPipeline(job, provider or get_provider(), is_stopped=is_stopped).process()
