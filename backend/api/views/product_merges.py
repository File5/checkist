"""Local API of provisional product merges: ``/api/product-merges/``.

Same access as the recognition API (``LocalAPIView``). Every mutation is one
call of ``merges.services``; its errors are mapped to the contract codes here.
A decision is recorded with the user of the request (``local`` in ``local_single``).
"""
import json

from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.parsers import BaseParser
from rest_framework.response import Response
from rest_framework import status

from accounts.access import Moderator, is_moderator, owner_q, request_user
from api.pagination import paginate
from api.params import MAX_ID, Params
from api.product_merge_serialization import group_briefs, group_object, line_object
from api.projection import own_annotation
from config.exceptions import ApiError, InvalidParameter, InvalidRequest, ObjectNotFound
from merges import services
from merges.models import ProductMerge

from .recognition import path_id
from .recognition_base import LocalAPIView, invalid_constant, unique_object

BODY_LIMIT = 4096

REQUIRED = "Обязательное поле."
EXPECTED_ID = "Ожидается целое положительное число."
EXPECTED_OBJECT = "Ожидается объект."
NOT_MEMBER = "Товар не входит в активные записи группы."
PARAMETER_MESSAGES = {
    "not_member": NOT_MEMBER,
    "invalid_type": EXPECTED_OBJECT,
    "not_conflict": "По этому полю нет противоречия.",
    "not_candidate": "У этой записи нет значения спорного поля.",
}
CONFLICT_MESSAGES = {
    "name": "Товар с таким названием, брендом и фасовкой уже существует.",
    "gtin": "Товар с таким GTIN уже существует.",
}
FACT_CONFLICT = "У записей группы разные значения."


class MergeApiError(ApiError):
    """Errors of the merge API; only fixed, public codes and messages."""

    status_code = status.HTTP_409_CONFLICT
    ERRORS = {
        "merge_conflict": "Данные товаров противоречат друг другу.",
        "merge_resolved": "Слияние уже завершено.",
        "merge_changed": "Состав группы изменился.",
        "merge_busy": "Каталог сейчас изменяется. Повторите позже.",
    }

    def __init__(self, code, *, fields=None):
        self.code = code
        super().__init__(self.ERRORS[code], fields=fields)


class JsonObjectParser(BaseParser):
    """A JSON object up to 4096 bytes without repeated keys; keys are checked by the view."""

    media_type = "application/json"

    def parse(self, stream, media_type=None, parser_context=None):
        try:
            data = stream.read(BODY_LIMIT + 1)
            if len(data) > BODY_LIMIT:
                raise InvalidRequest()
            value = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                               parse_constant=invalid_constant)
        except (UnicodeError, ValueError, RecursionError):
            raise InvalidRequest() from None
        if not isinstance(value, dict):
            raise InvalidRequest()
        return value


def _is_id(value):
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= MAX_ID


def _api_error(error):
    """The contract error of a ``merges.services`` failure."""
    if isinstance(error, services.MergeNotFound):
        return ObjectNotFound()
    if isinstance(error, services.MergeInvalidParameter):
        return InvalidParameter({
            name: [PARAMETER_MESSAGES.get(reason, ApiError.message)] for name, reason in error.fields.items()
        })
    if isinstance(error, services.MergeConflict):
        return MergeApiError("merge_conflict", fields={
            name: [CONFLICT_MESSAGES[name] if not product_ids and name in CONFLICT_MESSAGES else FACT_CONFLICT]
            for name, product_ids in error.fields.items()
        })
    return MergeApiError(error.code)


class MergeAPIView(LocalAPIView):
    def handle_exception(self, exc):
        if isinstance(exc, services.MergeError):
            exc = _api_error(exc)
        return super().handle_exception(exc)


class MergeMutationView(MergeAPIView):
    permission_classes = [Moderator]
    http_method_names = ["post", "options"]
    parser_classes = [JsonObjectParser]

    def body(self, request, *, required=(), optional=()):
        """The JSON object of the request; unknown keys are a structure error."""
        if request.content_type != "application/json":
            raise UnsupportedMediaType(request.content_type)
        # DRF bypasses parsers for an empty body. An object is required, even then.
        if request._request.META.get("CONTENT_LENGTH") in (None, "", "0"):
            raise InvalidRequest()
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        if not isinstance(data, dict) or set(data) - set(required) - set(optional):
            raise InvalidRequest()
        missing = {name: [REQUIRED] for name in required if name not in data}
        if missing:
            raise InvalidParameter(missing)
        return data


class GroupsView(MergeAPIView):
    def get(self, request):
        params = Params(request.query_params)
        page = params.page()
        group_status = params.choice("status", ProductMerge.Status.values)
        product = params.integer("product")
        params.check()
        body = paginate(services.groups(status=group_status, product=product), page)
        body["results"] = group_briefs(body["results"])
        return Response(body)


class GroupView(MergeAPIView):
    def get(self, request, pk):
        return Response(group_object(services.get_group(path_id(pk))))


class GroupLinesView(MergeAPIView):
    def get(self, request, pk):
        group = services.get_group(path_id(pk))
        params = Params(request.query_params)
        page = params.page()
        params.check()
        # Чеки личные: все строки группы видит только модератор, и чужие — без ссылки на чек.
        mine = None if is_moderator(request) else owner_q(request, "receipt__")
        lines = services.group_lines(group, mine).annotate(own=own_annotation(request))
        return Response(paginate(lines, page, lambda line: line_object(line, line.own)))


class DetectView(MergeMutationView):
    def post(self, request):
        self.body(request)
        result = services.detect()
        return Response({"created": result.created, "extended": result.extended, "group_ids": result.group_ids})


class ConfirmView(MergeMutationView):
    def post(self, request, pk):
        data = self.body(
            request, required=("version", "target_product_id"), optional=("name_product_id", "resolutions"),
        )
        errors = {
            name: [EXPECTED_ID] for name in ("version", "target_product_id", "name_product_id")
            if name in data and not _is_id(data[name])
        }
        resolutions = data.get("resolutions", {})
        if not isinstance(resolutions, dict):
            errors["resolutions"] = [EXPECTED_OBJECT]
        else:
            for name, chosen in resolutions.items():
                if name not in services.FACT_FIELDS:
                    errors[f"resolutions.{name}"] = [PARAMETER_MESSAGES["not_conflict"]]
                elif not _is_id(chosen):
                    errors[f"resolutions.{name}"] = [EXPECTED_ID]
        if errors:
            raise InvalidParameter(errors)
        group = services.confirm(
            path_id(pk), version=data["version"], target_product_id=data["target_product_id"],
            name_product_id=data.get("name_product_id"), resolutions=resolutions, actor=request_user(request),
        )
        return Response(group_object(group))


class CancelView(MergeMutationView):
    def post(self, request, pk):
        self.body(request)
        return Response(group_object(services.cancel(path_id(pk), actor=request_user(request))))


class ExcludeView(MergeMutationView):
    def post(self, request, pk):
        data = self.body(request, required=("version", "product_id"))
        errors = {name: [EXPECTED_ID] for name in ("version", "product_id") if not _is_id(data[name])}
        if errors:
            raise InvalidParameter(errors)
        group = services.exclude(
            path_id(pk), version=data["version"], product_id=data["product_id"], actor=request_user(request),
        )
        return Response(group_object(group))
