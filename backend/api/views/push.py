"""Уведомления (``/api/push/``): устройства человека, его включатели поводов и проверочное уведомление.

Доступ — как у трат: ``accounts`` — вход, ``local_single`` — DEBUG + флаг + loopback; запись — с CSRF.
Всё своё: устройства и включатели — только пользователя запроса. Без ключей VAPID на сервере
подписка и проверочное отвечают ``409 push_not_configured``, а ``GET`` — ``configured: false``.
"""
import re
from decimal import Decimal
from urllib.parse import urlsplit

from django.conf import settings
from django.db import transaction
from django.utils.crypto import constant_time_compare
from rest_framework.response import Response

from accounts.access import request_user
from config.exceptions import InvalidParameter, RecognitionApiError
from push import services
from push.models import PushSettings, PushSubscription
from rates.convert import request_base_currency

from .. import common
from .receipts import manual_body
from .recognition_base import JsonObjectParser, LocalAPIView

# Push-сервисы браузеров: Chrome/Edge/Samsung — FCM, Firefox — Mozilla, Safari — Apple, старый Edge — WNS.
# Сервер шлёт POST только туда: адрес подписки не уводит запрос во внутреннюю сеть.
PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com",
              "notify.windows.com")
_KEY = re.compile(r"[A-Za-z0-9_-]+={0,2}")
_AMOUNT = re.compile(r"[0-9]{1,12}(\.[0-9]{1,2})?")
UNKNOWN = "Неизвестное поле."


def state(request):
    user = request_user(request)
    prefs = services.preferences(user)
    configured = services.configured()
    return {
        "configured": configured,
        "public_key": settings.WEBPUSH_VAPID_PUBLIC_KEY if configured else None,
        "devices": PushSubscription.objects.filter(user=user).count(),
        "base_currency": request_base_currency(request),
        "settings": {**{kind: getattr(prefs, kind) for kind in services.KINDS},
                     "large_threshold": common.amount(prefs.large_threshold)},
    }


def _threshold(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return None
    text = str(value).strip().replace(",", ".")
    if not _AMOUNT.fullmatch(text) or Decimal(text) <= 0:
        return None
    return Decimal(text)


def _push_host(endpoint):
    try:
        parts = urlsplit(endpoint)
    except ValueError:
        return False
    host = parts.hostname or ""
    return (parts.scheme == "https" and parts.port is None and not parts.username
            and any(host == name or host.endswith("." + name) for name in PUSH_HOSTS))


def _subscription(data):
    """``{endpoint, keys: {p256dh, auth}}`` — как ``PushSubscription.toJSON()`` браузера."""
    errors = {key: [UNKNOWN] for key in data if key not in ("endpoint", "keys", "expirationTime")}
    endpoint, keys = data.get("endpoint"), data.get("keys")
    if not (isinstance(endpoint, str) and len(endpoint) <= 2048 and _push_host(endpoint)):
        errors["endpoint"] = ["Адрес push-сервиса браузера."]
    if not (isinstance(keys, dict) and set(keys) == {"p256dh", "auth"}
            and all(isinstance(keys[name], str) and _KEY.fullmatch(keys[name]) for name in keys)
            and len(keys["p256dh"]) <= 200 and len(keys["auth"]) <= 100):
        errors["keys"] = ["Ключи подписки p256dh и auth."]
    if errors:
        raise InvalidParameter(errors)
    return endpoint, keys


def _configured():
    if not services.configured():
        raise RecognitionApiError("push_not_configured")


class PushView(LocalAPIView):
    """``GET`` — состояние и включатели; ``PATCH`` — включатели и порог крупной траты, ответ как у ``GET``."""

    http_method_names = ["get", "patch", "head", "options"]
    parser_classes = [JsonObjectParser]

    def get(self, request):
        return Response(state(request))

    def patch(self, request):
        data = manual_body(request)
        errors, values = {}, {}
        for key, value in data.items():
            if key in services.KINDS:
                values[key] = value
                if not isinstance(value, bool):
                    errors[key] = ["Включатель — true или false."]
            elif key == "large_threshold":
                values[key] = _threshold(value)
                if values[key] is None:
                    errors[key] = ["Сумма больше нуля, не больше двух знаков после запятой."]
            else:
                errors[key] = [UNKNOWN]
        if errors or not values:
            raise InvalidParameter(errors or {"body": ["Укажите хотя бы одно поле."]})
        PushSettings.objects.update_or_create(user=request_user(request), defaults=values)
        return Response(state(request))


class SubscribeView(LocalAPIView):
    """Подписка этого устройства за пользователем запроса и его сессией входа.

    Подписка с тем же ``endpoint`` у другого человека переходит к нему только с теми же ключами ``p256dh`` и
    ``auth`` — их знает лишь браузер этого устройства; иначе ``400`` у ``keys``, подписка не меняется.
    """

    http_method_names = ["post", "options"]
    parser_classes = [JsonObjectParser]

    def post(self, request):
        _configured()
        endpoint, keys = _subscription(manual_body(request))
        user = request_user(request)
        with transaction.atomic():
            found = PushSubscription.objects.select_for_update().filter(endpoint=endpoint).first()
            if found is not None and found.user_id != user.pk and not constant_time_compare(
                    f"{found.p256dh}.{found.auth}", f"{keys['p256dh']}.{keys['auth']}"):
                raise InvalidParameter({"keys": ["Ключи не совпадают с подпиской этого устройства."]})
            PushSubscription.objects.update_or_create(endpoint=endpoint, defaults={
                "user": user, **keys, "session_key": request._request.session.session_key})
        return Response(state(request))


class UnsubscribeView(LocalAPIView):
    """Отписать устройство по ``endpoint``; чужое и уже отписанное — ничего."""

    http_method_names = ["post", "options"]
    parser_classes = [JsonObjectParser]

    def post(self, request):
        data = manual_body(request)
        endpoint = data.get("endpoint")
        if set(data) != {"endpoint"} or not isinstance(endpoint, str):
            raise InvalidParameter({"endpoint": ["Адрес push-сервиса браузера."]})
        PushSubscription.objects.filter(user=request_user(request), endpoint=endpoint).delete()
        return Response(state(request))


class PushTestView(LocalAPIView):
    """Проверочное уведомление сразу на все устройства человека, без тишины; ``{"sent": число устройств}``."""

    http_method_names = ["post", "options"]

    def post(self, request):
        _configured()
        sent = services.send(request_user(request), "Проверка уведомлений",
                             "Если вы это видите — уведомления работают.", "/account", ttl=600)
        return Response({**state(request), "sent": sent})
