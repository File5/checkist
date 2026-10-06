from django.urls import re_path

from .views.recognition import LocalNotFoundView
from .views.stats_spending import SpendingView

urlpatterns = [
    re_path(r"^stats/spending/$", SpendingView.as_view(), name="stats-spending"),
    re_path(r"^stats/(?:.*/)?$", LocalNotFoundView.as_view(), name="stats-not-found"),
]
