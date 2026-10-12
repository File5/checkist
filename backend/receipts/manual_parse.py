"""«Трата словами»: очередь разбора текста и шаг воркера.

Codex CLI со входом есть только рядом с ``recognition_worker`` (в Docker — контейнер
``recognition``), поэтому ``web`` разбор не выполняет: ``request`` пишет строку
``ManualParseRequest`` в ``queued``, воркер берёт её (``claim``) раньше заданий
распознавания и пакетов предположений и выполняет один текстовый вызов (``execute``),
клиент опрашивает строку. Ответ модели проверяется схемой и правилами ``manual.parse``;
черновик — тело ``POST /api/receipts/manual/``. Чеки и каталог разбор не трогает.

Переходы: ``queued → running`` (``claim``), ``running → succeeded | failed`` (``execute``,
сверка по ``run_token``), ``running → failed / worker_lost`` (истёкшая lease,
``recover_expired``; повтора нет — человек отправит текст ещё раз), ``queued → failed /
expired`` (ждал воркера дольше ``QUEUE_TTL``: человек уже не ждёт, модель не спрашиваем).
"""
import json
import os
import re
import time
import uuid
from datetime import date, timedelta
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from catalog.models import Category
from receipts import manual
from receipts.models import ManualParseRequest, Receipt
from recognition.providers.base import ProviderError, RunContext
from recognition.queue import db_now
from recognition.schema_validation import SchemaValidationError, _bounded
from stores.models import Currency

Status = ManualParseRequest.Status
TEXT_MAX = 500
# Защита подписки Codex: незавершённых запросов на человека и запросов за час.
MAX_UNFINISHED = 3
MAX_PER_HOUR = 30
QUEUE_TTL = timedelta(minutes=5)
LEASE_MARGIN = timedelta(seconds=30)
CATEGORIES_MAX = 500
UNASSIGNED = "Не разобрано"
SCHEMA_PATH = Path(__file__).resolve().parent / "schemas" / "manual_parse.schema.json"
PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "manual_parse.txt"
INPUT_MARKER = "INPUT JSON:"
FAKE_SCENARIOS = ("simple", "invalid_output", "provider_error", "timeout")
FAKE_SCENARIO_ENV = "MANUAL_PARSE_FAKE_SCENARIO"


class ParseLimit(Exception):
    """Слишком много запросов человека: незавершённых либо за последний час."""


class ParseOutputError(ValueError):
    """Ответ модели не прошёл схему или правила ручной траты; без значений ответа."""


# --- постановка и очередь ---

def request(owner, text, today=None):
    """Новая строка ``queued``; ``ParseLimit`` — сверх лимитов владельца.

    Строка пользователя блокируется на время подсчёта: два одновременных запроса не
    обходят лимит.
    """
    with transaction.atomic():
        get_user_model().objects.select_for_update().filter(pk=owner.pk).first()
        own = ManualParseRequest.objects.filter(owner=owner)
        now = timezone.now()
        if (own.filter(status__in=[Status.QUEUED, Status.RUNNING]).count() >= MAX_UNFINISHED
                or own.filter(created_at__gte=now - timedelta(hours=1)).count() >= MAX_PER_HOUR):
            raise ParseLimit()
        return ManualParseRequest.objects.create(owner=owner, text=text, today=today or timezone.localdate())


def _close(row, status, *, draft=None, error_code="", now=None):
    row.status, row.draft, row.error_code = status, draft, error_code
    row.finished_at = now or db_now()
    row.run_token = row.lease_expires_at = None
    row.save(update_fields=["status", "draft", "error_code", "finished_at", "run_token", "lease_expires_at"])


def expire_stale():
    """Строки, ждавшие воркера дольше ``QUEUE_TTL``, закрываются ``expired`` без вызова модели."""
    now = db_now()
    return ManualParseRequest.objects.filter(status=Status.QUEUED, created_at__lte=now - QUEUE_TTL).update(
        status=Status.FAILED, error_code="expired", finished_at=now)


def recover_expired():
    """Строки ``running`` с истёкшей lease (воркер пропал) — ``failed`` / ``worker_lost``."""
    now = db_now()
    return ManualParseRequest.objects.filter(status=Status.RUNNING, lease_expires_at__lte=now).update(
        status=Status.FAILED, error_code="worker_lost", finished_at=now, run_token=None, lease_expires_at=None)


def claim():
    """Самая старая строка ``queued`` становится ``running``; ``None`` — очередь пуста."""
    expire_stale()
    with transaction.atomic():
        row = ManualParseRequest.objects.select_for_update(skip_locked=True).filter(
            status=Status.QUEUED).order_by("pk").first()
        if row is None:
            return None
        now = db_now()
        row.status, row.run_token, row.started_at = Status.RUNNING, uuid.uuid4(), now
        row.lease_expires_at = now + timedelta(seconds=settings.MANUAL_PARSE_TIMEOUT_SECONDS) + LEASE_MARGIN
        row.save(update_fields=["status", "run_token", "started_at", "lease_expires_at"])
        return row


def finish(row, *, draft=None, error_code=""):
    """Конечный статус захваченной строки; ``False`` — её уже закрыли (lease истекла)."""
    with transaction.atomic():
        owned = ManualParseRequest.objects.select_for_update().filter(
            pk=row.pk, status=Status.RUNNING, run_token=row.run_token).first()
        if owned is None:
            return False
        _close(owned, Status.FAILED if error_code else Status.SUCCEEDED, draft=draft, error_code=error_code)
        return True


# --- вход модели и проверка ответа ---

def build_input(row):
    """Вход модели: сегодня, валюта по умолчанию, валюты и категории каталога, текст."""
    categories = (Category.objects.exclude(name=UNASSIGNED).order_by("pk")
                  .values("pk", "name", "parent_id")[:CATEGORIES_MAX])
    return {
        "today": row.today.isoformat(),
        "default_currency": manual.default_currency(Receipt.objects.filter(owner_id=row.owner_id)),
        "currencies": list(Currency.objects.order_by("pk").values_list("pk", flat=True)),
        "categories": [{"id": item["pk"], "name": item["name"], "parent_id": item["parent_id"]} for item in categories],
        "text": row.text,
    }


@lru_cache(maxsize=1)
def schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def draft_from_output(data, payload):
    """Черновик — тело ``POST /api/receipts/manual/``, либо ``ParseOutputError``.

    Пустые валюта и дата получают значения входа; с позициями итог — их сумма.
    """
    try:
        _bounded(data, schema())
    except SchemaValidationError:
        raise ParseOutputError() from None
    lines = [{"name": line["name"].strip(), "amount": line["amount"], "quantity": line["quantity"],
              "category": line["category"]} for line in data["lines"]]
    body = {
        "total": data["total"], "currency": data["currency"] or payload["default_currency"],
        "category": data["category"], "purchased_on": data["purchased_on"] or payload["today"],
        "store_name": (data["store_name"] or "").strip() or None, "note": (data["note"] or "").strip(),
        "lines": lines,
    }
    try:
        manual.parse({key: value for key, value in body.items() if value is not None})
    except manual.ManualInvalid:
        raise ParseOutputError() from None
    if lines:
        body["total"] = str(sum((Decimal(line["amount"]) for line in lines), Decimal("0.00")))
    return body


# --- исполнители ---

class FakeTextParser:
    """Детерминированный ответ без модели: последнее число текста — сумма, первая категория входа, сегодня."""

    name = "fake"

    def __init__(self, scenario="simple"):
        if scenario not in FAKE_SCENARIOS:
            raise ProviderError("configuration_error")
        self.scenario = scenario

    def parse(self, payload, run):
        run.stage("parse")
        if self.scenario == "provider_error":
            raise ProviderError("provider_unavailable")
        if self.scenario == "timeout":
            raise ProviderError("timeout")
        if self.scenario == "invalid_output":
            return {"total": "много"}
        numbers = re.findall(r"[0-9]+(?:[.,][0-9]{1,2})?", payload["text"])
        total = numbers[-1].replace(",", ".") if numbers else None
        return {
            "total": total, "currency": None,
            "category": payload["categories"][0]["id"] if payload["categories"] else None,
            "purchased_on": None, "store_name": None, "note": None, "lines": [],
        }


class CodexTextParser:
    """Один текстовый вызов Codex CLI со схемой ответа, как у предположений категорий."""

    name = "codex_cli"

    def __init__(self, provider=None):
        if provider is None:
            from recognition.providers.codex_cli import CodexCLIProvider

            provider = CodexCLIProvider()
        self.provider = provider

    def parse(self, payload, run):
        try:
            prompt = PROMPT_PATH.read_text(encoding="utf-8").rstrip("\n")
        except OSError:
            raise ProviderError("configuration_error") from None
        prompt = f"{prompt}\n{INPUT_MARKER}\n{json.dumps(payload, ensure_ascii=False)}\n"
        return self.provider.run_text(
            prompt=prompt, schema=SCHEMA_PATH, timeout_seconds=settings.MANUAL_PARSE_TIMEOUT_SECONDS,
            run=run, stage="parse",
        )


def get_parser(*, scenario=None):
    """Исполнитель настроенного провайдера; сбой Codex никогда не выбирает fake."""
    if settings.RECEIPT_OCR_PROVIDER == "fake":
        return FakeTextParser(scenario or os.environ.get(FAKE_SCENARIO_ENV) or "simple")
    if settings.RECEIPT_OCR_PROVIDER == "codex_cli":
        return CodexTextParser()
    raise ProviderError("configuration_error")


def execute(row, *, parser, is_stopped=lambda: False):
    """Один захваченный запрос: вызов модели вне транзакции, проверка, конечный статус.

    Сбой провайдера — его код (``timeout``, ``auth_required``, …), неверный ответ —
    ``invalid_output``, остановка воркера — ``worker_lost``. Непредвиденное исключение
    уходит вызывающему (воркер закрывает строку ``internal_error``).
    """
    context = RunContext(deadline=time.monotonic() + settings.MANUAL_PARSE_TIMEOUT_SECONDS + 5,
                         is_cancelled=is_stopped)
    draft, error_code = None, ""
    payload = build_input(row)
    try:
        draft = draft_from_output(parser.parse(payload, context), payload)
    except ProviderError as error:
        error_code = "worker_lost" if error.code == "cancelled" else error.code
    except ParseOutputError:
        error_code = "invalid_output"
    finish(row, draft=draft, error_code=error_code)
    row.refresh_from_db()
    return row


def fail(row, error_code):
    """Закрыть захваченную строку ошибкой (непредвиденный сбой шага, остановка воркера)."""
    return finish(row, error_code=error_code)


def client_today(value):
    """Дата клиента не дальше суток от даты сервера, иначе ``None`` (берётся дата сервера)."""
    try:
        parsed = date.fromisoformat(value) if isinstance(value, str) and len(value) == 10 else None
    except ValueError:
        return None
    if parsed is None or abs((parsed - timezone.localdate()).days) > 1:
        return None
    return parsed
