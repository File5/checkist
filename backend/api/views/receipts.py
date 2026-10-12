from django.contrib.postgres.aggregates import ArrayAgg
from django.db.models import Exists, OuterRef, Q, Subquery
from django.db.models.functions import Coalesce
from rest_framework import status
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.response import Response

from accounts.access import owner_q, request_user
from api.common import CategoryTree, get_or_404, utc_datetime
from api.pagination import paginate
from api.params import Params
from api.recognition_serialization import (
    discount_object, executor_object, line_object, receipt_object, receipts_queryset, tax_object,
)
from config.exceptions import InvalidParameter, InvalidRequest, ObjectNotFound, RecognitionApiError
from receipts import deletion, manual, manual_parse
from receipts.models import ManualParseRequest, Receipt, ReceiptLine

from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView

# Причины отказа ``receipts.manual`` -> фиксированные тексты; значения запроса в ответ не идут.
MANUAL_MESSAGES = {
    "body": "Ожидается объект JSON.",
    "unknown_field": "Неизвестное поле.",
    "required": "Обязательное поле.",
    "type": "Неверный тип значения.",
    "blank": "Значение не может быть пустым.",
    "too_long": "Слишком длинное значение.",
    "size": f"Не больше {manual.MAX_LINES} позиций.",
    "money": "Сумма больше нуля, не больше двух знаков после запятой.",
    "quantity": "Количество больше нуля, не больше трёх знаков после запятой.",
    "format": "Код валюты — три буквы.",
    "date": "Дата в формате ГГГГ-ММ-ДД.",
    "unknown": "Значение не найдено.",
    "mismatch": "Итог не совпадает с суммой позиций.",
    "itemized": "У траты с позициями категорию задают позициям.",
}


class ManualBodyParser(JsonObjectParser):
    limit = 64 * 1024  # 100 позиций с запасом


def manual_body(request):
    """Объект JSON тела; пустое тело и не JSON — отказ до проверки полей."""
    if request.content_type != "application/json":
        raise UnsupportedMediaType(request.content_type)
    if request._request.META.get("CONTENT_LENGTH") in (None, "", "0"):
        raise InvalidRequest()
    try:
        return request.data
    except ParseError:
        raise InvalidRequest() from None


def manual_invalid(error):
    return InvalidParameter({name: [MANUAL_MESSAGES[reason]] for name, reason in error.fields.items()})


def with_list_fields(receipts):
    """Поля строки списка «Траты»: первая позиция и категории строк — подзапросами, без запроса на чек.

    Категория строки — категория товара, если товар есть, иначе ``ReceiptLine.category``
    (как в статистике); строки без неё не учитываются.
    """
    lines = ReceiptLine.objects.filter(receipt_id=OuterRef("pk"))
    categories = (lines.annotate(spent_category=Coalesce("product__generic__category_id", "category_id"))
                  .filter(spent_category__isnull=False).order_by().values("receipt_id")
                  .annotate(ids=ArrayAgg("spent_category", distinct=True)).values("ids"))
    return receipts.annotate(first_line=Subquery(lines.order_by("position", "id").values("raw_name")[:1]),
                             line_category_ids=Subquery(categories))


def list_items(receipts):
    """Объекты списка: ``receipt_object`` + ``category`` (общая категория верхнего уровня либо null) + ``first_line``.

    Дерево категорий читается одним запросом и только если на странице есть строки с категорией.
    """
    tree = CategoryTree.load() if any(receipt.line_category_ids for receipt in receipts) else None
    items = []
    for receipt in receipts:
        roots = {tree.path_ids(pk)[0] for pk in receipt.line_category_ids or () if pk in tree}
        root = roots.pop() if len(roots) == 1 else None
        items.append({**receipt_object(receipt), "first_line": receipt.first_line or None,
                      "category": None if root is None else {"id": root, "name": tree.name(root)}})
    return items


class ReceiptsView(LocalAPIView):
    def get(self, request):
        params = Params(request.query_params)
        page = params.page()
        ordering = params.choice("ordering", ("-purchased_at", "purchased_at"), default="-purchased_at")
        store, product = params.integer("store"), params.integer("product")
        country, currency = params.country(), params.currency()
        operation = params.choice("operation", Receipt.Operation.values)
        date_from, date_to = params.date_range()
        search = params.search()
        # Логин того, кто добавил; видны только чеки семьи, поэтому чужой или неизвестный логин — пустой список.
        owner = params.raw("owner")
        params.check()
        receipts = receipts_queryset(request)
        if owner is not None:
            receipts = receipts.filter(owner__username=owner)
        for field, value in (("store_id", store), ("store__country_id", country),
                             ("currency_id", currency), ("operation", operation),
                             ("purchased_on__gte", date_from), ("purchased_on__lte", date_to)):
            if value is not None:
                receipts = receipts.filter(**{field: value})
        if product is not None:
            receipts = receipts.filter(Exists(ReceiptLine.objects.filter(receipt_id=OuterRef("pk"), product_id=product)))
        if search:
            matching_line = ReceiptLine.objects.filter(receipt_id=OuterRef("pk")).filter(
                Q(raw_name__icontains=search) | Q(product__name__icontains=search))
            receipts = receipts.filter(Q(store__merchant__brand_name__icontains=search)
                                       | Q(store__name__icontains=search) | Q(note__icontains=search)
                                       | Q(Exists(matching_line)))
        data = paginate(with_list_fields(receipts).order_by(ordering, "-id" if ordering.startswith("-") else "id"), page)
        data["results"] = list_items(list(data["results"]))
        return Response(data)


def own_receipt(request, pk):
    """The receipt of the request's user; another user's one is ``404`` like a missing one."""
    return get_or_404(Receipt.objects.filter(owner_q(request)), path_id(pk))


class ManualReceiptView(LocalAPIView):
    """``GET`` — значения формы по умолчанию, ``POST`` — новая трата без чека."""

    http_method_names = ["get", "post", "head", "options"]
    parser_classes = [ManualBodyParser]

    def get(self, request):
        own = Receipt.objects.filter(owner_q(request))
        return Response({
            "currency": manual.default_currency(own),
            "frequent_categories": manual.frequent_categories(ReceiptLine.objects.filter(owner_q(request, "receipt__"))),
        })

    def post(self, request):
        data = manual_body(request)
        try:
            receipt = manual.create(request_user(request), data)
        except manual.ManualInvalid as error:
            raise manual_invalid(error) from None
        return Response(receipt_object(get_or_404(receipts_queryset(request), receipt.pk)), status=status.HTTP_201_CREATED)


# Коды сбоя разбора -> фиксированные тексты; сырой ответ модели в API не попадает.
PARSE_ERRORS = {
    "invalid_output": "Не удалось разобрать текст. Заполните форму вручную.",
    "timeout": "Разбор не уложился в срок. Попробуйте ещё раз или заполните форму вручную.",
    "expired": "Разбор не дождался исполнителя. Заполните форму вручную.",
    "worker_lost": "Исполнитель остановился во время разбора. Попробуйте ещё раз.",
    "auth_required": "Разбор сейчас недоступен: исполнителю нужен вход в Codex.",
}
PARSE_ERROR_DEFAULT = "Разбор сейчас недоступен. Заполните форму вручную."


def parse_object(row):
    error = None
    if row.error_code:
        error = {"code": row.error_code, "message": PARSE_ERRORS.get(row.error_code, PARSE_ERROR_DEFAULT)}
    return {
        "id": row.pk, "status": row.status, "draft": row.draft if row.status == ManualParseRequest.Status.SUCCEEDED else None,
        "error": error, "created_at": utc_datetime(row.created_at), "finished_at": utc_datetime(row.finished_at),
        "executor": executor_object(),
    }


class ManualParseView(LocalAPIView):
    """``POST`` — поставить текст «Трата словами» в очередь воркера; ``202`` и строка запроса."""

    http_method_names = ["post", "options"]
    parser_classes = [JsonObjectParser]

    def post(self, request):
        data = manual_body(request)
        errors = {key: ["Неизвестное поле."] for key in data if key not in ("text", "today")}
        text = data.get("text")
        if not isinstance(text, str) or not text.strip():
            errors["text"] = ["Напишите, на что потрачено и сколько."]
        elif len(text.strip()) > manual_parse.TEXT_MAX:
            errors["text"] = [f"Не длиннее {manual_parse.TEXT_MAX} символов."]
        today = None
        if data.get("today") is not None and (today := manual_parse.client_today(data["today"])) is None:
            errors["today"] = ["Дата в формате ГГГГ-ММ-ДД, не дальше суток от даты сервера."]
        if errors:
            raise InvalidParameter(errors)
        try:
            row = manual_parse.request(request_user(request), text.strip(), today)
        except manual_parse.ParseLimit:
            raise RecognitionApiError("parse_limit") from None
        return Response(parse_object(row), status=status.HTTP_202_ACCEPTED)


class ManualParseDetailView(LocalAPIView):
    """``GET`` — состояние запроса и черновик формы; чужой запрос — ``404``."""

    def get(self, request, pk):
        return Response(parse_object(get_or_404(ManualParseRequest.objects.filter(owner_q(request)), path_id(pk))))


class ReceiptView(LocalAPIView):
    """Чек; ``PATCH`` — только у траты, внесённой вручную (иначе ``409 receipt_read_only``).

    ``DELETE`` — любой видимый чек (свой либо члена семьи). Чек с фото удаляется со строками, его вырезки
    остаются без связи; ``?with_photo=1`` удаляет и исходное фото со всеми заданиями, вырезками, попытками и
    файлами (``receipts.deletion``). Отказы: ``409 job_active``, ``409 photo_shared``.
    """

    http_method_names = ["get", "patch", "delete", "head", "options"]
    parser_classes = [ManualBodyParser]

    def get(self, request, pk):
        return Response(receipt_object(get_or_404(receipts_queryset(request), path_id(pk))))

    def manual_receipt(self, request, pk):
        receipt = own_receipt(request, pk)
        if receipt.source != Receipt.Source.MANUAL:
            raise RecognitionApiError("receipt_read_only")
        return receipt

    def patch(self, request, pk):
        receipt = self.manual_receipt(request, pk)
        data = manual_body(request)
        try:
            manual.update(receipt.pk, data)
        except manual.ManualInvalid as error:
            raise manual_invalid(error) from None
        return Response(receipt_object(get_or_404(receipts_queryset(request), receipt.pk)))

    def delete(self, request, pk):
        receipt = own_receipt(request, pk)
        params = Params(request.query_params)
        with_photo = params.boolean("with_photo", default=False)
        params.check()
        if receipt.source == Receipt.Source.MANUAL:
            manual.delete(receipt.pk)
            return Response(status=status.HTTP_204_NO_CONTENT)
        try:
            deletion.delete_receipt(receipt.pk, with_photo=with_photo)
        except Receipt.DoesNotExist:
            raise ObjectNotFound() from None
        except deletion.DeleteRefused as refused:
            raise RecognitionApiError(refused.code) from None
        return Response(status=status.HTTP_204_NO_CONTENT)


class ReceiptLinesView(LocalAPIView):
    def get(self, request, pk):
        receipt = own_receipt(request, pk)
        params = Params(request.query_params)
        page = params.page()
        kind = params.choice("kind", ReceiptLine.Kind.values)
        matching = params.choice("matching", ("matched", "unmatched"))
        params.check()
        lines = receipt.lines.select_related("product", "tax_rate", "category")
        if kind is not None:
            lines = lines.filter(kind=kind)
        if matching is not None:
            lines = lines.filter(product__isnull=matching == "unmatched")
        return Response(paginate(lines.order_by("position", "id"), page, line_object))


class ReceiptDiscountsView(LocalAPIView):
    def get(self, request, pk):
        receipt = own_receipt(request, pk)
        params = Params(request.query_params)
        page = params.page()
        params.check()
        return Response(paginate(receipt.discounts.order_by("position", "id"), page, discount_object))


class ReceiptTaxesView(LocalAPIView):
    def get(self, request, pk):
        receipt = own_receipt(request, pk)
        params = Params(request.query_params)
        page = params.page()
        params.check()
        return Response(paginate(receipt.taxes.select_related("tax_rate").order_by("tax_rate_id", "id"), page, tax_object))
