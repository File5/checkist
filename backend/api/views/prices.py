from decimal import Decimal

from django.db.models import Count, DateField, F, Max, Min, Sum, Window
from django.db.models.functions import FirstValue, Trunc
from rest_framework.response import Response

from catalog.models import Product
from config.exceptions import ObjectNotFound, RangeTooLarge
from merges.visibility import visible
from receipts.decimal_math import change_percent, decimal_average, price_context
from receipts.prices import price_history
from stores.models import Store

from .. import common
from ..pagination import HISTORY_MAX_PAGE_SIZE, HISTORY_PAGE_SIZE, paginate
from ..params import MAX_ID, Params
from ..projection import own_annotation
from .base import ReadOnlyAPIView

# Порядок наблюдений: момент покупки, затем чек и позиция — стабилен при равных моментах.
_OBSERVED = ("receipt__purchased_at", "receipt_id", "position")
ORDERINGS = {
    "observed_at": _OBSERVED,
    "-observed_at": ("-receipt__purchased_at", "receipt_id", "position"),
}
# group_by -> поля ключа группы; валюта и единица цены входят в ключ всегда.
GROUPS = {
    "country": ("receipt__store__country_id",),
    "store": ("receipt__store_id",),
    "none": (),
}
INTERVALS = ("none", "day", "week", "month")
# price -> (цена наблюдения, её единица): аннотации price_history либо поля строки.
PRICES = {
    "paid": ("paid_unit_price", "unit"),
    "list": ("unit_price", "unit"),
    "normalized": ("normalized_price", "normalized_unit"),
}
MAX_INTERVALS = 1000
# Не нужны ответу и не должны в него попасть: текст чека, фискальные реквизиты, «прочее».
_DEFERRED = (
    "extra", "name_i18n", "receipt__raw_text", "receipt__fiscal", "receipt__extra",
    "receipt__store__address_i18n", "receipt__store__merchant__extra",
)


def _product(pk):
    """Товар с обобщённым продуктом либо ``404 not_found``; поглощённый слиянием — тоже ``404``."""
    if pk > MAX_ID:
        raise ObjectNotFound()
    return common.get_or_404(visible(Product.objects.select_related("generic")), pk)


def _product_brief(product):
    return {"id": product.pk, "name": product.name, "base_unit": product.generic.base_unit}


def _observations(product, params):
    """Наблюдения цены товара с общими фильтрами обоих эндпоинтов.

    Ошибки параметров копятся в ``params``; пока вызывающий код не вызвал
    ``params.check()``, запрос к строкам не выполняется.
    """
    date_from, date_to = params.date_range()
    country = params.country()
    currency = params.currency()
    store = params.object_id("store", Store.objects.all(), message="Магазин не найден.")
    lines = price_history(product=product, store=store, country=country, date_from=date_from, date_to=date_to)
    if currency is not None:
        lines = lines.filter(receipt__currency=currency)
    return lines


def _point(line, base_unit):
    """Точка истории цен; ``line.own`` — аннотация ``own_annotation``.

    У чужого наблюдения нет полей, по которым находится чек: точного момента, количества,
    скидки, id чека и позиции. Цена, день и магазин общие.
    """
    own = line.own
    return {
        "observed_at": common.utc_datetime(line.observed_at) if own else None,
        "purchased_on": common.iso_date(line.receipt.purchased_on),
        "store": common.store_brief(line.receipt.store),
        "currency": line.currency_code,
        "quantity": common.quantity(line.quantity) if own else None,
        "unit": line.unit,
        "list_unit_price": common.price(line.list_unit_price),
        "paid_unit_price": common.price(line.paid_unit_price),
        "discount_amount": common.amount(line.discount_amount) if own else None,
        "normalized_price": common.price(line.normalized_price),
        "normalized_unit": line.normalized_unit,
        "comparable": line.normalized_unit is not None and line.normalized_unit == base_unit,
        "receipt_id": line.receipt_id if own else None,
        "position": line.position if own else None,
        "own": own,
    }


class ProductPricesView(ReadOnlyAPIView):
    """``GET /api/products/{id}/prices/`` — точки истории цен товара."""

    def get(self, request, pk):
        product = _product(pk)
        params = Params(request.query_params)
        lines = _observations(product, params)
        ordering = params.choice("ordering", tuple(ORDERINGS), default="observed_at")
        page = params.page(default=HISTORY_PAGE_SIZE, maximum=HISTORY_MAX_PAGE_SIZE)
        params.check()

        # Порядок считает сервер по всем наблюдениям: чужие точки стоят на своих местах.
        lines = (
            lines.annotate(own=own_annotation(request)).select_related("receipt__store__merchant")
            .defer(*_DEFERRED).order_by(*ORDERINGS[ordering])
        )
        base_unit = product.generic.base_unit
        body = paginate(lines, page, lambda line: _point(line, base_unit))
        return Response({"product": _product_brief(product), **body})


def _summary_rows(lines, keys, interval, value_field):
    """Строка на интервал каждой группы — одним запросом, то есть на одном снимке данных.

    Агрегаты интервала и первое наблюдение группы считают оконные функции, а
    ``DISTINCT ON`` оставляет от интервала его последнее наблюдение — по порядку
    ``(observed_at, receipt_id, position)``. При ``interval=none`` интервал один на группу.
    """
    bucket_keys = keys
    if interval != "none":
        # Усечение локальной даты чека: от часового пояса сервера не зависит; неделя — с понедельника.
        period = F("receipt__purchased_on") if interval == "day" else Trunc(
            "receipt__purchased_on", interval, output_field=DateField(),
        )
        lines = lines.annotate(period=period)
        bucket_keys = (*keys, "period")
    bucket = [F(key) for key in bucket_keys]
    group = [F(key) for key in keys] or None
    first = [F(field).asc() for field in _OBSERVED]
    rows = (
        lines.annotate(
            bucket_count=Window(Count("pk"), partition_by=bucket or None),
            bucket_min=Window(Min(value_field), partition_by=bucket or None),
            bucket_max=Window(Max(value_field), partition_by=bucket or None),
            bucket_sum=Window(Sum(value_field), partition_by=bucket or None),
            first_price=Window(FirstValue(value_field), partition_by=group, order_by=first),
            first_on=Window(FirstValue("receipt__purchased_on"), partition_by=group, order_by=first),
        )
        .order_by(*bucket_keys, *(f"-{field}" for field in _OBSERVED))
        .distinct(*bucket_keys)
        .values(
            *bucket_keys, value_field, "receipt__purchased_on", "receipt__purchased_at", "receipt_id", "position",
            "bucket_count", "bucket_min", "bucket_max", "bucket_sum", "first_price", "first_on",
        )
    )
    if interval == "none":
        return list(rows)
    rows = list(rows[:MAX_INTERVALS + 1])
    if len(rows) > MAX_INTERVALS:
        raise RangeTooLarge()
    return rows


def _change_percent(first, last, count):
    if count < 2 or first == 0:
        return None
    return common.percent(change_percent(first, last))


def _group(rows, interval, value_field):
    """Итог и интервалы одной группы из её строк, идущих по возрастанию интервала."""
    count = sum(row["bucket_count"] for row in rows)
    with price_context():
        total = sum((row["bucket_sum"] for row in rows), Decimal(0))
    # Локальная дата и момент в UTC упорядочены по-разному, если в группе магазины разных
    # часовых поясов: последнее наблюдение группы не обязано лежать в последнем интервале.
    last = max(rows, key=lambda row: (row["receipt__purchased_at"], row["receipt_id"], row["position"]))
    first_price, last_price = rows[0]["first_price"], last[value_field]
    return {
        "total": {
            "count": count,
            "min": common.price(min(row["bucket_min"] for row in rows)),
            "max": common.price(max(row["bucket_max"] for row in rows)),
            "avg": common.price(decimal_average(total, count)),
            "first": {"price": common.price(first_price), "purchased_on": common.iso_date(rows[0]["first_on"])},
            "last": {
                "price": common.price(last_price),
                "purchased_on": common.iso_date(last["receipt__purchased_on"]),
            },
            "change_percent": _change_percent(first_price, last_price, count),
        },
        "buckets": [] if interval == "none" else [
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


class ProductPriceSummaryView(ReadOnlyAPIView):
    """``GET /api/products/{id}/prices/summary/`` — агрегаты цен товара по группам и интервалам."""

    def get(self, request, pk):
        product = _product(pk)
        params = Params(request.query_params)
        lines = _observations(product, params)
        group_by = params.choice("group_by", tuple(GROUPS), default="country")
        interval = params.choice("interval", INTERVALS, default="none")
        price = params.choice("price", tuple(PRICES), default="paid")
        params.check()

        body = {"product": _product_brief(product), "price": price, "group_by": group_by, "interval": interval}
        value_field, unit_field = PRICES[price]
        if price == "normalized":
            body["skipped_without_normalized"] = lines.filter(normalized_price__isnull=True).count()
            lines = lines.filter(normalized_price__isnull=False)

        # Валюта и единица — в ключе всегда: цены разных валют и единиц не смешиваются.
        keys = (*GROUPS[group_by], "receipt__currency_id", unit_field)
        grouped = {}
        for row in _summary_rows(lines, keys, interval, value_field):
            grouped.setdefault(tuple(row[key] for key in keys), []).append(row)

        stores = {}
        if group_by == "store" and grouped:
            stores = Store.objects.select_related("merchant").in_bulk({key[0] for key in grouped})
        groups = []
        for key, rows in grouped.items():
            *owner, currency, unit = key
            if group_by == "country":
                head = {"country": owner[0]}
            elif group_by == "store":
                head = {"store": common.store_object(stores[owner[0]])}
            else:
                head = {}
            groups.append({**head, "currency": currency, "unit": unit, **_group(rows, interval, value_field)})
        body["groups"] = groups
        return Response(body)
