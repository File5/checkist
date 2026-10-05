"""Helpers over the fictional demo catalog (``merges.demo``)."""
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from catalog.models import Brand, Category, GenericProduct, Product
from merges import demo
from merges.models import (
    ProductMerge, ProductMergeAlias, ProductMergeLine, ProductMergeMember, ProductMergeRejection,
)
from receipts.dedup import name_key
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from stores.models import Merchant, Store

DOMAIN_MODELS = (
    Category, GenericProduct, Brand, Product, Merchant, Store, Receipt, ReceiptLine, ReceiptDiscount,
    ReceiptTax, ProductAlias,
)
MERGE_MODELS = (ProductMerge, ProductMergeMember, ProductMergeLine, ProductMergeAlias, ProductMergeRejection)

PIZZA, MILK, ZIMBO, ROULADE, EGGS, TOAST, MAULTASCHEN = (
    demo.GROUPS[1], demo.GROUPS[0], demo.GROUPS[2], demo.GROUPS[3], demo.GROUPS[4], demo.GROUPS[5], demo.GROUPS[6],
)


def snapshot(*models):
    return {model.__name__: list(model.objects.order_by("pk").values()) for model in models or DOMAIN_MODELS + MERGE_MODELS}


def product(name):
    return Product.objects.get(name=name)


def ids(names):
    return [product(name).pk for name in names]


def pending_group(name):
    """The pending group of the product with this name."""
    return ProductMerge.objects.get(status="pending", members__active_product__name=name)


def links():
    """Current owner of every line and alias."""
    return (
        dict(ReceiptLine.objects.values_list("pk", "product_id")),
        dict(ProductAlias.objects.values_list("pk", "product_id")),
    )


def main_store():
    return Store.objects.get(merchant__tax_id=demo.MERCHANTS[demo.MAIN]["tax_id"])


def add_product(name, *, store=None, **fields):
    """A product as the importer leaves it: the service generic and one alias."""
    store = store or main_store()
    fields.setdefault("generic", GenericProduct.objects.get(name=demo.SERVICE_GENERIC_NAME))
    item = Product.objects.create(name=name, **fields)
    ProductAlias.objects.create(merchant=store.merchant, product=item, name_key=name_key(name), raw_name=name)
    return item


_numbers = iter(range(1, 10_000))


def add_line(item, raw_name, *, on=date(2026, 11, 2), price="3.49", store=None, **fields):
    """A new receipt with one line, as if imported while a group is pending."""
    store = store or main_store()
    receipt = Receipt.objects.create(
        store=store, currency_id="EUR", operation=Receipt.Operation.SALE, purchased_on=on,
        purchased_at=datetime.combine(on, time(12, 0), tzinfo=ZoneInfo(store.timezone)),
        receipt_number=f"TEST-MERGE-{next(_numbers)}", total=Decimal(price),
    )
    return ReceiptLine.objects.create(
        receipt=receipt, position=1, kind=ReceiptLine.Kind.PRODUCT, raw_name=raw_name,
        quantity=Decimal("1.000"), unit="pcs", unit_price=Decimal(price), amount=Decimal(price),
        product=item, **fields,
    )
