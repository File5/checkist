"""Тестовые данные API поверх образцов ``receipts.tests.samples``.

Образцы дают три страны и три валюты, но не все случаи контракта: в них нет товара
с ценами в двух валютах, несовпадения единицы фасовки с ``base_unit`` и цикла
категорий. Эти случаи достраивают функции ниже. Все названия вымышленные.
"""
from datetime import date, datetime, time
from decimal import Decimal
from itertools import count
from types import SimpleNamespace
from zoneinfo import ZoneInfo

from catalog.models import Category, Product
from catalog.units import Unit
from receipts.models import Receipt
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line

D = Decimal
_numbers = count(1)


def save_samples():
    """Все образцы: чеки ДНС (KZ, KZT), магазина (RU, RUB), шесть чеков Lidl (DE, EUR), каталог.

    Возвращает объект с полями ``dns``, ``shop`` (чеки), ``lidl`` (список чеков),
    ``dns_store``, ``shop_store``, ``lidl_store``, ``shop_milk``, ``lidl_milk``, ``ssd``
    (товары), ``milk``, ``ssd_generic`` (обобщённые продукты).

    Сопоставлены три товара: ``shop_milk`` (850 мл, цена за литр есть), ``lidl_milk``
    (штучный без фасовки — нормализованной цены нет), ``ssd`` (штучный без фасовки).
    """
    dns = samples.save_dns_kz()
    shop = samples.save_shop_ru()
    lidl = samples.save_lidl_de()
    catalog = samples.save_catalog()
    return SimpleNamespace(
        dns=dns, shop=shop, lidl=lidl,
        dns_store=dns.store, shop_store=shop.store, lidl_store=lidl[0].store,
        milk=catalog["shop_milk"].generic, ssd_generic=catalog["ssd"].generic,
        **catalog,
    )


def make_product(generic, name, *, package=None, **fields):
    """Товар; ``package`` — ``("500", Unit.G)`` либо ``None`` (фасовка не задана)."""
    package_quantity, package_unit = (D(package[0]), package[1]) if package else (None, "")
    return Product.objects.create(
        generic=generic, name=name, package_quantity=package_quantity, package_unit=package_unit, **fields,
    )


def make_receipt(store, currency, on, *, at=time(12, 0), owner=None, **fields):
    """Чек продажи в магазине: ``on`` — локальная дата, ``at`` — локальное время.

    ``currency`` — код валюты; она не обязана совпадать с обычной валютой страны.
    Номер чека уникален, поэтому несколько чеков в один момент не считаются дубликатами.
    """
    fields.setdefault("operation", Receipt.Operation.SALE)
    fields.setdefault("total", D("0.00"))
    fields.setdefault("receipt_number", f"factory-{next(_numbers)}")
    purchased_at = datetime.combine(on, at, tzinfo=ZoneInfo(store.timezone))
    return Receipt.objects.create(
        store=store, currency_id=currency, owner=owner or local_user(), purchased_at=purchased_at, purchased_on=on, **fields,
    )


def observe(product, store, currency, on, unit_price, *, quantity="1", unit=Unit.PCS, discount="0.00", **fields):
    """Одно наблюдение цены: новый чек с одной строкой товара. Возвращает строку.

    ``unit_price`` — цена за единицу до скидки, ``discount`` — скидка на строку.
    Остальные поля строки (``kind``, ``raw_name``, ``position``) — через ``fields``.
    """
    quantity, unit_price = D(quantity), D(unit_price)
    receipt = make_receipt(store, currency, on, at=fields.pop("at", time(12, 0)))
    fields.setdefault("raw_name", product.name if product else "Тестовый товар")
    return make_line(
        receipt, product=product, quantity=quantity, unit=unit, unit_price=unit_price,
        amount=(quantity * unit_price).quantize(D("0.01")), discount_amount=D(discount), **fields,
    )


def second_currency(data, on=date(2026, 7, 1), unit_price="1.20"):
    """Вторая валюта у товара: ``shop_milk`` куплен в том же магазине RU чеком в EUR.

    После этого у товара две группы — ``(RU, EUR)`` и ``(RU, RUB)``; складывать и
    усреднять их цены нельзя. 1,20 EUR за 850 мл — 1,4118 за литр.
    """
    return observe(data.shop_milk, data.shop_store, "EUR", on, unit_price)


def piece_without_package(data, on=date(2026, 7, 2), unit_price="0.89"):
    """Штучная строка товара без фасовки: нормализованной цены и единицы нет.

    Новый товар «Молоко без фасовки» обобщённого продукта «Молоко», куплен в Lidl.
    """
    product = make_product(data.milk, "Молоко без фасовки")
    return observe(product, data.lidl_store, "EUR", on, unit_price)


def unit_mismatch(data, on=date(2026, 7, 3), unit_price="1.50"):
    """Единица не совпадает с ``base_unit``: «Молоко сухое 500 г» у продукта с ``base_unit='l'``.

    Нормализованная цена есть (3,0000 за кг), но ``normalized_unit='kg'`` — несравнимо.
    """
    product = make_product(data.milk, "Молоко сухое 500 г", package=("500", Unit.G))
    return observe(product, data.lidl_store, "EUR", on, unit_price)


def category_cycle():
    """Цикл категорий ``a -> b -> a`` и узел ``child`` под ``a``; БД цикл не запрещает."""
    a = Category.objects.create(name="Цикл А")
    b = Category.objects.create(name="Цикл Б", parent=a)
    child = Category.objects.create(name="Под циклом", parent=a)
    Category.objects.filter(pk=a.pk).update(parent=b)
    a.refresh_from_db()
    return SimpleNamespace(a=a, b=b, child=child)
