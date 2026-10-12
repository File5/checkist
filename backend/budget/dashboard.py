"""Дашборд месяца: потрачено против прошлого месяца, лимиты по категориям, последние траты.

Месяц — по локальной дате чека ``purchased_on``. Валюты не складываются: на каждую валюту
свой блок. «Потрачено» — ``Σ Receipt.total`` (сколько заплачено, со скидкой на весь чек;
возврат — со своим знаком), как ``receipts_total`` в ``/api/stats/spending/``. Категории —
разбивка ``receipts.spending`` по корням дерева: категория строки — категория товара, у
строки без товара — своя ``ReceiptLine.category``, потомки сворачиваются в корень.
Строки без категории, услуги и залоги в категории не попадают, но входят в «потрачено».
"""
import calendar
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from django.db.models import Count, F, Sum

from catalog.models import Product
from receipts import spending
from receipts.models import ReceiptLine

RECENT_LIMIT = 10
_ZERO = Decimal("0.00")
# Сколько категорий показывать — все: «прочее» на дашборде не сворачивается.
_ALL = 10**9


@dataclass(frozen=True)
class Month:
    year: int
    month: int

    @property
    def first(self):
        return date(self.year, self.month, 1)

    @property
    def last(self):
        return date(self.year, self.month, calendar.monthrange(self.year, self.month)[1])

    def previous(self):
        return Month(self.year - 1, 12) if self.month == 1 else Month(self.year, self.month - 1)

    def label(self):
        return f"{self.year:04d}-{self.month:02d}"

    @classmethod
    def of(cls, day):
        return cls(day.year, day.month)


def days_left(month, today):
    """Дней до конца месяца, включая сегодня, если месяц текущий; иначе 0."""
    if Month.of(today) != month:
        return 0
    return (month.last - today).days + 1


@dataclass
class CategoryRow:
    category_id: int
    name: str
    spent: Decimal = _ZERO
    limit: Decimal | None = None
    limit_id: int | None = None


@dataclass
class CurrencyBlock:
    currency: str
    spent: Decimal = _ZERO
    previous_spent: Decimal = _ZERO
    limit_total: Decimal | None = None
    categories: list = field(default_factory=list)


def _totals(receipts, month):
    rows = (receipts.filter(purchased_on__gte=month.first, purchased_on__lte=month.last)
            .values("currency_id").annotate(total_sum=Sum("total")).order_by().values_list("currency_id", "total_sum"))
    return dict(rows)


def currency_blocks(receipts, limits, month, tree, product_ref=None):
    """Блоки по валютам в порядке кода валюты.

    ``receipts`` — видимые запросу чеки, ``limits`` — видимые лимиты (queryset
    ``BudgetLimit``), ``tree`` — ``api.common.CategoryTree``. Валюта попадает в ответ,
    если в ней есть чеки этого или прошлого месяца либо лимит.
    """
    in_month = receipts.filter(purchased_on__gte=month.first, purchased_on__lte=month.last)
    blocks = {}
    by_category = {}
    for block in spending.summarize(spending.collect(in_month, product_ref), group_by="category", limit=_ALL, tree=tree):
        target = blocks[block.currency] = CurrencyBlock(block.currency, spent=block.receipts_total)
        for item in block.items:
            if item.kind == "category":
                row = CategoryRow(item.id, item.name, spent=item.amount)
                target.categories.append(row)
                by_category[(block.currency, item.id)] = row
    for currency, total in _totals(receipts, month.previous()).items():
        blocks.setdefault(currency, CurrencyBlock(currency)).previous_spent = total
    for limit in limits.order_by("pk"):
        target = blocks.setdefault(limit.currency_id, CurrencyBlock(limit.currency_id))
        target.limit_total = (target.limit_total or _ZERO) + limit.amount
        row = by_category.get((limit.currency_id, limit.category_id))
        if row is None:
            name = tree.name(limit.category_id) if limit.category_id in tree else limit.category.name
            row = by_category[(limit.currency_id, limit.category_id)] = CategoryRow(limit.category_id, name)
            target.categories.append(row)
        row.limit, row.limit_id = limit.amount, limit.pk
    result = []
    for currency in sorted(blocks):
        block = blocks[currency]
        block.categories.sort(key=lambda row: (-row.spent, row.name, row.category_id))
        result.append(block)
    return result


def _root(tree, category_id):
    if category_id is None or category_id not in tree:
        return None
    return tree.path_ids(category_id)[0]


def recent(receipts, tree, limit=RECENT_LIMIT, product_ref=None):
    """Последние ``limit`` чеков по моменту покупки; у каждого — главная категория.

    Главная категория — корень с наибольшей суммой строк чека (при равенстве — по
    имени), ``None``, если у строк чека категорий нет. ``product_ref`` — выражение
    «товар строки», как в ``currency_blocks``: строка поглощённого слиянием товара
    относится к категории оставляемого. Три запроса.
    """
    rows = list(receipts.select_related("store__merchant", "owner")
                .annotate(lines_total=Count("lines")).order_by("-purchased_at", "-id")[:limit])
    paid = {}
    lines = list(
        ReceiptLine.objects.filter(receipt_id__in=[row.pk for row in rows], kind=ReceiptLine.Kind.PRODUCT)
        .values("receipt_id", "category_id")
        .annotate(owner=product_ref if product_ref is not None else F("product_id"),
                  paid=Sum(F("amount") - F("discount_amount")))
        .order_by()
        .values_list("receipt_id", "category_id", "owner", "paid")
    )
    owners = {owner for _, _, owner, _ in lines if owner is not None}
    product_category = dict(Product.objects.filter(pk__in=owners).values_list("pk", "generic__category_id"))
    for receipt_id, line_category, owner, amount in lines:
        category = product_category.get(owner) if owner is not None else None
        root = _root(tree, category if category is not None else line_category)
        if root is not None:
            sums = paid.setdefault(receipt_id, {})
            sums[root] = sums.get(root, _ZERO) + amount
    result = []
    for row in rows:
        sums = paid.get(row.pk, {})
        main = min(sums, key=lambda pk: (-sums[pk], tree.name(pk), pk)) if sums else None
        result.append((row, None if main is None else tree.name(main)))
    return result
