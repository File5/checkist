from django.contrib import admin

from classification.models import (
    ClassificationRun, CreatedCategory, CreatedGenericProduct, ProductClassification,
)


class ReadOnlyAdminMixin:
    """Classification records are changed only by the service (API, worker, management command)."""

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


# ClassificationRejection is deliberately not registered: it cascades from Product,
# and a read-only registration would forbid deleting such a product in the admin.
# ClassificationAttempt keeps private model output and stays out as well.


@admin.register(ProductClassification)
class ProductClassificationAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = (
        "id", "status", "resolution", "version", "product_name", "suggested_generic_name", "final_generic_name",
        "created_at", "resolved_at",
    )
    list_filter = ("status", "resolution")
    search_fields = ("product_name", "suggested_generic_name")
    ordering = ("-id",)
    # The list shows snapshots only.
    list_select_related = False


@admin.register(ClassificationRun)
class ClassificationRunAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = (
        "id", "status", "trigger", "scope", "requested_count", "applied_count", "unknown_count", "skipped_count",
        "error_code", "created_at", "finished_at",
    )
    list_filter = ("status", "trigger")
    ordering = ("-id",)
    list_select_related = False
    exclude = ("run_token",)


@admin.register(CreatedGenericProduct)
class CreatedGenericProductAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ("id", "name", "base_unit", "state", "generic_ref", "category_ref", "created_at", "resolved_at")
    list_filter = ("state",)
    search_fields = ("name",)
    ordering = ("-id",)
    list_select_related = False


@admin.register(CreatedCategory)
class CreatedCategoryAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ("id", "name", "state", "category_ref", "parent_ref", "created_at", "resolved_at")
    list_filter = ("state",)
    search_fields = ("name",)
    ordering = ("-id",)
    list_select_related = False
