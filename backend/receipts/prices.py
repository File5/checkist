from dataclasses import dataclass
from decimal import Decimal

from django.db.models import (
    Avg, Case, CharField, Count, DecimalField, ExpressionWrapper, F, Max, Min, Q, Value, When,
)
from django.db.models.functions import Round

from catalog.units import Unit, to_base
from receipts.decimal_math import round_decimal
from receipts.models import Receipt, ReceiptLine

PRICE_DECIMAL_PLACES = 4  # как у ReceiptLine.unit_price
# Вычисляемая цена: до 21 целой цифры при минимальных количестве и фасовке.
# ExpressionWrapper задаёт тип ORM, а вычисления Postgres остаются numeric без typmod.
_PRICE = DecimalField(max_digits=25, decimal_places=PRICE_DECIMAL_PLACES)
# Единица -> множитель до базовой (г -> 0,001 кг) из catalog.units.to_base.
_FACTORS = {unit: to_base(1, unit)[0] for unit in Unit}
# Единица -> базовая единица, за которую получается нормализованная цена (г -> кг).
_BASE_UNITS = {unit: to_base(1, unit)[1].value for unit in Unit}
# Строка в этих единицах — весовая: цена за единицу уже относится к весу или объёму.
_MEASURED_UNITS = (Unit.KG, Unit.G, Unit.L, Unit.ML)


def _price(expression):
    return Round(ExpressionWrapper(expression, output_field=_PRICE), PRICE_DECIMAL_PLACES)


def observation_q(prefix=""):
    """Условие «строка — наблюдение цены»: товар, положительное количество, чек продажи.

    ``prefix`` — путь до ``ReceiptLine`` от другой модели, например
    ``"receipt_lines__"`` для запросов от ``catalog.Product``.
    """
    return Q(**{
        f"{prefix}kind": ReceiptLine.Kind.PRODUCT,
        f"{prefix}quantity__gt": 0,
        f"{prefix}receipt__operation": Receipt.Operation.SALE,
    })


def comparable_q():
    """Условие для строк ``price_history``: цена за базовую единицу сравнима.

    Сравнима — значит ``normalized_unit`` равна ``base_unit`` обобщённого продукта
    товара. Строка без товара или без нормализованной цены несравнима.
    """
    return Q(normalized_unit=F("product__generic__base_unit"))


def price_history(*, product=None, generic=None, store=None, country=None, date_from=None, date_to=None):
    """История цен: строки чеков с ценой за единицу, по возрастанию момента покупки.

    Отдельной таблицы наблюдений нет — цена выводится из строк. В выборке только
    товары (``kind='product'``) с положительным количеством из чеков продажи:
    залог, возврат тары, услуги и возвраты в неё не входят.

    Фильтры необязательны и складываются по «И»: ``product``, ``generic``, ``store``,
    ``country`` — объект или его ключ; ``date_from`` и ``date_to`` — границы локальной
    даты чека ``purchased_on``, обе включительно. Несопоставленный товар ищется
    дальнейшим ``.filter(receipt__store__merchant=..., raw_name=...)`` либо по
    ``store_item_code``.

    Аннотации (цены округлены до 4 знаков, в валюте чека — курсы не хранятся):

    - ``observed_at`` — ``receipt.purchased_at``;
    - ``currency_code`` — код валюты чека;
    - ``list_unit_price`` — цена за единицу до скидки;
    - ``paid_unit_price`` — ``(amount - discount_amount) / quantity``;
    - ``normalized_price`` — цена за кг / л / шт: у весовой строки это
      ``paid_unit_price``, приведённая к кг или л; у штучной строки с сопоставленным
      товаром с фасовкой — ``paid_unit_price``, делённая на фасовку в базовых
      единицах; иначе ``NULL``;
    - ``normalized_unit`` — единица ``normalized_price`` (``kg``, ``l``, ``pcs``, у фасовки
      в метрах — ``m``); ``NULL`` там же, где ``NULL`` цена. Совпадение с
      ``GenericProduct.base_unit`` здесь не проверяется — см. ``comparable_q``.

    Скидка на весь чек (``ReceiptDiscount.line IS NULL``) по строкам не
    распределяется и в цену не входит.
    """
    lines = ReceiptLine.objects.filter(observation_q())
    if product is not None:
        lines = lines.filter(product=product)
    if generic is not None:
        lines = lines.filter(product__generic=generic)
    if store is not None:
        lines = lines.filter(receipt__store=store)
    if country is not None:
        lines = lines.filter(receipt__store__country=country)
    if date_from is not None:
        lines = lines.filter(receipt__purchased_on__gte=date_from)
    if date_to is not None:
        lines = lines.filter(receipt__purchased_on__lte=date_to)

    # Нормализация считается от неокруглённой цены: иначе цена за грамм теряет знаки.
    paid = (F("amount") - F("discount_amount")) / F("quantity")
    measured = [
        When(unit=unit, then=_price(paid / Value(_FACTORS[unit]))) for unit in _MEASURED_UNITS
    ]
    packaged = [
        When(
            unit=Unit.PCS, product__package_unit=unit,
            then=_price(paid / (F("product__package_quantity") * Value(factor))),
        )
        for unit, factor in _FACTORS.items()
    ]
    # Те же условия, что у normalized_price: единица есть ровно там, где есть цена.
    units = [When(unit=unit, then=Value(_BASE_UNITS[unit])) for unit in _MEASURED_UNITS] + [
        When(unit=Unit.PCS, product__package_unit=unit, then=Value(base_unit))
        for unit, base_unit in _BASE_UNITS.items()
    ]
    return lines.annotate(
        observed_at=F("receipt__purchased_at"),
        currency_code=F("receipt__currency_id"),
        list_unit_price=F("unit_price"),
        paid_unit_price=_price(paid),
        normalized_price=Case(*measured, *packaged, default=Value(None), output_field=_PRICE),
        normalized_unit=Case(*units, default=Value(None), output_field=CharField(max_length=8)),
    ).order_by("observed_at", "receipt_id", "position")


@dataclass
class PriceGroup:
    """Сводка цен товара в одной паре «страна магазина, валюта чека».

    Цены разных валют в одну группу не попадают. ``normalized_*`` считаются только
    по сравнимым наблюдениям (``comparable_q``) и равны ``None``, если таких нет;
    ``normalized_avg`` — простое среднее, округлённое до 4 знаков (``ROUND_HALF_UP``).
    ``last`` — последняя строка группы с аннотациями ``price_history`` и загруженными
    ``receipt.store.merchant``; сравнимой она может не быть.
    """

    product_id: int
    country: str
    currency: str
    observations: int
    comparable_observations: int
    normalized_min: Decimal | None
    normalized_max: Decimal | None
    normalized_avg: Decimal | None
    last: ReceiptLine | None = None


def _observations(products, *, countries=None, currency=None, store=None, date_from=None, date_to=None):
    lines = price_history(store=store, date_from=date_from, date_to=date_to).filter(product__in=products)
    if countries is not None:
        lines = lines.filter(receipt__store__country__in=countries)
    if currency is not None:
        lines = lines.filter(receipt__currency=currency)
    return lines


def price_groups(products, *, countries=None, currency=None, store=None, date_from=None, date_to=None):
    """Число наблюдений, мин / макс / средняя цена за базовую единицу по группам.

    Один сгруппированный запрос на весь набор ``products`` (объекты или ключи), группа —
    «товар, страна магазина, валюта чека». Фильтры складываются по «И»: ``countries`` —
    набор кодов стран, ``currency`` и ``store`` — объект или ключ, ``date_from`` и
    ``date_to`` — границы ``purchased_on`` включительно. Возвращает список ``PriceGroup``
    без ``last``, по порядку ``product_id, country, currency``; для пустого набора
    товаров запрос не выполняется.
    """
    products = list(products)
    if not products:
        return []
    rows = (
        _observations(
            products, countries=countries, currency=currency, store=store, date_from=date_from, date_to=date_to,
        )
        .order_by()
        .values("product_id", "receipt__store__country_id", "currency_code")
        .annotate(
            observations=Count("pk"),
            comparable_observations=Count("pk", filter=comparable_q()),
            normalized_min=Min("normalized_price", filter=comparable_q()),
            normalized_max=Max("normalized_price", filter=comparable_q()),
            normalized_avg=Avg("normalized_price", filter=comparable_q()),
        )
        .order_by("product_id", "receipt__store__country_id", "currency_code")
    )
    return [
        PriceGroup(
            product_id=row["product_id"],
            country=row["receipt__store__country_id"],
            currency=row["currency_code"],
            observations=row["observations"],
            comparable_observations=row["comparable_observations"],
            normalized_min=row["normalized_min"],
            normalized_max=row["normalized_max"],
            normalized_avg=round_decimal(row["normalized_avg"], PRICE_DECIMAL_PLACES),
        )
        for row in rows
    ]


def last_prices(
    products, *, countries=None, currency=None, store=None, date_from=None, date_to=None, comparable_only=False,
):
    """Последнее наблюдение каждой группы «товар, страна магазина, валюта чека».

    Один запрос с ``DISTINCT ON`` на весь набор товаров; «последнее» — по порядку
    ``(observed_at, receipt_id, position)``. Фильтры те же, что у ``price_groups``;
    ``comparable_only=True`` оставляет только сравнимые наблюдения (``comparable_q``).
    Возвращает список строк с аннотациями ``price_history`` и загруженными
    ``receipt.store.merchant``, по порядку ``product_id, country, currency``.
    """
    products = list(products)
    if not products:
        return []
    lines = _observations(
        products, countries=countries, currency=currency, store=store, date_from=date_from, date_to=date_to,
    )
    if comparable_only:
        lines = lines.filter(comparable_q())
    group = ("product_id", "receipt__store__country_id", "receipt__currency_id")
    return list(
        lines.select_related("receipt__store__merchant")
        .order_by(*group, "-receipt__purchased_at", "-receipt_id", "-position")
        .distinct(*group)
    )


def price_summary(products, *, countries=None, currency=None, store=None, date_from=None, date_to=None):
    """Сводка цен набора товаров: ``{product_id: [PriceGroup, ...]}``.

    Два запроса на весь набор независимо от числа товаров: ``price_groups`` и
    ``last_prices``. У каждой группы заполнена ``last``; группы товара идут по
    ``country, currency``. Товара без наблюдений в результате нет. Если группа
    исчезла между запросами, она пропускается: ``last`` всегда заполнена.
    Общего снимка на оба запроса при READ COMMITTED нет.
    """
    filters = dict(countries=countries, currency=currency, store=store, date_from=date_from, date_to=date_to)
    products = list(products)
    groups = price_groups(products, **filters)
    if not groups:
        return {}
    last = {
        (line.product_id, line.receipt.store.country_id, line.currency_code): line
        for line in last_prices(products, **filters)
    }
    summary = {}
    for group in groups:
        group.last = last.get((group.product_id, group.country, group.currency))
        if group.last is None:
            continue
        summary.setdefault(group.product_id, []).append(group)
    return summary
