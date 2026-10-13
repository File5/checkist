from django.contrib import admin

from .models import DismissedSuggestion, RecurringDecision, RecurringPayment


@admin.register(RecurringPayment)
class RecurringPaymentAdmin(admin.ModelAdmin):
    """Регулярные платежи; обычно их правят на экране «Регулярные платежи», админка — запасной путь."""

    list_display = ("name", "amount", "currency", "due_day", "active", "category", "store", "household", "user")
    list_filter = ("active", "currency")
    search_fields = ("name", "category__name", "household__name", "user__username")
    raw_id_fields = ("store", "created_by")
    autocomplete_fields = ("user",)
    ordering = ("household", "user", "due_day", "name")


@admin.register(RecurringDecision)
class RecurringDecisionAdmin(admin.ModelAdmin):
    """Ответы на вопрос «платёж не найден»: только чтение и удаление (удаление снова открывает вопрос)."""

    list_display = ("payment", "month", "decision", "receipt_id", "decided_by", "decided_at")
    list_filter = ("decision",)
    search_fields = ("payment__name",)
    ordering = ("-month", "-pk")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False


@admin.register(DismissedSuggestion)
class DismissedSuggestionAdmin(admin.ModelAdmin):
    """Скрытые предложения: удаление вернёт предложение."""

    list_display = ("store", "category", "currency", "household", "user", "dismissed_by", "dismissed_at")
    ordering = ("-dismissed_at", "-pk")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False
