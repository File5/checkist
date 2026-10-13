"""Журнал лимитов (``BudgetLimitChange``) и сумма лимита в месяце.

Запись: ``save_limit`` и ``delete_limit`` — единственный путь изменения лимита для API и
админки; журнал пишется в той же транзакции, что и сам лимит. Перенос лимита на другую
категорию, валюту или владельца — удаление прежней пары и создание новой (две записи).

Чтение: сумма лимита пары «категория и валюта» в месяце — ``new_amount`` последней записи
журнала с ``effective_month`` не позже этого месяца (``None`` — лимита не было либо он
удалён). Записи одного месяца упорядочены по ``changed_at`` и ``pk``. Лимит без единой
записи журнала (заведён мимо сервиса — тестом, из shell) действует во всех месяцах своей
текущей суммой, как до журнала. Функции чтения работают со списками, без запросов к БД;
им передают весь журнал пары, а не срез по месяцам — иначе пара без записей в срезе
сочтётся парой без журнала.

Здесь же (2026-10-13): ``backfill`` — нынешние лимиты прошлым месяцам (команда
``limit_history backfill``); общий бюджет месяца ``MonthlyBudget`` — ``set_budget`` и
``budget_at`` (таблица бюджета сама себе журнал: строка на месяц изменения).
"""
from dataclasses import dataclass, field
from datetime import date, datetime, time
from types import SimpleNamespace

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .models import BudgetLimit, BudgetLimitChange, MonthlyBudget

_OWNER_KEY = ("household_id", "user_id", "category_id", "currency_id")


def month_start(day):
    return date(day.year, day.month, 1)


def current_month():
    return month_start(timezone.localdate())


def _owner_key(limit):
    return tuple(getattr(limit, name) for name in _OWNER_KEY)


def _actor(actor):
    """Пользователь журнала; аноним и ``None`` — ``None``."""
    return actor if actor is not None and getattr(actor, "pk", None) is not None else None


def _change(key, old, new, actor, now):
    household_id, user_id, category_id, currency_id = key
    return BudgetLimitChange(
        household_id=household_id, user_id=user_id, category_id=category_id, currency_id=currency_id,
        old_amount=old, new_amount=new, changed_by=_actor(actor), changed_at=now,
        effective_month=month_start(timezone.localdate(now)),
    )


def save_limit(limit, actor=None):
    """Сохранить новый либо изменённый лимит и записать изменение; ``IntegrityError`` пары — наружу.

    Сумма без изменений журнал не пополняет.
    """
    with transaction.atomic():
        before = None
        if limit.pk is not None:
            before = BudgetLimit.objects.select_for_update().filter(pk=limit.pk).first()
        limit.save()
        now = timezone.now()
        if before is None:
            changes = [_change(_owner_key(limit), None, limit.amount, actor, now)]
        elif _owner_key(before) != _owner_key(limit):
            changes = [_change(_owner_key(before), before.amount, None, actor, now),
                       _change(_owner_key(limit), None, limit.amount, actor, now)]
        elif before.amount != limit.amount:
            changes = [_change(_owner_key(limit), before.amount, limit.amount, actor, now)]
        else:
            changes = []
        BudgetLimitChange.objects.bulk_create(changes)
    return limit


def delete_limit(limit, actor=None):
    """Удалить лимит и записать удаление; уже удалённый — ничего не делает."""
    with transaction.atomic():
        current = BudgetLimit.objects.select_for_update().filter(pk=limit.pk).first()
        if current is None:
            return
        _change(_owner_key(current), current.amount, None, actor, timezone.now()).save()
        current.delete()


def backfill(since, *, dry_run=False):
    """Прошлые месяцы с ``since`` (первое число) получают нынешние лимиты (``manage.py limit_history backfill``).

    Журнал начался 2026-10-12, и прошлые месяцы показывали «Лимиты не заданы». Паре текущего лимита, чей
    журнал начинается позже ``since``, добавляется запись «создан» с текущей суммой в месяце ``since``
    (автор неизвестен, время — полночь первого числа). Пара без журнала и так действует во всех месяцах,
    пара с журналом не позже ``since`` не трогается — повтор ничего не меняет. Удалённые лимиты не
    восстанавливаются. Возвращает добавленные записи (с ``dry_run`` — те, что были бы добавлены).
    """
    from django.db.models import Min

    started = {
        key[:4]: key[4] for key in BudgetLimitChange.objects.values("household_id", "user_id", "category_id", "currency_id")
        .annotate(first=Min("effective_month")).order_by()
        .values_list("household_id", "user_id", "category_id", "currency_id", "first")
    }
    at = timezone.make_aware(datetime.combine(since, time.min))
    rows = []
    for limit in BudgetLimit.objects.select_related("category").order_by("pk"):
        first = started.get(_owner_key(limit))
        if first is None or first <= since:
            continue
        row = _change(_owner_key(limit), None, limit.amount, None, at)
        row.category, row.effective_month = limit.category, since
        rows.append(row)
    if not dry_run:
        BudgetLimitChange.objects.bulk_create(rows)
    return rows


# --- общий бюджет месяца (``MonthlyBudget``) ---

def budget_at(owner_q, month):
    """Строка бюджета, действующая в месяце ``month`` (первое число), либо ``None``; ``amount`` пуст — бюджет снят.

    ``owner_q`` — ``budget.access.limits_q``. Один запрос.
    """
    return (MonthlyBudget.objects.filter(owner_q, effective_month__lte=month)
            .order_by("-effective_month").first())


def set_budget(owner, currency, amount, actor=None):
    """Бюджет с текущего месяца: ``amount`` либо ``None`` (снять); прошлые месяцы не меняются.

    ``owner`` — ``budget.access.limit_owner``. Снятие без действующего бюджета ничего не пишет.
    """
    month = current_month()
    lookup = {"household": owner["household"], "user": owner["user"], "effective_month": month}
    with transaction.atomic():
        if amount is None:
            mine = Q(household=owner["household"]) if owner["household"] else Q(user=owner["user"], household__isnull=True)
            active = budget_at(mine, month)
            if active is None or active.amount is None:
                return None
        row, _ = MonthlyBudget.objects.update_or_create(**lookup, defaults={
            "currency_id": currency, "amount": amount, "changed_by": _actor(actor), "changed_at": timezone.now()})
    return row


# --- сумма лимита в месяце ---

def _ordered(changes):
    """``{(category_id, currency): [запись, ...]}`` по ``effective_month``, ``changed_at``, ``pk``."""
    by_key = {}
    for change in sorted(changes, key=lambda item: (item.effective_month, item.changed_at, item.pk)):
        by_key.setdefault((change.category_id, change.currency_id), []).append(change)
    return by_key


def amount_at(rows, month):
    """Сумма в месяце ``month`` (первое число) по записям одной пары в порядке ``_ordered``."""
    amount = None
    for change in rows:
        if change.effective_month > month:
            break
        amount = change.new_amount
    return amount


def amount_before(rows, month):
    """Сумма к началу месяца ``month`` — до его изменений."""
    amount = None
    for change in rows:
        if change.effective_month >= month:
            break
        amount = change.new_amount
    return amount


@dataclass
class Series:
    """Лимит пары «категория и валюта» по месяцам окна."""

    category_id: int
    currency: str
    limit: object  # текущий ``BudgetLimit`` либо ``None`` (удалён)
    amounts: list  # Decimal | None на каждый месяц окна
    # месяц окна -> (сумма до месяца, сумма в месяце), только у месяцев, где сумма изменилась
    changed: dict = field(default_factory=dict)
    changes: list = field(default_factory=list)  # записи журнала пары, по возрастанию


def series(limits, changes, months):
    """Пары с лимитом сейчас либо хотя бы в одном месяце окна; ``months`` — первые числа по возрастанию."""
    by_key = _ordered(changes)
    current = {(limit.category_id, limit.currency_id): limit for limit in limits}
    result = []
    for key in sorted(set(by_key) | set(current)):
        limit, rows = current.get(key), by_key.get(key)
        if rows is None:
            result.append(Series(key[0], key[1], limit, [limit.amount] * len(months)))
            continue
        amounts = [amount_at(rows, month) for month in months]
        if limit is None and all(amount is None for amount in amounts):
            continue
        changed = {}
        for month, amount in zip(months, amounts):
            before = amount_before(rows, month)
            if before != amount:
                changed[month] = (before, amount)
        result.append(Series(key[0], key[1], limit, amounts, changed, rows))
    return result


def limits_at(limits, changes, month):
    """Лимиты месяца ``month`` в виде объектов с полями ``BudgetLimit``, по ``pk``.

    ``pk`` — текущего лимита пары (``None``, если пары уже нет); ``category`` — из записи
    журнала (``select_related``) либо из текущего лимита.
    """
    by_key = _ordered(changes)
    current = {(limit.category_id, limit.currency_id): limit for limit in limits}
    result = []
    for key in set(by_key) | set(current):
        limit, rows = current.get(key), by_key.get(key)
        amount = limit.amount if rows is None else amount_at(rows, month)
        if amount is None:
            continue
        category = limit.category if limit is not None else rows[-1].category
        result.append(SimpleNamespace(pk=limit.pk if limit is not None else None, category_id=key[0],
                                      currency_id=key[1], amount=amount, category=category))
    return sorted(result, key=lambda item: (item.pk is None, item.pk or 0, item.currency_id, item.category_id))
