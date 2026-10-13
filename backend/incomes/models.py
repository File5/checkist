from django.conf import settings
from django.db import models
from django.db.models import Q

# Встроенный список в порядке показа; заводит миграция ``0001_initial``.
BUILT_IN = ("Зарплата", "Подработка", "Подарки", "Кэшбэк и проценты", "Продажа вещей", "Прочее")


class IncomeCategory(models.Model):
    """Категория дохода: свой короткий список, в дерево категорий трат не входит.

    Встроенные (``household`` и ``user`` пусты) видят все. Свои — владелец как у лимита
    (``budget.access.limit_owner``): семья, если она есть у пользователя, иначе он сам.
    """

    household = models.ForeignKey("accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    name = models.CharField(max_length=60)

    class Meta:
        verbose_name = "income category"
        verbose_name_plural = "income categories"
        constraints = [
            models.CheckConstraint(condition=Q(household__isnull=True) | Q(user__isnull=True),
                                   name="income_category_one_owner"),
        ]

    def __str__(self):
        return self.name


class Income(models.Model):
    """Доход, внесённый человеком вручную (из выписок доходы не берутся).

    ``owner`` — кто внёс. Запись видят автор и главный в семье (``incomes.access.visible_q``),
    остальные члены семьи — только общий доход семьи за месяц (``incomes.services``).
    """

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="incomes")
    received_on = models.DateField()
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="+")
    category = models.ForeignKey(IncomeCategory, on_delete=models.PROTECT, related_name="incomes")
    note = models.TextField(blank=True, default="")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "income"
        verbose_name_plural = "incomes"
        indexes = [models.Index(fields=["owner", "received_on"], name="income_owner_day_idx")]
        constraints = [models.CheckConstraint(condition=Q(amount__gt=0), name="income_amount_positive")]

    def __str__(self):
        return f"{self.received_on} {self.amount} {self.currency_id}"
