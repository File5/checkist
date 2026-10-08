"""Адрес клиента с учётом обратного прокси; единственный источник для счётчиков по адресу."""
import ipaddress

from django.conf import settings


def _address(value):
    try:
        return str(ipaddress.ip_address(value.strip()))
    except (AttributeError, ValueError):
        return ""


def client_address(request):
    """IP клиента строкой в каноничной записи либо "", если адрес неизвестен.

    Без settings.TRUST_PROXY — всегда REMOTE_ADDR: заголовок присылает сам клиент.
    С доверием — последний элемент X-Forwarded-For: его дописывает прокси перед Django,
    значения левее клиент подделывает. Невалидный последний элемент — REMOTE_ADDR.
    """
    remote = _address(request.META.get("REMOTE_ADDR", ""))
    if not settings.TRUST_PROXY:
        return remote
    forwarded = request.META.get("HTTP_X_FORWARDED_FOR", "")
    return _address(forwarded.rsplit(",", 1)[-1]) or remote
