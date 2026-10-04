from django.db.models import CharField, Count, Exists, F, Max, OuterRef, Q, Value
from django.db.models.functions import Cast, Coalesce, Concat, NullIf
from rest_framework.response import Response

from api.common import (
    CategoryTree, brand_brief, generic_brief, get_or_404, iso_date, package, price, store_name, store_object,
    utc_datetime,
)
from api.pagination import paginate
from api.params import MAX_ID, Params
from catalog.models import Brand, GenericProduct, Product
from config.exceptions import ObjectNotFound
from receipts.models import ProductAlias, Receipt, ReceiptLine
from receipts.prices import observation_q, price_history, price_summary
from stores.models import Country, Store

from .base import ReadOnlyAPIView

# Потолок списков ``aliases`` и ``stores`` в карточке товара.
DETAIL_LIST_LIMIT = 50
PRODUCT_ORDERINGS = ("name", "-name", "last_observed_at", "-last_observed_at")


def _object_pk(pk):
    """Ключ из пути; число вне диапазона ``BigAutoField`` — тот же ``404``, без запроса."""
    if not 1 <= pk <= MAX_ID:
        raise ObjectNotFound()
    return pk


def _observations():
    """Строки-наблюдения цены без аннотаций ``price_history`` — для счётчиков."""
    return ReceiptLine.objects.filter(observation_q()).order_by()


# --- справочники ---

class CountriesView(ReadOnlyAPIView):
    def get(self, request):
        params = Params(request.query_params)
        include_all = params.boolean("all", default=False)
        params.check()

        stores = dict(Store.objects.order_by().values_list("country_id").annotate(Count("pk")))
        currencies = {}
        pairs = Receipt.objects.order_by().values_list("store__country_id", "currency_id").distinct()
        for country, currency in pairs:
            currencies.setdefault(country, []).append(currency)
        products = dict(
            _observations().values_list("receipt__store__country_id").annotate(Count("product_id", distinct=True))
        )
        countries = Country.objects.order_by("pk")
        if not include_all:
            countries = countries.filter(pk__in=list(stores))
        return Response({"results": [
            {
                "code": country.pk,
                "name": country.name,
                "currencies": sorted(currencies.get(country.pk, ())),
                "stores_count": stores.get(country.pk, 0),
                "products_count": products.get(country.pk, 0),
            }
            for country in countries
        ]})


class StoresView(ReadOnlyAPIView):
    def get(self, request):
        params = Params(request.query_params)
        country = params.country()
        query = params.search()
        page = params.page()
        params.check()

        stores = Store.objects.select_related("merchant").annotate(
            # То же правило, что у api.common.store_name, — для сортировки в БД.
            display_name=Coalesce(
                NullIf("merchant__brand_name", Value("")), NullIf("name", Value("")),
                Concat(Value("Магазин №"), Cast("pk", CharField())), output_field=CharField(),
            ),
            receipts_count=Count("receipts"),
        )
        if country is not None:
            stores = stores.filter(country=country)
        if query is not None:
            stores = stores.filter(
                Q(merchant__brand_name__icontains=query) | Q(name__icontains=query) | Q(city__icontains=query)
            )
        return Response(paginate(
            stores.order_by("display_name", "pk"), page,
            lambda store: {**store_object(store), "receipts_count": store.receipts_count},
        ))


class BrandsView(ReadOnlyAPIView):
    def get(self, request):
        params = Params(request.query_params)
        query = params.search()
        page = params.page()
        params.check()

        brands = Brand.objects.annotate(products_count=Count("products"))
        if query is not None:
            brands = brands.filter(name__icontains=query)
        return Response(paginate(brands.order_by("name", "pk"), page, lambda brand: {
            "id": brand.pk,
            "name": brand.name,
            "manufacturer": brand.manufacturer,
            "products_count": brand.products_count,
        }))


# --- категории ---

class _CategoryCounts:
    """Счётчики всех категорий: два сгруппированных запроса на HTTP-запрос."""

    def __init__(self, tree):
        self.tree = tree
        self.generics = dict(GenericProduct.objects.order_by().values_list("category_id").annotate(Count("pk")))
        self.products = dict(Product.objects.order_by().values_list("generic__category_id").annotate(Count("pk")))
        # Обход в глубину перечисляет родителя раньше потомков: в обратном порядке
        # сумма узла готова к моменту, когда она прибавляется к родителю.
        self.totals = {}
        for pk in reversed(tree.ordered_ids()):
            self.totals[pk] = self.totals.get(pk, 0) + self.products.get(pk, 0)
            path = tree.path_ids(pk)
            if len(path) > 1:
                self.totals[path[-2]] = self.totals.get(path[-2], 0) + self.totals[pk]

    def node(self, pk):
        tree = self.tree
        return {
            "id": pk,
            "name": tree.name(pk),
            "parent_id": tree.parent_id(pk),
            "depth": tree.depth(pk),
            "path": tree.path(pk),
            "children_count": len(tree.children(pk)),
            "generic_products_count": self.generics.get(pk, 0),
            "products_count": self.products.get(pk, 0),
            "products_total": self.totals[pk],
        }


class CategoriesView(ReadOnlyAPIView):
    def get(self, request):
        params = Params(request.query_params)
        query = params.search()
        params.check()

        tree = CategoryTree.load()
        ordered = tree.ordered_ids()
        if query is not None:
            needle = query.casefold()
            keep = set()
            for pk in ordered:
                if needle in tree.name(pk).casefold():
                    keep.update(tree.path_ids(pk))
            ordered = [pk for pk in ordered if pk in keep]
        counts = _CategoryCounts(tree)
        return Response({"results": [counts.node(pk) for pk in ordered]})


class CategoryView(ReadOnlyAPIView):
    def get(self, request, pk):
        tree = CategoryTree.load()
        if pk not in tree:
            raise ObjectNotFound()
        counts = _CategoryCounts(tree)
        generics = (
            GenericProduct.objects.filter(category=pk)
            .annotate(products_count=Count("products"))
            .order_by("name", "pk")
        )
        return Response({
            **counts.node(pk),
            "children": [counts.node(child) for child in tree.children(pk)],
            "generic_products": [
                {**generic_brief(generic), "products_count": generic.products_count} for generic in generics
            ],
        })


# --- обобщённые продукты ---

def _generics():
    return GenericProduct.objects.annotate(products_count=Count("products"))


def _generic_objects(generics, tree):
    """Объекты обобщённых продуктов; страны всего набора — одним запросом."""
    countries = {}
    if generics:
        pairs = (
            _observations().filter(product__generic__in=[generic.pk for generic in generics])
            .values_list("product__generic_id", "receipt__store__country_id").distinct()
        )
        for generic_id, country in pairs:
            countries.setdefault(generic_id, []).append(country)
    return [
        {
            **generic_brief(generic),
            "category": tree.category(generic.category_id),
            "products_count": generic.products_count,
            "countries": sorted(countries.get(generic.pk, ())),
        }
        for generic in generics
    ]


class GenericProductsView(ReadOnlyAPIView):
    def get(self, request):
        params = Params(request.query_params)
        category = params.integer("category")
        query = params.search()
        page = params.page()
        params.check()

        tree = CategoryTree.load()
        generics = _generics()
        if category is not None:
            generics = generics.filter(category__in=tree.descendant_ids(category) if category in tree else [])
        if query is not None:
            generics = generics.filter(name__icontains=query)
        body = paginate(generics.order_by("name", "pk"), page)
        body["results"] = _generic_objects(body["results"], tree)
        return Response(body)


class GenericProductView(ReadOnlyAPIView):
    def get(self, request, pk):
        generic = get_or_404(_generics(), _object_pk(pk))
        return Response(_generic_objects([generic], CategoryTree.load())[0])


# --- продукты ---

def _product_objects(products, tree):
    """Объекты товаров; сводка цен всего набора — двумя запросами ``price_summary``."""
    summary = price_summary([product.pk for product in products])
    objects = []
    for product in products:
        generic = product.generic
        prices, moments = [], []
        for group in summary.get(product.pk, ()):
            last = group.last
            moments.append(last.observed_at)
            prices.append({
                "country": group.country,
                "currency": group.currency,
                "observations": group.observations,
                "last": {
                    "paid_unit_price": price(last.paid_unit_price),
                    "normalized_price": price(last.normalized_price),
                    "normalized_unit": last.normalized_unit,
                    "comparable": last.normalized_unit is not None and last.normalized_unit == generic.base_unit,
                    "purchased_on": iso_date(last.receipt.purchased_on),
                    "store_id": last.receipt.store_id,
                },
            })
        objects.append({
            "id": product.pk,
            "name": product.name,
            "brand": brand_brief(product.brand),
            "model": product.model,
            "gtin": product.gtin,
            "package": package(product),
            "generic": generic_brief(generic),
            "category": tree.category(generic.category_id),
            "last_observed_at": utc_datetime(max(moments, default=None)),
            "prices": prices,
        })
    return objects


def _product_observation(**filters):
    return Exists(ReceiptLine.objects.filter(observation_q(), product=OuterRef("pk"), **filters))


class ProductsView(ReadOnlyAPIView):
    def get(self, request):
        params = Params(request.query_params)
        query = params.search()
        category = params.integer("category")
        generic = params.integer("generic")
        brand = params.integer("brand")
        country = params.country()
        has_prices = params.boolean("has_prices")
        ordering = params.choice("ordering", PRODUCT_ORDERINGS, default="name")
        page = params.page()
        params.check()

        tree = CategoryTree.load()
        products = Product.objects.select_related("generic__category", "brand")
        if query is not None:
            products = products.filter(
                Q(name__icontains=query) | Q(brand__name__icontains=query) | Q(model__icontains=query)
                | Q(gtin=query)
            )
        if category is not None:
            products = products.filter(
                generic__category__in=tree.descendant_ids(category) if category in tree else [],
            )
        if generic is not None:
            products = products.filter(generic=generic)
        if brand is not None:
            products = products.filter(brand=brand)
        if country is not None:
            products = products.filter(_product_observation(receipt__store__country=country))
        if has_prices is not None:
            observed = _product_observation()
            products = products.filter(observed if has_prices else ~observed)

        if ordering.endswith("last_observed_at"):
            # Товары без наблюдений — в конце при любом направлении.
            products = products.annotate(last_observed_at=Max(
                "receipt_lines__receipt__purchased_at", filter=observation_q("receipt_lines__"),
            ))
            moment = F("last_observed_at")
            first = moment.desc(nulls_last=True) if ordering.startswith("-") else moment.asc(nulls_last=True)
            products = products.order_by(first, "pk")
        else:
            products = products.order_by(ordering, "pk")

        body = paginate(products, page)
        body["results"] = _product_objects(body["results"], tree)
        return Response(body)


def _alias_objects(product):
    """Названия товара на чеках: продавец показан вывеской либо названием своего магазина.

    Сопоставление привязано к продавцу, а не к магазину. Юридическое название не
    отдаётся, поэтому у продавца без вывески берётся его первый (по ``id``) магазин.
    """
    aliases = list(
        ProductAlias.objects.filter(product=product).select_related("merchant")
        .order_by("raw_name", "pk")[:DETAIL_LIST_LIMIT]
    )
    unnamed = {alias.merchant_id for alias in aliases if not alias.merchant.brand_name}
    names = {}
    if unnamed:
        first_stores = (
            Store.objects.filter(merchant__in=unnamed).select_related("merchant")
            .order_by("merchant_id", "pk").distinct("merchant_id")
        )
        names = {store.merchant_id: store_name(store) for store in first_stores}
    return [
        {
            "store_name": alias.merchant.brand_name or names.get(alias.merchant_id, ""),
            "raw_name": alias.raw_name,
            "store_item_code": alias.store_item_code,
        }
        for alias in aliases
    ]


def _store_objects(product):
    """Магазины, где встречался товар: сначала с самой поздней покупкой, затем по ``id``."""
    rows = list(
        price_history(product=product).order_by().values("receipt__store_id")
        .annotate(observations=Count("pk"), last_purchased_on=Max("receipt__purchased_on"))
        .order_by("-last_purchased_on", "receipt__store_id")[:DETAIL_LIST_LIMIT]
    )
    stores = Store.objects.select_related("merchant").in_bulk([row["receipt__store_id"] for row in rows])
    return [
        {
            **store_object(stores[row["receipt__store_id"]]),
            "observations": row["observations"],
            "last_purchased_on": iso_date(row["last_purchased_on"]),
        }
        for row in rows
    ]


class ProductView(ReadOnlyAPIView):
    def get(self, request, pk):
        product = get_or_404(Product.objects.select_related("generic__category", "brand"), _object_pk(pk))
        return Response({
            **_product_objects([product], CategoryTree.load())[0],
            "attributes": product.attributes,
            "aliases": _alias_objects(product),
            "stores": _store_objects(product),
            "alternatives_count": Product.objects.filter(generic=product.generic_id).exclude(pk=product.pk).count(),
        })
