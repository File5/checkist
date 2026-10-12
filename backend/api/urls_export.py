from django.urls import re_path

from .views.export import ExportView
from .views.recognition import LocalNotFoundView

urlpatterns = [
    re_path(r"^export/$", ExportView.as_view(), name="export"),
    re_path(r"^export/(?:.*/)?$", LocalNotFoundView.as_view(), name="export-not-found"),
]
