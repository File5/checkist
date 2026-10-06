"""Вымышленные данные для статистики трат, графика цен и разложения среднего чека.

Только для БД ``test_*`` и ``checkist_qa*``. Случайности нет: состав каждого чека
выводится из его порядкового номера, цены — из таблицы уровней цен по полугодиям,
поэтому повторная сборка даёт те же числа. ``build_receipts`` БД не использует.

Что есть в данных:

- 2019–2026 годы (2026 — по сентябрь), три магазина двух стран: два немецких разных
  продавцов (EUR) и один казахстанский (KZT); продавцы, адреса и налоговые номера
  ``DEMOSTATS…`` выдуманы;
- дерево категорий и обобщённые продукты с фасовками: «Молоко» (л) — свой товар в
  каждом магазине, «Хлеб» (кг), «Яблоки» (кг, весовые строки); остальной ассортимент
  немецких магазинов общий, цена во втором магазине выше;
- часть товаров оставлена в «Не разобрано», как после импорта, часть строк —
  несопоставленные;
- залог и возврат тары, услуга, скидка строки, скидка на весь чек, один чек возврата,
  один чек с ценами без налога, чек казахстанского магазина в 01:10 первого января
  (по UTC — ещё прошлый год).

Корзина подобрана под вопрос «цены или количество»: число позиций в немецком чеке
растёт с 11,5 в 2020 году до 14,67 в 2026, цены — по ``PRICE_LEVELS``, с 2023 года в
ассортименте появляются дорогие товары. Точные итоговые числа — в
``receipts/tests/test_demo.py``.
"""
import re
from datetime import date, datetime, time
from decimal import ROUND_HALF_UP, Decimal
from typing import NamedTuple
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction

D = Decimal
UNASSIGNED = "Не разобрано"
NORD, SUED, KZ = "nord", "sued", "kz"
FIRST_YEAR, LAST_YEAR, LAST_MONTH = 2019, 2026, 9
RECEIPT_PREFIX = "DEMO-STATS-"

PRODUCT, SERVICE, DEPOSIT, DEPOSIT_RETURN = "product", "service", "deposit", "deposit_return"
SALE, REFUND = "sale", "refund"
_CENT = D("0.01")


class DemoError(ValueError):
    pass


class Item(NamedTuple):
    """Товар ассортимента: ``base`` — цена при уровне цен 100, ``sens`` — на сколько
    процентов от общего роста цен дорожает товар."""

    name: str
    base: str
    sens: int = 100
    generic: str = UNASSIGNED
    package: tuple | None = None
    unit: str = "pcs"  # кг — весовая строка
    since: int = FIRST_YEAR
    multi: bool = False  # иногда берут две штуки
    quantity: int = 1
    deposit: str | None = None  # залог за штуку


# (название, родитель); порядок создания.
CATEGORIES = (
    ("Продукты питания", None),
    ("Молочные продукты", "Продукты питания"),
    ("Хлеб", "Продукты питания"),
    ("Овощи и фрукты", "Продукты питания"),
    ("Бытовая химия", None),
    (UNASSIGNED, None),
)
# название -> (категория, базовая единица); «Макароны» и «Курица» лежат прямо в корневой категории.
GENERICS = {
    "Молоко": ("Молочные продукты", "l"),
    "Йогурт": ("Молочные продукты", "kg"),
    "Сыр": ("Молочные продукты", "kg"),
    "Сливочное масло": ("Молочные продукты", "kg"),
    "Кефир": ("Молочные продукты", "l"),
    "Хлеб": ("Хлеб", "kg"),
    "Яблоки": ("Овощи и фрукты", "kg"),
    "Бананы": ("Овощи и фрукты", "kg"),
    "Картофель": ("Овощи и фрукты", "kg"),
    "Макароны": ("Продукты питания", "kg"),
    "Курица": ("Продукты питания", "kg"),
    "Средство для посуды": ("Бытовая химия", "l"),
    "Стиральное средство": ("Бытовая химия", "l"),
    "Бумажные полотенца": ("Бытовая химия", "pcs"),
    UNASSIGNED: (UNASSIGNED, "pcs"),
}

# Общий ассортимент двух немецких магазинов. Порядок задаёт состав чеков.
DE_POOL = (
    Item("Demo Roggenbrot 500g", "1.49", 110, "Хлеб", ("500", "g"), multi=True),
    Item("Demo Kakaotafel Zartbitter", "1.19", 90, multi=True),
    Item("Demo Äpfel lose", "2.49", 105, "Яблоки", unit="kg"),
    Item("Demo Bohnenkaffee gemahlen", "5.49", 120),
    Item("Demo Naturjoghurt 500g", "0.89", 115, "Йогурт", ("500", "g"), multi=True),
    Item("Demo Sprudelwasser 1,5L", "0.45", 60, quantity=6, deposit="0.25"),
    Item("Demo Gouda Scheiben 400g", "2.99", 110, "Сыр", ("400", "g")),
    Item("Demo Butterkeks", "1.29", 80, multi=True),
    Item("Demo Kartoffeln 2kg", "2.29", 95, "Картофель", ("2", "kg")),
    Item("Demo Tomatensauce", "1.59", 100, multi=True),
    Item("Demo Spülmittel 500ml", "1.15", 70, "Средство для посуды", ("500", "ml")),
    Item("Demo Hühnereier Karton", "2.19", 125),
    Item("Demo Bananen lose", "1.39", 75, "Бананы", unit="kg"),
    Item("Demo Sauerrahmbutter 250g", "1.99", 130, "Сливочное масло", ("250", "g")),
    Item("Demo Waschmittel 1,35L", "4.95", 85, "Стиральное средство", ("1.35", "l")),
    Item("Demo Orangensaft", "1.69", 110, multi=True),
    Item("Demo Spaghetti 500g", "0.79", 120, "Макароны", ("500", "g"), multi=True),
    Item("Demo Küchenrolle", "2.65", 90, "Бумажные полотенца"),
    Item("Demo Weizentoast 500g", "1.19", 105, "Хлеб", ("500", "g")),
    Item("Demo Reiswaffeln", "0.99", 85, multi=True),
    Item("Demo Hähnchenbrust 600g", "5.99", 115, "Курица", ("600", "g")),
    Item("Demo Zahncreme", "1.65", 65),
    Item("Demo Bio-Bergkäse 200g", "2.79", 100, "Сыр", ("200", "g"), since=2023),
    Item("Demo Lachsfilet", "3.49", 100, since=2023),
    Item("Demo Olivenöl nativ", "3.79", 100, since=2024),
    Item("Demo Hafertrunk", "1.39", 100, since=2024, multi=True),
)
KZ_POOL = (
    Item("Демо Хлеб пшеничный 400 г", "120", 110, "Хлеб", ("400", "g"), multi=True),
    Item("Демо Чай чёрный 100 г", "690", 90),
    Item("Демо Яблоки весовые", "480", 105, "Яблоки", unit="kg"),
    Item("Демо Рис 900 г", "520", 100),
    Item("Демо Кефир 1 л", "310", 110, "Кефир", ("1", "l"), multi=True),
    Item("Демо Сахар 1 кг", "290", 120),
    Item("Демо Макароны 400 г", "240", 95, "Макароны", ("400", "g"), multi=True),
    Item("Демо Курица охлаждённая 1 кг", "1650", 115, "Курица", ("1", "kg")),
    Item("Демо Вода 1,5 л", "170", 70, multi=True),
    Item("Демо Печенье сливочное", "430", 85),
)

STORES = {
    NORD: {
        "legal_name": "Zahlenfrisch Testhandel GmbH (вымышленный)", "brand_name": "Zahlenfrisch",
        "tax_id": "DEMOSTATS0001", "country": "DE", "currency": "EUR", "timezone": "Europe/Berlin",
        "city": "Musterstadt", "address_raw": "Statistikweg 1, 00000 Musterstadt",
        "milk": Item("Demo Frischmilch 1,5% 1L", "0.79", 135, "Молоко", ("1", "l")),
        "pool": DE_POOL, "price_percent": 100, "days": ((4, time(10, 15)), (13, time(17, 40)), (24, time(12, 5))),
        "code": "N", "unmatched": ("Aktionsartikel", "2.49"), "service": ("Demo Lieferservice", "2.90"),
        "line_discount": "Rabatt 10%", "receipt_discount": ("Coupon", "1.00"),
        "deposit": "Pfand", "deposit_return": ("Leergut", "0.25", 6),
    },
    SUED: {
        "legal_name": "Beispielkorb Probe GmbH (вымышленный)", "brand_name": "Beispielkorb",
        "tax_id": "DEMOSTATS0002", "country": "DE", "currency": "EUR", "timezone": "Europe/Berlin",
        "city": "Beispielhausen", "address_raw": "Diagrammallee 2, 00000 Beispielhausen",
        "milk": Item("Demo Landmilch 3,5% 1L", "0.89", 125, "Молоко", ("1", "l")),
        "pool": DE_POOL, "price_percent": 106, "days": ((18, time(16, 20)),),
        "code": "S", "unmatched": ("Backware", "1.99"), "service": None,
        "line_discount": "Rabatt 10%", "receipt_discount": ("Coupon", "1.00"),
        "deposit": "Pfand", "deposit_return": ("Leergut", "0.25", 6),
    },
    KZ: {
        "legal_name": "ТОО «Демо Статмаркет» (вымышленное)", "brand_name": "Статмаркет",
        "tax_id": "DEMOSTATS0003", "country": "KZ", "currency": "KZT", "timezone": "Asia/Almaty",
        "city": "Алматы", "address_raw": "г. Алматы, ул. Примерная, д. 3",
        "milk": Item("Демо Молоко 2,5% 1 л", "340", 110, "Молоко", ("1", "l")),
        "pool": KZ_POOL, "price_percent": 100, "days": ((1, time(18, 40)),),
        "code": "K", "unmatched": ("Товар без названия", "350"), "service": None,
        "line_discount": "Скидка 10%", "receipt_discount": ("Купон", "150.00"),
        "deposit": None, "deposit_return": None,
    },
}

# Уровень цен по полугодиям (2019 = 100) и шаг округления цены.
PRICE_LEVELS = {
    "EUR": {
        2019: (100, 100), 2020: (101, 102), 2021: (103, 105), 2022: (110, 116),
        2023: (119, 121), 2024: (122, 123), 2025: (124, 125), 2026: (125, 126),
    },
    "KZT": {
        2019: (100, 103), 2020: (107, 110), 2021: (115, 120), 2022: (132, 142),
        2023: (150, 156), 2024: (162, 167), 2025: (174, 180), 2026: (188, 195),
    },
}
PRICE_STEP = {"EUR": _CENT, "KZT": D("1")}
# Число товарных строк в чеке: по кругу внутри года.
LINES_PER_RECEIPT = {
    "EUR": {
        2019: (11,), 2020: (11, 12), 2021: (12,), 2022: (12, 13),
        2023: (13,), 2024: (13, 14), 2025: (14,), 2026: (15, 14, 15),
    },
    "KZT": {
        2019: (5,), 2020: (5, 6), 2021: (6,), 2022: (6,),
        2023: (6, 7), 2024: (7,), 2025: (7,), 2026: (7, 8),
    },
}
POOL_STEP = 7  # сдвиг по ассортименту между соседними чеками; взаимно прост с его размером
REFUND_ON = (NORD, date(2026, 3, 14), time(15, 30), "Demo Bohnenkaffee gemahlen")
TAX_EXCLUSIVE_ON = (SUED, date(2026, 5, 18))
TAX_EXCLUSIVE_RATE = D("7.00")
# Первого января чек пробит ночью: по UTC это ещё предыдущий год.
NIGHT_STORE, NIGHT_TIME = KZ, time(1, 10)


class Line(NamedTuple):
    kind: str
    raw_name: str
    item: str | None  # название товара каталога; None — строка не сопоставлена
    quantity: Decimal
    unit: str
    unit_price: Decimal
    amount: Decimal
    discount: Decimal = D("0.00")
    discount_name: str = ""
    parent: int | None = None  # индекс строки товара в чеке — для залога


class Sale(NamedTuple):
    store: str
    number: str
    operation: str
    on: date
    at: time
    lines: tuple
    receipt_discount: tuple | None  # (название, сумма)
    tax: tuple | None  # (ставка, нетто, налог, брутто) — у чека с ценами без налога
    total: Decimal


def _round(value, step=_CENT):
    return value.quantize(step, rounding=ROUND_HALF_UP)


def price(store, base, sens, on):
    """Цена товара в магазине ``store`` на дату ``on``."""
    spec = STORES[store]
    level = PRICE_LEVELS[spec["currency"]][on.year][0 if on.month <= 6 else 1]
    value = D(base) * (10000 + (level - 100) * sens) * spec["price_percent"] / 1000000
    return _round(value, PRICE_STEP[spec["currency"]])


def _product_line(store, item, on, quantity):
    unit_price = price(store, item.base, item.sens, on)
    return Line(PRODUCT, item.name, item.name, quantity, item.unit, unit_price, _round(quantity * unit_price))


def _sale(store, on, at, sequence, in_year):
    """Чек продажи номер ``sequence`` (сквозной по магазину), ``in_year`` — номер в году."""
    spec = STORES[store]
    pattern = LINES_PER_RECEIPT[spec["currency"]][on.year]
    picks = pattern[in_year % len(pattern)] - 1  # ещё одна строка — молоко
    pool = [item for item in spec["pool"] if item.since <= on.year]
    start = sequence * POOL_STEP % len(pool)

    lines = [_product_line(store, spec["milk"], on, D(2 if sequence % 2 == 0 else 1))]
    deposits = []
    for index in range(picks):
        item = pool[(start + index) % len(pool)]
        if index == picks - 1 and sequence % 3 == 0:
            name, base = spec["unmatched"]
            unit_price = price(store, base, 100, on)
            lines.append(Line(PRODUCT, name, None, D(1), "pcs", unit_price, unit_price))
            continue
        if item.unit == "kg":
            quantity = D(800 + (sequence * 137 + index * 71) % 9 * 75) / 1000
        elif item.multi and (sequence + index) % 3 == 0:
            quantity = D(2)
        else:
            quantity = D(item.quantity)
        lines.append(_product_line(store, item, on, quantity))
        if item.deposit:
            deposits.append((len(lines) - 1, quantity, D(item.deposit)))
    if sequence % 5 == 2:
        discount = _round(lines[2].amount / 10, PRICE_STEP[spec["currency"]])
        lines[2] = lines[2]._replace(discount=discount, discount_name=spec["line_discount"])
    for parent, quantity, unit_price in deposits:
        name = f"{spec['deposit']} {unit_price}".replace(".", ",")
        lines.append(Line(DEPOSIT, name, None, quantity, "pcs", unit_price, quantity * unit_price, parent=parent))
    if spec["deposit_return"] and sequence % 4 == 3:
        name, unit_price, count = spec["deposit_return"]
        lines.append(Line(DEPOSIT_RETURN, name, None, D(-count), "pcs", D(unit_price), -count * D(unit_price)))
    if spec["service"] and sequence % 12 == 7:
        name, base = spec["service"]
        unit_price = price(store, base, 100, on)
        lines.append(Line(SERVICE, name, None, D(1), "pcs", unit_price, unit_price))

    receipt_discount = None
    if sequence % 8 == 5:
        receipt_discount = (spec["receipt_discount"][0], D(spec["receipt_discount"][1]))
    total = sum(line.amount - line.discount for line in lines) - (receipt_discount[1] if receipt_discount else 0)
    tax = None
    if (store, on) == TAX_EXCLUSIVE_ON:
        # Цены строк без налога: налог добавлен сверху и виден только в итоге чека.
        added = _round(total * TAX_EXCLUSIVE_RATE / 100)
        tax = (TAX_EXCLUSIVE_RATE, total, added, total + added)
        total += added
    number = f"{RECEIPT_PREFIX}{spec['code']}-{sequence + 1:04d}"
    return Sale(store, number, SALE, on, at, tuple(lines), receipt_discount, tax, _round(total))


def _refund():
    store, on, at, name = REFUND_ON
    item = next(item for item in STORES[store]["pool"] if item.name == name)
    unit_price = price(store, item.base, item.sens, on)
    line = Line(PRODUCT, item.name, item.name, D(-1), item.unit, unit_price, -unit_price)
    return Sale(store, f"{RECEIPT_PREFIX}{STORES[store]['code']}-R001", REFUND, on, at, (line,), None, None, -unit_price)


def build_receipts():
    """Все чеки демо по порядку магазинов и дат. БД не используется."""
    sales = []
    for store, spec in STORES.items():
        sequence = 0
        for year in range(FIRST_YEAR, LAST_YEAR + 1):
            in_year = 0
            for month in range(1, (LAST_MONTH if year == LAST_YEAR else 12) + 1):
                for day, at in spec["days"]:
                    if store == NIGHT_STORE and month == 1:
                        at = NIGHT_TIME
                    sales.append(_sale(store, date(year, month, day), at, sequence, in_year))
                    sequence += 1
                    in_year += 1
    sales.append(_refund())
    return sales


def items():
    """Товары каталога в порядке создания: молоко магазинов, затем ассортимент без повторов."""
    found = {}
    for spec in STORES.values():
        found.setdefault(spec["milk"].name, spec["milk"])
    for spec in STORES.values():
        for item in spec["pool"]:
            found.setdefault(item.name, item)
    return list(found.values())


def allowed_database(name):
    return bool(re.fullmatch(r"(?:test_[A-Za-z0-9_]+|checkist_qa(?:_[A-Za-z0-9_]+)?)", str(name)))


def seed_demo():
    """Создаёт демо один раз; повторный вызов ничего не меняет. Возвращает числа и ``created``.

    Категории, обобщённые продукты, страны, валюты и ставка налога берутся
    существующие, если уже есть, и не правятся; ожидаемые числа статистики верны на
    базе, где до демо не было одноимённых обобщённых продуктов в других категориях.
    """
    from catalog.models import Category, GenericProduct, Product
    from receipts.dedup import name_key
    from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
    from stores.models import Country, Currency, Merchant, Store, TaxRate

    if not allowed_database(settings.DATABASES["default"]["NAME"]):
        raise DemoError("Stats demo data require a test_* or checkist_qa* database; dev/production is forbidden.")
    sales = build_receipts()
    try:
        with transaction.atomic():
            if Merchant.objects.filter(tax_id__in=[spec["tax_id"] for spec in STORES.values()]).exists():
                return {"created": False}
            countries = {
                code: Country.objects.get_or_create(code=code, defaults={"name": name})[0]
                for code, name in (("DE", "Германия"), ("KZ", "Казахстан"))
            }
            for code, name in (("EUR", "Евро"), ("KZT", "Казахстанский тенге")):
                Currency.objects.get_or_create(code=code, defaults={"name": name})
            stores = {}
            for key, spec in STORES.items():
                merchant = Merchant.objects.create(
                    country=countries[spec["country"]], legal_name=spec["legal_name"],
                    brand_name=spec["brand_name"], tax_id=spec["tax_id"], tax_id_type=Merchant.TaxIdType.OTHER,
                )
                stores[key] = Store.objects.create(
                    merchant=merchant, country=countries[spec["country"]], name=spec["brand_name"],
                    address_raw=spec["address_raw"], city=spec["city"], timezone=spec["timezone"],
                )
            categories = {}
            for name, parent in CATEGORIES:
                categories[name], _ = Category.objects.get_or_create(
                    parent=categories[parent] if parent else None, name=name,
                )
            generics = {}
            for name, (category, base_unit) in GENERICS.items():
                generics[name], _ = GenericProduct.objects.get_or_create(
                    name__iexact=name,
                    defaults={"name": name, "category": categories[category], "base_unit": base_unit},
                )
            products = {}
            for item in items():
                quantity, unit = item.package or (None, "")
                products[item.name] = Product.objects.create(
                    generic=generics[item.generic], name=item.name,
                    package_quantity=D(quantity) if quantity else None, package_unit=unit,
                )
            # Как после импорта: написание товара у каждого продавца, где его покупали.
            sold = dict.fromkeys(
                (sale.store, line.item) for sale in sales for line in sale.lines if line.item is not None
            )
            ProductAlias.objects.bulk_create(
                ProductAlias(
                    merchant=stores[store].merchant, product=products[name], name_key=name_key(name), raw_name=name,
                )
                for store, name in sold
            )

            receipts = Receipt.objects.bulk_create(
                Receipt(
                    store=stores[sale.store], currency_id=STORES[sale.store]["currency"], operation=sale.operation,
                    purchased_on=sale.on,
                    purchased_at=datetime.combine(sale.on, sale.at, tzinfo=ZoneInfo(STORES[sale.store]["timezone"])),
                    receipt_number=sale.number, total=sale.total,
                    discount_total=sum(line.discount for line in sale.lines)
                    + (sale.receipt_discount[1] if sale.receipt_discount else 0),
                    prices_include_tax=sale.tax is None,
                )
                for sale in sales
            )

            def rows(with_parent):
                for sale, receipt in zip(sales, receipts):
                    for position, line in enumerate(sale.lines, 1):
                        if (line.parent is not None) == with_parent:
                            yield (receipt.pk, position), line

            def create(planned, parents=None):
                planned = list(planned)
                created = ReceiptLine.objects.bulk_create(
                    ReceiptLine(
                        receipt_id=receipt_id, position=position, kind=line.kind, raw_name=line.raw_name,
                        quantity=line.quantity, unit=line.unit, unit_price=line.unit_price, amount=line.amount,
                        discount_amount=line.discount, product=products.get(line.item),
                        parent=parents[receipt_id, line.parent + 1] if parents else None,
                    )
                    for (receipt_id, position), line in planned
                )
                return {key: saved for (key, _), saved in zip(planned, created)}

            saved = create(rows(with_parent=False))
            # Залог ссылается на строку товара, поэтому создаётся вторым проходом.
            saved.update(create(rows(with_parent=True), parents=saved))

            discounts, taxes = [], []
            for sale, receipt in zip(sales, receipts):
                position = 0
                for index, line in enumerate(sale.lines, 1):
                    if line.discount:
                        position += 1
                        discounts.append(ReceiptDiscount(
                            receipt=receipt, line=saved[receipt.pk, index], position=position,
                            name=line.discount_name, amount=line.discount,
                        ))
                if sale.receipt_discount:
                    name, amount = sale.receipt_discount
                    discounts.append(ReceiptDiscount(receipt=receipt, position=position + 1, name=name, amount=amount))
                if sale.tax:
                    rate, net, tax, gross = sale.tax
                    tax_rate, _ = TaxRate.objects.get_or_create(
                        country=countries[STORES[sale.store]["country"]], kind=TaxRate.Kind.VAT, rate=rate,
                        defaults={"name": f"MwSt {rate.normalize():f}%"},
                    )
                    taxes.append(ReceiptTax(receipt=receipt, tax_rate=tax_rate, net=net, tax=tax, gross=gross))
            ReceiptDiscount.objects.bulk_create(discounts)
            ReceiptTax.objects.bulk_create(taxes)
    except IntegrityError:
        raise DemoError("Demo names collide with existing catalog records; use a clean QA database.") from None
    return {
        "created": True, "merchants": len(STORES), "products": len(products), "receipts": len(receipts),
        "lines": len(saved), "discounts": len(discounts),
    }
