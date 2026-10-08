from django.conf import settings
from django.db import models
from django.db.models import F, Q


class ProductMerge(models.Model):
    """Group of duplicate products: merged provisionally, then confirmed or cancelled."""

    class Status(models.TextChoices):
        PENDING = "pending", "Ожидает подтверждения"
        CONFIRMED = "confirmed", "Подтверждено"
        CANCELLED = "cancelled", "Отменено"

    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    # Grows with every change of the member set; clients echo it back.
    version = models.PositiveIntegerField(default=1)
    # Id of the surviving product. No FK: the journal outlives catalog edits.
    target_ref = models.BigIntegerField()
    detector_version = models.PositiveSmallIntegerField()
    created_at = models.DateTimeField(auto_now_add=True)
    resolved_at = models.DateTimeField(null=True, blank=True)
    # Who confirmed or cancelled; empty for a command, the detector and old records.
    resolved_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
    )

    class Meta:
        constraints = [
            models.CheckConstraint(
                condition=(
                    Q(status="pending", resolved_at__isnull=True)
                    | (Q(status__in=["confirmed", "cancelled"]) & Q(resolved_at__isnull=False))
                ),
                name="merges_productmerge_pending_unresolved",
            ),
        ]
        indexes = [
            models.Index(fields=["status", "id"], name="merges_merge_status_id_idx"),
        ]

    def __str__(self):
        return f"{self.pk} {self.status}"


class ProductMergeMember(models.Model):
    """One product of a group with a snapshot of its name and facts."""

    class Role(models.TextChoices):
        TARGET = "target", "Оставляемая"
        SOURCE = "source", "Поглощаемая"

    class State(models.TextChoices):
        ACTIVE = "active", "В группе"
        EXCLUDED = "excluded", "Исключена"

    group = models.ForeignKey(ProductMerge, on_delete=models.CASCADE, related_name="members")
    product_ref = models.BigIntegerField()  # product id, kept after the product is deleted
    # Set only while the group is pending and the member is active. PROTECT keeps
    # a product of a pending group from being deleted; unique — one pending group.
    active_product = models.OneToOneField(
        "catalog.Product", null=True, blank=True, on_delete=models.PROTECT,
        related_name="pending_merge_member",
    )
    role = models.CharField(max_length=8, choices=Role.choices)
    state = models.CharField(max_length=8, choices=State.choices, default=State.ACTIVE)
    name = models.CharField(max_length=255)
    facts = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["group", "product_ref"], name="merges_member_group_product_uniq",
            ),
            models.UniqueConstraint(
                fields=["group"], condition=Q(role="target", state="active"),
                name="merges_member_group_target_uniq",
            ),
        ]

    def __str__(self):
        return f"{self.group_id}:{self.product_ref} {self.name}"


class ProductMergeLine(models.Model):
    """Journal: the receipt line belonged to this member before the merge."""

    member = models.ForeignKey(ProductMergeMember, on_delete=models.CASCADE, related_name="lines")
    line = models.ForeignKey("receipts.ReceiptLine", on_delete=models.CASCADE, related_name="merge_entries")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["member", "line"], name="merges_line_member_line_uniq"),
        ]


class ProductMergeAlias(models.Model):
    """Journal: the alias belonged to this member before the merge."""

    member = models.ForeignKey(ProductMergeMember, on_delete=models.CASCADE, related_name="aliases")
    alias = models.ForeignKey("receipts.ProductAlias", on_delete=models.CASCADE, related_name="merge_entries")

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["member", "alias"], name="merges_alias_member_alias_uniq"),
        ]


class ProductMergeRejection(models.Model):
    """A pair a human refused to merge; the detector never proposes it again."""

    product_low = models.ForeignKey("catalog.Product", on_delete=models.CASCADE, related_name="+")
    product_high = models.ForeignKey("catalog.Product", on_delete=models.CASCADE, related_name="+")
    group = models.ForeignKey(
        ProductMerge, null=True, blank=True, on_delete=models.SET_NULL, related_name="rejections",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    # Who refused the pair; empty for a command and old records.
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+",
    )

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["product_low", "product_high"], name="merges_rejection_pair_uniq",
            ),
            models.CheckConstraint(
                condition=Q(product_low__lt=F("product_high")), name="merges_rejection_low_lt_high",
            ),
        ]

    def __str__(self):
        return f"{self.product_low_id}/{self.product_high_id}"
