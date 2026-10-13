"""Группы «один получатель» по ответу модели — команда ``store_merges suggest``.

Модель получает действующие магазины с чеками (id и название, частые сначала) и возвращает группы id одного
получателя («Anthropic Claude» и «CLAUDE.AI SUBSCRIPTION»). Ответ проверяется схемой; группы с неизвестными
id, из одного магазина и пересекающиеся с прежними группами ответа отбрасываются. Новые группы пишутся
``StoreMergeSuggestion(source=model)``, уже известные (ждут решения либо «Не то») пропускаются. Склеивает
человек на экране «Магазины». Модель вызывается тем же путём Codex CLI, что разбор трат словами; ``fake`` —
пары похожих названий (``merging.similar_pairs``), без модели.
"""
import json
import time
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.db.models import Count

from recognition.providers.base import ProviderError, RunContext
from recognition.schema_validation import SchemaValidationError, _bounded
from stores import merging
from stores.models import Store, StoreMergeSuggestion

STORES_MAX = 400
TIMEOUT_SECONDS = 300
PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "store_groups.txt"
SCHEMA_PATH = Path(__file__).resolve().parent / "schemas" / "store_groups.schema.json"
INPUT_MARKER = "INPUT JSON:"


class GroupingOutputError(ValueError):
    """Ответ модели не прошёл схему; без значений ответа."""


@lru_cache(maxsize=1)
def schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def candidates(limit=STORES_MAX):
    """Действующие магазины с чеками любого владельца, частые сначала: ``[{"id", "name"}]``."""
    stores = (Store.objects.filter(merged_into__isnull=True).annotate(uses=Count("receipts")).filter(uses__gt=0)
              .select_related("merchant").order_by("-uses", "pk")[:limit])
    return [{"id": store.pk, "name": merging.display_name(store)} for store in stores]


def groups_from_output(data, payload):
    """Проверенные группы ответа: отсортированные id, известные, не меньше двух, без пересечений."""
    try:
        _bounded(data, schema())
    except SchemaValidationError:
        raise GroupingOutputError() from None
    known = {item["id"] for item in payload["stores"]}
    taken, groups = set(), []
    for group in data["groups"]:
        ids = sorted(set(group))
        if len(ids) < 2 or not known.issuperset(ids) or taken.intersection(ids):
            continue
        taken.update(ids)
        groups.append(ids)
    return groups


class FakeGrouper:
    """Без модели: связные группы пар похожих названий."""

    name = "fake"

    def group(self, payload, run):
        run.stage("stores")
        names = {item["id"]: item["name"] for item in payload["stores"]}
        parent = {pk: pk for pk in names}

        def root(pk):
            while parent[pk] != pk:
                pk = parent[pk]
            return pk

        for first, second in merging.similar_pairs(names):
            parent[root(second)] = root(first)
        groups = {}
        for pk in names:
            groups.setdefault(root(pk), []).append(pk)
        return {"groups": [sorted(ids) for ids in groups.values() if len(ids) > 1]}


class CodexGrouper:
    """Один текстовый вызов Codex CLI со схемой ответа."""

    name = "codex_cli"

    def __init__(self, provider=None):
        if provider is None:
            from recognition.providers.codex_cli import CodexCLIProvider

            provider = CodexCLIProvider()
        self.provider = provider

    def group(self, payload, run):
        try:
            prompt = PROMPT_PATH.read_text(encoding="utf-8").rstrip("\n")
        except OSError:
            raise ProviderError("configuration_error") from None
        prompt = f"{prompt}\n{INPUT_MARKER}\n{json.dumps(payload, ensure_ascii=False)}\n"
        return self.provider.run_text(prompt=prompt, schema=SCHEMA_PATH, timeout_seconds=TIMEOUT_SECONDS,
                                      run=run, stage="stores")


def get_grouper():
    """Исполнитель настроенного провайдера; сбой Codex никогда не выбирает fake."""
    if settings.RECEIPT_OCR_PROVIDER == "fake":
        return FakeGrouper()
    if settings.RECEIPT_OCR_PROVIDER == "codex_cli":
        return CodexGrouper()
    raise ProviderError("configuration_error")


def suggest(grouper, *, dry_run=False, limit=STORES_MAX):
    """Спросить ``grouper`` и записать новые группы; ``(группы ответа, записано)``.

    ``ProviderError`` и ``GroupingOutputError`` уходят вызывающему: ничего не записано.
    """
    payload = {"stores": candidates(limit)}
    if len(payload["stores"]) < 2:
        return [], 0
    run = RunContext(deadline=time.monotonic() + TIMEOUT_SECONDS + 5)
    groups = groups_from_output(grouper.group(payload, run), payload)
    if dry_run:
        return groups, 0
    known = {tuple(ids) for ids in StoreMergeSuggestion.objects.values_list("store_ids", flat=True)}
    fresh = [ids for ids in groups if tuple(ids) not in known]
    StoreMergeSuggestion.objects.bulk_create(
        [StoreMergeSuggestion(store_ids=ids, source=StoreMergeSuggestion.Source.MODEL) for ids in fresh])
    return groups, len(fresh)
