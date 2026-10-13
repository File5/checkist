from django.urls import re_path

from .views.receipts import (
    ManualParseDetailView, ManualParseView, ManualReceiptView, ManualSuggestView, ReceiptDiscountsView, ReceiptHideView, ReceiptLinesView, ReceiptTaxesView, ReceiptView, ReceiptsView,
)
from .views.recognition import LocalNotFoundView

urlpatterns = [
    re_path(r"^receipts/$", ReceiptsView.as_view(), name="receipts-list"),
    re_path(r"^receipts/manual/$", ManualReceiptView.as_view(), name="receipts-manual"),
    re_path(r"^receipts/manual/suggest/$", ManualSuggestView.as_view(), name="receipts-manual-suggest"),
    re_path(r"^receipts/manual/parse/$", ManualParseView.as_view(), name="receipts-manual-parse"),
    re_path(r"^receipts/manual/parse/(?P<pk>[1-9][0-9]{0,18})/$", ManualParseDetailView.as_view(),
            name="receipts-manual-parse-detail"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/$", ReceiptView.as_view(), name="receipts-detail"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/hide/$", ReceiptHideView.as_view(hide=True), name="receipts-hide"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/unhide/$", ReceiptHideView.as_view(hide=False), name="receipts-unhide"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/lines/$", ReceiptLinesView.as_view(), name="receipts-lines"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/discounts/$", ReceiptDiscountsView.as_view(), name="receipts-discounts"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/taxes/$", ReceiptTaxesView.as_view(), name="receipts-taxes"),
    re_path(r"^receipts/(?:.*/)?$", LocalNotFoundView.as_view(), name="receipts-not-found"),
]
