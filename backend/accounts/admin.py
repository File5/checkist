from django.contrib import admin

from .models import Household, LoginFailure, Membership


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


class MembershipInline(admin.TabularInline):
    model = Membership
    extra = 1
    fields = ("user", "role", "visible_from")
    autocomplete_fields = ("user",)


@admin.register(Household)
class HouseholdAdmin(admin.ModelAdmin):
    """Семьи заводит администратор: название и члены; пользователь — не больше чем в одной.

    ИИ семьи: включатель (его же меняет главный на «Семье») и дневная квота запросов — только здесь.
    """

    list_display = ("name", "ai_enabled", "ai_daily_limit", "created_at")
    search_fields = ("name", "memberships__user__username")
    inlines = (MembershipInline,)
