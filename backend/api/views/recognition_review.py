"""Human confirmation of a ``needs_review`` crop: ``POST …/receipt-images/{id}/confirm/``.

Same access as the rest of the recognition API (``LocalAPIView``). The request
is one call of ``recognition.review.confirm``; its errors are mapped to the
contract codes here. Field messages are fixed texts: no request value, issue
message or exception text reaches the response.
"""
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.response import Response

from api.common import get_or_404
from api.recognition_serialization import executor_object, image_object, job_object, jobs_queryset, public_issues
from config.exceptions import ApiError, InvalidParameter, InvalidRequest, ObjectNotFound, RecognitionApiError
from recognition import review
from recognition.models import ReceiptImage

from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView

PARAMETER_MESSAGES = {
    "required": "Обязательное поле.",
    "null": "Значение обязательно.",
    "type": "Неверный тип значения.",
    "format": "Неверный формат значения.",
    "choice": "Недопустимое значение.",
    "range": "Значение вне допустимого диапазона.",
    "blank": "Значение не может быть пустым.",
    "too_long": "Слишком длинное значение.",
    "size": "Недопустимое число элементов.",
    "unknown": "Значение не найдено.",
    "duplicate": "Значение повторяется.",
    "reference": "Ссылка на отсутствующую или неподходящую позицию.",
    "too_many_null": "Можно оставить пустым не более одного из значений net, tax, gross.",
}


class ReviewBodyParser(JsonObjectParser):
    limit = 1024 * 1024  # up to 1000 lines; the 4096 bytes of cancel/retry do not fit


class ConfirmView(LocalAPIView):
    http_method_names = ["post", "options"]
    parser_classes = [ReviewBodyParser]

    def handle_exception(self, exc):
        if isinstance(exc, review.ReviewInvalid):
            response = super().handle_exception(RecognitionApiError(exc.code))
            # Reasons of the refusal in the issue form of the crop, by the indexes of the request.
            response.data = {**response.data, "issues": public_issues(
                exc.issues, status="needs_review", normalized=exc.normalized)}
            return response
        if isinstance(exc, review.ReviewNotFound):
            exc = ObjectNotFound()
        elif isinstance(exc, review.ReviewInvalidParameter):
            exc = InvalidParameter({
                name: [PARAMETER_MESSAGES.get(reason, ApiError.message)] for name, reason in exc.fields.items()})
        elif isinstance(exc, review.ReviewError):
            exc = RecognitionApiError(exc.code)
        return super().handle_exception(exc)

    def body(self, request):
        if request.content_type != "application/json":
            raise UnsupportedMediaType(request.content_type)
        # DRF bypasses parsers for an empty body. An object is required, even then.
        if request._request.META.get("CONTENT_LENGTH") in (None, "", "0"):
            raise InvalidRequest()
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        if not review.known_structure(data):
            raise InvalidRequest()
        return data

    def post(self, request, pk):
        data = self.body(request)
        result = review.confirm(path_id(pk), data)
        image = get_or_404(ReceiptImage.objects.all(), result.image_id)
        job = get_or_404(jobs_queryset(), result.job_id)
        items = list(job.images.order_by("position", "id"))
        return Response({"image": image_object(image, detail=True),
                         "job": job_object(job, executor_object(), items=items)})
