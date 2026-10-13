"""Регулярные платежи (``/api/recurring/``): месяц, платежи, ответы на вопросы и предложения.

Доступ — как у лимитов и записи трат: ``accounts`` — вход, ``local_single`` — DEBUG + флаг +
loopback; запись — с CSRF. Платежи семьи видят и правят все её члены, чужой — ``404``.
Сверка с тратами — ``recurring.services`` (видимые траты семьи без скрытых).

Регулярный доход (``kind: "income"``, 2026-10-13): ``category_id`` — категория дохода
(``/api/incomes/categories/``), места нет; получен ли — сверка с доходами месяца. Такой шаблон
видят его автор и главный в семье, остальным он — ``404``. Вопросов о прошлом месяце у дохода нет.

«Оплатил» (2026-10-13): ``POST {id}/pay/`` — трата на введённые сумму, день и способ оплаты и ответ ``added``
о месяце; у месяца платежа ``year`` — «как и сколько оплатил» за 12 месяцев с итогом по способам оплаты.
"""
import re
from datetime import date, timedelta

from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response

from accounts.access import request_user
from accounts.people import person
from budget.dashboard import Month
from catalog.models import Category
from config.exceptions import ApiError, InvalidParameter, ObjectNotFound
from receipts import manual
from receipts.models import Receipt
from recurring import matching, services
from incomes.access import categories_q
from incomes.models import IncomeCategory
from recurring.access import owner_fields, visible_payments_q
from recurring.models import RecurringDecision, RecurringPayment
from stores.models import Currency, Store

from .. import common
from ..params import Params
from .budget import _amount, read_month
from .receipts import manual_body, manual_invalid
from .recognition import path_id
from .recognition_base import JsonObjectParser, LocalAPIView

FIELDS = ("name", "store_name", "category_id", "currency", "amount", "due_day", "active", "kind")
INCOME = RecurringPayment.Kind.INCOME
NAME_MAX = 100
MESSAGES = {
    "unknown_field": "Неизвестное поле.",
    "required": "Обязательное поле.",
    "name": f"Название — от 1 до {NAME_MAX} символов.",
    "store_name": f"Место — строка не длиннее {manual.STORE_NAME_MAX} символов.",
    "category": "Категория не найдена.",
    "currency": "Валюта не найдена.",
    "amount": "Сумма больше нуля, не больше двух знаков после запятой.",
    "due_day": "Число месяца от 1 до 31.",
    "active": "Ожидается true или false.",
    "empty": "Укажите хотя бы одно поле.",
    "decision": "Ответ — added, skipped или elsewhere.",
    "month": "Месяц до текущего, не раньше чем за год, в формате ГГГГ-ММ.",
    "store": "Магазин не найден.",
    "kind": "Вид — spend или income; у сохранённого шаблона не меняется.",
    "pay_month": "Месяц не позже текущего, не раньше чем за год, в формате ГГГГ-ММ.",
    "payment_method": "Способ оплаты — kaspi_gold, forte, cash, crypto, card либо пусто.",
    "purchased_on": "Дата в формате ГГГГ-ММ-ДД, не позже сегодняшней.",
}
_MONTH = re.compile(r"([0-9]{4})-([0-9]{2})")


class RecurringConflict(ApiError):
    status_code = status.HTTP_409_CONFLICT
    TEXTS = {
        "already_paid": "Оплата за этот месяц уже найдена.",
        "already_decided": "За этот месяц ответ уже есть.",
    }

    def __init__(self, code):
        self.code = code
        super().__init__(self.TEXTS[code])


class RecurringBodyParser(JsonObjectParser):
    pass


def _id(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and 0 < value < 2**63 else None


def _currency(value):
    if isinstance(value, str) and re.fullmatch(r"[A-Za-z]{3}", value.strip()):
        return Currency.objects.filter(pk=value.strip().upper()).values_list("pk", flat=True).first()
    return None


def read_payment(data, request, *, partial, kind=None):
    """Проверенные поля тела платежа (только присланные при ``partial``); ``store_name`` — текст места.

    ``kind`` — вид сохранённого шаблона (правка его не меняет); у нового — из тела, по умолчанию ``spend``.
    """
    errors, values = {}, {}
    raw_kind = data.get("kind", kind or RecurringPayment.Kind.SPEND)
    if raw_kind not in RecurringPayment.Kind.values or (kind is not None and raw_kind != kind):
        errors["kind"] = [MESSAGES["kind"]]
    income = raw_kind == INCOME
    for key in data:
        if key not in FIELDS:
            errors[key] = [MESSAGES["unknown_field"]]
    for key in FIELDS:
        if key not in data:
            if not partial and key in ("name", "category_id", "currency", "amount", "due_day"):
                errors[key] = [MESSAGES["required"]]
            continue
        value = data[key]
        if key == "name":
            text = value.strip() if isinstance(value, str) else ""
            if not 0 < len(text) <= NAME_MAX:
                errors[key] = [MESSAGES["name"]]
            values["name"] = text
        elif key == "store_name":
            # Пусто либо null — без места; иначе магазин по названию (receipts.manual.find_or_create_store).
            if value is not None and not (isinstance(value, str) and len(value.strip()) <= manual.STORE_NAME_MAX):
                errors[key] = [MESSAGES["store_name"]]
            values["store_name"] = (value.strip() or None) if isinstance(value, str) else None
        elif key == "kind":
            values["kind"] = raw_kind
        elif key == "category_id":
            categories = IncomeCategory.objects.filter(categories_q(request)) if income else Category.objects
            category = categories.filter(pk=_id(value)).first() if _id(value) else None
            if category is None:
                errors[key] = [MESSAGES["category"]]
            values["category"] = category
        elif key == "currency":
            code = _currency(value)
            if code is None:
                errors[key] = [MESSAGES["currency"]]
            values["currency_id"] = code
        elif key == "amount":
            amount = _amount(value)
            if amount is None:
                errors[key] = [MESSAGES["amount"]]
            values["amount"] = amount
        elif key == "due_day":
            if not (isinstance(value, int) and not isinstance(value, bool) and 1 <= value <= 31):
                errors[key] = [MESSAGES["due_day"]]
            values["due_day"] = value
        else:
            if not isinstance(value, bool):
                errors[key] = [MESSAGES["active"]]
            values["active"] = value
    if partial and not errors and not values:
        errors["body"] = [MESSAGES["empty"]]
    if errors:
        raise InvalidParameter(errors)
    return values


def apply(payment, values):
    payment.kind = values.get("kind", payment.kind)
    for name, value in values.items():
        if name == "category" and payment.kind == INCOME:
            payment.income_category = value
        elif name == "store_name" and payment.kind == INCOME:
            payment.store = None  # у дохода места нет
        elif name == "store_name":
            currency = values.get("currency_id") or payment.currency_id
            payment.store = manual.find_or_create_store(value, currency) if value else None
        else:
            setattr(payment, name, value)
    return payment


def _store(store):
    return None if store is None else {"id": store.pk, "name": common.store_name(store)}


def payment_object(payment):
    return {
        "id": payment.pk, "kind": payment.kind, "name": payment.name, "store": _store(payment.store),
        "category": {"id": payment.any_category.pk, "name": payment.any_category.name},
        "currency": payment.currency_id, "amount": common.amount(payment.amount), "due_day": payment.due_day,
        "active": payment.active, "created_by": person(payment.created_by) if payment.created_by else None,
    }


def _paid(spend, payment):
    # У дохода ``receipt_id`` — null, ``purchased_on`` — день, когда доход получен.
    return None if spend is None else {
        "receipt_id": None if payment.kind == INCOME else spend.id, "purchased_on": common.iso_date(spend.day),
        "total": common.amount(spend.total)}


def _year(row):
    """«Как и сколько оплатил» за 12 месяцев по этот (новые сначала) и итог по способам оплаты; выключенный — null.

    Все оплаты платежа — в его валюте (сверка берёт траты той же валюты); трата ответа в другой валюте (валюту
    платежа сменили позже) в итог не входит.
    """
    if not row.year:
        return None
    total, methods = None, {}
    for _, _, spend in row.year:
        if spend is not None and spend.currency == row.payment.currency_id:
            total = (total or 0) + spend.total
            methods[spend.method] = methods.get(spend.method, 0) + spend.total
    return {
        # ``payment_method`` — способ оплаты найденной траты (``""`` — не указан; у дохода всегда ``""``);
        # ``source`` — ``photo`` | ``manual`` (у дохода ``""``): клиент ведёт ручную трату сразу на правку.
        "months": [{"month": month.label(), "state": state,
                    "paid": None if spend is None else {**_paid(spend, row.payment), "payment_method": spend.method,
                                                         "source": spend.source}}
                   for month, state, spend in row.year],
        "total": common.amount(total),
        "methods": [{"payment_method": method, "total": common.amount(value)}
                    for method, value in sorted(methods.items(), key=lambda item: (-item[1], item[0] == "", item[0]))],
    }


def _month_payment(row):
    return {
        **payment_object(row.payment), "state": row.state, "due_date": common.iso_date(row.due),
        "paid": _paid(row.spend, row.payment),
        "added": row.added, "average": common.amount(row.average), "last_amount": common.amount(row.last),
        "previous_amount": common.amount(row.previous),
        "history": [{"month": month.label(), "state": state} for month, state in row.history],
        "year": _year(row),
    }


def _question(item):
    return {
        "payment_id": item.payment.pk, "name": item.payment.name, "month": item.month.label(),
        "due_date": common.iso_date(item.due), "currency": item.payment.currency_id,
        "amount": common.amount(item.amount), "from_history": item.from_history,
    }


def _suggestion(row):
    item = row.suggestion
    return {
        "store_id": item.store_id, "store_name": row.store_name, "category_id": item.category_id,
        "category_name": row.category_name, "currency": item.currency, "amount": common.amount(item.amount),
        "due_day": item.due_day, "months": item.months, "last_date": common.iso_date(item.last_day), "name": row.name,
    }


def _totals(rows):
    """По валютам: сколько платежей в месяце, сколько закрыто, сколько осталось оплатить."""
    totals = {}
    for row in rows:
        if row.state in (services.BEFORE, services.INACTIVE) or row.payment.kind == INCOME:
            continue
        entry = totals.setdefault(row.payment.currency_id, {"currency": row.payment.currency_id, "payments": 0,
                                                             "done": 0, "left": None})
        entry["payments"] += 1
        if row.state in services.UNPAID:
            entry["left"] = (entry["left"] or 0) + row.payment.amount
        else:
            entry["done"] += 1
    return [{**entry, "left": common.amount(entry["left"])} for _, entry in sorted(totals.items())]


def visible_payments(request):
    return RecurringPayment.objects.filter(visible_payments_q(request)).select_related(
        "store__merchant", "category", "income_category", "created_by")


class PaymentsView(LocalAPIView):
    """``GET`` — месяц ``?month=ГГГГ-ММ`` (по умолчанию текущий), ``POST`` — новый платёж."""

    http_method_names = ["get", "post", "head", "options"]
    parser_classes = [RecurringBodyParser]

    def get(self, request):
        today = timezone.localdate()
        params = Params(request.query_params)
        month = read_month(params, today)
        params.check()
        view = services.month_view(request, month, today)
        return Response({
            "month": month.label(), "previous_month": month.previous().label(), "today": common.iso_date(today),
            "payments": [_month_payment(row) for row in view.payments],
            "questions": [_question(item) for item in view.questions],
            "suggestions": [_suggestion(row) for row in view.suggestions],
            "totals": _totals(view.payments),
        })

    def post(self, request):
        values = read_payment(manual_body(request), request, partial=False)
        payment = apply(RecurringPayment(**owner_fields(request), created_by=request_user(request)), values)
        payment.save()
        return Response(payment_object(payment), status=status.HTTP_201_CREATED)


class PaymentView(LocalAPIView):
    """Один платёж: ``GET``, ``PATCH`` (любые поля), ``DELETE`` (с ответами). Чужой — ``404``."""

    http_method_names = ["get", "patch", "delete", "head", "options"]
    parser_classes = [RecurringBodyParser]

    def get(self, request, pk):
        return Response(payment_object(common.get_or_404(visible_payments(request), path_id(pk))))

    def patch(self, request, pk):
        payment = common.get_or_404(visible_payments(request), path_id(pk))
        apply(payment, read_payment(manual_body(request), request, partial=True, kind=payment.kind)).save()
        return Response(payment_object(payment))

    def delete(self, request, pk):
        common.get_or_404(visible_payments(request), path_id(pk)).delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


def _answer_month(raw, today, *, current=False):
    """Месяц ``ГГГГ-ММ`` не раньше чем за год и до текущего (с ``current`` — включая текущий); иначе ``None``."""
    match = _MONTH.fullmatch(raw) if isinstance(raw, str) else None
    if not (match and 1 <= int(match[2]) <= 12 and int(match[1]) >= 1901):
        return None
    month, now = Month(int(match[1]), int(match[2])), Month.of(today)
    earliest = matching.shift(now, -services.LOOKBACK_MONTHS)
    last = now if current else now.previous()
    return month if (earliest.year, earliest.month) <= (month.year, month.month) <= (last.year, last.month) else None


def read_decision(data, today):
    errors = {}
    for key in data:
        if key not in ("month", "decision"):
            errors[key] = [MESSAGES["unknown_field"]]
    decision = data.get("decision")
    if decision not in RecurringDecision.Decision.values:
        errors["decision"] = [MESSAGES["decision"]]
    # Отвечают о прошлых месяцах, не дальше года назад: текущий ещё не кончился.
    month = _answer_month(data.get("month"), today)
    if month is None:
        errors["month"] = [MESSAGES["month"]]
    if errors:
        raise InvalidParameter(errors)
    return month, decision


def read_pay(data, today):
    """``(month, amount, method, day)`` тела «Оплатил»; способ и дата необязательны — «не указан» и сегодня."""
    errors = {}
    for key in data:
        if key not in ("month", "amount", "payment_method", "purchased_on"):
            errors[key] = [MESSAGES["unknown_field"]]
    month = _answer_month(data.get("month"), today, current=True)
    if month is None:
        errors["month"] = [MESSAGES["pay_month"]]
    amount = _amount(data.get("amount"))
    if amount is None:
        errors["amount"] = [MESSAGES["amount"]]
    method = data.get("payment_method") or ""
    if method not in Receipt.PaymentMethod.values:
        errors["payment_method"] = [MESSAGES["payment_method"]]
    day, raw = today, data.get("purchased_on")
    if raw is not None:
        try:
            day = date.fromisoformat(raw) if isinstance(raw, str) and len(raw) == 10 else None
        except ValueError:
            day = None
        # Сутки запаса: день клиента может быть впереди дня сервера.
        if day is None or day > today + timedelta(days=1):
            errors["purchased_on"] = [MESSAGES["purchased_on"]]
    if errors:
        raise InvalidParameter(errors)
    return month, amount, method, day


class DecisionView(LocalAPIView):
    """``POST {"month", "decision"}`` — ответ на «платёж за месяц не найден»; ``added`` создаёт трату."""

    http_method_names = ["post", "options"]
    parser_classes = [RecurringBodyParser]

    def post(self, request, pk):
        payment = common.get_or_404(visible_payments(request).filter(kind=RecurringPayment.Kind.SPEND), path_id(pk))
        today = timezone.localdate()
        month, decision = read_decision(manual_body(request), today)
        try:
            saved = services.decide(request, payment.pk, month, decision, today)
        except services.DecisionRefused as refused:
            raise RecurringConflict(refused.code) from None
        except RecurringPayment.DoesNotExist:
            raise ObjectNotFound() from None
        except manual.ManualInvalid as error:
            raise manual_invalid(error) from None
        return Response({"payment_id": payment.pk, "month": month.label(), "decision": saved.decision,
                         "receipt_id": saved.receipt_id}, status=status.HTTP_201_CREATED)


class PayView(LocalAPIView):
    """``POST {"month", "amount", "payment_method"?, "purchased_on"?}`` — «Оплатил»: трата и ответ ``added``.

    Ответ — как у ``decision``. Регулярный доход — ``404``; оплачен — ``409 already_paid``, ответ есть —
    ``409 already_decided``.
    """

    http_method_names = ["post", "options"]
    parser_classes = [RecurringBodyParser]

    def post(self, request, pk):
        payment = common.get_or_404(visible_payments(request).filter(kind=RecurringPayment.Kind.SPEND), path_id(pk))
        today = timezone.localdate()
        month, amount, method, day = read_pay(manual_body(request), today)
        try:
            saved = services.pay(request, payment.pk, month, amount, method, day, today)
        except services.DecisionRefused as refused:
            raise RecurringConflict(refused.code) from None
        except RecurringPayment.DoesNotExist:
            raise ObjectNotFound() from None
        except manual.ManualInvalid as error:
            raise manual_invalid(error) from None
        return Response({"payment_id": payment.pk, "month": month.label(), "decision": saved.decision,
                         "receipt_id": saved.receipt_id}, status=status.HTTP_201_CREATED)


def read_key(data):
    errors = {}
    for key in data:
        if key not in ("store_id", "category_id", "currency"):
            errors[key] = [MESSAGES["unknown_field"]]
    store_id, category_id = _id(data.get("store_id")), _id(data.get("category_id"))
    if store_id is None or not Store.objects.filter(pk=store_id).exists():
        errors["store_id"] = [MESSAGES["store"]]
    if category_id is None or not Category.objects.filter(pk=category_id).exists():
        errors["category_id"] = [MESSAGES["category"]]
    currency = _currency(data.get("currency"))
    if currency is None:
        errors["currency"] = [MESSAGES["currency"]]
    if errors:
        raise InvalidParameter(errors)
    return store_id, category_id, currency


class SuggestionAcceptView(LocalAPIView):
    """``POST {"store_id", "category_id", "currency"}`` — завести платёж из предложения; нет его — ``404``."""

    http_method_names = ["post", "options"]
    parser_classes = [RecurringBodyParser]

    def post(self, request):
        payment = services.accept(request, *read_key(manual_body(request)))
        if payment is None:
            raise ObjectNotFound()
        payment = visible_payments(request).get(pk=payment.pk)
        return Response(payment_object(payment), status=status.HTTP_201_CREATED)


class SuggestionDismissView(LocalAPIView):
    """``POST {"store_id", "category_id", "currency"}`` — больше не предлагать; ответ — тот же ключ, повтор — тот же ответ."""

    http_method_names = ["post", "options"]
    parser_classes = [RecurringBodyParser]

    def post(self, request):
        store_id, category_id, currency = read_key(manual_body(request))
        services.dismiss(request, store_id, category_id, currency)
        return Response({"store_id": store_id, "category_id": category_id, "currency": currency})
