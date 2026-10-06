"""Input document of one model call. Read only: no locks, no writes.

Printed product names, brands and shop signs leave for the model; receipt
texts, fiscal fields, prices, legal names and tax ids never do.
"""
from collections import defaultdict

from django.db.models import Count

from catalog.models import Category, GenericProduct, Product
from classification import taxonomy
from classification.dto import INPUT_VERSION, ClassificationRequest, serialize
from classification.models import ClassificationRejection, ProductClassification
from merges.visibility import visible, visible_q
from receipts.models import ProductAlias, ReceiptLine
from stores.models import Store

MAX_INPUT_BYTES = 120_000
CATEGORIES_LIMIT = 300
GENERICS_LIMIT = 500
EXAMPLES_LIMIT = 40
EXAMPLES_PER_GENERIC = 2
SPELLINGS_LIMIT = 5
SPELLING_LENGTH = 120
MERCHANTS_LIMIT = 3
UNITS_LIMIT = 3
REJECTED_LIMIT = 10


class InputTooLarge(ValueError):
    """The document of these products exceeds ``MAX_INPUT_BYTES``."""

    code = "input_too_large"


def category_paths():
    """``{category id: [names from the root]}`` without the service root and its descendants."""
    rows = {pk: (name, parent_id) for pk, name, parent_id in Category.objects.values_list("pk", "name", "parent_id")}
    paths = {}
    for pk in rows:
        names, seen, current = [], set(), pk
        while current is not None and current in rows and current not in seen:
            seen.add(current)
            names.append(rows[current][0])
            current = rows[current][1]
        if current is None and not taxonomy.is_service_name(names[-1]):  # a cycle or a lost parent is left out
            paths[pk] = names[::-1]
    return paths


def _categories(paths):
    return [{"id": pk, "path": paths[pk]} for pk in sorted(paths)[:CATEGORIES_LIMIT]]


def _generics():
    queryset = GenericProduct.objects.exclude(name__iexact=taxonomy.SERVICE_NAME)
    if queryset.count() > GENERICS_LIMIT:
        # Too many for one request: keep the most used ones.
        ids = queryset.annotate(used=Count("products", filter=visible_q("products__"))).order_by(
            "-used", "pk").values_list("pk", flat=True)[:GENERICS_LIMIT]
        queryset = GenericProduct.objects.filter(pk__in=list(ids))
    return [
        {"id": pk, "name": name, "base_unit": base_unit, "category_id": category_id}
        for pk, name, base_unit, category_id in queryset.order_by("pk").values_list(
            "pk", "name", "base_unit", "category_id")
        if not taxonomy.is_service_name(name)
    ]


def _examples(generic_ids):
    """Products a person already assigned: confirmed records first (newest first), then the rest by id."""
    assigned = visible(Product.objects.filter(
        generic_id__in=generic_ids, pending_classification__isnull=True,
    )).select_related("brand")
    confirmed = list(
        ProductClassification.objects.filter(status=ProductClassification.Status.CONFIRMED)
        .order_by("-resolved_at", "-pk").values_list("product_ref", flat=True)[:EXAMPLES_LIMIT * 5]
    )
    by_id = assigned.in_bulk(confirmed)
    ordered = [by_id[pk] for pk in dict.fromkeys(confirmed) if pk in by_id]
    ordered += list(assigned.exclude(pk__in=by_id).order_by("pk")[:EXAMPLES_LIMIT * 5])
    examples, used = [], defaultdict(int)
    for product in ordered:
        if len(examples) == EXAMPLES_LIMIT:
            break
        if used[product.generic_id] < EXAMPLES_PER_GENERIC:
            used[product.generic_id] += 1
            examples.append({
                "name": product.name, "brand": product.brand.name if product.brand_id else None,
                "generic_id": product.generic_id,
            })
    return examples


def _merchant_names(aliases):
    """Shop sign of the alias merchant, else the name of its first store; never the legal name."""
    unnamed = {alias.merchant_id for alias in aliases if not alias.merchant.brand_name}
    names = {}
    if unnamed:
        for store in Store.objects.filter(merchant__in=unnamed).order_by("merchant_id", "pk").distinct("merchant_id"):
            names[store.merchant_id] = store.name
    return {alias.merchant_id: alias.merchant.brand_name or names.get(alias.merchant_id, "") for alias in aliases}


def _products(product_ids):
    products = list(Product.objects.filter(pk__in=product_ids).select_related("brand").order_by("pk"))
    ids = [product.pk for product in products]
    aliases = list(
        ProductAlias.objects.filter(product_id__in=ids).select_related("merchant").order_by("raw_name", "pk")
    )
    merchant_names = _merchant_names(aliases)
    spellings, merchants = defaultdict(dict), defaultdict(dict)
    for alias in aliases:
        spelling = alias.raw_name[:SPELLING_LENGTH]
        spellings[alias.product_id].setdefault(taxonomy.name_key(spelling), spelling)
        if merchant_names[alias.merchant_id]:
            merchants[alias.product_id].setdefault(merchant_names[alias.merchant_id])
    units = defaultdict(list)
    for product_id, unit in ReceiptLine.objects.filter(
        product_id__in=ids, kind=ReceiptLine.Kind.PRODUCT,
    ).values_list("product_id", "unit").distinct().order_by("product_id", "unit"):
        units[product_id].append(unit)
    rejected = defaultdict(list)
    for product_id, name in ClassificationRejection.objects.filter(product_id__in=ids).order_by("pk").values_list(
            "product_id", "generic_name"):
        rejected[product_id].append(name)
    return [
        {
            "id": product.pk, "name": product.name,
            "spellings": list(spellings[product.pk].values())[:SPELLINGS_LIMIT],
            "brand": product.brand.name if product.brand_id else None,
            "package": (
                {"quantity": f"{product.package_quantity:.3f}", "unit": product.package_unit}
                if product.package_quantity is not None else None
            ),
            "merchants": list(merchants[product.pk])[:MERCHANTS_LIMIT],
            "units": units[product.pk][:UNITS_LIMIT],
            "rejected": rejected[product.pk][:REJECTED_LIMIT],
        }
        for product in products
    ]


def build_request(product_ids):
    """``ClassificationRequest`` for these products, in ascending id order.

    Products that no longer exist are left out, so ``request.product_ids`` may be
    shorter than the argument. A fixed number of queries. Raises ``InputTooLarge``
    when the serialised document exceeds ``MAX_INPUT_BYTES``.
    """
    paths = category_paths()
    generics = _generics()
    document = {
        "input_version": INPUT_VERSION,
        "categories": _categories(paths),
        "generic_products": generics,
        "examples": _examples([generic["id"] for generic in generics]),
        "products": _products(list(product_ids)),
    }
    if len(serialize(document).encode("utf-8")) > MAX_INPUT_BYTES:
        raise InputTooLarge("The classification input is too large.")
    return ClassificationRequest.build(document)


def fit_request(product_ids):
    """The request for the longest fitting prefix: the batch is halved until it fits.

    Raises ``InputTooLarge`` when a single product does not fit.
    """
    product_ids = list(product_ids)
    while True:
        try:
            return build_request(product_ids)
        except InputTooLarge:
            if len(product_ids) <= 1:
                raise
            product_ids = product_ids[:len(product_ids) // 2]
