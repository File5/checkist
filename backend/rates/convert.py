"""Пересчёт трат в основную валюту семьи по курсу Нацбанка на дату покупки.

Основная валюта (``base_currency``) — ``Profile.default_currency`` главного в семье; у
пользователя без семьи (и в семье без главного) — своя; не выбрана — KZT. Курс валюты на дату —
последний опубликованный не позже этой даты (``Rate`` есть и на выходные), но не старше
``STALE_DAYS``: дыра в загруженных курсах не подменяется молча курсом месячной давности — такая
трата «без курса» (``None``), и экраны показывают её отдельно, а не в итоге.

Курсы Нацбанка — тенге за единицу: X → KZT умножением на курс X, X → Y через тенге
(``× курс X / курс Y``). Результат — 2 знака, половина вверх.

Для расчётов по многим тратам — ``converter(base, needs)``: все нужные курсы одним запросом,
дальше без БД. Для одной суммы — ``to_base``.
"""
import bisect
from datetime import timedelta
from decimal import Decimal

from django.db.models import Q, Subquery, Value
from django.db.models.functions import Coalesce

from receipts.decimal_math import price_context, round_decimal

from . import services
from .models import Rate

KZT = "KZT"
DEFAULT_BASE = KZT
STALE_DAYS = 7
_ONE = Decimal(1)


def _base_currency(user_q, user_id):
    """Один запрос: ``Profile.default_currency`` главного семьи пользователя ``user_q`` либо его самого."""
    from accounts.models import Membership, Profile

    family = Membership.objects.filter(user_q).values("household_id")[:1]
    head = Membership.objects.filter(household_id=Subquery(family), role=Membership.Role.HEAD).values("user_id")[:1]
    code = (Profile.objects.filter(user_id=Coalesce(Subquery(head), user_id))
            .values_list("default_currency_id", flat=True).first())
    return code or DEFAULT_BASE


def base_currency(user):
    """base_currency(user) -> str; основная валюта семьи пользователя (см. описание модуля); один запрос."""
    if user is None or user.pk is None:
        return DEFAULT_BASE
    return _base_currency(Q(user_id=user.pk), Value(user.pk))


def request_base_currency(request):
    """Основная валюта семьи пользователя запроса одним запросом (в ``local_single`` — без чтения пользователя)."""
    from django.contrib.auth import get_user_model

    from accounts.access import LOCAL_SINGLE, mode
    from receipts.ownership import LOCAL_USERNAME

    if mode() != LOCAL_SINGLE:
        return base_currency(request.user)
    local = get_user_model().objects.filter(username=LOCAL_USERNAME).values("pk")[:1]
    return _base_currency(Q(user__username=LOCAL_USERNAME), Subquery(local))


class Converter:
    """Курсы, загруженные один раз; ``rate`` и ``convert`` БД не трогают."""

    def __init__(self, base, rates=None):
        self.base = base
        # {код: ([дни по возрастанию], [тенге за единицу])}
        self._rates = rates or {}

    def rate(self, currency, day):
        """Тенге за единицу ``currency`` на ``day`` либо ``None`` (курса нет или он старше ``STALE_DAYS``)."""
        if currency == KZT:
            return _ONE
        found = self._rates.get(currency)
        if not found:
            return None
        days, values = found
        index = bisect.bisect_right(days, day) - 1
        if index < 0 or (day - days[index]).days > STALE_DAYS:
            return None
        return values[index]

    def rate_day(self, currency, day):
        """День курса, по которому считается ``day`` (последний опубликованный не позже), либо ``None``."""
        if currency == KZT:
            return day
        found = self._rates.get(currency)
        if not found:
            return None
        days, _ = found
        index = bisect.bisect_right(days, day) - 1
        return None if index < 0 or (day - days[index]).days > STALE_DAYS else days[index]

    def factor(self, currency, day):
        """Во сколько раз сумма в основной валюте больше суммы в ``currency`` на ``day``; ``None`` без курса."""
        if currency == self.base:
            return _ONE
        source, target = self.rate(currency, day), self.rate(self.base, day)
        if source is None or target is None:
            return None
        with price_context():
            return source / target

    def convert(self, amount, currency, day):
        """``amount`` в основной валюте, 2 знака; ``None``, если курса нет. Та же валюта — без изменений."""
        if amount is None:
            return None
        if currency == self.base:
            return amount
        factor = self.factor(currency, day)
        if factor is None:
            return None
        with price_context():
            return round_decimal(amount * factor, 2)


def converter(base, needs, *, lazy=True):
    """Converter для пар ``(валюта, день)`` из ``needs``: курсы одним запросом (ни одного, если пересчитывать нечего).

    Если какой-то недавний день ещё не загружен, сначала пробует его догрузить
    (``services.lazy_fetch``) и тогда читает курсы ещё раз.
    """
    needs = {(currency, day) for currency, day in needs if currency != base}
    if not needs:
        return Converter(base)
    codes = {currency for currency, _ in needs} | {base}
    codes.discard(KZT)
    days = {day for _, day in needs}
    if not codes:
        return Converter(base)
    result = _load(base, codes, min(days), max(days))
    if lazy:
        missing = {day for currency, day in needs
                   for code in {currency, base} - {KZT} if result.rate_day(code, day) != day}
        if missing and services.lazy_fetch(missing):
            result = _load(base, codes, min(days), max(days))
    return result


def _load(base, codes, first, last):
    rates = {}
    for code, day, value, quant in (
        Rate.objects.filter(currency__in=codes, day__gte=first - timedelta(days=STALE_DAYS), day__lte=last)
        .order_by("currency", "day").values_list("currency", "day", "value", "quant")
    ):
        days, values = rates.setdefault(code, ([], []))
        days.append(day)
        with price_context():
            values.append(value / quant)
    return Converter(base, rates)


def to_base(amount, currency_code, day, user):
    """to_base(amount, currency_code, day, user) -> Decimal | None; сумма в основной валюте семьи ``user``.

    Курс — на ``day`` (последний опубликованный не позже); ``None``, если его нет. Два запроса
    (основная валюта и курсы); в той же валюте — один. Для многих сумм — ``converter``.
    """
    base = base_currency(user)
    return converter(base, [(currency_code, day)]).convert(amount, currency_code, day)
