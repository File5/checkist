"""Траты за период: суммы строк чеков по категориям, продуктам, товарам и магазинам.

``collect`` читает БД тремя запросами независимо от объёма данных, ``summarize``
считает без БД. Валюты не складываются: на каждую валюту чека свой блок. В траты
входят все чеки, включая возвраты, — суммы берутся со своим знаком.

Значение элемента — ``Σ (amount − discount_amount)`` его строк. Скидка на весь чек по
строкам не распределяется и видна разницей ``receipts_total − lines_paid``.

Категория строки — собственная ``ReceiptLine.category`` (трата, внесённая вручную, либо
строка-услуга обслуживания и чаевых — ``receipts.service_charges``), а без неё — категория
её товара: названная покупка траты вручную (товар каталога, 2026-10-13) лежит в категории,
выбранной человеком, а не в категории товара. Строка без товара в разбивке по
категориям лежит в своей категории, по обобщённым продуктам и товарам — в особом
элементе ``no_product``. Чеки без магазина (``store`` NULL) в разбивке по магазинам —
особый элемент ``no_store``. Строка без товара и без категории — ``unmatched``, как раньше.

Основная валюта семьи (2026-10-13): ``rebase`` переводит строки и итоги чеков в неё по курсу
на дату покупки (``rates.convert``) — ``summarize`` по такому набору даёт блок основной валюты,
куда сложены все валюты, и блоки только тех трат, курса которых нет («без курса»).
"""
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from typing import NamedTuple

from django.db.models import Count, F, Sum

from catalog.models import Product
from receipts.decimal_math import price_context, round_decimal
from receipts.models import ReceiptLine

GROUPS = ("category", "generic", "product", "store")
# Особые элементы в порядке ответа: в «прочее» не сворачиваются.
SPECIAL = ("unmatched", "service", "deposit", "no_product", "no_store")
# Служебные категория и обобщённый продукт, куда импорт кладёт новые товары.
UNASSIGNED_NAME = "Не разобрано"

_KIND = ReceiptLine.Kind
_SPECIAL_KINDS = {_KIND.SERVICE: "service", _KIND.DEPOSIT: "deposit", _KIND.DEPOSIT_RETURN: "deposit"}
_ZERO = Decimal("0.00")


class LineRow(NamedTuple):
    """Строки одного чека с одним товаром, видом и единицей, уже сложенные."""

    currency: str
    receipt_id: int
    store_id: int | None
    product_id: int | None
    kind: str
    unit: str
    paid: Decimal
    lines: int
    quantity: Decimal
    category_id: int | None = None  # ReceiptLine.category: важнее категории товара


class ReceiptRow(NamedTuple):
    """Чеки одного магазина в одной валюте."""

    currency: str
    store_id: int | None
    count: int
    total: Decimal


class DayTotal(NamedTuple):
    """Чеки одного магазина в одной валюте за один день: для пересчёта по курсу дня."""

    currency: str
    store_id: int | None
    day: date
    count: int
    total: Decimal


class ProductInfo(NamedTuple):
    name: str
    generic_id: int
    generic_name: str
    category_id: int


@dataclass
class Collected:
    lines: list
    receipts: list
    products: dict
    days: dict = field(default_factory=dict)  # {receipt_id: purchased_on} строк ``lines``
    day_totals: list = field(default_factory=list)  # DayTotal; ``receipts`` — их сумма по магазину

    def needs(self):
        """Пары ``(валюта, день)`` трат набора: какие курсы нужны для ``rebase``."""
        return {(row.currency, row.day) for row in self.day_totals}


@dataclass
class Item:
    kind: str
    id: int | None
    name: str | None
    amount: Decimal
    lines_count: int
    receipts_count: int
    direct: bool = False
    unassigned: bool = False
    share_percent: Decimal | None = None
    quantity: Decimal | None = None
    unit: str | None = None
    extra: dict = field(default_factory=dict)  # у магазина — city, country


@dataclass
class Other:
    count: int
    amount: Decimal
    share_percent: Decimal | None = None


@dataclass
class Block:
    currency: str
    receipts_count: int
    receipts_total: Decimal | None
    lines_paid: Decimal
    difference: Decimal | None
    items: list
    other: Other | None


def collect(receipts, product_ref=None):
    """Данные расчёта по чекам ``receipts`` (queryset ``Receipt``); три запроса.

    ``product_ref`` — выражение «товар строки» от ``ReceiptLine``; по умолчанию
    ``product_id``. Слой API передаёт выражение, относящее строку поглощённого
    слиянием товара к оставляемому.
    """
    lines, days = [], {}
    for *row, day in (
        ReceiptLine.objects.filter(receipt__in=receipts.values("pk"))
        .values("receipt__currency_id", "receipt_id", "receipt__store_id", "kind", "unit", "category_id",
                "receipt__purchased_on")
        .annotate(
            owner=product_ref if product_ref is not None else F("product_id"),
            paid=Sum(F("amount") - F("discount_amount")), lines=Count("pk"), quantity_sum=Sum("quantity"),
        )
        .order_by()
        .values_list(
            "receipt__currency_id", "receipt_id", "receipt__store_id", "owner", "kind", "unit",
            "paid", "lines", "quantity_sum", "category_id", "receipt__purchased_on",
        )
    ):
        lines.append(LineRow(*row))
        days[row[1]] = day
    day_totals = [
        DayTotal(*row) for row in receipts.values("currency_id", "store_id", "purchased_on")
        .annotate(count=Count("pk"), total_sum=Sum("total")).order_by()
        .values_list("currency_id", "store_id", "purchased_on", "count", "total_sum")
    ]
    ids = {row.product_id for row in lines if row.product_id is not None}
    products = {
        pk: ProductInfo(*info) for pk, *info in Product.objects.filter(pk__in=ids)
        .values_list("pk", "name", "generic_id", "generic__name", "generic__category_id")
    }
    return Collected(lines, by_store(day_totals), products, days, day_totals)


def by_store(day_totals):
    """``[ReceiptRow]`` — чеки по валюте и магазину из ``DayTotal`` (дни сложены)."""
    found = {}
    with price_context():
        for row in day_totals:
            key = (row.currency, row.store_id)
            count, total = found.get(key, (0, _ZERO))
            found[key] = (count + row.count, total + row.total)
    return [ReceiptRow(currency, store_id, count, total) for (currency, store_id), (count, total) in found.items()]


def rebase(data, converter):
    """Набор ``data`` в основной валюте ``converter.base``: суммы строк и чеков — по курсу дня покупки.

    Строки и чеки, курса которых нет, остаются в своей валюте: ``summarize`` даст им отдельные
    блоки — траты «без курса», не вошедшие в основной. БД не используется.
    """
    lines = []
    for row in data.lines:
        paid = converter.convert(row.paid, row.currency, data.days.get(row.receipt_id))
        lines.append(row if paid is None or row.currency == converter.base
                     else row._replace(currency=converter.base, paid=paid))
    day_totals = []
    for row in data.day_totals:
        total = converter.convert(row.total, row.currency, row.day)
        day_totals.append(row if total is None or row.currency == converter.base
                          else row._replace(currency=converter.base, total=total))
    return Collected(lines, by_store(day_totals), data.products, data.days, day_totals)


def unconverted(data, converter):
    """Траты без курса (``converter`` не знает курса валюты на день покупки): ``[(валюта, чеков, сумма)]``."""
    found = {}
    with price_context():
        for row in data.day_totals:
            if row.currency != converter.base and converter.factor(row.currency, row.day) is None:
                count, total = found.get(row.currency, (0, _ZERO))
                found[row.currency] = (count + row.count, total + row.total)
    return [(currency, count, total) for currency, (count, total) in sorted(found.items())]


class _Bucket:
    def __init__(self):
        self.amount, self.lines, self.quantity = _ZERO, 0, Decimal(0)
        self.receipts, self.units = set(), set()

    def add(self, row):
        self.amount += row.paid
        self.lines += row.lines
        self.quantity += row.quantity
        self.receipts.add(row.receipt_id)
        self.units.add(row.unit)


def _special(row, product):
    """Особый элемент строки либо ``None`` для строки товара или категории.

    Строка-услуга с категорией (обслуживание и чаевые, ``receipts.service_charges``) лежит
    в своей категории, как трата вручную; без категории — в особом ``service``.
    """
    if row.kind != _KIND.PRODUCT and not (row.kind == _KIND.SERVICE and row.category_id is not None):
        return _SPECIAL_KINDS[row.kind]
    return "unmatched" if product is None and row.category_id is None else None


def line_category(row, product):
    """Категория строки: своя ``ReceiptLine.category``, иначе категория товара; ``None`` — ни той, ни другой."""
    if row.category_id is not None or product is None:
        return row.category_id
    return product.category_id


def _store_key(store_id):
    return ("no_store", None, False) if store_id is None else ("store", store_id, False)


def _category_key(tree, category_id, parent):
    """Сектор разбивки по категориям: корень либо прямой потомок ``parent``; сама ``parent`` — direct."""
    path = tree.path_ids(category_id)
    if parent is None:
        return ("category", path[0], False)
    if category_id == parent or parent not in path:
        return ("category", parent, True)
    return ("category", path[path.index(parent) + 1], False)


def _share(amount, positive):
    if amount <= 0 or positive <= 0:
        return None
    return round_decimal(amount * 100 / positive, 2)


def fold(regular, special, limit):
    """Порядок, свёртка «прочего» и доли: ``(items, other)``.

    Обычные элементы — по сумме по убыванию, затем ``name``, ``id``; после первых
    ``limit`` сворачиваются в ``other``. Особые идут следом в порядке ``SPECIAL``.
    Доля — от суммы положительных элементов ответа (показанные и «прочее»); у
    неположительного элемента её нет.
    """
    regular = sorted(regular, key=lambda item: (-item.amount, item.name, item.id))
    special = sorted(special, key=lambda item: SPECIAL.index(item.kind))
    shown, rest = regular[:limit], regular[limit:]
    items = [*shown, *special]
    with price_context():
        other = Other(len(rest), sum((item.amount for item in rest), _ZERO)) if rest else None
        parts = [item.amount for item in items] + ([other.amount] if other else [])
        positive = sum((part for part in parts if part > 0), _ZERO)
        for part in (*items, *([other] if other else [])):
            part.share_percent = _share(part.amount, positive)
    return items, other


def spent_categories(data):
    """``{(валюта, категория)}`` строк, которые разбивка по категориям кладёт в категорию; без БД."""
    found = set()
    for row in data.lines:
        product = data.products.get(row.product_id) if row.kind == _KIND.PRODUCT else None
        if _special(row, product):
            continue
        category_id = line_category(row, product)
        if category_id is not None:
            found.add((row.currency, category_id))
    return found


def summarize(data, *, group_by="category", limit=10, tree=None, category=None, generic=None, stores=None):
    """Блоки по валютам из ``Collected``; БД не используется.

    ``tree`` — дерево категорий (``path_ids``, ``descendant_ids``, ``name``,
    ``parent_id``), нужно для ``group_by="category"`` и фильтра ``category``; категория
    фильтра должна быть в дереве. ``stores`` — ``{id: {"name", "city", "country"}}`` для
    ``group_by="store"``.

    С фильтром ``category`` или ``generic`` считаются только строки сопоставленных
    товаров (с фильтром ``category`` — и строки без товара с категорией внутри неё,
    они в элементе ``no_product`` при разбивке по продуктам и товарам): других особых
    элементов нет, ``receipts_total`` и ``difference`` — ``None``,
    ``receipts_count`` — чеки с такими строками, значение магазина — сумма этих строк.
    Без фильтра значение магазина — ``Σ Receipt.total``.
    """
    filtered = category is not None or generic is not None
    inside = set(tree.descendant_ids(category)) if category is not None else None
    generic_names = {info.generic_id: info.generic_name for info in data.products.values()}
    buckets = {}
    for row in data.lines:
        product = data.products.get(row.product_id) if row.kind == _KIND.PRODUCT else None
        special = _special(row, product)
        category_id = line_category(row, product)
        if filtered and (
            special
            or (generic is not None and (product is None or product.generic_id != generic))
            or (inside is not None and category_id not in inside)
        ):
            continue
        if group_by == "store":
            key = _store_key(row.store_id)
        elif special:
            key = (special, None, False)
        elif product is None and group_by in ("product", "generic"):
            key = ("no_product", None, False)
        elif group_by == "product":
            key = ("product", row.product_id, False)
        elif group_by == "generic":
            key = ("generic", product.generic_id, False)
        else:
            key = _category_key(tree, category_id, category)
        buckets.setdefault(row.currency, {}).setdefault(key, _Bucket()).add(row)

    receipts = {}
    for row in data.receipts:
        receipts.setdefault(row.currency, {})[row.store_id] = row

    def item(key, bucket):
        kind, pk, direct = key
        result = Item(kind, pk, None, bucket.amount, bucket.lines, len(bucket.receipts), direct=direct)
        if kind == "category":
            result.name = tree.name(pk)
            result.unassigned = result.name == UNASSIGNED_NAME and tree.parent_id(pk) is None
        elif kind == "generic":
            result.name = generic_names[pk]
            result.unassigned = result.name.casefold() == UNASSIGNED_NAME.casefold()
        elif kind == "product":
            result.name = data.products[pk].name
            if len(bucket.units) == 1:
                result.quantity, result.unit = bucket.quantity, next(iter(bucket.units))
        elif kind == "store":
            result.name = stores[pk]["name"]
            result.extra = {"city": stores[pk]["city"], "country": stores[pk]["country"]}
        return result

    blocks = []
    for currency in sorted(buckets if filtered else receipts):
        found = dict(buckets.get(currency, {}))
        by_store = receipts.get(currency, {})
        if group_by == "store" and not filtered:
            # Магазин с чеками без строк тоже элемент; сумма и число чеков — из чеков.
            for store_id in by_store:
                found.setdefault(_store_key(store_id), _Bucket())
        items = [item(key, bucket) for key, bucket in found.items()]
        if group_by == "store" and not filtered:
            for entry in items:
                entry.amount, entry.receipts_count = by_store[entry.id].total, by_store[entry.id].count
        with price_context():
            lines_paid = sum((entry.amount for entry in items), _ZERO)
            if filtered:
                count = len(set().union(*(bucket.receipts for bucket in found.values())))
                total = difference = None
            else:
                count = sum(row.count for row in by_store.values())
                total = sum((row.total for row in by_store.values()), _ZERO)
                difference = total - lines_paid
        shown, other = fold(
            [entry for entry in items if entry.kind not in SPECIAL],
            [entry for entry in items if entry.kind in SPECIAL], limit,
        )
        blocks.append(Block(currency, count, total, lines_paid, difference, shown, other))
    return blocks
