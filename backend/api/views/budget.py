"""Лимиты бюджета (``/api/budget/limits/``) и дашборд месяца (``/api/dashboard/``).

Доступ — как у ``/api/receipts/`` и записи трат: ``accounts`` — вход, ``local_single`` —
DEBUG + флаг + loopback; запись — с CSRF. Лимиты семьи видят и правят все её члены, чужой
лимит — ``404``. Чеки дашборда — ``owner_q`` (вся семья).
"""
import re
from decimal import Decimal, InvalidOperation

from django.db import IntegrityError, transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from accounts.access import request_user, visible_receipts_q
from accounts.people import display_name
from budget import allowance, dashboard, history
from budget.access import limit_owner, limits_q, people
from budget.models import BudgetLimit, BudgetLimitChange
from catalog.models import Category
from config.exceptions import InvalidParameter
from incomes.services import month_income
from rates.convert import request_base_currency
from receipts import spending
from receipts.models import Receipt
from stores.models import Currency

from .. import common, stats_common
from ..pagination import paginate
from ..params import Params
from .receipts import manual_body
from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView

FIELDS = ("category_id", "currency", "amount")
AMOUNT_MAX = Decimal("999999999999.99")  # Decimal(14, 2)
_MONTH = re.compile(r"([0-9]{4})-([0-9]{2})")
_AMOUNT = re.compile(r"[0-9]{1,12}(\.[0-9]{1,2})?")

MESSAGES = {
    "unknown_field": "Неизвестное поле.",
    "required": "Обязательное поле.",
    "category": "Категория не найдена.",
    "currency": "Валюта не найдена.",
    "amount": "Сумма больше нуля, не больше двух знаков после запятой.",
    "duplicate": "Лимит для этой категории и валюты уже есть.",
    "empty": "Укажите хотя бы одно поле.",
}


def base_only_message(base):
    return f"Лимиты задаются в основной валюте семьи — {base}."


def limit_object(limit, converter):
    """Лимит; ``base_amount`` — его сумма в основной валюте семьи по сегодняшнему курсу (null — курса нет)."""
    return {
        "id": limit.pk, "category_id": limit.category_id, "category_name": limit.category.name,
        "currency": limit.currency_id, "amount": common.amount(limit.amount),
        "base_currency": converter.base,
        "base_amount": common.amount(converter.convert(limit.amount, limit.currency_id, timezone.localdate())),
    }


def limit_objects(request, limits):
    """Лимиты ответа: курсы всех — одним запросом."""
    today = timezone.localdate()
    converter = stats_common.converter(request, {(limit.currency_id, today) for limit in limits})
    return [limit_object(limit, converter) for limit in limits]


def check_base(request, limit):
    """Новый либо изменённый лимит — только в основной валюте семьи (``rates.convert``); иначе ``400`` у ``currency``.

    Прежние лимиты другой валюты читаются и удаляются как раньше, а правка переводит их в основную.
    """
    base = request_base_currency(request)
    if limit.currency_id != base:
        raise InvalidParameter({"currency": [base_only_message(base)]})


def visible_limits(request):
    return BudgetLimit.objects.filter(limits_q(request)).select_related("category")


def _amount(value):
    """Сумма как у формы траты: строка (запятая допустима) либо число JSON; > 0, два знака."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    text = repr(value) if isinstance(value, float) else str(value).strip().replace(",", ".")
    if not _AMOUNT.fullmatch(text):
        return None
    try:
        result = Decimal(text)
    except InvalidOperation:
        return None
    return result if Decimal(0) < result <= AMOUNT_MAX else None


def read_limit(data, *, partial):
    """Проверенные поля тела: ``{"category", "currency", "amount"}`` (только присланные при ``partial``)."""
    errors, values = {}, {}
    for key in data:
        if key not in FIELDS:
            errors[key] = [MESSAGES["unknown_field"]]
    for key in FIELDS:
        if key not in data:
            if not partial:
                errors[key] = [MESSAGES["required"]]
            continue
        value = data[key]
        if key == "category_id":
            category = None
            if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2**63:
                category = Category.objects.filter(pk=value).first()
            if category is None:
                errors[key] = [MESSAGES["category"]]
            values["category"] = category
        elif key == "currency":
            currency = None
            if isinstance(value, str) and re.fullmatch(r"[A-Z]{3}", value.strip().upper()):
                currency = Currency.objects.filter(pk=value.strip().upper()).first()
            if currency is None:
                errors[key] = [MESSAGES["currency"]]
            values["currency"] = currency
        else:
            amount = _amount(value)
            if amount is None:
                errors[key] = [MESSAGES["amount"]]
            values["amount"] = amount
    if partial and not errors and not values:
        errors["body"] = [MESSAGES["empty"]]
    if errors:
        raise InvalidParameter(errors)
    return values


def save_limit(limit, actor=None):
    """Сохранить с записью в журнал; пара «категория и валюта» уже занята у этого владельца — ``400`` у ``category_id``."""
    try:
        with transaction.atomic():
            history.save_limit(limit, actor)
    except IntegrityError:
        raise InvalidParameter({"category_id": [MESSAGES["duplicate"]]}) from None
    return limit


class LimitBodyParser(JsonObjectParser):
    pass


class LimitsView(LocalAPIView):
    """``GET`` — лимиты семьи (или свои), ``POST`` — новый лимит."""

    http_method_names = ["get", "post", "head", "options"]
    parser_classes = [LimitBodyParser]

    def get(self, request):
        params = Params(request.query_params)
        page = params.page()
        params.check()
        limits = visible_limits(request).order_by("category__name", "currency_id", "pk")
        data = paginate(limits, page)
        today = timezone.localdate()
        converter = stats_common.converter(request, {(limit.currency_id, today) for limit in data["results"]})
        data["results"] = [limit_object(limit, converter) for limit in data["results"]]
        # Основная валюта семьи: в ней задаются новые лимиты (и при пустом списке).
        data["base_currency"] = converter.base
        return Response(data)

    def post(self, request):
        values = read_limit(manual_body(request), partial=False)
        limit = BudgetLimit(**limit_owner(request), **values)
        check_base(request, limit)
        limit = save_limit(limit, request_user(request))
        return Response(limit_objects(request, [limit])[0], status=status.HTTP_201_CREATED)


class LimitView(LocalAPIView):
    """``PATCH`` — сменить сумму, категорию или валюту; ``DELETE`` — удалить. Чужой — ``404``."""

    http_method_names = ["get", "patch", "delete", "head", "options"]
    parser_classes = [LimitBodyParser]

    def get(self, request, pk):
        return Response(limit_objects(request, [common.get_or_404(visible_limits(request), path_id(pk))])[0])

    def patch(self, request, pk):
        limit = common.get_or_404(visible_limits(request), path_id(pk))
        for name, value in read_limit(manual_body(request), partial=True).items():
            setattr(limit, name, value)
        check_base(request, limit)
        return Response(limit_objects(request, [save_limit(limit, request_user(request))])[0])

    def delete(self, request, pk):
        history.delete_limit(common.get_or_404(visible_limits(request), path_id(pk)), request_user(request))
        return Response(status=status.HTTP_204_NO_CONTENT)


def budget_object(request):
    """Общий бюджет текущего месяца: ``amount`` (null — не задан), ``currency`` и основная валюта семьи."""
    row = history.budget_at(limits_q(request), history.current_month())
    amount = row.amount if row is not None else None
    return {"amount": common.amount(amount), "currency": row.currency_id if amount is not None else None,
            "base_currency": request_base_currency(request)}


class MonthBudgetView(LocalAPIView):
    """Общий бюджет месяца над лимитами (2026-10-13): одна сумма на семью (без семьи — своя), в основной валюте.

    ``GET`` — бюджет текущего месяца; ``POST {"amount"}`` — задать с текущего месяца; ``DELETE`` — снять с
    текущего месяца. Прошлые месяцы сохраняют свою сумму (``budget.history.budget_at``).
    """

    http_method_names = ["get", "post", "delete", "head", "options"]
    parser_classes = [LimitBodyParser]

    def get(self, request):
        return Response(budget_object(request))

    def post(self, request):
        data = manual_body(request)
        errors = {key: [MESSAGES["unknown_field"]] for key in data if key != "amount"}
        amount = _amount(data["amount"]) if "amount" in data else None
        if "amount" not in data:
            errors["amount"] = [MESSAGES["required"]]
        elif amount is None:
            errors["amount"] = [MESSAGES["amount"]]
        if errors:
            raise InvalidParameter(errors)
        history.set_budget(limit_owner(request), request_base_currency(request), amount, request_user(request))
        return Response(budget_object(request))

    def delete(self, request):
        history.set_budget(limit_owner(request), request_base_currency(request), None, request_user(request))
        return Response(status=status.HTTP_204_NO_CONTENT)


def read_month(params, today):
    raw = params.raw("month")
    if raw is None:
        return dashboard.Month.of(today)
    match = _MONTH.fullmatch(raw)
    if match is None or not (1901 <= int(match[1]) <= 9999 and 1 <= int(match[2]) <= 12):
        params.error("month", "Месяц в формате ГГГГ-ММ.")
        return None
    return dashboard.Month(int(match[1]), int(match[2]))


def _recent_object(receipt, category_name, converter):
    if receipt.store_id is not None:
        title = common.store_name(receipt.store)
    else:
        title = receipt.note or category_name or "Без места"
    return {
        "id": receipt.pk, "source": receipt.source, "title": title, "category_name": category_name,
        "owner": receipt.owner.get_username(), "owner_name": display_name(receipt.owner),
        "purchased_on": common.iso_date(receipt.purchased_on),
        "total": common.amount(receipt.total), "currency": receipt.currency_id, "lines_count": receipt.lines_total,
        # В основной валюте семьи по курсу дня покупки; null — курса нет.
        "base_total": common.amount(converter.convert(receipt.total, receipt.currency_id, receipt.purchased_on)),
    }


def _category_object(row):
    return {
        "category_id": row.category_id, "name": row.name, "spent": common.amount(row.spent),
        "limit": common.amount(row.limit), "limit_id": row.limit_id,
        "children": [_category_object(child) for child in row.children],
    }


def _block_object(block):
    return {
        "currency": block.currency, "spent": common.amount(block.spent),
        "previous_spent": common.amount(block.previous_spent), "limit_total": common.amount(block.limit_total),
        "limited_spent": common.amount(block.limited_spent),
        "categories": [_category_object(row) for row in block.categories],
    }


def _month_budget(row, converter, day, block):
    """Бюджет месяца дашборда в основной валюте рядом с потраченным; ``None`` — бюджета нет (или нет курса)."""
    amount = converter.convert(row.amount, row.currency_id, day) if row is not None and row.amount is not None else None
    if amount is None:
        return None
    return {"amount": common.amount(amount), "currency": converter.base,
            "spent": common.amount(block.spent if block is not None else Decimal("0.00"))}


def _allowance_object(value):
    if value is None:
        return None
    return {
        "currency": value.currency, "basis": value.basis, "amount": common.amount(value.amount),
        "spent": common.amount(value.spent), "unpaid": common.amount(value.unpaid), "unpaid_count": value.unpaid_count,
        "days_left": value.days_left, "per_day": common.amount(value.per_day), "overspent": common.amount(value.overspent),
    }


def month_limits(request, month, today):
    """Лимиты месяца дашборда по ``pk``: текущий и будущие — нынешние, прошлый — суммы того месяца по журналу."""
    limits = visible_limits(request).order_by("pk")
    if month.first >= history.month_start(today):
        return list(limits)
    changes = (BudgetLimitChange.objects.filter(limits_q(request))
               .select_related("category"))
    return history.limits_at(list(limits), list(changes), month.first)


class DashboardView(LocalAPIView):
    """Месяц семьи: потрачено и прошлый месяц, категории с лимитами, последние траты.

    ``currencies`` — по валютам, как раньше (валюты не складываются); ``base`` — всё в основной
    валюте семьи (``base_currency``) по курсу дня покупки, ``excluded`` — траты месяца без курса.
    Число запросов от объёма данных не зависит.
    """

    def get(self, request):
        today = timezone.localdate()
        params = Params(request.query_params)
        month = read_month(params, today)
        params.check()
        tree = common.CategoryTree.load()
        receipts = Receipt.objects.filter(visible_receipts_q(request))
        product_ref = stats_common.owner_product_id()
        found = dashboard.collect_month(receipts, month, product_ref)
        limits = month_limits(request, month, today)
        latest = dashboard.recent(receipts, tree, product_ref=product_ref)
        family = people(request)
        rate_day = dashboard.limit_day(month, today)
        budget = history.budget_at(limits_q(request), month.first)
        converter = stats_common.converter(request, found.needs() | {
            *((limit.currency_id, rate_day) for limit in limits),
            *(((budget.currency_id, rate_day),) if budget is not None else ()),
            *((row.currency_id, row.purchased_on) for row, _name in latest)})
        blocks = dashboard.currency_blocks(found, limits, month, tree)
        in_base = dashboard.currency_blocks(found, limits, month, tree, converter, today)
        block = stats_common.base_block(in_base, converter.base)
        return Response({
            "month": month.label(), "previous_month": month.previous().label(),
            "days_left": dashboard.days_left(month, today),
            "members": [item["username"] for item in family], "people": family,
            "currencies": stats_common.primary_first(request, [_block_object(block) for block in blocks]),
            **stats_common.base_fields(converter, block and _block_object(block),
                                       spending.unconverted(found.data, converter)),
            "recent": [_recent_object(row, name, converter) for row, name in latest],
            # Общий бюджет месяца и «можно тратить в день» (только текущий месяц) — в основной валюте.
            "budget": _month_budget(budget, converter, rate_day, block),
            "allowance": _allowance_object(allowance.daily(
                request_user(request), month, today=today,
                income=lambda: month_income(request_user(request), month))),
        })
