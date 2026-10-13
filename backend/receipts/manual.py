"""Трата без чека: ``Receipt(source=manual)`` — создание, правка и удаление.

Трата — обычный чек, чтобы списки и статистика оставались одной выборкой. Без
позиций это одна строка «<категория>» на всю сумму; с позициями — строки с
названиями человека. Строки ручной траты товаром каталога не сопоставляются:
сопоставление импорта идёт по написаниям продавца (``ProductAlias`` по ``merchant``),
а у траты продавца может не быть; новый товар попал бы в «Не разобрано» и спрятал бы
категорию, выбранную человеком. Категорию строки хранит ``ReceiptLine.category``.

Три правила дедупликации к ручным тратам не применяются (условие ``source='photo'``
у ограничений). Место — свободный текст: найденный по названию магазин либо новый
продавец с магазином; пусто — «Без места» (``store`` NULL).

Разбор тела — ``parse``: ошибки копятся и уходят одним ``ManualInvalid`` с полями
``{"имя": "причина"}``; тексты причин — у слоя API.
"""
import re
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import transaction
from django.db.models import Count, F, Q
from django.utils import timezone

from catalog.models import Category
from receipts.decimal_math import price_context, round_decimal
from receipts.models import Receipt, ReceiptLine
from stores.models import Country, Currency, Merchant, Store

MAX_LINES = 100
NAME_MAX = 200
NOTE_MAX = 1000
STORE_NAME_MAX = 100
FREQUENT_LIMIT = 8
DEFAULT_CURRENCY = "KZT"
DEFAULT_COUNTRY = "KZ"
# Как у распознавания (recognition.resolution): страна нового места — по валюте траты.
COUNTRY_BY_CURRENCY = {"RUB": "RU", "KZT": "KZ", "EUR": "DE"}
TIMEZONE_BY_COUNTRY = {"RU": "Europe/Moscow", "KZ": "Asia/Almaty", "DE": "Europe/Berlin"}

FIELDS = ("total", "currency", "category", "purchased_on", "store_name", "note", "lines")
LINE_FIELDS = ("name", "amount", "quantity", "category")
_MONEY = re.compile(r"[0-9]{1,12}(?:\.[0-9]{1,2})?")
_QUANTITY = re.compile(r"[0-9]{1,9}(?:\.[0-9]{1,3})?")
_ONE = Decimal(1)


class ManualInvalid(Exception):
    """Тело не прошло проверку: ``fields`` — ``{"имя поля": "причина"}``."""

    def __init__(self, fields):
        super().__init__("manual spend invalid")
        self.fields = fields


@dataclass
class LineInput:
    name: str
    amount: Decimal
    quantity: Decimal = _ONE
    category: int | None = None


# --- разбор тела ---

def _number(value, pattern):
    """``Decimal`` > 0 из строки или числа JSON; ``None`` — неверный формат или не больше нуля."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    text = str(value).strip().replace(",", ".") if not isinstance(value, float) else repr(value)
    if not pattern.fullmatch(text):
        return None
    number = Decimal(text)
    return number if number > 0 else None


def _text(errors, name, value, limit, *, required):
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        errors[name] = "type"
        return None
    value = value.strip()
    if required and not value:
        errors[name] = "blank"
        return None
    if len(value) > limit:
        errors[name] = "too_long"
        return None
    return value


def _id(errors, name, value):
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value < 2 ** 63:
        errors[name] = "type"
        return None
    return value


def parse(data):
    """Проверенные значения переданных полей тела; отсутствующих ключей в ответе нет.

    ``lines`` — список ``LineInput`` (пустой — трата без позиций). Существование валюты и
    категорий проверяется здесь же (два запроса).
    """
    if not isinstance(data, dict):
        raise ManualInvalid({"body": "type"})
    errors, values = {}, {}
    for key in data:
        if key not in FIELDS:
            errors[key] = "unknown_field"
    if "total" in data:
        if data["total"] is None:
            values["total"] = None
        elif (total := _number(data["total"], _MONEY)) is None:
            errors["total"] = "money"
        else:
            values["total"] = total
    if "currency" in data:
        code = data["currency"]
        if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z]{3}", code.strip()):
            errors["currency"] = "format"
        else:
            values["currency"] = code.strip().upper()
    refs = {}  # имя поля -> id категории, проверяются одним запросом
    if "category" in data:
        values["category"] = refs["category"] = _id(errors, "category", data["category"])
    if "purchased_on" in data:
        value = data["purchased_on"]
        try:
            values["purchased_on"] = date.fromisoformat(value) if isinstance(value, str) and len(value) == 10 else None
        except ValueError:
            values["purchased_on"] = None
        if values["purchased_on"] is None:
            errors["purchased_on"] = "date"
    if "store_name" in data:
        name = _text(errors, "store_name", data["store_name"], STORE_NAME_MAX, required=False)
        values["store_name"] = name or None
    if "note" in data:
        note = _text(errors, "note", data["note"], NOTE_MAX, required=False)
        values["note"] = note or ""
    if "lines" in data:
        values["lines"] = _parse_lines(errors, data["lines"], refs)
    _check_references(errors, values, refs)
    if errors:
        raise ManualInvalid(errors)
    return values


def _parse_lines(errors, raw, refs):
    if raw is None:
        return []
    if not isinstance(raw, list):
        errors["lines"] = "type"
        return []
    if len(raw) > MAX_LINES:
        errors["lines"] = "size"
        return []
    lines = []
    for index, item in enumerate(raw):
        prefix = f"lines.{index}."
        if not isinstance(item, dict):
            errors[f"lines.{index}"] = "type"
            continue
        for key in item:
            if key not in LINE_FIELDS:
                errors[prefix + key] = "unknown_field"
        name = _text(errors, prefix + "name", item.get("name"), NAME_MAX, required=True)
        amount = _number(item.get("amount"), _MONEY)
        if amount is None:
            errors[prefix + "amount"] = "money" if "amount" in item else "required"
        quantity = _ONE
        if item.get("quantity") is not None:
            quantity = _number(item["quantity"], _QUANTITY)
            if quantity is None:
                errors[prefix + "quantity"] = "quantity"
        category = refs[prefix + "category"] = _id(errors, prefix + "category", item.get("category"))
        if name is not None and amount is not None and quantity is not None:
            lines.append(LineInput(name, amount, quantity, category))
    return lines


def _check_references(errors, values, refs):
    if "currency" in values and "currency" not in errors \
            and not Currency.objects.filter(pk=values["currency"]).exists():
        errors["currency"] = "unknown"
    wanted = {}
    for name, pk in refs.items():
        if pk is not None:
            wanted.setdefault(pk, []).append(name)
    if wanted:
        known = set(Category.objects.filter(pk__in=list(wanted)).values_list("pk", flat=True))
        for pk, names in wanted.items():
            if pk not in known:
                for name in names:
                    errors[name] = "unknown"


# --- значения по умолчанию ---

def default_currency(receipts, user=None):
    """Основная валюта ``user`` из настроек, иначе валюта последнего чека ``receipts``, иначе ``KZT``."""
    from accounts.profile import default_currency as profile_currency

    preferred = profile_currency(user)
    if preferred:
        return preferred
    last = receipts.order_by("-purchased_at", "-id").values_list("currency_id", flat=True).first()
    return last or DEFAULT_CURRENCY


def frequent_categories(lines, limit=FREQUENT_LIMIT):
    """Категории ручных трат по частоте: ``lines`` — queryset строк владельца."""
    return list(
        lines.filter(receipt__source=Receipt.Source.MANUAL, category__isnull=False)
        .values("category_id").annotate(uses=Count("pk")).order_by("-uses", "category_id")
        .values_list("category_id", flat=True)[:limit]
    )


# --- место и момент покупки ---

def find_or_create_store(name, currency):
    """Магазин с вывеской или названием ``name`` (без учёта регистра) либо новый продавец с магазином.

    Единственный вход «название → магазин» для трат без чека и импорта выписок. Склеенный магазин
    (вариант написания, ``Store.merged_into``) отвечает своим главным: «Anthropic Claude» после склейки —
    «CLAUDE.AI SUBSCRIPTION».
    """
    found = (
        Store.objects.filter(Q(merchant__brand_name__iexact=name) | Q(name__iexact=name))
        .select_related("merged_into").order_by(F("merged_into").asc(nulls_first=True), "pk").first()
    )
    if found is not None:
        return found.merged_into or found
    code = COUNTRY_BY_CURRENCY.get(currency, DEFAULT_COUNTRY)
    country = Country.objects.filter(pk=code).first() or Country.objects.order_by("pk").first()
    merchant = Merchant.objects.create(country=country, legal_name=name, brand_name=name[:100])
    return Store.objects.create(
        merchant=merchant, country=country, name=name, address_raw="",
        timezone=TIMEZONE_BY_COUNTRY.get(country.pk, "UTC"),
    )


def _zone(store):
    if store is not None:
        try:
            return ZoneInfo(store.timezone)
        except (KeyError, ValueError, OSError):
            pass
    return timezone.get_default_timezone()


def purchase_moment(purchased_on, store):
    """Момент траты: «сейчас», если дата — сегодня в поясе места, иначе полдень того дня."""
    zone = _zone(store)
    now = timezone.now()
    if now.astimezone(zone).date() == purchased_on:
        return now
    return datetime.combine(purchased_on, time(12), tzinfo=zone)


# --- запись ---

def _rows(lines, total, category, names):
    """Строки траты: позиции человека либо одна строка «<категория>» на всю сумму."""
    if not lines:
        return [LineInput(names[category], total, _ONE, category)]
    return [LineInput(line.name, line.amount, line.quantity, line.category or category) for line in lines]


def _write_lines(receipt, rows):
    receipt.lines.all().delete()
    with price_context():
        ReceiptLine.objects.bulk_create([
            ReceiptLine(
                receipt=receipt, position=position, kind=ReceiptLine.Kind.PRODUCT, raw_name=row.name,
                quantity=row.quantity, unit_price=round_decimal(row.amount / row.quantity, 4),
                amount=row.amount, category_id=row.category,
            )
            for position, row in enumerate(rows, start=1)
        ])


def _category_names(*ids):
    ids = [pk for pk in ids if pk is not None]
    return dict(Category.objects.filter(pk__in=ids).values_list("pk", "name"))


def _total(errors, lines, total):
    """Итог траты с позициями: сумма позиций; переданный итог обязан с ней совпасть."""
    with price_context():
        computed = sum((line.amount for line in lines), Decimal("0.00"))
    if total is not None and total != computed:
        errors["total"] = "mismatch"
    return computed


def create(owner, data):
    """Новая трата владельца ``owner`` по телу ``data``; ``ManualInvalid`` — тело не подошло."""
    values = parse(data)
    errors = {}
    lines = values.get("lines") or []
    category = values.get("category")
    total = values.get("total")
    if lines:
        total = _total(errors, lines, total)
    else:
        if total is None:
            errors["total"] = "required"
        if category is None:
            errors["category"] = "required"
    if errors:
        raise ManualInvalid(errors)
    currency = values.get("currency") or default_currency(Receipt.objects.filter(owner=owner))
    if not Currency.objects.filter(pk=currency).exists():
        raise ManualInvalid({"currency": "required"})
    purchased_on = values.get("purchased_on") or timezone.localdate()
    with transaction.atomic():
        store = find_or_create_store(values["store_name"], currency) if values.get("store_name") else None
        receipt = Receipt.objects.create(
            owner=owner, source=Receipt.Source.MANUAL, store=store, currency_id=currency,
            operation=Receipt.Operation.SALE, purchased_on=purchased_on,
            purchased_at=purchase_moment(purchased_on, store), total=total, note=values.get("note", ""),
        )
        _write_lines(receipt, _rows(lines, total, category, _category_names(category)))
    return receipt


def update(receipt_id, data):
    """Правка ручной траты: переданные поля меняются, остальные остаются.

    ``lines`` в теле заменяет все строки (пустой список — трата без позиций на ``total``
    в ``category``). Без ``lines``: у траты из одной строки ``total`` и ``category``
    меняют её; у траты с позициями ``total`` должен совпасть с их суммой, а ``category``
    задают позициям.
    """
    values = parse(data)
    with transaction.atomic():
        receipt = Receipt.objects.select_for_update().get(pk=receipt_id)
        current = list(receipt.lines.order_by("position", "pk"))
        errors = {}
        category = values.get("category")
        total = values.get("total")
        rows = None
        if "lines" in values:
            lines = values["lines"]
            if lines:
                total = _total(errors, lines, total)
            else:
                single = current[0].category_id if len(current) == 1 else None
                category = category if category is not None else single
                total = total if total is not None else receipt.total
                if category is None:
                    errors["category"] = "required"
            if not errors:
                rows = _rows(lines, total, category, _category_names(category))
        elif "total" in values or "category" in values:
            if "total" in values and total is None:
                errors["total"] = "required"
            elif len(current) == 1:
                line = current[0]
                total = total if total is not None else line.amount
                new_category = category if category is not None else line.category_id
                name = line.raw_name
                if line.category_id is not None and new_category != line.category_id:
                    old = _category_names(line.category_id).get(line.category_id)
                    if old == name:  # строка «<категория>» следует за категорией
                        name = _category_names(new_category)[new_category]
                rows = [LineInput(name, total, line.quantity, new_category)]
            else:
                if "category" in values:
                    errors["category"] = "itemized"
                if total is not None:
                    _total(errors, current, total)
        if errors:
            raise ManualInvalid(errors)
        if "currency" in values:
            receipt.currency_id = values["currency"]
        if "store_name" in values:
            name = values["store_name"]
            receipt.store = find_or_create_store(name, receipt.currency_id) if name else None
        if "note" in values:
            receipt.note = values["note"]
        if "purchased_on" in values and values["purchased_on"] != receipt.purchased_on:
            receipt.purchased_on = values["purchased_on"]
            receipt.purchased_at = purchase_moment(receipt.purchased_on, receipt.store)
        if rows is not None:
            _write_lines(receipt, rows)
            with price_context():
                receipt.total = sum((row.amount for row in rows), Decimal("0.00"))
        receipt.save()
    return receipt


def delete(receipt_id):
    with transaction.atomic():
        Receipt.objects.select_for_update().filter(pk=receipt_id).delete()
