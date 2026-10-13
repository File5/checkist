"""Текст выписки → банк и строки. Без Django: только текст, который вынул ``extract``.

Kaspi Gold — строка на операцию::

    12.09.26 - 2 590,00 ₸ Покупка ТОО "Магазин"
    14.09.26 - 4 812,34 ₸ (-10,00 USD) Покупка APPLE.COM/BILL
    15.09.26 + 15 000,00 ₸ Пополнение С Kaspi Депозита

ForteBank — дата, сумма с валютой, вид операции и детали; детали могут продолжаться на
следующих строках::

    12.09.2026 -2590.00 KZT Покупка MAGNUM AKSAI, ALMATY, KZ, MCC: 5411
    13.09.2026 -6700.00 KZT Платеж Beeline Казахстан, PAYMENT_ID=1a2b3c4d

Банк узнаётся по шапке: первое упоминание банка в начале текста. Выписка другого банка —
``UnsupportedBank``, текст без операций — пустой список строк.
"""
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

KASPI = "kaspi_gold"
FORTE = "forte"
BANK_LABELS = {KASPI: "Kaspi Gold", FORTE: "ForteBank"}

HEAD_CHARS = 3000
# Отметки банков в шапке; первая по тексту решает. Другие банки — отказ, а не попытка разобрать.
_MARKS = (
    (KASPI, re.compile(r"kaspi\s*gold|kaspi\s*bank|kaspi\.kz|каспи", re.IGNORECASE)),
    (FORTE, re.compile(r"forte\s*bank|fortebank|forte\.kz|форте", re.IGNORECASE)),
    (None, re.compile(
        r"halyk|халык|jusan|жусан|bereke|береке|freedom\s*bank|фридом|home\s*credit|хоум\s*кредит|"
        r"centercredit|центркредит|евразийский|eurasian\s*bank|altyn|алтын\s*банк|nurbank|нурбанк|sber|сбер|"
        r"tinkoff|тинькофф|т-банк|альфа[- ]?банк|alfa[- ]?bank|втб|vtb|rbk|bank\s*rbk",
        re.IGNORECASE)),
)

_SPACES = re.compile(r"[\u00a0\u2007\u2009\u202f\u2002\u2003\u2004\u2005\u2006\u2008\u200a\t\f\v]")
_ZERO_WIDTH = re.compile(r"[\u200b\u200c\u200d\ufeff]")

# The integer part of an amount: thousands split by single spaces («1 234 567», after clean_text) or plain digits.
# It never ends in a space, so it cannot overlap the «\s*» before the currency: no quadratic backtracking on a
# crafted line of digits and spaces (the parser runs in the web process).
_INTEGER = r"(?:\d{1,3}(?: \d{3})+|\d+)"
_KASPI_ROW = re.compile(
    r"^(?P<d>\d{2})\.(?P<m>\d{2})\.(?P<y>\d{2})\s+(?P<sign>[+-])\s*(?P<amount>" + _INTEGER + r"(?:,\d{1,2})?)\s*₸\s*"
    r"(?:\((?P<foreign>[^)]*)\)\s*)?(?P<op>Покупка|Перевод|Пополнение|Снятие|Разное|Возврат)\b\s*(?P<details>.*)$"
)
_FORTE_ROW = re.compile(
    r"^(?P<d>\d{2})\.(?P<m>\d{2})\.(?P<y>\d{4})\s+(?P<amount>[+-]? ?" + _INTEGER + r"(?:[.,]\d{1,2})?)\s*(?P<cur>[A-Z]{3})\b\s*(?P<rest>.*)$"
)
_FORTE_BODY = re.compile(
    r"^(?:\((?P<foreign>[^)]*)\)\s*)?(?P<op>Покупка|Пополнение счета|Пополнение|Перевод\S*|Снятие\S*|Списание\S*|Возврат\S*|"
    r"Комиссия\S*|Оплата\S*|Платеж\S*|Платёж\S*|Кэшбэк\S*|Вознаграждение\S*|\S+)\s*(?P<details>.*)$"
)
# Строки шапки и подвала страниц ForteBank: не продолжение деталей операции.
_FORTE_NOISE = re.compile(
    r"^(?:Дата\b|Детализация|Выписка|Страница|Стр\.|Итого|Остаток|Сумма\b|Период|Номер\b|Валюта\b|Клиент|ИИН|БИН|"
    r"Page\b|АО\b|Forte|\d+\s*(?:/|из)\s*\d+$)",
    re.IGNORECASE,
)
_MCC = re.compile(r"MCC:?\s*(\d{4})", re.IGNORECASE)
_PAYMENT_ID = re.compile(r"PAYMENT_ID=\s*([0-9A-Za-z-]+)")
_LEGAL_QUOTED = re.compile(r'^(?:ТОО|ИП|АО|TOO|IP|LLP)\s+["«“](.+?)["»”]\s*$', re.IGNORECASE)
_LEGAL_PREFIX = re.compile(r"^(?:ТОО|ИП|TOO|IP|LLP)\s+", re.IGNORECASE)

MERCHANT_MAX = 200
DETAILS_MAX = 300
OPERATION_MAX = 40
# Bounds of the work on one text: a longer line is no row of a statement and is skipped unread; more text or rows —
# the statement is refused as too large (``TooLarge``).
MAX_LINE = 500
MAX_TEXT = 4_000_000
MAX_ROWS = 3000
MAX_CONTINUATION = 10


class UnsupportedBank(Exception):
    """Шапка называет другой банк либо не называет никакого."""


class TooLarge(Exception):
    """Текст длиннее ``MAX_TEXT`` либо операций больше ``MAX_ROWS``."""


@dataclass(frozen=True)
class ParsedRow:
    date: date
    amount: Decimal          # со знаком: отрицательная — деньги ушли с карты
    currency: str
    operation: str           # «Покупка», «Перевод», «Платеж», …
    details: str
    merchant: str            # получатель либо отправитель
    mcc: str = ""
    payment_id: str = ""     # ForteBank: платёж и возврат его бонусной части


def clean_text(text):
    """Пробелы PDF (неразрывные, узкие, табуляции) — обычные, переводы строк — ``\\n``."""
    text = _ZERO_WIDTH.sub("", text.replace("\r\n", "\n").replace("\r", "\n"))
    return _SPACES.sub(" ", text)


def detect_bank(text):
    """``KASPI`` | ``FORTE`` по первой отметке банка в шапке; иначе ``UnsupportedBank``."""
    head = clean_text(text)[:HEAD_CHARS]
    found = [(match.start(), bank) for bank, pattern in _MARKS if (match := pattern.search(head))]
    if not found:
        raise UnsupportedBank()
    bank = min(found, key=lambda item: item[0])[1]
    if bank is None:
        raise UnsupportedBank()
    return bank


def _day(day, month, year):
    try:
        return date(year, int(month), int(day))
    except ValueError:
        return None


def _decimal(text):
    try:
        value = Decimal(text.replace(" ", "").replace(",", "."))
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def _cut(text, limit):
    return re.sub(r"\s+", " ", text).strip()[:limit]


def kaspi_merchant(details):
    """``ТОО "Магазин"`` → ``Магазин``; остальное — как в выписке."""
    text = _cut(details, DETAILS_MAX)
    match = _LEGAL_QUOTED.match(text)
    return (match.group(1) if match else text)[:MERCHANT_MAX].strip()


def forte_merchant(operation, details):
    """Покупка и платёж — название до первой запятой без ``TOO``/``IP``; перевод — детали без служебных меток."""
    text = _PAYMENT_ID.sub("", _MCC.sub("", details))
    if operation.startswith(("Покупка", "Возврат", "Платеж", "Платёж", "Оплата")):
        text = text.split(",")[0]
    text = _cut(text, DETAILS_MAX).strip(" ,;")
    match = _LEGAL_QUOTED.match(text)
    text = match.group(1) if match else _LEGAL_PREFIX.sub("", text)
    return text[:MERCHANT_MAX].strip()


def _lines(text):
    """Строки текста без пробелов по краям; длиннее ``MAX_LINE`` — пропускаются, регулярные выражения их не видят."""
    for line in clean_text(text).split("\n"):
        line = line.strip()
        if len(line) <= MAX_LINE:
            yield line


def _add(rows, row):
    rows.append(row)
    if len(rows) > MAX_ROWS:
        raise TooLarge()


def parse_kaspi(text):
    rows = []
    for line in _lines(text):
        match = _KASPI_ROW.match(line)
        if not match:
            continue
        day = _day(match["d"], match["m"], 2000 + int(match["y"]))
        amount = _decimal(match["amount"])
        if day is None or amount is None or amount == 0:
            continue
        details = _cut(match["details"], DETAILS_MAX)
        _add(rows, ParsedRow(
            date=day, amount=-amount if match["sign"] == "-" else amount, currency="KZT",
            operation=match["op"], details=details, merchant=kaspi_merchant(details),
        ))
    return rows


def parse_forte(text):
    heads = []
    for line in _lines(text):
        match = _FORTE_ROW.match(line)
        if match:
            heads.append([match, [match["rest"]]])
            if len(heads) > MAX_ROWS:
                raise TooLarge()
        elif heads and line and len(heads[-1][1]) <= MAX_CONTINUATION and not _FORTE_NOISE.match(line):
            heads[-1][1].append(line)
    rows = []
    for match, parts in heads:
        day = _day(match["d"], match["m"], int(match["y"]))
        amount = _decimal(match["amount"])
        if day is None or amount is None or amount == 0:
            continue
        body = _cut(" ".join(parts), 2000)
        found = _FORTE_BODY.match(body)
        operation, details = (found["op"], found["details"]) if found else ("?", body)
        mcc = _MCC.search(details)
        payment = _PAYMENT_ID.search(details)
        _add(rows, ParsedRow(
            date=day, amount=amount, currency=match["cur"], operation=operation[:OPERATION_MAX],
            details=_cut(details, DETAILS_MAX), merchant=forte_merchant(operation, details),
            mcc=mcc.group(1) if mcc else "", payment_id=payment.group(1)[:8] if payment else "",
        ))
    return rows


def parse(text):
    """``(bank, rows)``; ``UnsupportedBank`` — не Kaspi Gold и не ForteBank, ``TooLarge`` — сверх пределов."""
    if len(text) > MAX_TEXT:
        raise TooLarge()
    bank = detect_bank(text)
    return bank, parse_kaspi(text) if bank == KASPI else parse_forte(text)
