"""Цели накоплений и взносы в них.

Общая цель принадлежит семье (``household``) — её видят и правят все члены; личная —
пользователю (``user``): её видят только он и главный его семьи. Правило — только
``goals.access.goals_q``. Накоплено — сумма взносов в валюте цели по курсу дня взноса
(``goals.services``); сама сумма не хранится.
"""
from django.conf import settings
from django.db import models
from django.db.models import Q


class Goal(models.Model):
    household = models.ForeignKey(
        "accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="goals")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="goals")
    name = models.CharField(max_length=100)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="goals")
    deadline = models.DateField(null=True, blank=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "goal"
        verbose_name_plural = "goals"
        constraints = [
            models.CheckConstraint(
                condition=Q(household__isnull=False, user__isnull=True) | Q(household__isnull=True, user__isnull=False),
                name="goals_goal_one_owner"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="goals_goal_amount_positive"),
        ]

    def __str__(self):
        return self.name


class Contribution(models.Model):
    """Взнос: сколько, в какой валюте, когда и кто отложил. Из выписки — ``statements.StatementRow.contribution``."""

    goal = models.ForeignKey(Goal, on_delete=models.CASCADE, related_name="contributions")
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="+")
    date = models.DateField()
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    note = models.CharField(max_length=200, blank=True, default="")
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "goal contribution"
        verbose_name_plural = "goal contributions"
        indexes = [models.Index(fields=["goal", "date"], name="goals_contribution_goal_date")]
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="goals_contribution_amount_positive")]

    def __str__(self):
        return f"{self.goal_id} {self.date} {self.amount}"
