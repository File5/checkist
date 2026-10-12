from django.contrib import admin

from . import history
from .models import BudgetLimit, BudgetLimitChange


@admin.register(BudgetLimit)
class BudgetLimitAdmin(admin.ModelAdmin):
    """Лимиты по категориям: обычно их правят на экране лимитов, админка — запасной путь.

    Сохранение и удаление идут через ``budget.history``: журнал изменений пишется и здесь.
    """

    list_display = ("category", "amount", "currency", "household", "user", "updated_at")
    list_filter = ("currency",)
    search_fields = ("category__name", "household__name", "user__username")
    autocomplete_fields = ("user",)
    ordering = ("household", "user", "category__name", "currency")

    def save_model(self, request, obj, form, change):
        history.save_limit(obj, actor=request.user)

    def delete_model(self, request, obj):
        history.delete_limit(obj, actor=request.user)

    def delete_queryset(self, request, queryset):
        for limit in queryset.order_by("pk"):
            history.delete_limit(limit, actor=request.user)


@admin.register(BudgetLimitChange)
class BudgetLimitChangeAdmin(admin.ModelAdmin):
    """Журнал лимитов только для чтения: его пишет ``budget.history``."""

    list_display = ("changed_at", "category", "currency", "old_amount", "new_amount", "effective_month",
                    "household", "user", "changed_by")
    list_filter = ("currency",)
    search_fields = ("category__name", "household__name", "user__username")
    ordering = ("-changed_at", "-pk")

    def has_add_permission(self, request):
        return False

    # Удаление не запрещено: иначе админка не дала бы удалить семью, пользователя или категорию с журналом (CASCADE).
    def has_change_permission(self, request, obj=None):
        return False
