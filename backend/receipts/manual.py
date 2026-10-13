"""Трата: создание ручной траты и правка любой траты — с фото, ручной, из выписки — одним путём.

Единая форма траты (2026-10-13): источник (``Receipt.source`` ``photo`` / ``manual``, выписка — ручная трата
со строкой ``statements.StatementRow``) — только пометка; ``create`` и ``update`` применяют одни правила ко всем.

Трата — обычный чек, чтобы списки и статистика оставались одной выборкой. Строка как в чеке: название,
количество, единица (``catalog.units.Unit``), цена за единицу, сумма до скидки (``amount``), скидка
(``discount_amount``) и категория строки. Итог траты — сумма строк за вычетом скидок (у чека с ценами без
налога — плюс налог). Без позиций это одна строка на всю сумму: названная покупкой («Что купили»,
``item_name``) либо, без названия, «<категория>».

Названная строка — товар каталога (``find_or_create_products``, правило ветки товаров: свой личный тёзка, общий
товар по написанию места и названию, иначе новый личный товар владельца в «Не разобрано»). Правка сохраняет
товарную связь строки (``id`` в теле), пока её название не менялось (``receipts.dedup.name_key``); строка
«<категория>» (выписки, регулярные платежи, трата без названия) товаром не становится. Категорию строки хранит
``ReceiptLine.category``: она важнее категории товара. Наблюдения цены считаются из строк при чтении
(``receipts.prices``), поэтому следуют за правкой сами.

Скидка строки — строки ``ReceiptDiscount`` этой позиции (их сумма равна ``discount_amount``), скидки на весь
чек не меняются; ``discount_total`` — сумма всех скидок. Деньги строк поменялись — пересчитываются налог строки
по её ставке, итоги по ставкам (``ReceiptTax``) и итог; иначе напечатанные значения остаются.

Три правила дедупликации (у чеков с фото, в пределах владельца) не ломаются: правка, которая сделала бы чек
копией другого своего чека, отказывает (``receipt: duplicate``). У чека с фото место обязательно, время покупки
сохраняется (меняется только дата); у траты из выписки способ оплаты — банк, комментарий кончается « · Выписка …».

Разбор тела — ``parse``: ошибки копятся и уходят одним ``ManualInvalid`` с полями
``{"имя": "причина"}``; тексты причин — у слоя API.
"""
import re
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import IntegrityError, connection, transaction
from django.db.models import Count, F, Max, Q, Sum
from django.utils import timezone

from catalog.models import Category, GenericProduct, Product
from catalog.units import BaseUnit, Unit
from receipts.decimal_math import price_context, round_decimal
from receipts.dedup import name_key
from receipts import service_charges
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine
from stores.models import Country, Currency, Merchant, Store

MAX_LINES = 300
NAME_MAX = 200
NOTE_MAX = 1000
STORE_NAME_MAX = 100
FREQUENT_LIMIT = 8
DEFAULT_CURRENCY = "KZT"
DEFAULT_COUNTRY = "KZ"
# Как у распознавания (recognition.resolution): страна нового места — по валюте траты.
COUNTRY_BY_CURRENCY = {"RUB": "RU", "KZT": "KZ", "EUR": "DE"}
TIMEZONE_BY_COUNTRY = {"RU": "Europe/Moscow", "KZ": "Asia/Almaty", "DE": "Europe/Berlin"}
UNASSIGNED = "Не разобрано"  # как у импорта (recognition.resolution.resolve_product)
DISCOUNT_NAME = "Скидка"  # строка ReceiptDiscount скидки, введённой в форме
# Позиции строк переставляются через временный диапазон: (receipt, position) уникальна.
POSITION_SHIFT = 10000
# |количество × цена − сумма| строки: копейка (как у receipts.validation) плюс округление цены до 4 знаков.
PRICE_TOLERANCE = Decimal("0.01")
PRICE_STEP = Decimal("0.00005")
# Ограничения дедупликации чеков с фото (receipts.models.Receipt.Meta).
DEDUP_CONSTRAINTS = (
    "receipts_receipt_owner_fiscal_key_uniq", "receipts_receipt_owner_store_number_uniq",
    "receipts_receipt_owner_store_time_total_uniq",
)
# Комментарий траты из выписки кончается « · Выписка …» (statements.drafts.note_for, api.export).
STATEMENT_MARK = re.compile(r"\s*·\s*Выписка[^·]*$")

FIELDS = ("total", "currency", "category", "purchased_on", "store_name", "note", "lines", "payment_method", "item_name")
LINE_FIELDS = ("id", "name", "amount", "quantity", "unit", "unit_price", "discount_amount", "category")
_MONEY = re.compile(r"[0-9]{1,12}(?:\.[0-9]{1,2})?")
_SIGNED_MONEY = re.compile(r"-?[0-9]{1,12}(?:\.[0-9]{1,2})?")
_QUANTITY = re.compile(r"[0-9]{1,9}(?:\.[0-9]{1,3})?")
_SIGNED_QUANTITY = re.compile(r"-?[0-9]{1,9}(?:\.[0-9]{1,3})?")
_PRICE = re.compile(r"[0-9]{1,10}(?:\.[0-9]{1,4})?")
_ONE = Decimal(1)
_ZERO = Decimal("0.00")


class ManualInvalid(Exception):
    """Тело не прошло проверку: ``fields`` — ``{"имя поля": "причина"}``."""

    def __init__(self, fields):
        super().__init__("manual spend invalid")
        self.fields = fields


@dataclass
class LineInput:
    """Строка траты из тела. Необязательные поля (``None``) у сохранённой строки (``id``) остаются её,
    у новой — значения по умолчанию: единица «шт», цена — сумма / количество, без скидки."""

    name: str
    amount: Decimal
    quantity: Decimal | None = _ONE
    category: int | None = None
    named: bool = True  # покупка, названная человеком, — товар каталога; False — строка «<категория>»
    id: int | None = None  # сохранённая строка этой траты: правится на месте
    unit: str | None = None
    unit_price: Decimal | None = None
    discount: Decimal | None = None


# --- разбор тела ---

def _number(value, pattern):
    """``Decimal`` > 0 из строки или числа JSON; ``None`` — неверный формат или не больше нуля."""
    number = _decimal(value, pattern)
    return number if number is not None and number > 0 else None


def _decimal(value, pattern):
    """``Decimal`` любого знака из строки или числа JSON по шаблону ``pattern``; ``None`` — неверный формат."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    text = str(value).strip().replace(",", ".") if not isinstance(value, float) else repr(value)
    if not pattern.fullmatch(text):
        return None
    return Decimal(text)


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
    if "item_name" in data:
        values["item_name"] = _text(errors, "item_name", data["item_name"], NAME_MAX, required=False) or ""
    if "payment_method" in data:
        method = data["payment_method"] or ""  # null и пусто — «не указан»
        if method not in Receipt.PaymentMethod.values:
            errors["payment_method"] = "choice"
        values["payment_method"] = method
    _check_references(errors, values, refs)
    if errors:
        raise ManualInvalid(errors)
    return values


def _parse_lines(errors, raw, refs):
    """Строки тела. Знак суммы и количества проверяет запись (``_check_lines``): минус и ноль допустимы только
    у сохранённой строки, прочитанной с таким знаком (возврат тары, бесплатная позиция чека с фото)."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        errors["lines"] = "type"
        return []
    if len(raw) > MAX_LINES:
        errors["lines"] = "size"
        return []
    lines, seen = [], set()
    for index, item in enumerate(raw):
        prefix = f"lines.{index}."
        if not isinstance(item, dict):
            errors[f"lines.{index}"] = "type"
            continue
        for key in item:
            if key not in LINE_FIELDS:
                errors[prefix + key] = "unknown_field"
        pk = _id(errors, prefix + "id", item.get("id"))
        if pk is not None:
            if pk in seen:
                errors[prefix + "id"] = "unknown"
            seen.add(pk)
        name = _text(errors, prefix + "name", item.get("name"), NAME_MAX, required=True)
        amount = _decimal(item.get("amount"), _SIGNED_MONEY)
        if amount is None:
            errors[prefix + "amount"] = "money" if "amount" in item else "required"
        quantity = _ONE if pk is None else None
        if item.get("quantity") is not None:
            quantity = _decimal(item["quantity"], _SIGNED_QUANTITY)
            if quantity is None or quantity == 0:
                errors[prefix + "quantity"] = "quantity"
        if pk is None:  # новая строка — только больше нуля; сохранённую проверяет _check_lines
            if amount is not None and amount <= 0:
                errors[prefix + "amount"] = "money"
            if quantity is not None and quantity < 0:
                errors[prefix + "quantity"] = "quantity"
        unit = item.get("unit")
        if unit is not None and unit not in Unit.values:
            errors[prefix + "unit"] = "unit"
        price = None
        if item.get("unit_price") is not None and (price := _decimal(item["unit_price"], _PRICE)) is None:
            errors[prefix + "unit_price"] = "price"
        discount = None
        if item.get("discount_amount") is not None and (discount := _decimal(item["discount_amount"], _MONEY)) is None:
            errors[prefix + "discount_amount"] = "discount"
        category = refs[prefix + "category"] = _id(errors, prefix + "category", item.get("category"))
        if name is not None and amount is not None and not any(key.startswith(prefix) for key in errors):
            lines.append(LineInput(name, amount, quantity, category, id=pk, unit=unit, unit_price=price,
                                   discount=discount))
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


def find_or_create_products(names, owner, store=None):
    """Товары названных покупок траты владельца ``owner``: ``{name_key(название): Product | None}``.

    Правило импорта чеков (``recognition.resolution.resolve_product``) для строки без кода, штрихкода,
    бренда и фасовки: написание продавца места (``ProductAlias``) → товар с тем же нормализованным
    названием (``receipts.dedup.name_key``) → новый товар в «Не разобрано». Два разных товара с таким
    названием — неоднозначно, товара нет (как у импорта). Склеенный дубль ведёт к оставляемому:
    поглощённый ожидающим слиянием товар и название товара, поглощённого подтверждённым слиянием
    (``merges``), отвечают оставляемым.

    Название — личный текст человека: ищутся только общие товары (``scope=""``) и свои личные («user:<id владельца>»,
    ``receipts.prices.product_scope``), свой личный тёзка важнее общего; товар другого человека, в том числе члена семьи,
    не находится; новый товар — личный товар владельца. Написание у места не запоминается.

    Вызывается в транзакции записи: берёт мьютекс импорта (``recognition.importer.IMPORT_LOCK``), чтобы
    не пересекаться с импортом и слияниями дублей.
    """
    from merges.models import ProductMerge, ProductMergeMember
    from receipts.prices import product_scope
    from recognition.importer import IMPORT_LOCK  # lazy: the importer imports receipts

    spelled = {}
    for name in names:
        spelled.setdefault(name_key(name), name)
    if not spelled:
        return {}
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(%s)", [IMPORT_LOCK])
    found = {key: set() for key in spelled}
    merchant_id = store.merchant_id if store is not None else None
    if merchant_id is not None:
        for key, pk in ProductAlias.objects.filter(merchant_id=merchant_id, name_key__in=list(spelled)) \
                .values_list("name_key", "product_id"):
            found[key].add(pk)
    sources = ProductMergeMember.objects.filter(role=ProductMergeMember.Role.SOURCE)
    for rows in (
        Product.objects.values_list("name", "pk"),
        # Поглощённого подтверждённым слиянием товара нет — его название ведёт к оставляемому.
        sources.filter(state=ProductMergeMember.State.ACTIVE, group__status=ProductMerge.Status.CONFIRMED)
        .values_list("name", "product_ref"),
    ):
        missing = {key for key, ids in found.items() if not ids}
        if not missing:
            break
        for name, pk in rows.iterator():
            if (key := name_key(name)) in missing:
                found[key].add(pk)
    # Поглощённый (ожидающее слияние) либо удалённый подтверждённым слиянием товар -> оставляемый.
    moved = dict(sources.filter(Q(active_product__isnull=False) | Q(group__status=ProductMerge.Status.CONFIRMED,
                                                                   state=ProductMergeMember.State.ACTIVE))
                 .values_list("product_ref", "group__target_ref"))

    def survivor(pk):
        for _ in range(len(moved) + 1):
            if pk not in moved:
                break
            pk = moved[pk]
        return pk

    ids = {key: {survivor(pk) for pk in pks} for key, pks in found.items()}
    existing = (Product.objects.filter(scope__in=["", product_scope(owner.pk)])
                .in_bulk({pk for pks in ids.values() for pk in pks}))
    result = {}
    for key, name in spelled.items():
        products = [existing[pk] for pk in ids[key] if pk in existing]
        # Свой личный тёзка важнее общего: общий товар с тем же названием (чек с фото) не ломает свою покупку.
        products = [product for product in products if product.scope] or products
        result[key] = None if len(products) > 1 else products[0] if products else _new_product(name, owner)
    return result


def _new_product(name, owner):
    """Новый личный товар владельца траты в «Не разобрано» (как у импорта), ``scope`` — «user:<id>» (``product_scope``):
    тёзка другого человека уникальности не мешает."""
    from receipts.prices import product_scope

    category, _ = Category.objects.get_or_create(parent=None, name=UNASSIGNED)
    generic, _ = GenericProduct.objects.get_or_create(
        name__iexact=UNASSIGNED, defaults={"name": UNASSIGNED, "category": category, "base_unit": BaseUnit.PCS})
    scope = product_scope(owner.pk)
    try:
        with transaction.atomic():
            return Product.objects.create(generic=generic, name=name, scope=scope)
    except IntegrityError:  # гонка за то же точное имя: в области «user:<id>» это может быть только свой товар
        return Product.objects.get(brand=None, name=name, package_quantity=None, package_unit="", scope=scope)


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


def same_wall_clock(purchased_at, purchased_on, store_before, store):
    """Момент чека с фото после правки даты либо места: то же время на часах, новая дата в поясе нового места."""
    local = purchased_at.astimezone(_zone(store_before))
    return datetime.combine(purchased_on, time(local.hour, local.minute, local.second, local.microsecond),
                            tzinfo=_zone(store))


# --- трата из выписки ---

def statement_bank(receipt):
    """Банк выписки, из которой сохранена трата (``kaspi_gold`` / ``forte``), иначе ``None``: строка выписки
    (``statements.StatementRow.receipt``) — пометка источника, по ней и правка оставляет трату «из выписки»."""
    if receipt.source != Receipt.Source.MANUAL:
        return None
    from statements.models import StatementRow

    return StatementRow.objects.filter(receipt_id=receipt.pk).values_list("statement__bank", flat=True).first()


def statement_note(note, bank):
    """Комментарий траты из выписки: текст человека и пометка « · Выписка …» в конце (как ``note_for``)."""
    from statements.drafts import SOURCE_NOTE

    body = STATEMENT_MARK.sub("", note or "").strip()
    mark = SOURCE_NOTE.get(bank, "Выписка")
    return f"{body} · {mark}" if body else f"· {mark}"


# --- запись ---

def _rows(lines, total, category, names, item_name=""):
    """Строки траты: позиции человека (без своей категории — категория траты) либо одна строка на всю сумму —
    «Что купили» или «<категория>»."""
    if not lines:
        if item_name:
            return [LineInput(item_name, total, _ONE, category)]
        return [LineInput(names[category], total, _ONE, category, named=False)]
    for line in lines:
        line.category = line.category or category
    service_charges.retarget(lines)
    return lines


def _check_lines(errors, rows, current):
    """Дополняет строки значениями по умолчанию и проверяет знак, цену и скидку.

    ``rows`` — строки по порядку тела, ``current`` — сохранённые строки траты по ``id``. Новая строка — с суммой
    и количеством больше нуля (это проверяет ``parse``); сохранённая может сохранить ноль либо минус, с которыми
    она прочитана (возврат тары, бесплатная позиция), знаки суммы и количества совпадают. Цена за единицу:
    переданная обязана дать сумму (``количество × цена``, допуск — копейка и округление цены), без неё — прежняя,
    если сумма и количество строки те же, иначе ``сумма / количество``. Скидка — от нуля до суммы строки.
    """
    for index, row in enumerate(rows):
        prefix = f"lines.{index}."
        saved = None
        if row.id is not None:
            saved = current.get(row.id)
            if saved is None:
                errors[prefix + "id"] = "unknown"
                continue
        if row.quantity is None:
            row.quantity = saved.quantity
        if row.unit is None:
            row.unit = saved.unit if saved is not None else Unit.PCS
        if row.discount is None:
            row.discount = saved.discount_amount if saved is not None else _ZERO
        signed = saved is not None and saved.amount <= 0
        returned = saved is not None and saved.kind == ReceiptLine.Kind.DEPOSIT_RETURN
        if row.amount <= 0 and not signed or returned and row.amount > 0:
            errors[prefix + "amount"] = "money"
        if row.amount > 0 > row.quantity or row.amount < 0 < row.quantity:
            errors[prefix + "quantity"] = "quantity"
        with price_context():
            if row.unit_price is None:
                if saved is not None and (row.amount, row.quantity) == (saved.amount, saved.quantity):
                    row.unit_price = saved.unit_price
                else:
                    row.unit_price = round_decimal(row.amount / row.quantity, 4)
                if row.unit_price >= 10 ** 10:
                    errors[prefix + "unit_price"] = "price"
            elif abs(row.quantity * row.unit_price - row.amount) > PRICE_TOLERANCE + abs(row.quantity) * PRICE_STEP:
                errors[prefix + "unit_price"] = "price_mismatch"
        if row.discount > abs(row.amount):
            errors[prefix + "discount_amount"] = "discount"


def _paid(rows):
    """Сумма строк за вычетом их скидок."""
    with price_context():
        return sum((row.amount - row.discount for row in rows), _ZERO)


def _apply_lines(receipt, rows, current):
    """Строки траты по ``rows``: строка с ``id`` правится на месте, без — создаётся, не названная в теле —
    удаляется. Возвращает ``True``, если поменялись деньги строк (состав, сумма либо скидка).

    Товарная связь сохранённой строки остаётся, пока её название то же (``name_key``); новая и переименованная
    названная строка связывается с товаром по правилу трат (``find_or_create_products``), строка «<категория>» —
    без товара. Скидка строки — одна строка ``ReceiptDiscount`` на её сумму; не менялась — прежние строки скидок
    остаются. Поменялись деньги строки со ставкой налога — налог строки считается заново.
    """
    by_id = {line.pk: line for line in current}
    kept = {row.id for row in rows if row.id is not None}
    renamed = [row.name for row in rows if row.named
               and (row.id is None or name_key(row.name) != name_key(by_id[row.id].raw_name))]
    products = find_or_create_products(renamed, receipt.owner, receipt.store) if renamed else {}
    removed = {pk for pk in by_id if pk not in kept}
    changed = bool(removed) or len(kept) != len(rows)
    if removed:
        # Залог удалённой строки остаётся строкой без родителя: каскад его не заберёт.
        ReceiptLine.objects.filter(pk__in=kept, parent_id__in=removed).update(parent=None)
        ReceiptLine.objects.filter(pk__in=removed).delete()
    if kept:
        ReceiptLine.objects.filter(pk__in=kept).update(position=F("position") + POSITION_SHIFT)
    next_discount = (receipt.discounts.aggregate(top=Max("position"))["top"] or 0) + 1
    with price_context():
        for position, row in enumerate(rows, start=1):
            fresh = row.id is None
            line = ReceiptLine(receipt=receipt, kind=ReceiptLine.Kind.PRODUCT) if fresh else by_id[row.id]
            before = None if fresh else (line.amount, line.discount_amount)
            if line.parent_id in removed:
                line.parent = None
            if fresh or name_key(row.name) != name_key(line.raw_name):
                line.product = products.get(name_key(row.name)) if row.named else None
                line.name_i18n = {}
            line.raw_name = row.name
            line.position = position
            line.quantity, line.unit, line.unit_price = row.quantity, row.unit, row.unit_price
            line.amount, line.discount_amount, line.category_id = row.amount, row.discount, row.category
            if not fresh and before != (line.amount, line.discount_amount):
                changed = True
                if line.tax_amount is not None:
                    line.tax_amount = _line_tax(line, receipt.prices_include_tax)
            line.save()
            if fresh or before[1] != line.discount_amount:
                if not fresh:
                    line.discounts.all().delete()
                if line.discount_amount:
                    ReceiptDiscount.objects.create(receipt=receipt, line=line, position=next_discount,
                                                   name=DISCOUNT_NAME, amount=line.discount_amount)
                    next_discount += 1
    return changed


def _line_tax(line, include):
    """Налог строки по её ставке: из оплаченной суммы (цены с налогом) либо сверху (цены без налога)."""
    if line.tax_rate_id is None:
        return None
    rate = line.tax_rate.rate
    if rate is None:  # без НДС
        return _ZERO
    with price_context():
        paid = line.amount - line.discount_amount
        return round_decimal(paid * rate / (100 + rate) if include else paid * rate / 100, 2)


def _recount(receipt):
    """Скидки, итоги по ставкам и итог траты из её строк — после правки денег строк.

    Итог — сумма строк за вычетом их скидок и скидок на весь чек; у чека с ценами без налога — плюс налог.
    """
    lines = list(receipt.lines.select_related("tax_rate"))
    with price_context():
        whole = receipt.discounts.filter(line__isnull=True).aggregate(total=Sum("amount"))["total"] or _ZERO
        paid = sum((line.amount - line.discount_amount for line in lines), _ZERO) - whole
        receipt.discount_total = sum((line.discount_amount for line in lines), _ZERO) + whole
        taxes = list(receipt.taxes.select_related("tax_rate").order_by("pk"))
        if taxes:
            taxes = _retax(receipt, lines, taxes, paid, whole)
        receipt.total = paid if receipt.prices_include_tax else paid + sum((tax.tax for tax in taxes), _ZERO)


def _retax(receipt, lines, taxes, paid, whole):
    """Итоги по ставкам (``ReceiptTax``) заново из оплаченной суммы ``paid`` (за вычетом скидок на чек ``whole``);
    возвращает оставшиеся итоги.

    Одна ставка — вся сумма. Несколько — по ставкам строк, если ставка есть у каждой оплачиваемой строки, все
    они среди итогов и скидок на весь чек нет (итог ставки без строк удаляется); иначе прежние доли итогов,
    остаток округления — последнему. Налог итога — по ставке (цены с налогом — изнутри, без — сверху).
    """
    include = receipt.prices_include_tax
    rated = {tax.tax_rate_id for tax in taxes}
    paying = [line for line in lines if line.amount - line.discount_amount]
    if len(taxes) == 1:
        bases = {taxes[0].tax_rate_id: paid}
    elif not whole and all(line.tax_rate_id in rated for line in paying):
        bases = dict.fromkeys(rated, _ZERO)
        for line in paying:
            bases[line.tax_rate_id] += line.amount - line.discount_amount
    else:
        old = [tax.gross if include else tax.net for tax in taxes]
        weight = sum(old, _ZERO)
        if not weight:
            return taxes
        bases, left = {}, paid
        for tax, share in zip(taxes[:-1], old[:-1]):
            bases[tax.tax_rate_id] = round_decimal(paid * share / weight, 2)
            left -= bases[tax.tax_rate_id]
        bases[taxes[-1].tax_rate_id] = left
    kept = []
    for tax in taxes:
        base = bases.get(tax.tax_rate_id, _ZERO)
        if not base and len(taxes) > 1:
            tax.delete()
            continue
        rate = tax.tax_rate.rate or _ZERO
        if include:
            tax.gross, tax.tax = base, round_decimal(base * rate / (100 + rate), 2)
            tax.net = base - tax.tax
        else:
            tax.net, tax.tax = base, round_decimal(base * rate / 100, 2)
            tax.gross = base + tax.tax
        tax.save()
        kept.append(tax)
    return kept


def _category_names(*ids):
    ids = [pk for pk in ids if pk is not None]
    return dict(Category.objects.filter(pk__in=ids).values_list("pk", "name"))


def _save(receipt):
    """Сохраняет шапку траты; копия другого своего чека с фото (три правила дедупликации) — ``receipt: duplicate``."""
    try:
        with transaction.atomic():
            receipt.save()
    except IntegrityError as error:
        if any(name in str(error) for name in DEDUP_CONSTRAINTS):
            raise ManualInvalid({"receipt": "duplicate"}) from None
        raise


def create(owner, data):
    """Новая ручная трата владельца ``owner`` по телу ``data``; ``ManualInvalid`` — тело не подошло."""
    values = parse(data)
    errors = {}
    lines = values.get("lines") or []
    category = values.get("category")
    total = values.get("total")
    item_name = values.get("item_name", "")
    if lines:
        if item_name:
            errors["item_name"] = "item_itemized"
        rows = _rows(lines, total, category, {}, item_name)
        _check_lines(errors, rows, {})
        if not errors:
            computed = _paid(rows)
            if total is not None and total != computed:
                errors["total"] = "mismatch"
            total = computed
    else:
        if total is None:
            errors["total"] = "required"
        if category is None:
            errors["category"] = "required"
    if errors:
        raise ManualInvalid(errors)
    if not lines:
        rows = _rows([], total, category, _category_names(category), item_name)
        _check_lines(errors, rows, {})
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
            payment_method=values.get("payment_method", ""),
        )
        _apply_lines(receipt, rows, [])
        _recount(receipt)
        receipt.save(update_fields=["total", "discount_total"])
    return receipt


def update(receipt_id, data):
    """Правка любой траты — с фото, ручной, из выписки: переданные поля меняются, остальные остаются.

    ``lines`` в теле — все строки траты по порядку: с ``id`` правится сохранённая строка, без — новая, не
    названная — удаляется (пустой список — трата без позиций на ``total`` в ``category``, названная ``item_name``;
    без него — «<категория>»). Без ``lines``: у траты из одной строки ``total``, ``category`` и ``item_name``
    меняют её (пустой ``item_name`` — снова «<категория>» без товара); у траты с позициями ``total`` должен
    совпасть с их суммой, а ``category`` и ``item_name`` — отказ ``itemized``.

    Чек с фото: место обязательно, правка даты либо места сохраняет время на часах. Трата из выписки: способ
    оплаты — банк выписки, комментарий кончается « · Выписка …». Копия другого своего чека — ``receipt: duplicate``.
    """
    values = parse(data)
    with transaction.atomic():
        receipt = Receipt.objects.select_for_update(of=("self",)).select_related("store").get(pk=receipt_id)
        current = list(receipt.lines.select_related("tax_rate").order_by("position", "pk"))
        by_id = {line.pk: line for line in current}
        photo = receipt.source == Receipt.Source.PHOTO
        bank = statement_bank(receipt)
        errors = {}
        category = values.get("category")
        total = values.get("total")
        item_name = values.get("item_name", "")
        rows = None
        if "lines" in values:
            lines = values["lines"]
            if lines:
                if item_name:
                    errors["item_name"] = "item_itemized"
            else:
                single = current[0].category_id if len(current) == 1 else None
                category = category if category is not None else single
                total = total if total is not None else receipt.total
                if category is None:
                    errors["category"] = "required"
            if not errors:
                rows = _rows(lines, total, category, _category_names(category), item_name)
        elif "total" in values or "category" in values or "item_name" in values:
            if "total" in values and total is None:
                errors["total"] = "required"
            elif len(current) == 1:
                line = current[0]
                amount = line.amount if total is None else total + line.discount_amount
                new_category = category if category is not None else line.category_id
                names = _category_names(line.category_id, new_category)
                # Строка «<категория>» следует за категорией; названная покупка остаётся собой.
                named = line.product_id is not None or line.category_id is None or names[line.category_id] != line.raw_name
                name = line.raw_name if named else names[new_category]
                if "item_name" in values and not item_name and new_category is None:
                    errors["category"] = "required"
                elif "item_name" in values:
                    named, name = bool(item_name), item_name or names[new_category]
                rows = [LineInput(name, amount, None, new_category, named, id=line.pk)]
            else:
                if "category" in values:
                    errors["category"] = "itemized"
                if item_name:
                    errors["item_name"] = "item_itemized"
        if rows is not None:
            _check_lines(errors, rows, by_id)
        if photo and "store_name" in values and not values["store_name"]:
            errors["store_name"] = "required"
        if bank and values.get("payment_method") not in (None, "", bank):
            errors["payment_method"] = "statement"
        if errors:
            raise ManualInvalid(errors)
        store_before, date_before = receipt.store, receipt.purchased_on
        if "currency" in values:
            receipt.currency_id = values["currency"]
        if "store_name" in values:
            name = values["store_name"]
            receipt.store = find_or_create_store(name, receipt.currency_id) if name else None
        if "note" in values:
            receipt.note = statement_note(values["note"], bank) if bank else values["note"]
        if "payment_method" in values:
            receipt.payment_method = values["payment_method"]
        if bank:
            receipt.payment_method = bank
        if "purchased_on" in values:
            receipt.purchased_on = values["purchased_on"]
        if photo and (receipt.purchased_on != date_before or receipt.store_id != getattr(store_before, "pk", None)):
            receipt.purchased_at = same_wall_clock(receipt.purchased_at, receipt.purchased_on, store_before, receipt.store)
        elif not photo and receipt.purchased_on != date_before:
            receipt.purchased_at = purchase_moment(receipt.purchased_on, receipt.store)
        if "lines" in values and not values["lines"]:
            # Одной суммой: итог — эта сумма, скидок на весь чек больше нет.
            receipt.discounts.filter(line__isnull=True).delete()
        if rows is not None and _apply_lines(receipt, rows, current):
            _recount(receipt)
        if total is not None and receipt.total != total:
            raise ManualInvalid({"total": "mismatch"})
        _save(receipt)
    return receipt


def delete(receipt_id):
    with transaction.atomic():
        Receipt.objects.select_for_update().filter(pk=receipt_id).delete()
