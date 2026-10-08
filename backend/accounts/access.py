"""Who the request belongs to and whether it may pass: the single point of access rules.

``settings.CHECKIST_AUTH_MODE`` is read on every call, so ``override_settings`` works:

- ``accounts`` — the user of the Django session (shared with ``/admin/``); without one the
  API answers ``401 not_authenticated`` with ``WWW-Authenticate: Session``;
- ``local_single`` — no sign-in, every request belongs to the user ``local``; the local API
  keeps its DEBUG + flag + loopback rule.

Views read neither ``request.user`` nor the setting: they take ``request_user``,
``owner_q`` and ``is_moderator`` from here.
"""
import ipaddress

from django.conf import settings
from django.db.models import Q
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import NotAuthenticated
from rest_framework.permissions import SAFE_METHODS, BasePermission

from config.exceptions import RecognitionApiError
from receipts.ownership import LOCAL_USERNAME, local_user
from recognition.auth import enforce_csrf

ACCOUNTS = "accounts"
LOCAL_SINGLE = "local_single"
MODERATE_CATALOG = "catalog.moderate_catalog"


def mode():
    """mode() -> "accounts" | "local_single"."""
    return settings.CHECKIST_AUTH_MODE


def _django_request(request):
    # A DRF request wraps the Django one; plain Django views pass the latter directly.
    return getattr(request, "_request", request)


def request_user(request):
    """request_user(request) -> User; whose receipts and photos the request works with.

    ``accounts``: the user of the request — a real one after the permission check.
    ``local_single``: ``local_user()``, read once per request.
    """
    if mode() != LOCAL_SINGLE:
        return request.user
    base = _django_request(request)
    user = getattr(base, "_checkist_local_user", None)
    if user is None:
        user = base._checkist_local_user = local_user()
    return user


def owner_q(request, prefix=""):
    """owner_q(request, prefix="") -> Q; rows of the request's user.

    ``prefix`` is the path to the model with ``owner``: ``"receipt__"`` from a line,
    ``"photo__"`` from a job or a receipt image, ``"receipts__"`` from a store.
    ``local_single`` filters by the username through a JOIN, without a query for the user.
    An anonymous request in ``accounts`` matches nothing: ``owner`` is never NULL.
    """
    if mode() == LOCAL_SINGLE:
        return Q(**{f"{prefix}owner__username": LOCAL_USERNAME})
    return Q(**{f"{prefix}owner_id": request.user.pk})


def is_moderator(request):
    """is_moderator(request) -> bool; may decide about the shared catalog.

    ``accounts``: the permission ``catalog.moderate_catalog`` of an active user (a superuser
    has it). ``local_single``: always.
    """
    if mode() == LOCAL_SINGLE:
        return True
    return bool(request.user.has_perm(MODERATE_CATALOG))


def _signed_in(request):
    user = request.user
    return bool(user and user.is_authenticated and user.is_active)


def _local(request):
    try:
        loopback = ipaddress.ip_address(request.META.get("REMOTE_ADDR", "")).is_loopback
    except ValueError:
        loopback = False
    return bool(settings.DEBUG and settings.ALLOW_LOCAL_RECOGNITION_API and loopback)


class SessionUserAuthentication(BaseAuthentication):
    """The active user of the Django session; nobody in ``local_single``.

    CSRF is not checked here: the permission does it for unsafe methods in both modes.
    """

    def authenticate(self, request):
        if mode() == LOCAL_SINGLE:
            # The session is not read: the request costs the same queries as before.
            return None
        user = getattr(request._request, "user", None)
        if user is None or not user.is_authenticated or not user.is_active:
            return None
        return user, None

    def authenticate_header(self, request):
        # With this header the error handler answers 401 not_authenticated instead of 403.
        return "Session"


class SignedIn(BasePermission):
    """``accounts``: a signed-in user, otherwise ``401``. ``local_single``: everyone."""

    def has_permission(self, request, view):
        if mode() != LOCAL_SINGLE and not _signed_in(request):
            raise NotAuthenticated()
        return True


class LocalOrSignedIn(BasePermission):
    """``accounts``: a signed-in user. ``local_single``: DEBUG + flag + loopback ``REMOTE_ADDR``.

    An unsafe method also needs CSRF, the anonymous ``local_single`` included.
    Refusals in order: ``401 not_authenticated`` (``accounts``) or ``403 permission_denied``
    (``local_single``), then ``403 csrf_failed``.
    """

    def has_permission(self, request, view):
        if mode() == LOCAL_SINGLE:
            if not _local(request):
                raise RecognitionApiError("permission_denied")
        elif not _signed_in(request):
            raise NotAuthenticated()
        if request.method not in SAFE_METHODS:
            enforce_csrf(request._request)
        return True


class Moderator(LocalOrSignedIn):
    """``LocalOrSignedIn`` plus ``is_moderator``, otherwise ``403 permission_denied``."""

    def has_permission(self, request, view):
        super().has_permission(request, view)
        if not is_moderator(request):
            raise RecognitionApiError("permission_denied")
        return True
