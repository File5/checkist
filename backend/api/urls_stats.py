from django.urls import re_path

from .views.recognition import LocalNotFoundView
from .views.stats_receipts import ReceiptCompareView, ReceiptSeriesView
from .views.stats_spending import SpendingView

urlpatterns = [
    re_path(r"^stats/spending/$", SpendingView.as_view(), name="stats-spending"),
    re_path(r"^stats/receipts/series/$", ReceiptSeriesView.as_view(), name="stats-receipts-series"),
    re_path(r"^stats/receipts/compare/$", ReceiptCompareView.as_view(), name="stats-receipts-compare"),
    re_path(r"^stats/(?:.*/)?$", LocalNotFoundView.as_view(), name="stats-not-found"),
]
