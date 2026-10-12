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

from accounts.access import visible_receipts_q
from accounts.people import display_name
from budget import dashboard
from budget.access import limit_owner, limits_q, people
from budget.models import BudgetLimit
from catalog.models import Category
from config.exceptions import InvalidParameter
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


def limit_object(limit):
    return {
        "id": limit.pk, "category_id": limit.category_id, "category_name": limit.category.name,
        "currency": limit.currency_id, "amount": common.amount(limit.amount),
    }


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


def save_limit(limit):
    """Сохранить; пара «категория и валюта» уже занята у этого владельца — ``400`` у ``category_id``."""
    try:
        with transaction.atomic():
            limit.save()
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
        return Response(paginate(limits, page, limit_object))

    def post(self, request):
        values = read_limit(manual_body(request), partial=False)
        limit = save_limit(BudgetLimit(**limit_owner(request), **values))
        return Response(limit_object(limit), status=status.HTTP_201_CREATED)


class LimitView(LocalAPIView):
    """``PATCH`` — сменить сумму, категорию или валюту; ``DELETE`` — удалить. Чужой — ``404``."""

    http_method_names = ["get", "patch", "delete", "head", "options"]
    parser_classes = [LimitBodyParser]

    def get(self, request, pk):
        return Response(limit_object(common.get_or_404(visible_limits(request), path_id(pk))))

    def patch(self, request, pk):
        limit = common.get_or_404(visible_limits(request), path_id(pk))
        for name, value in read_limit(manual_body(request), partial=True).items():
            setattr(limit, name, value)
        return Response(limit_object(save_limit(limit)))

    def delete(self, request, pk):
        common.get_or_404(visible_limits(request), path_id(pk)).delete()
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


def _recent_object(receipt, category_name):
    if receipt.store_id is not None:
        title = common.store_name(receipt.store)
    else:
        title = receipt.note or category_name or "Без места"
    return {
        "id": receipt.pk, "source": receipt.source, "title": title, "category_name": category_name,
        "owner": receipt.owner.get_username(), "owner_name": display_name(receipt.owner),
        "purchased_on": common.iso_date(receipt.purchased_on),
        "total": common.amount(receipt.total), "currency": receipt.currency_id, "lines_count": receipt.lines_total,
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


class DashboardView(LocalAPIView):
    """Месяц семьи: потрачено и прошлый месяц по валютам, категории с лимитами, последние траты."""

    def get(self, request):
        today = timezone.localdate()
        params = Params(request.query_params)
        month = read_month(params, today)
        params.check()
        tree = common.CategoryTree.load()
        receipts = Receipt.objects.filter(visible_receipts_q(request))
        product_ref = stats_common.owner_product_id()
        blocks = dashboard.currency_blocks(receipts, visible_limits(request), month, tree, product_ref)
        family = people(request)
        return Response({
            "month": month.label(), "previous_month": month.previous().label(),
            "days_left": dashboard.days_left(month, today),
            "members": [item["username"] for item in family], "people": family,
            "currencies": stats_common.primary_first(request, [_block_object(block) for block in blocks]),
            "recent": [_recent_object(*pair) for pair in dashboard.recent(receipts, tree, product_ref=product_ref)],
        })
