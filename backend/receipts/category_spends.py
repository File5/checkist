"""Траты одной категории за месяц: из каких чеков и трат она сложилась.

Категория строки — как в ``receipts.spending``: категория товара строки (товар,
поглощённый слиянием, — через выражение ``product_ref`` слоя API), у строки без товара —
своя ``ReceiptLine.category`` (трата, внесённая вручную, импорт выписки, обслуживание и
чаевые). В категорию входят её строки и строки всех потомков. Залоги, услуги без
категории и строки без товара и без категории в категории не бывают — их нет и здесь.
Значение строки — ``amount − discount_amount``; скидка на весь чек по строкам не
распределяется, поэтому сумма категории в чеке может отличаться от его итога.

Валюты не складываются: на каждую валюту чека свой блок. Чтение — три запроса
независимо от объёма данных (строки, категории их товаров, чеки со строками категории).
С ``converter`` (``rates.convert``) суммы переводятся в основную валюту по курсу дня покупки
и складываются в её блок; у чека остаются исходная валюта и сумма (``ReceiptItem.original``),
траты без курса — блоками своей валюты.
"""
from dataclasses import dataclass, field
from decimal import Decimal

from django.db.models import F

from catalog.models import Product
from receipts.decimal_math import price_context
from receipts.models import Receipt, ReceiptLine

_KIND = ReceiptLine.Kind
_ZERO = Decimal("0.00")


@dataclass
class LineItem:
    id: int
    position: int
    name: str
    amount: Decimal
    category_id: int


@dataclass
class ReceiptItem:
    receipt: Receipt
    amount: Decimal = _ZERO
    lines: list = field(default_factory=list)
    original: Decimal = _ZERO  # сумма строк категории в валюте чека (в основной валюте ``amount`` — пересчёт)
    total: Decimal | None = None  # итог чека в валюте блока (в основной — пересчёт)


@dataclass
class Part:
    """Прямой потомок категории (со своими потомками) либо сама категория (``direct``)."""

    id: int
    amount: Decimal = _ZERO
    lines_count: int = 0
    direct: bool = False


@dataclass
class Block:
    currency: str
    total: Decimal = _ZERO
    parts: dict = field(default_factory=dict)
    receipts: dict = field(default_factory=dict)


def line_category(kind, line_category_id, owner, product_category):
    """Категория строки по правилам ``receipts.spending`` либо ``None``."""
    if kind == _KIND.PRODUCT:
        # Своя категория строки важнее категории товара (названная покупка траты вручную).
        return line_category_id if line_category_id is not None or owner is None else product_category.get(owner)
    if kind == _KIND.SERVICE:
        return line_category_id
    return None


def collect(receipts, tree, category_id, product_ref=None):
    """Блоки по валютам (в порядке кода) для чеков ``receipts`` (queryset ``Receipt``).

    ``tree`` — ``api.common.CategoryTree``, в нём есть ``category_id``. Три запроса.
    """
    return group(load(receipts, tree, category_id, product_ref), tree, category_id)


def load(receipts, tree, category_id, product_ref=None):
    """Строки категории и их чеки: ``(matched, {receipt_id: Receipt})``; три запроса."""
    inside = set(tree.descendant_ids(category_id))
    rows = list(
        ReceiptLine.objects.filter(receipt__in=receipts.values("pk"), kind__in=(_KIND.PRODUCT, _KIND.SERVICE))
        .annotate(owner=product_ref if product_ref is not None else F("product_id"), paid=F("amount") - F("discount_amount"))
        .order_by()
        .values_list("pk", "receipt_id", "position", "raw_name", "kind", "category_id", "owner", "paid")
    )
    owners = {row[6] for row in rows if row[6] is not None and row[4] == _KIND.PRODUCT}
    product_category = dict(Product.objects.filter(pk__in=owners).values_list("pk", "generic__category_id")) if owners else {}
    matched = []
    for pk, receipt_id, position, name, kind, own_category, owner, paid in rows:
        category = line_category(kind, own_category, owner, product_category)
        if category in inside:
            matched.append((receipt_id, LineItem(pk, position, name, paid, category)))
    ids = {receipt_id for receipt_id, _ in matched}
    found = {
        receipt.pk: receipt for receipt in
        Receipt.objects.filter(pk__in=ids).select_related("store__merchant", "owner")
    } if ids else {}
    return matched, found


def needs(loaded):
    """Пары ``(валюта, день)`` чеков ``load``: какие курсы нужны для основной валюты."""
    return {(receipt.currency_id, receipt.purchased_on) for receipt in loaded[1].values()}


def group(loaded, tree, category_id, converter=None):
    """Блоки из ``load``; с ``converter`` — в основной валюте (см. описание модуля). БД не используется."""
    matched, found = loaded
    blocks = {}
    with price_context():
        for receipt_id, line in matched:
            receipt = found[receipt_id]
            currency, original, total = receipt.currency_id, line, receipt.total
            if converter is not None:
                amount = converter.convert(line.amount, receipt.currency_id, receipt.purchased_on)
                if amount is not None:
                    currency, line = converter.base, LineItem(line.id, line.position, line.name, amount, line.category_id)
                    total = converter.convert(receipt.total, receipt.currency_id, receipt.purchased_on)
            block = blocks.setdefault(currency, Block(currency))
            block.total += line.amount
            item = block.receipts.setdefault(receipt_id, ReceiptItem(receipt, total=total))
            item.amount += line.amount
            item.original += original.amount
            item.lines.append(line)
            path = tree.path_ids(line.category_id)
            direct = line.category_id == category_id
            part_id = category_id if direct else path[path.index(category_id) + 1]
            part = block.parts.setdefault((part_id, direct), Part(part_id, direct=direct))
            part.amount += line.amount
            part.lines_count += 1
    for block in blocks.values():
        for item in block.receipts.values():
            item.lines.sort(key=lambda line: (line.position, line.id))
    return [blocks[currency] for currency in sorted(blocks)]


def ordered_parts(block, tree):
    """Части по сумме по убыванию, затем имени и id; «сама категория» — последней."""
    return sorted(block.parts.values(), key=lambda part: (part.direct, -part.amount, tree.name(part.id), part.id))


def ordered_receipts(block):
    """Чеки и траты от новых к старым: по моменту покупки, затем id."""
    return sorted(block.receipts.values(), key=lambda item: (item.receipt.purchased_at, item.receipt.pk), reverse=True)
