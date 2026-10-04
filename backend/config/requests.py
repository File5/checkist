"""Защита разбора клиентского запроса вне DRF; только для пространства /api/."""
import logging
import re
from urllib.parse import unquote_to_bytes

from django.core.handlers.asgi import ASGIRequest
from django.core.handlers.wsgi import WSGIRequest
from django.http import JsonResponse
from django.middleware.common import CommonMiddleware
from django.utils.http import parse_header_parameters

from .exceptions import InvalidRequest, REQUEST_ERRORS

_BAD_PERCENT = re.compile(rb"%(?![0-9a-fA-F]{2})")


def is_api_path(path):
    return path == "/api" or path.startswith("/api/")


def invalid_request_response():
    return JsonResponse({"error": {"code": InvalidRequest.code, "message": InvalidRequest.message}}, status=400)


class SafeContentTypeMixin:
    def _set_content_type_params(self, meta):
        # Django вызывает это из конструктора WSGI/ASGIRequest, до middleware.
        # Ловим только ошибки разбора данного заголовка, а не ошибки всего handler.
        if not is_api_path(self.path_info):
            return super()._set_content_type_params(meta)
        try:
            self.content_type, self.content_params = parse_header_parameters(meta.get("CONTENT_TYPE", ""))
        except (LookupError, UnicodeError, ValueError):
            self.invalid_content_type = True
            self.content_type, self.content_params = "", {}
        # Read-only API не разбирает body. Setter encoding в Django читает GET
        # уже в конструкторе; charset тела не должен запускать этот разбор.
        self._encoding = "utf-8"


class SafeWSGIRequest(SafeContentTypeMixin, WSGIRequest):
    pass


class SafeASGIRequest(SafeContentTypeMixin, ASGIRequest):
    def __init__(self, scope, body_file):
        # ASGIRequest декодирует query bytes до middleware. Сохраняем отказ
        # именно этого декодирования; ошибки остальных частей конструктора не ловим.
        raw_query = scope.get("query_string", b"")
        if is_api_path(scope["path"]) and isinstance(raw_query, bytes):
            try:
                raw_query.decode("utf-8", errors="strict")
            except UnicodeError:
                self.invalid_query_string = True
                scope = {**scope, "query_string": b""}
        super().__init__(scope, body_file)


class ApiCommonMiddleware(CommonMiddleware):
    """CommonMiddleware с безопасным отказом разбора API до DRF/Params."""

    def process_request(self, request):
        if not is_api_path(request.path_info):
            return super().process_request(request)
        try:
            request.get_host()  # DisallowedHost не должен дойти до Django security log.
            if getattr(request, "invalid_content_type", False) or getattr(request, "invalid_query_string", False):
                return invalid_request_response()
            # Content-Type тела не определяет кодировку query read-only API.
            if request.encoding != "utf-8":
                request.encoding = "utf-8"
            try:
                request.path_info.encode("utf-8", errors="strict")
                if hasattr(request, "scope"):
                    raw_query = request.scope.get("query_string", b"")
                else:
                    raw_query = request.META.get("QUERY_STRING", "").encode("iso-8859-1")
                if _BAD_PERCENT.search(raw_query):
                    return invalid_request_response()
                unquote_to_bytes(raw_query).decode("utf-8", errors="strict")
                for token in request.META.get("HTTP_ACCEPT", "*/*").split(","):
                    parse_header_parameters(token)
            except (LookupError, UnicodeError, ValueError):
                return invalid_request_response()
            # Не пытаемся сохранить тело через APPEND_SLASH (DEBUG иначе даёт RuntimeError).
            if request.method not in ("GET", "HEAD", "OPTIONS") and self.should_redirect_with_slash(request):
                return invalid_request_response()
            return super().process_request(request)
        except REQUEST_ERRORS:
            return invalid_request_response()

    def process_exception(self, request, exception):
        if is_api_path(request.path_info) and isinstance(exception, REQUEST_ERRORS):
            return invalid_request_response()
        return None


class SafeApiTargetFilter(logging.Filter):
    """runserver не пишет query/идентификаторы API в access log, в том числе при 400."""

    def filter(self, record):
        if isinstance(record.args, tuple) and record.args and isinstance(record.args[0], str):
            parts = record.args[0].split()
            if len(parts) >= 2 and is_api_path(parts[1].split("?", 1)[0]):
                record.args = (f"{parts[0]} /api/[redacted] {' '.join(parts[2:])}", *record.args[1:])
        return True
