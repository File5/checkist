"""ИИ у семьи: включатель и дневная квота запросов к модели — единственная точка правила.

Фото чеков, «Трата словами» и всё, что отправляет данные семьи внешней модели, перед постановкой
в очередь вызывает ``use_ai(user)``: запрос считается, отказ — исключение ``AiRefused`` (это ошибка
API: вью его не ловят, ответ строит общий обработчик).

- ``local_single`` и пользователь без семьи — можно всегда, без счёта (один человек, прежнее поведение);
- семья с ``Household.ai_enabled = False`` — ``403 ai_disabled`` (включает главный на «Семье»);
- больше ``Household.ai_daily_limit`` запросов семьи за сутки — ``429 ai_quota`` с ``resets_at``
  (начало следующих суток, UTC ISO 8601) и ``Retry-After``. Сутки — ``timezone.localdate()``
  (``TIME_ZONE`` сервера — UTC): в полночь UTC счёт начинается с нуля.

``ai_allowed(user)`` только читает (включено и квота не исчерпана) — для решения «спрашивать ли
модель»; сам запрос всё равно идёт через ``use_ai``.
"""
import math
from datetime import datetime, time, timedelta

from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework import status

from accounts.models import AiUsage, Household
from api.common import utc_datetime
from config.exceptions import ApiError


class AiRefused(ApiError):
    """``ai_disabled`` (403) либо ``ai_quota`` (429, рядом с ``error`` — ``resets_at``)."""

    ERRORS = {
        "ai_disabled": (status.HTTP_403_FORBIDDEN, "ИИ выключен в вашей семье: включить может главный."),
        "ai_quota": (status.HTTP_429_TOO_MANY_REQUESTS, "На сегодня запросы к ИИ закончились."),
    }

    def __init__(self, code, *, resets_at=None):
        self.code = code
        self.status_code, self.message = self.ERRORS[code]
        if resets_at is not None:
            seconds = max(1, math.ceil((resets_at - timezone.now()).total_seconds()))
            self.extra = {"resets_at": utc_datetime(resets_at)}
            self.headers = {"Retry-After": str(seconds)}
        super().__init__()


def resets_at(day=None):
    """Начало суток после ``day`` (по умолчанию — сегодня) в часовом поясе сервера."""
    day = day or timezone.localdate()
    return timezone.make_aware(datetime.combine(day + timedelta(days=1), time.min))


def household_of(user):
    """Семья пользователя либо ``None``: в ``local_single``, без семьи, без пользователя."""
    from accounts.access import LOCAL_SINGLE, mode

    if mode() == LOCAL_SINGLE or user is None or user.pk is None:
        return None
    return Household.objects.filter(memberships__user_id=user.pk).first()


def used_today(household):
    return (AiUsage.objects.filter(household=household, day=timezone.localdate())
            .values_list("count", flat=True).first()) or 0


def ai_allowed(user):
    """ai_allowed(user) -> bool; можно ли сейчас спрашивать модель. Ничего не считает."""
    family = household_of(user)
    if family is None:
        return True
    return family.ai_enabled and used_today(family) < family.ai_daily_limit


def use_ai(user):
    """Один запрос семьи к модели: счёт +1 либо ``AiRefused``. Без семьи — ничего.

    Прибавка идёт одним ``UPDATE … WHERE count < limit``: одновременные запросы квоту не обходят.
    Внутри внешней транзакции счёт откатывается вместе с ней.
    """
    family = household_of(user)
    if family is None:
        return
    if not family.ai_enabled:
        raise AiRefused("ai_disabled")
    day = timezone.localdate()
    with transaction.atomic():
        AiUsage.objects.get_or_create(household=family, day=day)
        counted = (AiUsage.objects.filter(household=family, day=day, count__lt=family.ai_daily_limit)
                   .update(count=F("count") + 1))
    if not counted:
        raise AiRefused("ai_quota", resets_at=resets_at(day))


def status_object(household):
    """Состояние ИИ семьи для «Семьи»: ``{"enabled", "daily_limit", "used_today", "resets_at"}``."""
    return {"enabled": household.ai_enabled, "daily_limit": household.ai_daily_limit,
            "used_today": used_today(household), "resets_at": utc_datetime(resets_at())}


def set_enabled(household, enabled):
    household.ai_enabled = enabled
    household.save(update_fields=["ai_enabled"])
    return household
