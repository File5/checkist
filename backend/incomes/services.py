"""Доходы: проверка тела, запись, итоги месяца в основной валюте семьи.

Доход человек вносит сам (выписки поступления в доходы не переносят). Тело — ``amount``,
``currency``, ``category`` (id категории дохода), ``received_on``, ``note``; ошибки копятся и
уходят одним ``receipts.manual.ManualInvalid`` с теми же кодами причин, что у ручной траты.

Итоги — в основной валюте семьи (``rates.convert``) по курсу дня: доход — всех членов семьи
(``accounts.access.owner_q``: общий доход видят все), «потрачено» — ``Σ Receipt.total`` видимых
чеков (``visible_receipts_q``), как «Потрачено» Главной. Суммы без курса в итог не входят
(``excluded``). «Отложено» — доход минус потрачено.
"""
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from types import SimpleNamespace

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from accounts.access import owner_q, request_user, visible_receipts_q
from budget.dashboard import Month
from rates import convert
from receipts import manual
from receipts.decimal_math import price_context
from receipts.models import Receipt
from stores.models import Currency

from .access import categories_q
from .models import Income, IncomeCategory

FIELDS = ("amount", "currency", "category", "received_on", "note")
CATEGORY_NAME_MAX = 60
ZERO = Decimal("0.00")


def as_request(user):
    """Правила ``accounts.access`` для кода без HTTP-запроса: они читают только ``user``."""
    return SimpleNamespace(user=user)


def parse(data, request, *, partial=False):
    """Проверенные значения тела; ``category`` — видимая запросу ``IncomeCategory``."""
    if not isinstance(data, dict):
        raise manual.ManualInvalid({"body": "type"})
    errors = {key: "unknown_field" for key in data if key not in FIELDS}
    values = {}
    if "amount" in data or not partial:
        amount = manual._number(data.get("amount"), manual._MONEY)
        if amount is None:
            errors["amount"] = "money" if data.get("amount") is not None else "required"
        values["amount"] = amount
    if "currency" in data:
        code = data["currency"]
        if not isinstance(code, str) or not Currency.objects.filter(pk=code.strip().upper()).exists():
            errors["currency"] = "unknown"
        else:
            values["currency_id"] = code.strip().upper()
    if "category" in data or not partial:
        pk = data.get("category")
        category = None
        if isinstance(pk, int) and not isinstance(pk, bool) and 0 < pk < 2**63:
            category = IncomeCategory.objects.filter(categories_q(request), pk=pk).first()
        if category is None:
            errors["category"] = "unknown" if pk is not None else "required"
        values["category"] = category
    if "received_on" in data:
        value = data["received_on"]
        try:
            values["received_on"] = date.fromisoformat(value) if isinstance(value, str) and len(value) == 10 else None
        except ValueError:
            values["received_on"] = None
        if values["received_on"] is None:
            errors["received_on"] = "date"
    if "note" in data:
        note = data["note"]
        if note is not None and not isinstance(note, str):
            errors["note"] = "type"
        elif note and len(note.strip()) > manual.NOTE_MAX:
            errors["note"] = "too_long"
        values["note"] = (note or "").strip()
    if errors:
        raise manual.ManualInvalid(errors)
    return values


def create(request, data):
    """Новый доход пользователя запроса; валюта по умолчанию — как у трат (профиль → последний чек → KZT)."""
    values = parse(data, request)
    owner = request_user(request)
    values.setdefault("currency_id", manual.default_currency(Receipt.objects.filter(owner=owner), owner))
    values.setdefault("received_on", timezone.localdate())
    return Income.objects.create(owner=owner, **values)


def update(income, request, data):
    with transaction.atomic():
        for name, value in parse(data, request, partial=True).items():
            setattr(income, name, value)
        income.save()
    return income


def add_category(request, name):
    """Своя категория семьи (владелец как у лимита); то же имя без учёта регистра — уже имеющаяся."""
    from budget.access import limit_owner

    found = IncomeCategory.objects.filter(categories_q(request), name__iexact=name).first()
    return found or IncomeCategory.objects.create(name=name, **limit_owner(request))


# --- итоги в основной валюте ---

@dataclass
class Totals:
    """Суммы по месяцам в основной валюте; ``income`` — только месяцы, где доходы есть."""

    base: str
    income: dict = field(default_factory=dict)  # {Month: Decimal}
    spent: dict = field(default_factory=dict)
    excluded: dict = field(default_factory=dict)  # {валюта: сумма без курса}


def _rows(queryset, day_field, amount_field):
    return list(queryset.values("currency_id", day_field).annotate(total=Sum(amount_field)).order_by()
                .values_list("currency_id", day_field, "total"))


def totals(request, first, last):
    """Доход семьи и траты видимых чеков с ``first`` по ``last`` включительно по месяцам; до пяти запросов."""
    incomes = _rows(Income.objects.filter(owner_q(request), received_on__gte=first, received_on__lte=last),
                    "received_on", "amount")
    spends = _rows(Receipt.objects.filter(visible_receipts_q(request), purchased_on__gte=first, purchased_on__lte=last),
                   "purchased_on", "total")
    base = convert.base_currency(request_user(request))
    converter = convert.converter(base, {(currency, day) for currency, day, _ in incomes + spends})
    result = Totals(base)
    with price_context():
        for target, rows in ((result.income, incomes), (result.spent, spends)):
            for currency, day, total in rows:
                value = converter.convert(total, currency, day)
                if value is None:
                    result.excluded[currency] = result.excluded.get(currency, ZERO) + total
                    continue
                month = Month.of(day)
                target[month] = target.get(month, ZERO) + value
    # Месяц с доходами только без курса — всё же месяц с доходами: итог 0, суммы видны в ``excluded``.
    for currency, day, _ in incomes:
        result.income.setdefault(Month.of(day), ZERO)
    return result


def saved(income, spent):
    """``(отложено, доля в %)``; без дохода — ``(None, None)``."""
    if income is None:
        return None, None
    with price_context():
        rest = income - spent
        return rest, rest * 100 / income if income > 0 else None


def month_income(user, month):
    """month_income(user, month) -> Decimal | None; доход семьи ``user`` за месяц в основной валюте.

    ``month`` — ``budget.dashboard.Month`` либо дата внутри месяца; ``None`` — доходов за месяц нет.
    Для «можно тратить в день» (``budget.allowance``).
    """
    if isinstance(month, date):
        month = Month.of(month)
    return totals(as_request(user), month.first, month.last).income.get(month)
