"""Вымышленные данные «длинных хвостов» для раскрытия строки «Прочее» в статистике трат.

Только для пустой БД ``test_*`` и ``checkist_qa*``; на одну базу с ``seed_stats_demo`` не
ставится — у того свои эталоны и числа приёмки. Случайности и текущего времени нет:
цены выводятся из порядкового номера товара, поэтому повторная сборка даёт те же числа.
``build_receipts`` и ``checks`` БД не используют.

Что есть в данных за период ``PERIOD`` (2025 год):

- EUR: 14 корневых категорий с тратами (13 названных и «Не разобрано»), 13 подкатегорий
  «Продукты питания» и товары самой этой категории, 52 обобщённых продукта, 520 товаров,
  13 магазинов разных продавцов — «Прочее» есть в каждой разбивке, у товаров оно остаётся
  и при ``limit=500``;
- один товар (``NEGATIVE``) с отрицательной суммой: в декабре возвращено три штуки,
  купленные до периода, а за период куплена одна. При ``limit=500`` он остаётся внутри
  «Прочего» всей разбивки «Товары», отдельной строкой состава виден внутри своей
  категории — там доли первых строк в двух запросах расходятся;
- KZT: один магазин, 15 товаров — «Прочее» у товаров второго блока валюты;
- особые строки: несопоставленные (обе валюты), услуга, залог и возврат тары (EUR).

Одна покупка лежит до периода (декабрь 2024): без фильтра по датам сумма ``NEGATIVE``
положительна. Скидок, налоговых итогов и написаний товаров (``ProductAlias``) нет.
Ожидаемые счётчики — ``checks``, точные числа — ``receipts/tests/test_tail_demo.py``.
"""
from datetime import date, datetime, time
from decimal import Decimal
from typing import NamedTuple
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction

from receipts.demo import (
    DEPOSIT, DEPOSIT_RETURN, PRODUCT, REFUND, SALE, SERVICE, UNASSIGNED, DemoError, Line, Sale, allowed_database,
)

D = Decimal
PERIOD = (date(2025, 1, 1), date(2025, 12, 31))
RECEIPT_PREFIX = "DEMO-TAIL-"
TAX_PREFIX = "DEMOTAIL"
FOOD = "Продукты питания"
KZ = "kz"
DEFAULT_LIMIT, WIDE_LIMIT = 10, 500  # серверный limit по умолчанию и запрос состава

# (корневая категория, подкатегория либо None, обобщённые продукты); порядок создания.
TREE = (
    (FOOD, "Молочные продукты", ("Молоко", "Сыр")),
    (FOOD, "Хлеб и выпечка", ("Хлеб", "Булочки")),
    (FOOD, "Овощи", ("Картофель", "Томаты")),
    (FOOD, "Фрукты", ("Яблоки", "Бананы")),
    (FOOD, "Мясо", ("Курица", "Говядина")),
    (FOOD, "Рыба", ("Лосось", "Сельдь")),
    (FOOD, "Крупы", ("Рис", "Гречка")),
    (FOOD, "Макароны", ("Спагетти", "Лапша")),
    (FOOD, "Сладости", ("Шоколад", "Печенье")),
    (FOOD, "Консервы", ("Фасоль консервированная", "Тунец консервированный")),
    (FOOD, "Заморозка", ("Пельмени", "Мороженое")),
    (FOOD, "Соусы", ("Кетчуп", "Майонез")),
    (FOOD, "Специи", ("Перец молотый", "Соль")),
    (FOOD, None, ("Готовая еда",)),  # товары самой корневой категории
    ("Напитки", None, ("Вода", "Сок")),
    ("Бытовая химия", None, ("Стиральное средство", "Средство для посуды")),
    ("Косметика и гигиена", None, ("Шампунь", "Зубная паста")),
    ("Товары для дома", None, ("Лампочки", "Губки")),
    ("Канцелярия", None, ("Тетради", "Ручки")),
    ("Зоотовары", None, ("Корм для кошек", "Корм для собак")),
    ("Детские товары", None, ("Подгузники", "Детское пюре")),
    ("Аптека", None, ("Пластырь", "Витамины")),
    ("Одежда", None, ("Носки", "Перчатки")),
    ("Электроника", None, ("Батарейки", "Кабели")),
    ("Сад и огород", None, ("Семена", "Грунт")),
    ("Автотовары", None, ("Омыватель стёкол", "Автошампунь")),
    (UNASSIGNED, None, (UNASSIGNED,)),
)
PER_GENERIC = 10  # товаров EUR у каждого обобщённого продукта
EUR_STORES = 13
LINES_PER_RECEIPT = 10
RECEIPT_MONTHS = (2, 5, 8, 11)  # чеки магазина по порядку; день месяца — номер магазина
AT = time(12, 0)
# Цена товара EUR в центах: перестановка номеров, все цены разные; множитель подобран так,
# что разные и суммы обобщённых продуктов, категорий и магазинов (сверяет тест плана).
PRICE_BASE, PRICE_STEP, PRICE_MIX = 300, 7, 173

# Товары второй валюты: (обобщённый продукт, сколько товаров).
KZ_GENERICS = (("Молоко", 5), ("Хлеб", 5), (UNASSIGNED, 5))
KZ_RECEIPTS = ((date(2025, 3, 10), 8), (date(2025, 9, 10), 7))
KZ_PRICE_BASE, KZ_PRICE_STEP, KZ_PRICE_MIX = 200, 35, 4

# Товар с отрицательной суммой за период и подкатегория, где он виден строкой состава.
NEGATIVE, NEGATIVE_SUB, NEGATIVE_GENERIC = "Демо Шоколад 04", "Сладости", "Шоколад"
NEGATIVE_RETURNED = 3  # штук куплено до периода и возвращено в периоде
BEFORE_PERIOD, REFUND_ON = date(2024, 12, 20), date(2025, 12, 5)

UNMATCHED = {"EUR": ("Aktionsartikel", "2.49"), "KZT": ("Товар без названия", "350")}
SERVICE_LINE, SERVICE_STORES = ("Demo Lieferservice", "2.90"), (0, 1)
DEPOSIT_LINE, DEPOSIT_STORES = ("Pfand 0,25", "0.25", 6), (0, 1, 2)
DEPOSIT_RETURN_LINE, DEPOSIT_RETURN_STORE = ("Leergut", "0.25", 4), 0


class Good(NamedTuple):
    """Товар каталога: ``store`` — где его покупают (номер магазина EUR либо ``KZ``)."""

    name: str
    generic: str
    price: Decimal
    store: object


def _label(generic):
    return "Новинка" if generic == UNASSIGNED else generic


def generics():
    """``{обобщённый продукт: (корневая категория, подкатегория либо None)}`` в порядке создания."""
    return {name: (root, sub) for root, sub, names in TREE for name in names}


def eur_goods():
    names = list(generics())
    count = len(names) * PER_GENERIC
    return [
        Good(
            f"Демо {_label(names[index // PER_GENERIC])} {index % PER_GENERIC + 1:02d}", names[index // PER_GENERIC],
            D(PRICE_BASE + PRICE_STEP * (index * PRICE_MIX % count)) / 100, index % EUR_STORES,
        )
        for index in range(count)
    ]


def kz_goods():
    names = [(generic, number) for generic, count in KZ_GENERICS for number in range(1, count + 1)]
    return [
        Good(
            f"Демо {_label(generic)} Алматы {number:02d}", generic,
            D(KZ_PRICE_BASE + KZ_PRICE_STEP * (index * KZ_PRICE_MIX % len(names))), KZ,
        )
        for index, (generic, number) in enumerate(names)
    ]


def goods():
    """Все товары каталога в порядке создания: EUR, затем KZT."""
    return [*eur_goods(), *kz_goods()]


def stores():
    """``{ключ магазина: описание}``: 13 немецких продавцов (EUR) и один казахстанский (KZT)."""
    found = {
        index: {
            "legal_name": f"Restmarkt {index + 1:02d} Testhandel GmbH (вымышленный)",
            "brand_name": f"Restmarkt {index + 1:02d}", "tax_id": f"{TAX_PREFIX}{index + 1:04d}",
            "country": "DE", "currency": "EUR", "timezone": "Europe/Berlin", "city": "Musterstadt",
            "address_raw": f"Restweg {index + 1}, 00000 Musterstadt",
        }
        for index in range(EUR_STORES)
    }
    found[KZ] = {
        "legal_name": "ТОО «Демо Хвост-маркет» (вымышленное)", "brand_name": "Хвост-маркет",
        "tax_id": f"{TAX_PREFIX}{EUR_STORES + 1:04d}", "country": "KZ", "currency": "KZT",
        "timezone": "Asia/Almaty", "city": "Алматы", "address_raw": "г. Алматы, ул. Хвостовая, д. 5",
    }
    return found


def _product_line(good, quantity=1):
    return Line(PRODUCT, good.name, good.name, D(quantity), "pcs", good.price, quantity * good.price)


def _extra(kind, name, unit_price, quantity=1, parent=None):
    unit_price = D(unit_price)
    return Line(kind, name, None, D(quantity), "pcs", unit_price, quantity * unit_price, parent=parent)


def _sale(store, code, on, lines, operation=SALE):
    number = f"{RECEIPT_PREFIX}{code}"
    return Sale(store, number, operation, on, AT, tuple(lines), None, None, sum(line.amount for line in lines))


def build_receipts():
    """Все чеки демо: магазины EUR по порядку, покупка до периода, возврат, затем KZT. БД не используется."""
    sales = []
    by_store = {}
    for good in eur_goods():
        by_store.setdefault(good.store, []).append(good)
    for store, bought in by_store.items():
        for index in range(len(bought) // LINES_PER_RECEIPT):
            lines = [_product_line(good) for good in bought[index * LINES_PER_RECEIPT:(index + 1) * LINES_PER_RECEIPT]]
            if index == 0:
                lines.append(_extra(PRODUCT, *UNMATCHED["EUR"]))
            if index == 1 and store in SERVICE_STORES:
                lines.append(_extra(SERVICE, *SERVICE_LINE))
            if index == 2 and store in DEPOSIT_STORES:
                lines.append(_extra(DEPOSIT, *DEPOSIT_LINE, parent=0))
            if index == 3 and store == DEPOSIT_RETURN_STORE:
                name, unit_price, count = DEPOSIT_RETURN_LINE
                lines.append(_extra(DEPOSIT_RETURN, name, unit_price, -count))
            on = date(PERIOD[0].year, RECEIPT_MONTHS[index], store + 1)
            sales.append(_sale(store, f"{store + 1:02d}-{index + 1}", on, lines))

    negative = next(good for good in eur_goods() if good.name == NEGATIVE)
    code = f"{negative.store + 1:02d}"
    sales.append(_sale(negative.store, f"{code}-0", BEFORE_PERIOD, [_product_line(negative, NEGATIVE_RETURNED)]))
    sales.append(
        _sale(negative.store, f"{code}-R", REFUND_ON, [_product_line(negative, -NEGATIVE_RETURNED)], operation=REFUND)
    )

    bought, start = kz_goods(), 0
    for index, (on, count) in enumerate(KZ_RECEIPTS):
        lines = [_product_line(good) for good in bought[start:start + count]]
        if index == 0:
            lines.append(_extra(PRODUCT, *UNMATCHED["KZT"]))
        sales.append(_sale(KZ, f"KZ-{index + 1}", on, lines))
        start += count
    return sales


def _counters(items, special=()):
    """Счётчики одной разбивки: без ``limit`` и с ``limit=WIDE_LIMIT``."""
    shown, wide = min(items, DEFAULT_LIMIT), min(items, WIDE_LIMIT)
    return {
        "items": items, "shown": shown, "other": items - shown,
        "tail_rows": wide - shown, "tail_other": items - wide, "special": list(special),
    }


def checks(ids):
    """Проверки экрана ``/stats``: адрес, блок валюты и ожидаемые счётчики. БД не используется.

    ``ids`` — ``{"food", "negative_category", "negative_generic"}`` с id записей каталога.
    ``items`` — обычных элементов всего, ``shown`` и ``other`` — строк и свёрнуто в «Прочее»
    без ``limit``; ``tail_rows`` и ``tail_other`` — строк состава и остаток при
    ``limit=WIDE_LIMIT``; ``special`` — особые строки блока после состава.
    """
    tree = generics()
    roots = len(dict.fromkeys(root for root, _sub in tree.values()))
    food = len({sub for root, sub in tree.values() if root == FOOD})  # подкатегории и товары самой категории
    in_food = [name for name, (root, _sub) in tree.items() if root == FOOD]
    in_sub = [name for name, (_root, sub) in tree.items() if sub == NEGATIVE_SUB]
    special = ("unmatched", "service", "deposit")

    def check(title, counters, *, currency="EUR", filtered=True, note=None, **query):
        params = {"date_from": PERIOD[0].isoformat(), "date_to": PERIOD[1].isoformat()}
        if filtered:
            params["currency"] = currency
        params.update({name: value for name, value in query.items() if value is not None})
        search = urlencode(params)
        return {
            "title": title, "screen": f"/stats?{search}", "api": f"/api/stats/spending/?{search}",
            "currency": currency, **counters, **({"note": note} if note else {}),
        }

    return [
        check("Категории, верхний уровень", _counters(roots, special)),
        check(f"Категории внутри «{FOOD}»", _counters(food), category=ids["food"]),
        check("Магазины", _counters(EUR_STORES), group_by="store"),
        check("Обобщённые продукты", _counters(len(tree), special), group_by="generic"),
        check(
            "Товары: элементов больше лимита", _counters(len(tree) * PER_GENERIC, special), group_by="product",
            note=f"При limit={WIDE_LIMIT} остаток остаётся строкой; товар «{NEGATIVE}» внутри остатка, базы долей равны.",
        ),
        check(
            f"Обобщённые продукты внутри «{FOOD}»", _counters(len(in_food)),
            group_by="generic", category=ids["food"],
        ),
        check(
            f"Товары внутри «{NEGATIVE_SUB}»: отрицательная сумма в хвосте",
            _counters(len(in_sub) * PER_GENERIC), group_by="product", category=ids["negative_category"],
            note=f"«{NEGATIVE}» — последняя строка состава без доли; доли первых строк в двух запросах разные.",
        ),
        check(
            f"Товары обобщённого продукта «{NEGATIVE_GENERIC}»: «Прочего» нет", _counters(PER_GENERIC),
            group_by="product", generic=ids["negative_generic"],
        ),
        check(
            "Товары, второй блок валюты", _counters(sum(count for _name, count in KZ_GENERICS), ("unmatched",)),
            currency="KZT", filtered=False, group_by="product",
            note="Адрес без валюты: на экране два блока, блок EUR — как в проверке «Товары: элементов больше лимита».",
        ),
    ]


def _summary(ids, negative_id):
    negative = next(good for good in eur_goods() if good.name == NEGATIVE)
    return {
        "period": {"date_from": PERIOD[0].isoformat(), "date_to": PERIOD[1].isoformat()},
        "negative_product": {
            "id": negative_id, "name": NEGATIVE,
            "amount": str((1 - NEGATIVE_RETURNED) * negative.price),
        },
        "checks": checks(ids),
    }


def seed_tail_demo():
    """Создаёт демо один раз в пустой базе; повторный вызов ничего не меняет.

    Возвращает ``created``, числа созданного (при создании), период, товар с отрицательной
    суммой и проверки ``checks`` с настоящими id. База с другими чеками, каталогом или
    магазинами отвергается: ожидаемые счётчики верны только без посторонних данных.
    """
    from catalog.models import Category, GenericProduct, Product
    from receipts.models import Receipt, ReceiptLine
    from receipts.ownership import local_user
    from stores.models import Country, Currency, Merchant, Store

    if not allowed_database(settings.DATABASES["default"]["NAME"]):
        raise DemoError("Stats tail demo data require a test_* or checkist_qa* database; dev/production is forbidden.")
    sales, planned = build_receipts(), stores()

    def summary():
        ids = {
            "food": Category.objects.get(name=FOOD, parent=None).pk,
            "negative_category": Category.objects.get(name=NEGATIVE_SUB, parent__name=FOOD).pk,
            "negative_generic": GenericProduct.objects.get(name=NEGATIVE_GENERIC).pk,
        }
        return _summary(ids, Product.objects.get(name=NEGATIVE).pk)

    try:
        with transaction.atomic():
            if Merchant.objects.filter(tax_id__startswith=TAX_PREFIX).exists():
                return {"created": False, **summary()}
            busy = [
                model._meta.label for model in (Category, GenericProduct, Product, Merchant, Store, Receipt)
                if model.objects.exists()
            ]
            if busy:
                raise DemoError(f"Stats tail demo data require an empty QA database; found {', '.join(busy)}.")
            # Владелец всех чеков демо; отказ и повторный вызов до него не доходят.
            owner = local_user()
            countries = {
                code: Country.objects.get_or_create(code=code, defaults={"name": name})[0]
                for code, name in (("DE", "Германия"), ("KZ", "Казахстан"))
            }
            for code, name in (("EUR", "Евро"), ("KZT", "Казахстанский тенге")):
                Currency.objects.get_or_create(code=code, defaults={"name": name})
            saved_stores = {}
            for key, spec in planned.items():
                merchant = Merchant.objects.create(
                    country=countries[spec["country"]], legal_name=spec["legal_name"],
                    brand_name=spec["brand_name"], tax_id=spec["tax_id"], tax_id_type=Merchant.TaxIdType.OTHER,
                )
                saved_stores[key] = Store.objects.create(
                    merchant=merchant, country=countries[spec["country"]], name=spec["brand_name"],
                    address_raw=spec["address_raw"], city=spec["city"], timezone=spec["timezone"],
                )
            categories, saved_generics = {}, {}
            for name, (root, sub) in generics().items():
                for path in ((root, None), (root, sub)) if sub else ((root, None),):
                    if path not in categories:
                        categories[path] = Category.objects.create(
                            name=path[1] or root, parent=categories[root, None] if path[1] else None,
                        )
                saved_generics[name] = GenericProduct.objects.create(
                    name=name, category=categories[root, sub], base_unit="pcs",
                )
            products = {
                product.name: product for product in Product.objects.bulk_create(
                    Product(generic=saved_generics[good.generic], name=good.name) for good in goods()
                )
            }

            receipts = Receipt.objects.bulk_create(
                Receipt(
                    owner=owner, store=saved_stores[sale.store], currency_id=planned[sale.store]["currency"],
                    operation=sale.operation, purchased_on=sale.on,
                    purchased_at=datetime.combine(sale.on, sale.at, tzinfo=ZoneInfo(planned[sale.store]["timezone"])),
                    receipt_number=sale.number, total=sale.total,
                )
                for sale in sales
            )

            def create(with_parent, parents=None):
                planned_lines = [
                    ((receipt.pk, position), line)
                    for sale, receipt in zip(sales, receipts) for position, line in enumerate(sale.lines, 1)
                    if (line.parent is not None) == with_parent
                ]
                created = ReceiptLine.objects.bulk_create(
                    ReceiptLine(
                        receipt_id=receipt_id, position=position, kind=line.kind, raw_name=line.raw_name,
                        quantity=line.quantity, unit=line.unit, unit_price=line.unit_price, amount=line.amount,
                        product=products.get(line.item),
                        parent=parents[receipt_id, line.parent + 1] if parents else None,
                    )
                    for (receipt_id, position), line in planned_lines
                )
                return {key: line for (key, _), line in zip(planned_lines, created)}

            lines = create(with_parent=False)
            # Залог ссылается на строку товара, поэтому создаётся вторым проходом.
            lines.update(create(with_parent=True, parents=lines))
            return {
                "created": True, "merchants": len(saved_stores), "categories": len(categories),
                "generics": len(saved_generics), "products": len(products), "receipts": len(receipts),
                "lines": len(lines), **summary(),
            }
    except IntegrityError:
        raise DemoError("Demo names collide with existing records; use an empty QA database.") from None
