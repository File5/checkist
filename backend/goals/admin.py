from django.contrib import admin

from .models import Contribution, Goal


class ContributionInline(admin.TabularInline):
    model = Contribution
    extra = 0
    raw_id_fields = ("user", "created_by")


@admin.register(Goal)
class GoalAdmin(admin.ModelAdmin):
    """Цели накоплений; обычно их правят на экране «Цели», админка — запасной путь."""

    list_display = ("name", "amount", "currency", "deadline", "household", "user")
    list_filter = ("currency",)
    search_fields = ("name", "household__name", "user__username")
    raw_id_fields = ("user", "created_by")
    inlines = [ContributionInline]
