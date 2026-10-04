"""Decimal-контекст вычисляемых цен; контекст вызывающего кода не меняется.

Модули API используют те же правила, что агрегаты receipts. По полям моделей:
abs(amount - discount) < 10**12, quantity >= .001, фасовка в базовых единицах
>= .000001, поэтому abs(normalized) < 10**21 (25 цифр с четырьмя дробными).
Курс имеет до 24 значащих цифр: точное произведение требует до 49 цифр.
Сумма по максимум 2**63-1 строкам требует до 44 цифр. Ненулевая пересчитанная
цена >= 10**-16 по модулю, процент — до 51 целой цифры. 128 цифр покрывают
эти границы и запас для деления: до 49 цифр знаменателя плюс 53 цифры ответа.
Нормализацию и SQL-агрегаты считает Postgres numeric, без приведения к float.
"""
from decimal import ROUND_HALF_UP, Context, Decimal, localcontext

_CONTEXT = Context(prec=128, rounding=ROUND_HALF_UP)


def price_context():
    return localcontext(_CONTEXT)


def round_decimal(value, places):
    if value is None:
        return None
    with price_context():
        return Decimal(value).quantize(Decimal(1).scaleb(-places))


def decimal_average(total, count):
    with price_context():
        return total / count


def decimal_mean(values):
    with price_context():
        return sum(values, Decimal(0)) / len(values) if values else None


def change_percent(first, last):
    with price_context():
        return round_decimal((last - first) / first * 100, 2)
