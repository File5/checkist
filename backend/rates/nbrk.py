"""Официальные курсы Национального банка Казахстана: адрес, загрузка и разбор XML.

Источник — ``https://nationalbank.kz/rss/get_rates.cfm?fdate=ДД.ММ.ГГГГ`` (проверено 2026-10-13):

    <rates><date>09.10.2026</date>
      <item><fullname>ДОЛЛАР США</fullname><title>USD</title><description>448.94</description>
            <quant>1</quant><index>UP</index><change>+0.62</change></item> …
    </rates>

``description`` — сколько тенге стоят ``quant`` единиц валюты (у UZS и KRW ``quant`` 100, у IRR 10000).
Курс есть на каждый календарный день до сегодняшнего, включая выходные; на завтра и позже ответ
без ``item`` с ``<info>на выбранную дату информации нет.</info>`` — это пустой список, не ошибка.
Сеть — только ``fetch``; разбор (``parse``) — чистая функция, её проверяют на образцах XML.
"""
import re
import urllib.error
import urllib.request
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import NamedTuple
from xml.etree import ElementTree

from django.conf import settings

MAX_BYTES = 1024 * 1024
_CODE = re.compile(r"[A-Z]{3}")
_NUMBER = re.compile(r"[0-9]{1,12}(?:\.[0-9]{1,6})?")
_QUANT = re.compile(r"[0-9]{1,9}")


class FetchError(Exception):
    """Нацбанк не ответил, ответил ошибкой или не тем XML; текст — для журнала и команды."""


class Item(NamedTuple):
    currency: str
    value: Decimal  # тенге за ``quant`` единиц
    quant: int


def url(day):
    """Адрес курсов на ``day``: шаблон ``RATES_NBRK_URL`` с ``{date}`` = ``ДД.ММ.ГГГГ``."""
    return settings.RATES_NBRK_URL.format(date=day.strftime("%d.%m.%Y"))


def _text(element, name):
    found = element.find(name)
    return (found.text or "").strip() if found is not None else ""


def parse(content):
    """``bytes`` XML -> ``[Item]``; неразборчивый XML — ``FetchError``.

    Строка с неверным кодом, курсом или ``quant`` пропускается, повтор кода — первая строка.
    Ответ «информации нет» — пустой список. XML с объявлениями DTD и сущностей не разбирается вовсе
    (у Нацбанка их нет): так ни внешние сущности, ни их размножение до разбора не доходят.
    """
    if b"<!DOCTYPE" in content.upper() or b"<!ENTITY" in content.upper():
        raise FetchError("XML with a DTD is not accepted")
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as error:
        raise FetchError(f"not an XML answer: {error}") from None
    if root.tag != "rates":
        raise FetchError(f"unexpected root element <{root.tag}>")
    items, seen = [], set()
    for element in root.iter("item"):
        code, value, quant = _text(element, "title").upper(), _text(element, "description"), _text(element, "quant")
        if not (_CODE.fullmatch(code) and _NUMBER.fullmatch(value) and _QUANT.fullmatch(quant)) or code in seen:
            continue
        try:
            amount, units = Decimal(value), int(quant)
        except (InvalidOperation, ValueError):
            continue
        if amount <= 0 or units <= 0:
            continue
        seen.add(code)
        items.append(Item(code, amount, units))
    return items


def fetch(day, timeout=None):
    """Курсы на ``day`` с сайта Нацбанка; ``timeout`` — секунды (по умолчанию ``RATES_FETCH_TIMEOUT_SECONDS``)."""
    if not isinstance(day, date):
        raise TypeError("day must be a date")
    request = urllib.request.Request(url(day), headers={"User-Agent": "checkist-rates/1"})
    try:
        with urllib.request.urlopen(request, timeout=timeout or settings.RATES_FETCH_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                raise FetchError(f"HTTP {response.status}")
            content = response.read(MAX_BYTES + 1)
    except FetchError:
        raise
    except (urllib.error.URLError, OSError, ValueError) as error:
        raise FetchError(f"request failed: {error}") from None
    if len(content) > MAX_BYTES:
        raise FetchError("answer too large")
    return parse(content)
