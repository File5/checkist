"""Persistent lifecycle values shared by the queue, worker and HTTP projections."""
from django.db import models


class JobStatus(models.TextChoices):
    QUEUED = "queued"
    RUNNING = "running"
    CANCEL_REQUESTED = "cancel_requested"
    CANCELLED = "cancelled"
    SUCCEEDED = "succeeded"
    PARTIAL_SUCCEEDED = "partial_succeeded"
    FAILED = "failed"


class JobStage(models.TextChoices):
    WAITING = "waiting"
    PREPARE = "prepare"
    DETECT = "detect"
    CROP = "crop"
    RECOGNIZE = "recognize"
    VALIDATE = "validate"
    IMPORT = "import"
    FINISHED = "finished"


class ImageStatus(models.TextChoices):
    PENDING = "pending"
    RUNNING = "running"
    IMPORTED = "imported"
    REUSED = "reused"
    UPDATED = "updated"
    NEEDS_REVIEW = "needs_review"
    FAILED = "failed"
    CANCELLED = "cancelled"


class ImportEffect(models.TextChoices):
    NONE = "none"
    CREATED = "created"
    LINKED = "linked"
    UPDATED = "updated"


class AttemptPhase(models.TextChoices):
    DETECT = "detect"
    RECOGNIZE = "recognize"


class AttemptStatus(models.TextChoices):
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


ACTIVE_JOB_STATUSES = (JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.CANCEL_REQUESTED)
EXECUTING_JOB_STATUSES = (JobStatus.RUNNING, JobStatus.CANCEL_REQUESTED)
TERMINAL_JOB_STATUSES = (JobStatus.CANCELLED, JobStatus.SUCCEEDED, JobStatus.PARTIAL_SUCCEEDED, JobStatus.FAILED)
TERMINAL_IMAGE_STATUSES = tuple(value for value in ImageStatus.values if value not in {"pending", "running"})
PROGRESS_FIELDS = ("completed_count", "imported_count", "reused_count", "review_count", "failed_count", "cancelled_count")
