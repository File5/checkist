"""Защита от перебора пароля: счётчик неудачных входов в PostgreSQL.

Окно начинается с первой неудачи и длится ``AUTH_LOGIN_LOCK_SECONDS``. Достигнут порог —
отказ до конца окна без проверки пароля: ``AUTH_LOGIN_FAILURE_LIMIT`` на пару «логин и адрес»,
``AUTH_LOGIN_IP_FAILURE_LIMIT`` на адрес. Логин без адреса не блокируется: чужие неудачи не
закрывают вход с другого адреса. Отказанная попытка счётчик не увеличивает и окно не продлевает.

Адрес клиента — только ``config.proxy.client_address``; IPv6 сводится к сети /64.
"""
import hashlib
import ipaddress
import math
from collections import namedtuple
from datetime import timedelta

from django.conf import settings
from django.db import connection
from django.utils import timezone

from config.proxy import client_address

from .models import LoginFailure

Keys = namedtuple("Keys", "pair address")

UPSERT = """
INSERT INTO {table} AS failure (key, failures, window_started_at)
VALUES (%s, 1, %s), (%s, 1, %s)
ON CONFLICT (key) DO UPDATE SET
    failures = CASE WHEN failure.window_started_at <= %s THEN 1 ELSE failure.failures + 1 END,
    window_started_at = CASE
        WHEN failure.window_started_at <= %s THEN EXCLUDED.window_started_at ELSE failure.window_started_at
    END
"""


def now():
    return timezone.now()


def window():
    return timedelta(seconds=settings.AUTH_LOGIN_LOCK_SECONDS)


def address_bucket(address):
    """address_bucket(address) -> str; IPv4 как есть, IPv6 — сеть /64, неизвестный адрес — ``unknown``."""
    try:
        value = ipaddress.ip_address(address)
    except ValueError:
        return "unknown"
    if value.version == 6:
        if value.ipv4_mapped is not None:
            return str(value.ipv4_mapped)
        return str(ipaddress.ip_network(f"{value}/64", strict=False))
    return str(value)


def keys(request, username):
    """keys(request, username) -> Keys(pair, address); регистр логина не различается."""
    bucket = address_bucket(client_address(request))
    digest = hashlib.sha256(str(username).casefold().encode("utf-8", "surrogatepass")).hexdigest()
    return Keys(f"p:{bucket}:{digest}", f"a:{bucket}")


def retry_after(login_keys):
    """retry_after(keys) -> int; секунд до конца блокировки, ``0`` — вход разрешён. Один запрос."""
    limits = {
        login_keys.pair: settings.AUTH_LOGIN_FAILURE_LIMIT,
        login_keys.address: settings.AUTH_LOGIN_IP_FAILURE_LIMIT,
    }
    moment, seconds = now(), 0
    rows = LoginFailure.objects.filter(key__in=limits).values_list("key", "failures", "window_started_at")
    for key, failures, started_at in rows:
        left = (started_at + window() - moment).total_seconds()
        if failures >= limits[key] and left > 0:
            seconds = max(seconds, math.ceil(left))
    return seconds


def record_failure(login_keys):
    """Неудача для пары и для адреса: одна атомарная запись; просроченные строки удаляются."""
    moment = now()
    expired = moment - window()
    LoginFailure.objects.filter(window_started_at__lte=expired).delete()
    with connection.cursor() as cursor:
        cursor.execute(
            UPSERT.format(table=connection.ops.quote_name(LoginFailure._meta.db_table)),
            [login_keys.pair, moment, login_keys.address, moment, expired, expired],
        )


def reset(login_keys):
    """Успешный вход обнуляет счётчик пары; счётчик адреса остаётся."""
    LoginFailure.objects.filter(key=login_keys.pair).delete()
