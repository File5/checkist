from django.contrib import admin

from .models import StatementImport, StatementRule
from .rules import normalize


@admin.register(StatementRule)
class StatementRuleAdmin(admin.ModelAdmin):
    """Правила выписок: обычно их правят на экране правил, админка — запасной путь."""

    list_display = ("pattern", "action", "category", "store_name", "origin", "household", "user", "updated_at")
    list_filter = ("action", "origin")
    search_fields = ("pattern", "category__name", "household__name", "user__username")
    exclude = ("key",)
    autocomplete_fields = ("user",)
    ordering = ("household", "user", "key")

    def save_model(self, request, obj, form, change):
        obj.key = normalize(obj.pattern)
        if not change:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)


@admin.register(StatementImport)
class StatementImportAdmin(admin.ModelAdmin):
    """Черновики выписок только для просмотра: строки создаёт разбор, траты — экран черновика."""

    list_display = ("pk", "owner", "bank", "date_from", "date_to", "created_at", "saved_at")
    list_filter = ("bank",)
    search_fields = ("owner__username",)
    ordering = ("-created_at", "-pk")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
