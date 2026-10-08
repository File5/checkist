"""Local API of suggested generic products: ``/api/product-classifications/``.

Same access as the recognition API (``LocalAPIView``). Every mutation is one
call of ``classification.services``; its errors are mapped to the contract codes
here. No ``Idempotency-Key``: a repeat is recognised by the request content and
the state of the record. A decision is recorded with the user of the request
(``local`` in ``local_single``).
"""
from rest_framework import status
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.response import Response

from accounts.access import Moderator, request_user
from api.pagination import paginate
from api.params import MAX_ID, Params
from api.product_classification_serialization import record_object, record_objects, run_object, status_object
from api.recognition_serialization import executor_object
from classification import services
from classification.models import ClassificationRun, ProductClassification
from config.exceptions import ApiError, InvalidParameter, InvalidRequest, ObjectNotFound

from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView

MANY_BODY_LIMIT = 8192

REQUIRED = "Обязательное поле."
EXPECTED_ID = "Ожидается целое положительное число."
EXPECTED_OBJECT = "Ожидается объект."
PARAMETER_MESSAGES = {
    "unknown": "Обобщённый продукт не найден.",
    "service_generic": "Нельзя выбрать «Не разобрано».",
    "empty": "Нужна хотя бы одна запись.",
    "too_many": "Не больше 100 записей.",
    "duplicate": "Значение повторяется.",
}
ORDERINGS = ("generic", "-id")


class ClassificationApiError(ApiError):
    """Errors of the classification API; only fixed, public codes and messages."""

    status_code = status.HTTP_409_CONFLICT
    ERRORS = {
        "classification_resolved": "Предположение уже решено.",
        "classification_changed": "Предположение изменилось.",
        "classification_busy": "Каталог сейчас изменяется. Повторите позже.",
    }

    def __init__(self, code, *, fields=None):
        self.code = code
        super().__init__(self.ERRORS[code], fields=fields)


class ManyJsonObjectParser(JsonObjectParser):
    limit = MANY_BODY_LIMIT


def _is_id(value):
    return isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= MAX_ID


def _api_error(error):
    """The contract error of a ``classification.services`` failure."""
    if isinstance(error, services.ClassificationNotFound):
        return ObjectNotFound()
    if isinstance(error, services.ClassificationInvalidParameter):
        return InvalidParameter({
            name: [PARAMETER_MESSAGES.get(reason, ApiError.message)] for name, reason in error.fields.items()
        })
    if isinstance(error, (services.ClassificationResolved, services.ClassificationChanged)):
        # Only the bulk confirmation names the records: ``items.N`` is resolved or changed.
        fields = {
            name: [ClassificationApiError.ERRORS[f"classification_{reason}"]]
            for name, reason in error.fields.items()
        }
        return ClassificationApiError(error.code, fields=fields or None)
    return ClassificationApiError(error.code)


class ClassificationAPIView(LocalAPIView):
    def handle_exception(self, exc):
        if isinstance(exc, services.ClassificationError):
            exc = _api_error(exc)
        return super().handle_exception(exc)


def _body(request, *, required=()):
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
    if not isinstance(data, dict) or set(data) - set(required):
        raise InvalidRequest()
    return data


def _ids(request, *names):
    """Required ids of the body: every one an integer from 1 to 2^63 − 1."""
    data = _body(request, required=names)
    errors = {name: [REQUIRED] for name in names if name not in data}
    errors.update({name: [EXPECTED_ID] for name in names if name in data and not _is_id(data[name])})
    if errors:
        raise InvalidParameter(errors)
    return data


class ClassificationMutationView(ClassificationAPIView):
    permission_classes = [Moderator]
    http_method_names = ["post", "options"]
    parser_classes = [JsonObjectParser]


class RecordsView(ClassificationAPIView):
    def get(self, request):
        params = Params(request.query_params)
        page = params.page()
        filters = {
            "status": params.choice("status", ProductClassification.Status.values),
            "product": params.integer("product"),
            "generic": params.integer("generic"),
            "run": params.integer("run"),
            "ordering": params.choice("ordering", ORDERINGS, default=ORDERINGS[0]),
        }
        params.check()
        body = paginate(services.records(**filters), page)
        body["results"] = record_objects(body["results"])
        return Response(body)


class RecordView(ClassificationAPIView):
    def get(self, request, pk):
        return Response(record_object(services.get_record(path_id(pk))))


class ConfirmView(ClassificationMutationView):
    def post(self, request, pk):
        data = _ids(request, "version", "generic_id")
        record = services.confirm(
            path_id(pk), version=data["version"], generic_id=data["generic_id"], actor=request_user(request),
        )
        return Response(record_object(services.get_record(record.pk)))


class RejectView(ClassificationMutationView):
    def post(self, request, pk):
        data = _ids(request, "version")
        record = services.reject(path_id(pk), version=data["version"], actor=request_user(request))
        return Response(record_object(services.get_record(record.pk)))


class ConfirmManyView(ClassificationMutationView):
    parser_classes = [ManyJsonObjectParser]

    def post(self, request):
        data = _body(request, required=("items",))
        if "items" not in data:
            raise InvalidParameter({"items": [REQUIRED]})
        items = data["items"]
        if not isinstance(items, list) or not items:
            raise InvalidParameter({"items": [PARAMETER_MESSAGES["empty"]]})
        if len(items) > services.MANY_LIMIT:
            raise InvalidParameter({"items": [PARAMETER_MESSAGES["too_many"]]})
        if any(isinstance(item, dict) and set(item) - {"id", "version"} for item in items):
            raise InvalidRequest()
        errors = {}
        for position, item in enumerate(items):
            if not isinstance(item, dict):
                errors[f"items.{position}"] = [EXPECTED_OBJECT]
                continue
            for name in ("id", "version"):
                if name not in item:
                    errors[f"items.{position}.{name}"] = [REQUIRED]
                elif not _is_id(item[name]):
                    errors[f"items.{position}.{name}"] = [EXPECTED_ID]
        if errors:
            raise InvalidParameter(errors)
        records = services.confirm_many(
            [(item["id"], item["version"]) for item in items], actor=request_user(request),
        )
        # Read again with the run loaded: the page is serialized in a fixed number of queries.
        results = record_objects(services.records().filter(pk__in=[record.pk for record in records]).order_by("pk"))
        return Response({"confirmed": len(results), "results": results})


class StatusView(ClassificationAPIView):
    def get(self, request):
        return Response(status_object())


class RunsView(ClassificationAPIView):
    http_method_names = ["get", "head", "options", "post"]
    parser_classes = [JsonObjectParser]

    def get_permissions(self):
        # Reading the runs is open like the other GET; queueing one is a moderator's decision.
        return [Moderator()] if self.request.method == "POST" else super().get_permissions()

    def get(self, request):
        params = Params(request.query_params)
        page = params.page()
        run_status = params.choice("status", ClassificationRun.Status.values)
        params.check()
        return Response(paginate(services.runs(status=run_status), page, run_object))

    def post(self, request):
        _body(request)
        run, created = services.request_run(trigger=ClassificationRun.Trigger.MANUAL, actor=request_user(request))
        return Response(
            {"created": created, "run": run_object(run) if run else None, "executor": executor_object()},
            status=status.HTTP_202_ACCEPTED if created else status.HTTP_200_OK,
        )


class RunView(ClassificationAPIView):
    def get(self, request, pk):
        return Response(run_object(services.get_run(path_id(pk))))
