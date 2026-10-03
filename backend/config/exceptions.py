from rest_framework import exceptions, status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler


def exception_handler(exc, context):
    if isinstance(exc, exceptions.MethodNotAllowed):
        code, message, http_status = (
            "method_not_allowed", "Метод не поддерживается.", status.HTTP_405_METHOD_NOT_ALLOWED
        )
    elif isinstance(exc, exceptions.NotAcceptable):
        code, message, http_status = (
            "not_acceptable", "Доступен только JSON.", status.HTTP_406_NOT_ACCEPTABLE
        )
    else:
        response = drf_exception_handler(exc, context)
        if response is not None and response.status_code < 500:
            return response
        code, message, http_status = (
            "internal_error", "Внутренняя ошибка сервера.", status.HTTP_500_INTERNAL_SERVER_ERROR
        )
    return Response({"error": {"code": code, "message": message}}, status=http_status)
