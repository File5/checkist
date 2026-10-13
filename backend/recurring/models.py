from django.conf import settings
from django.db import models
from django.db.models import Q

OWNER_CONSTRAINT = Q(household__isnull=False, user__isnull=True) | Q(household__isnull=True, user__isnull=False)


class RecurringPayment(models.Model):
    """Регулярный платёж: аренда, коммунальные, ОСИ, интернет, подписка — раз в месяц.

    Владелец — как у лимита (``budget.BudgetLimit``): семья, если у пользователя она есть,
    иначе сам пользователь; платежи семьи видят и правят все её члены. Оплачен ли платёж в
    месяце, не хранится: это сверка с тратами при чтении (``recurring.matching``). Магазин
    необязателен: без него платёж узнаётся по категории и сумме. Удаление магазина оставляет
    платёж без магазина; категорию с платежом удалить нельзя (PROTECT), как у лимита.
    """

    household = models.ForeignKey(
        "accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="recurring_payments")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="recurring_payments")
    name = models.CharField(max_length=100)
    # Без обратной связи у магазина: у Store нет полей «оплаты» (receipts.tests.test_samples).
    store = models.ForeignKey("stores.Store", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    category = models.ForeignKey("catalog.Category", on_delete=models.PROTECT, related_name="recurring_payments")
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="recurring_payments")
    amount = models.DecimalField(max_digits=14, decimal_places=2)  # ожидаемая сумма
    due_day = models.PositiveSmallIntegerField()  # число месяца; 31 в коротком месяце — его последний день
    active = models.BooleanField(default=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "recurring payment"
        verbose_name_plural = "recurring payments"
        constraints = [
            models.CheckConstraint(condition=OWNER_CONSTRAINT, name="recurring_payment_one_owner"),
            models.CheckConstraint(condition=Q(amount__gt=0), name="recurring_payment_amount_positive"),
            models.CheckConstraint(condition=Q(due_day__gte=1, due_day__lte=31), name="recurring_payment_due_day_range"),
        ]

    def __str__(self):
        return self.name


class RecurringDecision(models.Model):
    """Ответ человека на вопрос «платёж за месяц не найден»: добавить по средней, не было, оплачено иначе.

    Один ответ на платёж и месяц (``month`` — первое число). ``receipt`` — трата, созданная
    ответом «добавить по средней»; связь без ограничения БД и без обратной связи у чека:
    удаление чека её не трогает, а удалённая трата снова открывает вопрос
    (``recurring.services``).
    """

    class Decision(models.TextChoices):
        ADDED = "added", "Добавлено по средней"
        SKIPPED = "skipped", "Не было"
        ELSEWHERE = "elsewhere", "Оплачено иначе"

    payment = models.ForeignKey(RecurringPayment, on_delete=models.CASCADE, related_name="decisions")
    month = models.DateField()
    decision = models.CharField(max_length=16, choices=Decision.choices)
    receipt = models.ForeignKey(
        "receipts.Receipt", null=True, blank=True, on_delete=models.DO_NOTHING, db_constraint=False, related_name="+")
    decided_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    decided_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "recurring decision"
        verbose_name_plural = "recurring decisions"
        constraints = [
            models.UniqueConstraint(fields=["payment", "month"], name="recurring_decision_payment_month_uniq"),
            models.CheckConstraint(condition=Q(month__day=1), name="recurring_decision_month_start"),
        ]

    def __str__(self):
        return f"{self.payment_id} {self.month:%Y-%m}: {self.decision}"


class DismissedSuggestion(models.Model):
    """Предложение «похоже на регулярный платёж», которое человек скрыл: больше не предлагается.

    Ключ предложения — магазин, категория и валюта; владелец — как у платежа.
    """

    household = models.ForeignKey(
        "accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="+")
    store = models.ForeignKey("stores.Store", on_delete=models.CASCADE, related_name="+")
    category = models.ForeignKey("catalog.Category", on_delete=models.CASCADE, related_name="+")
    currency = models.ForeignKey("stores.Currency", on_delete=models.CASCADE, related_name="+")
    dismissed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    dismissed_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        verbose_name = "dismissed recurring suggestion"
        verbose_name_plural = "dismissed recurring suggestions"
        constraints = [
            models.CheckConstraint(condition=OWNER_CONSTRAINT, name="recurring_dismissed_one_owner"),
            models.UniqueConstraint(
                fields=["household", "store", "category", "currency"], condition=Q(household__isnull=False),
                name="recurring_dismissed_household_key_uniq"),
            models.UniqueConstraint(
                fields=["user", "store", "category", "currency"], condition=Q(user__isnull=False),
                name="recurring_dismissed_user_key_uniq"),
        ]

    def __str__(self):
        return f"{self.store_id} {self.category_id} {self.currency_id}"
