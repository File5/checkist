from decimal import Decimal

from django.db.models import Case, DecimalField, ExpressionWrapper, F, Value, When
from django.db.models.functions import Round

from catalog.units import Unit, to_base
from receipts.models import Receipt, ReceiptLine

PRICE_DECIMAL_PLACES = 4  # как у ReceiptLine.unit_price
_PRICE = DecimalField(max_digits=20, decimal_places=PRICE_DECIMAL_PLACES)
# Единица -> множитель до базовой (г -> 0,001 кг) из catalog.units.to_base.
_FACTORS = {unit: to_base(1, unit)[0] for unit in Unit}
# Строка в этих единицах — весовая: цена за единицу уже относится к весу или объёму.
_MEASURED_UNITS = (Unit.KG, Unit.G, Unit.L, Unit.ML)


def _price(expression):
    return Round(ExpressionWrapper(expression, output_field=_PRICE), PRICE_DECIMAL_PLACES)


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
      единицах; иначе ``NULL``.

    Скидка на весь чек (``ReceiptDiscount.line IS NULL``) по строкам не
    распределяется и в цену не входит.
    """
    lines = ReceiptLine.objects.filter(
        kind=ReceiptLine.Kind.PRODUCT, quantity__gt=0, receipt__operation=Receipt.Operation.SALE,
    )
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
    return lines.annotate(
        observed_at=F("receipt__purchased_at"),
        currency_code=F("receipt__currency_id"),
        list_unit_price=F("unit_price"),
        paid_unit_price=_price(paid),
        normalized_price=Case(*measured, *packaged, default=Value(None), output_field=_PRICE),
    ).order_by("observed_at", "receipt_id", "position")
