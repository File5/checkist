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

from accounts import profile
from accounts.access import (
    LOCAL_SINGLE, LocalOrSignedIn, SignedIn, household, is_head, is_moderator, mode, request_user,
)
from accounts.models import Membership
from accounts.people import display_name, household_people
from config.exceptions import AuthApiError, InvalidParameter, InvalidRequest, ObjectNotFound, PasswordRejected
from push import services as push
from rates.convert import request_base_currency
from recognition.auth import enforce_csrf

from stores.models import Currency

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


def household_object(request):
    """Семья пользователя запроса либо ``None``.

    ``{"id", "name", "members": [логины по алфавиту], "people": [{"username", "display_name"}]}``:
    ``people`` — те же люди в том же порядке с именем для показа (``accounts.people``);
    ``head`` — логин главного в семье либо ``null``, пока администратор его не назначил.
    """
    family = household(request)
    if family is None:
        return None
    people = household_people(family)
    head = (Membership.objects.filter(household=family, role=Membership.Role.HEAD)
            .values_list("user__username", flat=True).first())
    return {"id": family.pk, "name": family.name, "members": [item["username"] for item in people], "people": people,
            "head": head}


def settings_object(user):
    """Настройки пользователя: ``{"default_currency": код | null}``."""
    return {"default_currency": profile.default_currency(user)}


def me_object(request):
    """Объект «Я»: режим, пользователь запроса, его семья, права и токен CSRF текущей сессии."""
    user = request_user(request)
    return {
        "mode": mode(),
        "user": {"id": user.pk, "username": user.get_username(), "display_name": display_name(user),
                 "is_staff": user.is_staff},
        "household": household_object(request),
        "permissions": {"moderate_catalog": is_moderator(request)},
        "is_head": is_head(request),
        "settings": settings_object(user),
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


class SettingsView(LocalAPIView):
    """``GET`` — настройки и известные серверу валюты; ``PATCH`` — правка, ответ как у ``GET``.

    Тело ``PATCH`` — объект с полями настроек (сейчас одно: ``default_currency`` — код валюты
    либо ``null``); неизвестное поле, чужой код — ``400 invalid_parameter``.
    """

    http_method_names = ["get", "patch", "head", "options"]
    parser_classes = [JsonObjectParser]

    def get_permissions(self):
        if self.request.method in SAFE_METHODS:
            return [SignedIn()]
        return [LocalOrSignedIn()]

    def answer(self, request):
        currencies = [{"code": code, "name": name} for code, name in Currency.objects.order_by("code").values_list("code", "name")]
        # base_currency — основная валюта семьи (главного; без семьи — своя): в ней итоги и лимиты (rates.convert).
        return Response({**settings_object(request_user(request)), "currencies": currencies,
                         "base_currency": request_base_currency(request)})

    def get(self, request):
        return self.answer(request)

    def patch(self, request):
        if request.content_type != "application/json":
            raise UnsupportedMediaType(request.content_type)
        if request._request.META.get("CONTENT_LENGTH") in (None, "", "0"):
            raise InvalidRequest()
        try:
            data = request.data
        except ParseError:
            raise InvalidRequest() from None
        if not isinstance(data, dict):
            raise InvalidRequest()
        errors = {key: ["Неизвестное поле."] for key in data if key != "default_currency"}
        changes = {}
        if "default_currency" in data:
            code = data["default_currency"]
            if code is None:
                changes["default_currency"] = None
            elif isinstance(code, str) and Currency.objects.filter(code=code.upper()).exists():
                changes["default_currency"] = code.upper()
            else:
                errors["default_currency"] = ["Неизвестная валюта."]
        if errors:
            raise InvalidParameter(errors)
        profile.save(request_user(request), **changes)
        return self.answer(request)


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
        session_key = request._request.session.session_key
        update_session_auth_hash(request._request, account)
        # Новый ключ сессии: уведомления этого устройства остаются (push.services.signed_in).
        push.session_moved(session_key, request._request.session.session_key)
        request.user = account
        return Response(me_object(request))
