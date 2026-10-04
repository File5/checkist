from django.urls import re_path

from .views.receipts import ReceiptDiscountsView, ReceiptLinesView, ReceiptTaxesView, ReceiptView, ReceiptsView
from .views.recognition import LocalNotFoundView

urlpatterns = [
    re_path(r"^receipts/$", ReceiptsView.as_view(), name="receipts-list"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/$", ReceiptView.as_view(), name="receipts-detail"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/lines/$", ReceiptLinesView.as_view(), name="receipts-lines"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/discounts/$", ReceiptDiscountsView.as_view(), name="receipts-discounts"),
    re_path(r"^receipts/(?P<pk>[1-9][0-9]{0,18})/taxes/$", ReceiptTaxesView.as_view(), name="receipts-taxes"),
    re_path(r"^receipts/(?:.*/)?$", LocalNotFoundView.as_view(), name="receipts-not-found"),
]
