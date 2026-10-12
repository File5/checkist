"""История лимитов: ``GET /api/budget/limits/history/``.

Доступ и видимость — как у ``/api/budget/limits/``: журнал владельца лимитов запроса
(семьи либо своих, ``limits_q``). Окно — ``from`` … ``to`` (``ГГГГ-ММ``, как у «Динамики»:
без ``to`` — текущий месяц сервера, без ``from`` — с месяца первого изменения, но не меньше
12 месяцев до ``to`` и не больше 60).
``category`` — точная категория (без потомков), ``currency`` — код валюты. Ответ: изменения
с месяцем действия в окне, новые сверху, и по каждой паре «категория и валюта» ряд суммы
лимита по месяцам окна. Число запросов от объёма данных не зависит.
"""
import re
from decimal import ROUND_HALF_UP, Decimal

from django.utils import timezone
from rest_framework.response import Response

from accounts.people import person
from budget import history
from budget.access import limits_q
from budget.models import BudgetLimitChange
from receipts import trends

from .. import common, stats_common
from ..params import Params
from .budget import visible_limits
from .recognition_base import LocalAPIView
from .stats_trends import _head, _period

CURRENCY_MESSAGE = "Валюта — три латинские буквы."
_CURRENCY = re.compile(r"[A-Za-z]{3}")
_CENT = Decimal("0.01")


def _kind(change):
    if change.old_amount is None:
        return "created"
    return "deleted" if change.new_amount is None else "changed"


def _change_percent(change):
    if change.old_amount is None or change.new_amount is None:
        return None
    return ((change.new_amount - change.old_amount) * 100 / change.old_amount).quantize(_CENT, ROUND_HALF_UP)


def _category(tree, category_id, category):
    if category_id in tree:
        return tree.category(category_id)
    return {"id": category_id, "name": category.name, "path": [{"id": category_id, "name": category.name}]}


def _change_object(tree, change):
    return {
        "id": change.pk, "changed_at": common.utc_datetime(change.changed_at),
        "effective_month": trends.label(change.effective_month), "kind": _kind(change),
        "category": _category(tree, change.category_id, change.category), "currency": change.currency_id,
        "old_amount": stats_common.money(change.old_amount), "new_amount": stats_common.money(change.new_amount),
        "change_percent": common.percent(_change_percent(change)),
        "changed_by": None if change.changed_by is None else person(change.changed_by),
    }


class LimitHistoryView(LocalAPIView):
    """Журнал лимитов семьи (или своих) и ряд суммы каждого лимита по месяцам окна."""

    def get(self, request):
        params = Params(request.query_params)
        months = _period(params, timezone.localdate())
        category = params.integer("category", message="Ожидается идентификатор категории.")
        currency = params.raw("currency")
        if currency is not None and not _CURRENCY.fullmatch(currency):
            params.error("currency", CURRENCY_MESSAGE)
        params.check()
        filters = {}
        if category is not None:
            filters["category_id"] = category
        if currency is not None:
            filters["currency_id"] = currency.upper()
        tree = common.CategoryTree.load()
        limits = list(visible_limits(request).filter(**filters).order_by("pk"))
        changes = list(BudgetLimitChange.objects.filter(limits_q(request), **filters)
                       .select_related("category", "changed_by"))
        if params.raw("from") is None and changes:
            # Без from окно начинается с первого изменения (не короче 12 месяцев и не длиннее 60): вся история.
            start = max(min(change.effective_month for change in changes), trends.shift(months[-1], 1 - trends.MAX_MONTHS))
            if start < months[0]:
                months = trends.window(months[-1], trends.months_between(start, months[-1]))
        listed = sorted((change for change in changes if months[0] <= change.effective_month <= months[-1]),
                        key=lambda change: (change.changed_at, change.pk), reverse=True)
        order = {pk: index for index, pk in enumerate(tree.ordered_ids())}
        rows = sorted(history.series(limits, changes, months),
                      key=lambda row: (row.currency, order.get(row.category_id, len(order)), row.category_id))
        names = {change.category_id: change.category for change in changes}
        names.update((limit.category_id, limit.category) for limit in limits)
        return Response({
            **_head(months),
            "changes": [_change_object(tree, change) for change in listed],
            "series": [
                {
                    "category": _category(tree, row.category_id, names[row.category_id]),
                    "currency": row.currency,
                    "limit_id": None if row.limit is None else row.limit.pk,
                    "amount": stats_common.money(None if row.limit is None else row.limit.amount),
                    "months": [
                        {"month": trends.label(first), "amount": stats_common.money(amount)}
                        for first, amount in zip(months, row.amounts)
                    ],
                }
                for row in rows
            ],
        })
