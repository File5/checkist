"""«Магазины»: места семьи с числом трат и вариантами написания, группы «похоже на одного получателя», склейка.

Чтение — как у трат (``LocalOrSignedIn``). Склейка и «Не то» — только модератор каталога (``Moderator``):
магазины общие для всех семей. Предложения считаются и отдаются только модератору. Ответ склейки и «Не то» —
тот же объект, что у ``GET``: экран заменяет им своё состояние без второго запроса.
"""
from django.db.models import Count
from rest_framework.response import Response

from accounts.access import Moderator, is_moderator, request_user, visible_receipts_q
from config.exceptions import InvalidParameter, RecognitionApiError
from stores import merging
from stores.models import Store

from .receipts import manual_body
from .recognition_base import JsonObjectParser, LocalAPIView

IDS_MAX = 50
MESSAGES = {
    "type": "Ожидается номер магазина.",
    "list": f"Ожидается список номеров магазинов, не больше {IDS_MAX}.",
    "unknown": "Магазин не найден.",
    "merged": "Магазин уже склеен с другим.",
    "same": "Главный магазин не склеивается сам с собой.",
    "required": "Выберите магазины для склейки.",
    "few": "Нужно не меньше двух магазинов.",
    "unknown_field": "Неизвестное поле.",
}


def _id(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2 ** 63


def _ids(value):
    if not isinstance(value, list) or len(value) > IDS_MAX or not all(_id(item) for item in value):
        return None
    return list(dict.fromkeys(value))


def _invalid(fields):
    return InvalidParameter({name: [MESSAGES[reason]] for name, reason in fields.items()})


def stores_state(request):
    """Действующие магазины с тратами семьи (по названию), их варианты и — модератору — предложения.

    Три запроса: магазины с числом видимых трат, варианты, группы ``StoreMergeSuggestion``.
    """
    stores = list(Store.objects.filter(merged_into__isnull=True).select_related("merchant")
                  .annotate(receipts_count=Count("receipts", filter=visible_receipts_q(request, "receipts__")))
                  .filter(receipts_count__gt=0))
    names = {store.pk: merging.display_name(store) for store in stores}
    counts = {store.pk: store.receipts_count for store in stores}
    spellings = merging.aliases(list(names))
    moderator = is_moderator(request)
    stores.sort(key=lambda store: (names[store.pk].lower(), store.pk))
    return {
        "can_merge": moderator,
        "suggestions": merging.suggestions(counts, names) if moderator else [],
        "stores": [{"id": store.pk, "name": names[store.pk], "receipts_count": counts[store.pk],
                    "aliases": spellings.get(store.pk, [])} for store in stores],
    }


class StoreMergesView(LocalAPIView):
    def get(self, request):
        return Response(stores_state(request))


class StoreMergeMutationView(LocalAPIView):
    permission_classes = [Moderator]
    http_method_names = ["post", "options"]
    parser_classes = [JsonObjectParser]
    fields = ()

    def body(self, request):
        data = manual_body(request)
        errors = {key: "unknown_field" for key in data if key not in self.fields}
        if errors:
            raise _invalid(errors)
        return data


class StoreMergeView(StoreMergeMutationView):
    """``POST {"store": id главного, "merged": [id]}`` — склеить; отказы: ``400`` с полями,
    ``409 store_merge_conflict`` (одинаковые чеки с фото одного человека)."""

    fields = ("store", "merged")

    def post(self, request):
        data = self.body(request)
        errors = {}
        if not _id(data.get("store")):
            errors["store"] = "type" if "store" in data else "required"
        merged = _ids(data.get("merged", []))
        if merged is None:
            errors["merged"] = "list"
        if errors:
            raise _invalid(errors)
        try:
            merging.merge(data["store"], merged, actor=request_user(request))
        except merging.MergeInvalid as error:
            raise _invalid(error.fields) from None
        except merging.MergeConflict:
            raise RecognitionApiError("store_merge_conflict") from None
        return Response(stores_state(request))


class StoreDismissView(StoreMergeMutationView):
    """``POST {"stores": [id, …]}`` — «Не то»: группа и пары внутри неё больше не предлагаются."""

    fields = ("stores",)

    def post(self, request):
        data = self.body(request)
        ids = _ids(data.get("stores"))
        if ids is None:
            raise _invalid({"stores": "list"})
        if len(ids) < 2:
            raise _invalid({"stores": "few"})
        if Store.objects.filter(pk__in=ids).count() != len(ids):
            raise _invalid({"stores": "unknown"})
        merging.dismiss(ids)
        return Response(stores_state(request))
