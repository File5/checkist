"""Склейка магазинов: один получатель под несколькими названиями («Anthropic Claude», «CLAUDE.AI SUBSCRIPTION»).

Склеенный магазин остаётся строкой с ``merged_into`` на главный: его вывеска и название — варианты написания,
по ним ``receipts.manual.find_or_create_store`` и импорт фото находят главный. ``merge`` переносит чеки на главный
и пишет журнал ``StoreMerge``; ``revert`` возвращает чеки и варианты по журналу (команда ``store_merges revert``).
Магазины общие для всех семей: решает модератор каталога (слой API).

Пары с похожими названиями приложение считает при чтении (``similar_pairs``); группы модели хранит
``StoreMergeSuggestion`` (команда ``store_merges suggest``), туда же пишется «Не то» человека (``dismiss``).
"""
import re
import unicodedata
from difflib import SequenceMatcher

from django.db import IntegrityError, transaction
from django.utils import timezone

from stores.models import Store, StoreMerge, StoreMergeSuggestion

Suggestion = StoreMergeSuggestion
# Слова, которые не отличают получателя: правовые формы и хвосты выписок («CLAUDE.AI SUBSCRIPTION», «ТОО Small»).
LEGAL_FORMS = frozenset({"тоо", "ип", "ао", "ооо", "оао", "зао", "чп", "too", "llp", "llc", "ltd", "inc", "gmbh", "jsc"})
NOISE = frozenset({"subscription", "subscr", "subs", "подписка", "оплата", "payment", "www", "com", "kz", "ru"})
SIMILAR_RATIO = 0.85


class MergeInvalid(Exception):
    """Склейка не подходит: ``fields`` — ``{"store" | "merged": "unknown" | "merged" | "same" | "required"}``."""

    def __init__(self, fields):
        super().__init__("store merge invalid")
        self.fields = fields


class MergeConflict(Exception):
    """После переноса у одного владельца оказались бы два одинаковых чека с фото в одном магазине."""


def display_name(store):
    """Как ``api.common.store_name``: вывеска, иначе название, иначе «Магазин №id» (нужен ``store.merchant``)."""
    return store.merchant.brand_name or store.name or f"Магазин №{store.pk}"


def aliases(store_ids):
    """``{id главного: [названия его вариантов]}`` для ``store_ids`` — один запрос."""
    found = {}
    for store in Store.objects.filter(merged_into_id__in=store_ids).select_related("merchant").order_by("pk"):
        found.setdefault(store.merged_into_id, []).append(display_name(store))
    return found


def name_key(name):
    """Название без регистра, пунктуации («*», «.»), правовых форм и хвостов «SUBSCR…»: «claude ai»."""
    text = unicodedata.normalize("NFKC", name or "").lower().replace("ё", "е")
    words = re.findall(r"[^\W_]+", text)
    return " ".join(word for word in words
                    if word not in LEGAL_FORMS and word not in NOISE and not word.startswith("subscr"))


def similarity(first, second):
    """Похожесть двух ключей ``name_key``: 1 — равны, 0.9 — одно начало другого по словам, иначе доля совпадения
    без пробелов, если она не меньше ``SIMILAR_RATIO`` (опечатка), иначе 0."""
    if not first or not second:
        return 0.0
    if first == second:
        return 1.0
    short, long = sorted((first.split(), second.split()), key=len)
    if long[:len(short)] == short:
        return 0.9
    ratio = SequenceMatcher(None, first.replace(" ", ""), second.replace(" ", "")).ratio()
    return ratio if ratio >= SIMILAR_RATIO else 0.0


def similar_pairs(names):
    """Пары id с похожими названиями: ``names`` — ``{id: название}``; сильные сначала.

    Сравниваются только названия с общим первым словом либо первыми тремя буквами — так любое из правил
    ``similarity`` не теряет пар, а сравнений не n².
    """
    keys = {pk: name_key(name) for pk, name in names.items()}
    buckets = {}
    for pk, key in keys.items():
        if key:
            for bucket in {key.split()[0], key.replace(" ", "")[:3]}:
                buckets.setdefault(bucket, []).append(pk)
    scored = {}
    for members in buckets.values():
        for index, first in enumerate(members):
            for second in members[index + 1:]:
                pair = (min(first, second), max(first, second))
                if pair not in scored:
                    scored[pair] = similarity(keys[first], keys[second])
    return [pair for pair, score in sorted(scored.items(), key=lambda item: (-item[1], item[0])) if score > 0]


def suggestions(counts, names):
    """Группы «похоже на одного получателя» среди ``counts`` (``{id: число трат}`` действующих магазинов семьи).

    Группы модели (ждут решения) и пары похожих названий; кроме групп, где меньше двух магазинов из
    ``counts``, и пар, которые человек уже назвал «Не то». В группе первым — магазин с большим числом трат.
    Один запрос к ``StoreMergeSuggestion``.
    """
    rows = list(Suggestion.objects.values_list("store_ids", "source", "status"))
    dismissed = [set(ids) for ids, _, status in rows if status == Suggestion.Status.DISMISSED]
    order = lambda ids: sorted(ids, key=lambda pk: (-counts[pk], names[pk].lower(), pk))  # noqa: E731
    found, seen = [], set()
    candidates = [(Suggestion.Source.MODEL, ids) for ids, source, status in rows
                  if source == Suggestion.Source.MODEL and status == Suggestion.Status.PENDING]
    candidates += [(Suggestion.Source.SIMILAR, pair) for pair in similar_pairs({pk: names[pk] for pk in counts})]
    for source, ids in candidates:
        group = order({pk for pk in ids if pk in counts})
        if len(group) < 2 or tuple(group) in seen or any(set(group) <= refused for refused in dismissed):
            continue
        seen.add(tuple(group))
        found.append({"source": source, "stores": group})
    return found


def dismiss(store_ids):
    """«Не то»: группа больше не предлагается — ни как группа модели, ни парами похожих названий внутри неё."""
    ids = sorted(set(store_ids))
    with transaction.atomic():
        updated = Suggestion.objects.filter(store_ids=ids, status=Suggestion.Status.PENDING).update(
            status=Suggestion.Status.DISMISSED)
        if not updated and not Suggestion.objects.filter(store_ids=ids, status=Suggestion.Status.DISMISSED).exists():
            Suggestion.objects.create(store_ids=ids, source=Suggestion.Source.SIMILAR, status=Suggestion.Status.DISMISSED)


def _check(store_id, merged_ids, stores):
    errors = {}
    main = stores.get(store_id)
    if main is None:
        errors["store"] = "unknown"
    elif main.merged_into_id is not None:
        errors["store"] = "merged"
    if not merged_ids:
        errors["merged"] = "required"
    elif store_id in merged_ids:
        errors["merged"] = "same"
    elif any(pk not in stores for pk in merged_ids):
        errors["merged"] = "unknown"
    elif any(stores[pk].merged_into_id is not None for pk in merged_ids):
        errors["merged"] = "merged"
    if errors:
        raise MergeInvalid(errors)
    return main


def merge(store_id, merged_ids, actor=None):
    """Склеить магазины ``merged_ids`` в главный ``store_id``: их чеки — главному, их варианты — главному,
    они сами — варианты главного; по записи журнала на каждый. ``MergeInvalid`` / ``MergeConflict`` — ничего
    не изменено."""
    merged_ids = list(dict.fromkeys(merged_ids))
    from receipts.models import Receipt

    try:
        with transaction.atomic():
            stores = Store.objects.select_for_update().in_bulk([store_id, *merged_ids])
            main = _check(store_id, merged_ids, stores)
            entries = []
            for pk in merged_ids:
                receipt_ids = list(Receipt.objects.filter(store_id=pk).order_by("pk").values_list("pk", flat=True))
                Receipt.objects.filter(pk__in=receipt_ids).update(store=main)
                alias_ids = list(Store.objects.filter(merged_into_id=pk).order_by("pk").values_list("pk", flat=True))
                Store.objects.filter(pk__in=alias_ids).update(merged_into=main)
                Store.objects.filter(pk=pk).update(merged_into=main)
                entries.append(StoreMerge.objects.create(
                    store=main, merged_id=pk, receipt_ids=receipt_ids, alias_ids=alias_ids, created_by=actor))
    except IntegrityError:
        raise MergeConflict() from None
    return entries


def revert(entry_id):
    """Вернуть склейку по записи журнала: чеки и варианты, которые она перенесла и которые всё ещё у главного
    (либо у того, в кого главный склеен позже), — назад; склеенный магазин снова самостоятельный.

    ``StoreMerge.DoesNotExist``; ``MergeInvalid({"entry": "reverted"})`` — уже отменена; ``MergeConflict``.
    """
    from receipts.models import Receipt

    try:
        with transaction.atomic():
            entry = StoreMerge.objects.select_for_update().select_related("store").get(pk=entry_id)
            if entry.reverted_at is not None:
                raise MergeInvalid({"entry": "reverted"})
            list(Store.objects.select_for_update().filter(pk__in=[entry.store_id, entry.merged_id]))
            current = [pk for pk in (entry.store_id, entry.store.merged_into_id) if pk is not None]
            Receipt.objects.filter(pk__in=entry.receipt_ids, store_id__in=current).update(store_id=entry.merged_id)
            Store.objects.filter(pk__in=entry.alias_ids, merged_into_id__in=current).update(merged_into_id=entry.merged_id)
            Store.objects.filter(pk=entry.merged_id).update(merged_into=None)
            entry.reverted_at = timezone.now()
            entry.save(update_fields=["reverted_at"])
    except IntegrityError:
        raise MergeConflict() from None
    return entry
