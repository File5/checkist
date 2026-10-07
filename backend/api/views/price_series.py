"""``GET /api/products/{id}/prices/series/`` — ряды цен для графика.

Свой товар — ряд на тройку «магазин, валюта, единица»; похожие товары (видимые товары
того же обобщённого продукта) — ряд на «товар, страна, валюта, единица». Цены разных
валют и единиц в один ряд не попадают. Наблюдения и цены — ``receipts.prices.price_history``,
интервалы — тот же запрос, что у ``/prices/summary/``.
"""
from django.db.models import Count, OuterRef, Q, Subquery
from rest_framework.response import Response

from catalog.models import Product
from config.exceptions import RangeTooLarge
from merges.visibility import visible
from receipts.decimal_math import decimal_average
from receipts.prices import price_history
from receipts.spending import UNASSIGNED_NAME
from stores.models import Store

from .. import common
from ..params import Params
from ..stats_common import owner_product_id
from .base import ReadOnlyAPIView
from .prices import MAX_INTERVALS, PRICES, _product, _summary_rows

INTERVALS = ("month", "day", "week")
PRICE_KINDS = ("paid", "normalized")
SIMILAR = ("generic", "none")
SIMILAR_LIMIT = 8
MAX_SIMILAR = 20
MAX_OWN_SERIES = 20
MAX_POINTS = MAX_INTERVALS  # на весь ответ: свои и похожие ряды вместе

_STORE, _COUNTRY, _CURRENCY = "receipt__store_id", "receipt__store__country_id", "receipt__currency_id"


def _observations(params):
    """Наблюдения всех товаров по фильтрам запроса с владельцем строки ``owner``.

    ``owner`` — оставляемый товар вместо поглощённого слиянием: «отбившаяся» строка
    относится к нему. Ошибки параметров копятся в ``params``.
    """
    date_from, date_to = params.date_range()
    countries = params.countries()
    currency = params.currency()
    lines = price_history(date_from=date_from, date_to=date_to).annotate(owner=owner_product_id())
    if countries:
        lines = lines.filter(**{f"{_COUNTRY}__in": countries})
    if currency is not None:
        lines = lines.filter(**{_CURRENCY: currency})
    return lines


def _grouped(rows, keys):
    """``{ключ ряда: строки интервалов}``; порядок рядов и интервалов — как в ``rows``."""
    grouped = {}
    for row in rows:
        grouped.setdefault(tuple(row[key] for key in keys), []).append(row)
    return grouped


def _series(role, product, store, country, currency, unit, rows, value_field, base_unit):
    return {
        "role": role,
        "product": {"id": product[0], "name": product[1]},
        "store": store,
        "country": country,
        "currency": currency,
        "unit": unit,
        # Сравнима только нормализованная цена за базовую единицу обобщённого продукта.
        "comparable": value_field == "normalized_price" and unit == base_unit,
        "observations": sum(row["bucket_count"] for row in rows),
        "points": [
            {
                "period_start": common.iso_date(row["period"]),
                "count": row["bucket_count"],
                "min": common.price(row["bucket_min"]),
                "max": common.price(row["bucket_max"]),
                "avg": common.price(decimal_average(row["bucket_sum"], row["bucket_count"])),
                "last": common.price(row[value_field]),
            }
            for row in rows
        ],
    }


def _own(lines, interval, value_field, unit_field):
    """Интервалы рядов своего товара и признак усечения. До двух запросов.

    Рядов не больше ``MAX_OWN_SERIES`` — с наибольшим числом наблюдений, затем по
    магазину, валюте и единице.
    """
    keys = (_STORE, _CURRENCY, unit_field)
    heads = list(
        lines.order_by().values(*keys).annotate(observations=Count("pk"))
        .order_by("-observations", *keys)[:MAX_OWN_SERIES + 1]
    )
    if not heads:
        return {}, False
    truncated = len(heads) > MAX_OWN_SERIES
    if truncated:
        chosen = Q()
        for head in heads[:MAX_OWN_SERIES]:
            chosen |= Q(**{key: head[key] for key in keys})
        lines = lines.filter(chosen)
    return _grouped(_summary_rows(lines, keys, interval, value_field), keys), truncated


def _similar_products(lines, product, limit):
    """Число похожих товаров с наблюдениями и первые ``limit`` из них. Два запроса.

    Похожие — видимые товары того же обобщённого продукта, кроме самого товара; порядок —
    по числу наблюдений в окне, затем ``name``, ``id``.
    """
    candidates = visible(Product.objects.filter(generic=product.generic_id)).exclude(pk=product.pk)
    ranked = (
        lines.filter(owner__in=candidates.values("pk")).order_by()
        .annotate(owner_name=Subquery(Product.objects.filter(pk=OuterRef("owner")).values("name")[:1]))
        .values("owner", "owner_name").annotate(observations=Count("pk"))
    )
    return ranked.count(), list(ranked.order_by("-observations", "owner_name", "owner")[:limit])


class ProductPriceSeriesView(ReadOnlyAPIView):
    """``GET /api/products/{id}/prices/series/`` — ряды цен товара и похожих товаров."""

    def get(self, request, pk):
        product = _product(pk)
        params = Params(request.query_params)
        lines = _observations(params)
        interval = params.choice("interval", INTERVALS, default="month")
        price = params.choice("price", PRICE_KINDS, default="paid")
        similar = params.choice("similar", SIMILAR, default="generic")
        limit = params.integer(
            "similar_limit", default=SIMILAR_LIMIT, maximum=MAX_SIMILAR, message=f"Допустимо от 1 до {MAX_SIMILAR}.",
        )
        params.check()

        generic = product.generic
        value_field, unit_field = PRICES[price]
        skipped = 0
        if price == "normalized":
            skipped = lines.filter(owner=product.pk, normalized_price__isnull=True).count()
            lines = lines.filter(normalized_price__isnull=False)

        own, truncated = _own(lines.filter(owner=product.pk), interval, value_field, unit_field)
        points = sum(len(rows) for rows in own.values())
        stores = Store.objects.select_related("merchant").in_bulk({key[0] for key in own}) if own else {}
        series = [
            _series(
                "own", (product.pk, product.name), common.store_brief(stores[store_id]), stores[store_id].country_id,
                currency, unit, rows, value_field, generic.base_unit,
            )
            for (store_id, currency, unit), rows in own.items()
        ]
        # Сортировка устойчива: при равном числе наблюдений остаётся порядок «магазин, валюта, единица».
        series.sort(key=lambda entry: -entry["observations"])

        status, total, shown = "ok", 0, []
        if similar == "none":
            status = "disabled"
        elif generic.name.casefold() == UNASSIGNED_NAME.casefold():
            status = "generic_unassigned"
        else:
            total, shown = _similar_products(lines, product, limit)
            if not total:
                status = "none"
        if shown:
            names = {row["owner"]: row["owner_name"] for row in shown}
            keys = ("owner", _COUNTRY, _CURRENCY, unit_field)
            rows = _summary_rows(lines.filter(owner__in=list(names)), keys, interval, value_field)
            if points + len(rows) > MAX_POINTS:
                raise RangeTooLarge()
            entries = [
                _series(
                    "similar", (owner, names[owner]), None, country, currency, unit, rows, value_field,
                    generic.base_unit,
                )
                for (owner, country, currency, unit), rows in _grouped(rows, keys).items()
            ]
            # Строки идут по «товар, страна, валюта, единица»; устойчивая сортировка ставит товары по name, id.
            entries.sort(key=lambda entry: (entry["product"]["name"], entry["product"]["id"]))
            series += entries

        return Response({
            "product": {"id": product.pk, "name": product.name, "base_unit": generic.base_unit},
            "generic": common.generic_brief(generic),
            "price": price,
            "interval": interval,
            "skipped_without_normalized": skipped,
            "series": series,
            "own_truncated": truncated,
            "similar": {"status": status, "products_total": total, "products_shown": len(shown)},
        })
