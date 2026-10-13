"""Прогресс целей: накоплено в валюте цели, темп последних трёх месяцев и прогноз.

Взнос в другой валюте пересчитывается в валюту цели по курсу дня взноса
(``rates.convert.converter``); взнос без курса в «накоплено» не входит и показывается
отдельно (``excluded``). Темп — взносы (не записи «проценты») за последние ``PACE_DAYS`` дней (до
сегодня включительно), делённые на 3 месяца, а у цели моложе трёх месяцев — на число месяцев с
первого взноса (не меньше одного); взносов в окне нет — прогноза нет. Месяц — ``MONTH_DAYS``
дней: до срока через 79 дней — 3 месяца.

Депозит (``Goal.Kind.DEPOSIT``) считается ``goals.forecast`` по своей ставке: «накоплено» — сумма на
депозите сегодня с процентами, «нужно в месяц», «до цели ~K месяцев» и «к сроку будет» — с процентами;
у копилки та же арифметика со ставкой 0 даёт прежние числа.
"""
import math
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import timedelta
from decimal import Decimal

from rates.convert import converter
from receipts.decimal_math import price_context, round_decimal

from . import forecast
from .models import Contribution, Goal

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
    # Депозит: взносов всего, на депозите без новых взносов через год, к сроку при нынешнем темпе, ряд графика.
    deposits: Decimal = ZERO
    year: Decimal | None = None
    at_deadline: tuple | None = None  # (всего, из них процентов)
    points: list = field(default_factory=list)  # [(месяц, всего, взносов, прогноз ли)]


def months(days):
    """Месяцев в ``days`` днях, с округлением вверх и не меньше одного."""
    return max(1, math.ceil(Decimal(days) / MONTH_DAYS))


def progress(goals, today):
    """{goal.pk: Progress}: взносы всех целей — один запрос, курсы — по запросу на валюту цели."""
    goals = list(goals)
    by_goal = _rows(Contribution.objects.filter(goal__in=goals))
    converters = _converters(goals, by_goal)
    return {goal.pk: _one(goal, by_goal[goal.pk], converters[goal.currency_id], today) for goal in goals}


def estimate(goal, day):
    """На депозите ``goal`` на день ``day`` (после событий дня), 2 знака; ``None`` — взносов по этот день нет."""
    by_goal = _rows(goal.contributions.filter(date__lte=day))
    events, _excluded = _events(by_goal[goal.pk], _converters([goal], by_goal)[goal.currency_id])
    if not any(deposit for _day, _value, deposit in events):
        return None
    return round_decimal(forecast.daily(events, *_terms(goal), day)[0].total, 2)


def _rows(contributions):
    by_goal = defaultdict(list)
    for goal_id, *row in contributions.values_list("goal_id", "amount", "currency_id", "date", "kind"):
        by_goal[goal_id].append(row)
    return by_goal


def _converters(goals, by_goal):
    needs = defaultdict(set)
    for goal in goals:
        needs[goal.currency_id].update((currency, day) for _amount, currency, day, _kind in by_goal[goal.pk])
    return {base: converter(base, pairs) for base, pairs in needs.items()}


def _events(rows, convert):
    """[(дата, сумма в валюте цели, взнос ли)] и {валюта: сумма} взносов без курса."""
    events, excluded = [], defaultdict(lambda: ZERO)
    for amount, currency, day, kind in rows:
        value = convert.convert(amount, currency, day)
        if value is None:
            excluded[currency] += amount
        else:
            events.append((day, value, kind == Contribution.Kind.DEPOSIT))
    return events, dict(sorted(excluded.items()))


def _terms(goal):
    """(ставка, ежемесячная ли капитализация): у копилки ставка 0."""
    deposit = goal.kind == Goal.Kind.DEPOSIT and goal.rate is not None
    return (goal.rate if deposit else ZERO), goal.capitalization == Goal.Capitalization.MONTHLY


def _one(goal, rows, convert, today):
    events, result_excluded = _events(rows, convert)
    rate, monthly = _terms(goal)
    deposits = [(day, value) for day, value, deposit in events if deposit]
    result = Progress(count=len([row for row in rows if row[3] == Contribution.Kind.DEPOSIT]), excluded=result_excluded)
    state, total_deposits, history = forecast.daily(events, rate, monthly, today)
    result.saved, result.deposits = round_decimal(state.total, 2), round_decimal(total_deposits, 2)
    start = today - timedelta(days=PACE_DAYS)
    recent = sum((value for day, value in deposits if start < day <= today), ZERO)
    remaining = goal.amount - result.saved
    ahead = goal.deadline is not None and goal.deadline >= today
    left = min(months(max(1, (goal.deadline - today).days)), forecast.HORIZON) if ahead else None
    if recent > 0:
        first = min(day for day, _value in deposits)
        span = 3 if first <= start else min(3, months((today - first).days + 1))
        with price_context():
            result.pace = round_decimal(recent / span, 2) or None
            if result.pace and remaining > 0:
                result.months_left = forecast.months_to(state, rate, monthly, goal.amount, result.pace)
    if goal.deadline is not None and remaining > 0:
        if not ahead:
            result.overdue = True
        else:
            result.need = round_decimal(forecast.need(state, rate, monthly, left, goal.amount), 2)
    if goal.kind == Goal.Kind.DEPOSIT and history:
        result.year = round_decimal(forecast.project(state, rate, monthly, 12).total, 2)
        if ahead and result.pace:
            total = round_decimal(forecast.project(state, rate, monthly, left, result.pace).total, 2)
            result.at_deadline = (total, total - result.deposits - result.pace * left)
        result.points = [(month, total, saved, False) for month, total, saved in history]
        payment, saved = result.pace or ZERO, total_deposits
        month = today.replace(day=1)
        for _ in range(min(left or 12, 60)):
            month = (month + timedelta(days=32)).replace(day=1)
            state, saved = forecast.project(state, rate, monthly, 1, payment), saved + payment
            result.points.append((month, state.total, saved, True))
    return result
