"""Депозит: проценты на остаток по дням и прогнозы — чистые функции без базы, курсов и часов.

Начисление — каждый прошедший день на остаток: ``остаток × ставка / 100 / 365``. Ежемесячная капитализация
1-го числа прибавляет начисленное к остатку (дальше на него тоже начисляется); без капитализации начисленное
копится отдельно и процентов не приносит. Счёт — с первого события; в день события сначала (1-го числа)
капитализация, затем события дня — взнос и запись «проценты» (сверка с банком) прибавляются к остатку, — затем
начисление за этот день, если день уже прошёл (за ``until`` не начисляется). Значит, «на депозите» на день
сверки — сумма после событий этого дня, а разница с банком дальше считается частью остатка. Событие позже
``until`` прибавляется без процентов (как прежде у копилки).

Прогноз — по месяцам: проценты месяца — ``остаток × ставка / 100 / 12``, взнос — в конце месяца (аннуитет).
Будущая сумма линейна по взносу: ``FV(n, взнос) = FV(n, 0) + взнос × FV(n, 1 | с нуля)`` — отсюда «вносите по
N в месяц». При ставке 0 это прежнее «осталось / месяцев» и «осталось / темп».
"""
from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal, localcontext

YEAR_DAYS = 365
HORIZON = 600  # месяцев: дальше «до цели ~K месяцев» не ищется
ZERO = Decimal(0)


@dataclass(frozen=True)
class State:
    balance: Decimal = ZERO  # взносы, сверки и прибавленные проценты
    accrued: Decimal = ZERO  # начислено и ещё не прибавлено к остатку

    @property
    def total(self):
        return self.balance + self.accrued


def daily(events, rate, monthly, until):
    """(State на ``until``, взносов всего, [(1-е число месяца, всего, взносов на конец месяца)]).

    ``events`` — [(дата, сумма в валюте цели, взнос ли)]; запись «проценты» — не взнос. Последняя точка — ``until``.
    """
    events = sorted(events, key=lambda event: event[0])
    later = [event for event in events if event[0] > until]
    events = [event for event in events if event[0] <= until]
    per_day = Decimal(rate) / 100 / YEAR_DAYS
    balance = accrued = deposits = ZERO
    points, index = [], 0
    with localcontext() as context:
        context.prec = 34
        day = events[0][0] if events else until
        while True:
            if monthly and day.day == 1:
                balance, accrued = balance + accrued, ZERO
            while index < len(events) and events[index][0] == day:
                balance += events[index][1]
                deposits += events[index][1] if events[index][2] else ZERO
                index += 1
            if day == until:
                break
            accrued += balance * per_day
            following = day + timedelta(days=1)
            if following.month != day.month:
                points.append((day.replace(day=1), balance + accrued, deposits))
            day = following
        for _day, amount, deposit in later:
            balance += amount
            deposits += amount if deposit else ZERO
        if events or later:
            points.append((until.replace(day=1), balance + accrued, deposits))
    return State(balance, accrued), deposits, points


def project(state, rate, monthly, months, payment=ZERO):
    """State через ``months`` месяцев: проценты месяца на остаток, затем взнос ``payment`` в конце месяца."""
    per_month = Decimal(rate) / 100 / 12
    balance, accrued = state.balance, state.accrued
    with localcontext() as context:
        context.prec = 34
        for _ in range(months):
            if monthly:
                balance, accrued = balance + accrued + balance * per_month, ZERO
            else:
                accrued += balance * per_month
            balance += payment
    return State(balance, accrued)


def need(state, rate, monthly, months, target):
    """Взнос в месяц (в конце месяца), чтобы через ``months`` месяцев было ``target``; 0 — хватит процентов."""
    base = project(state, rate, monthly, months).total
    if base >= target:
        return ZERO
    with localcontext() as context:
        context.prec = 34
        return (target - base) / project(State(), rate, monthly, months, Decimal(1)).total


def months_to(state, rate, monthly, target, payment):
    """Через сколько месяцев будет ``target`` при взносе ``payment`` в месяц; ``None`` — не за ``HORIZON``."""
    for months in range(HORIZON + 1):
        if state.total >= target:
            return months
        state = project(state, rate, monthly, 1, payment)
    return None
