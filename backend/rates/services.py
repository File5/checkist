"""Загрузка курсов Нацбанка в ``rates.Rate``: день, диапазон и ленивая догрузка свежих дней.

Ежедневное обновление — команда ``manage.py rates fetch`` (последние ``REFRESH_DAYS`` дней,
только недостающие) строкой cron на сервере; Celery beat в проекте нет. Кроме того, расчёт в
основной валюте сам догружает недостающие недавние дни (``lazy_fetch``) — не чаще раза в
``LAZY_PAUSE_SECONDS`` на все процессы, с коротким сроком ответа и до первой ошибки: если
Нацбанк недоступен, итоги считаются по последнему известному курсу. Старые траты — только
командой (``--from``/``--to`` либо ``--receipts``).
"""
import logging
import time
from datetime import timedelta

from django.conf import settings
from django.core.cache import cache
from django.db import connection, transaction
from django.utils import timezone

from . import nbrk
from .models import Rate

logger = logging.getLogger(__name__)

REFRESH_DAYS = 7
# Ленивая догрузка: только дни не старше этого от сегодняшнего; старше — команда.
LAZY_DAYS = 7
LAZY_PAUSE_SECONDS = 600
LAZY_KEY = "rates:lazy-fetch"


def store(day, items):
    """Записать курсы дня (новые и изменившиеся); число строк ``items``."""
    if not items:
        return 0
    rows = [Rate(currency=item.currency, day=day, value=item.value, quant=item.quant) for item in items]
    with transaction.atomic():
        Rate.objects.bulk_create(
            rows, update_conflicts=True, unique_fields=["currency", "day"], update_fields=["value", "quant", "fetched_at"])
    return len(rows)


def fetch_day(day, timeout=None):
    """Скачать и записать курсы ``day``; число валют (0 — на этот день курса ещё нет). Ошибка — ``nbrk.FetchError``."""
    return store(day, nbrk.fetch(day, timeout))


def stored_days(start, end):
    """Дни из ``start`` … ``end`` (включительно), за которые курсы уже есть; один запрос."""
    return set(Rate.objects.filter(day__gte=start, day__lte=end).values_list("day", flat=True).distinct())


def days_between(start, end):
    return [start + timedelta(days=offset) for offset in range((end - start).days + 1)]


def fetch_range(start, end, *, force=False, pause=0.0, report=None):
    """Курсы за каждый день ``start`` … ``end``; без ``force`` — только дней, которых ещё нет.

    Возвращает ``(загружено дней, пустых дней, ошибок)``. ``report(day, count | FetchError)`` — для
    вывода команды. ``pause`` — секунды между запросами, чтобы не торопить сайт Нацбанка.
    """
    have = set() if force else stored_days(start, end)
    loaded = empty = failed = 0
    for index, day in enumerate(day for day in days_between(start, end) if day not in have):
        if index and pause:
            time.sleep(pause)
        try:
            count = fetch_day(day)
        except nbrk.FetchError as error:
            failed += 1
            if report:
                report(day, error)
            continue
        loaded, empty = loaded + bool(count), empty + (not count)
        if report:
            report(day, count)
    return loaded, empty, failed


def auto_fetch_allowed():
    """Можно ли догружать курсы во время запроса: ``RATES_AUTO_FETCH`` и не тестовая база.

    В тестовой базе (``test_…``) — никогда: тесты в сеть не ходят, в том числе рабочие процессы
    ``--parallel``, которым раннер своих настроек не передаёт.
    """
    return settings.RATES_AUTO_FETCH and not str(connection.settings_dict.get("NAME") or "").startswith("test_")


def lazy_fetch(days, today=None):
    """Догрузить недостающие дни ``days`` не старше ``LAZY_DAYS`` от сегодня; ``True``, если что-то записано.

    Только при ``auto_fetch_allowed()``. Не чаще раза в ``LAZY_PAUSE_SECONDS`` на все процессы
    (ключ в общем кэше), до первой ошибки сети; кэш недоступен — ничего не делает.
    """
    if not auto_fetch_allowed():
        return False
    today = today or timezone.localdate()
    wanted = sorted(day for day in set(days) if today - timedelta(days=LAZY_DAYS) <= day <= today)
    if not wanted:
        return False
    try:
        if not cache.add(LAZY_KEY, 1, LAZY_PAUSE_SECONDS):
            return False
    except Exception:  # noqa: BLE001 — без кэша догрузки нет, итоги считаются по известным курсам
        logger.warning("rates: cache unavailable, lazy fetch skipped", exc_info=True)
        return False
    written = False
    for day in wanted:
        try:
            written = bool(fetch_day(day, settings.RATES_LAZY_TIMEOUT_SECONDS)) or written
        except nbrk.FetchError as error:
            logger.warning("rates: lazy fetch of %s failed: %s", day, error)
            break
    return written
