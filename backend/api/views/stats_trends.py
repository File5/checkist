"""«Динамика»: траты по месяцам, одна категория во времени и индекс цен семьи.

Доступ и чеки — как у прочих ``/api/stats/*``: чеки пользователя запроса и его семьи
(``owner_q``). Окно — ``months`` месяцев (1–36, по умолчанию 12), последний — ``month``
(``ГГГГ-ММ``, по умолчанию текущий месяц сервера). Число запросов к БД от объёма данных
не зависит.
"""
from django.utils import timezone
from rest_framework.response import Response

from catalog.models import Product
from config.exceptions import ObjectNotFound
from receipts import trends

from .. import common, stats_common
from ..params import Params
from .budget import read_month, visible_limits
from .recognition_base import LocalAPIView

MONTHS_MESSAGE = f"Допустимо от 1 до {trends.MAX_MONTHS}."


def _window(params):
    """``(месяцы окна, параметры)``; ошибки копятся в ``params``."""
    end = read_month(params, timezone.localdate())
    count = params.integer("months", default=trends.DEFAULT_MONTHS, maximum=trends.MAX_MONTHS, message=MONTHS_MESSAGE)
    return end, count


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
        end, count = _window(params)
        params.check()
        months = trends.window(end.first, count)
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
        end, count = _window(params)
        category = params.integer("category")
        params.check()
        months = trends.window(end.first, count)
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


class TrendsLimitsView(LocalAPIView):
    """Лимиты пользователя и семьи и их исполнение в каждом месяце окна (текущая сумма лимита)."""

    def get(self, request):
        params = Params(request.query_params)
        end, count = _window(params)
        params.check()
        months = trends.window(end.first, count)
        tree = common.CategoryTree.load()
        limits = [
            (limit.pk, limit.category_id, limit.currency_id, limit.amount)
            for limit in visible_limits(request).order_by("pk")
        ]
        rows = trends.collect_spending(_receipts(request), months, stats_common.owner_product_id()) if limits else None
        history = trends.limit_history(rows, months, tree, limits) if limits else []
        return Response({
            **_head(months),
            "limits": [
                {
                    "id": row.id,
                    "category": tree.category(row.category_id) if row.category_id in tree else None,
                    "currency": row.currency, "amount": stats_common.money(row.amount),
                    "months": [
                        {"month": trends.label(first), "spent": stats_common.money(spent), "percent": common.percent(percent)}
                        for first, spent, percent in zip(months, row.spent, row.percents)
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
        end, count = _window(params)
        params.check()
        months = trends.window(end.first, count)
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
