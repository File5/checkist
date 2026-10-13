"""Оплачен ли регулярный платёж в месяце и что похоже на регулярный платёж — без БД.

**Окно месяца.** Срок платежа в месяце — его число (``due_day``; 31 в коротком месяце —
последний день). Оплатой за месяц считается трата от ``EARLY_DAYS`` дней до срока этого
месяца и до ``EARLY_DAYS`` дней до срока следующего (полуоткрытый отрезок): окна месяцев
идут подряд без пропусков и не пересекаются. Срок 5-го: за октябрь — с 25 сентября по
24 октября; оплата 25-го и позже идёт в следующий месяц. Опоздание до ~20 дней ещё
считается оплатой своего месяца.

**Совпадение.** Трата той же валюты с суммой больше нуля подходит платежу, если сходятся
хотя бы два признака из трёх: тот же магазин; категория траты — категория платежа или
её потомок; сумма в пределах ``AMOUNT_TOLERANCE`` (±25 %) от ожидаемой. Без магазина у
платежа остаются категория и сумма. Категория траты — общий предок категорий её строк
(``common_category``): у «Единой квитанции» со светом, водой и ОСИ это «Жильё».

**Одна трата — один платёж за один месяц.** Пары «платёж — трата» перебираются от лучших:
больше признаков, ближе сумма к ожидаемой, ближе дата к сроку; трата, уже отданная одному
платежу, другому не достаётся, и у платежа в месяце не больше одной траты. Трата,
добавленная ответом «добавить по средней», закреплена за своим платежом и месяцем.

**Предложения.** Траты группируются по магазину, категории и валюте; в каждом месяце
берётся трата с суммой ближе к медиане группы. Подряд идущие месяцы, где сумма отличается
от прошлой не больше чем на ``SUGGEST_TOLERANCE`` (±20 %), образуют цепочку; последняя
цепочка от ``SUGGEST_MONTHS`` (3) месяцев, закончившаяся в последние полгода, — предложение
(сумма и число — по ней: последняя сумма, медиана чисел месяца). Группа, где в месяцах цепочки
трат больше одной (кроме одной лишней на всю цепочку), — частые покупки, а не платёж.
"""
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal
from statistics import median

from budget.dashboard import Month

EARLY_DAYS = 10
AMOUNT_TOLERANCE = Decimal("0.25")
SUGGEST_TOLERANCE = Decimal("0.20")
SUGGEST_MONTHS = 3
# Цепочка должна закончиться в последние полгода (этот месяц и пять до него): давно отменённая подписка не нужна,
# а пропуск в пару месяцев («забыли внести») предложение не прячет.
SUGGEST_RECENT_MONTHS = 5
_CENT = Decimal("0.01")
_DEPTH = 64  # дерево категорий без циклов в БД не проверяется; обход конечен


@dataclass(frozen=True)
class Spend:
    """Видимая трата: ``category_id`` — общий предок категорий строк либо ``None``; ``method`` — способ оплаты."""

    id: int
    day: date
    store_id: int | None
    category_id: int | None
    currency: str
    total: Decimal
    method: str = ""


@dataclass(frozen=True)
class Plan:
    """Платёж для сверки: только то, что нужно правилу."""

    id: int
    store_id: int | None
    category_id: int
    currency: str
    amount: Decimal
    due_day: int


@dataclass(frozen=True)
class Suggestion:
    store_id: int
    category_id: int
    currency: str
    amount: Decimal
    due_day: int
    months: int
    last_day: date


def shift(month, count):
    index = month.year * 12 + month.month - 1 + count
    return Month(index // 12, index % 12 + 1)


def due_date(month, due_day):
    return date(month.year, month.month, min(due_day, month.last.day))


def window(month, due_day):
    """``(начало, конец)`` окна месяца; конец не входит."""
    early = timedelta(days=EARLY_DAYS)
    return due_date(month, due_day) - early, due_date(shift(month, 1), due_day) - early


def month_of(day, due_day):
    """Месяц, в окно которого попадает ``day`` у платежа со сроком ``due_day``."""
    moved = day + timedelta(days=EARLY_DAYS)
    month = Month.of(moved)
    return month if moved >= due_date(month, due_day) else month.previous()


def path(category_id, parents):
    """Путь от корня к категории: ``[корень, …, category_id]``."""
    result, current = [], category_id
    while current is not None and len(result) < _DEPTH and current not in result:
        result.append(current)
        current = parents.get(current)
    return result[::-1]


def within(category_id, ancestor_id, parents):
    """Категория — ``ancestor_id`` либо её потомок."""
    return ancestor_id in path(category_id, parents)


def common_category(ids, parents):
    """Глубочайший общий предок категорий ``ids``; ``None`` — категорий нет либо у них разные корни."""
    paths = [path(pk, parents) for pk in set(ids)]
    if not paths:
        return None
    common = None
    for steps in zip(*paths):
        if any(step != steps[0] for step in steps):
            break
        common = steps[0]
    return common


def _relative(amount, expected):
    return abs(amount - expected) / expected if expected else Decimal(1)


def signals(plan, spend, parents):
    """Сколько признаков сошлось: магазин, категория, сумма."""
    same_store = plan.store_id is not None and spend.store_id == plan.store_id
    same_category = spend.category_id is not None and within(spend.category_id, plan.category_id, parents)
    close = _relative(spend.total, plan.amount) <= AMOUNT_TOLERANCE
    return int(same_store) + int(same_category) + int(close)


def income_signals(plan, income, parents):
    """Регулярный доход: категория дохода обязательна (считается за два признака), сумма ±25 % — третий.

    Магазина у дохода нет, а сумму при внесении можно поправить: «Зарплата» той же категории в окне месяца —
    полученная зарплата, даже если пришло меньше обычного.
    """
    if income.category_id != plan.category_id:
        return 0
    return 2 + int(_relative(income.total, plan.amount) <= AMOUNT_TOLERANCE)


def assign(plans, spends, months, parents, fixed=None, score=signals):
    """``{(plan_id, Month): Spend}`` — оплата каждого платежа в каждом месяце ``months``.

    ``fixed`` — ``{(plan_id, Month): spend_id}``: траты, добавленные ответом «по средней». ``score`` — правило
    признаков (у регулярного дохода — ``income_signals``, «траты» — доходы месяца).
    """
    months = set(months)
    by_id = {spend.id: spend for spend in spends}
    result, used = {}, set()
    for key, spend_id in (fixed or {}).items():
        spend = by_id.get(spend_id)
        if spend is not None and key[1] in months and spend_id not in used:
            result[key] = spend
            used.add(spend_id)
    by_currency = defaultdict(list)
    for spend in spends:
        if spend.total > 0 and spend.id not in used:
            by_currency[spend.currency].append(spend)
    candidates = []
    for plan in plans:
        for spend in by_currency.get(plan.currency, ()):
            month = month_of(spend.day, plan.due_day)
            if month not in months or (plan.id, month) in result:
                continue
            found = score(plan, spend, parents)
            if found >= 2:
                late = abs((spend.day - due_date(month, plan.due_day)).days)
                candidates.append(((-found, _relative(spend.total, plan.amount), late, spend.id, plan.id), plan.id, month, spend))
    candidates.sort(key=lambda item: item[0])
    for _, plan_id, month, spend in candidates:
        if spend.id in used or (plan_id, month) in result:
            continue
        result[(plan_id, month)] = spend
        used.add(spend.id)
    return result


def average(amounts):
    """Среднее до копеек; пусто — ``None``."""
    amounts = list(amounts)
    if not amounts:
        return None
    return (sum(amounts, Decimal(0)) / len(amounts)).quantize(_CENT, rounding=ROUND_HALF_UP)


def _chain(points):
    """Последняя цепочка от ``SUGGEST_MONTHS`` подряд идущих месяцев со схожей суммой: ``[(Month, Spend), …]``.

    Пропуски после неё (забыли внести) цепочку не отменяют.
    """
    found, current = [], []
    for month, spend in points:
        if current and shift(current[-1][0], 1) == month \
                and _relative(spend.total, current[-1][1].total) <= SUGGEST_TOLERANCE:
            current.append((month, spend))
        else:
            current = [(month, spend)]
        if len(current) >= SUGGEST_MONTHS:
            found = list(current)
    return found


def suggest(spends, today, covered=lambda store_id, category_id, currency, last: False):
    """Предложения по истории ``spends``: тот же магазин, категория и валюта, схожая сумма ≥ 3 месяцев подряд.

    ``covered(store_id, category_id, currency, last)`` — уже есть такой платёж (``last`` —
    последняя трата цепочки) либо предложение скрыто. Порядок — по сумме, больше сначала.
    """
    groups = defaultdict(list)
    for spend in spends:
        if spend.store_id is not None and spend.category_id is not None and spend.total > 0:
            groups[(spend.store_id, spend.category_id, spend.currency)].append(spend)
    recent = shift(Month.of(today), -SUGGEST_RECENT_MONTHS)
    result = []
    for (store_id, category_id, currency), items in groups.items():
        middle = Decimal(median(spend.total for spend in items))
        by_month = defaultdict(list)
        for spend in items:
            by_month[Month.of(spend.day)].append(spend)
        points = [(month, min(by_month[month], key=lambda spend: (abs(spend.total - middle), spend.day, spend.id)))
                  for month in sorted(by_month, key=lambda month: (month.year, month.month))]
        chain = _chain(points)
        if not chain or (chain[-1][0].year, chain[-1][0].month) < (recent.year, recent.month):
            continue
        # Платёж — раз в месяц: магазин, где в те же месяцы трат несколько (продукты, такси), — не он.
        # Одна лишняя трата за цепочку допустима (срок сдвинулся, оплатили дважды).
        if sum(len(by_month[month]) for month, _ in chain) > len(chain) + 1:
            continue
        last = chain[-1][1]
        if covered(store_id, category_id, currency, last):
            continue
        due_day = int(median(spend.day.day for _, spend in chain))
        result.append(Suggestion(store_id, category_id, currency, last.total, due_day, len(chain), last.day))
    result.sort(key=lambda item: (-item.amount, item.store_id, item.category_id, item.currency))
    return result
