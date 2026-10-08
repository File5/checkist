from django.contrib import admin

from .models import LoginFailure


@admin.register(LoginFailure)
class LoginFailureAdmin(admin.ModelAdmin):
    """Счётчики неудачных входов: только чтение, их пишет ``accounts.throttle``."""

    list_display = ("key", "failures", "window_started_at")
    search_fields = ("key",)
    ordering = ("-window_started_at",)

    def has_add_permission(self, request):
        return False

    def has_change_permission(self, request, obj=None):
        return False

    def has_delete_permission(self, request, obj=None):
        return False
