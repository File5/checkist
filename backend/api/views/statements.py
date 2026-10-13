"""Импорт выписок: загрузка PDF, черновик, «Сохранить N трат» и правила получателей.

Черновик — личный: виден и сохраняется только тем, кто загрузил выписку (чужой — ``404``);
траты создаются на него. Правила — общие на семью, как лимиты (``budget.access``).
"""
from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from rest_framework import status
from rest_framework.exceptions import ParseError
from rest_framework.response import Response

from accounts.access import request_user
from api.common import CategoryTree, get_or_404, iso_date, store_name, utc_datetime
from api.pagination import paginate
from api.params import Params
from api.recognition_serialization import executor_object
from budget.access import limit_owner, limits_q
from catalog.models import Category
from config.exceptions import ApiError, InvalidParameter, InvalidRequest
from receipts import manual
from statements import drafts
from statements.extract import MAX_BYTES, StatementError
from statements.models import StatementAsk, StatementImport, StatementRow, StatementRule
from statements.parsers import BANK_LABELS
from statements.rules import normalize

from .recognition import path_id
from .recognition_base import BoundedMultiPartParser, JsonObjectParser, LocalAPIView


class StatementApiError(ApiError):
    """Отказы приёма выписки: только постоянные коды и тексты."""

    ERRORS = {
        "unsupported_format": (400, "Загрузите выписку в PDF."),
        "invalid_pdf": (400, "Не удалось прочитать PDF."),
        "pdf_encrypted": (400, "PDF защищён паролем. Сохраните выписку без пароля и загрузите снова."),
        "pdf_too_many_pages": (400, "В выписке слишком много страниц. Выберите период короче."),
        "statement_too_large": (400, "Выписка слишком большая. Выберите период короче."),
        "statement_unsupported_bank": (400, "Это не выписка Kaspi Gold или ForteBank: другие банки пока не поддерживаются."),
        "statement_empty": (400, "В выписке не нашлось операций. Нужна выписка по карте за период, в PDF из приложения банка."),
        "upload_too_large": (413, "Файл или запрос превышает допустимый размер."),
    }

    def __init__(self, code):
        self.code = code
        self.status_code, self.message = self.ERRORS[code]
        super().__init__()


# Причины отказа сохранения и правила -> постоянные тексты; значения запроса в ответ не идут.
MESSAGES = {
    "body": "Ожидается объект JSON.",
    "unknown_field": "Неизвестное поле.",
    "required": "Обязательное поле.",
    "type": "Неверный тип значения.",
    "size": f"Не больше {drafts.MAX_ROWS} строк.",
    "repeated": "Строка указана дважды.",
    "too_long": "Слишком длинное значение.",
    "unknown": "Значение не найдено.",
    "income": "Поступление не сохраняется тратой.",
    "refunded": "Покупка возвращена полностью.",
    "blank": "Значение не может быть пустым.",
    "money": "Сумма больше нуля, не больше двух знаков после запятой.",
    "format": "Код валюты — три буквы.",
    "date": "Дата в формате ГГГГ-ММ-ДД.",
    "taken": "Правило для этого получателя уже есть.",
    "choice": "Неизвестное значение.",
    "category_action": "Категория нужна только правилу «категория».",
}


def invalid(fields):
    return InvalidParameter({name: [MESSAGES.get(reason, MESSAGES["type"])] for name, reason in fields.items()})


def category_object(tree, pk):
    if pk is None or pk not in tree:
        return None
    return {"id": pk, "name": tree.name(pk), "path": tree.path(pk)}


def row_object(row, tree):
    duplicate = None
    if row.duplicate_of is not None:
        receipt = row.duplicate_of
        duplicate = {"id": receipt.pk, "purchased_on": iso_date(receipt.purchased_on), "total": str(receipt.total),
                     "currency": receipt.currency_id, "store_name": store_name(receipt.store) if receipt.store else None}
    return {
        "id": row.pk, "date": iso_date(row.date), "amount": str(row.amount), "currency": row.currency,
        "operation": row.operation, "details": row.details, "merchant": row.merchant, "mcc": row.mcc or None,
        "refund": str(row.refund), "spend": str(drafts.spend_amount(row)),
        "kind": row.kind, "state": row.state, "reason": row.reason or None,
        "category": category_object(tree, row.category_id), "store_name": row.store_name or None,
        "source": row.source or None, "ai": row.ai or None, "duplicate_of": duplicate, "receipt_id": row.receipt_id,
    }


def summary_object(statement):
    return {
        "id": statement.pk, "bank": statement.bank, "bank_name": BANK_LABELS[statement.bank],
        "date_from": iso_date(statement.date_from), "date_to": iso_date(statement.date_to),
        "created_at": utc_datetime(statement.created_at), "saved_at": utc_datetime(statement.saved_at),
        "rows_count": statement.rows_count, "saved_count": statement.saved_count,
    }


def annotated(queryset):
    return queryset.annotate(rows_count=Count("rows"), saved_count=Count("rows", filter=Q(rows__receipt__isnull=False)))


def detail_object(statement):
    tree = CategoryTree.load()
    rows = list(statement.rows.select_related("duplicate_of__store__merchant").order_by("position"))
    asks = statement.asks.values_list("status", flat=True)
    waiting = sum(1 for row in rows if row.ai == StatementRow.Ai.WAITING)
    return {
        **summary_object(statement),
        "ai": {"waiting": waiting, "active": any(value in (StatementAsk.Status.QUEUED, StatementAsk.Status.RUNNING) for value in asks),
               "executor": executor_object()},
        "rows": [row_object(row, tree) for row in rows],
    }


def own_statements(request):
    return StatementImport.objects.filter(owner=request_user(request))


class StatementsView(LocalAPIView):
    """``GET`` — свои выписки, новые сверху; ``POST`` (multipart ``file``) — загрузить PDF.

    Тот же файл повторно — прежний черновик (``200``, ``reused: true``); новый — ``201``.
    """

    http_method_names = ["get", "post", "head", "options"]
    parser_classes = [BoundedMultiPartParser]

    def get(self, request):
        params = Params(request.query_params)
        page = params.page()
        params.check()
        return Response(paginate(annotated(own_statements(request)).order_by("-created_at", "-id"), page, summary_object))

    def post(self, request):
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        if set(data) - {"file"} or set(request.FILES) - {"file"}:
            raise InvalidRequest()
        if len(request.FILES.getlist("file")) != 1 or len(data.getlist("file")) != 1:
            raise InvalidParameter({"file": ["Выберите один файл."]})
        upload = request.FILES["file"]
        if upload.size > MAX_BYTES:
            raise StatementApiError("upload_too_large")
        content = upload.read()
        try:
            statement, created = drafts.accept(request_user(request), content, rule_scope=limits_q(request))
        except StatementError as error:
            raise StatementApiError(error.code) from None
        statement = annotated(StatementImport.objects.filter(pk=statement.pk)).get()
        return Response({"reused": not created, "statement": summary_object(statement)},
                        status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)


class StatementView(LocalAPIView):
    """``GET`` — черновик со всеми строками; ``DELETE`` — убрать черновик (сохранённые траты остаются)."""

    http_method_names = ["get", "delete", "head", "options"]

    def get(self, request, pk):
        statement = get_or_404(annotated(own_statements(request)), path_id(pk))
        return Response(detail_object(statement))

    def delete(self, request, pk):
        statement = get_or_404(own_statements(request), path_id(pk))
        statement.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class SaveBodyParser(JsonObjectParser):
    limit = 512 * 1024  # 3000 строк с запасом


class StatementSaveView(LocalAPIView):
    """``POST {"rows": [{"id", "category", "store_name"?}]}`` — траты из отмеченных строк.

    Ответ: ``created`` (новых трат), ``learned`` (правил выучено по правкам) и черновик.
    """

    http_method_names = ["post", "options"]
    parser_classes = [SaveBodyParser]

    def post(self, request, pk):
        statement = get_or_404(own_statements(request), path_id(pk))
        if request.content_type != "application/json":
            raise InvalidRequest()
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        try:
            created, learned = drafts.save(statement.pk, data, rule_owner=limit_owner(request), actor=request_user(request))
        except drafts.SaveInvalid as error:
            raise invalid(error.fields) from None
        statement = annotated(StatementImport.objects.filter(pk=statement.pk)).get()
        return Response({"created": created, "learned": learned, "statement": detail_object(statement)})


# --- правила ---

RULE_FIELDS = ("pattern", "action", "category", "store_name")


def rule_object(rule, tree):
    return {
        "id": rule.pk, "pattern": rule.pattern, "action": rule.action, "category": category_object(tree, rule.category_id),
        "store_name": rule.store_name or None, "origin": rule.origin, "updated_at": utc_datetime(rule.updated_at),
    }


def rule_values(data, current=None):
    """Проверенные поля правила; без ``current`` — новое (``pattern`` обязателен)."""
    if not isinstance(data, dict):
        raise invalid({"body": "body"})
    errors = {key: "unknown_field" for key in data if key not in RULE_FIELDS}
    values = {}
    if "pattern" in data or current is None:
        pattern = data.get("pattern")
        if not isinstance(pattern, str):
            errors["pattern"] = "required" if pattern is None else "type"
        elif not normalize(pattern):
            errors["pattern"] = "blank"
        elif len(pattern.strip()) > 200:
            errors["pattern"] = "too_long"
        else:
            values["pattern"], values["key"] = pattern.strip(), normalize(pattern)
    if "action" in data:
        if data["action"] not in StatementRule.Action.values:
            errors["action"] = "choice"
        else:
            values["action"] = data["action"]
    if "category" in data:
        category = data["category"]
        if category is not None and (isinstance(category, bool) or not isinstance(category, int)):
            errors["category"] = "type"
        elif category is not None and not Category.objects.filter(pk=category).exists():
            errors["category"] = "unknown"
        else:
            values["category_id"] = category
    if "store_name" in data:
        store = data["store_name"]
        if store is not None and not isinstance(store, str):
            errors["store_name"] = "type"
        elif len((store or "").strip()) > manual.STORE_NAME_MAX:
            errors["store_name"] = "too_long"
        else:
            values["store_name"] = (store or "").strip()
    action = values.get("action", current.action if current else StatementRule.Action.CATEGORY)
    category = values.get("category_id", current.category_id if current else None)
    if action == StatementRule.Action.CATEGORY and category is None and "category" not in errors:
        errors["category"] = "required"
    if action != StatementRule.Action.CATEGORY:
        if "category" in data and data["category"] is not None and "category" not in errors:
            errors["category"] = "category_action"
        values["category_id"] = None
        values["store_name"] = ""
    if errors:
        raise invalid(errors)
    return values


def save_rule(rule):
    try:
        with transaction.atomic():
            rule.save()
    except IntegrityError:
        raise invalid({"pattern": "taken"}) from None


class RulesView(LocalAPIView):
    """``GET`` — правила семьи (без семьи — свои) по получателю; ``POST`` — новое правило."""

    http_method_names = ["get", "post", "head", "options"]
    parser_classes = [JsonObjectParser]

    def get(self, request):
        tree = CategoryTree.load()
        rules = StatementRule.objects.filter(limits_q(request)).order_by("key", "pk")
        return Response({"results": [rule_object(rule, tree) for rule in rules]})

    def post(self, request):
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        values = rule_values(data)
        rule = StatementRule(**limit_owner(request), **values, origin=StatementRule.Origin.MANUAL,
                             created_by=request_user(request))
        save_rule(rule)
        return Response(rule_object(rule, CategoryTree.load()), status=status.HTTP_201_CREATED)


class RuleView(LocalAPIView):
    """``PATCH`` — изменить правило, ``DELETE`` — удалить; чужое правило — ``404``."""

    http_method_names = ["patch", "delete", "options"]
    parser_classes = [JsonObjectParser]

    def patch(self, request, pk):
        rule = get_or_404(StatementRule.objects.filter(limits_q(request)), path_id(pk))
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        for name, value in rule_values(data, rule).items():
            setattr(rule, name, value)
        save_rule(rule)
        return Response(rule_object(rule, CategoryTree.load()))

    def delete(self, request, pk):
        get_or_404(StatementRule.objects.filter(limits_q(request)), path_id(pk)).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)
