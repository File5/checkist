"""Чьи регулярные платежи видит и правит запрос — как лимиты бюджета (``budget.access``).

С семьёй платежи общие на семью, без семьи — свои; в ``local_single`` — пользователя
``local``. Траты для сверки — ``accounts.access.visible_receipts_q``: вся семья, без
скрытых платежей. ``as_request(user)`` — те же правила для кода без HTTP-запроса
(``recurring.services.unpaid``).
"""
from budget.access import limit_owner, limits_q


class _UserRequest:
    """Запрос без HTTP: правила ``accounts.access`` читают только ``user``."""

    def __init__(self, user):
        self.user = user


def as_request(user):
    return _UserRequest(user)


def owner_fields(request):
    """Поля владельца нового платежа: ``household`` либо ``user``."""
    return limit_owner(request)


def payments_q(request, prefix=""):
    """Платежи (и скрытые предложения), которые запрос видит и правит."""
    return limits_q(request, prefix)
