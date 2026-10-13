"""Доходы (``/api/incomes/``), строка Главной и «Динамика» дохода (``/api/stats/trends/incomes/``).

Доступ — как у трат без чека: ``accounts`` — вход, ``local_single`` — DEBUG + флаг + loopback;
запись — с CSRF. Записи видят автор и главный в семье (``incomes.access.visible_q``), чужая —
``404``; общий доход семьи за месяц виден всем её членам (``family_total``).
"""
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from accounts.people import display_name
from budget.dashboard import Month
from config.exceptions import InvalidParameter
from incomes import services
from incomes.access import categories_q, visible_q
from incomes.models import Income, IncomeCategory
from receipts.manual import ManualInvalid

from .. import common, stats_common
from ..params import Params
from .budget import read_month
from .receipts import manual_body, manual_invalid
from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView
from .stats_trends import _head, _window


class IncomeBodyParser(JsonObjectParser):
    pass


def income_object(income, converter):
    return {
        "id": income.pk, "received_on": common.iso_date(income.received_on), "amount": common.amount(income.amount),
        "currency": income.currency_id, "category": {"id": income.category_id, "name": income.category.name},
        "note": income.note, "owner": income.owner.get_username(), "owner_name": display_name(income.owner),
        # В основной валюте семьи по курсу дня; null — курса нет.
        "base_amount": common.amount(converter.convert(income.amount, income.currency_id, income.received_on)),
    }


def visible_incomes(request):
    return Income.objects.filter(visible_q(request)).select_related("category", "owner")


def one(request, income):
    converter = stats_common.converter(request, {(income.currency_id, income.received_on)})
    return income_object(visible_incomes(request).get(pk=income.pk), converter)


class IncomesView(LocalAPIView):
    """``GET ?month=ГГГГ-ММ`` — видимые записи месяца и общий доход семьи; ``POST`` — новый доход."""

    http_method_names = ["get", "post", "head", "options"]
    parser_classes = [IncomeBodyParser]

    def get(self, request):
        params = Params(request.query_params)
        month = read_month(params, timezone.localdate())
        params.check()
        rows = list(visible_incomes(request).filter(received_on__gte=month.first, received_on__lte=month.last)
                    .order_by("-received_on", "-pk"))
        found = services.totals(request, month.first, month.last)
        converter = stats_common.converter(request, {(row.currency_id, row.received_on) for row in rows})
        return Response({
            "month": month.label(), "base_currency": found.base,
            "family_total": common.amount(found.income.get(month)),
            "results": [income_object(row, converter) for row in rows],
        })

    def post(self, request):
        try:
            income = services.create(request, manual_body(request))
        except ManualInvalid as error:
            raise manual_invalid(error) from None
        return Response(one(request, income), status=status.HTTP_201_CREATED)


class IncomeView(LocalAPIView):
    """Один доход: ``GET``, ``PATCH``, ``DELETE``; невидимый запросу — ``404``."""

    http_method_names = ["get", "patch", "delete", "head", "options"]
    parser_classes = [IncomeBodyParser]

    def get(self, request, pk):
        return Response(one(request, common.get_or_404(visible_incomes(request), path_id(pk))))

    def patch(self, request, pk):
        income = common.get_or_404(visible_incomes(request), path_id(pk))
        try:
            services.update(income, request, manual_body(request))
        except ManualInvalid as error:
            raise manual_invalid(error) from None
        return Response(one(request, income))

    def delete(self, request, pk):
        common.get_or_404(visible_incomes(request), path_id(pk)).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def category_object(category):
    return {"id": category.pk, "name": category.name, "built_in": category.household_id is None and category.user_id is None}


class IncomeCategoriesView(LocalAPIView):
    """``GET`` — встроенные категории доходов, потом свои; ``POST {"name"}`` — своя категория семьи."""

    http_method_names = ["get", "post", "head", "options"]
    parser_classes = [IncomeBodyParser]

    def get(self, request):
        rows = IncomeCategory.objects.filter(categories_q(request)).order_by("pk")
        return Response({"results": [category_object(row) for row in rows]})

    def post(self, request):
        data = manual_body(request)
        errors = {key: ["Неизвестное поле."] for key in data if key != "name"}
        name = data["name"].strip() if isinstance(data.get("name"), str) else ""
        if not 0 < len(name) <= services.CATEGORY_NAME_MAX:
            errors["name"] = [f"Название — от 1 до {services.CATEGORY_NAME_MAX} символов."]
        if errors:
            raise InvalidParameter(errors)
        return Response(category_object(services.add_category(request, name)), status=status.HTTP_201_CREATED)


def month_figures(found, month):
    """Доход, потрачено, отложено и его доля месяца; без дохода — ``income``, ``saved``, ``saved_percent`` null."""
    income = found.income.get(month)
    spent = found.spent.get(month, services.ZERO)
    saved, percent = services.saved(income, spent)
    return {"income": common.amount(income), "spent": common.amount(spent), "saved": common.amount(saved),
            "saved_percent": common.percent(percent)}


def excluded(found):
    return [{"currency": currency, "total": common.amount(total)} for currency, total in sorted(found.excluded.items())]


class IncomeSummaryView(LocalAPIView):
    """``GET ?month=`` — строка Главной: доход семьи, потрачено, отложено (null — дохода за месяц нет)."""

    def get(self, request):
        params = Params(request.query_params)
        month = read_month(params, timezone.localdate())
        params.check()
        found = services.totals(request, month.first, month.last)
        return Response({"month": month.label(), "base_currency": found.base, **month_figures(found, month),
                         "excluded": excluded(found)})


class TrendsIncomesView(LocalAPIView):
    """«Динамика»: доход семьи, потрачено и отложено по месяцам окна (параметры — как у ``trends/monthly/``)."""

    def get(self, request):
        params = Params(request.query_params)
        months = [Month.of(first) for first in _window(params) or []]
        params.check()
        found = services.totals(request, months[0].first, months[-1].last)
        return Response({**_head([month.first for month in months]), "base_currency": found.base,
                         "excluded": excluded(found),
                         "items": [{"month": month.label(), **month_figures(found, month)} for month in months]})
