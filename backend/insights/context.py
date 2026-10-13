"""Сводка трат для модели: компактные цифры семьи, не сырые строки базы.

Окно — 12 месяцев по месяц ``month`` включительно. Всё — в основной валюте семьи по курсу дня покупки
(``rates.convert``); траты без курса в суммы не входят и перечислены в ``without_rate``. Траты читаются
только через ``accounts.access.visible_receipts_q`` пользователя: скрытый от него платёж в сводку не
попадает. Расчёт — тот же, что у экранов: месяцы и категории — ``receipts.trends`` («Динамика»), лимиты —
``budget.dashboard`` («Главная»), регулярные платежи — ``recurring.services``. Суммы — строки с двумя знаками.

``focus`` — цифры самого месяца, которые экран разбора показывает рядом с текстом модели: «потрачено»,
прошлый месяц, среднее (прошлые месяцы окна, начиная с первого месяца с тратами), разница с ними,
корневые категории, лимиты и места месяца.
"""
from collections import defaultdict
from decimal import Decimal
from types import SimpleNamespace

from django.db.models import Count, Sum
from django.utils import timezone

from accounts.access import visible_receipts_q
from api import stats_common
from api.common import CategoryTree, amount, store_name
from budget import history
from budget.access import limits_q
from budget.dashboard import collect_month, currency_blocks, limit_day
from budget.models import BudgetLimit, BudgetLimitChange
from receipts import trends
from receipts.decimal_math import price_context, round_decimal
from receipts.models import Receipt
from recurring.services import month_view
from stores.models import Store

WINDOW = 12
PLACES = 10
NO_PLACE = "Без места"
_ZERO = Decimal("0.00")


def incomes(user, month):
    """Доходы семьи по месяцам окна — пока пусто: модель о доходах не говорит.

    ponytail: доходы вносит ветка feature/incomes (``incomes.services.month_income(user, month)``, основная
    валюта); при слиянии ведущий отдаёт здесь ``[{"month": "ГГГГ-ММ", "total": "…"}]`` — промпты уже знают поле.
    """
    return []


def _limits(request, month, today):
    """Лимиты месяца, как на «Главной»: текущий и будущие — нынешние, прошлый — суммы того месяца по журналу."""
    limits = BudgetLimit.objects.filter(limits_q(request)).select_related("category").order_by("pk")
    if month.first >= history.month_start(today):
        return list(limits)
    changes = BudgetLimitChange.objects.filter(limits_q(request)).select_related("category")
    return history.limits_at(list(limits), list(changes), month.first)


def _average(values, start):
    """Среднее ``values[start:-1]`` (месяцы до разбираемого), 2 знака; ``None`` — таких месяцев нет."""
    earlier = values[start:-1] if start is not None else []
    if not earlier:
        return None
    with price_context():
        return round_decimal(sum(earlier, _ZERO) / len(earlier), 2)


def _figures(spent, previous, average):
    difference = None if average is None else spent - average
    return {"spent": amount(spent), "previous": amount(previous), "average": amount(average),
            "change_previous": amount(spent - previous), "change_average": amount(difference)}


def _limit_rows(rows):
    found = []
    for row in rows:
        if row.limit is not None:
            found.append({"category": row.name, "limit": amount(row.limit), "spent": amount(row.spent),
                          "over": amount(row.spent - row.limit) if row.spent > row.limit else None})
        found.extend(_limit_rows(row.children))
    return found


def _top(sums, counts, names):
    order = sorted(sums, key=lambda key: (-sums[key], names[key]))[:PLACES]
    return [{"name": names[key], "spent": amount(sums[key]), "count": counts[key]} for key in order]


def build(user, month, today=None):
    """build(user, month, today=None) -> dict; сводка для модели и цифры экрана. ``month`` — ``budget.dashboard.Month``.

    Число запросов от объёма данных не зависит.
    """
    today = today or timezone.localdate()
    request = SimpleNamespace(user=user)
    tree = CategoryTree.load()
    receipts = Receipt.objects.filter(visible_receipts_q(request))
    product_ref = stats_common.owner_product_id()
    months = trends.window(month.first, WINDOW)
    rows = trends.collect_spending(receipts, months, product_ref)
    found = collect_month(receipts, month, product_ref)
    limits = _limits(request, month, today)
    rate_day = limit_day(month, today)
    converter = stats_common.converter(request, rows.needs() | found.needs()
                                       | {(limit.currency_id, rate_day) for limit in limits})
    base = converter.base

    monthly = stats_common.base_block(trends.monthly(trends.rebase(rows, converter), months, tree), base)
    totals = [spend.total for spend in monthly.months] if monthly else [_ZERO] * WINDOW
    nodes = monthly.rows if monthly else []
    # Среднее — по месяцам до разбираемого, начиная с первого месяца с тратами: пустые месяцы до начала учёта
    # его не занижают.
    start = next((index for index, total in enumerate(totals[:-1]) if total), None)
    roots = sorted((row for row in nodes if row.parent_id is None and (row.amounts[-1] or row.amounts[-2])),
                   key=lambda row: (-row.amounts[-1], row.name))
    dashboard = stats_common.base_block(currency_blocks(found, limits, month, tree, converter, today), base)

    sums, counts = defaultdict(lambda: _ZERO), defaultdict(int)
    year_sums, year_counts = defaultdict(lambda: _ZERO), defaultdict(int)
    for store_id, currency, day, total, count in (
        receipts.filter(purchased_on__gte=months[0], purchased_on__lte=month.last)
        .values("store_id", "currency_id", "purchased_on").annotate(total_sum=Sum("total"), count=Count("pk"))
        .order_by().values_list("store_id", "currency_id", "purchased_on", "total_sum", "count")
    ):
        value = converter.convert(total, currency, day)
        if value is None:
            continue  # без курса — в without_rate
        year_sums[store_id] += value
        year_counts[store_id] += count
        if day >= month.first:
            sums[store_id] += value
            counts[store_id] += count
    names = {store.pk: store_name(store)
             for store in Store.objects.filter(pk__in=[pk for pk in year_sums if pk]).select_related("merchant")}
    names[None] = NO_PLACE

    payments = month_view(request, month, today, suggestions=False).payments
    return {
        "today": today.isoformat(),
        "month": month.label(),
        "currency": base,
        "months": [trends.label(first) for first in months],
        "totals": [amount(total) for total in totals],
        "categories": [{"id": row.id, "name": row.name, "parent_id": row.parent_id,
                        "amounts": [amount(value) for value in row.amounts]} for row in nodes],
        "focus": {
            **_figures(totals[-1], totals[-2], _average(totals, start)),
            "categories": [{"id": row.id, "name": row.name,
                            **_figures(row.amounts[-1], row.amounts[-2], _average(row.amounts, start))}
                           for row in roots],
            "limit_total": amount(dashboard.limit_total) if dashboard else None,
            "limited_spent": amount(dashboard.limited_spent) if dashboard else None,
            "limits": _limit_rows(dashboard.categories) if dashboard else [],
            "places": _top(sums, counts, names),
        },
        "places_year": _top(year_sums, year_counts, names),
        "recurring": [{"name": row.payment.name, "amount": amount(row.payment.amount), "currency": row.payment.currency_id,
                       "state": row.state, "paid": amount(row.spend.total) if row.spend else None}
                      for row in payments if row.state != "inactive"],
        "incomes": incomes(user, month),
        "without_rate": [{"currency": currency, "receipts": count, "total": amount(total)}
                         for currency, count, total in trends.unconverted(rows, converter)],
    }
