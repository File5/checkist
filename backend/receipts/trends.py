"""Динамика по месяцам: траты по корневым категориям, одна категория во времени, индекс цен семьи.

Окно — ``months`` календарных месяцев, последний — ``end`` включительно; месяц чека — по
локальной дате ``purchased_on``. Месяцы без трат в ответе есть с нулём (или без индекса):
ряды не пропускают месяцы. Валюты не складываются: на каждую валюту чека свой блок.

Траты (``monthly``, ``category_series``) — как в ``receipts.spending``: в «потрачено»
месяца входят все чеки, включая возвраты, со своим знаком (``Σ Receipt.total``);
значение категории — ``Σ (amount − discount_amount)`` строк. Категория строки — категория
её товара, у строки без товара — своя ``ReceiptLine.category`` (ручная трата). Услуги,
залоги и строки без категории в категории не попадают: вместе со скидкой на весь чек они
— ``uncategorized`` = «потрачено» − Σ категорий.

Индекс цен (``price_trend``) — цепной индекс Фишера по товарам, купленным в соседних
месяцах с покупками (``receipts.basket.match`` и ``price_index``): первый месяц окна с
покупками — 100, каждый следующий — индекс опорного месяца × Фишер(опорный, этот).
Опорный — последний месяц с индексом. Месяц без покупок или без общих с опорным товаров
индекса не получает, опорный остаётся прежним. В расчёт входят только чеки продажи,
строки товаров с положительными количеством и суммой: ручные траты без товара его не
меняют.

``collect_*`` читают БД постоянным числом запросов; остальное — чистые функции.

Основная валюта семьи (2026-10-13): ``rebase`` переводит траты окна в неё по курсу дня покупки
(``rates.convert``); ``monthly``, ``category_series`` и ``limit_history`` по такому набору дают
блок основной валюты и блоки только тех трат, курса которых нет. Индекс цен — по валютам, как был.
"""
from dataclasses import dataclass, field
from datetime import date, timedelta
from decimal import Decimal

from django.db.models import Count, DateField, F, Sum
from django.db.models.functions import Trunc

from catalog.models import Product
from receipts import basket
from receipts.decimal_math import price_context, round_decimal
from receipts.models import Receipt, ReceiptLine
from receipts.spending import UNASSIGNED_NAME

MAX_MONTHS = 60
DEFAULT_MONTHS = 12
MOVERS_LIMIT = 5

_KIND = ReceiptLine.Kind
_ZERO = Decimal("0.00")
_HUNDRED = Decimal(100)


# --- месяцы ---

def month_start(day):
    return date(day.year, day.month, 1)


def shift(first, months):
    """Первое число месяца через ``months`` месяцев от ``first`` (может быть отрицательным)."""
    index = first.year * 12 + first.month - 1 + months
    return date(index // 12, index % 12 + 1, 1)


def months_between(first, last):
    """Число месяцев от месяца ``first`` до месяца ``last`` включительно (0 и меньше, если ``last`` раньше)."""
    return (last.year - first.year) * 12 + last.month - first.month + 1


def window(end, months):
    """Первые числа ``months`` месяцев по возрастанию, последний — месяц ``end``."""
    last = month_start(end)
    return [shift(last, offset) for offset in range(1 - months, 1)]


def month_end(first):
    return shift(first, 1) - timedelta(days=1)


def label(first):
    return f"{first.year:04d}-{first.month:02d}"


def _average(total, count):
    with price_context():
        return total / count if count else None


# --- траты: данные ---

@dataclass
class SpendRows:
    """Строки окна, сложенные по валюте, месяцу, виду, категории строки и товару."""

    lines: list  # (currency, month, kind, line_category_id, product_id, paid, lines_count)
    totals: dict  # {(currency, month): Σ Receipt.total}
    product_category: dict  # {product_id: generic__category_id}
    # Те же строки и итоги по дням покупки — для пересчёта по курсу дня (``rebase``).
    day_lines: list = field(default_factory=list)  # (currency, day, kind, line_category_id, product_id, paid, count)
    day_totals: list = field(default_factory=list)  # (currency, day, count, Σ Receipt.total)

    def needs(self):
        """Пары ``(валюта, день)`` трат окна."""
        return {(currency, day) for currency, day, _count, _total in self.day_totals}


def _by_month(day_lines, day_totals, product_category):
    """``SpendRows`` с месячными ``lines`` и ``totals`` из строк и итогов по дням."""
    lines, totals = {}, {}
    with price_context():
        for currency, day, kind, category, product, paid, count in day_lines:
            key = (currency, month_start(day), kind, category, product)
            before = lines.get(key, (_ZERO, 0))
            lines[key] = (before[0] + paid, before[1] + count)
        for currency, day, _count, total in day_totals:
            key = (currency, month_start(day))
            totals[key] = totals.get(key, _ZERO) + total
    return SpendRows([(*key, paid, count) for key, (paid, count) in lines.items()], totals, product_category,
                     day_lines, day_totals)


def rebase(rows, converter):
    """``rows`` в основной валюте ``converter.base``; траты без курса остаются в своей валюте. БД не используется."""
    def moved(currency, day, amount):
        converted = None if currency == converter.base else converter.convert(amount, currency, day)
        return (currency, amount) if converted is None else (converter.base, converted)

    day_lines = []
    for currency, day, kind, category, product, paid, count in rows.day_lines:
        currency, paid = moved(currency, day, paid)
        day_lines.append((currency, day, kind, category, product, paid, count))
    day_totals = []
    for currency, day, count, total in rows.day_totals:
        currency, total = moved(currency, day, total)
        day_totals.append((currency, day, count, total))
    return _by_month(day_lines, day_totals, rows.product_category)


def unconverted(rows, converter):
    """Траты окна без курса: ``[(валюта, чеков, сумма)]`` по коду валюты."""
    found = {}
    with price_context():
        for currency, day, count, total in rows.day_totals:
            if currency != converter.base and converter.factor(currency, day) is None:
                before = found.get(currency, (0, _ZERO))
                found[currency] = (before[0] + count, before[1] + total)
    return [(currency, count, total) for currency, (count, total) in sorted(found.items())]


def _in_window(receipts, months):
    return receipts.filter(purchased_on__gte=months[0], purchased_on__lte=month_end(months[-1]))


def collect_spending(receipts, months, product_ref=None):
    """Строки и итоги чеков ``receipts`` за окно ``months``; три запроса.

    ``product_ref`` — выражение «товар строки» от ``ReceiptLine`` (слой API относит строку
    поглощённого слиянием товара к оставляемому); по умолчанию ``product_id``.
    """
    inside = _in_window(receipts, months)
    day_lines = list(
        ReceiptLine.objects.filter(receipt__in=inside.values("pk"))
        .values("receipt__currency_id", "receipt__purchased_on", "kind", "category_id")
        .annotate(
            owner=product_ref if product_ref is not None else F("product_id"),
            paid=Sum(F("amount") - F("discount_amount")), lines_count=Count("pk"),
        )
        .order_by()
        .values_list("receipt__currency_id", "receipt__purchased_on", "kind", "category_id", "owner", "paid",
                     "lines_count")
    )
    day_totals = list(
        inside.values("currency_id", "purchased_on").annotate(count=Count("pk"), total_sum=Sum("total")).order_by()
        .values_list("currency_id", "purchased_on", "count", "total_sum")
    )
    ids = {row[4] for row in day_lines if row[4] is not None and row[2] == _KIND.PRODUCT}
    product_category = dict(Product.objects.filter(pk__in=ids).values_list("pk", "generic__category_id"))
    return _by_month(day_lines, day_totals, product_category)


def _line_category(rows, kind, line_category, product_id):
    """Категория строки либо ``None`` (услуга, залог, строка без категории)."""
    if kind != _KIND.PRODUCT:
        return None
    if product_id is not None:
        return rows.product_category.get(product_id)
    return line_category


# --- траты по месяцам ---

@dataclass
class MonthSpend:
    month: date
    total: Decimal = _ZERO
    categories: dict = field(default_factory=dict)  # {root_id: amount}

    @property
    def uncategorized(self):
        with price_context():
            return self.total - sum(self.categories.values(), _ZERO)


@dataclass
class LegendEntry:
    id: int
    name: str
    unassigned: bool
    total: Decimal


def change_percent(previous, current):
    """Изменение ``current`` к ``previous`` в %, 2 знака; ``None`` при неположительном или неизвестном ``previous``."""
    if previous is None or current is None or previous <= 0:
        return None
    with price_context():
        return round_decimal((current - previous) * 100 / previous, 2)


@dataclass
class NodeRow:
    """Категория с суммами на каждый месяц окна."""

    id: int
    name: str
    parent_id: int | None
    depth: int
    amounts: list  # Decimal на каждый месяц окна
    total: Decimal
    direct: bool = False  # строки, лежащие прямо в выбранной категории, а не в подкатегории

    @property
    def change_percent(self):
        """Последний месяц окна к предыдущему."""
        return change_percent(self.amounts[-2], self.amounts[-1]) if len(self.amounts) > 1 else None

    @property
    def change_percents(self):
        """Каждый месяц окна к предыдущему; у первого — ``None``."""
        return [None] + [change_percent(previous, current) for previous, current in zip(self.amounts, self.amounts[1:])]

    @property
    def average(self):
        """Среднее за месяц окна, 2 знака."""
        return round_decimal(_average(self.total, len(self.amounts)), 2)


@dataclass
class Summary:
    """Последний месяц окна против предыдущего и против среднего за окно."""

    month: date
    spent: Decimal
    previous_month: date | None
    previous: Decimal | None
    change_percent: Decimal | None
    average_change_percent: Decimal | None


@dataclass
class MonthlyBlock:
    currency: str
    total: Decimal
    average: Decimal
    categories: list  # LegendEntry по убыванию суммы за окно
    months: list  # MonthSpend на каждый месяц окна
    rows: list = field(default_factory=list)  # NodeRow: корень, затем его прямые подкатегории
    summary: Summary | None = None


def _node_rows(tree, months, sums, ids, parent_id, depth):
    """Строки категорий ``ids`` по убыванию суммы за окно, затем по имени и id."""
    found = []
    for pk in ids:
        amounts = [sums[pk].get(first, _ZERO) for first in months]
        with price_context():
            total = sum(amounts, _ZERO)
        found.append(NodeRow(pk, tree.name(pk), parent_id, depth, amounts, total))
    return sorted(found, key=lambda row: (-row.total, row.name, row.id))


def monthly(rows, months, tree):
    """Траты по корневым категориям на каждый месяц окна; блок у валюты с чеками в окне."""
    blocks = {}

    def bucket(currency, month):
        found = blocks.setdefault(currency, {first: MonthSpend(first) for first in months})
        return found[month]

    for (currency, month), total in rows.totals.items():
        bucket(currency, month).total = total
    nodes = {}  # {currency: {category_id: {month: amount}}} — корни и их прямые подкатегории
    for currency, month, kind, line_category, product_id, paid, _count in rows.lines:
        category = _line_category(rows, kind, line_category, product_id)
        if category is None or category not in tree:
            continue
        path = tree.path_ids(category)
        target = bucket(currency, month).categories
        with price_context():
            target[path[0]] = target.get(path[0], _ZERO) + paid
            for node in path[:2]:
                by_month = nodes.setdefault(currency, {}).setdefault(node, {})
                by_month[month] = by_month.get(month, _ZERO) + paid

    result = []
    for currency in sorted(blocks):
        spends = [blocks[currency][first] for first in months]
        sums = {}
        with price_context():
            for spend in spends:
                for root, amount in spend.categories.items():
                    sums[root] = sums.get(root, _ZERO) + amount
            total = sum((spend.total for spend in spends), _ZERO)
        legend = sorted(
            (LegendEntry(root, tree.name(root), tree.name(root) == UNASSIGNED_NAME, amount)
             for root, amount in sums.items()),
            key=lambda entry: (-entry.total, entry.name, entry.id),
        )
        average = _average(total, len(months))
        sums = nodes.get(currency, {})
        node_rows = []
        for root in legend:
            node_rows.extend(_node_rows(tree, months, sums, [root.id], None, 0))
            children = [pk for pk in sums if pk != root.id and tree.path_ids(pk)[0] == root.id]
            node_rows.extend(_node_rows(tree, months, sums, children, root.id, 1))
        last = spends[-1]
        previous = spends[-2] if len(spends) > 1 else None
        summary = Summary(
            last.month, last.total, previous and previous.month, previous and previous.total,
            change_percent(previous and previous.total, last.total), change_percent(average, last.total),
        )
        result.append(MonthlyBlock(currency, total, average, legend, spends, node_rows, summary))
    return result


# --- одна категория во времени ---

@dataclass
class CategoryMonth:
    month: date
    amount: Decimal = _ZERO
    lines_count: int = 0


@dataclass
class CategoryBlock:
    currency: str
    total: Decimal
    average: Decimal
    months: list  # CategoryMonth на каждый месяц окна
    # NodeRow прямых подкатегорий с тратами (и ``direct`` — строки самой категории); пусто, если подкатегорий с тратами нет
    parts: list = field(default_factory=list)


def spent_categories(rows, tree):
    """Категории со строками в окне (любая валюта) и все их предки."""
    found = set()
    for _currency, _month, kind, line_category, product_id, _paid, _count in rows.lines:
        category = _line_category(rows, kind, line_category, product_id)
        if category is not None and category in tree:
            found.update(tree.path_ids(category))
    return found


def suggested_category(rows, tree):
    """Корень, в котором тратили в наибольшем числе месяцев окна (затем по имени, id); ``None`` без трат."""
    months_of = {}
    for _currency, month, kind, line_category, product_id, _paid, _count in rows.lines:
        category = _line_category(rows, kind, line_category, product_id)
        if category is not None and category in tree:
            months_of.setdefault(tree.path_ids(category)[0], set()).add(month)
    if not months_of:
        return None
    return min(months_of, key=lambda root: (-len(months_of[root]), tree.name(root), root))


def category_series(rows, months, tree, category):
    """Траты категории ``category`` с потомками на каждый месяц окна; блок у валюты с такими строками."""
    inside = set(tree.descendant_ids(category))
    blocks, parts = {}, {}
    for currency, month, kind, line_category, product_id, paid, count in rows.lines:
        line = _line_category(rows, kind, line_category, product_id)
        if line not in inside:
            continue
        spends = blocks.setdefault(currency, {first: CategoryMonth(first) for first in months})
        target = spends[month]
        path = tree.path_ids(line)
        child = path[path.index(category) + 1] if line != category else category
        by_month = parts.setdefault(currency, {}).setdefault(child, {})
        with price_context():
            target.amount += paid
            by_month[month] = by_month.get(month, _ZERO) + paid
        target.lines_count += count
    result = []
    for currency in sorted(blocks):
        spends = [blocks[currency][first] for first in months]
        with price_context():
            total = sum((spend.amount for spend in spends), _ZERO)
        sums = parts[currency]
        children = _node_rows(tree, months, sums, [pk for pk in sums if pk != category], category, tree.depth(category) + 1)
        if children:
            if category in sums:
                direct = _node_rows(tree, months, sums, [category], category, tree.depth(category))[0]
                direct.direct = True
                children.append(direct)
        result.append(CategoryBlock(currency, total, _average(total, len(months)), spends, children))
    return result


# --- лимиты по месяцам ---

@dataclass
class LimitRow:
    """Лимит и его исполнение в каждом месяце окна: траты категории с потомками в валюте лимита.

    ``amounts`` — сумма лимита в каждом месяце (``budget.history``: последнее изменение не
    позже месяца; ``None`` — лимита в месяце не было), ``amount`` — текущая (``None`` — удалён).
    """

    id: int | None
    category_id: int
    currency: str
    amount: Decimal | None
    spent: list  # Decimal на каждый месяц окна
    amounts: list  # Decimal | None на каждый месяц окна
    changed: dict = field(default_factory=dict)  # месяц -> (до, после), где лимит в месяце менялся

    @property
    def percents(self):
        """Доля лимита месяца, %; без лимита в месяце — ``None``. Лимит всегда положителен (ограничение БД)."""
        with price_context():
            return [None if limit is None else round_decimal(value * 100 / limit, 2)
                    for value, limit in zip(self.spent, self.amounts)]


def limit_history(rows, months, tree, series):
    """``series`` — ``budget.history.series``: у каждого месяца окна своя сумма лимита.

    Порядок — по валюте, затем по порядку дерева категорий; удалённые — после текущих той же категории.
    """
    order = {pk: index for index, pk in enumerate(tree.ordered_ids())}
    result = []
    for item in series:
        category_id, currency = item.category_id, item.currency
        inside = set(tree.descendant_ids(category_id)) if category_id in tree else {category_id}
        by_month = {}
        for line_currency, month, kind, line_category, product_id, paid, _count in rows.lines:
            if line_currency == currency and _line_category(rows, kind, line_category, product_id) in inside:
                with price_context():
                    by_month[month] = by_month.get(month, _ZERO) + paid
        limit = item.limit
        result.append(LimitRow(
            None if limit is None else limit.pk, category_id, currency, None if limit is None else limit.amount,
            [by_month.get(first, _ZERO) for first in months], list(item.amounts), dict(item.changed)))
    return sorted(result, key=lambda row: (row.currency, order.get(row.category_id, len(order)),
                                           row.id is None, row.id or 0))


# --- индекс цен ---

def collect_purchases(receipts, months, product_ref=None):
    """Покупки товаров по валюте и месяцу окна: ``{currency: {month: [Purchase]}}`` и имена; два запроса.

    Только чеки продажи, строки ``kind=product`` с положительным количеством; товар — по
    ``product_ref``, как в ``collect_spending``.
    """
    sales = _in_window(receipts, months).filter(operation=Receipt.Operation.SALE)
    found = {}
    for currency, month, *row in (
        ReceiptLine.objects.filter(receipt__in=sales.values("pk"), kind=_KIND.PRODUCT, quantity__gt=0)
        .annotate(month=Trunc("receipt__purchased_on", "month", output_field=DateField()))
        .values("receipt__currency_id", "month", "unit")
        .annotate(
            owner=product_ref if product_ref is not None else F("product_id"),
            paid=Sum(F("amount") - F("discount_amount")), quantity_sum=Sum("quantity"), lines=Count("pk"),
        )
        .order_by()
        .values_list("receipt__currency_id", "month", "owner", "unit", "paid", "quantity_sum", "lines")
    ):
        found.setdefault(currency, {}).setdefault(month, []).append(basket.Purchase(*row))
    return found


def product_ids(purchases):
    return {row.product_id for by_month in purchases.values() for rows in by_month.values() for row in rows} - {None}


@dataclass
class IndexPoint:
    month: date
    index: Decimal | None = None
    base_month: date | None = None  # опорный месяц звена
    link_percent: Decimal | None = None  # изменение к опорному месяцу, %
    matched_products: int = 0


@dataclass
class Mover:
    product_id: int
    unit: str
    old_month: date
    old_price: Decimal
    new_month: date
    new_price: Decimal

    @property
    def change_percent(self):
        with price_context():
            return round_decimal((self.new_price - self.old_price) * 100 / self.old_price, 2)


@dataclass
class PriceBlock:
    currency: str
    first_month: date | None
    points: list  # IndexPoint на каждый месяц окна
    risers: list  # Mover, сильнее всего подорожавшие
    fallers: list  # Mover, сильнее всего подешевевшие
    products_total: int  # товаров (с единицей), купленных хотя бы в двух месяцах окна
    risen_total: int = 0  # из них подорожали (цена последнего месяца выше первого)
    fallen_total: int = 0  # подешевели

    @property
    def last_point(self):
        """Последний месяц с индексом, если он не первый: с чем сравнивать 100."""
        found = next((point for point in reversed(self.points) if point.index is not None), None)
        return None if found is None or found.month == self.first_month else found

    @property
    def change_percent(self):
        """Индекс последнего месяца − 100: на сколько процентов изменились цены с первого месяца."""
        point = self.last_point
        return None if point is None else point.index - _HUNDRED


def _usable(rows):
    return [row for row in rows if row.product_id is not None and row.quantity > 0 and row.paid > 0]


def _paid(rows):
    with price_context():
        return sum((row.paid for row in rows), _ZERO)


def chain_index(by_month, months):
    """Цепной индекс Фишера на каждый месяц окна (см. описание модуля)."""
    points, base, base_index = [], None, None
    for first in months:
        rows = _usable(by_month.get(first, []))
        point = IndexPoint(first)
        points.append(point)
        if not rows:
            continue
        if base is None:
            point.index, base, base_index = _HUNDRED, first, _HUNDRED
            continue
        point.base_month = base
        base_rows = _usable(by_month[base])
        matches = basket.match(base_rows, rows)
        index = basket.price_index(matches, _paid(base_rows), _paid(rows))
        if index is None:
            continue
        with price_context():
            point.index = base_index * index.fisher
            point.link_percent = (index.fisher - 1) * 100
        point.matched_products = index.matched_products
        base, base_index = first, point.index
    return points


def movers(by_month, months, names, limit=MOVERS_LIMIT):
    """Товары, купленные хотя бы в двух месяцах окна: цена первого и последнего месяца.

    Возвращает ``(подорожавшие, подешевевшие, всего, всего подорожало, всего подешевело)``;
    порядок — по модулю изменения, затем по имени, id и единице. Товар без изменения цены
    ни в один список не входит.
    """
    seen = {}
    for first in months:
        for row in _usable(by_month.get(first, [])):
            seen.setdefault((row.product_id, row.unit), []).append((first, row.price))
    found = [
        Mover(product_id, unit, prices[0][0], prices[0][1], prices[-1][0], prices[-1][1])
        for (product_id, unit), prices in seen.items() if len(prices) >= 2
    ]

    def order(mover):
        return (-abs(mover.change_percent), names.get(mover.product_id, ""), mover.product_id, mover.unit)

    risers = sorted((mover for mover in found if mover.change_percent > 0), key=order)
    fallers = sorted((mover for mover in found if mover.change_percent < 0), key=order)
    return risers[:limit], fallers[:limit], len(found), len(risers), len(fallers)


def price_trend(purchases, months, names, limit=MOVERS_LIMIT):
    """Блоки индекса цен по валютам; блок у валюты с покупками товаров в окне."""
    blocks = []
    for currency in sorted(purchases):
        by_month = purchases[currency]
        if not any(_usable(rows) for rows in by_month.values()):
            continue
        points = chain_index(by_month, months)
        first = next((point.month for point in points if point.index is not None), None)
        risers, fallers, total, risen, fallen = movers(by_month, months, names, limit)
        blocks.append(PriceBlock(currency, first, points, risers, fallers, total, risen, fallen))
    return blocks
