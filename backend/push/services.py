"""Отправка web push: настройки человека, тишина, без повторов.

``notify(user, kind, title, body, url, key)`` — единственный вход для поводов: выключенный повод,
человек без устройств или выключенный на сервере push (нет ключей VAPID) — ничего; тот же
``(user, kind, key)`` второй раз — ничего; в тишину 22:00–9:00 (``LOCAL_TZ``) уведомление
записывается и уходит в 9:00 со следующим ``flush`` (``manage.py push tick``).

Шифрование и подпись — ``pywebpush``; ответ 404/410 push-сервиса удаляет подписку устройства.
"""
import json
import logging
from datetime import datetime, time, timedelta
from decimal import ROUND_UP, Decimal
from zoneinfo import ZoneInfo

import requests
from django.conf import settings
from django.utils import timezone
from pywebpush import WebPushException, webpush

from .models import PushNotification, PushSettings, PushSubscription

logger = logging.getLogger(__name__)

# ``TIME_ZONE`` сервера — UTC; часы людей — Алматы.
LOCAL_TZ = ZoneInfo("Asia/Almaty")
QUIET_FROM, QUIET_TO = 22, 9
KINDS = ("recurring", "limits", "weekly", "monthly", "large")
# Устройство не в сети — push-сервис держит уведомление сутки.
TTL_SECONDS = 86400
TIMEOUT_SECONDS = 10
SYMBOLS = {"KZT": "₸", "RUB": "₽", "USD": "$", "EUR": "€", "GBP": "£", "CNY": "¥", "TRY": "₺"}
NBSP = " "


def configured():
    return bool(settings.WEBPUSH_VAPID_PUBLIC_KEY and settings.WEBPUSH_VAPID_PRIVATE_KEY
                and settings.WEBPUSH_VAPID_SUBJECT)


def preferences(user):
    return PushSettings.objects.filter(user=user).first() or PushSettings(user=user)


def money(amount, currency):
    """«9 822 ₸»: целые, вверх по модулю — как ``formatMoney`` клиента."""
    whole = int(Decimal(amount).to_integral_value(rounding=ROUND_UP))
    digits = f"{abs(whole):,}".replace(",", NBSP)
    return f"{'-' if whole < 0 else ''}{digits}{NBSP}{SYMBOLS.get(currency, currency)}"


def release_at(now):
    """Когда можно показать уведомление, созданное в ``now``: сразу либо в 9:00 после тишины."""
    local = now.astimezone(LOCAL_TZ)
    if QUIET_TO <= local.hour < QUIET_FROM:
        return now
    day = local.date() + timedelta(days=1) if local.hour >= QUIET_FROM else local.date()
    return datetime.combine(day, time(QUIET_TO), tzinfo=LOCAL_TZ)


def _push(subscription, payload, ttl):
    """``True`` — push-сервис принял; 404/410 — устройство отписалось, подписка удаляется."""
    try:
        webpush(
            subscription_info={"endpoint": subscription.endpoint,
                               "keys": {"p256dh": subscription.p256dh, "auth": subscription.auth}},
            data=payload, vapid_private_key=settings.WEBPUSH_VAPID_PRIVATE_KEY,
            vapid_claims={"sub": settings.WEBPUSH_VAPID_SUBJECT}, ttl=ttl, timeout=TIMEOUT_SECONDS)
        return True
    except WebPushException as error:
        if error.status_code in (404, 410):
            subscription.delete()
        else:
            logger.warning("push: %s answered %s", subscription.endpoint.split("/")[2], error.status_code)
    except (requests.RequestException, ValueError) as error:
        logger.warning("push: %s failed: %s", subscription.endpoint.split("/")[2], type(error).__name__)
    return False


def send(user, title, body, url, ttl=TTL_SECONDS):
    """Сразу на все устройства ``user``, без настроек и тишины; число принявших устройств."""
    payload = json.dumps({"title": title, "body": body, "url": url}, ensure_ascii=False)
    return sum(_push(item, payload, ttl) for item in list(PushSubscription.objects.filter(user=user)))


def _deliver(notification, now):
    # Захват строкой UPDATE: два одновременных тика не отправят одно уведомление дважды.
    claimed = PushNotification.objects.filter(pk=notification.pk, sent_at__isnull=True).update(sent_at=now)
    if claimed:
        send(notification.user, notification.title, notification.body, notification.url)
    return bool(claimed)


def notify(user, kind, title, body, url, key, *, now=None):
    """Уведомить ``user`` о поводе ``kind`` (``KINDS``) один раз на ``key``; ``PushNotification`` либо ``None``."""
    now = now or timezone.now()
    if (not configured() or not getattr(preferences(user), kind)
            or not PushSubscription.objects.filter(user=user).exists()):
        return None
    notification, created = PushNotification.objects.get_or_create(
        user=user, kind=kind, key=key[:100],
        defaults={"title": title[:200], "body": body[:500], "url": url[:300], "send_after": release_at(now)})
    if not created:
        return None
    if notification.send_after <= now:
        _deliver(notification, now)
    return notification


def flush(now=None):
    """Отправить отложенные тишиной; число отправленных уведомлений."""
    now = now or timezone.now()
    due = PushNotification.objects.filter(sent_at__isnull=True, send_after__lte=now).select_related("user")
    return sum(_deliver(notification, now) for notification in list(due))
