"""Цели накоплений и взносы в них.

Общая цель принадлежит семье (``household``) — её видят и правят все члены; личная —
пользователю (``user``): её видят только он и главный его семьи. Правило — только
``goals.access.goals_q``. Накоплено — сумма взносов в валюте цели по курсу дня взноса
(``goals.services``); сама сумма не хранится. Цель-депозит (``kind``) ещё и приносит проценты по ставке
``rate`` — расчёт в ``goals.forecast``; сверка с банком — запись ``Contribution.Kind.INTEREST``.
"""
from django.conf import settings
from django.db import models
from django.db.models import Q


class Goal(models.Model):
    class Kind(models.TextChoices):
        SAVING = "saving", "Копилка"
        DEPOSIT = "deposit", "Депозит"

    class Capitalization(models.TextChoices):
        MONTHLY = "monthly", "Ежемесячно"
        NONE = "none", "Без капитализации"

    household = models.ForeignKey(
        "accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="goals")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="goals")
    name = models.CharField(max_length=100)
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="goals")
    deadline = models.DateField(null=True, blank=True)
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.SAVING)
    # % годовых депозита; у копилки не читается (ставка 0).
    rate = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    capitalization = models.CharField(max_length=8, choices=Capitalization.choices, default=Capitalization.MONTHLY)
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
            models.CheckConstraint(condition=Q(rate__isnull=True) | Q(rate__gte=0, rate__lte=100), name="goals_goal_rate_range"),
        ]

    def __str__(self):
        return self.name


class Contribution(models.Model):
    """Взнос: сколько, в какой валюте, когда и кто отложил. Из выписки — ``statements.StatementRow.contribution``.

    ``kind=interest`` — не взнос, а «проценты»: разница сверки депозита с банком, в валюте цели, может быть
    отрицательной; в темп «откладываете» и во вклад людей не входит.
    """

    class Kind(models.TextChoices):
        DEPOSIT = "deposit", "Взнос"
        INTEREST = "interest", "Проценты"

    goal = models.ForeignKey(Goal, on_delete=models.CASCADE, related_name="contributions")
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="+")
    date = models.DateField()
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    note = models.CharField(max_length=200, blank=True, default="")
    kind = models.CharField(max_length=8, choices=Kind.choices, default=Kind.DEPOSIT)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "goal contribution"
        verbose_name_plural = "goal contributions"
        indexes = [models.Index(fields=["goal", "date"], name="goals_contribution_goal_date")]
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0) | Q(kind="interest"), name="goals_contribution_amount_positive")]

    def __str__(self):
        return f"{self.goal_id} {self.date} {self.amount}"
