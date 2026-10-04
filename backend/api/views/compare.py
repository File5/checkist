from bisect import bisect_left
from dataclasses import dataclass

from rest_framework.response import Response

from api import common
from api.pagination import COMPARE_MAX_PAGE_SIZE, COMPARE_PAGE_SIZE, paginate
from api.params import MAX_ID, Params
from api.rates import parse_conversion
from catalog.models import GenericProduct, Product
from catalog.units import Unit
from config.exceptions import ObjectNotFound
from receipts.decimal_math import change_percent, decimal_mean
from receipts.models import ReceiptLine
from receipts.prices import PriceGroup, last_prices, price_groups

from .base import ReadOnlyAPIView

SCOPES = ("generic", "category")


@dataclass
class _Offer:
    """Цены товара в одной паре «страна, валюта».

    ``comparable`` — в окне есть наблюдения с ценой за единицу сравнения ответа.
    ``last`` у сравнимого предложения — последнее сравнимое наблюдение (по его цене
    считаются место и отклонение), у несравнимого — последнее наблюдение группы.
    """

    group: PriceGroup
    comparable: bool
    last: ReceiptLine | None = None

    @property
    def key(self):
        return self.group.country, self.group.currency

    @property
    def price(self):
        """Последняя цена за единицу сравнения; ``None`` у несравнимого предложения."""
        return self.last.normalized_price if self.comparable and self.last else None

    @property
    def moment(self):
        return self.last.observed_at, self.last.receipt_id, self.last.position


def _get(queryset, pk):
    # Ключ больше BigAutoField в БД не уходит: иначе вместо 404 была бы ошибка запроса.
    if pk > MAX_ID:
        raise ObjectNotFound()
    return common.get_or_404(queryset, pk)


def _line_key(line):
    return line.product_id, line.receipt.store.country_id, line.currency_code


def _rank(prices, value):
    """Место в отсортированном списке цен: 1 — самая низкая, равные цены делят место."""
    return None if value is None else bisect_left(prices, value) + 1


def _reason(offer):
    """Почему предложение несравнимо: нет фасовки у штучной строки либо другая единица."""
    line = offer.last
    if line.normalized_unit is None and line.unit == Unit.PCS:
        return "no_package"
    return "unit_mismatch"


def _latest(offers):
    """Предложение с самым поздним последним наблюдением либо ``None``."""
    return max(offers, key=lambda offer: offer.moment, default=None)


def _diff(value, reference):
    """Отклонение ``value`` от ``reference`` в процентах; без базы или при нулевой базе — ``None``."""
    if value is None or not reference:
        return None
    return common.percent(change_percent(reference, value))


def _comparison(params, generic, base, products):
    """Тело ответа сравнения товаров ``products``; ``base`` — исходный товар либо ``None``.

    Число запросов не зависит от числа товаров: состав набора, сводка групп и
    последние сравнимые цены — по одному запросу на весь набор (место и блок
    ``groups`` считаются по всему набору, а не по странице), товары страницы и
    последние наблюдения её несравнимых предложений — по одному запросу на страницу.
    """
    countries = params.countries() or None
    date_from, date_to = params.date_range()
    conversion = parse_conversion(params)
    page_params = params.page(default=COMPARE_PAGE_SIZE, maximum=COMPARE_MAX_PAGE_SIZE)
    params.check()
    filters = dict(countries=countries, date_from=date_from, date_to=date_to)
    unit = generic.base_unit
    base_id = base and base.pk

    # Товар обобщённого продукта с другой base_unit (scope=category) с набором несравним.
    rows = list(products.order_by("name", "pk").values_list("pk", "generic__base_unit"))
    same_unit = {pk for pk, base_unit in rows if base_unit == unit}
    offers = {}
    for group in price_groups([pk for pk, _ in rows], **filters):
        has_price = group.comparable_observations > 0 and group.product_id in same_unit
        offers.setdefault(group.product_id, []).append(_Offer(group, has_price))
    comparable_ids = [pk for pk in offers if any(offer.comparable for offer in offers[pk])]
    last = {_line_key(line): line for line in last_prices(comparable_ids, comparable_only=True, **filters)}
    for pk, product_offers in offers.items():
        for offer in product_offers:
            if offer.comparable:
                offer.last = last.get((offer.group.product_id, *offer.key))
        # READ COMMITTED: группа могла исчезнуть после агрегатов.
        offers[pk] = [offer for offer in product_offers if not offer.comparable or offer.last is not None]

    # Порядок: исходный товар, сравнимые по name, id, затем несравнимые (сортировка устойчива).
    comparable = {pk for pk, product_offers in offers.items() if any(offer.comparable for offer in product_offers)}
    page = paginate(
        sorted((pk for pk, _ in rows), key=lambda pk: 0 if pk == base_id else 1 if pk in comparable else 2),
        page_params,
    )
    page_ids = page["results"]
    page_products = Product.objects.select_related("brand").in_bulk(page_ids)
    fallback_ids = [pk for pk in page_ids if any(not offer.comparable for offer in offers.get(pk, ()))]
    last = {_line_key(line): line for line in last_prices(fallback_ids, **filters)}
    for pk in fallback_ids:
        for offer in offers[pk]:
            if not offer.comparable:
                offer.last = last.get((pk, *offer.key))
        offers[pk] = [offer for offer in offers[pk] if offer.last is not None]

    # Место и сводка — внутри пары «страна, валюта»: цены разных валют не смешиваются.
    priced = [offer for product_offers in offers.values() for offer in product_offers if offer.price is not None]
    prices = {}
    for offer in priced:
        prices.setdefault(offer.key, []).append(offer.price)
    for values in prices.values():
        values.sort()
    groups = []
    for country, currency in sorted({offer.key for product_offers in offers.values() for offer in product_offers}):
        values = prices.get((country, currency), [])
        groups.append({
            "country": country, "currency": currency, "products_with_price": len(values),
            "min": common.price(values[0] if values else None),
            "max": common.price(values[-1] if values else None),
            "avg": common.price(decimal_mean(values)),
        })

    def converted(offer):
        return conversion.convert(offer.price, offer.group.currency) if conversion else None

    # Отклонение — от последней цены исходного товара в той же валюте; если такой нет,
    # а курсы заданы — от его последней пересчитанной цены.
    base_offers = [offer for offer in offers.get(base_id, ()) if offer.price is not None]
    references = {
        currency: _latest([offer for offer in base_offers if offer.group.currency == currency])
        for currency in {offer.group.currency for offer in base_offers}
    }
    converted_reference = _latest([offer for offer in base_offers if converted(offer) is not None])

    def diff(offer):
        reference = references.get(offer.group.currency)
        if reference is not None:
            return _diff(offer.price, reference.price)
        if converted_reference is not None:
            return _diff(converted(offer), converted(converted_reference))
        return None

    overall_prices = sorted(value for value in map(converted, priced) if value is not None)

    def serialize_offer(offer):
        group, line = offer.group, offer.last
        value = converted(offer)
        show = offer.comparable
        result = {
            "country": group.country,
            "currency": group.currency,
            "observations": group.observations,
            "last": {
                "normalized_price": common.price(offer.price),
                "paid_unit_price": common.price(line.paid_unit_price),
                "purchased_on": common.iso_date(line.receipt.purchased_on),
                "store": common.store_brief(line.receipt.store),
            },
            "min": common.price(group.normalized_min if show else None),
            "max": common.price(group.normalized_max if show else None),
            "avg": common.price(group.normalized_avg if show else None),
            "rank_in_group": _rank(prices.get(offer.key, []), offer.price),
            "diff_to_base_percent": diff(offer),
            "converted": None if value is None else {
                "currency": conversion.target_currency,
                "last": common.price(value),
                "min": common.price(conversion.convert(group.normalized_min, group.currency)),
                "max": common.price(conversion.convert(group.normalized_max, group.currency)),
                "avg": common.price(conversion.convert(group.normalized_avg, group.currency)),
            },
        }
        if conversion:
            result["rank_overall"] = _rank(overall_prices, value)
        if not offer.comparable:
            result["not_comparable_reason"] = _reason(offer)
        return result

    def serialize(pk):
        product = page_products[pk]
        # Наблюдение, исчезнувшее между запросами, предложением не считается.
        product_offers = [offer for offer in offers.get(pk, ()) if offer.last is not None]
        result = {
            "product": {
                "id": product.pk,
                "name": product.name,
                "brand": common.brand_brief(product.brand),
                "package": common.package(product),
                "is_base": pk == base_id,
            },
            "offers": [serialize_offer(offer) for offer in product_offers],
        }
        if not product_offers:
            result["not_comparable_reason"] = "no_observations"
        return result

    body = {
        "base": base and {"id": base.pk, "name": base.name},
        "generic": common.generic_brief(generic),
        "unit": unit,
        "conversion": conversion.as_json() if conversion else None,
    }
    if conversion:
        body["overall"] = {
            "currency": conversion.target_currency,
            "offers_with_price": len(overall_prices),
            "min": common.price(overall_prices[0] if overall_prices else None),
        }
    body["groups"] = groups
    # Товар, удалённый между запросами, в страницу не попадает.
    page["results"] = [serialize(pk) for pk in page_ids if pk in page_products]
    body.update(page)
    return body


class ProductAlternativesView(ReadOnlyAPIView):
    """``GET /api/products/{id}/alternatives/`` — исходный товар и его альтернативы."""

    def get(self, request, pk):
        base = _get(Product.objects.select_related("generic"), pk)
        params = Params(request.query_params)
        if params.choice("scope", SCOPES, default="generic") == "category":
            products = Product.objects.filter(generic__category_id=base.generic.category_id)
        else:
            products = Product.objects.filter(generic_id=base.generic_id)
        return Response(_comparison(params, base.generic, base, products))


class GenericComparisonView(ReadOnlyAPIView):
    """``GET /api/generic-products/{id}/comparison/`` — все товары обобщённого продукта, без исходного."""

    def get(self, request, pk):
        generic = _get(GenericProduct.objects.all(), pk)
        return Response(_comparison(Params(request.query_params), generic, None, generic.products.all()))
