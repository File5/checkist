"""Трата без чека: ``Receipt(source=manual)`` — создание, правка и удаление.

Трата — обычный чек, чтобы списки и статистика оставались одной выборкой. Без
позиций это одна строка на всю сумму: названная покупкой («Что купили», ``item_name``)
либо, без названия, «<категория>»; с позициями — строки с названиями человека.

Названная покупка — товар каталога (2026-10-13): строка «Что купили» и каждая позиция
связываются с товаром по правилу импорта чеков (``find_or_create_products``), новый товар
попадает в «Не разобрано». Строка «<категория>» (выписки, регулярные платежи, трата без
названия) товаром не становится. Категорию строки хранит ``ReceiptLine.category``: она
важнее категории товара, поэтому статистика по категориям от товара не зависит.

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

from django.db import IntegrityError, connection, transaction
from django.db.models import Count, F, Q
from django.utils import timezone

from catalog.models import Category, GenericProduct, Product
from catalog.units import BaseUnit
from receipts.decimal_math import price_context, round_decimal
from receipts.dedup import name_key
from receipts.models import ProductAlias, Receipt, ReceiptLine
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
UNASSIGNED = "Не разобрано"  # как у импорта (recognition.resolution.resolve_product)

FIELDS = ("total", "currency", "category", "purchased_on", "store_name", "note", "lines", "payment_method", "item_name")
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
    named: bool = True  # покупка, названная человеком, — товар каталога; False — строка «<категория>»


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


# --- запись ---

def _rows(lines, total, category, names, item_name=""):
    """Строки траты: позиции человека либо одна строка на всю сумму — «Что купили» или «<категория>»."""
    if not lines:
        if item_name:
            return [LineInput(item_name, total, _ONE, category)]
        return [LineInput(names[category], total, _ONE, category, named=False)]
    return [LineInput(line.name, line.amount, line.quantity, line.category or category) for line in lines]


def _write_lines(receipt, rows):
    """Строки заново; названные — с товаром каталога (``find_or_create_products``)."""
    receipt.lines.all().delete()
    products = find_or_create_products([row.name for row in rows if row.named], receipt.owner, receipt.store)
    with price_context():
        ReceiptLine.objects.bulk_create([
            ReceiptLine(
                receipt=receipt, position=position, kind=ReceiptLine.Kind.PRODUCT, raw_name=row.name,
                quantity=row.quantity, unit_price=round_decimal(row.amount / row.quantity, 4),
                amount=row.amount, category_id=row.category,
                product=products.get(name_key(row.name)) if row.named else None,
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
    item_name = values.get("item_name", "")
    if lines:
        total = _total(errors, lines, total)
        if item_name:
            errors["item_name"] = "item_itemized"
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
            payment_method=values.get("payment_method", ""),
        )
        _write_lines(receipt, _rows(lines, total, category, _category_names(category), item_name))
    return receipt


def update(receipt_id, data):
    """Правка ручной траты: переданные поля меняются, остальные остаются.

    ``lines`` в теле заменяет все строки (пустой список — трата без позиций на ``total``
    в ``category``, названная ``item_name``; без него — «<категория>»). Без ``lines``: у траты
    из одной строки ``total``, ``category`` и ``item_name`` меняют её (пустой ``item_name`` —
    снова «<категория>» без товара); у траты с позициями ``total`` должен совпасть с их суммой,
    а ``category`` и ``item_name`` — отказ ``itemized``. Названная строка заново связывается
    с товаром по своему названию; прежний товар остаётся в каталоге.
    """
    values = parse(data)
    with transaction.atomic():
        receipt = Receipt.objects.select_for_update().get(pk=receipt_id)
        current = list(receipt.lines.order_by("position", "pk"))
        errors = {}
        category = values.get("category")
        total = values.get("total")
        item_name = values.get("item_name", "")
        rows = None
        if "lines" in values:
            lines = values["lines"]
            if lines:
                total = _total(errors, lines, total)
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
                total = total if total is not None else line.amount
                new_category = category if category is not None else line.category_id
                names = _category_names(line.category_id, new_category)
                # Строка «<категория>» следует за категорией; названная покупка остаётся собой.
                named = line.product_id is not None or line.category_id is None or names[line.category_id] != line.raw_name
                name = line.raw_name if named else names[new_category]
                if "item_name" in values and not item_name and new_category is None:
                    errors["category"] = "required"
                elif "item_name" in values:
                    named, name = bool(item_name), item_name or names[new_category]
                rows = [LineInput(name, total, line.quantity, new_category, named)]
            else:
                if "category" in values:
                    errors["category"] = "itemized"
                if item_name:
                    errors["item_name"] = "item_itemized"
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
        if "payment_method" in values:
            receipt.payment_method = values["payment_method"]
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
