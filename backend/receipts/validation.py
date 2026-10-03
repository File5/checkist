from decimal import Decimal
from zoneinfo import ZoneInfo

ROUNDING_TOLERANCE = Decimal("0.01")
ZERO = Decimal(0)


def _line_label(line):
    return f"строка {line.position}"


def validate_receipt(receipt):
    """Нарушения инвариантов уровня приложения у сохранённого чека; пустой список — их нет.

    Это предупреждения, а не отказ в сохранении: источник данных — распознавание,
    и чек с ошибкой в одной цифре лучше сохранить, чем потерять.
    """
    problems = []
    store = receipt.store
    lines = list(receipt.lines.select_related("tax_rate").order_by("position"))
    discounts = list(receipt.discounts.order_by("position"))
    taxes = list(receipt.taxes.select_related("tax_rate").order_by("pk"))
    line_ids = {line.pk for line in lines}

    try:
        local_date = receipt.purchased_at.astimezone(ZoneInfo(store.timezone)).date()
    except (KeyError, ValueError, OSError):  # ZoneInfoNotFoundError — подкласс KeyError
        problems.append(f"store.timezone: неизвестный часовой пояс «{store.timezone}».")
    else:
        if receipt.purchased_on != local_date:
            problems.append(
                f"purchased_on: {receipt.purchased_on} не совпадает с датой purchased_at "
                f"в поясе магазина {store.timezone} ({local_date})."
            )

    line_discounts = {}
    for discount in discounts:
        if discount.line_id is None:
            continue
        if discount.line_id not in line_ids:
            problems.append(
                f"discount.line: скидка {discount.position} «{discount.name}» относится к строке другого чека."
            )
        else:
            line_discounts[discount.line_id] = line_discounts.get(discount.line_id, ZERO) + discount.amount

    for line in lines:
        label = _line_label(line)
        if line.parent_id is not None and line.parent_id not in line_ids:
            problems.append(f"line.parent: {label} ссылается на строку другого чека.")
        discounted = line_discounts.get(line.pk, ZERO)
        if line.discount_amount != discounted:
            problems.append(
                f"line.discount_amount: {label}: {line.discount_amount} не равно сумме скидок строки {discounted}."
            )
        expected = line.quantity * line.unit_price
        if abs(line.amount - expected) > ROUNDING_TOLERANCE:
            problems.append(
                f"line.amount: {label}: {line.amount} не равно quantity × unit_price = {expected.normalize():f}."
            )
        if line.tax_rate is not None and line.tax_rate.country_id != store.country_id:
            problems.append(
                f"line.tax_rate: {label}: ставка страны {line.tax_rate.country_id}, магазин в {store.country_id}."
            )

    lines_total = sum((line.amount for line in lines), ZERO) - sum((d.amount for d in discounts), ZERO)
    if not receipt.prices_include_tax:
        # Цены без налога: налог из итогов по ставкам добавляется сверху.
        lines_total += sum((tax.tax for tax in taxes), ZERO)
    if lines_total != receipt.total:
        problems.append(f"total: сумма строк за вычетом скидок {lines_total} не равна итогу чека {receipt.total}.")

    for tax in taxes:
        if tax.tax_rate.country_id != store.country_id:
            problems.append(
                f"tax.tax_rate: итог по ставке «{tax.tax_rate.name}»: "
                f"ставка страны {tax.tax_rate.country_id}, магазин в {store.country_id}."
            )
    # Итоги по ставкам печатают не на каждом чеке: без них сверять нечего.
    if taxes:
        gross_total = sum((tax.gross for tax in taxes), ZERO)
        if gross_total != receipt.total:
            problems.append(f"taxes.gross: сумма итогов по ставкам {gross_total} не равна итогу чека {receipt.total}.")

    return problems
