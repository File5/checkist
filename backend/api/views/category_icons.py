"""Значок категории (2026-10-13): ``GET`` и ``POST /api/categories/{id}/icon/`` (``{"icon": ключ | null}``).

Ответ — ``{"id", "icon", "own_icon"}``: значок с наследованием (``CategoryTree.icon``; ``null`` — ни у кого в ветви)
и свой (``null`` — как у родителя). Читает любой, кому открыты траты; категории общие для всех семей, поэтому
меняет только модератор каталога (``Moderator``: иначе ``403 permission_denied``). ``null`` либо ``""`` в теле —
как у родителя. Ответы каталога (``/api/categories/…``) не меняются.
"""
from rest_framework.response import Response

from accounts.access import Moderator
from api.common import CategoryTree
from catalog.models import Category, CategoryIcon
from config.exceptions import InvalidParameter, ObjectNotFound

from .receipts import manual_body
from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView


def icon_object(pk):
    tree = CategoryTree.load()
    if pk not in tree:
        raise ObjectNotFound()
    return {"id": pk, "icon": tree.icon(pk), "own_icon": tree.own_icon(pk)}


class CategoryIconView(LocalAPIView):
    http_method_names = ["get", "head", "post", "options"]
    parser_classes = [JsonObjectParser]

    def get_permissions(self):
        return [Moderator()] if self.request.method == "POST" else super().get_permissions()

    def get(self, request, pk):
        return Response(icon_object(path_id(pk)))

    def post(self, request, pk):
        pk = path_id(pk)
        if not Category.objects.filter(pk=pk).exists():
            raise ObjectNotFound()
        data = manual_body(request)
        errors = {key: ["Неизвестное поле."] for key in data if key != "icon"}
        icon = data.get("icon")
        if "icon" not in data:
            errors["icon"] = ["Обязательное поле."]
        elif icon not in (None, "", *CategoryIcon.values):
            errors["icon"] = ["Неизвестный значок."]
        if errors:
            raise InvalidParameter(errors)
        Category.objects.filter(pk=pk).update(icon=icon or "")
        return Response(icon_object(pk))
