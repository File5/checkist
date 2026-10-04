import uuid

from django.core.exceptions import ValidationError
from django.core.validators import RegexValidator
from django.db import models
from django.db.models import F, Q
from django.db.models.functions import Cast
from django.db.models.lookups import LessThanOrEqual
from django.utils import timezone

from .statuses import (
    ACTIVE_JOB_STATUSES, EXECUTING_JOB_STATUSES, PROGRESS_FIELDS, TERMINAL_JOB_STATUSES,
    AttemptPhase, AttemptStatus, ImageStatus, ImportEffect, JobStage, JobStatus,
)

SHA256_VALIDATOR = RegexValidator(r"\A[0-9a-f]{64}\Z", "Expected a lowercase SHA-256 digest.")


class SourcePhoto(models.Model):
    storage_uuid = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    original_file = models.FileField(max_length=255)
    upright_file = models.FileField(max_length=255, null=True, blank=True)
    sha256 = models.CharField(max_length=64, unique=True, validators=[SHA256_VALIDATOR])
    content_type = models.CharField(max_length=16)
    bytes = models.PositiveIntegerField()
    raw_width = models.PositiveIntegerField()
    raw_height = models.PositiveIntegerField()
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    exif_orientation = models.PositiveSmallIntegerField(default=1)
    preparation_version = models.PositiveSmallIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [models.Index(fields=["created_at", "id"], name="rec_photo_created_idx")]
        constraints = [
            models.CheckConstraint(condition=Q(bytes__gt=0, bytes__lte=20971520), name="rec_photo_bytes_check"),
            models.CheckConstraint(
                condition=Q(raw_width__gt=0, raw_height__gt=0, width__gt=0, height__gt=0)
                & LessThanOrEqual(Cast(F("raw_width"), models.BigIntegerField()) * F("raw_height"), 40000000)
                & LessThanOrEqual(Cast(F("width"), models.BigIntegerField()) * F("height"), 40000000),
                name="rec_photo_pixels_check",
            ),
            models.CheckConstraint(condition=Q(exif_orientation__gte=1, exif_orientation__lte=8), name="rec_photo_orientation_check"),
            models.CheckConstraint(condition=Q(content_type__in=["image/jpeg", "image/png", "image/webp"]), name="rec_photo_type_check"),
        ]


class ProcessingJob(models.Model):
    Status = JobStatus
    Stage = JobStage
    photo = models.ForeignKey(SourcePhoto, on_delete=models.PROTECT, related_name="jobs")
    retry_of = models.ForeignKey("self", null=True, blank=True, on_delete=models.SET_NULL, related_name="retries")
    status = models.CharField(max_length=20, choices=JobStatus.choices, default=JobStatus.QUEUED)
    stage = models.CharField(max_length=16, choices=JobStage.choices, default=JobStage.WAITING)
    detected_count = models.PositiveSmallIntegerField(null=True, blank=True)
    completed_count = models.PositiveSmallIntegerField(default=0)
    imported_count = models.PositiveSmallIntegerField(default=0)
    reused_count = models.PositiveSmallIntegerField(default=0)
    review_count = models.PositiveSmallIntegerField(default=0)
    failed_count = models.PositiveSmallIntegerField(default=0)
    cancelled_count = models.PositiveSmallIntegerField(default=0)
    current_position = models.PositiveSmallIntegerField(null=True, blank=True)
    version = models.PositiveBigIntegerField(default=1)
    run_token = models.UUIDField(null=True, blank=True)
    claim_count = models.PositiveSmallIntegerField(default=0)
    available_at = models.DateTimeField(default=timezone.now)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    processing_deadline_at = models.DateTimeField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    cancel_requested_at = models.DateTimeField(null=True, blank=True)
    error_code = models.CharField(max_length=64, blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["status", "available_at", "id"], name="rec_job_available_idx"),
            models.Index(fields=["status", "lease_expires_at"], name="rec_job_lease_idx"),
        ]
        constraints = [
            models.UniqueConstraint(fields=["photo"], condition=Q(status__in=ACTIVE_JOB_STATUSES), name="rec_job_active_photo_uniq"),
            models.CheckConstraint(condition=Q(status__in=JobStatus.values), name="rec_job_status_check"),
            models.CheckConstraint(condition=Q(stage__in=JobStage.values), name="rec_job_stage_check"),
            models.CheckConstraint(condition=Q(version__gte=1), name="rec_job_version_check"),
            models.CheckConstraint(condition=Q(detected_count__isnull=True) | Q(detected_count__lte=10), name="rec_job_detected_check"),
            models.CheckConstraint(
                condition=Q(current_position__isnull=True) | Q(current_position__gte=1, current_position__lte=F("detected_count"), detected_count__isnull=False),
                name="rec_job_position_check",
            ),
            models.CheckConstraint(
                condition=(Q(status__in=TERMINAL_JOB_STATUSES, finished_at__isnull=False, stage=JobStage.FINISHED)
                           | Q(status__in=ACTIVE_JOB_STATUSES, finished_at__isnull=True) & ~Q(stage=JobStage.FINISHED)),
                name="rec_job_finished_check",
            ),
            models.CheckConstraint(
                condition=(Q(status__in=EXECUTING_JOB_STATUSES, run_token__isnull=False, heartbeat_at__isnull=False,
                             lease_expires_at__isnull=False, started_at__isnull=False, processing_deadline_at__isnull=False)
                           | Q(status__in=[JobStatus.QUEUED, *TERMINAL_JOB_STATUSES], run_token__isnull=True,
                               heartbeat_at__isnull=True, lease_expires_at__isnull=True)),
                name="rec_job_ownership_check",
            ),
            models.CheckConstraint(
                condition=(Q(status__in=[JobStatus.CANCEL_REQUESTED, JobStatus.CANCELLED], cancel_requested_at__isnull=False)
                           | ~Q(status__in=[JobStatus.CANCEL_REQUESTED, JobStatus.CANCELLED]) & Q(cancel_requested_at__isnull=True)),
                name="rec_job_cancel_check",
            ),
            *[models.CheckConstraint(
                condition=Q(**{f"{field}__lte": 10}) & (
                    Q(detected_count__isnull=True, **{field: 0}) | Q(detected_count__isnull=False, **{f"{field}__lte": F("detected_count")})
                ), name=f"rec_job_{field}_check",
            ) for field in PROGRESS_FIELDS],
        ]


class ReceiptImage(models.Model):
    Status = ImageStatus
    ImportEffect = ImportEffect
    photo = models.ForeignKey(SourcePhoto, on_delete=models.PROTECT, related_name="receipt_images")
    job = models.ForeignKey(ProcessingJob, on_delete=models.CASCADE, related_name="images")
    position = models.PositiveSmallIntegerField()
    file = models.FileField(max_length=255)
    sha256 = models.CharField(max_length=64, validators=[SHA256_VALIDATOR])
    width = models.PositiveIntegerField()
    height = models.PositiveIntegerField()
    bbox = models.JSONField()
    quad = models.JSONField(null=True, blank=True)
    rotation_degrees = models.FloatField(default=0)
    crop_transform = models.JSONField(default=dict, blank=True)
    clipped = models.BooleanField(default=False)
    status = models.CharField(max_length=16, choices=ImageStatus.choices, default=ImageStatus.PENDING)
    receipt = models.ForeignKey("receipts.Receipt", null=True, blank=True, on_delete=models.SET_NULL, related_name="recognition_images")
    import_effect = models.CharField(max_length=8, choices=ImportEffect.choices, default=ImportEffect.NONE)
    normalized_result = models.JSONField(null=True, blank=True)
    issues = models.JSONField(default=list, blank=True)
    # Keeps historical receipt identity if SET_NULL clears the live relation.
    outcome_snapshot = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["photo", "id"], name="rec_image_photo_idx"),
            models.Index(fields=["receipt", "id"], name="rec_image_receipt_idx"),
        ]
        constraints = [
            models.UniqueConstraint(fields=["job", "position"], name="rec_image_position_uniq"),
            models.CheckConstraint(condition=Q(position__gte=1, position__lte=10), name="rec_image_position_check"),
            models.CheckConstraint(condition=Q(width__gt=0, height__gt=0) & LessThanOrEqual(Cast(F("width"), models.BigIntegerField()) * F("height"), 40000000), name="rec_image_pixels_check"),
            models.CheckConstraint(condition=Q(status__in=ImageStatus.values), name="rec_image_status_check"),
            models.CheckConstraint(condition=Q(import_effect__in=ImportEffect.values), name="rec_image_effect_check"),
            models.CheckConstraint(condition=Q(rotation_degrees__gte=-180, rotation_degrees__lte=180), name="rec_image_rotation_check"),
        ]

    def clean(self):
        super().clean()
        if self.job_id and self.photo_id and self.job.photo_id != self.photo_id:
            raise ValidationError({"photo": "The image must belong to the job's source photo."})
        from .images import ImageError, validate_geometry
        try:
            validate_geometry(self.bbox, self.quad, self.rotation_degrees)
        except ImageError:
            raise ValidationError({"bbox": "Invalid normalized receipt geometry."}) from None


class RecognitionAttempt(models.Model):
    Phase = AttemptPhase
    Status = AttemptStatus
    job = models.ForeignKey(ProcessingJob, on_delete=models.CASCADE, related_name="attempts")
    image = models.ForeignKey(ReceiptImage, null=True, blank=True, on_delete=models.CASCADE, related_name="attempts")
    phase = models.CharField(max_length=10, choices=AttemptPhase.choices)
    ordinal = models.PositiveSmallIntegerField(default=1)
    run_token = models.UUIDField()
    provider = models.CharField(max_length=32)
    model = models.CharField(max_length=100, blank=True, default="")
    provider_version = models.CharField(max_length=64, blank=True, default="")
    cli_version = models.CharField(max_length=64, blank=True, default="")
    prompt_version = models.CharField(max_length=64, blank=True, default="")
    schema_version = models.CharField(max_length=64)
    input_sha256 = models.CharField(max_length=64, validators=[SHA256_VALIDATOR])
    status = models.CharField(max_length=16, choices=AttemptStatus.choices, default=AttemptStatus.RUNNING)
    raw_payload = models.JSONField(null=True, blank=True)
    invalid_output_text = models.TextField(blank=True, default="")
    error_code = models.CharField(max_length=64, blank=True, default="")
    started_at = models.DateTimeField(default=timezone.now)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["job", "id"], name="rec_attempt_job_idx")]
        constraints = [
            models.UniqueConstraint(fields=["job", "phase", "image", "ordinal"], nulls_distinct=False, name="rec_attempt_ordinal_uniq"),
            models.CheckConstraint(condition=Q(ordinal__gte=1), name="rec_attempt_ordinal_check"),
            models.CheckConstraint(condition=Q(phase=AttemptPhase.DETECT, image__isnull=True) | Q(phase=AttemptPhase.RECOGNIZE, image__isnull=False), name="rec_attempt_phase_check"),
            models.CheckConstraint(condition=Q(status=AttemptStatus.RUNNING, finished_at__isnull=True) | Q(status__in=[AttemptStatus.SUCCEEDED, AttemptStatus.FAILED, AttemptStatus.CANCELLED], finished_at__isnull=False), name="rec_attempt_finished_check"),
        ]

    def clean(self):
        super().clean()
        if self.image_id and self.job_id and self.image.job_id != self.job_id:
            raise ValidationError({"image": "The attempt must belong to the image's job."})
