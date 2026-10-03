from django.core.exceptions import PermissionDenied as DjangoPermissionDenied
from django.http import Http404
from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler


class ApiError(exceptions.APIException):
    """Ошибка API в едином формате ``{"error": {"code", "message", "fields?"}}``.

    Сообщение — фиксированный текст для клиента: значения параметров, текст
    исключений и внутренние детали в него не попадают.
    """

    status_code = status.HTTP_400_BAD_REQUEST
    code = "invalid_parameter"
    message = "Некорректные параметры запроса."

    def __init__(self, message=None, *, fields=None):
        if message is not None:
            self.message = message
        self.fields = fields
        super().__init__(detail=self.message, code=self.code)


class InvalidParameter(ApiError):
    """400: ``fields`` — ``{"имя параметра": ["сообщение", ...]}``."""

    def __init__(self, fields, message=None):
        super().__init__(message, fields={name: list(messages) for name, messages in fields.items()})


class RangeTooLarge(ApiError):
    code = "range_too_large"
    message = "Слишком большой диапазон: сузьте даты или укрупните интервал."


class ObjectNotFound(ApiError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "not_found"
    message = "Не найдено."


class PageOutOfRange(ApiError):
    status_code = status.HTTP_404_NOT_FOUND
    code = "page_out_of_range"
    message = "Страница за пределами диапазона."


def _error(code, message, http_status, *, fields=None, headers=None):
    error = {"code": code, "message": message}
    if fields:
        error["fields"] = fields
    return Response({"error": error}, status=http_status, headers=headers)


def _validation_fields(detail):
    """Поля из ``ValidationError`` DRF; ошибки без имени поля в ``fields`` не попадают."""
    if not isinstance(detail, dict):
        return None
    return {
        str(name): [str(message) for message in (messages if isinstance(messages, list) else [messages])]
        for name, messages in detail.items()
    }


def exception_handler(exc, context):
    if isinstance(exc, Http404):
        exc = exceptions.NotFound()
    elif isinstance(exc, DjangoPermissionDenied):
        exc = exceptions.PermissionDenied()

    if isinstance(exc, ApiError):
        return _error(exc.code, exc.message, exc.status_code, fields=exc.fields)
    if isinstance(exc, exceptions.MethodNotAllowed):
        return _error("method_not_allowed", "Метод не поддерживается.", status.HTTP_405_METHOD_NOT_ALLOWED)
    if isinstance(exc, exceptions.NotAcceptable):
        return _error("not_acceptable", "Доступен только JSON.", status.HTTP_406_NOT_ACCEPTABLE)
    if isinstance(exc, exceptions.NotFound):
        return _error(ObjectNotFound.code, ObjectNotFound.message, status.HTTP_404_NOT_FOUND)
    if isinstance(exc, (exceptions.NotAuthenticated, exceptions.AuthenticationFailed)):
        # DRF отдаёт 401 только при заголовке WWW-Authenticate, иначе понижает до 403.
        auth_header = getattr(exc, "auth_header", None)
        if auth_header:
            return _error(
                "not_authenticated", "Требуется вход.", status.HTTP_401_UNAUTHORIZED,
                headers={"WWW-Authenticate": auth_header},
            )
        return _error("permission_denied", "Доступ запрещён.", status.HTTP_403_FORBIDDEN)
    if isinstance(exc, exceptions.PermissionDenied):
        return _error("permission_denied", "Доступ запрещён.", status.HTTP_403_FORBIDDEN)
    if isinstance(exc, exceptions.APIException) and exc.status_code == status.HTTP_400_BAD_REQUEST:
        fields = _validation_fields(exc.detail) if isinstance(exc, exceptions.ValidationError) else None
        return _error(ApiError.code, ApiError.message, status.HTTP_400_BAD_REQUEST, fields=fields)

    response = drf_exception_handler(exc, context)
    if response is not None and response.status_code < 500:
        return response
    return _error("internal_error", "Внутренняя ошибка сервера.", status.HTTP_500_INTERNAL_SERVER_ERROR)
