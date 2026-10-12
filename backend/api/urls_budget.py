from django.urls import re_path

from .views.budget import DashboardView, LimitView, LimitsView
from .views.recognition import LocalNotFoundView

urlpatterns = [
    re_path(r"^dashboard/$", DashboardView.as_view(), name="dashboard"),
    re_path(r"^budget/limits/$", LimitsView.as_view(), name="budget-limits"),
    re_path(r"^budget/limits/(?P<pk>[1-9][0-9]{0,18})/$", LimitView.as_view(), name="budget-limit"),
    re_path(r"^budget/(?:.*/)?$", LocalNotFoundView.as_view(), name="budget-not-found"),
]
