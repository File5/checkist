from django.contrib import admin

from .models import Income, IncomeCategory


@admin.register(Income)
class IncomeAdmin(admin.ModelAdmin):
    """Доходы; обычно их вносят в форме «Трата / Доход», админка — запасной путь."""

    list_display = ("received_on", "amount", "currency", "category", "owner")
    list_filter = ("currency",)
    search_fields = ("note", "category__name", "owner__username")
    raw_id_fields = ("owner",)
    ordering = ("-received_on", "-pk")


@admin.register(IncomeCategory)
class IncomeCategoryAdmin(admin.ModelAdmin):
    """Категории доходов: встроенные (без владельца) и свои категории семьи."""

    list_display = ("name", "household", "user")
    search_fields = ("name",)
    ordering = ("pk",)
