"""ИИ о тратах (``/api/insights/``): разбор месяца и ответы на вопросы.

Доступ — как у «Траты словами»: ``accounts`` — вход, ``local_single`` — DEBUG + флаг + loopback; запись — с
CSRF. Строки видит только их владелец (не семья): чужая — ``404``. Модель спрашивает воркер
(``insights.queue``); до постановки в очередь — ``accounts.ai.use_ai`` (``403 ai_disabled`` / ``429 ai_quota``).
Цифры разбора (``figures``) — от сервера: сводка, которую получила модель, либо, пока разбора нет, она же сейчас.
"""
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from accounts.access import request_user
from api.common import get_or_404, utc_datetime
from api.params import Params
from api.recognition_serialization import executor_object
from budget.dashboard import Month
from config.exceptions import InvalidParameter, RecognitionApiError
from insights import context, queue
from insights.models import InsightRequest

from .budget import read_month
from .receipts import manual_body
from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView

Kind, Status = InsightRequest.Kind, InsightRequest.Status
UNFINISHED = [Status.QUEUED, Status.RUNNING]

# Коды сбоя -> фиксированные тексты; сырой ответ модели в API не попадает.
ERRORS = {
    "invalid_output": "Не удалось составить ответ. Попробуйте ещё раз.",
    "timeout": "Ответ не уложился в срок. Попробуйте ещё раз.",
    "expired": "Ответ не дождался исполнителя. Попробуйте позже.",
    "worker_lost": "Исполнитель остановился во время ответа. Попробуйте ещё раз.",
    "auth_required": "ИИ сейчас недоступен: исполнителю нужен вход в Codex.",
}
ERROR_DEFAULT = "ИИ сейчас недоступен. Попробуйте позже."


def figures(summary):
    """Цифры месяца для экрана: всё из ``focus`` сводки, её основная валюта и траты без курса."""
    return {"month": summary["month"], "currency": summary["currency"], **summary["focus"],
            "without_rate": summary["without_rate"]}


def row_object(row):
    if row is None:
        return None
    error = None
    if row.error_code:
        error = {"code": row.error_code, "message": ERRORS.get(row.error_code, ERROR_DEFAULT)}
    succeeded = row.status == Status.SUCCEEDED
    result = {
        "id": row.pk, "kind": row.kind, "month": f"{row.month:%Y-%m}", "question": row.question, "status": row.status,
        "answer": row.answer if succeeded else None, "unverified": queue.unverified(row) if succeeded else [],
        "error": error, "created_at": utc_datetime(row.created_at), "finished_at": utc_datetime(row.finished_at),
        "executor": executor_object(),
    }
    if row.kind == Kind.REVIEW:
        result["figures"] = figures(row.context)
    return result


def own(request):
    return InsightRequest.objects.filter(owner=request_user(request))


def review_month(params, today):
    """Месяц разбора: по умолчанию — прошлый; будущий — отказ."""
    current = Month.of(today)
    if params.raw("month") is None:
        return current.previous()
    month = read_month(params, today)
    if month is not None and (month.year, month.month) > (current.year, current.month):
        params.error("month", "Месяц не позже текущего, в формате ГГГГ-ММ.")
    return month


class InsightBodyParser(JsonObjectParser):
    pass


class ReviewView(LocalAPIView):
    """``GET ?month=`` — цифры месяца и его разбор; ``POST {"month"}`` — новый разбор в очередь, ``202``.

    ``review`` — последний готовый разбор месяца, без него — последний любой (идёт либо не удался);
    ``pending`` — идущий новее готового («Обновить»). Незавершённый разбор того же месяца ``POST`` возвращает
    сам, без нового запроса к ИИ.
    """

    http_method_names = ["get", "post", "options"]
    parser_classes = [InsightBodyParser]

    def get(self, request):
        params = Params(request.query_params)
        month = review_month(params, timezone.localdate())
        params.check()
        rows = own(request).filter(kind=Kind.REVIEW, month=month.first).order_by("-pk")
        review = rows.filter(status=Status.SUCCEEDED).first() or rows.first()
        pending = rows.filter(status__in=UNFINISHED, pk__gt=review.pk).first() if review is not None else None
        summary = review.context if review is not None else context.build(request_user(request), month)
        return Response({"month": month.label(), "figures": figures(summary), "review": row_object(review),
                         "pending": row_object(pending)})

    def post(self, request):
        data = manual_body(request)
        errors = {key: ["Неизвестное поле."] for key in data if key != "month"}
        value = data.get("month")
        if value is not None and not isinstance(value, str):
            errors["month"] = ["Месяц в формате ГГГГ-ММ."]
        params = Params({"month": value} if isinstance(value, str) else {})
        month = review_month(params, timezone.localdate())
        errors.update(params.errors)
        if errors:
            raise InvalidParameter(errors)
        row = queue.request_review(request_user(request), month)
        return Response(row_object(row), status=status.HTTP_202_ACCEPTED)


class AskView(LocalAPIView):
    """``GET`` — последние вопросы человека (только свои); ``POST {"question"}`` — вопрос в очередь, ``202``."""

    http_method_names = ["get", "post", "options"]
    parser_classes = [InsightBodyParser]

    def get(self, request):
        rows = own(request).filter(kind=Kind.ASK).order_by("-pk")[:queue.HISTORY]
        return Response({"results": [row_object(row) for row in rows]})

    def post(self, request):
        data = manual_body(request)
        errors = {key: ["Неизвестное поле."] for key in data if key != "question"}
        question = data.get("question")
        if not isinstance(question, str) or not question.strip():
            errors["question"] = ["Напишите вопрос о тратах."]
        elif len(question.strip()) > queue.QUESTION_MAX:
            errors["question"] = [f"Не длиннее {queue.QUESTION_MAX} символов."]
        if errors:
            raise InvalidParameter(errors)
        try:
            row = queue.request_ask(request_user(request), question.strip(), Month.of(timezone.localdate()))
        except queue.AskLimit:
            raise RecognitionApiError("parse_limit") from None
        return Response(row_object(row), status=status.HTTP_202_ACCEPTED)


class InsightView(LocalAPIView):
    """``GET`` — состояние и ответ одной своей строки; чужая — ``404``."""

    def get(self, request, pk):
        return Response(row_object(get_or_404(own(request), path_id(pk))))
