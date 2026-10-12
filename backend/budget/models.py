from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q


class BudgetLimit(models.Model):
    """Месячный лимит трат в одной категории (любого уровня) и одной валюте.

    Владелец — ровно один: семья (``household``), если у пользователя она есть, иначе сам
    пользователь (``user``). Лимит семьи видят и правят все её члены. Категория — любого
    уровня: трата подкатегории входит и в её лимит, и в лимит предков. Удаление
    семьи или пользователя удаляет и лимит; категорию с лимитом удалить нельзя (PROTECT) —
    уборка созданных категорий в ``classification`` по отказу удаления оставляет её.
    """

    household = models.ForeignKey(
        "accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="budget_limits")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="budget_limits")
    category = models.ForeignKey("catalog.Category", on_delete=models.PROTECT, related_name="budget_limits")
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
        if self.amount is not None and self.amount <= Decimal(0):
            errors["amount"] = "Сумма больше нуля."
        if errors:
            raise ValidationError(errors)


class BudgetLimitChange(models.Model):
    """Запись журнала лимитов: создание, смена суммы или удаление лимита одной категории и валюты.

    Владелец — как у ``BudgetLimit`` (семья либо пользователь). ``old_amount`` пуст у
    создания, ``new_amount`` — у удаления. ``effective_month`` — первое число месяца
    изменения (локальная дата): сумма лимита в месяце — ``new_amount`` последней записи с
    ``effective_month`` не позже этого месяца (``budget.history``). Пишет только
    ``budget.history`` в одной транзакции с самим лимитом — API и админка. Перенос лимита
    на другую категорию, валюту или владельца — две записи: удаление и создание.
    """

    household = models.ForeignKey(
        "accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="budget_limit_changes")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="budget_limit_changes")
    category = models.ForeignKey("catalog.Category", on_delete=models.CASCADE, related_name="budget_limit_changes")
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="budget_limit_changes")
    old_amount = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    new_amount = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    changed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    changed_at = models.DateTimeField()
    effective_month = models.DateField()

    class Meta:
        verbose_name = "budget limit change"
        verbose_name_plural = "budget limit changes"
        indexes = [models.Index(fields=["category", "currency", "effective_month"], name="budget_change_key_month")]
        constraints = [
            models.CheckConstraint(
                condition=(Q(household__isnull=False, user__isnull=True) | Q(household__isnull=True, user__isnull=False)),
                name="budget_limit_change_one_owner",
            ),
            models.CheckConstraint(
                condition=Q(old_amount__isnull=False) | Q(new_amount__isnull=False),
                name="budget_limit_change_not_empty",
            ),
            models.CheckConstraint(condition=Q(effective_month__day=1), name="budget_limit_change_month_start"),
        ]

    def __str__(self):
        return f"{self.category_id} {self.currency_id}: {self.old_amount} -> {self.new_amount}"
