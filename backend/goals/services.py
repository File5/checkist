"""Прогресс целей: накоплено в валюте цели, темп последних трёх месяцев и прогноз.

Взнос в другой валюте пересчитывается в валюту цели по курсу дня взноса
(``rates.convert.converter``); взнос без курса в «накоплено» не входит и показывается
отдельно (``excluded``). Темп — взносы за последние ``PACE_DAYS`` дней (до сегодня
включительно), делённые на 3 месяца, а у цели моложе трёх месяцев — на число месяцев с
первого взноса (не меньше одного); взносов в окне нет — прогноза нет. Месяц — ``MONTH_DAYS``
дней: до срока через 79 дней — 3 месяца.
"""
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from rates.convert import converter
from receipts.decimal_math import price_context, round_decimal

from .models import Contribution

PACE_DAYS = 91
MONTH_DAYS = Decimal("30.44")
ZERO = Decimal("0.00")


@dataclass
class Progress:
    saved: Decimal = ZERO
    excluded: dict = field(default_factory=dict)  # {валюта: сумма} взносов без курса
    count: int = 0
    pace: Decimal | None = None  # в месяц, в валюте цели
    months_left: int | None = None
    need: Decimal | None = None  # в месяц, чтобы успеть к сроку
    overdue: bool = False


def months(days):
    """Месяцев в ``days`` днях, с округлением вверх и не меньше одного."""
    return max(1, math.ceil(Decimal(days) / MONTH_DAYS))


def progress(goals, today):
    """{goal.pk: Progress}: взносы всех целей — один запрос, курсы — по запросу на валюту цели."""
    goals = list(goals)
    by_goal = defaultdict(list)
    for goal_id, amount, currency, day in (Contribution.objects.filter(goal__in=goals)
                                           .values_list("goal_id", "amount", "currency_id", "date")):
        by_goal[goal_id].append((amount, currency, day))
    needs = defaultdict(set)
    for goal in goals:
        needs[goal.currency_id].update((currency, day) for _amount, currency, day in by_goal[goal.pk])
    converters = {base: converter(base, pairs) for base, pairs in needs.items()}
    return {goal.pk: _one(goal, by_goal[goal.pk], converters[goal.currency_id], today) for goal in goals}


def _one(goal, rows, convert, today):
    result = Progress(count=len(rows))
    start = today - timedelta(days=PACE_DAYS)
    recent = ZERO
    excluded = defaultdict(lambda: ZERO)
    for amount, currency, day in rows:
        value = convert.convert(amount, currency, day)
        if value is None:
            excluded[currency] += amount
            continue
        result.saved += value
        if start < day <= today:
            recent += value
    result.excluded = dict(sorted(excluded.items()))
    remaining = goal.amount - result.saved
    if recent > 0:
        first = min(day for _amount, _currency, day in rows)
        span = 3 if first <= start else min(3, months((today - first).days + 1))
        with price_context():
            result.pace = round_decimal(recent / span, 2) or None
            if result.pace and remaining > 0:
                result.months_left = math.ceil(remaining / result.pace)
    if goal.deadline is not None and remaining > 0:
        if goal.deadline < today:
            result.overdue = True
        else:
            with price_context():
                result.need = round_decimal(remaining / months(max(1, (goal.deadline - today).days)), 2)
    return result
