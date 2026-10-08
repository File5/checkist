from rest_framework.response import Response

from config.exceptions import RangeTooLarge
from receipts import basket

from .. import common, stats_common
from ..params import Params
from .recognition_base import LocalAPIView

MAX_LIMIT = 100
PERIODS_OVERLAP = "Периоды не должны пересекаться."


def _visits(visits):
    return {
        "receipts_count": visits.receipts_count,
        "total": stats_common.money(visits.total),
        "avg_receipt": stats_common.money(visits.avg_receipt),
        "median_receipt": stats_common.money(visits.median),
        "lines_count": visits.lines_count,
        "lines_per_receipt": common.decimal_string(visits.lines_per_receipt, 2),
        "paid_per_line": common.price(visits.paid_per_line),
    }


def _series(found):
    return {
        "currency": found.currency, "refunds_excluded": found.refunds_excluded,
        "buckets": [
            {"period_start": common.iso_date(bucket.period_start), **_visits(bucket.visits)}
            for bucket in found.buckets
        ],
    }


class ReceiptSeriesView(LocalAPIView):
    """Походы по времени по валютам; число запросов не зависит от объёма данных."""

    def get(self, request):
        params = Params(request.query_params)
        period = stats_common.read_period(params)
        scope = stats_common.read_scope(params)
        interval = params.interval()
        params.check()
        try:
            found = basket.series(stats_common.receipts(request, scope, period), interval)
        except basket.TooManyBuckets:
            raise RangeTooLarge() from None
        return Response({"interval": interval, **period.as_json(), "currencies": [_series(item) for item in found]})


def _side(side, period):
    visits = side.visits
    body = _visits(visits)
    return {
        "receipts_count": body.pop("receipts_count"),
        "months": common.decimal_string(basket.months(period.date_from, period.date_to), 2),
        "receipts_per_month": common.decimal_string(
            basket.per_month(visits.receipts_count, period.date_from, period.date_to), 2,
        ),
        "refunds_excluded": side.refunds_excluded,
        **body,
    }


def _effects(effects):
    if effects is None:
        return None
    return {
        "quantity": stats_common.money(effects.quantity), "price": stats_common.money(effects.price),
        "mix": stats_common.money(effects.mix), "price_per_line": stats_common.money(effects.price_per_line),
        "quantity_percent": common.percent(effects.quantity_percent),
        "price_percent": common.percent(effects.price_percent), "mix_percent": common.percent(effects.mix_percent),
    }


def _price_index(index):
    if index is None:
        return None
    return {
        "fisher": common.price(index.fisher), "laspeyres": common.price(index.laspeyres),
        "paasche": common.price(index.paasche), "matched_products": index.matched_products,
        "coverage_base_percent": common.percent(index.coverage_base_percent),
        "coverage_current_percent": common.percent(index.coverage_current_percent),
    }


def _purchase(purchase):
    return {
        "price": common.price(purchase.price), "quantity": common.quantity(purchase.quantity),
        "amount": stats_common.money(purchase.paid),
    }


def _comparison(block, base, current, names):
    return {
        "currency": block.currency,
        "base": _side(block.base, base),
        "current": _side(block.current, current),
        "change": {
            "avg_receipt": stats_common.money(block.change),
            "avg_receipt_percent": common.percent(block.change_percent),
        },
        "effects": _effects(block.effects),
        "price_index": _price_index(block.price_index),
        "products": [
            {
                "product": {"id": pair.product_id, "name": names[pair.product_id]}, "unit": pair.unit,
                "base": _purchase(pair.base), "current": _purchase(pair.current),
                "price_change_percent": common.percent(pair.price_change_percent),
            }
            for pair in block.products
        ],
        "products_total": block.products_total,
    }


class ReceiptCompareView(LocalAPIView):
    """Разложение изменения среднего чека между двумя периодами по валютам."""

    def get(self, request):
        params = Params(request.query_params)
        base = stats_common.read_period(params, "base_from", "base_to", required=True)
        current = stats_common.read_period(params, "current_from", "current_to", required=True)
        if None not in (base.date_from, base.date_to, current.date_from, current.date_to) and not params.errors:
            if base.date_to >= current.date_from:
                params.error("current_from", PERIODS_OVERLAP)
        scope = stats_common.read_scope(params)
        limit = params.integer("limit", default=20, maximum=MAX_LIMIT, message=f"Допустимо от 1 до {MAX_LIMIT}.")
        params.check()

        data = basket.collect(stats_common.receipts(request, scope), base, current, stats_common.owner_product_id())
        return Response({
            "base": base.as_json(), "current": current.as_json(),
            "currencies": [
                _comparison(block, base, current, data.names) for block in basket.compare(data, limit=limit)
            ],
        })
