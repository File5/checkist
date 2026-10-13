"""Разбор месяца и ответы на вопросы: очередь ``InsightRequest`` и шаг ``recognition_worker``.

Codex CLI со входом есть только рядом с воркером, поэтому ``web`` модель не спрашивает: ``request_review`` /
``request_ask`` проверяют право на ИИ (``accounts.ai.use_ai`` — до постановки в очередь), собирают сводку
(``insights.context``) и пишут строку ``queued``; воркер после вопроса выписки берёт её (``claim``) и делает один
текстовый вызов (``execute``); клиент опрашивает строку. Ответ модели проверяется схемой; неверный —
``invalid_output``. Траты и каталог ответ не трогает.

Переходы — как у «Траты словами»: ``queued → running`` (``claim``), ``running → succeeded | failed``
(``execute``, сверка по ``run_token``), ``running → failed / worker_lost`` (истёкшая lease), ``queued → failed /
expired`` (ждал воркера дольше ``QUEUE_TTL``).

Числа текста сверяются со сводкой (``unverified``): число от 100, которого нет среди цифр сводки (и вопроса),
экран показывает как непроверенное — суммы на экране разбора всегда идут от сервера.
"""
import json
import math
import os
import re
import time
import uuid
from datetime import timedelta
from decimal import Decimal, InvalidOperation
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from accounts.ai import use_ai
from recognition.providers.base import ProviderError, RunContext
from recognition.queue import db_now
from recognition.schema_validation import SchemaValidationError, _bounded

from . import context as summary
from .models import InsightRequest

Kind = InsightRequest.Kind
Status = InsightRequest.Status
QUESTION_MAX = 300
HISTORY = 20
# Защита подписки Codex сверх квоты семьи: незавершённых вопросов человека и вопросов за час.
MAX_UNFINISHED = 2
MAX_PER_HOUR = 30
QUEUE_TTL = timedelta(minutes=10)
LEASE_MARGIN = timedelta(seconds=30)
TIMEOUT_SECONDS = 120
ROOT = Path(__file__).resolve().parent
INPUT_MARKER = "INPUT JSON:"
FAKE_SCENARIOS = ("simple", "invalid_output", "provider_error", "timeout")
FAKE_SCENARIO_ENV = "INSIGHTS_FAKE_SCENARIO"


def timeout_seconds():
    return getattr(settings, "INSIGHTS_TIMEOUT_SECONDS", TIMEOUT_SECONDS)


class AskLimit(Exception):
    """Слишком много вопросов человека: незавершённых либо за последний час."""


class OutputError(ValueError):
    """Ответ модели не прошёл схему; без значений ответа."""


# --- постановка и очередь ---

def pending_review(owner, month):
    return InsightRequest.objects.filter(owner=owner, kind=Kind.REVIEW, month=month.first,
                                         status__in=[Status.QUEUED, Status.RUNNING]).order_by("-pk").first()


def request_review(owner, month, today=None):
    """Разбор ``month`` (``budget.dashboard.Month``): незавершённый того же месяца — он же, без нового запроса к ИИ.

    Иначе — ``use_ai`` (отказ — ``AiRefused`` как есть), сводка и новая строка ``queued``.
    """
    pending = pending_review(owner, month)
    if pending is not None:
        return pending
    context = summary.build(owner, month, today)
    with transaction.atomic():
        # Два одновременных «Обновить» не ставят два разбора: строка человека заперта на время проверки.
        get_user_model().objects.select_for_update().filter(pk=owner.pk).first()
        pending = pending_review(owner, month)
        if pending is not None:
            return pending
        use_ai(owner)
        return InsightRequest.objects.create(owner=owner, kind=Kind.REVIEW, month=month.first, context=context)


def request_ask(owner, question, month, today=None):
    """Вопрос о тратах: ``use_ai`` и лимиты человека в одной транзакции (отказ лимита откатывает и счёт ИИ)."""
    context = summary.build(owner, month, today)
    with transaction.atomic():
        use_ai(owner)
        get_user_model().objects.select_for_update().filter(pk=owner.pk).first()
        own = InsightRequest.objects.filter(owner=owner, kind=Kind.ASK)
        if (own.filter(status__in=[Status.QUEUED, Status.RUNNING]).count() >= MAX_UNFINISHED
                or own.filter(created_at__gte=timezone.now() - timedelta(hours=1)).count() >= MAX_PER_HOUR):
            raise AskLimit()
        return InsightRequest.objects.create(owner=owner, kind=Kind.ASK, month=month.first, question=question,
                                             context=context)


def expire_stale():
    """Строки, ждавшие воркера дольше ``QUEUE_TTL``, закрываются ``expired`` без вызова модели."""
    now = db_now()
    return InsightRequest.objects.filter(status=Status.QUEUED, created_at__lte=now - QUEUE_TTL).update(
        status=Status.FAILED, error_code="expired", finished_at=now)


def recover_expired():
    """Строки ``running`` с истёкшей lease (воркер пропал) — ``failed`` / ``worker_lost``."""
    now = db_now()
    return InsightRequest.objects.filter(status=Status.RUNNING, lease_expires_at__lte=now).update(
        status=Status.FAILED, error_code="worker_lost", finished_at=now, run_token=None, lease_expires_at=None)


def claim():
    """Самая старая строка ``queued`` становится ``running``; ``None`` — очередь пуста."""
    expire_stale()
    with transaction.atomic():
        row = InsightRequest.objects.select_for_update(skip_locked=True).filter(status=Status.QUEUED).order_by("pk").first()
        if row is None:
            return None
        now = db_now()
        row.status, row.run_token, row.started_at = Status.RUNNING, uuid.uuid4(), now
        row.lease_expires_at = now + timedelta(seconds=timeout_seconds()) + LEASE_MARGIN
        row.save(update_fields=["status", "run_token", "started_at", "lease_expires_at"])
        return row


def finish(row, *, answer=None, error_code=""):
    """Конечный статус захваченной строки; ``False`` — её уже закрыли (lease истекла)."""
    with transaction.atomic():
        owned = InsightRequest.objects.select_for_update().filter(
            pk=row.pk, status=Status.RUNNING, run_token=row.run_token).first()
        if owned is None:
            return False
        owned.status = Status.FAILED if error_code else Status.SUCCEEDED
        owned.answer, owned.error_code, owned.finished_at = answer, error_code, db_now()
        owned.run_token = owned.lease_expires_at = None
        owned.save(update_fields=["status", "answer", "error_code", "finished_at", "run_token", "lease_expires_at"])
        return True


# --- вход модели и проверка ответа ---

def build_input(row):
    """Вход модели: сводка строки, у вопроса — и сам вопрос."""
    payload = dict(row.context)
    if row.kind == Kind.ASK:
        payload["question"] = row.question
    return payload


@lru_cache(maxsize=2)
def schema(kind):
    return json.loads((ROOT / "schemas" / f"{kind}.schema.json").read_text(encoding="utf-8"))


def _flat(value):
    """Строки ответа — одной строкой: переводы строк и табуляции модели становятся пробелами."""
    if isinstance(value, str):
        return re.sub(r"[ \t\r\n\f\v]+", " ", value).strip()  # неразрывные пробелы модели остаются
    if isinstance(value, list):
        return [_flat(item) for item in value]
    if isinstance(value, dict):
        return {key: _flat(item) for key, item in value.items()}
    return value


def answer_from_output(kind, data):
    """Ответ модели -> ``answer`` строки либо ``OutputError``; пустой текст — тоже ошибка."""
    data = _flat(data)
    try:
        _bounded(data, schema(kind))
    except SchemaValidationError:
        raise OutputError() from None
    if kind == Kind.ASK:
        if not data["answer"]:
            raise OutputError()
        return {"answer": data["answer"]}
    advice = [item for item in data["advice"] if item]
    if not data["summary"]:
        raise OutputError()
    return {"summary": data["summary"], "changes": data["changes"] or None, "limits": data["limits"] or None,
            "advice": advice}


def texts(row):
    """Тексты ответа строки по порядку показа."""
    answer = row.answer or {}
    return [text for text in (answer.get("summary"), answer.get("changes"), answer.get("limits"), answer.get("answer"),
                              *answer.get("advice", [])) if text]


NUMBER = re.compile(r"(?<![\w.,])(\d{1,3}(?:[ \u00a0\u202f]\d{3})+|\d+)(?:[.,](\d{1,2}))?(?!\d|\s?%)")
_SKIP_KEYS = {"id", "parent_id", "receipts", "count"}


def _numbers(text):
    for match in NUMBER.finditer(text):
        value = Decimal(re.sub(r"\D", "", match[1]) + (f".{match[2]}" if match[2] else ""))
        yield match[0], value


def _known(value, found):
    if isinstance(value, dict):
        for key, item in value.items():
            if key not in _SKIP_KEYS:
                _known(item, found)
    elif isinstance(value, list):
        for item in value:
            _known(item, found)
    elif isinstance(value, str):
        try:
            number = abs(Decimal(value))
        except InvalidOperation:
            found.update(int(item) for item in re.findall(r"\d{4}", value))  # годы месяцев «2026-09»
            return
        found.update((math.floor(number), math.ceil(number)))


def unverified(row):
    """Числа от 100 в тексте ответа, которых нет среди цифр сводки и вопроса (с точностью до округления), — как написаны."""
    found = set()
    _known(row.context, found)
    found.update(math.floor(value) for _text, value in _numbers(row.question))
    result = []
    for text in texts(row):
        for written, value in _numbers(text):
            if value >= 100 and not {math.floor(value), math.ceil(value)} & found and written not in result:
                result.append(written)
    return result


# --- исполнители ---

def _money(value, currency):
    units = math.ceil(abs(Decimal(value)))
    return f"{units:,}".replace(",", "\u00a0") + f"\u00a0{currency}"


class FakeWriter:
    """Детерминированный ответ без модели — только цифрами сводки, как просит промпт."""

    name = "fake"

    def __init__(self, scenario="simple"):
        if scenario not in FAKE_SCENARIOS:
            raise ProviderError("configuration_error")
        self.scenario = scenario

    def write(self, kind, payload, run):
        run.stage(f"insight_{kind}")
        if self.scenario == "provider_error":
            raise ProviderError("provider_unavailable")
        if self.scenario == "timeout":
            raise ProviderError("timeout")
        if self.scenario == "invalid_output":
            return {"answer": 42}
        focus, currency = payload["focus"], payload["currency"]
        top = focus["categories"][0] if focus["categories"] else None
        if kind == Kind.ASK:
            words = payload["question"].casefold()
            found = next((item for item in focus["categories"]
                          if any(word[:4] in words for word in item["name"].casefold().split() if len(word) >= 4)), None)
            if found is None:
                return {"answer": "Не знаю: в данных нет ответа на этот вопрос."}
            return {"answer": f"На «{found['name']}» в этом месяце ушло {_money(found['spent'], currency)}."}
        if top is None:
            return {"summary": "Трат в этом месяце нет.", "changes": None, "limits": None, "advice": []}
        over = next((item for item in focus["limits"] if item["over"]), None)
        change = Decimal(focus["change_previous"])
        return {
            "summary": f"Всего ушло {_money(focus['spent'], currency)}, больше всего — на «{top['name']}»: "
                       f"{_money(top['spent'], currency)}.",
            "changes": f"Против прошлого месяца — {'больше' if change > 0 else 'меньше'} на "
                       f"{_money(focus['change_previous'], currency)}.",
            "limits": f"«{over['category']}» — сверх лимита на {_money(over['over'], currency)}." if over else None,
            "advice": [f"Посмотрите траты «{top['name']}» — это самая большая статья месяца.",
                       "Сверьте регулярные платежи: всё ли оплачено и нет ли лишних подписок."],
        }


class CodexWriter:
    """Один текстовый вызов Codex CLI со схемой ответа, как у вопроса выписки."""

    name = "codex_cli"

    def __init__(self, provider=None):
        if provider is None:
            from recognition.providers.codex_cli import CodexCLIProvider

            provider = CodexCLIProvider()
        self.provider = provider

    def write(self, kind, payload, run):
        try:
            prompt = (ROOT / "prompts" / f"{kind}.txt").read_text(encoding="utf-8").rstrip("\n")
        except OSError:
            raise ProviderError("configuration_error") from None
        prompt = f"{prompt}\n{INPUT_MARKER}\n{json.dumps(payload, ensure_ascii=False)}\n"
        return self.provider.run_text(prompt=prompt, schema=ROOT / "schemas" / f"{kind}.schema.json",
                                      timeout_seconds=timeout_seconds(), run=run, stage=f"insight_{kind}")


def get_writer(*, scenario=None):
    """Исполнитель настроенного провайдера; сбой Codex никогда не выбирает fake."""
    if settings.RECEIPT_OCR_PROVIDER == "fake":
        return FakeWriter(scenario or os.environ.get(FAKE_SCENARIO_ENV) or "simple")
    if settings.RECEIPT_OCR_PROVIDER == "codex_cli":
        return CodexWriter()
    raise ProviderError("configuration_error")


def execute(row, *, writer, is_stopped=lambda: False):
    """Одна захваченная строка: вызов модели вне транзакции, проверка, конечный статус.

    Сбой провайдера — его код, неверный ответ — ``invalid_output``, остановка воркера — ``worker_lost``.
    Непредвиденное исключение уходит вызывающему (воркер закрывает строку ``internal_error``).
    """
    run = RunContext(deadline=time.monotonic() + timeout_seconds() + 5, is_cancelled=is_stopped)
    answer, error_code = None, ""
    try:
        answer = answer_from_output(row.kind, writer.write(row.kind, build_input(row), run))
    except ProviderError as error:
        error_code = "worker_lost" if error.code == "cancelled" else error.code
    except OutputError:
        error_code = "invalid_output"
    finish(row, answer=answer, error_code=error_code)
    row.refresh_from_db()
    return row


def fail(row, error_code):
    """Закрыть захваченную строку ошибкой (непредвиденный сбой шага, остановка воркера)."""
    return finish(row, error_code=error_code)
