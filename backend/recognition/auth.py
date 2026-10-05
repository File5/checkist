"""Explicit anonymous CSRF and local-only permission for the v1 HTTP API."""
import ipaddress

from django.conf import settings
from django.http import QueryDict
from rest_framework.authentication import CSRFCheck
from rest_framework.permissions import BasePermission, SAFE_METHODS

from config.exceptions import RecognitionApiError


class LocalRecognitionPermission(BasePermission):
    def has_permission(self, request, view):
        try:
            local = ipaddress.ip_address(request.META.get("REMOTE_ADDR", "")).is_loopback
        except ValueError:
            local = False
        if not (settings.DEBUG and settings.ALLOW_LOCAL_RECOGNITION_API and local):
            raise RecognitionApiError("permission_denied")
        if request.method not in SAFE_METHODS:
            enforce_csrf(request._request)
        return True


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
