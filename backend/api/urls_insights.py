from django.urls import re_path

from .views.insights import AskView, InsightView, ReviewView
from .views.recognition import LocalNotFoundView

urlpatterns = [
    re_path(r"^insights/review/$", ReviewView.as_view(), name="insights-review"),
    re_path(r"^insights/ask/$", AskView.as_view(), name="insights-ask"),
    re_path(r"^insights/(?P<pk>[1-9][0-9]{0,18})/$", InsightView.as_view(), name="insights-detail"),
    re_path(r"^insights/(?:.*/)?$", LocalNotFoundView.as_view(), name="insights-not-found"),
]
