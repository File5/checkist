from django.urls import re_path

from .views.product_classifications import (
    ConfirmManyView, ConfirmView, RecordView, RecordsView, RejectView, RunView, RunsView, StatusView,
)
from .views.recognition import LocalNotFoundView

PREFIX = r"^product-classifications/"
RECORD = PREFIX + r"(?P<pk>[1-9][0-9]{0,18})/"

urlpatterns = [
    re_path(PREFIX + r"$", RecordsView.as_view(), name="product-classifications-list"),
    re_path(PREFIX + r"confirm/$", ConfirmManyView.as_view(), name="product-classifications-confirm-many"),
    re_path(PREFIX + r"status/$", StatusView.as_view(), name="product-classifications-status"),
    re_path(PREFIX + r"runs/$", RunsView.as_view(), name="product-classifications-runs"),
    re_path(PREFIX + r"runs/(?P<pk>[1-9][0-9]{0,18})/$", RunView.as_view(), name="product-classifications-run"),
    re_path(RECORD + r"$", RecordView.as_view(), name="product-classifications-detail"),
    re_path(RECORD + r"confirm/$", ConfirmView.as_view(), name="product-classifications-confirm"),
    re_path(RECORD + r"reject/$", RejectView.as_view(), name="product-classifications-reject"),
    re_path(PREFIX + r"(?:.*/)?$", LocalNotFoundView.as_view(), name="product-classifications-not-found"),
]
