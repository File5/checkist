"""Походы в магазин: ряды по времени и разложение изменения среднего чека.

Поход — чек ``operation=sale``; возвраты в расчёт не входят, их число отдаётся
отдельно. По периоду и валюте: ``R`` — число чеков, ``T`` — ``Σ Receipt.total``,
``L`` — число строк ``kind=product`` с положительным количеством. Средний чек
``a = T / R``, позиций на чек ``n = L / R``, сумма на позицию ``p = T / L``;
``a = n × p``. Изменение среднего чека между периодами 1 и 2 раскладывается точно:

- количество: ``(n₂ − n₁) × (p₁ + p₂) / 2``;
- цены: ``(n₁ + n₂) / 2 × p₁ × (I − 1)``;
- состав: ``(n₁ + n₂) / 2 × (p₂ − p₁ × I)``,

где ``I`` — индекс Фишера по товарам, купленным в обоих периодах. Индекс измерен
только на совпавших товарах и перенесён на всю корзину — покрытие отдаётся рядом.

Арифметика (``months``, ``match``, ``price_index``, ``change``, ``decompose``,
``compare``, ``series``, ``collect``) — чистые функции на ``Decimal`` без БД; ``series_rows`` и
``compare_rows`` читают БД тремя запросами. Валюты не складываются: на каждую свой блок.

Основная валюта семьи (2026-10-13): ``series`` и ``collect`` с ``converter`` (``rates.convert``)
переводят итоги чеков и суммы строк в неё по курсу дня покупки и складывают все валюты в один
блок; чеки без курса остаются блоками своей валюты. Поэтому БД отдаёт итог каждого чека, а
сложение и медиана — в Python: медиана как ``percentile_cont(0.5)``, середина двух средних.
"""
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal
from typing import NamedTuple

from django.db.models import Count, F, Q, Sum

from catalog.models import Product
from receipts.decimal_math import price_context, round_decimal
from receipts.models import Receipt, ReceiptLine

MAX_BUCKETS = 1000
DAYS_PER_MONTH = Decimal("30.4375")
BASE, CURRENT = "base", "current"

_SALE, _REFUND = Receipt.Operation.SALE, Receipt.Operation.REFUND
_ZERO = Decimal("0.00")


class TooManyBuckets(Exception):
    """Интервалов в ряду больше ``MAX_BUCKETS``."""


# --- числа похода ---

@dataclass(frozen=True)
class Visits:
    """Походы одной валюты за период или интервал; производные не округлены."""

    receipts_count: int = 0
    total: Decimal = _ZERO
    median: Decimal | None = None
    lines_count: int = 0

    @property
    def avg_receipt(self):
        return _ratio(self.total, self.receipts_count)

    @property
    def lines_per_receipt(self):
        return _ratio(Decimal(self.lines_count), self.receipts_count)

    @property
    def paid_per_line(self):
        return _ratio(self.total, self.lines_count)


def _ratio(value, count):
    if not count:
        return None
    with price_context():
        return value / count


def months(date_from, date_to):
    """Длина периода в месяцах: дни (обе границы включительно) / 30,4375."""
    with price_context():
        return Decimal((date_to - date_from).days + 1) / DAYS_PER_MONTH


def per_month(count, date_from, date_to):
    with price_context():
        return Decimal(count) / months(date_from, date_to)


# --- индекс цен ---

class Purchase(NamedTuple):
    """Строки товара в одной единице за период: оплаченная сумма, количество, число строк."""

    product_id: int | None  # None — несопоставленные строки
    unit: str
    paid: Decimal
    quantity: Decimal
    lines: int = 1

    @property
    def price(self):
        with price_context():
            return self.paid / self.quantity


class Match(NamedTuple):
    product_id: int
    unit: str
    base: Purchase
    current: Purchase

    @property
    def price_change_percent(self):
        with price_context():
            return round_decimal((self.current.price - self.base.price) * 100 / self.base.price, 2)


@dataclass(frozen=True)
class PriceIndex:
    fisher: Decimal
    laspeyres: Decimal
    paasche: Decimal
    matched_products: int
    coverage_base_percent: Decimal | None
    coverage_current_percent: Decimal | None


def match(base, current):
    """Совпавшие товары: тот же товар и единица в обоих периодах.

    Несопоставленные строки не участвуют. Цена — оплаченная сумма / количество, поэтому
    пара берётся, только если в обоих периодах количество и оплаченная сумма
    положительны: иначе цены и веса индекса не определены.
    """
    def usable(rows):
        return {
            (row.product_id, row.unit): row for row in rows
            if row.product_id is not None and row.quantity > 0 and row.paid > 0
        }

    first, second = usable(base), usable(current)
    return [Match(*key, first[key], second[key]) for key in sorted(first.keys() & second.keys())]


def _paid(rows):
    with price_context():
        return sum((row.paid for row in rows), _ZERO)


def price_index(matches, base_paid, current_paid):
    """Индексы Ласпейреса, Пааше и Фишера по ``matches``; ``None`` без совпавших товаров.

    ``base_paid`` и ``current_paid`` — оплаченная сумма всех товарных строк периода:
    знаменатель покрытия. Неположительный знаменатель — покрытия нет.
    """
    if not matches:
        return None
    with price_context():
        base_matched = sum(pair.base.paid for pair in matches)  # Σ p₁q₁
        current_matched = sum(pair.current.paid for pair in matches)  # Σ p₂q₂
        laspeyres = sum(pair.current.price * pair.base.quantity for pair in matches) / base_matched
        paasche = current_matched / sum(pair.base.price * pair.current.quantity for pair in matches)
        return PriceIndex(
            fisher=(laspeyres * paasche).sqrt(), laspeyres=laspeyres, paasche=paasche,
            matched_products=len(matches),
            coverage_base_percent=base_matched * 100 / base_paid if base_paid > 0 else None,
            coverage_current_percent=current_matched * 100 / current_paid if current_paid > 0 else None,
        )


# --- разложение ---

@dataclass(frozen=True)
class Effects:
    """Слагаемые изменения среднего чека в деньгах, 2 знака; ``price + mix = price_per_line``."""

    quantity: Decimal
    price: Decimal | None
    mix: Decimal | None
    price_per_line: Decimal
    quantity_percent: Decimal | None
    price_percent: Decimal | None
    mix_percent: Decimal | None


def change(base, current):
    """``(изменение среднего чека, процент от базового)``; 2 знака.

    Изменение — разность уже округлённых средних: числа ответа сходятся между собой.
    Нет чеков в любом периоде — ``(None, None)``; неположительный базовый средний —
    процента нет.
    """
    if not base.receipts_count or not current.receipts_count:
        return None, None
    with price_context():
        first = round_decimal(base.avg_receipt, 2)
        delta = round_decimal(current.avg_receipt, 2) - first
        return delta, round_decimal(delta * 100 / first, 2) if first > 0 else None


def decompose(base, current, fisher=None):
    """Эффекты количества, цен и состава; ``None``, если в периоде нет чеков или строк товаров.

    ``quantity + price + mix`` равно изменению из ``change`` точно: остаток округления
    относится в ``mix``. Без индекса (``fisher=None``, совпавших товаров нет) цены и
    состав не разделяются — заполнена только их сумма ``price_per_line``. Проценты —
    доля слагаемого в изменении, при нулевом изменении их нет.
    """
    if not (base.receipts_count and current.receipts_count and base.lines_count and current.lines_count):
        return None
    with price_context():
        delta, _ = change(base, current)
        lines = (base.lines_per_receipt + current.lines_per_receipt) / 2
        quantity = round_decimal(
            (current.lines_per_receipt - base.lines_per_receipt) * (base.paid_per_line + current.paid_per_line) / 2, 2,
        )
        per_line = delta - quantity
        price = mix = None
        if fisher is not None:
            price = round_decimal(lines * base.paid_per_line * (fisher - 1), 2)
            mix = per_line - price

        def share(value):
            return None if value is None or not delta else round_decimal(value * 100 / delta, 2)

        return Effects(quantity, price, mix, per_line, share(quantity), share(price), share(mix))


# --- сравнение периодов ---

@dataclass
class Collected:
    """Данные сравнения; ключ словарей — ``(валюта, BASE | CURRENT)``."""

    visits: dict  # Visits без lines_count — он считается по purchases
    refunds: dict
    purchases: dict  # списки Purchase
    names: dict  # {product_id: name} товаров, купленных в обоих периодах


@dataclass
class Side:
    visits: Visits
    refunds_excluded: int


@dataclass
class Comparison:
    currency: str
    base: Side
    current: Side
    change: Decimal | None
    change_percent: Decimal | None
    effects: Effects | None
    price_index: PriceIndex | None
    products: list  # Match, первые limit
    products_total: int


def compare(data, limit=20):
    """Блоки сравнения по валютам из ``Collected``; БД не используется.

    Блок есть у валюты с походами хотя бы в одном периоде. ``products`` — совпавшие
    товары по убыванию ``|current.paid − base.paid|``, затем ``name``, ``id``, ``unit``.
    """
    blocks = []
    for currency in sorted({key[0] for key in data.visits}):
        sides, rows = {}, {}
        for period in (BASE, CURRENT):
            rows[period] = data.purchases.get((currency, period), [])
            found = data.visits.get((currency, period), Visits())
            visits = Visits(
                found.receipts_count, found.total, found.median, sum(row.lines for row in rows[period]),
            )
            sides[period] = Side(visits, data.refunds.get((currency, period), 0))
        base, current = sides[BASE].visits, sides[CURRENT].visits
        matches = match(rows[BASE], rows[CURRENT])
        index = price_index(matches, _paid(rows[BASE]), _paid(rows[CURRENT]))
        delta, percent = change(base, current)
        matches.sort(key=lambda pair: (
            -abs(pair.current.paid - pair.base.paid), data.names.get(pair.product_id, ""), pair.product_id, pair.unit,
        ))
        blocks.append(Comparison(
            currency, sides[BASE], sides[CURRENT], delta, percent,
            decompose(base, current, index.fisher if index else None), index, matches[:limit], len(matches),
        ))
    return blocks


# --- БД ---

class Bucket(NamedTuple):
    period_start: object  # date
    visits: Visits


class Series(NamedTuple):
    currency: str
    refunds_excluded: int
    buckets: list


class SeriesRows(NamedTuple):
    """Сырые данные рядов: итог каждого чека продажи, строки товаров по дням и возвраты по валютам."""

    sales: list  # (currency, day, total) — по чеку
    lines: list  # (currency, day, count)
    refunds: dict  # {currency: count}

    def needs(self):
        return {(currency, day) for currency, day, _total in self.sales}


def series_rows(receipts):
    """Данные рядов по queryset ``Receipt``; три запроса, дальше расчёт без БД (``series``)."""
    sales = receipts.filter(operation=_SALE)
    rows = list(sales.order_by().values_list("currency_id", "purchased_on", "total"))
    lines = list(
        ReceiptLine.objects.filter(receipt__in=sales.values("pk"), kind=ReceiptLine.Kind.PRODUCT, quantity__gt=0)
        .values("receipt__currency_id", "receipt__purchased_on").annotate(count=Count("pk")).order_by()
        .values_list("receipt__currency_id", "receipt__purchased_on", "count")
    )
    refunds = dict(
        receipts.filter(operation=_REFUND).values("currency_id").annotate(count=Count("pk")).order_by()
        .values_list("currency_id", "count")
    )
    return SeriesRows(rows, lines, refunds)


def bucket_start(day, interval):
    """Начало интервала ``interval`` (``month``, ``week`` с понедельника, ``quarter``, ``year``), как ``date_trunc``."""
    if interval == "week":
        return day - timedelta(days=day.weekday())
    if interval == "quarter":
        return date(day.year, (day.month - 1) // 3 * 3 + 1, 1)
    if interval == "year":
        return date(day.year, 1, 1)
    return date(day.year, day.month, 1)


def median(values):
    """Медиана как ``percentile_cont(0.5)``: средний элемент либо середина двух средних; ``None`` без значений."""
    ordered = sorted(values)
    if not ordered:
        return None
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    with price_context():
        return (ordered[middle - 1] + ordered[middle]) / 2


def _moved(converter, currency, day, amount):
    """``(валюта, сумма)`` в основной валюте по курсу ``day``; без ``converter`` или без курса — как была."""
    if converter is None or currency == converter.base:
        return currency, amount
    converted = converter.convert(amount, currency, day)
    return (currency, amount) if converted is None else (converter.base, converted)


def _visits(values, lines=0):
    with price_context():
        return Visits(len(values), sum(values, _ZERO), median(values), lines)


def series(rows, interval, converter=None):
    """Ряды походов по валютам из ``series_rows``; без БД.

    ``interval`` — ``month``, ``week`` (с понедельника), ``quarter``, ``year``; начало интервала
    считается от локальной даты чека. Интервалы без походов не включаются, валюта без походов
    блока не даёт; порядок — по коду валюты. С ``converter`` (``rates.convert``) итоги чеков
    переводятся в основную валюту по курсу дня покупки и складываются в её ряд, чеки без курса
    остаются рядами своей валюты, возвраты в ряду основной валюты — всех валют. Больше
    ``MAX_BUCKETS`` интервалов суммарно — ``TooManyBuckets``.
    """
    totals, counts = {}, {}
    for currency, day, total in rows.sales:
        currency, total = _moved(converter, currency, day, total)
        totals.setdefault((currency, bucket_start(day, interval)), []).append(total)
    if len(totals) > MAX_BUCKETS:
        raise TooManyBuckets()
    for currency, day, count in rows.lines:
        currency, _ = _moved(converter, currency, day, _ZERO)
        key = (currency, bucket_start(day, interval))
        counts[key] = counts.get(key, 0) + count
    refunds = dict(rows.refunds)
    if converter is not None:
        refunds = {converter.base: sum(refunds.values())}
    found = {}
    for currency, start in sorted(totals):
        visits = _visits(totals[currency, start], counts.get((currency, start), 0))
        found.setdefault(currency, []).append(Bucket(start, visits))
    return [Series(currency, refunds.get(currency, 0), buckets) for currency, buckets in found.items()]


def _within(period, prefix=""):
    return Q(**{f"{prefix}purchased_on__gte": period.date_from, f"{prefix}purchased_on__lte": period.date_to})


class CompareRows(NamedTuple):
    """Сырые данные сравнения: чеки обоих периодов, строки товаров по дням и имена товаров."""

    receipts: list  # (currency, operation, day, total) — по чеку
    lines: list  # (currency, day, owner, unit, paid, quantity, lines)
    names: dict  # {product_id: name} товаров, купленных в обоих периодах

    def needs(self):
        return {(currency, day) for currency, _operation, day, _total in self.receipts}


def _side(base, day):
    return BASE if base.date_from <= day <= base.date_to else CURRENT


def compare_rows(receipts, base, current, product_ref=None):
    """Данные сравнения периодов ``base`` и ``current`` по queryset ``Receipt``; три запроса.

    Периоды — объекты с ``date_from`` и ``date_to`` (обе заданы, включительно), не
    пересекаются. ``product_ref`` — выражение «товар строки» от ``ReceiptLine``; по
    умолчанию ``product_id``. Слой API передаёт выражение, относящее строку
    поглощённого слиянием товара к оставляемому.
    """
    inside = receipts.filter(_within(base) | _within(current))
    rows = list(inside.order_by().values_list("currency_id", "operation", "purchased_on", "total"))
    lines = list(
        ReceiptLine.objects.filter(receipt__in=inside.filter(operation=_SALE).values("pk"),
                                   kind=ReceiptLine.Kind.PRODUCT, quantity__gt=0)
        .values("receipt__currency_id", "receipt__purchased_on", "unit")
        .annotate(
            owner=product_ref if product_ref is not None else F("product_id"),
            paid=Sum(F("amount") - F("discount_amount")), quantity_sum=Sum("quantity"), lines=Count("pk"),
        )
        .order_by()
        .values_list("receipt__currency_id", "receipt__purchased_on", "owner", "unit", "paid", "quantity_sum", "lines")
    )
    bought = {BASE: set(), CURRENT: set()}
    for _currency, day, owner, *_rest in lines:
        bought[_side(base, day)].add(owner)
    ids = (bought[BASE] & bought[CURRENT]) - {None}
    names = dict(Product.objects.filter(pk__in=ids).values_list("pk", "name"))
    return CompareRows(rows, lines, names)


def collect(rows, base, converter=None):
    """``Collected`` из ``compare_rows``; ``base`` — базовый период. Без БД.

    С ``converter`` (``rates.convert``) итоги чеков и суммы строк переводятся в основную валюту
    по курсу дня покупки и складываются в её блок; чеки без курса остаются в своей валюте.
    """
    totals, refunds = {}, {}
    for currency, operation, day, total in rows.receipts:
        currency, total = _moved(converter, currency, day, total)
        key = (currency, _side(base, day))
        if operation == _SALE:
            totals.setdefault(key, []).append(total)
        else:
            refunds[key] = refunds.get(key, 0) + 1
    visits = {key: _visits(values) for key, values in totals.items()}
    grouped = {}
    with price_context():
        for currency, day, owner, unit, paid, quantity, count in rows.lines:
            currency, paid = _moved(converter, currency, day, paid)
            key = (currency, _side(base, day), owner, unit)
            before = grouped.get(key, (_ZERO, Decimal(0), 0))
            grouped[key] = (before[0] + paid, before[1] + quantity, before[2] + count)
    purchases = {}
    for (currency, period, owner, unit), (paid, quantity, count) in grouped.items():
        purchases.setdefault((currency, period), []).append(Purchase(owner, unit, paid, quantity, count))
    return Collected(visits, refunds, purchases, rows.names)


def unconverted(sales, converter):
    """Чеки продажи без курса из ``(валюта, день, итог)``: ``[(валюта, чеков, сумма)]`` по коду валюты."""
    found = {}
    with price_context():
        for currency, day, total in sales:
            if currency != converter.base and converter.factor(currency, day) is None:
                count, amount = found.get(currency, (0, _ZERO))
                found[currency] = (count + 1, amount + total)
    return [(currency, count, total) for currency, (count, total) in sorted(found.items())]


def compare_sales(rows):
    """``(валюта, день, итог)`` чеков продажи ``compare_rows``: для ``unconverted``."""
    return [(currency, day, total) for currency, operation, day, total in rows.receipts if operation == _SALE]
