"""Выгрузка данных семьи одним документом JSON: ``GET /api/export/``.

Видимость — ``owner_q``: чеки пользователя запроса и его семьи, лимиты — ``limits_q``.
Фильтры необязательны и складываются (И). Число запросов к БД не зависит от числа
чеков: чеки, строки, товары строк, фото, магазины, лимиты и сводка читаются каждый
одним-тремя запросами. Чеков больше ``MAX_RECEIPTS`` — ``400 export_too_large``.

Деньги — строки с двумя знаками без округления сверх хранимого (``"12.30"``), цена
за единицу — четыре знака, количество — три. Валюты нигде не складываются.

**Выписки.** Отдельного признака у траты нет: трата из банковской выписки — это
ручная трата (``source = manual``), комментарий которой кончается частью
«· Выписка …» (``STATEMENT_NOTE_REGEX``: после последней «·» стоит слово «Выписка»).
Так их подписывает импорт выписок. В выгрузке у такой траты ``source = "statement"``,
у прочих ручных — ``"manual"``, у чеков с фото — ``"photo"``.

**Категория строки** — категория обобщённого продукта её товара (поглощённый
слиянием товар заменён оставляемым, как в статистике), у строки без товара —
собственная ``ReceiptLine.category``, иначе ``null``.

**Доходы** (2026-10-13, раздел ``incomes``) — записи, видимые запросу (``incomes.access.visible_q``:
свои, а главному — всей семьи); из фильтров к ним относятся только период, валюта и человек.
"""
import re
from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from django.db.models import BooleanField, Count, Exists, ExpressionWrapper, OuterRef, Q, Sum
from django.db.models.functions import TruncMonth
from django.utils import timezone

from accounts.access import visible_receipts_q
from accounts.people import display_name
from budget.access import limits_q
from budget.models import BudgetLimit
from catalog.models import Product
from config.exceptions import ApiError
from incomes.access import visible_q as visible_incomes_q
from incomes.models import Income
from receipts import spending
from receipts.decimal_math import price_context
from receipts.models import Receipt, ReceiptLine
from recognition.models import ReceiptImage
from recognition.previews import variant_url
from stores.models import Store

from . import common
from .params import Params
from .recognition_serialization import download_url
from .stats_common import owner_product_id

FORMAT = "checkist-export"
VERSION = 1
MAX_RECEIPTS = 20_000
MAX_VALUES = 50
SECTIONS = ("receipts", "lines", "categories", "stores", "limits", "summary", "media", "incomes")
DEFAULT_SECTIONS = ("receipts", "lines", "categories", "stores", "limits", "summary", "incomes")
# Разделы внутри чека: без ``receipts`` им негде стоять.
NESTED_SECTIONS = ("lines", "media")
SOURCES = ("photo", "manual", "statement")
# Последняя часть комментария, отделённая «·», начинается словом «Выписка».
STATEMENT_NOTE_REGEX = r"·\s*Выписка[^·]*$"
PATH_SEPARATOR = " / "
NO_CATEGORY = "Без категории"

_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f\ud800-\udfff]")
_INTEGER = re.compile(r"[0-9]{1,18}")
_MONEY = re.compile(r"-?[0-9]{1,12}(?:[.,][0-9]{1,2})?")
_ZERO = Decimal("0.00")


class ExportTooLarge(ApiError):
    code = "export_too_large"
    message = f"Больше {MAX_RECEIPTS} чеков: сузьте период или добавьте фильтры."

    def __init__(self):
        super().__init__()
        self.extra = {"max_receipts": MAX_RECEIPTS}


@dataclass(frozen=True)
class Filters:
    date_from: date | None = None
    date_to: date | None = None
    categories: tuple = ()  # как прислано
    category_ids: frozenset = frozenset()  # с потомками
    sources: tuple = ()
    owners: tuple = ()
    stores: tuple = ()
    currency: str | None = None
    q: str | None = None
    min_total: Decimal | None = None
    max_total: Decimal | None = None
    include: tuple = DEFAULT_SECTIONS

    def as_json(self):
        return {
            "from": common.iso_date(self.date_from), "to": common.iso_date(self.date_to),
            "category": list(self.categories), "source": list(self.sources), "owner": list(self.owners),
            "store": list(self.stores), "currency": self.currency, "q": self.q,
            "min_total": common.amount(self.min_total), "max_total": common.amount(self.max_total),
            "include": list(self.include),
        }


def _many(params, name):
    """Значения повторяемого параметра: ``?x=1&x=2`` и ``?x=1,2``; без повторов, порядок сохранён."""
    values = []
    for raw in params.query.getlist(name):
        if _CONTROL.search(raw):
            params.error(name, "Управляющие символы недопустимы.")
            return []
        values.extend(part.strip() for part in raw.split(","))
    values = list(dict.fromkeys(value for value in values if value))
    if len(values) > MAX_VALUES:
        params.error(name, f"Не больше {MAX_VALUES} значений.")
        return []
    return values


def _ids(params, name):
    values = _many(params, name)
    if not all(_INTEGER.fullmatch(value) and int(value) > 0 for value in values):
        params.error(name, "Ожидаются целые положительные числа.")
        return []
    return [int(value) for value in values]


def _money(params, name):
    value = params.raw(name)
    if value is None:
        return None
    if not _MONEY.fullmatch(value):
        params.error(name, "Ожидается сумма: число, не больше двух знаков после запятой.")
        return None
    return Decimal(value.replace(",", "."))


def read_filters(request, tree, family):
    """Фильтры запроса либо ``400 invalid_parameter`` со всеми ошибками; ``download`` — вторым значением.

    ``tree`` — ``CategoryTree``, ``family`` — логины видимых людей.
    """
    params = Params(request.query_params)
    date_from, date_to = params.date_range("from", "to")
    categories = _ids(params, "category")
    if any(pk not in tree for pk in categories):
        params.error("category", "Категория не найдена.")
        categories = []
    sources = _many(params, "source")
    if any(value not in SOURCES for value in sources):
        params.error("source", f"Допустимые значения: {', '.join(SOURCES)}.")
        sources = []
    owners = _many(params, "owner")
    if any(value not in family for value in owners):
        params.error("owner", "Такого человека нет в семье.")
        owners = []
    stores = _ids(params, "store")
    if stores and Store.objects.filter(pk__in=stores).count() != len(stores):
        params.error("store", "Магазин не найден.")
        stores = []
    currency = params.currency()
    search = params.search("q")
    min_total, max_total = _money(params, "min_total"), _money(params, "max_total")
    if min_total is not None and max_total is not None and min_total > max_total:
        params.error("min_total", "Должна быть не больше max_total.")
    include = _many(params, "include")
    if any(value not in SECTIONS for value in include):
        params.error("include", f"Допустимые значения: {', '.join(SECTIONS)}.")
    elif include and "receipts" not in include and any(value in NESTED_SECTIONS for value in include):
        params.error("include", "Строки и ссылки на фото выгружаются внутри чеков: добавьте receipts.")
    download = params.boolean("download", default=False)
    params.check()
    expanded = frozenset(node for pk in categories for node in tree.descendant_ids(pk))
    return Filters(
        date_from=date_from, date_to=date_to, categories=tuple(categories), category_ids=expanded,
        sources=tuple(sources), owners=tuple(owners), stores=tuple(stores), currency=currency, q=search,
        min_total=min_total, max_total=max_total,
        include=tuple(value for value in SECTIONS if value in include) if include else DEFAULT_SECTIONS,
    ), download


# --- выбор чеков ---

def _statement_q(prefix=""):
    return Q(**{f"{prefix}source": Receipt.Source.MANUAL, f"{prefix}note__regex": STATEMENT_NOTE_REGEX})


def _source_q(source):
    if source == "photo":
        return Q(source=Receipt.Source.PHOTO)
    if source == "statement":
        return _statement_q()
    return Q(source=Receipt.Source.MANUAL) & ~Q(note__regex=STATEMENT_NOTE_REGEX)


def _category_lines(category_ids):
    """Строки, чья категория (товара либо своя) в ``category_ids``."""
    in_products = Product.objects.filter(generic__category_id__in=category_ids).values("pk")
    return (ReceiptLine.objects.annotate(owner_pid=owner_product_id())
            .filter(Q(owner_pid__in=in_products) | Q(product__isnull=True, category_id__in=category_ids)))


def receipts_queryset(request, filters):
    """Чеки семьи по фильтрам, без порядка и полей выгрузки."""
    receipts = Receipt.objects.filter(visible_receipts_q(request))
    for field, value in (("purchased_on__gte", filters.date_from), ("purchased_on__lte", filters.date_to),
                         ("currency_id", filters.currency), ("total__gte", filters.min_total),
                         ("total__lte", filters.max_total)):
        if value is not None:
            receipts = receipts.filter(**{field: value})
    if filters.owners:
        receipts = receipts.filter(owner__username__in=filters.owners)
    if filters.stores:
        receipts = receipts.filter(store_id__in=filters.stores)
    if filters.sources:
        condition = Q()
        for source in filters.sources:
            condition |= _source_q(source)
        receipts = receipts.filter(condition)
    if filters.category_ids:
        receipts = receipts.filter(Exists(_category_lines(filters.category_ids).filter(receipt_id=OuterRef("pk"))))
    if filters.q:
        matching_line = ReceiptLine.objects.filter(receipt_id=OuterRef("pk")).filter(
            Q(raw_name__icontains=filters.q) | Q(product__name__icontains=filters.q))
        receipts = receipts.filter(Q(store__merchant__brand_name__icontains=filters.q)
                                   | Q(store__name__icontains=filters.q) | Q(note__icontains=filters.q)
                                   | Q(Exists(matching_line)))
    return receipts


# --- части документа ---

def _path(tree, pk):
    return None if pk is None or pk not in tree else PATH_SEPARATOR.join(node["name"] for node in tree.path(pk))


def _products(ids):
    """``{id: (name, category_id)}`` товаров строк; один запрос."""
    return {pk: (name, category_id) for pk, name, category_id in Product.objects.filter(pk__in=ids)
            .values_list("pk", "name", "generic__category_id")}


def _lines(selected, tree):
    """``{receipt_id: [строка, ...]}`` по позиции; два запроса."""
    rows = list(ReceiptLine.objects.filter(receipt__in=selected.values("pk")).annotate(owner_pid=owner_product_id())
                .order_by("receipt_id", "position", "id")
                .values_list("receipt_id", "position", "kind", "raw_name", "quantity", "unit", "unit_price",
                             "amount", "discount_amount", "owner_pid", "category_id"))
    products = _products({row[9] for row in rows if row[9] is not None})
    found = {}
    for receipt_id, position, kind, name, quantity, unit, unit_price, amount, discount, pid, own_category in rows:
        product = products.get(pid)
        category_id = product[1] if product else own_category
        with price_context():
            paid = amount - discount
        found.setdefault(receipt_id, []).append({
            "position": position, "kind": kind, "name": name,
            "quantity": common.quantity(quantity), "unit": unit, "unit_price": common.price(unit_price),
            "amount": common.amount(amount), "discount_amount": common.amount(discount), "paid_amount": common.amount(paid),
            "category_id": category_id, "category_path": _path(tree, category_id),
            "product_id": pid if product else None, "product_name": product[0] if product else None,
        })
    return found


def _media(request, selected):
    """``{receipt_id: {"display_url", "download_url"}}`` по последней вырезке чека; один запрос."""
    found = {}
    images = (ReceiptImage.objects.filter(receipt__in=selected.values("pk")).select_related("photo")
              .order_by("receipt_id", "-created_at", "-id"))
    for image in images:
        if image.receipt_id in found:
            continue
        display, download = variant_url(image.file.name, "display"), download_url(image.photo)
        found[image.receipt_id] = {
            "display_url": request.build_absolute_uri(display) if display else None,
            "download_url": request.build_absolute_uri(download) if download else None,
        }
    return found


def _receipts(request, selected, filters, tree):
    rows = list(selected.select_related("owner", "store__merchant")
                .annotate(is_statement=ExpressionWrapper(_statement_q(), output_field=BooleanField()))
                .order_by("purchased_at", "id")[:MAX_RECEIPTS + 1])
    if len(rows) > MAX_RECEIPTS:
        raise ExportTooLarge()
    lines = _lines(selected, tree)
    media = _media(request, selected) if "media" in filters.include else None
    result = []
    for receipt in rows:
        own = lines.get(receipt.pk, [])
        item = {
            "id": receipt.pk,
            "source": "statement" if receipt.is_statement else receipt.source,
            "operation": receipt.operation,
            "purchased_on": common.iso_date(receipt.purchased_on), "purchased_at": common.utc_datetime(receipt.purchased_at),
            "store_id": receipt.store_id,
            "store_name": None if receipt.store_id is None else common.store_name(receipt.store),
            "currency": receipt.currency_id, "total": common.amount(receipt.total),
            "discount_total": common.amount(receipt.discount_total), "note": receipt.note,
            "payment_method": receipt.payment_method,
            "owner": receipt.owner.get_username(), "owner_name": display_name(receipt.owner),
            "created_at": common.utc_datetime(receipt.created_at),
            "categories": sorted({line["category_path"] for line in own if line["category_path"]}),
        }
        if "lines" in filters.include:
            item["lines"] = own
        if media is not None:
            item["media"] = media.get(receipt.pk)
        result.append(item)
    return result


def _categories(tree):
    return [{"id": pk, "name": tree.name(pk), "parent_id": tree.parent_id(pk), "path": _path(tree, pk)}
            for pk in tree.ordered_ids()]


def _stores(store_ids):
    stores = Store.objects.filter(pk__in=store_ids).select_related("merchant").order_by("pk")
    return [{"id": store.pk, "name": common.store_name(store), "address": store.address_raw,
             "city": store.city, "country": store.country_id} for store in stores]


def _limits(request, filters, tree):
    limits = BudgetLimit.objects.filter(limits_q(request)).order_by("category_id", "currency_id")
    if filters.currency:
        limits = limits.filter(currency_id=filters.currency)
    if filters.category_ids:
        limits = limits.filter(category_id__in=filters.category_ids)
    return [{"category_id": limit.category_id, "category_path": _path(tree, limit.category_id),
             "currency": limit.currency_id, "amount": common.amount(limit.amount)} for limit in limits]


def _incomes(request, filters):
    """Доходы, видимые запросу, по периоду, валюте и людям фильтров; один запрос."""
    incomes = Income.objects.filter(visible_incomes_q(request)).select_related("category", "owner")
    for field, value in (("received_on__gte", filters.date_from), ("received_on__lte", filters.date_to),
                         ("currency_id", filters.currency)):
        if value is not None:
            incomes = incomes.filter(**{field: value})
    if filters.owners:
        incomes = incomes.filter(owner__username__in=filters.owners)
    return [{"id": income.pk, "received_on": common.iso_date(income.received_on), "currency": income.currency_id,
             "amount": common.amount(income.amount), "category": income.category.name, "note": income.note,
             "owner": income.owner.get_username(), "owner_name": display_name(income.owner)}
            for income in incomes.order_by("received_on", "pk")]


def _summary(selected, filters, tree):
    """Итоги по валютам: чеки, строки, сумма, верхние категории строк и месяцы; пять запросов.

    Строки собирает ``receipts.spending.collect`` (тот же расчёт, что у статистики): значение
    строки — ``amount − discount_amount``. ``category_total`` — сумма строк выбранных
    категорий (с потомками), только с фильтром ``category``.
    """
    data = spending.collect(selected, owner_product_id())
    blocks = {}

    def block(currency):
        return blocks.setdefault(currency, {
            "currency": currency, "receipts_count": 0, "lines_count": 0, "total": _ZERO,
            "category_total": _ZERO if filters.category_ids else None, "categories": {}, "months": [],
        })

    with price_context():
        for row in data.receipts:
            entry = block(row.currency)
            entry["receipts_count"] += row.count
            entry["total"] += row.total
        for row in data.lines:
            entry = block(row.currency)
            entry["lines_count"] += row.lines
            product = data.products.get(row.product_id)
            category_id = product.category_id if product is not None else row.category_id
            root = tree.path_ids(category_id)[0] if category_id is not None and category_id in tree else None
            bucket = entry["categories"].setdefault(root, [_ZERO, 0])
            bucket[0] += row.paid
            bucket[1] += row.lines
            if filters.category_ids and category_id in filters.category_ids:
                entry["category_total"] += row.paid
    months = (selected.annotate(month=TruncMonth("purchased_on")).order_by().values("currency_id", "month")
              .annotate(count=Count("pk"), total_sum=Sum("total")).order_by("currency_id", "month"))
    for row in months:
        block(row["currency_id"])["months"].append({
            "month": row["month"].strftime("%Y-%m"), "receipts_count": row["count"], "total": common.amount(row["total_sum"]),
        })

    def category_items(categories):
        named = [(root, amount, lines) for root, (amount, lines) in categories.items()]
        named.sort(key=lambda item: (item[0] is None, -item[1], tree.name(item[0]) if item[0] is not None else "", item[0] or 0))
        return [{"category_id": root, "name": tree.name(root) if root is not None else NO_CATEGORY,
                 "amount": common.amount(amount), "lines_count": lines} for root, amount, lines in named]

    currencies = [{
        "currency": entry["currency"], "receipts_count": entry["receipts_count"], "lines_count": entry["lines_count"],
        "total": common.amount(entry["total"]), "category_total": common.amount(entry["category_total"]),
        "by_category": category_items(entry["categories"]), "by_month": entry["months"],
    } for _, entry in sorted(blocks.items())]
    return {
        "receipts_count": sum(entry["receipts_count"] for entry in currencies),
        "lines_count": sum(entry["lines_count"] for entry in currencies),
        "max_receipts": MAX_RECEIPTS,
        "currencies": currencies,
    }


def build(request, filters, tree, family_people):
    """Документ выгрузки; ``ExportTooLarge`` — чеков больше ``MAX_RECEIPTS``."""
    selected = receipts_queryset(request, filters)
    document = {
        "format": FORMAT, "version": VERSION, "exported_at": common.utc_datetime(timezone.now()),
        "filters": filters.as_json(), "people": family_people,
    }
    include = filters.include
    receipts = _receipts(request, selected, filters, tree) if "receipts" in include else None
    if "categories" in include:
        document["categories"] = _categories(tree)
    if "stores" in include:
        if receipts is not None:
            store_ids = {item["store_id"] for item in receipts if item["store_id"] is not None}
        else:
            store_ids = selected.filter(store_id__isnull=False).values("store_id")
        document["stores"] = _stores(store_ids)
    if receipts is not None:
        document["receipts"] = receipts
    if "limits" in include:
        document["limits"] = _limits(request, filters, tree)
    if "summary" in include:
        document["summary"] = _summary(selected, filters, tree)
    if "incomes" in include:
        document["incomes"] = _incomes(request, filters)
    return document


def filename(filters, today):
    """``checkist-export-<from>-<to>.json``; без границы — ``all`` и дата выгрузки."""
    start = filters.date_from.isoformat() if filters.date_from else "all"
    end = (filters.date_to or today).isoformat()
    return f"checkist-export-{start}-{end}.json"

