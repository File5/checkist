from django.db.models import Exists, OuterRef, Q
from rest_framework.response import Response

from accounts.access import owner_q
from api.common import get_or_404
from api.pagination import paginate
from api.params import Params
from api.recognition_serialization import (
    discount_object, line_object, receipt_object, receipts_queryset, tax_object,
)
from receipts.models import Receipt, ReceiptLine

from .recognition import path_id
from .recognition_base import LocalAPIView


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
                                       | Q(store__name__icontains=search) | Q(Exists(matching_line)))
        return Response(paginate(receipts.order_by(ordering, "-id" if ordering.startswith("-") else "id"), page, receipt_object))


def own_receipt(request, pk):
    """The receipt of the request's user; another user's one is ``404`` like a missing one."""
    return get_or_404(Receipt.objects.filter(owner_q(request)), path_id(pk))


class ReceiptView(LocalAPIView):
    def get(self, request, pk):
        return Response(receipt_object(get_or_404(receipts_queryset(request), path_id(pk))))


class ReceiptLinesView(LocalAPIView):
    def get(self, request, pk):
        receipt = own_receipt(request, pk)
        params = Params(request.query_params)
        page = params.page()
        kind = params.choice("kind", ReceiptLine.Kind.values)
        matching = params.choice("matching", ("matched", "unmatched"))
        params.check()
        lines = receipt.lines.select_related("product", "tax_rate")
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
