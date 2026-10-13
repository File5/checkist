"""Незнакомые получатели черновика → вопрос модели: очередь ``StatementAsk`` и шаг ``recognition_worker``.

Codex CLI со входом есть только рядом с воркером, поэтому ``web`` ставит вопрос в очередь
(``request``), а воркер отдельным шагом цикла берёт его (``claim``) и делает один
текстовый вызов (``execute``). Ответ проверяется схемой и списком категорий; подходящие
строки черновика получают предложение (``source = "model"``) и остаются спорными —
человек проверяет. Сбой модели черновик не ломает: строки остаются без предложения.
Строку, которую человек уже сохранил, ответ не трогает.

Право на модель — ``_ai_allowed(user)`` поверх ``accounts.ai.use_ai`` (включатель и квота семьи, один
вопрос на выписку). Без права строки помечаются ``ai = "off"``, вопрос не ставится.
"""
import json
import os
import re
import time
import uuid
from datetime import timedelta
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.db import transaction

from catalog.models import Category
from recognition.providers.base import ProviderError, RunContext
from recognition.queue import db_now
from recognition.schema_validation import SchemaValidationError, _bounded

from .models import StatementAsk, StatementRow

Status = StatementAsk.Status
Ai = StatementRow.Ai
CHUNK = 40
QUEUE_TTL = timedelta(minutes=30)
LEASE_MARGIN = timedelta(seconds=30)
TIMEOUT_SECONDS = 180
CATEGORIES_MAX = 500
UNASSIGNED = "Не разобрано"
SCHEMA_PATH = Path(__file__).resolve().parent / "schemas" / "statement_ask.schema.json"
PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "statement_ask.txt"
INPUT_MARKER = "INPUT JSON:"
FAKE_SCENARIOS = ("simple", "invalid_output", "provider_error", "timeout")
FAKE_SCENARIO_ENV = "STATEMENT_ASK_FAKE_SCENARIO"


def _ai_allowed(user):
    """Можно ли спрашивать модель за ``user`` — правило ``accounts.ai``: вопрос по выписке засчитывается в
    квоту семьи сразу (один на выписку); выключенный ИИ или исчерпанная квота — строки без модели, не ошибка."""
    from accounts.ai import AiRefused, use_ai

    try:
        use_ai(user)
    except AiRefused:
        return False
    return True


def timeout_seconds():
    return getattr(settings, "STATEMENT_ASK_TIMEOUT_SECONDS", TIMEOUT_SECONDS)


class AskOutputError(ValueError):
    """Ответ модели не прошёл схему или ссылается на чужие строки и категории."""


# --- постановка и очередь ---

def request(statement, merchants):
    """Вопросы о получателях ``merchants`` пачками по ``CHUNK``; строки уже помечены ``waiting``."""
    return [StatementAsk.objects.create(statement=statement, merchants=merchants[start:start + CHUNK])
            for start in range(0, len(merchants), CHUNK)]


def _close_rows(ask, value):
    StatementRow.objects.filter(statement_id=ask.statement_id, merchant__in=ask.merchants, ai=Ai.WAITING,
                                receipt__isnull=True).update(ai=value)


def expire_stale():
    """Вопросы, ждавшие воркера дольше ``QUEUE_TTL``, закрываются ``expired``: строки — ``failed``."""
    now = db_now()
    stale = list(StatementAsk.objects.filter(status=Status.QUEUED, created_at__lte=now - QUEUE_TTL))
    for ask in stale:
        with transaction.atomic():
            if StatementAsk.objects.filter(pk=ask.pk, status=Status.QUEUED).update(
                    status=Status.FAILED, error_code="expired", finished_at=now):
                _close_rows(ask, Ai.FAILED)
    return len(stale)


def recover_expired():
    """Вопросы ``running`` с истёкшей lease (воркер пропал) — ``failed`` / ``worker_lost``."""
    now = db_now()
    lost = list(StatementAsk.objects.filter(status=Status.RUNNING, lease_expires_at__lte=now))
    for ask in lost:
        with transaction.atomic():
            if StatementAsk.objects.filter(pk=ask.pk, status=Status.RUNNING, run_token=ask.run_token).update(
                    status=Status.FAILED, error_code="worker_lost", finished_at=now, run_token=None, lease_expires_at=None):
                _close_rows(ask, Ai.FAILED)
    return len(lost)


def claim():
    """Самый старый вопрос ``queued`` становится ``running``; ``None`` — очередь пуста."""
    expire_stale()
    with transaction.atomic():
        ask = StatementAsk.objects.select_for_update(skip_locked=True).filter(status=Status.QUEUED).order_by("pk").first()
        if ask is None:
            return None
        now = db_now()
        ask.status, ask.run_token, ask.started_at = Status.RUNNING, uuid.uuid4(), now
        ask.lease_expires_at = now + timedelta(seconds=timeout_seconds()) + LEASE_MARGIN
        ask.save(update_fields=["status", "run_token", "started_at", "lease_expires_at"])
        return ask


def finish(ask, *, answers=None, error_code=""):
    """Конечный статус захваченного вопроса и предложения строкам; ``False`` — его уже закрыли."""
    with transaction.atomic():
        owned = StatementAsk.objects.select_for_update().filter(
            pk=ask.pk, status=Status.RUNNING, run_token=ask.run_token).first()
        if owned is None:
            return False
        if error_code:
            _close_rows(owned, Ai.FAILED)
        else:
            apply(owned, answers)
        owned.status = Status.FAILED if error_code else Status.SUCCEEDED
        owned.error_code, owned.finished_at = error_code, db_now()
        owned.run_token = owned.lease_expires_at = None
        owned.save(update_fields=["status", "error_code", "finished_at", "run_token", "lease_expires_at"])
        return True


def apply(ask, answers):
    """``answers`` — ``{получатель: (категория | None, место | None)}``; ждущие строки получают предложение."""
    rows = StatementRow.objects.select_for_update().filter(
        statement_id=ask.statement_id, merchant__in=ask.merchants, ai=Ai.WAITING, receipt__isnull=True)
    for row in rows:
        category, store = answers.get(row.merchant, (None, None))
        if category is None:
            row.ai = Ai.UNKNOWN
        else:
            row.ai, row.category_id, row.source = Ai.DONE, category, "model"
            if store:
                row.store_name = store[:100]
        row.save(update_fields=["ai", "category", "source", "store_name"])


# --- вход модели и проверка ответа ---

def build_input(ask):
    """Вход модели: категории каталога и получатели с примером строки (операция, MCC, детали, сумма)."""
    categories = (Category.objects.exclude(name=UNASSIGNED).order_by("pk")
                  .values("pk", "name", "parent_id")[:CATEGORIES_MAX])
    samples = {}
    for row in StatementRow.objects.filter(statement_id=ask.statement_id, merchant__in=ask.merchants).order_by("position"):
        samples.setdefault(row.merchant, row)
    items = []
    for index, merchant in enumerate(ask.merchants, start=1):
        row = samples.get(merchant)
        items.append({
            "id": index, "merchant": merchant, "operation": row.operation if row else "",
            "mcc": (row.mcc or None) if row else None, "details": row.details if row else "",
            "amount": f"{-row.amount:.2f}" if row else None, "currency": row.currency if row else None,
        })
    return {
        "categories": [{"id": item["pk"], "name": item["name"], "parent_id": item["parent_id"]} for item in categories],
        "items": items,
    }


@lru_cache(maxsize=1)
def schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def answers_from_output(data, payload):
    """Ответ модели → ``{получатель: (категория | None, место | None)}`` либо ``AskOutputError``."""
    try:
        _bounded(data, schema())
    except SchemaValidationError:
        raise AskOutputError() from None
    merchants = {item["id"]: item["merchant"] for item in payload["items"]}
    known = {item["id"] for item in payload["categories"]}
    answers = {}
    for item in data["items"]:
        merchant = merchants.get(item["id"])
        if merchant is None or merchant in answers or (item["category"] is not None and item["category"] not in known):
            raise AskOutputError()
        store = (item["store_name"] or "").strip() or None
        answers[merchant] = (item["category"], store)
    return answers


# --- исполнители ---

class FakeAsker:
    """Детерминированный ответ без модели: категория, чьё имя подсказывает слово получателя, иначе «не знаю»."""

    name = "fake"
    HINTS = (
        (r"coffee|кофе|cafe|кафе|bar\b|бар\b|pizza|пицц|burger|sushi|суши|ресторан|restoran", "кафе"),
        (r"apteka|аптек|pharm|clinic|клиник|med", "здоров"),
        (r"taxi|такси|bus|авто|parking|парков|fuel|азс", "транспорт"),
        (r"market|маркет|магазин|shop|food|продукт|мини", "еда"),
        (r"cinema|кино|game|игр|club|клуб", "развлеч"),
    )

    def __init__(self, scenario="simple"):
        if scenario not in FAKE_SCENARIOS:
            raise ProviderError("configuration_error")
        self.scenario = scenario

    def ask(self, payload, run):
        run.stage("statement_ask")
        if self.scenario == "provider_error":
            raise ProviderError("provider_unavailable")
        if self.scenario == "timeout":
            raise ProviderError("timeout")
        if self.scenario == "invalid_output":
            return {"items": "много"}
        items = []
        for item in payload["items"]:
            category = None
            for pattern, word in self.HINTS:
                if re.search(pattern, item["merchant"], re.IGNORECASE):
                    category = next((entry["id"] for entry in payload["categories"]
                                     if entry["parent_id"] is None and entry["name"].casefold().startswith(word)), None)
                    break
            items.append({"id": item["id"], "category": category, "store_name": None})
        return {"items": items}


class CodexAsker:
    """Один текстовый вызов Codex CLI со схемой ответа, как у «Траты словами»."""

    name = "codex_cli"

    def __init__(self, provider=None):
        if provider is None:
            from recognition.providers.codex_cli import CodexCLIProvider

            provider = CodexCLIProvider()
        self.provider = provider

    def ask(self, payload, run):
        try:
            prompt = PROMPT_PATH.read_text(encoding="utf-8").rstrip("\n")
        except OSError:
            raise ProviderError("configuration_error") from None
        prompt = f"{prompt}\n{INPUT_MARKER}\n{json.dumps(payload, ensure_ascii=False)}\n"
        return self.provider.run_text(prompt=prompt, schema=SCHEMA_PATH, timeout_seconds=timeout_seconds(),
                                      run=run, stage="statement_ask")


def get_asker(*, scenario=None):
    """Исполнитель настроенного провайдера; сбой Codex никогда не выбирает fake."""
    if settings.RECEIPT_OCR_PROVIDER == "fake":
        return FakeAsker(scenario or os.environ.get(FAKE_SCENARIO_ENV) or "simple")
    if settings.RECEIPT_OCR_PROVIDER == "codex_cli":
        return CodexAsker()
    raise ProviderError("configuration_error")


def execute(ask, *, asker, is_stopped=lambda: False):
    """Один захваченный вопрос: вызов модели вне транзакции, проверка, предложения строкам.

    Сбой провайдера — его код, неверный ответ — ``invalid_output``, остановка воркера —
    ``worker_lost``. Непредвиденное исключение уходит вызывающему (воркер закрывает вопрос
    ``internal_error``).
    """
    context = RunContext(deadline=time.monotonic() + timeout_seconds() + 5, is_cancelled=is_stopped)
    answers, error_code = None, ""
    payload = build_input(ask)
    try:
        answers = answers_from_output(asker.ask(payload, context), payload)
    except ProviderError as error:
        error_code = "worker_lost" if error.code == "cancelled" else error.code
    except AskOutputError:
        error_code = "invalid_output"
    finish(ask, answers=answers, error_code=error_code)
    ask.refresh_from_db()
    return ask


def fail(ask, error_code):
    """Закрыть захваченный вопрос ошибкой (непредвиденный сбой шага, остановка воркера)."""
    return finish(ask, error_code=error_code)
