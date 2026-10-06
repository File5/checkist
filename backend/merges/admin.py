from django.contrib import admin

from merges.models import ProductMerge, ProductMergeMember


class ReadOnlyAdminMixin:
    """Merge records are changed only by the service (API, management command)."""

    def has_add_permission(self, request, obj=None):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False


class ProductMergeMemberInline(ReadOnlyAdminMixin, admin.TabularInline):
    model = ProductMergeMember
    fields = ("product_ref", "active_product", "role", "state", "name")
    ordering = ("product_ref",)
    extra = 0
    can_delete = False
    show_change_link = True


@admin.register(ProductMerge)
class ProductMergeAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ("id", "status", "version", "target_ref", "created_at", "resolved_at")
    list_filter = ("status",)
    ordering = ("-id",)
    # No foreign keys to follow in the list.
    list_select_related = False
    inlines = (ProductMergeMemberInline,)


@admin.register(ProductMergeMember)
class ProductMergeMemberAdmin(ReadOnlyAdminMixin, admin.ModelAdmin):
    list_display = ("id", "group", "product_ref", "role", "state", "name", "active_product")
    list_filter = ("role", "state")
    search_fields = ("name",)
    ordering = ("-group_id", "product_ref")
    list_select_related = ("group", "active_product")
