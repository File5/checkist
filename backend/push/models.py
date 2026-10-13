"""Web push: устройства человека, его включатели поводов и журнал отправленного (он же очередь тишины)."""
from decimal import Decimal

from django.conf import settings
from django.db import models
from django.db.models import Q

LARGE_THRESHOLD = Decimal("100000.00")


class PushSubscription(models.Model):
    """Подписка Push API одного устройства (браузера); ``endpoint`` — адрес push-сервиса, ключи — шифрование."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="push_subscriptions")
    endpoint = models.CharField(max_length=2048, unique=True)
    p256dh = models.CharField(max_length=200)
    auth = models.CharField(max_length=100)
    created_at = models.DateTimeField(auto_now_add=True)


class PushSettings(models.Model):
    """Включатели поводов человека; строки нет — значения по умолчанию (крупная трата выключена)."""

    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="push_settings")
    recurring = models.BooleanField(default=True)
    limits = models.BooleanField(default=True)
    weekly = models.BooleanField(default=True)
    monthly = models.BooleanField(default=True)
    large = models.BooleanField(default=False)
    # В основной валюте семьи (``rates.convert``).
    large_threshold = models.DecimalField(max_digits=14, decimal_places=2, default=LARGE_THRESHOLD)


class PushNotification(models.Model):
    """Уведомление повода: одно на ``(user, kind, key)``; ``sent_at`` пуст — ждёт ``send_after`` (тишина)."""

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="push_notifications")
    kind = models.CharField(max_length=16)
    key = models.CharField(max_length=100)
    title = models.CharField(max_length=200)
    body = models.CharField(max_length=500)
    url = models.CharField(max_length=300)
    created_at = models.DateTimeField(auto_now_add=True)
    send_after = models.DateTimeField()
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["user", "kind", "key"], name="push_notification_once")]
        indexes = [models.Index(fields=["send_after"], condition=Q(sent_at__isnull=True), name="push_pending_idx")]
