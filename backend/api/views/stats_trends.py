"""«Динамика»: траты по месяцам, одна категория во времени и индекс цен семьи.

Доступ и чеки — как у прочих ``/api/stats/*``: чеки пользователя запроса и его семьи
(``owner_q``). Окно — либо ``from`` … ``to`` (``ГГГГ-ММ``, оба включительно, не больше
``MAX_MONTHS`` месяцев; без ``to`` — текущий месяц сервера, без ``from`` — 12 месяцев до ``to``),
либо по-старому ``months`` месяцев (1–``MAX_MONTHS``, по умолчанию 12), последний — ``month``
(по умолчанию текущий месяц сервера); смешивать два способа нельзя. Число запросов к БД
от объёма данных не зависит. ``range/`` — первый и последний месяц с чеками и текущий месяц
сервера: из них клиент строит «Всё время» и прочие готовые периоды.
"""
import re
from datetime import date

from django.db.models import Max, Min
from django.utils import timezone
from rest_framework.response import Response

from catalog.models import Product
from budget import history as budget_history
from budget.access import limits_q
from budget.models import BudgetLimitChange
from config.exceptions import ObjectNotFound
from receipts import trends

from .. import common, stats_common
from ..params import Params
from .budget import read_month, visible_limits
from .recognition_base import LocalAPIView

MONTHS_MESSAGE = f"Допустимо от 1 до {trends.MAX_MONTHS}."
MONTH_MESSAGE = "Месяц в формате ГГГГ-ММ."
MIXED_MESSAGE = "Укажите либо from и to, либо months и month."
ORDER_MESSAGE = "Начало периода позже конца."
SPAN_MESSAGE = f"Период — не больше {trends.MAX_MONTHS} месяцев."
_MONTH = re.compile(r"([0-9]{4})-([0-9]{2})")


def _month(params, name):
    """Первое число месяца ``name`` (``ГГГГ-ММ``) либо ``None``; ошибка копится в ``params``."""
    raw = params.raw(name)
    if raw is None:
        return None
    match = _MONTH.fullmatch(raw)
    if match is None or not (1901 <= int(match[1]) <= 9999 and 1 <= int(match[2]) <= 12):
        params.error(name, MONTH_MESSAGE)
        return None
    return date(int(match[1]), int(match[2]), 1)


def _period(params, today):
    """Окно ``from`` … ``to``; ``None`` при ошибке (она уже в ``params``)."""
    if params.raw("months") is not None or params.raw("month") is not None:
        params.error("from", MIXED_MESSAGE)
        return None
    start, end = _month(params, "from"), _month(params, "to")
    if (start is None and params.raw("from") is not None) or (end is None and params.raw("to") is not None):
        return None
    end = end or trends.month_start(today)
    start = start or trends.shift(end, 1 - trends.DEFAULT_MONTHS)
    if start > end:
        params.error("to" if params.raw("to") is not None else "from", ORDER_MESSAGE)
        return None
    count = trends.months_between(start, end)
    if count > trends.MAX_MONTHS:
        params.error("from", SPAN_MESSAGE)
        return None
    return trends.window(end, count)


def _window(params):
    """Первые числа месяцев окна по возрастанию; при ошибке — ``None``, ошибки копятся в ``params``."""
    today = timezone.localdate()
    if params.raw("from") is not None or params.raw("to") is not None:
        return _period(params, today)
    end = read_month(params, today)
    count = params.integer("months", default=trends.DEFAULT_MONTHS, maximum=trends.MAX_MONTHS, message=MONTHS_MESSAGE)
    return None if end is None or count is None else trends.window(end.first, count)


def _head(months):
    return {"months": len(months), "month_from": trends.label(months[0]), "month_to": trends.label(months[-1])}


def _receipts(request):
    return stats_common.receipts(request, stats_common.Scope())


def _label(first):
    return None if first is None else trends.label(first)


def _amounts(values):
    return [stats_common.money(value) for value in values]


def _row(row):
    return {
        "id": row.id, "name": row.name, "parent_id": row.parent_id, "depth": row.depth, "direct": row.direct,
        "total": stats_common.money(row.total), "amounts": _amounts(row.amounts),
        "change_percent": common.percent(row.change_percent),
        "average": stats_common.money(row.average),
        "change_percents": [common.percent(value) for value in row.change_percents],
    }


def _summary(summary):
    return {
        "month": trends.label(summary.month), "spent": stats_common.money(summary.spent),
        "previous_month": _label(summary.previous_month), "previous": stats_common.money(summary.previous),
        "change_percent": common.percent(summary.change_percent),
        "average_change_percent": common.percent(summary.average_change_percent),
    }


def _monthly_block(block):
    return {
        "currency": block.currency,
        "total": stats_common.money(block.total),
        "average": stats_common.money(block.average),
        "categories": [
            {"id": entry.id, "name": entry.name, "unassigned": entry.unassigned, "total": stats_common.money(entry.total)}
            for entry in block.categories
        ],
        "months": [
            {
                "month": trends.label(spend.month),
                "total": stats_common.money(spend.total),
                "categories": [
                    {"id": entry.id, "amount": stats_common.money(spend.categories[entry.id])}
                    for entry in block.categories if entry.id in spend.categories
                ],
                "uncategorized": stats_common.money(spend.uncategorized),
            }
            for spend in block.months
        ],
        "summary": _summary(block.summary),
        "rows": [_row(row) for row in block.rows],
    }


class TrendsMonthlyView(LocalAPIView):
    """Траты по корневым категориям на каждый месяц окна, по валютам."""

    def get(self, request):
        params = Params(request.query_params)
        months = _window(params)
        params.check()
        tree = common.CategoryTree.load()
        rows = trends.collect_spending(_receipts(request), months, stats_common.owner_product_id())
        return Response({
            **_head(months), "currencies": stats_common.primary_first(
                request, [_monthly_block(block) for block in trends.monthly(rows, months, tree)]),
        })


def _option(tree, pk):
    return {"id": pk, "name": tree.name(pk), "path": [node["name"] for node in tree.path(pk)], "depth": tree.depth(pk)}


class TrendsCategoryView(LocalAPIView):
    """Траты одной категории с потомками на каждый месяц окна, по валютам; без ``category`` — предложенная."""

    def get(self, request):
        params = Params(request.query_params)
        months = _window(params)
        category = params.integer("category")
        params.check()
        tree = common.CategoryTree.load()
        if category is not None and category not in tree:
            raise ObjectNotFound()
        rows = trends.collect_spending(_receipts(request), months, stats_common.owner_product_id())
        spent = trends.spent_categories(rows, tree)
        suggested = category is None
        if suggested:
            category = trends.suggested_category(rows, tree)
        blocks = [] if category is None else stats_common.primary_first(
            request, trends.category_series(rows, months, tree, category))
        return Response({
            **_head(months),
            "category": None if category is None else tree.category(category),
            "suggested": suggested,
            "options": [_option(tree, pk) for pk in tree.ordered_ids() if pk in spent],
            "currencies": [
                {
                    "currency": block.currency,
                    "total": stats_common.money(block.total),
                    "average": stats_common.money(block.average),
                    "months": [
                        {"month": trends.label(spend.month), "amount": stats_common.money(spend.amount),
                         "lines_count": spend.lines_count}
                        for spend in block.months
                    ],
                    "parts": [_row(row) for row in block.parts],
                }
                for block in blocks
            ],
        })


def _limit_month(first, spent, percent, limit, changed):
    before_after = changed.get(first)
    return {
        "month": trends.label(first), "spent": stats_common.money(spent), "percent": common.percent(percent),
        "limit": stats_common.money(limit),
        "change": None if before_after is None else {
            "old": stats_common.money(before_after[0]), "new": stats_common.money(before_after[1])},
    }


class TrendsLimitsView(LocalAPIView):
    """Лимиты пользователя и семьи и их исполнение в каждом месяце окна — суммой лимита того месяца.

    Строка — пара «категория и валюта» с лимитом сейчас либо хотя бы в одном месяце окна
    (удалённый лимит — ``id`` и ``amount`` ``null``). У месяца — ``limit`` (сумма того месяца,
    ``null`` — лимита не было, тогда и ``percent`` ``null``) и ``change`` — ``{old, new}``,
    если лимит в этом месяце менялся.
    """

    def get(self, request):
        params = Params(request.query_params)
        months = _window(params)
        params.check()
        tree = common.CategoryTree.load()
        limits = list(visible_limits(request).order_by("pk"))
        changes = list(BudgetLimitChange.objects.filter(limits_q(request)))
        series = budget_history.series(limits, changes, months)
        rows = trends.collect_spending(_receipts(request), months, stats_common.owner_product_id()) if series else None
        history = trends.limit_history(rows, months, tree, series) if series else []
        return Response({
            **_head(months),
            "limits": [
                {
                    "id": row.id,
                    "category": tree.category(row.category_id) if row.category_id in tree else None,
                    "currency": row.currency, "amount": stats_common.money(row.amount),
                    "months": [
                        _limit_month(first, spent, percent, limit, row.changed)
                        for first, spent, percent, limit in zip(months, row.spent, row.percents, row.amounts)
                    ],
                }
                for row in history
            ],
        })


def _mover(mover, names):
    return {
        "product": {"id": mover.product_id, "name": names[mover.product_id]}, "unit": mover.unit,
        "old": {"month": trends.label(mover.old_month), "price": common.price(mover.old_price)},
        "new": {"month": trends.label(mover.new_month), "price": common.price(mover.new_price)},
        "change_percent": common.percent(mover.change_percent),
    }


def _point(point):
    return {
        "month": trends.label(point.month),
        "index": common.percent(point.index),
        "base_month": None if point.base_month is None else trends.label(point.base_month),
        "link_percent": common.percent(point.link_percent),
        "matched_products": point.matched_products,
    }


class TrendsPricesView(LocalAPIView):
    """Цепной индекс цен по товарам, купленным в соседних месяцах, и самые заметные изменения цен."""

    def get(self, request):
        params = Params(request.query_params)
        months = _window(params)
        params.check()
        product_ref = stats_common.owner_product_id()
        purchases = trends.collect_purchases(_receipts(request), months, product_ref)
        names = dict(Product.objects.filter(pk__in=trends.product_ids(purchases)).values_list("pk", "name"))
        blocks = stats_common.primary_first(request, trends.price_trend(purchases, months, names))
        return Response({
            **_head(months),
            "currencies": [
                {
                    "currency": block.currency,
                    "first_month": None if block.first_month is None else trends.label(block.first_month),
                    "points": [_point(point) for point in block.points],
                    "products_total": block.products_total,
                    "risen_total": block.risen_total,
                    "fallen_total": block.fallen_total,
                    "index_month": None if block.last_point is None else trends.label(block.last_point.month),
                    "change_percent": common.percent(block.change_percent),
                    "risers": [_mover(mover, names) for mover in block.risers],
                    "fallers": [_mover(mover, names) for mover in block.fallers],
                }
                for block in blocks
            ],
        })


class TrendsRangeView(LocalAPIView):
    """Первый и последний месяц чеков пользователя и семьи, текущий месяц сервера и наибольшее окно; один запрос."""

    def get(self, request):
        found = _receipts(request).aggregate(first=Min("purchased_on"), last=Max("purchased_on"))
        return Response({
            "first_month": None if found["first"] is None else trends.label(found["first"]),
            "last_month": None if found["last"] is None else trends.label(found["last"]),
            "current_month": trends.label(timezone.localdate()),
            "max_months": trends.MAX_MONTHS,
        })
