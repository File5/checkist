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
``compare``) — чистые функции на ``Decimal`` без БД. ``series`` и ``collect`` читают
БД постоянным числом запросов. Валюты не складываются: на каждую свой блок.
"""
from dataclasses import dataclass
from decimal import Decimal
from typing import NamedTuple

from django.db.models import Aggregate, Case, CharField, Count, DateField, DecimalField, F, Q, Sum, Value, When
from django.db.models.functions import Trunc

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

class Median(Aggregate):
    """Медиана суммы: ``percentile_cont(0.5)``, точная до половины цента.

    ``percentile_cont`` считает в ``double precision``. Сумма в центах — целое число
    (до 14 цифр), поэтому и сама она, и середина двух соседних представимы без
    потерь; обратно в ``numeric`` значение приводится уже точным.
    """

    function = "PERCENTILE_CONT"
    template = "(%(function)s(0.5) WITHIN GROUP (ORDER BY %(expressions)s * 100))::numeric / 100"
    output_field = DecimalField()


class Bucket(NamedTuple):
    period_start: object  # date
    visits: Visits


class Series(NamedTuple):
    currency: str
    refunds_excluded: int
    buckets: list


def series(receipts, interval):
    """Ряды походов по валютам из queryset ``Receipt``; три запроса.

    ``interval`` — ``month``, ``week`` (с понедельника), ``quarter``, ``year``; начало
    интервала считается от локальной даты чека. Интервалы без походов не включаются,
    валюта без походов блока не даёт. Больше ``MAX_BUCKETS`` интервалов суммарно —
    ``TooManyBuckets``.
    """
    sales = receipts.filter(operation=_SALE)
    rows = list(
        sales.annotate(bucket=Trunc("purchased_on", interval, output_field=DateField()))
        .values("currency_id", "bucket")
        .annotate(count=Count("pk"), total_sum=Sum("total"), median=Median("total"))
        .order_by("currency_id", "bucket")
        .values_list("currency_id", "bucket", "count", "total_sum", "median")[:MAX_BUCKETS + 1]
    )
    if len(rows) > MAX_BUCKETS:
        raise TooManyBuckets()
    lines = dict(
        ((currency, bucket), count) for currency, bucket, count in
        ReceiptLine.objects.filter(receipt__in=sales.values("pk"), kind=ReceiptLine.Kind.PRODUCT, quantity__gt=0)
        .annotate(bucket=Trunc("receipt__purchased_on", interval, output_field=DateField()))
        .values("receipt__currency_id", "bucket").annotate(count=Count("pk")).order_by()
        .values_list("receipt__currency_id", "bucket", "count")
    )
    refunds = dict(
        receipts.filter(operation=_REFUND).values("currency_id").annotate(count=Count("pk")).order_by()
        .values_list("currency_id", "count")
    )
    found = {}
    for currency, bucket, count, total, median in rows:
        found.setdefault(currency, []).append(
            Bucket(bucket, Visits(count, total, median, lines.get((currency, bucket), 0))),
        )
    return [Series(currency, refunds.get(currency, 0), buckets) for currency, buckets in found.items()]


def _within(period, prefix=""):
    return Q(**{f"{prefix}purchased_on__gte": period.date_from, f"{prefix}purchased_on__lte": period.date_to})


def _period(base, prefix=""):
    """Метка периода чека; чек уже отобран в один из двух непересекающихся периодов."""
    return Case(When(_within(base, prefix), then=Value(BASE)), default=Value(CURRENT), output_field=CharField())


def collect(receipts, base, current, product_ref=None):
    """Данные сравнения периодов ``base`` и ``current`` по queryset ``Receipt``; три запроса.

    Периоды — объекты с ``date_from`` и ``date_to`` (обе заданы, включительно), не
    пересекаются. ``product_ref`` — выражение «товар строки» от ``ReceiptLine``; по
    умолчанию ``product_id``. Слой API передаёт выражение, относящее строку
    поглощённого слиянием товара к оставляемому.
    """
    visits, refunds = {}, {}
    for currency, operation, period, count, total, median in (
        receipts.filter(_within(base) | _within(current))
        .values("currency_id", "operation").annotate(period=_period(base))
        .annotate(count=Count("pk"), total_sum=Sum("total"), median=Median("total")).order_by()
        .values_list("currency_id", "operation", "period", "count", "total_sum", "median")
    ):
        if operation == _SALE:
            visits[currency, period] = Visits(count, total, median)
        else:
            refunds[currency, period] = count
    sales = receipts.filter(_within(base) | _within(current), operation=_SALE)
    purchases = {}
    for currency, period, *row in (
        ReceiptLine.objects.filter(receipt__in=sales.values("pk"), kind=ReceiptLine.Kind.PRODUCT, quantity__gt=0)
        .values("receipt__currency_id", "unit")
        .annotate(
            period=_period(base, "receipt__"),
            owner=product_ref if product_ref is not None else F("product_id"),
            paid=Sum(F("amount") - F("discount_amount")), quantity_sum=Sum("quantity"), lines=Count("pk"),
        )
        .order_by()
        .values_list("receipt__currency_id", "period", "owner", "unit", "paid", "quantity_sum", "lines")
    ):
        purchases.setdefault((currency, period), []).append(Purchase(*row))
    bought = {
        period: {row.product_id for key, rows in purchases.items() if key[1] == period for row in rows}
        for period in (BASE, CURRENT)
    }
    ids = (bought[BASE] & bought[CURRENT]) - {None}
    names = dict(Product.objects.filter(pk__in=ids).values_list("pk", "name"))
    return Collected(visits, refunds, purchases, names)
