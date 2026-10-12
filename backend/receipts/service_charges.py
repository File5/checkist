"""Обслуживание и чаевые: строка-услуга чека получает свою категорию.

Строка вида ``service``, чьё название похоже на плату за обслуживание или чаевые
(``is_service_charge``), остаётся без товара каталога и получает ``ReceiptLine.category`` =
«Кафе и рестораны» › «Обслуживание и чаевые». Статистика относит строку без товара к её
категории, поэтому такие траты видны отдельно от еды. Другие услуги не меняются.

Правило применяет импорт распознанного чека (и подтверждение вырезки — тот же импорт)
только к новому чеку; уже сохранённые строки меняет лишь ``manage.py service_charges
backfill``. Категорию создаёт миграция ``catalog.0003_service_charge_category``; если её
нет (удалена либо переименована), правило ничего не делает.
"""
from catalog.models import Category
from receipts.models import ReceiptLine

PARENT_NAME = "Кафе и рестораны"
CATEGORY_NAME = "Обслуживание и чаевые"

# Части слов без учёта регистра; единственный список правила (клиент повторяет его для подсказки
# в форме исправления — frontend/src/features/recognition/service-charge.ts, менять вместе).
MARKERS = (
    "обслуж",          # обслуживание, обслуж. 10%
    "сервис",          # сервисный сбор
    "чаев",            # чаевые
    "service",         # service charge
    "servis",          # servis haqqı, servis ücreti
    "tips",
    "gratuity",
    "trinkgeld",
    "bedienung",
    "қызмет көрсет",   # қызмет көрсету (каз.)
    "қызмет ақы",      # қызмет ақысы
)


def is_service_charge(raw_name):
    """Похоже ли название строки на плату за обслуживание либо чаевые."""
    name = " ".join((raw_name or "").casefold().split())
    return any(marker in name for marker in MARKERS)


def applies(kind, raw_name):
    """Правило: строка-услуга с названием обслуживания или чаевых."""
    return kind == ReceiptLine.Kind.SERVICE and is_service_charge(raw_name)


def category_id():
    """Id «Кафе и рестораны» › «Обслуживание и чаевые» либо ``None``, если её нет; один запрос."""
    return (Category.objects.filter(name=CATEGORY_NAME, parent__name=PARENT_NAME, parent__parent=None)
            .values_list("pk", flat=True).first())


def seeded_category_ids():
    """Id корня и потомка из миграции (те, что есть); пустая база для демо QA их не считает данными."""
    child = category_id()
    if child is None:
        return list(Category.objects.filter(name=PARENT_NAME, parent=None, children=None).values_list("pk", flat=True))
    parent = Category.objects.filter(pk=child).values_list("parent_id", flat=True).get()
    return [child, parent]


class CategoryLookup:
    """Id категории, найденный не больше одного раза за жизнь объекта (один импорт)."""

    _missing = object()

    def __init__(self):
        self._value = self._missing

    def __call__(self):
        if self._value is self._missing:
            self._value = category_id()
        return self._value


def backfill(*, dry_run=False):
    """Применяет правило к сохранённым строкам-услугам без товара и без категории.

    Строку, у которой категория уже есть (выбрана человеком), не трогает. Возвращает
    ``{"category_id", "matched", "updated", "kept"}``: найдено по правилу, изменено (при
    ``dry_run`` — было бы изменено), оставлено со своей категорией. Без категории
    обслуживания ``category_id`` — None и ничего не меняется.
    """
    target = category_id()
    lines = (ReceiptLine.objects.filter(kind=ReceiptLine.Kind.SERVICE, product__isnull=True)
             .order_by("pk").values_list("pk", "raw_name", "category_id"))
    matched = [(pk, category) for pk, name, category in lines if is_service_charge(name)]
    fresh = [pk for pk, category in matched if category is None]
    kept = sum(1 for _, category in matched if category is not None and category != target)
    updated = 0
    if target is not None and fresh:
        updated = len(fresh) if dry_run else ReceiptLine.objects.filter(
            pk__in=fresh, category__isnull=True, product__isnull=True,
        ).update(category_id=target)
    return {"category_id": target, "matched": len(matched), "updated": updated, "kept": kept}
