"""Цели накоплений (``/api/goals/``): список, цель с историей взносов, правка, взносы.

Доступ — как у лимитов и регулярных платежей: ``accounts`` — вход, ``local_single`` — DEBUG +
флаг + loopback; запись — с CSRF. Видимость — только ``goals.access.goals_q``: общая цель —
вся семья, личная — владелец и главный семьи; чужая — ``404``. Взнос отвечает целью целиком
(``goal_detail``), чтобы экран сразу показал новый прогресс. Депозит (``kind=deposit``) — со ставкой и
капитализацией; «Сверить с банком» (``reconcile/``) пишет разницу с расчётом записью «проценты».
"""
import re
from datetime import date
from decimal import Decimal, InvalidOperation

from django.contrib.auth import get_user_model
from django.db.models import Case, IntegerField, Value, When
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from accounts.access import household, request_user
from accounts.people import person
from budget.access import members, people
from config.exceptions import InvalidParameter
from goals import services
from goals.access import goal_owner, goals_q
from goals.models import Contribution, Goal
from rates.convert import request_base_currency
from stores.models import Currency

from .. import common
from .budget import _amount
from .receipts import manual_body
from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView

NAME_MAX = 100
NOTE_MAX = 200
GOAL_FIELDS = ("name", "amount", "currency", "deadline", "shared", "kind", "rate", "capitalization")
CONTRIBUTION_FIELDS = ("amount", "currency", "date", "user", "note")
MESSAGES = {
    "unknown_field": "Неизвестное поле.",
    "required": "Обязательное поле.",
    "empty": "Укажите хотя бы одно поле.",
    "name": f"Название — от 1 до {NAME_MAX} символов.",
    "amount": "Сумма больше нуля, не больше двух знаков после запятой.",
    "currency": "Валюта не найдена.",
    "date": "Дата в формате ГГГГ-ММ-ДД.",
    "shared": "Ожидается true или false.",
    "no_household": "Общая цель — только у семьи.",
    "user": "Это не член семьи.",
    "note": f"Комментарий — строка не длиннее {NOTE_MAX} символов.",
    "kind": "Вид — saving или deposit.",
    "rate": "Ставка — от 0 до 100 % годовых, не больше двух знаков после запятой.",
    "rate_required": "У депозита укажите ставку.",
    "capitalization": "Капитализация — monthly или none.",
    "not_deposit": "Сверка с банком — только у депозита.",
    "reconcile_date": "Дата сверки — ГГГГ-ММ-ДД, не позже сегодня.",
    "no_deposits": "По эту дату взносов нет — сверять не с чем.",
    "interest_edit": "Сверку можно только удалить.",
}


class GoalBodyParser(JsonObjectParser):
    pass


def _currency(value):
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z]{3}", value.strip()):
        return Currency.objects.filter(pk=value.strip().upper()).values_list("pk", flat=True).first()
    return None


def _date(value):
    if not (isinstance(value, str) and len(value) == 10):
        return None
    try:
        return date.fromisoformat(value)
    except ValueError:
        return None


def _rate(value):
    """% годовых: строка (запятая допустима) либо число JSON; 0–100, два знака."""
    if isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    text = repr(value) if isinstance(value, float) else str(value).strip().replace(",", ".")
    if not re.fullmatch(r"\d{1,3}(?:\.\d{1,2})?", text):
        return None
    try:
        result = Decimal(text)
    except InvalidOperation:
        return None
    return result if result <= 100 else None


def _check_fields(data, allowed, errors):
    for key in data:
        if key not in allowed:
            errors[key] = [MESSAGES["unknown_field"]]


def read_goal(request, data, *, partial, goal=None):
    """Проверенные поля цели; без ``currency`` новая цель берёт основную валюту семьи; у депозита — ставка."""
    errors, values = {}, {}
    _check_fields(data, GOAL_FIELDS, errors)
    for key in ("name", "amount"):
        if key not in data and not partial:
            errors[key] = [MESSAGES["required"]]
    if "name" in data:
        text = data["name"].strip() if isinstance(data["name"], str) else ""
        if not 0 < len(text) <= NAME_MAX:
            errors["name"] = [MESSAGES["name"]]
        values["name"] = text
    if "amount" in data:
        values["amount"] = _amount(data["amount"])
        if values["amount"] is None:
            errors["amount"] = [MESSAGES["amount"]]
    if "currency" in data or not partial:
        values["currency_id"] = _currency(data["currency"]) if "currency" in data else request_base_currency(request)
        if values["currency_id"] is None:
            errors["currency"] = [MESSAGES["currency"]]
    if "deadline" in data:
        values["deadline"] = None if data["deadline"] in (None, "") else _date(data["deadline"])
        if data["deadline"] not in (None, "") and values["deadline"] is None:
            errors["deadline"] = [MESSAGES["date"]]
    if "shared" in data:
        if not isinstance(data["shared"], bool):
            errors["shared"] = [MESSAGES["shared"]]
        elif data["shared"] and household(request) is None:
            errors["shared"] = [MESSAGES["no_household"]]
        else:
            values["shared"] = data["shared"]
    choices = {"kind": Goal.Kind.values, "capitalization": Goal.Capitalization.values}
    for key, allowed in choices.items():
        if key in data:
            values[key] = data[key]
            if data[key] not in allowed:
                errors[key] = [MESSAGES[key]]
    if "rate" in data:
        values["rate"] = None if data["rate"] in (None, "") else _rate(data["rate"])
        if data["rate"] not in (None, "") and values["rate"] is None:
            errors["rate"] = [MESSAGES["rate"]]
    deposit = values.get("kind", goal.kind if goal else Goal.Kind.SAVING) == Goal.Kind.DEPOSIT
    if deposit and "rate" not in errors and values.get("rate", goal.rate if goal and "rate" not in data else None) is None:
        errors["rate"] = [MESSAGES["rate_required"]]
    if partial and not errors and not values:
        errors["body"] = [MESSAGES["empty"]]
    if errors:
        raise InvalidParameter(errors)
    return values


def apply_goal(request, goal, values):
    shared = values.pop("shared", None)
    if shared is not None and shared != (goal.household_id is not None):
        for name, value in goal_owner(request, shared).items():
            setattr(goal, name, value)
    for name, value in values.items():
        setattr(goal, name, value)
    return goal


def read_contribution(request, goal, data, *, partial):
    errors, values = {}, {}
    _check_fields(data, CONTRIBUTION_FIELDS, errors)
    if "amount" in data or not partial:
        values["amount"] = _amount(data.get("amount"))
        if values["amount"] is None:
            errors["amount"] = [MESSAGES["required"] if "amount" not in data else MESSAGES["amount"]]
    if "currency" in data or not partial:
        values["currency_id"] = _currency(data["currency"]) if "currency" in data else goal.currency_id
        if values["currency_id"] is None:
            errors["currency"] = [MESSAGES["currency"]]
    if "date" in data or not partial:
        values["date"] = _date(data["date"]) if "date" in data else timezone.localdate()
        if values["date"] is None:
            errors["date"] = [MESSAGES["date"]]
    if "user" in data or not partial:
        username = data.get("user")
        if username is None:
            values["user"] = request_user(request)
        elif isinstance(username, str) and username in members(request):
            values["user"] = get_user_model().objects.get(username=username)
        else:
            errors["user"] = [MESSAGES["user"]]
    if "note" in data:
        if not isinstance(data["note"], str) or len(data["note"].strip()) > NOTE_MAX:
            errors["note"] = [MESSAGES["note"]]
        else:
            values["note"] = data["note"].strip()
    if partial and not errors and not values:
        errors["body"] = [MESSAGES["empty"]]
    if errors:
        raise InvalidParameter(errors)
    return values


def deposit_object(goal, progress):
    """Депозит: взносов всего, ≈ заработано процентами, без взносов через год, к сроку при нынешнем темпе."""
    if goal.kind != Goal.Kind.DEPOSIT:
        return None
    return {
        "deposits": common.amount(progress.deposits), "interest": common.amount(progress.saved - progress.deposits),
        "in_a_year": common.amount(progress.year),
        "at_deadline": None if progress.at_deadline is None else dict(
            zip(("total", "interest"), map(common.amount, progress.at_deadline))),
        "by_interest": progress.need == services.ZERO,
    }


def goal_object(goal, progress):
    shared = goal.household_id is not None
    percent = int(progress.saved * 100 // goal.amount) if progress.saved > 0 else 0
    return {
        "id": goal.pk, "name": goal.name, "amount": common.amount(goal.amount), "currency": goal.currency_id,
        "deadline": common.iso_date(goal.deadline), "shared": shared,
        "owner": None if shared else person(goal.user),
        "created_by": person(goal.created_by) if goal.created_by else None,
        "saved": common.amount(progress.saved), "percent": percent,
        "remaining": common.amount(max(goal.amount - progress.saved, services.ZERO)),
        "reached": progress.saved >= goal.amount,
        "excluded": [{"currency": code, "amount": common.amount(value)} for code, value in progress.excluded.items()],
        "contributions_count": progress.count,
        "pace": None if progress.pace is None else {
            "per_month": common.amount(progress.pace), "months_left": progress.months_left},
        "need_per_month": common.amount(progress.need), "overdue": progress.overdue,
        "kind": goal.kind, "rate": None if goal.rate is None else common.decimal_string(goal.rate, 2),
        "capitalization": goal.capitalization, "deposit": deposit_object(goal, progress),
    }


def contribution_object(item):
    return {
        "id": item.pk, "amount": common.amount(item.amount), "currency": item.currency_id, "date": common.iso_date(item.date),
        "user": person(item.user) if item.user else None, "note": item.note, "kind": item.kind,
    }


def visible_goals(request):
    return Goal.objects.filter(goals_q(request)).select_related("user", "created_by")


def goal_detail(request, goal):
    progress = services.progress([goal], timezone.localdate())[goal.pk]
    contributions = goal.contributions.select_related("user").order_by("-date", "-pk")
    series = [{"month": month.isoformat()[:7], "total": common.amount(total), "deposits": common.amount(saved),
               "forecast": ahead} for month, total, saved, ahead in progress.points]
    return {**goal_object(goal, progress), "contributions": [contribution_object(item) for item in contributions],
            "people": people(request), "series": series if goal.kind == Goal.Kind.DEPOSIT else None}


class GoalsView(LocalAPIView):
    """``GET`` — цели: сначала общие семьи, затем личные; ``POST`` — новая цель."""

    http_method_names = ["get", "post", "head", "options"]
    parser_classes = [GoalBodyParser]

    def get(self, request):
        today = timezone.localdate()
        goals = list(visible_goals(request).order_by(
            Case(When(household__isnull=False, then=Value(0)), default=Value(1), output_field=IntegerField()), "pk"))
        progress = services.progress(goals, today)
        return Response({
            "today": common.iso_date(today), "base_currency": request_base_currency(request),
            "household": household(request) is not None,
            "results": [goal_object(goal, progress[goal.pk]) for goal in goals],
        })

    def post(self, request):
        values = read_goal(request, manual_body(request), partial=False)
        goal = Goal(**goal_owner(request, values.pop("shared", False)), created_by=request_user(request), **values)
        goal.save()
        return Response(goal_detail(request, goal), status=status.HTTP_201_CREATED)


class GoalView(LocalAPIView):
    """Одна цель: ``GET`` (с историей взносов), ``PATCH``, ``DELETE`` (вместе со взносами). Чужая — ``404``."""

    http_method_names = ["get", "patch", "delete", "head", "options"]
    parser_classes = [GoalBodyParser]

    def get(self, request, pk):
        return Response(goal_detail(request, common.get_or_404(visible_goals(request), path_id(pk))))

    def patch(self, request, pk):
        goal = common.get_or_404(visible_goals(request), path_id(pk))
        apply_goal(request, goal, read_goal(request, manual_body(request), partial=True, goal=goal)).save()
        return Response(goal_detail(request, goal))

    def delete(self, request, pk):
        common.get_or_404(visible_goals(request), path_id(pk)).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class ContributionsView(LocalAPIView):
    """``POST {"amount", "date"?, "user"?, "currency"?, "note"?}`` — взнос; ответ — цель целиком."""

    http_method_names = ["post", "options"]
    parser_classes = [GoalBodyParser]

    def post(self, request, pk):
        goal = common.get_or_404(visible_goals(request), path_id(pk))
        values = read_contribution(request, goal, manual_body(request), partial=False)
        Contribution.objects.create(goal=goal, created_by=request_user(request), **values)
        return Response(goal_detail(request, goal), status=status.HTTP_201_CREATED)


class ContributionView(LocalAPIView):
    """``PATCH`` — изменить взнос, ``DELETE`` — удалить; ответ — цель целиком."""

    http_method_names = ["patch", "delete", "options"]
    parser_classes = [GoalBodyParser]

    def _item(self, request, pk, item):
        goal = common.get_or_404(visible_goals(request), path_id(pk))
        return goal, common.get_or_404(goal.contributions.all(), path_id(item))

    def patch(self, request, pk, item):
        goal, contribution = self._item(request, pk, item)
        if contribution.kind == Contribution.Kind.INTEREST:
            raise InvalidParameter({"kind": [MESSAGES["interest_edit"]]})
        for name, value in read_contribution(request, goal, manual_body(request), partial=True).items():
            setattr(contribution, name, value)
        contribution.save()
        return Response(goal_detail(request, goal))

    def delete(self, request, pk, item):
        goal, contribution = self._item(request, pk, item)
        contribution.delete()
        return Response(goal_detail(request, goal))


class ReconcileView(LocalAPIView):
    """``POST {"balance", "date"?}`` — «Сверить с банком»: разница фактического остатка депозита с расчётом на эту
    дату (по умолчанию сегодня) — запись «проценты» (``kind=interest``, может быть отрицательной), дальше расчёт
    идёт от сверенного остатка. Ответ — цель целиком."""

    http_method_names = ["post", "options"]
    parser_classes = [GoalBodyParser]

    def post(self, request, pk):
        goal = common.get_or_404(visible_goals(request), path_id(pk))
        data, errors, today = manual_body(request), {}, timezone.localdate()
        _check_fields(data, ("balance", "date"), errors)
        balance = _amount(data.get("balance"))
        day = _date(data["date"]) if "date" in data else today
        if balance is None:
            errors["balance"] = [MESSAGES["required"] if "balance" not in data else MESSAGES["amount"]]
        if day is None or day > today:
            errors["date"] = [MESSAGES["reconcile_date"]]
        if goal.kind != Goal.Kind.DEPOSIT:
            errors["kind"] = [MESSAGES["not_deposit"]]
        if errors:
            raise InvalidParameter(errors)
        estimate = services.estimate(goal, day)
        if estimate is None:
            raise InvalidParameter({"date": [MESSAGES["no_deposits"]]})
        user = request_user(request)
        Contribution.objects.create(goal=goal, kind=Contribution.Kind.INTEREST, amount=balance - estimate,
                                    currency_id=goal.currency_id, date=day, user=user, created_by=user)
        return Response(goal_detail(request, goal), status=status.HTTP_201_CREATED)
