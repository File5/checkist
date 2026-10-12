"""``GET /api/export/`` — выгрузка семьи одним документом JSON (``api.export``)."""
from django.utils import timezone
from rest_framework.renderers import JSONRenderer
from rest_framework.response import Response

from budget.access import people

from .. import export
from ..common import CategoryTree
from .recognition_base import LocalAPIView


class ExportRenderer(JSONRenderer):
    """Документ с отступами: файл читает и человек."""

    def get_indent(self, accepted_media_type, renderer_context):
        return 2


class ExportView(LocalAPIView):
    """Доступ как у ``/api/receipts/``; ``?download=1`` — вложение с именем файла."""

    renderer_classes = [ExportRenderer]

    def get(self, request):
        tree = CategoryTree.load()
        family = people(request)
        filters, download = export.read_filters(request, tree, {item["username"] for item in family})
        response = Response(export.build(request, filters, tree, family))
        if download:
            name = export.filename(filters, timezone.localdate())
            response["Content-Disposition"] = f'attachment; filename="{name}"'
        return response
