from django.conf import settings
from django.db import models
from django.db.models import Q


class ClassificationRun(models.Model):
    """One request "suggest generic products for these products"; executed in batches."""

    class Status(models.TextChoices):
        QUEUED = "queued", "В очереди"
        RUNNING = "running", "Выполняется"
        SUCCEEDED = "succeeded", "Выполнен"
        FAILED = "failed", "Ошибка"
        CANCELLED = "cancelled", "Отменён"

    class Trigger(models.TextChoices):
        MANUAL = "manual", "Кнопка"
        IMPORT = "import", "После импорта"
        COMMAND = "command", "Команда"

    class Scope(models.TextChoices):
        ALL = "all", "Все товары без категории"
        PRODUCTS = "products", "Выбранные товары"

    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    trigger = models.CharField(max_length=16, choices=Trigger.choices)
    scope = models.CharField(max_length=16, choices=Scope.choices)
    # Fixed when the run is queued, at most PRODUCT_CLASSIFICATION_RUN_LIMIT ids.
    product_ids = models.JSONField(default=list, blank=True)
    cursor = models.PositiveIntegerField(default=0)  # how many ids went through batches
    requested_count = models.PositiveIntegerField(default=0)
    applied_count = models.PositiveIntegerField(default=0)
    unknown_count = models.PositiveIntegerField(default=0)
    skipped_count = models.PositiveIntegerField(default=0)
    # Candidates left out because of the run limit; null when not counted.
    remaining_count = models.PositiveIntegerField(null=True, blank=True)
    stats = models.JSONField(default=dict, blank=True)  # private: reason code -> count
    version = models.PositiveBigIntegerField(default=1)
    run_token = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    heartbeat_at = models.DateTimeField(null=True, blank=True)
    recoveries = models.PositiveSmallIntegerField(default=0)
    error_code = models.CharField(max_length=64, blank=True, default="")
    provider = models.CharField(max_length=32, blank=True, default="")
    model = models.CharField(max_length=100, blank=True, default="")
    prompt_version = models.CharField(max_length=64, blank=True, default="")
    schema_version = models.CharField(max_length=64, blank=True, default="")
    classifier_version = models.PositiveSmallIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)
    # Who asked for the run; empty for an import, a command and old records.
    requested_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
    )

    class Meta:
        constraints = [
            # At most one run waits and at most one executes.
            models.UniqueConstraint(
                fields=["status"], condition=Q(status="queued"), name="classification_run_one_queued",
            ),
            models.UniqueConstraint(
                fields=["status"], condition=Q(status="running"), name="classification_run_one_running",
            ),
            models.CheckConstraint(
                condition=(
                    Q(status="running", run_token__isnull=False, heartbeat_at__isnull=False,
                      lease_expires_at__isnull=False)
                    | (~Q(status="running") & Q(run_token__isnull=True, heartbeat_at__isnull=True,
                                                lease_expires_at__isnull=True))
                ),
                name="classification_run_ownership_check",
            ),
            models.CheckConstraint(
                condition=(
                    Q(status__in=["succeeded", "failed", "cancelled"], finished_at__isnull=False)
                    | Q(status__in=["queued", "running"], finished_at__isnull=True)
                ),
                name="classification_run_finished_check",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "id"], name="classification_run_status_idx"),
        ]

    def __str__(self):
        return f"{self.pk} {self.status}"


class ClassificationAttempt(models.Model):
    """Private record of one model call of a batch; never returned by the API."""

    class Status(models.TextChoices):
        RUNNING = "running", "Выполняется"
        SUCCEEDED = "succeeded", "Выполнена"
        FAILED = "failed", "Ошибка"

    run = models.ForeignKey(ClassificationRun, on_delete=models.CASCADE, related_name="attempts")
    batch = models.PositiveIntegerField()  # batch number of the run, from 1
    ordinal = models.PositiveSmallIntegerField()  # attempt of the batch, from 1
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.RUNNING)
    input_sha256 = models.CharField(max_length=64)
    product_ids = models.JSONField(default=list, blank=True)
    raw_payload = models.JSONField(null=True, blank=True)
    invalid_output_text = models.TextField(max_length=65536, blank=True, default="")
    error_code = models.CharField(max_length=64, blank=True, default="")
    started_at = models.DateTimeField(auto_now_add=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["run", "batch", "ordinal"], name="classification_attempt_run_batch_ordinal_uniq",
            ),
        ]

    def __str__(self):
        return f"{self.run_id}:{self.batch}.{self.ordinal} {self.status}"


class ProductClassification(models.Model):
    """A suggestion for one product: applied at once, then confirmed, rejected or superseded."""

    class Status(models.TextChoices):
        PENDING = "pending", "Ожидает подтверждения"
        CONFIRMED = "confirmed", "Подтверждено"
        REJECTED = "rejected", "Отклонено"
        SUPERSEDED = "superseded", "Заменено"

    class Resolution(models.TextChoices):
        CONFIRMED = "confirmed", "Подтверждено"
        OTHER = "other", "Выбран другой"
        REJECTED = "rejected", "Отклонено"
        CANCELLED = "cancelled", "Отменено командой"
        CHANGED = "changed", "Изменено вне экрана"
        MERGED = "merged", "Товар поглощён слиянием"
        PRODUCT_REMOVED = "product_removed", "Товар удалён"

    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    resolution = models.CharField(max_length=16, choices=Resolution.choices, blank=True, default="")
    # Grows with every change the service makes; clients echo it back.
    version = models.PositiveIntegerField(default=1)
    product_ref = models.BigIntegerField()  # product id, kept after the product is deleted
    # Set only while the record is pending. SET_NULL: a merge or a human may delete
    # the product; unique — one pending record per product.
    active_product = models.OneToOneField(
        "catalog.Product", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="pending_classification",
    )
    # The product the record was created for, once it moved to a merge survivor.
    origin_product_ref = models.BigIntegerField(null=True, blank=True)
    product_name = models.CharField(max_length=255)
    product_facts = models.JSONField(default=dict, blank=True)  # {"brand": ..., "package": ...}
    previous_generic_ref = models.BigIntegerField()  # always the service generic
    previous_generic_name = models.CharField(max_length=100)
    previous_generic_base_unit = models.CharField(max_length=8)
    suggested_generic = models.ForeignKey(
        "catalog.GenericProduct", null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
    )
    suggested_generic_ref = models.BigIntegerField()
    suggested_generic_name = models.CharField(max_length=100)
    suggested_base_unit = models.CharField(max_length=8)
    suggested_category_path = models.JSONField(default=list, blank=True)  # [{"id", "name"}] from the root
    final_generic_ref = models.BigIntegerField(null=True, blank=True)
    final_generic_name = models.CharField(max_length=100, blank=True, default="")
    final_base_unit = models.CharField(max_length=8, blank=True, default="")
    run = models.ForeignKey(
        ClassificationRun, null=True, blank=True, on_delete=models.SET_NULL, related_name="records",
    )
    classifier_version = models.PositiveSmallIntegerField()
    provider = models.CharField(max_length=32)
    model = models.CharField(max_length=100, blank=True, default="")  # empty for fake
    prompt_version = models.CharField(max_length=64)
    schema_version = models.CharField(max_length=64)
    confidence = models.DecimalField(max_digits=3, decimal_places=2, null=True, blank=True)  # private
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    # Who confirmed or rejected; empty for the automation, a command and old records.
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
    )

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(status="pending", resolved_at__isnull=True, resolution="")
                    | (Q(status__in=["confirmed", "rejected", "superseded"], resolved_at__isnull=False)
                       & ~Q(resolution=""))
                ),
                name="classification_record_pending_unresolved",
            ),
            # Not the reverse: a pending record briefly outlives its deleted product.
            models.CheckConstraint(
                condition=Q(active_product__isnull=True) | Q(status="pending"),
                name="classification_record_active_pending",
            ),
        ]
        indexes = [
            models.Index(
                fields=["status", "suggested_generic_name", "suggested_generic_ref", "id"],
                name="classification_rec_screen_idx",
            ),
            models.Index(fields=["product_ref", "id"], name="classification_rec_product_idx"),
            models.Index(fields=["suggested_generic_ref", "status"], name="classification_rec_generic_idx"),
        ]

    def __str__(self):
        return f"{self.pk} {self.status} {self.product_name}"


class CreatedState(models.TextChoices):
    PROVISIONAL = "provisional", "Новая"
    KEPT = "kept", "Принята"
    REMOVED = "removed", "Удалена"


def _created_state_check(name):
    return models.CheckConstraint(
        condition=(
            Q(state="provisional", resolved_at__isnull=True)
            | Q(state__in=["kept", "removed"], resolved_at__isnull=False)
        ),
        name=name,
    )


class CreatedGenericProduct(models.Model):
    """Journal: the generic product was created by the mechanism."""

    State = CreatedState

    generic = models.OneToOneField(
        "catalog.GenericProduct", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="classification_origin",
    )
    generic_ref = models.BigIntegerField()
    name = models.CharField(max_length=100)
    base_unit = models.CharField(max_length=8)
    category_ref = models.BigIntegerField()
    state = models.CharField(max_length=16, choices=CreatedState.choices, default=CreatedState.PROVISIONAL)
    run = models.ForeignKey(
        ClassificationRun, null=True, blank=True, on_delete=models.SET_NULL, related_name="created_generics",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [_created_state_check("classification_created_generic_state_check")]

    def __str__(self):
        return f"{self.generic_ref} {self.name} {self.state}"


class CreatedCategory(models.Model):
    """Journal: the category was created by the mechanism."""

    State = CreatedState

    category = models.OneToOneField(
        "catalog.Category", null=True, blank=True, on_delete=models.SET_NULL,
        related_name="classification_origin",
    )
    category_ref = models.BigIntegerField()
    name = models.CharField(max_length=100)
    parent_ref = models.BigIntegerField(null=True, blank=True)  # null for a root
    state = models.CharField(max_length=16, choices=CreatedState.choices, default=CreatedState.PROVISIONAL)
    run = models.ForeignKey(
        ClassificationRun, null=True, blank=True, on_delete=models.SET_NULL, related_name="created_categories",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name_plural = "created categories"
        constraints = [_created_state_check("classification_created_category_state_check")]

    def __str__(self):
        return f"{self.category_ref} {self.name} {self.state}"


class ClassificationRejection(models.Model):
    """A generic product name a human refused for the product; never suggested to it again.

    The key is the name, not an id: a rejected new generic product is removed by
    the cleanup, and the model must not bring it back.
    """

    product = models.ForeignKey("catalog.Product", on_delete=models.CASCADE, related_name="+")
    generic_key = models.CharField(max_length=100)  # classification.taxonomy.name_key
    generic_name = models.CharField(max_length=100)
    classification = models.ForeignKey(
        ProductClassification, null=True, blank=True, on_delete=models.SET_NULL, related_name="rejections",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    # Who refused the name; empty for old records.
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["product", "generic_key"], name="classification_rejection_product_key_uniq",
            ),
        ]

    def __str__(self):
        return f"{self.product_id} {self.generic_name}"
