from django.contrib import admin

from .models import BudgetLimit


@admin.register(BudgetLimit)
class BudgetLimitAdmin(admin.ModelAdmin):
    """Лимиты по категориям: обычно их правят на экране лимитов, админка — запасной путь."""

    list_display = ("category", "amount", "currency", "household", "user", "updated_at")
    list_filter = ("currency",)
    search_fields = ("category__name", "household__name", "user__username")
    autocomplete_fields = ("user",)
    ordering = ("household", "user", "category__name", "currency")
