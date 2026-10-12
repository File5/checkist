from django.db.models import Exists, OuterRef, Q
from rest_framework import status
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.response import Response

from accounts.access import owner_q, request_user
from api.common import get_or_404
from api.pagination import paginate
from api.params import Params
from api.recognition_serialization import (
    discount_object, line_object, receipt_object, receipts_queryset, tax_object,
)
from config.exceptions import InvalidParameter, InvalidRequest, RecognitionApiError
from receipts import manual
from receipts.models import Receipt, ReceiptLine

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
        params.check()
        receipts = receipts_queryset(request)
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
        return Response(paginate(receipts.order_by(ordering, "-id" if ordering.startswith("-") else "id"), page, receipt_object))


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


class ReceiptView(LocalAPIView):
    """Чек; ``PATCH`` и ``DELETE`` — только у траты, внесённой вручную (иначе ``409 receipt_read_only``)."""

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
        receipt = self.manual_receipt(request, pk)
        manual.delete(receipt.pk)
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
