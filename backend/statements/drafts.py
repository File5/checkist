"""Черновик выписки: решение по каждой строке, возвраты того же дня, дубли и сохранение трат.

Решение строки (``classify``): правило человека или семьи важнее всего; без правила
поступление (деньги пришли) и снятие наличных пропускаются, перевод человеку — тоже
(между своими счетами — отдельным видом), покупка получает категорию встроенного образца
или кода MCC, а незнакомый получатель становится спорным и уходит модели (``statements.ask``).
Возврат того же дня у того же продавца уменьшает покупку (``net_refunds``). Трата, которая
уже внесена у владельца (та же сумма в пределах суток либо квитанция за жильё), снимается
с отметки с причиной (``mark_duplicates``).

Траты создаёт только ``receipts.manual.create`` — на того, кто загрузил выписку; комментарий
кончается « · Выписка Kaspi Gold» / « · Выписка ForteBank» (по нему выгрузка и «Траты»
узнают трату из выписки).

Перевод или движение между своими счетами, подходящее под личное правило «→ цель», — строка
``goal``: «Сохранить» делает из неё взнос в цель (``goals.Contribution``) на того же человека, а
не трату; взнос, который у цели уже есть (та же сумма и валюта ±1 день), — дубль
(``mark_goal_duplicates``). Строка помнит взнос: повтор сохранения его не задваивает.
"""
import hashlib
import math
from collections import defaultdict
from datetime import timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone

from catalog.models import Category
from goals.models import Contribution, Goal
from receipts import manual
from receipts.models import Receipt, ReceiptLine

from . import ask, defaults, parsers
from .extract import StatementError, pdf_text
from .models import StatementImport, StatementRow, StatementRule
from .rules import RuleBook, learn, normalize, remember_goal

Kind, State = StatementRow.Kind, StatementRow.State
MAX_ROWS = parsers.MAX_ROWS
DUPLICATE_DAYS = 1
BILL_DAYS = 10
# Квитанции: перевод за жильё сверяется с уже внесённой квитанцией той же корневой категории
# в пределах BILL_DAYS дней и рубля округления (как в первом импорте Kaspi).
BILL_ROOTS = ("Жильё",)
SOURCE_NOTE = {parsers.KASPI: "Выписка Kaspi Gold", parsers.FORTE: "Выписка ForteBank"}
SAVE_FIELDS = ("id", "category", "store_name", "goal")
GOAL_KINDS = (StatementRow.Kind.TRANSFER, StatementRow.Kind.OWN_MOVE)


class SaveInvalid(Exception):
    """Тело сохранения не подошло: ``fields`` — ``{"rows.0.category": "причина"}``."""

    def __init__(self, fields):
        super().__init__("statement save invalid")
        self.fields = fields


class Categories:
    """Дерево категорий одним запросом: путь имён → id и корень категории."""

    def __init__(self):
        rows = list(Category.objects.values_list("pk", "name", "parent_id"))
        self.parent = {pk: parent for pk, _name, parent in rows}
        self.child = {(parent, name.casefold()): pk for pk, name, parent in rows}

    def resolve(self, path):
        node = None
        for name in path:
            node = self.child.get((node, name.casefold()))
            if node is None:
                return None
        return node

    def root(self, pk):
        seen = set()
        while pk is not None and pk not in seen:
            seen.add(pk)
            parent = self.parent.get(pk)
            if parent is None:
                return pk
            pk = parent
        return pk

    def root_names(self, names):
        return {pk for name in names if (pk := self.resolve((name,))) is not None}


# --- приём файла ---

def accept(owner, data, *, rule_scope):
    """PDF ``data`` → ``(черновик, создан ли)``. Тот же файл у того же человека — прежний черновик."""
    digest = hashlib.sha256(data).hexdigest()
    existing = StatementImport.objects.filter(owner=owner, sha256=digest).first()
    if existing is not None:
        return existing, False
    return import_text(owner, pdf_text(data), sha256=digest, rule_scope=rule_scope)


def import_text(owner, text, *, sha256, rule_scope):
    """Текст выписки → новый черновик со строками; ``StatementError`` — банк не тот или операций нет."""
    try:
        bank, parsed = parsers.parse(text)
    except parsers.UnsupportedBank:
        raise StatementError("statement_unsupported_bank") from None
    except parsers.TooLarge:
        raise StatementError("statement_too_large") from None
    if not parsed:
        raise StatementError("statement_empty")
    categories = Categories()
    rows = classify(parsed, RuleBook.load(rule_scope), categories)
    try:
        with transaction.atomic():
            statement = StatementImport.objects.create(
                owner=owner, bank=bank, sha256=sha256,
                date_from=min(row.date for row in rows), date_to=max(row.date for row in rows))
            mark_duplicates(owner, rows, categories)
            mark_goal_duplicates(rows)
            for row in rows:
                row.statement = statement
            waiting = [row for row in rows if row.state == State.REVIEW]
            allowed = bool(waiting) and ask._ai_allowed(owner)
            for row in waiting:
                row.ai = StatementRow.Ai.WAITING if allowed else StatementRow.Ai.OFF
            StatementRow.objects.bulk_create(rows)
            if allowed:
                ask.request(statement, sorted({row.merchant for row in waiting}))
    except IntegrityError:
        # Тот же файл в ту же секунду принял соседний запрос: его черновик и есть ответ.
        existing = StatementImport.objects.filter(owner=owner, sha256=sha256).first()
        if existing is None:
            raise
        return existing, False
    return statement, True


# --- решение по строкам ---

def classify(parsed, book, categories):
    """Несохранённые ``StatementRow`` с видом, состоянием и предложением; возвраты уже учтены."""
    rows = []
    for position, item in enumerate(parsed, start=1):
        row = StatementRow(
            position=position, date=item.date, amount=item.amount, currency=item.currency,
            operation=item.operation, details=item.details, mcc=item.mcc,
            merchant=(item.merchant or item.details or item.operation)[:200],
        )
        row._payment_id = item.payment_id
        decide(row, book.match(row.merchant), categories)
        rows.append(row)
    net_refunds(rows)
    return rows


def _skip(row, kind, reason):
    row.kind, row.state, row.reason = kind, State.SKIPPED, reason


def goal_kind(row):
    """Вид строки, которую правило «→ цель» делает взносом: перевод либо движение между своими; иначе ``None``."""
    if row.amount >= 0 or not defaults.TRANSFER_OPERATIONS.match(row.operation):
        return None
    return Kind.OWN_MOVE if defaults.OWN_MOVE.search(f"{row.merchant} {row.details}") else Kind.TRANSFER


def as_goal(row, goal_id):
    row.state, row.reason, row.source, row.goal_id = State.GOAL, "", "rule", goal_id
    row.category_id, row.store_name, row.duplicate_of_id = None, "", None


def decide(row, rule, categories):
    """Вид и состояние одной строки по правилу, операции банка, образцам и MCC."""
    operation, text = row.operation, f"{row.merchant} {row.details}"
    if rule is not None and rule.action == StatementRule.Action.GOAL:
        # «→ цель» — только переводу и движению между своими; покупку у того же получателя решают как без правила.
        kind = goal_kind(row)
        if kind is not None:
            row.kind = kind
            as_goal(row, rule.goal_id)
            return
        rule = None
    own_rule = rule is not None and rule.action == StatementRule.Action.OWN
    if row.amount > 0:
        # Деньги пришли: правило решает только «свои счета / семья», категория поступлению не нужна.
        row.source = "rule" if own_rule else ""
        if own_rule or defaults.OWN_MOVE.search(text):
            _skip(row, Kind.OWN_MOVE, "own_move")
        elif defaults.REFUND_OPERATIONS.match(operation):
            _skip(row, Kind.REFUND, "refund")  # без покупки того же дня станет поступлением (net_refunds)
        else:
            _skip(row, Kind.INCOME, "income")
        return
    transfer = bool(defaults.TRANSFER_OPERATIONS.match(operation))
    cash = bool(defaults.CASH_OPERATIONS.match(operation))
    if rule is not None:
        row.source = "rule"
        if own_rule:
            _skip(row, Kind.OWN_MOVE, "own_move")
        elif rule.action == StatementRule.Action.SKIP:
            _skip(row, Kind.TRANSFER if transfer else Kind.CASH if cash else Kind.SPEND, "rule")
        else:
            row.kind = Kind.TRANSFER if transfer else Kind.CASH if cash else Kind.SPEND
            row.state, row.category_id = State.SPEND, rule.category_id
            row.store_name = rule.store_name or ("" if transfer else defaults.place_for(row.merchant))
        return
    row.source = ""
    if cash:
        _skip(row, Kind.CASH, "cash")
        return
    if transfer:
        if defaults.OWN_MOVE.search(text):
            _skip(row, Kind.OWN_MOVE, "own_move")
        else:
            _skip(row, Kind.TRANSFER, "transfer")
        return
    row.kind = Kind.SPEND
    search = f"{text} {operation}"
    for pattern, path, place in defaults.BUILTIN:
        if pattern.search(search) and (category := categories.resolve(path)) is not None:
            row.state, row.category_id, row.source = State.SPEND, category, "builtin"
            row.store_name = defaults.place_for(row.merchant) if place is None else place
            return
    if row.mcc in defaults.MCC and (category := categories.resolve(defaults.MCC[row.mcc])) is not None:
        row.state, row.category_id, row.source = State.SPEND, category, "mcc"
        row.store_name = defaults.place_for(row.merchant)
        return
    row.state, row.store_name = State.REVIEW, defaults.place_for(row.merchant)


def _same_merchant(purchase, refund):
    if getattr(purchase, "_payment_id", "") and purchase._payment_id == getattr(refund, "_payment_id", ""):
        return True
    a, b = normalize(purchase.merchant), normalize(refund.merchant)
    return bool(a and b) and (a == b or f" {a} " in f" {b} " or f" {b} " in f" {a} ")


def spend_amount(row):
    """Сколько потрачено по строке: сумма банка без возвратов того же дня; у поступления — 0."""
    return max(-row.amount - row.refund, Decimal("0.00")) if row.amount < 0 else Decimal("0.00")


def net_refunds(rows):
    """Возврат того же дня у того же продавца вычитается из покупки; без покупки — это поступление."""
    purchases = [row for row in rows if row.amount < 0 and row.kind == Kind.SPEND]
    for refund in rows:
        if refund.kind != Kind.REFUND:
            continue
        same = [row for row in purchases if row.date == refund.date and _same_merchant(row, refund)]
        if not same:
            _skip(refund, Kind.INCOME, "income")
            continue
        target = next((row for row in same if spend_amount(row) >= refund.amount), same[0])
        target.refund += refund.amount
    for row in purchases:
        if row.refund and spend_amount(row) <= 0:
            _skip(row, Kind.SPEND, "refunded")


def mark_duplicates(owner, rows, categories):
    """Траты, уже внесённые у владельца, снимаются с отметки: та же сумма ±1 день, либо квитанция за жильё.

    Каждый чек владельца закрывает не больше одной строки.
    """
    candidates = sorted((row for row in rows if row.state in (State.SPEND, State.REVIEW) and row.amount < 0),
                        key=lambda row: (row.date, row.position))
    if not candidates:
        return
    start = candidates[0].date - timedelta(days=BILL_DAYS)
    end = candidates[-1].date + timedelta(days=BILL_DAYS)
    receipts = list(Receipt.objects.filter(owner=owner, purchased_on__range=(start, end))
                    .values_list("pk", "purchased_on", "total", "currency_id"))
    roots = defaultdict(set)
    for receipt_id, category_id in ReceiptLine.objects.filter(
            receipt_id__in=[pk for pk, *_ in receipts], category__isnull=False).values_list("receipt_id", "category_id"):
        roots[receipt_id].add(categories.root(category_id))
    bill_roots = categories.root_names(BILL_ROOTS)
    used = set()

    def nearest(row, fits):
        found = [(abs((day - row.date).days), pk) for pk, day, total, currency in receipts
                 if pk not in used and currency == row.currency and fits(pk, day, total)]
        return min(found)[1] if found else None

    for row in candidates:
        amount = spend_amount(row)
        match = nearest(row, lambda pk, day, total: total == amount and abs((day - row.date).days) <= DUPLICATE_DAYS)
        reason = "duplicate"
        if match is None and row.category_id and categories.root(row.category_id) in bill_roots:
            root = categories.root(row.category_id)
            match = nearest(row, lambda pk, day, total: root in roots[pk] and abs(math.ceil(total) - amount) <= 1
                            and abs((day - row.date).days) <= BILL_DAYS)
            reason = "bill"
        if match is not None:
            used.add(match)
            row.state, row.reason, row.duplicate_of_id = State.DUPLICATE, reason, match


def mark_goal_duplicates(rows):
    """Взнос, который у цели уже есть (та же сумма и валюта ±1 день), снимается с отметки; один взнос — одна строка."""
    candidates = sorted((row for row in rows if row.state == State.GOAL), key=lambda row: (row.date, row.position))
    if not candidates:
        return
    existing = list(Contribution.objects.filter(
        goal_id__in={row.goal_id for row in candidates},
        date__range=(candidates[0].date - timedelta(days=DUPLICATE_DAYS), candidates[-1].date + timedelta(days=DUPLICATE_DAYS)),
    ).values_list("pk", "goal_id", "amount", "currency_id", "date"))
    used = set()
    for row in candidates:
        amount = spend_amount(row)
        found = [(abs((day - row.date).days), pk) for pk, goal_id, total, currency, day in existing
                 if pk not in used and goal_id == row.goal_id and currency == row.currency and total == amount
                 and abs((day - row.date).days) <= DUPLICATE_DAYS]
        if found:
            used.add(min(found)[1])
            row.state, row.reason = State.DUPLICATE, "goal_duplicate"


def assign_goal(statement_id, row_id, goal, *, user, actor):
    """«Это взнос в цель»: личное правило получателя строки и его применение к несохранённым переводам черновика.

    Возвращает число строк, ставших взносами; ``SaveInvalid`` — строка не перевод или уже сохранена.
    """
    with transaction.atomic():
        statement = StatementImport.objects.select_for_update().get(pk=statement_id)
        row = statement.rows.filter(pk=row_id).first()
        if row is None:
            raise SaveInvalid({"row": "unknown"})
        if row.kind not in GOAL_KINDS or row.amount >= 0 or row.receipt_id or row.contribution_id:
            raise SaveInvalid({"row": "not_transfer"})
        rule = remember_goal(user, merchant=row.merchant, goal_id=goal.pk, actor=actor)
        book = RuleBook([rule])
        changed = [other for other in statement.rows.filter(kind__in=GOAL_KINDS, amount__lt=0, receipt__isnull=True,
                                                            contribution__isnull=True)
                   if book.match(other.merchant) is not None]
        for other in changed:
            as_goal(other, goal.pk)
        StatementRow.objects.bulk_update(
            changed, ["state", "reason", "source", "goal", "category", "store_name", "duplicate_of"])
    return len(changed)


# --- сохранение ---

def _id(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2 ** 63 else None


def parse_items(data):
    """Тело ``{"rows": [{"id", "category", "store_name"?}]}`` → список; ``SaveInvalid`` с полями."""
    if not isinstance(data, dict):
        raise SaveInvalid({"body": "type"})
    errors = {key: "unknown_field" for key in data if key != "rows"}
    raw = data.get("rows")
    if not isinstance(raw, list) or not raw:
        errors["rows"] = "required" if not raw else "type"
        raise SaveInvalid(errors)
    if len(raw) > MAX_ROWS:
        raise SaveInvalid({**errors, "rows": "size"})
    items, seen = [], set()
    for index, item in enumerate(raw):
        prefix = f"rows.{index}."
        if not isinstance(item, dict):
            errors[f"rows.{index}"] = "type"
            continue
        for key in item:
            if key not in SAVE_FIELDS:
                errors[prefix + key] = "unknown_field"
        pk, category, goal = _id(item.get("id")), _id(item.get("category")), _id(item.get("goal"))
        if pk is None:
            errors[prefix + "id"] = "required" if item.get("id") is None else "type"
        elif pk in seen:
            errors[prefix + "id"] = "repeated"
        seen.add(pk)
        if "goal" in item:
            # Взнос в цель: категории и места у него нет.
            if goal is None:
                errors[prefix + "goal"] = "type"
            for key in ("category", "store_name"):
                if key in item:
                    errors[prefix + key] = "unknown_field"
        elif category is None:
            errors[prefix + "category"] = "required" if item.get("category") is None else "type"
        store = item.get("store_name")
        if store is not None and not isinstance(store, str):
            errors[prefix + "store_name"] = "type"
            store = None
        store = (store or "").strip()
        if len(store) > manual.STORE_NAME_MAX:
            errors[prefix + "store_name"] = "too_long"
        items.append({"index": index, "id": pk, "category": category, "store_name": store, "goal": goal})
    if errors:
        raise SaveInvalid(errors)
    return items


def note_for(row, bank, store):
    """Комментарий траты: детали банка без места, учтённый возврат, затем « · Выписка …»."""
    parts = []
    if not store:
        parts.append(row.details or row.merchant)
    if row.refund:
        parts.append(f"с учётом возврата {row.refund:.2f}")
    body = "; ".join(part for part in parts if part)[:manual.NOTE_MAX - 40]
    return f"{body} · {SOURCE_NOTE[bank]}" if body else f"· {SOURCE_NOTE[bank]}"


def save(statement_id, data, *, rule_owner, actor, goal_scope=None):
    """Отмеченные строки → траты и взносы владельца черновика; ``(создано трат, выучено правил, взносов)``.

    Строки сохраняются одной транзакцией; уже сохранённая строка (трата или взнос)
    пропускается — повтор нажатия безопасен. Строка с ``goal`` становится взносом в цель
    из ``goal_scope`` (Q видимых запросу целей), а не тратой. Выбор категории или места,
    отличный от предложения, учит правило получателя (``rules.learn``).
    """
    items = parse_items(data)
    with transaction.atomic():
        statement = StatementImport.objects.select_for_update().get(pk=statement_id)
        rows = {row.pk: row for row in statement.rows.filter(pk__in=[item["id"] for item in items])}
        wanted = {item["goal"] for item in items if item["goal"]}
        goals = {}
        if wanted and goal_scope is not None:
            goals = {goal.pk: goal for goal in Goal.objects.filter(goal_scope, pk__in=wanted)}
        errors = {}
        for item in items:
            row = rows.get(item["id"])
            if row is None:
                errors[f"rows.{item['index']}.id"] = "unknown"
            elif row.amount >= 0:
                errors[f"rows.{item['index']}.id"] = "income"
            elif row.receipt_id is None and row.contribution_id is None and spend_amount(row) <= 0:
                errors[f"rows.{item['index']}.id"] = "refunded"
            if item["goal"] and item["goal"] not in goals:
                errors[f"rows.{item['index']}.goal"] = "unknown"
        if errors:
            raise SaveInvalid(errors)
        created, learned, contributed = 0, 0, 0
        for item in items:
            row = rows[item["id"]]
            if row.receipt_id is not None or row.contribution_id is not None:
                continue
            if item["goal"]:
                row.contribution = Contribution.objects.create(
                    goal=goals[item["goal"]], amount=spend_amount(row), currency_id=row.currency, date=row.date,
                    user=statement.owner, note=SOURCE_NOTE[statement.bank], created_by=actor)
                row.save(update_fields=["contribution"])
                contributed += 1
                continue
            store = item["store_name"]
            body = {"total": f"{spend_amount(row):.2f}", "currency": row.currency, "category": item["category"],
                    "purchased_on": row.date.isoformat(), "note": note_for(row, statement.bank, store),
                    "payment_method": statement.bank}  # коды банка и способа оплаты совпадают: kaspi_gold, forte
            if store:
                body["store_name"] = store
            try:
                row.receipt = manual.create(statement.owner, body)
            except manual.ManualInvalid as error:
                raise SaveInvalid({f"rows.{item['index']}.{name}": reason
                                   for name, reason in error.fields.items()}) from None
            row.save(update_fields=["receipt"])
            created += 1
            if item["category"] != row.category_id or store != row.store_name:
                learned += learn(rule_owner, merchant=row.merchant, category_id=item["category"],
                                 store_name=store, actor=actor)
        if created or contributed:
            statement.saved_at = timezone.now()
            statement.save(update_fields=["saved_at"])
    return created, learned, contributed
