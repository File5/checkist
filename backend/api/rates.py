"""Курсы валют из запроса: разбор ``target_currency`` и ``rates``, пересчёт цен.

Сервер курсов не хранит и не проверяет: ``rates=RUB:0.0098,KZT:0.0018`` означает
«1 единица валюты слева = столько единиц целевой валюты». Всё считается в ``Decimal``.
"""
import re
from dataclasses import dataclass, field
from decimal import Decimal

from stores.models import Currency

MAX_RATES = 10

_CURRENCY = re.compile(r"[A-Z]{3}")
# Только обычная десятичная запись: без знака, экспоненты, NaN и Infinity.
_RATE = re.compile(r"[0-9]{1,12}(?:\.[0-9]{1,12})?")

_FORMAT = "Ожидаются пары «код валюты:курс» через запятую, например RUB:0.0098."


class RatesError(ValueError):
    """Недопустимое значение ``rates``; текст — сообщение для клиента."""


def parse_rates(value):
    """``"RUB:0.0098,KZT:0.0018"`` -> ``{"RUB": Decimal("0.0098"), "KZT": Decimal("0.0018")}``.

    Курс — положительное десятичное число, не больше ``MAX_RATES`` пар, код валюты не
    повторяется (регистр кода не важен). Наличие кодов в справочнике здесь не
    проверяется. Иначе — ``RatesError``.
    """
    pairs = [pair.strip() for pair in value.split(",")]
    if len(pairs) > MAX_RATES:
        raise RatesError(f"Не больше {MAX_RATES} курсов.")
    rates = {}
    for pair in pairs:
        code, separator, number = pair.partition(":")
        code, number = code.strip().upper(), number.strip()
        if not separator or not _CURRENCY.fullmatch(code) or not _RATE.fullmatch(number):
            raise RatesError(_FORMAT)
        rate = Decimal(number)
        if rate <= 0:
            raise RatesError("Курс должен быть больше нуля.")
        if code in rates:
            raise RatesError("Валюта указана больше одного раза.")
        rates[code] = rate
    return rates


@dataclass(frozen=True)
class Conversion:
    """Пересчёт в ``target_currency`` по курсам из запроса."""

    target_currency: str
    rates: dict = field(default_factory=dict)

    def rate(self, currency):
        """Курс валюты к целевой; у самой целевой — 1; ``None``, если курса нет."""
        if currency == self.target_currency:
            return Decimal(1)
        return self.rates.get(currency)

    def convert(self, value, currency):
        """Цена в целевой валюте без округления; ``None``, если цены или курса нет."""
        rate = self.rate(currency)
        if value is None or rate is None:
            return None
        return value * rate

    def as_json(self):
        """Блок ``conversion`` ответа; курсы — строками, как разобраны."""
        return {
            "target_currency": self.target_currency,
            "rates": {code: format(rate, "f") for code, rate in self.rates.items()},
            "source": "request",
        }


def parse_conversion(params):
    """``Conversion`` из ``target_currency`` и ``rates`` либо ``None``, если пересчёт не задан.

    Ошибки копятся в ``params`` (``api.params.Params``) и поднимаются его ``check()``.
    ``rates`` без ``target_currency``, курс самой целевой валюты и код не из
    справочника валют — ошибки. Не больше двух запросов: по одному на параметр.
    """
    target = params.currency("target_currency")
    raw = params.raw("rates")
    if raw is None:
        return None if target is None else Conversion(target)
    if params.raw("target_currency") is None:
        params.error("target_currency", "Обязателен вместе с rates.")
    try:
        rates = parse_rates(raw)
    except RatesError as error:
        params.error("rates", str(error))
        return None
    if target in rates:
        params.error("rates", "Курс целевой валюты не задаётся: он равен 1.")
        return None
    known = set(Currency.objects.filter(pk__in=rates).values_list("pk", flat=True))
    if len(known) != len(rates):
        params.error("rates", "Неизвестный код валюты.")
        return None
    return None if target is None else Conversion(target, rates)
