"""Request parsing and error boundaries used only by the new local API."""
import json

from django.conf import settings
from django.db import InterfaceError, OperationalError
from rest_framework.parsers import BaseParser, MultiPartParser
from rest_framework.renderers import JSONRenderer
from rest_framework.views import APIView

from accounts.access import LocalOrSignedIn, SessionUserAuthentication, request_user
from config.exceptions import InvalidRequest, RecognitionApiError


def request_owner(request):
    """request_owner(request) -> User; whose receipts and photos the request works with.

    The former name of ``accounts.access.request_user``: the signed-in user, in
    ``local_single`` — ``local``.
    """
    return request_user(request)


class LimitedStream:
    def __init__(self, stream, limit):
        self.stream, self.limit, self.used = stream, limit, 0

    def read(self, size=-1):
        remaining = self.limit - self.used + 1
        data = self.stream.read(remaining if size < 0 else min(size, remaining))
        self.used += len(data)
        if self.used > self.limit:
            raise RecognitionApiError("upload_too_large")
        return data

    def readline(self, size=-1):
        remaining = self.limit - self.used + 1
        data = self.stream.readline(remaining if size < 0 else min(size, remaining))
        self.used += len(data)
        if self.used > self.limit:
            raise RecognitionApiError("upload_too_large")
        return data


class BoundedMultiPartParser(MultiPartParser):
    def parse(self, stream, media_type=None, parser_context=None):
        # Includes multipart framing and non-file fields, actual bytes, not
        # UploadedFile.size or a client's claimed file size.
        limit = settings.RECEIPT_IMAGE_MAX_BYTES + 1024 * 1024
        request = parser_context["request"]
        try:
            claimed_length = int(request.META.get("CONTENT_LENGTH", "0"))
        except (ValueError, TypeError):
            raise InvalidRequest() from None
        if claimed_length > limit:
            raise RecognitionApiError("upload_too_large")
        return super().parse(
            LimitedStream(stream, limit),
            media_type, parser_context,
        )


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise InvalidRequest()
        result[key] = value
    return result


def invalid_constant(value):
    raise InvalidRequest()


class EmptyObjectParser(BaseParser):
    media_type = "application/json"

    def parse(self, stream, media_type=None, parser_context=None):
        try:
            data = stream.read(4097)
            if len(data) > 4096:
                raise InvalidRequest()
            value = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                               parse_constant=invalid_constant)
        except (UnicodeError, ValueError):
            raise InvalidRequest() from None
        if not isinstance(value, dict) or value:
            raise InvalidRequest()
        return value


class JsonObjectParser(BaseParser):
    """A JSON object of at most ``limit`` bytes without repeated keys at any level.

    Keys and values are checked by the view. Subclass to set another ``limit``.
    """

    media_type = "application/json"
    limit = 4096

    def parse(self, stream, media_type=None, parser_context=None):
        try:
            data = stream.read(self.limit + 1)
            if len(data) > self.limit:
                raise InvalidRequest()
            value = json.loads(data.decode("utf-8"), object_pairs_hook=unique_object,
                               parse_constant=invalid_constant)
        except (UnicodeError, ValueError, RecursionError):
            raise InvalidRequest() from None
        if not isinstance(value, dict):
            raise InvalidRequest()
        return value


class LocalAPIView(APIView):
    authentication_classes = [SessionUserAuthentication]
    permission_classes = [LocalOrSignedIn]
    renderer_classes = [JSONRenderer]
    parser_classes = []
    http_method_names = ["get", "head", "options"]

    def handle_exception(self, exc):
        if isinstance(exc, (OperationalError, InterfaceError)):
            exc = RecognitionApiError("database_unavailable")
        return super().handle_exception(exc)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response
