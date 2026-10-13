"""Дашборд месяца: потрачено против прошлого месяца, лимиты по категориям, последние траты.

Месяц — по локальной дате чека ``purchased_on``. Валюты не складываются: на каждую валюту
свой блок. «Потрачено» — ``Σ Receipt.total`` (сколько заплачено, со скидкой на весь чек;
возврат — со своим знаком), как ``receipts_total`` в ``/api/stats/spending/``. Категории —
разбивка ``receipts.spending`` по корням дерева: категория строки — категория товара, у
строки без товара — своя ``ReceiptLine.category``, потомки сворачиваются в корень.
Строки без категории, услуги и залоги в категории не попадают, но входят в «потрачено».

Лимит можно задать категории любого уровня. Под корнем в ``children`` идут подкатегории
с тратами месяца, подкатегории с лимитом и их предки (2026-10-12: прежде — только с
лимитом; клиент открывает по строке траты категории); их «потрачено» — свои строки и
строки всех потомков, тем же расчётом ``receipts.spending`` с фильтром категории. В ``limit_total`` входят лимиты, у которых нет лимита у предка в той же валюте:
вложенный лимит — часть лимита родителя, а не добавка к нему. ``limited_spent`` — траты
этих же категорий (с потомками): общий лимит сравнивается с ним, а не со всеми тратами.

Основная валюта (2026-10-13): с ``converter`` (``rates.convert``) траты каждой валюты
переводятся в основную по курсу дня покупки (``spending.rebase``), лимиты другой валюты — по
курсу ``limit_day`` (конец месяца, у текущего — сегодня); всё складывается в блок основной
валюты, а траты и лимиты без курса остаются блоками своей валюты.
"""
import calendar
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

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
    # Подкатегории с лимитом и их предки; у каждой — свои ``children``.
    children: list = field(default_factory=list)


@dataclass
class CurrencyBlock:
    currency: str
    spent: Decimal = _ZERO
    previous_spent: Decimal = _ZERO
    limit_total: Decimal | None = None
    # Потрачено в категориях, которые входят в ``limit_total`` (каждая — с потомками): общий
    # лимит сравнивается с этим, а не со всеми тратами месяца.
    limited_spent: Decimal | None = None
    categories: list = field(default_factory=list)


@dataclass
class MonthData:
    """Траты месяца (``spending.Collected``) и итоги прошлого месяца по дням: ``[(валюта, день, сумма)]``."""

    data: object
    previous: list

    def needs(self):
        return self.data.needs() | {(currency, day) for currency, day, _total in self.previous}


def collect_month(receipts, month, product_ref=None):
    """Траты месяца и итоги прошлого; четыре запроса. ``product_ref`` — как в ``spending.collect``."""
    in_month = receipts.filter(purchased_on__gte=month.first, purchased_on__lte=month.last)
    before = month.previous()
    previous = list(receipts.filter(purchased_on__gte=before.first, purchased_on__lte=before.last)
                    .values("currency_id", "purchased_on").annotate(total_sum=Sum("total")).order_by()
                    .values_list("currency_id", "purchased_on", "total_sum"))
    return MonthData(spending.collect(in_month, product_ref), previous)


def limit_day(month, today):
    """День курса лимита месяца: последний день месяца, у текущего и будущих — сегодня."""
    return min(month.last, today)


def _previous_totals(previous, converter):
    totals = {}
    for currency, day, total in previous:
        converted = converter.convert(total, currency, day) if converter is not None else None
        if converted is not None:
            currency, total = converter.base, converted
        totals[currency] = totals.get(currency, _ZERO) + total
    return totals


def _limits_in_base(limits, converter, day):
    """Лимиты другой валюты — суммой в основной по курсу ``day``; без курса — как были."""
    result = []
    for limit in limits:
        amount = converter.convert(limit.amount, limit.currency_id, day)
        if amount is None or limit.currency_id == converter.base:
            result.append(limit)
        else:
            result.append(SimpleNamespace(pk=limit.pk, category_id=limit.category_id, category=limit.category,
                                          currency_id=converter.base, amount=amount, original=limit))
    # Лимит в основной валюте — первым: его ``limit_id`` и остаётся у строки, где сошлись два лимита.
    return sorted(result, key=lambda item: hasattr(item, "original"))


def _sort_rows(rows):
    rows.sort(key=lambda row: (-row.spent, row.name, row.category_id))
    for row in rows:
        _sort_rows(row.children)


def _subtree_spent(data, tree, category_id):
    """``{валюта: Σ строк категории и её потомков}``; без БД, тем же расчётом, что корни."""
    result = {}
    for block in spending.summarize(data, group_by="category", limit=_ALL, tree=tree, category=category_id):
        result[block.currency] = sum((item.amount for item in block.items), _ZERO)
    return result


def currency_blocks(found, limits, month, tree, converter=None, today=None):
    """Блоки по валютам в порядке кода валюты; БД не используется.

    ``found`` — ``collect_month`` по видимым запросу чекам, ``limits`` — видимые лимиты (список
    ``BudgetLimit`` либо ``budget.history.limits_at`` для прошлого месяца), ``tree`` —
    ``api.common.CategoryTree``. Валюта попадает в ответ, если в ней есть чеки этого или
    прошлого месяца либо лимит. Лимит подкатегории даёт строку в ``children`` её корня (и
    строки промежуточных предков); корень без трат и своего лимита появляется ради неё с нулём.
    С ``converter`` — в основной валюте (см. описание модуля; ``today`` — для ``limit_day``).
    """
    data = found.data if converter is None else spending.rebase(found.data, converter)
    limits = list(limits)
    if converter is not None:
        limits = _limits_in_base(limits, converter, limit_day(month, today or month.last))
    blocks = {}
    by_category = {}
    for block in spending.summarize(data, group_by="category", limit=_ALL, tree=tree):
        target = blocks[block.currency] = CurrencyBlock(block.currency, spent=block.receipts_total)
        for item in block.items:
            if item.kind == "category":
                row = CategoryRow(item.id, item.name, spent=item.amount)
                target.categories.append(row)
                by_category[(block.currency, item.id)] = row
    for currency, total in _previous_totals(found.previous, converter).items():
        blocks.setdefault(currency, CurrencyBlock(currency)).previous_spent = total
    limited = {(limit.currency_id, limit.category_id) for limit in limits}
    subtree = {}  # category_id -> {валюта: потрачено}; считается один раз на узел

    def spent_of(category_id, currency):
        if category_id not in subtree:
            subtree[category_id] = _subtree_spent(data, tree, category_id)
        return subtree[category_id].get(currency, _ZERO)

    def row_of(currency, path):
        """Строка узла ``path[-1]``: корень — в ``categories`` блока, потомок — в ``children`` родителя."""
        key = (currency, path[-1])
        row = by_category.get(key)
        if row is not None:
            return row
        target = blocks.setdefault(currency, CurrencyBlock(currency))
        if len(path) == 1:
            row = CategoryRow(path[0], tree.name(path[0]))
            target.categories.append(row)
        else:
            row = CategoryRow(path[-1], tree.name(path[-1]), spent=spent_of(path[-1], currency))
            row_of(currency, path[:-1]).children.append(row)
        by_category[key] = row
        return row

    # Every sub-category with spends of the month gets its row under its root, so the card answers «на что»:
    # a tap on the row opens the spends of that category (the client).
    for currency, category_id in sorted(spending.spent_categories(data)):
        if category_id in tree and tree.depth(category_id) > 0:
            row_of(currency, tree.path_ids(category_id))

    for limit in limits:
        target = blocks.setdefault(limit.currency_id, CurrencyBlock(limit.currency_id))
        if limit.category_id in tree:
            path = tree.path_ids(limit.category_id)
            row = row_of(limit.currency_id, path)
        else:
            path = [limit.category_id]
            row = by_category.get((limit.currency_id, limit.category_id))
            if row is None:
                row = by_category[(limit.currency_id, limit.category_id)] = CategoryRow(
                    limit.category_id, limit.category.name)
                target.categories.append(row)
        merged = row.limit is not None  # второй лимит той же категории, пересчитанный из другой валюты
        if not any((limit.currency_id, ancestor) in limited for ancestor in path[:-1]):
            target.limit_total = (target.limit_total or _ZERO) + limit.amount
            if not merged:
                target.limited_spent = (target.limited_spent or _ZERO) + row.spent
        row.limit, row.limit_id = (row.limit + limit.amount, row.limit_id) if merged else (limit.amount, limit.pk)
    result = []
    for currency in sorted(blocks):
        block = blocks[currency]
        _sort_rows(block.categories)
        result.append(block)
    return result


def _root(tree, category_id):
    if category_id is None or category_id not in tree:
        return None
    return tree.path_ids(category_id)[0]


def recent(receipts, tree, limit=RECENT_LIMIT, product_ref=None):
    """Последние ``limit`` чеков по моменту покупки: ``(чек, главная категория, значок)``.

    Главная категория — корень с наибольшей суммой строк чека (при равенстве — по
    имени), ``None``, если у строк чека категорий нет. Значок — как в списке «Траты»:
    у строк одна категория — её (``CategoryTree.icon``), иначе главной. ``product_ref`` —
    выражение «товар строки», как в ``currency_blocks``: строка поглощённого слиянием
    товара относится к категории оставляемого. Три запроса.
    """
    rows = list(receipts.select_related("store__merchant", "owner")
                .annotate(lines_total=Count("lines")).order_by("-purchased_at", "-id")[:limit])
    paid, leaves = {}, {}
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
        # Своя категория строки важнее категории товара (названная покупка траты вручную) —
        # и для суммы, и для значка.
        leaf = line_category if line_category is not None or owner is None else product_category.get(owner)
        root = _root(tree, leaf)
        if root is not None:
            sums = paid.setdefault(receipt_id, {})
            sums[root] = sums.get(root, _ZERO) + amount
            leaves.setdefault(receipt_id, set()).add(leaf)
    result = []
    for row in rows:
        sums = paid.get(row.pk, {})
        main = min(sums, key=lambda pk: (-sums[pk], tree.name(pk), pk)) if sums else None
        only = leaves.get(row.pk, set())
        shown = next(iter(only)) if len(only) == 1 else main
        result.append((row, None if main is None else tree.name(main), None if shown is None else tree.icon(shown)))
    return result
