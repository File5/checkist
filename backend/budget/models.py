from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q


class BudgetLimit(models.Model):
    """Месячный лимит трат в одной категории верхнего уровня и одной валюте.

    Владелец — ровно один: семья (``household``), если у пользователя она есть, иначе сам
    пользователь (``user``). Лимит семьи видят и правят все её члены. Категория — только
    верхнего уровня (проверяют API и форма админки; БД этого не умеет). Удаление
    категории, семьи или пользователя удаляет и лимит.
    """

    household = models.ForeignKey(
        "accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="budget_limits")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="budget_limits")
    category = models.ForeignKey("catalog.Category", on_delete=models.CASCADE, related_name="budget_limits")
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="budget_limits")
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "budget limit"
        verbose_name_plural = "budget limits"
        constraints = [
            models.CheckConstraint(
                condition=(Q(household__isnull=False, user__isnull=True) | Q(household__isnull=True, user__isnull=False)),
                name="budget_limit_one_owner",
            ),
            models.CheckConstraint(condition=Q(amount__gt=0), name="budget_limit_amount_positive"),
            models.UniqueConstraint(
                fields=["household", "category", "currency"], condition=Q(household__isnull=False),
                name="budget_limit_household_category_currency_uniq",
            ),
            models.UniqueConstraint(
                fields=["user", "category", "currency"], condition=Q(user__isnull=False),
                name="budget_limit_user_category_currency_uniq",
            ),
        ]

    def __str__(self):
        return f"{self.category_id} {self.amount} {self.currency_id}"

    def clean(self):
        errors = {}
        if (self.household_id is None) == (self.user_id is None):
            errors["household"] = "Укажите ровно одного владельца: семью либо пользователя."
        if self.category_id is not None and self.category.parent_id is not None:
            errors["category"] = "Лимит задаётся только категории верхнего уровня."
        if self.amount is not None and self.amount <= Decimal(0):
            errors["amount"] = "Сумма больше нуля."
        if errors:
            raise ValidationError(errors)
