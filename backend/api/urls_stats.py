from django.urls import re_path

from .views.recognition import LocalNotFoundView
from .views.stats_receipts import ReceiptCompareView, ReceiptSeriesView
from .views.stats_spending import SpendingView
from .views.stats_trends import TrendsCategoryView, TrendsLimitsView, TrendsMonthlyView, TrendsPricesView, TrendsRangeView

urlpatterns = [
    re_path(r"^stats/spending/$", SpendingView.as_view(), name="stats-spending"),
    re_path(r"^stats/receipts/series/$", ReceiptSeriesView.as_view(), name="stats-receipts-series"),
    re_path(r"^stats/receipts/compare/$", ReceiptCompareView.as_view(), name="stats-receipts-compare"),
    re_path(r"^stats/trends/monthly/$", TrendsMonthlyView.as_view(), name="stats-trends-monthly"),
    re_path(r"^stats/trends/category/$", TrendsCategoryView.as_view(), name="stats-trends-category"),
    re_path(r"^stats/trends/prices/$", TrendsPricesView.as_view(), name="stats-trends-prices"),
    re_path(r"^stats/trends/limits/$", TrendsLimitsView.as_view(), name="stats-trends-limits"),
    re_path(r"^stats/trends/range/$", TrendsRangeView.as_view(), name="stats-trends-range"),
    re_path(r"^stats/(?:.*/)?$", LocalNotFoundView.as_view(), name="stats-not-found"),
]
