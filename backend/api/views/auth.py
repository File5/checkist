"""Вход, выход, смена своего пароля и «кто я».

Сессия — штатная Django, общая с ``/admin/``. Неудачные попытки считает
``accounts.backends.ThrottledModelBackend``: вью только читает срок блокировки с запроса.
В ``local_single`` входа нет: ``login`` / ``logout`` / ``password`` отвечают ``404``.
"""
from django.contrib.auth import authenticate, get_user_model, login, logout, update_session_auth_hash
from django.contrib.auth.password_validation import validate_password
from django.core.exceptions import ValidationError
from django.middleware.csrf import get_token
from rest_framework.exceptions import ParseError, UnsupportedMediaType
from rest_framework.permissions import SAFE_METHODS, AllowAny, BasePermission
from rest_framework.response import Response

from accounts.access import LOCAL_SINGLE, LocalOrSignedIn, SignedIn, is_moderator, mode, request_user
from config.exceptions import AuthApiError, InvalidParameter, InvalidRequest, ObjectNotFound, PasswordRejected
from recognition.auth import enforce_csrf

from .recognition_base import EmptyObjectParser, JsonObjectParser, LocalAPIView

REQUIRED = "Обязательное поле."
NOT_TEXT = "Ожидается непустая строка."
WRONG_CURRENT_PASSWORD = "Неверный текущий пароль."
# Код причины для клиента: текст. Ключи — коды валидаторов Django без приставки ``password_``.
PASSWORD_ISSUES = {
    "too_short": "Пароль слишком короткий.",
    "too_common": "Пароль слишком распространён.",
    "entirely_numeric": "Пароль не может состоять только из цифр.",
    "too_similar": "Пароль слишком похож на данные учётной записи.",
}
PASSWORD_REJECTED = "Пароль не подходит."


def me_object(request):
    """Объект «Я»: режим, пользователь запроса, его права и токен CSRF текущей сессии."""
    user = request_user(request)
    return {
        "mode": mode(),
        "user": {"id": user.pk, "username": user.get_username(), "is_staff": user.is_staff},
        "permissions": {"moderate_catalog": is_moderator(request)},
        "csrf_token": get_token(request._request),
    }


class AccountsOnly(BasePermission):
    """``local_single``: ``404``, маршрута нет. ``accounts``: всем; небезопасный метод — CSRF."""

    def has_permission(self, request, view):
        if mode() == LOCAL_SINGLE:
            raise ObjectNotFound()
        if request.method not in SAFE_METHODS:
            enforce_csrf(request._request)
        return True


class AccountsSignedIn(BasePermission):
    """``local_single``: ``404``. ``accounts``: ``401`` без входа, затем CSRF."""

    def has_permission(self, request, view):
        if mode() == LOCAL_SINGLE:
            raise ObjectNotFound()
        return LocalOrSignedIn().has_permission(request, view)


class AuthMutationView(LocalAPIView):
    permission_classes = [AccountsOnly]
    http_method_names = ["post", "options"]
    parser_classes = [JsonObjectParser]

    def body(self, request, names):
        """Объект ровно с ключами ``names``; значения — непустые строки без NUL."""
        if request.content_type != "application/json":
            raise UnsupportedMediaType(request.content_type)
        # DRF bypasses parsers for an empty body. An object is required, even then.
        if request._request.META.get("CONTENT_LENGTH") in (None, "", "0"):
            raise InvalidRequest()
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        if not isinstance(data, dict) or set(data) - set(names):
            raise InvalidRequest()
        errors = {}
        for name in names:
            if name not in data:
                errors[name] = [REQUIRED]
            elif not isinstance(data[name], str) or not data[name] or "\x00" in data[name]:
                errors[name] = [NOT_TEXT]
        if errors:
            raise InvalidParameter(errors)
        return data

    def refusal(self, request, otherwise):
        """Отказ проверки пароля: блокировка, если её поставил backend, иначе ``otherwise``."""
        seconds = getattr(request._request, "login_retry_after", None)
        return AuthApiError("login_throttled", retry_after=seconds) if seconds else otherwise


class CsrfView(LocalAPIView):
    """Токен CSRF до входа: без сессии и запросов к базе, в обоих режимах."""

    authentication_classes = []
    permission_classes = [AllowAny]

    def get(self, request):
        return Response({"csrf_token": get_token(request._request)})


class MeView(LocalAPIView):
    permission_classes = [SignedIn]

    def get(self, request):
        return Response(me_object(request))


class LoginView(AuthMutationView):
    def post(self, request):
        data = self.body(request, ("username", "password"))
        username = get_user_model().normalize_username(data["username"])
        user = authenticate(request._request, username=username, password=data["password"])
        if user is None:
            raise self.refusal(request, AuthApiError("invalid_credentials"))
        # Меняет ключ сессии и токен CSRF: новый токен клиент берёт из ответа.
        login(request._request, user)
        request.user = user
        return Response(me_object(request))


class LogoutView(AuthMutationView):
    parser_classes = [EmptyObjectParser]

    def post(self, request):
        if request.content_type != "application/json":
            raise UnsupportedMediaType(request.content_type)
        if request.data != {}:
            raise InvalidRequest()
        # DRF bypasses parsers for an empty body. {} is required, even then.
        if request._request.META.get("CONTENT_LENGTH") in (None, "", "0"):
            raise InvalidRequest()
        logout(request._request)
        return Response(status=204)


class PasswordView(AuthMutationView):
    permission_classes = [AccountsSignedIn]

    def post(self, request):
        data = self.body(request, ("current_password", "new_password"))
        # Текущий пароль проверяет тот же backend: неудачи считаются вместе с неудачами входа.
        account = authenticate(
            request._request, username=request_user(request).get_username(), password=data["current_password"],
        )
        if account is None:
            raise self.refusal(request, InvalidParameter({"current_password": [WRONG_CURRENT_PASSWORD]}))
        try:
            validate_password(data["new_password"], account)
        except ValidationError as exc:
            codes = [(error.code or "").removeprefix("password_") for error in exc.error_list]
            issues = list(dict.fromkeys(code for code in codes if code in PASSWORD_ISSUES))
            messages = [PASSWORD_ISSUES[code] for code in issues] or [PASSWORD_REJECTED]
            raise PasswordRejected({"new_password": messages}, issues) from None
        account.set_password(data["new_password"])
        account.save(update_fields=["password"])
        # Эта сессия остаётся, остальные сессии пользователя перестают действовать.
        update_session_auth_hash(request._request, account)
        request.user = account
        return Response(me_object(request))
