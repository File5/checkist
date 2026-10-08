"""Explicit CSRF check of the v1 HTTP API; the access rules live in ``accounts.access``."""
from django.http import QueryDict
from rest_framework.authentication import CSRFCheck

from config.exceptions import RecognitionApiError


def enforce_csrf(request):
    # API accepts the token only in X-CSRFToken. Prevent Django's form-token
    # fallback from parsing a potentially large multipart body before permission.
    # Cookie, header token, Origin and HTTPS Referer checks remain Django's own.
    previous = getattr(request, "_post", None)
    had_post = hasattr(request, "_post")
    request._post = QueryDict()
    try:
        check = CSRFCheck(lambda req: None)
        check.process_request(request)
        reason = check.process_view(request, None, (), {})
    finally:
        if had_post:
            request._post = previous
        else:
            del request._post
    if reason:
        raise RecognitionApiError("csrf_failed")


def __getattr__(name):
    # The former name of the permission. Resolved on access: ``accounts.access`` imports
    # ``enforce_csrf`` from this module.
    if name == "LocalRecognitionPermission":
        from accounts.access import LocalOrSignedIn
        return LocalOrSignedIn
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
