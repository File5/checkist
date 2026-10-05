from django.urls import re_path

from .views.product_merges import (
    CancelView, ConfirmView, DetectView, ExcludeView, GroupLinesView, GroupView, GroupsView,
)
from .views.recognition import LocalNotFoundView

GROUP = r"^product-merges/(?P<pk>[1-9][0-9]{0,18})/"

urlpatterns = [
    re_path(r"^product-merges/$", GroupsView.as_view(), name="product-merges-list"),
    re_path(r"^product-merges/detect/$", DetectView.as_view(), name="product-merges-detect"),
    re_path(GROUP + r"$", GroupView.as_view(), name="product-merges-detail"),
    re_path(GROUP + r"lines/$", GroupLinesView.as_view(), name="product-merges-lines"),
    re_path(GROUP + r"confirm/$", ConfirmView.as_view(), name="product-merges-confirm"),
    re_path(GROUP + r"cancel/$", CancelView.as_view(), name="product-merges-cancel"),
    re_path(GROUP + r"exclude/$", ExcludeView.as_view(), name="product-merges-exclude"),
    re_path(r"^product-merges/(?:.*/)?$", LocalNotFoundView.as_view(), name="product-merges-not-found"),
]
