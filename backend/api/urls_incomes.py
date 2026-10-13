from django.urls import re_path

from .views.incomes import IncomeCategoriesView, IncomesView, IncomeSummaryView, IncomeView
from .views.recognition import LocalNotFoundView

ID = r"(?P<pk>[1-9][0-9]{0,18})"

urlpatterns = [
    re_path(r"^incomes/$", IncomesView.as_view(), name="incomes"),
    re_path(r"^incomes/summary/$", IncomeSummaryView.as_view(), name="incomes-summary"),
    re_path(r"^incomes/categories/$", IncomeCategoriesView.as_view(), name="incomes-categories"),
    re_path(rf"^incomes/{ID}/$", IncomeView.as_view(), name="income"),
    re_path(r"^incomes/(?:.*/)?$", LocalNotFoundView.as_view(), name="incomes-not-found"),
]
