from django.conf import settings
from django.db import models
from django.db.models import F, Q

from catalog.units import Unit


class Receipt(models.Model):
    class Operation(models.TextChoices):
        SALE = "sale", "Продажа"
        REFUND = "refund", "Возврат"

    class Source(models.TextChoices):
        PHOTO = "photo", "Фото чека"
        MANUAL = "manual", "Вручную"

    class PaymentMethod(models.TextChoices):
        NONE = "", "Не указан"
        KASPI_GOLD = "kaspi_gold", "Kaspi Gold"
        FORTE = "forte", "ForteBank"
        CASH = "cash", "Наличные"
        CARD = "card", "Другая карта"

    # Значения по умолчанию нет: забытый владелец — ошибка, а не тихий local.
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="receipts")
    # NULL — «Без места»: бывает только у траты, внесённой вручную.
    store = models.ForeignKey("stores.Store", null=True, blank=True, on_delete=models.PROTECT, related_name="receipts")
    # manual — трата без чека (receipts.manual): к ней не применяются три правила дедупликации.
    source = models.CharField(max_length=8, choices=Source.choices, default=Source.PHOTO)
    currency = models.ForeignKey("stores.Currency", on_delete=models.PROTECT, related_name="receipts")
    operation = models.CharField(max_length=8, choices=Operation.choices)
    purchased_at = models.DateTimeField()  # момент покупки, хранится в UTC
    purchased_on = models.DateField()  # локальная дата, как напечатана на чеке
    # Смена и касса — отдельные поля: они участвуют в ключе дубликатов.
    receipt_number = models.CharField(max_length=64, blank=True, default="")
    shift_number = models.CharField(max_length=16, blank=True, default="")
    register_code = models.CharField(max_length=64, blank=True, default="")
    # Канонический фискальный идентификатор, собирает receipts.dedup.build_fiscal_key.
    fiscal_key = models.CharField(max_length=160, blank=True, default="")
    fiscal = models.JSONField(default=dict, blank=True)  # реквизиты, ключи зависят от страны
    # Может быть отрицательной: возврат тары больше покупки.
    total = models.DecimalField(max_digits=14, decimal_places=2)
    discount_total = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    prices_include_tax = models.BooleanField(default=True)
    raw_text = models.TextField(blank=True, default="")
    extra = models.JSONField(default=dict, blank=True)  # кассир, способ оплаты, реклама
    note = models.TextField(blank=True, default="")  # комментарий человека к трате
    # Чем заплачено (2026-10-13): форма траты, разбор словами, импорт выписки, «Оплатил» регулярного платежа.
    payment_method = models.CharField(max_length=16, choices=PaymentMethod.choices, blank=True, default="")
    # Скрытый платёж (решает главный в семье): не виден остальным и не входит ни в какие суммы.
    hidden = models.BooleanField(default=False)
    hidden_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL,
                                  related_name="+")
    hidden_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [
            # Три уровня дедупликации, каждый в пределах владельца и только у чеков с фото:
            # две одинаковые ручные траты за день — две траты. Между уровнями ищет
            # receipts.dedup.find_duplicates.
            models.UniqueConstraint(
                fields=["owner", "fiscal_key"],
                condition=~Q(fiscal_key="") & Q(source="photo"),
                name="receipts_receipt_owner_fiscal_key_uniq",
            ),
            models.UniqueConstraint(
                fields=["owner", "store", "purchased_on", "shift_number", "register_code", "receipt_number"],
                condition=~Q(receipt_number="") & Q(source="photo"),
                name="receipts_receipt_owner_store_number_uniq",
            ),
            models.UniqueConstraint(
                fields=["owner", "store", "purchased_at", "total"],
                condition=Q(receipt_number="", fiscal_key="", source="photo"),
                name="receipts_receipt_owner_store_time_total_uniq",
            ),
        ]
        indexes = [
            models.Index(fields=["store", "purchased_at"], name="receipts_rcpt_store_at_idx"),
            models.Index(fields=["owner", "purchased_on"], name="receipts_rcpt_owner_on_idx"),
        ]

    def __str__(self):
        return f"{self.store_id} {self.purchased_on} {self.receipt_number or self.fiscal_key}".rstrip()


class ReceiptLine(models.Model):
    """Позиция чека. Скидка строкой не является — она в ReceiptDiscount."""

    class Kind(models.TextChoices):
        PRODUCT = "product", "Товар"
        SERVICE = "service", "Услуга"
        DEPOSIT = "deposit", "Залог"
        DEPOSIT_RETURN = "deposit_return", "Возврат тары"

    receipt = models.ForeignKey(Receipt, on_delete=models.CASCADE, related_name="lines")
    position = models.PositiveSmallIntegerField()  # порядок на чеке, с 1
    kind = models.CharField(max_length=16, choices=Kind.choices)
    # Только для deposit: товар, к которому относится залог.
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.CASCADE, related_name="children",
    )
    raw_name = models.TextField()  # название как на чеке
    name_i18n = models.JSONField(default=dict, blank=True)  # {"kk": "...", "ru": "..."}
    store_item_code = models.CharField(max_length=64, blank=True, default="")
    barcode = models.CharField(max_length=32, blank=True, default="")
    quantity = models.DecimalField(max_digits=12, decimal_places=3)
    unit = models.CharField(max_length=8, choices=Unit.choices, default=Unit.PCS)
    unit_price = models.DecimalField(max_digits=14, decimal_places=4)  # до скидки
    amount = models.DecimalField(max_digits=14, decimal_places=2)  # до скидки, со знаком
    discount_amount = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    tax_rate = models.ForeignKey(
        "stores.TaxRate", null=True, blank=True, on_delete=models.PROTECT, related_name="receipt_lines",
    )
    tax_code = models.CharField(max_length=8, blank=True, default="")  # буква класса как на чеке
    tax_amount = models.DecimalField(max_digits=14, decimal_places=2, null=True, blank=True)
    is_excise = models.BooleanField(default=False)
    is_marked = models.BooleanField(default=False)
    # Пусто, пока товар не сопоставлен.
    product = models.ForeignKey(
        "catalog.Product", null=True, blank=True, on_delete=models.SET_NULL, related_name="receipt_lines",
    )
    # Категория строки траты вручную (и обслуживания/чаевых без товара); важнее категории товара:
    # названная покупка траты вручную — товар каталога, но лежит в категории, выбранной человеком.
    category = models.ForeignKey(
        "catalog.Category", null=True, blank=True, on_delete=models.PROTECT, related_name="receipt_lines",
    )
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["receipt", "position"],
                name="receipts_receiptline_receipt_position_uniq",
            ),
            models.CheckConstraint(
                condition=Q(unit_price__gte=0),
                name="receipts_receiptline_unit_price_nonnegative",
            ),
            models.CheckConstraint(
                condition=Q(discount_amount__gte=0),
                name="receipts_receiptline_discount_amount_nonnegative",
            ),
            models.CheckConstraint(
                condition=~Q(quantity=0),
                name="receipts_receiptline_quantity_nonzero",
            ),
            # quantity * amount >= 0, записано без умножения.
            models.CheckConstraint(
                condition=Q(quantity__gte=0, amount__gte=0) | Q(quantity__lte=0, amount__lte=0),
                name="receipts_receiptline_quantity_amount_same_sign",
            ),
            models.CheckConstraint(
                condition=~Q(kind="deposit_return") | Q(amount__lte=0),
                name="receipts_receiptline_deposit_return_not_positive",
            ),
            models.CheckConstraint(
                condition=Q(parent__isnull=True) | Q(kind="deposit"),
                name="receipts_receiptline_parent_only_for_deposit",
            ),
        ]
        indexes = [
            models.Index(fields=["product", "receipt"], name="receipts_line_prod_rcpt_idx"),
            models.Index(fields=["store_item_code"], name="receipts_line_item_code_idx"),
        ]

    def __str__(self):
        return self.raw_name


class ReceiptDiscount(models.Model):
    receipt = models.ForeignKey(Receipt, on_delete=models.CASCADE, related_name="discounts")
    # NULL — скидка на весь чек.
    line = models.ForeignKey(
        ReceiptLine, null=True, blank=True, on_delete=models.CASCADE, related_name="discounts",
    )
    position = models.PositiveSmallIntegerField()  # порядок среди скидок чека
    name = models.CharField(max_length=255)  # как на чеке
    amount = models.DecimalField(max_digits=14, decimal_places=2)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["receipt", "position"],
                name="receipts_receiptdiscount_receipt_position_uniq",
            ),
            models.CheckConstraint(
                condition=Q(amount__gt=0),
                name="receipts_receiptdiscount_amount_positive",
            ),
        ]

    def __str__(self):
        return self.name


class ReceiptTax(models.Model):
    """Итог по ставке на чек."""

    receipt = models.ForeignKey(Receipt, on_delete=models.CASCADE, related_name="taxes")
    tax_rate = models.ForeignKey("stores.TaxRate", on_delete=models.PROTECT, related_name="receipt_taxes")
    tax_code = models.CharField(max_length=8, blank=True, default="")
    # Если на чеке напечатаны не все три числа, недостающее считает приложение.
    net = models.DecimalField(max_digits=14, decimal_places=2)
    tax = models.DecimalField(max_digits=14, decimal_places=2)  # 0 для «без НДС»
    gross = models.DecimalField(max_digits=14, decimal_places=2)

    class Meta:
        verbose_name_plural = "receipt taxes"
        constraints = [
            models.UniqueConstraint(
                fields=["receipt", "tax_rate"],
                name="receipts_receipttax_receipt_tax_rate_uniq",
            ),
            models.CheckConstraint(
                condition=Q(gross=F("net") + F("tax")),
                name="receipts_receipttax_net_plus_tax_eq_gross",
            ),
        ]

    def __str__(self):
        return f"{self.receipt_id} {self.tax_code or self.tax_rate_id}"


class ProductAlias(models.Model):
    """Сопоставление «название на чеке у продавца → товар». Ищет receipts.dedup.find_alias."""

    merchant = models.ForeignKey("stores.Merchant", on_delete=models.CASCADE, related_name="product_aliases")
    product = models.ForeignKey("catalog.Product", on_delete=models.CASCADE, related_name="aliases")
    name_key = models.CharField(max_length=255)  # receipts.dedup.name_key(raw_name)
    store_item_code = models.CharField(max_length=64, blank=True, default="")
    raw_name = models.TextField()  # образец исходного названия

    class Meta:
        verbose_name_plural = "product aliases"
        constraints = [
            models.UniqueConstraint(
                fields=["merchant", "name_key", "store_item_code"],
                name="receipts_productalias_merchant_name_code_uniq",
            ),
        ]

    def __str__(self):
        return self.raw_name


class ManualParseRequest(models.Model):
    """«Трата словами»: текст человека ждёт воркера, ответ — черновик формы траты.

    Строка ничего не меняет в чеках и каталоге: черновик человек проверяет и сохраняет
    обычной ручной тратой. Очередь и исполнение — ``receipts.manual_parse``.
    """

    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        SUCCEEDED = "succeeded"
        FAILED = "failed"

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="manual_parse_requests")
    text = models.CharField(max_length=500)
    # «Сегодня» для относительных дат текста: дата клиента либо сервера.
    today = models.DateField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    draft = models.JSONField(null=True, blank=True)
    error_code = models.CharField(max_length=32, blank=True, default="")
    run_token = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [
            models.Index(fields=["status", "id"], name="receipts_parse_status_idx"),
            models.Index(fields=["owner", "created_at"], name="receipts_parse_owner_idx"),
        ]
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=["queued", "running", "succeeded", "failed"]),
                name="receipts_parse_status_check",
            ),
        ]

    def __str__(self):
        return f"{self.pk} {self.status}"
