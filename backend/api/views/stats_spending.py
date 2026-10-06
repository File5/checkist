from rest_framework.response import Response

from receipts import spending
from stores.models import Store

from .. import common, stats_common
from ..params import Params
from .recognition_base import LocalAPIView

MAX_LIMIT = 50


def _item(item):
    return {
        "kind": item.kind, "id": item.id, "name": item.name,
        "direct": item.direct, "unassigned": item.unassigned,
        "amount": stats_common.money(item.amount), "share_percent": common.percent(item.share_percent),
        "lines_count": item.lines_count, "receipts_count": item.receipts_count,
        "quantity": common.quantity(item.quantity), "unit": item.unit,
        **item.extra,
    }


def _block(block):
    other = block.other
    return {
        "currency": block.currency,
        "totals": {
            "receipts_count": block.receipts_count,
            "receipts_total": stats_common.money(block.receipts_total),
            "lines_paid": stats_common.money(block.lines_paid),
            "difference": stats_common.money(block.difference),
        },
        "items": [_item(item) for item in block.items],
        "other": other and {
            "count": other.count, "amount": stats_common.money(other.amount),
            "share_percent": common.percent(other.share_percent),
        },
    }


class SpendingView(LocalAPIView):
    """Траты за период по валютам; число запросов не зависит от объёма данных."""

    def get(self, request):
        params = Params(request.query_params)
        period = stats_common.read_period(params)
        scope = stats_common.read_scope(params)
        group_by = params.choice("group_by", spending.GROUPS, default="category")
        category, generic = params.integer("category"), params.integer("generic")
        limit = params.integer("limit", default=10, maximum=MAX_LIMIT, message=f"Допустимо от 1 до {MAX_LIMIT}.")
        params.check()

        head = {"group_by": group_by, **period.as_json(), "parent": None}
        tree = common.CategoryTree.load() if group_by == "category" or category is not None else None
        if category is not None:
            if category not in tree:  # как в списках каталога: пусто, не ошибка
                return Response({**head, "currencies": []})
            head["parent"] = tree.category(category)
        data = spending.collect(stats_common.receipts(scope, period), stats_common.owner_product_id())
        stores = None
        if group_by == "store":
            ids = {row.store_id for row in data.receipts}
            stores = {
                store.pk: common.store_brief(store)
                for store in Store.objects.filter(pk__in=ids).select_related("merchant")
            }
        blocks = spending.summarize(
            data, group_by=group_by, limit=limit, tree=tree, category=category, generic=generic, stores=stores,
        )
        return Response({**head, "currencies": [_block(block) for block in blocks]})
