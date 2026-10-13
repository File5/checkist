"""Импорт выписок банка: черновик со строками, правила «получатель → категория» и очередь вопросов модели.

PDF выписки не хранится: у загрузки есть только SHA-256 файла (повтор того же файла —
тот же черновик) и разобранные строки. Траты из строк создаёт ``receipts.manual.create``
на того, кто загрузил выписку; строка помнит созданный чек.
"""
from django.conf import settings
from django.db import models
from django.db.models import Q


class StatementImport(models.Model):
    """Одна загруженная выписка — черновик. Видна и правится только тем, кто её загрузил."""

    class Bank(models.TextChoices):
        KASPI_GOLD = "kaspi_gold", "Kaspi Gold"
        FORTE = "forte", "ForteBank"

    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="statement_imports")
    bank = models.CharField(max_length=16, choices=Bank.choices)
    sha256 = models.CharField(max_length=64)
    date_from = models.DateField(null=True, blank=True)
    date_to = models.DateField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    saved_at = models.DateTimeField(null=True, blank=True)  # последнее «Сохранить N трат»

    class Meta:
        verbose_name = "statement import"
        verbose_name_plural = "statement imports"
        constraints = [
            models.UniqueConstraint(fields=["owner", "sha256"], name="statements_import_owner_sha256_uniq"),
            models.CheckConstraint(condition=Q(bank__in=["kaspi_gold", "forte"]), name="statements_import_bank_check"),
        ]

    def __str__(self):
        return f"{self.pk} {self.bank} {self.date_from}–{self.date_to}"


class StatementRow(models.Model):
    """Строка выписки и решение по ней.

    ``kind`` — что это за движение денег (по банку и правилам): покупка/платёж,
    перевод человеку, снятие наличных, между своими счетами или в семье, поступление,
    возврат покупки того же дня. ``state`` — что с ней делает черновик: трата (отмечена),
    спорная (подсвечена), дубль уже внесённой траты, пропущена. Поступления хранятся для
    будущего учёта доходов и тратами не становятся никогда.

    ``category`` и ``store_name`` — предложение (правило, встроенный образец, MCC либо
    модель); человек меняет их при сохранении, правка учит правило.

    ``goal`` — перевод на свой депозит по правилу «→ цель» (``state = goal``): «Сохранить»
    делает из такой строки взнос в цель (``contribution``), а не трату.
    """

    class Kind(models.TextChoices):
        SPEND = "spend"
        TRANSFER = "transfer"
        CASH = "cash"
        OWN_MOVE = "own_move"
        INCOME = "income"
        REFUND = "refund"

    class State(models.TextChoices):
        SPEND = "spend"
        REVIEW = "review"
        DUPLICATE = "duplicate"
        SKIPPED = "skipped"
        GOAL = "goal"

    class Ai(models.TextChoices):
        NONE = ""
        WAITING = "waiting"
        DONE = "done"
        UNKNOWN = "unknown"
        FAILED = "failed"
        OFF = "off"

    statement = models.ForeignKey(StatementImport, on_delete=models.CASCADE, related_name="rows")
    position = models.PositiveIntegerField()
    date = models.DateField()
    # Со знаком банка: отрицательная — деньги ушли с карты.
    amount = models.DecimalField(max_digits=14, decimal_places=2)
    currency = models.CharField(max_length=3)
    operation = models.CharField(max_length=40)
    details = models.CharField(max_length=300)
    # Получатель или отправитель: по нему ищутся правила и спрашивается модель.
    merchant = models.CharField(max_length=200, blank=True, default="")
    mcc = models.CharField(max_length=4, blank=True, default="")
    # Возвраты того же дня у того же продавца, уже вычтенные из покупки.
    refund = models.DecimalField(max_digits=14, decimal_places=2, default=0)
    kind = models.CharField(max_length=16, choices=Kind.choices)
    state = models.CharField(max_length=16, choices=State.choices)
    reason = models.CharField(max_length=24, blank=True, default="")
    category = models.ForeignKey("catalog.Category", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    store_name = models.CharField(max_length=100, blank=True, default="")
    # Откуда предложение: rule, builtin, mcc, model; пусто — предложения нет.
    source = models.CharField(max_length=16, blank=True, default="")
    ai = models.CharField(max_length=16, choices=Ai.choices, blank=True, default="")
    duplicate_of = models.ForeignKey("receipts.Receipt", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    receipt = models.ForeignKey("receipts.Receipt", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    goal = models.ForeignKey("goals.Goal", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    contribution = models.ForeignKey(
        "goals.Contribution", null=True, blank=True, on_delete=models.SET_NULL, related_name="+")

    class Meta:
        verbose_name = "statement row"
        verbose_name_plural = "statement rows"
        ordering = ["statement", "position"]
        constraints = [
            models.UniqueConstraint(fields=["statement", "position"], name="statements_row_position_uniq"),
            models.CheckConstraint(
                condition=Q(kind__in=["spend", "transfer", "cash", "own_move", "income", "refund"]),
                name="statements_row_kind_check",
            ),
            models.CheckConstraint(
                condition=Q(state__in=["spend", "review", "duplicate", "skipped", "goal"]), name="statements_row_state_check"),
        ]

    def __str__(self):
        return f"{self.date} {self.amount} {self.merchant}"


class StatementRule(models.Model):
    """«Получатель → категория (+ магазин)», «пропускать», «свои счета / семья» либо «→ цель».

    Владелец — как у лимитов (``budget.access``): семья, если она есть, иначе пользователь.
    ``key`` — нормализованный ``pattern`` (``statements.rules.normalize``): правило
    подходит, когда его слова стоят подряд в получателе строки; из нескольких — самое
    длинное. ``origin`` — заведено человеком на экране правил либо выучено по правке
    категории в черновике.

    «→ цель» (``goal``) — перевод на свой депозит как взнос в цель: такое правило личное
    (``user``, даже у члена семьи) и применяется только к его выпискам (``rules.visible_q``).
    """

    class Action(models.TextChoices):
        CATEGORY = "category"
        SKIP = "skip"
        OWN = "own"
        GOAL = "goal"

    class Origin(models.TextChoices):
        MANUAL = "manual"
        LEARNED = "learned"

    household = models.ForeignKey(
        "accounts.Household", null=True, blank=True, on_delete=models.CASCADE, related_name="statement_rules")
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.CASCADE, related_name="statement_rules")
    pattern = models.CharField(max_length=200)
    key = models.CharField(max_length=200)
    action = models.CharField(max_length=16, choices=Action.choices, default=Action.CATEGORY)
    # Категорию правила удалить нельзя, как категорию лимита: уборка категорий её оставит.
    category = models.ForeignKey(
        "catalog.Category", null=True, blank=True, on_delete=models.PROTECT, related_name="statement_rules")
    store_name = models.CharField(max_length=100, blank=True, default="")
    goal = models.ForeignKey("goals.Goal", null=True, blank=True, on_delete=models.CASCADE, related_name="statement_rules")
    origin = models.CharField(max_length=16, choices=Origin.choices, default=Origin.MANUAL)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL, related_name="+")
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "statement rule"
        verbose_name_plural = "statement rules"
        constraints = [
            models.CheckConstraint(
                condition=(Q(household__isnull=False, user__isnull=True) | Q(household__isnull=True, user__isnull=False)),
                name="statements_rule_one_owner",
            ),
            models.CheckConstraint(
                condition=(Q(action="category", category__isnull=False)
                           | Q(action__in=["skip", "own", "goal"], category__isnull=True)),
                name="statements_rule_category_action",
            ),
            models.CheckConstraint(
                condition=(Q(action="goal", goal__isnull=False) | Q(action__in=["category", "skip", "own"], goal__isnull=True)),
                name="statements_rule_goal_action",
            ),
            models.CheckConstraint(condition=~Q(key=""), name="statements_rule_key_not_blank"),
            models.UniqueConstraint(fields=["household", "key"], condition=Q(household__isnull=False),
                                    name="statements_rule_household_key_uniq"),
            models.UniqueConstraint(fields=["user", "key"], condition=Q(user__isnull=False),
                                    name="statements_rule_user_key_uniq"),
        ]

    def __str__(self):
        return f"{self.pattern} → {self.action}"


class StatementAsk(models.Model):
    """Вопрос модели о незнакомых получателях одного черновика; очередь ``recognition_worker``.

    Переходы как у «Траты словами» (``statements.ask``): ``queued → running`` (``claim``),
    ``running → succeeded | failed`` (``execute``, сверка по ``run_token``), ``running →
    failed / worker_lost`` (истёкшая lease), ``queued → failed / expired`` (ждал дольше
    ``QUEUE_TTL``). Сбой модели черновик не ломает: строки остаются спорными.
    """

    class Status(models.TextChoices):
        QUEUED = "queued"
        RUNNING = "running"
        SUCCEEDED = "succeeded"
        FAILED = "failed"

    statement = models.ForeignKey(StatementImport, on_delete=models.CASCADE, related_name="asks")
    merchants = models.JSONField(default=list)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.QUEUED)
    error_code = models.CharField(max_length=32, blank=True, default="")
    run_token = models.UUIDField(null=True, blank=True)
    lease_expires_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    started_at = models.DateTimeField(null=True, blank=True)
    finished_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        verbose_name = "statement ask"
        verbose_name_plural = "statement asks"
        indexes = [models.Index(fields=["status", "id"], name="statements_ask_status_idx")]
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=["queued", "running", "succeeded", "failed"]), name="statements_ask_status_check"),
        ]

    def __str__(self):
        return f"{self.pk} {self.status}"
