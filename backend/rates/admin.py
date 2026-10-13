from django.contrib import admin

from .models import Rate


@admin.register(Rate)
class RateAdmin(admin.ModelAdmin):
    """Курсы Нацбанка только для просмотра: их пишет ``manage.py rates fetch`` и догрузка свежих дней."""

    list_display = ("day", "currency", "value", "quant", "fetched_at")
    list_filter = ("currency",)
    date_hierarchy = "day"
    ordering = ("-day", "currency")

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
