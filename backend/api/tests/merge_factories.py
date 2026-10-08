"""Данные и клиент для тестов API слияния дублей. Все названия вымышленные.

``public_merge_data`` — маленький каталог с явными id: по нему построены эталонные
JSON для клиента (``merges/tests/fixtures/public``). Остальные тесты берут полный
демо-каталог ``merges.demo`` и ищут записи по названиям.
"""
import json
from datetime import date, datetime, time, timezone as dt_timezone
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

from django.db import connection
from rest_framework.test import APIClient

from catalog.models import Category, GenericProduct, Product
from merges import demo, services
from merges.models import ProductMerge
from receipts.dedup import name_key
from receipts.models import ProductAlias, Receipt, ReceiptLine
from receipts.ownership import local_user
from stores.models import Merchant, Store

NOW = datetime(2026, 10, 6, 10, 0, tzinfo=dt_timezone.utc)
PUBLIC = Path(__file__).resolve().parents[2] / "merges/tests/fixtures/public"
PRIVATE = "PRIVATE"

PIZZA_IDS, MILK_IDS, EGG_IDS = (5, 26, 43), (2, 14, 36), (18, 38)
# id, название, обобщённый продукт, фасовка
_PRODUCTS = (
    (2, "GQ EgSB H-Milch 1,5%", 92, None),
    (5, "Steinhof.PizzaSpezial", 91, None),
    (6, "Pizza Hot Dog", 91, None),
    (14, "GG EgSB H-Milch 1,5%", 91, None),
    (18, "Eier 10er Freilandh.", 91, ("10", "pcs")),
    (26, "Steinhof PizzaSpezial", 91, None),
    (36, "GO EgSB H-Milch 1,5%", 93, None),
    (38, "Eier 10er Freiland", 91, ("10", "pcs")),
    (43, "Steinof.PizzaSpezial", 91, None),
)
# id чека, дата, ((id строки, id товара, цена), ...)
_RECEIPTS = (
    (9, date(2026, 6, 9), ((101, 43, "3.49"), (102, 2, "1.05"))),
    (10, date(2026, 6, 29), ((103, 6, "3.99"), (104, 5, "3.49"), (105, 14, "1.05"), (106, 18, "2.99"))),
    (11, date(2026, 7, 6), ((107, 43, "3.49"),)),
    (13, date(2026, 10, 1), ((108, 26, "3.49"), (109, 36, "1.05"), (110, 38, "2.99"))),
)


def expected(name):
    return json.loads((PUBLIC / name).read_text(encoding="utf-8"))


def local_client():
    """Клиент локального API: CSRF проверяется, токен и Origin заданы."""
    client = APIClient(enforce_csrf_checks=True)
    token = client.get("/api/recognition/csrf/").json()["csrf_token"]
    client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")
    return client


def restart_group_ids():
    """Группы теста получают id с 1: эталонные JSON сравниваются целиком."""
    with connection.cursor() as cursor:
        cursor.execute("SELECT setval(pg_get_serial_sequence('merges_productmerge', 'id'), 1, false)")


def _receipt(pk, store, on, rows, names, owner=None):
    receipt = Receipt.objects.create(
        id=pk, owner=owner or local_user(), store=store, currency_id="EUR", operation=Receipt.Operation.SALE, purchased_on=on,
        purchased_at=datetime.combine(on, time(12, 0), tzinfo=ZoneInfo(store.timezone)),
        total=sum(Decimal(price) for _, _, price in rows), receipt_number=f"{PRIVATE} NUMBER {pk}",
        raw_text=f"{PRIVATE} TEXT", fiscal={"secret": f"{PRIVATE} FISCAL"}, extra={"stderr": f"{PRIVATE} EXTRA"},
        register_code=f"{PRIVATE} REGISTER", shift_number=f"{PRIVATE} SHIFT",
    )
    for position, (line_id, product_id, price) in enumerate(rows, 1):
        ReceiptLine.objects.create(
            id=line_id, receipt=receipt, position=position, kind=ReceiptLine.Kind.PRODUCT,
            raw_name=names[product_id], quantity=Decimal("1.000"), unit="pcs", unit_price=Decimal(price),
            amount=Decimal(price), product_id=product_id, extra={"raw_text": f"{PRIVATE} LINE"},
        )
    return receipt


def public_merge_data():
    """Девять товаров одного продавца: пицца 5/26/43, молоко 2/14/36 с конфликтом, яйца 18/38."""
    merchant = Merchant.objects.create(
        id=51, country_id="DE", legal_name=f"{PRIVATE} LEGAL", brand_name="Demomarkt", tax_id=f"{PRIVATE} TAX",
    )
    store = Store.objects.create(
        id=51, merchant=merchant, country_id="DE", name="Demomarkt", city="Musterstadt",
        address_raw="Beispielallee 1", timezone="Europe/Berlin",
    )
    category = Category.objects.create(id=81, name=demo.SERVICE_GENERIC_NAME)
    for pk, name, base_unit in ((91, demo.SERVICE_GENERIC_NAME, "pcs"), (92, "Молоко", "l"), (93, "H-Milch (демо)", "l")):
        GenericProduct.objects.create(id=pk, name=name, category=category, base_unit=base_unit)
    names = {}
    for pk, name, generic_id, package in _PRODUCTS:
        quantity, unit = package or (None, "")
        Product.objects.create(
            id=pk, generic_id=generic_id, name=name,
            package_quantity=Decimal(quantity) if quantity else None, package_unit=unit,
        )
        ProductAlias.objects.create(merchant=merchant, product_id=pk, name_key=name_key(name), raw_name=name)
        names[pk] = name
    for pk, on, rows in _RECEIPTS:
        _receipt(pk, store, on, rows, names)
    return store, names


def late_purchase(store, names):
    """Покупка оставляемого товара пиццы после слияния: в журнале её нет."""
    return _receipt(14, store, date(2026, 10, 3), ((111, 5, "3.59"),), names)


def demo_groups():
    """Полный демо-каталог с семью ожидающими группами."""
    demo.seed_demo()
    services.detect()


def product(name):
    return Product.objects.get(name=name)


def pending_group(name):
    return ProductMerge.objects.get(status="pending", members__active_product__name=name)
