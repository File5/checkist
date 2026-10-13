"""Регулярные платежи семьи в месяце: оплачен ли каждый, вопросы о прошлом месяце, предложения, ответы.

Оплата не хранится — сверка с видимыми тратами при каждом чтении (правило — ``recurring.matching``):
траты за 12 месяцев до месяца и окно самого месяца читаются тремя запросами, дальше — без БД.

Состояние платежа в месяце (``state``):

- ``paid`` — найдена трата (либо добавлена ответом «по средней»);
- ``skipped`` / ``elsewhere`` — ответ «не было» / «оплачено иначе»;
- ``due`` — не оплачен, срок ещё не прошёл; ``overdue`` — не оплачен, срок прошёл;
- ``before`` — месяц раньше начала платежа: раньше месяца его создания и первой найденной оплаты;
- ``inactive`` — платёж выключен: не сверяется и ни о чём не спрашивает.

Вопрос «платёж за прошлый месяц не найден» задаётся с 1-го числа текущего месяца по каждому
включённому платежу в состоянии ``overdue`` прошлого месяца. Ответ «добавить по средней»
создаёт ручную трату (``receipts.manual.create``) в срок того месяца на среднюю найденных
оплат за 12 месяцев (нет оплат — ожидаемая сумма). Сам модуль ничего не добавляет: только
по ответу человека. Удалённая трата такого ответа снова открывает вопрос.

«Оплатил» (``pay``, 2026-10-13) — тот же ответ ``added`` о любом месяце до текущего включительно, но трата —
на сумму, день и способ оплаты, которые ввёл человек. История в листе платежа — ``PaymentMonth.year``:
12 месяцев со своими состоянием и найденной тратой (у неё ``method`` — способ оплаты).

Регулярный доход (``kind = income``) сверяется тем же окном с доходами всей семьи
(``load_incomes``, правило — ``matching.income_signals``): ``paid`` — доход получен. Вопросов о
прошлом месяце и «осталось оплатить» у дохода нет, ``unpaid`` его не отдаёт.
"""
from dataclasses import dataclass, field, replace
from datetime import date, timedelta

from django.db import IntegrityError, transaction
from django.db.models import F
from django.db.models.functions import Coalesce
from django.utils import timezone

from accounts.access import owner_q, request_user, visible_receipts_q
from budget.dashboard import Month
from catalog.models import Category
from rates import convert
from receipts import manual
from receipts.models import Receipt, ReceiptLine
from receipts.spending import UNASSIGNED_NAME
from stores.models import Store

from . import matching
from .access import as_request, owner_fields, payments_q, visible_payments_q
from .models import DismissedSuggestion, RecurringDecision, RecurringPayment

LOOKBACK_MONTHS = 12
HISTORY_MONTHS = 6
YEAR_MONTHS = 12  # «как и сколько оплатил» в листе платежа
AVERAGE_MONTHS = 12

PAID, SKIPPED, ELSEWHERE, DUE, OVERDUE, BEFORE, INACTIVE = (
    "paid", "skipped", "elsewhere", "due", "overdue", "before", "inactive")
UNPAID = (DUE, OVERDUE)
SPEND, INCOME = RecurringPayment.Kind.SPEND, RecurringPayment.Kind.INCOME
MONTH_NAMES = ("январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь",
               "ноябрь", "декабрь")


class DecisionRefused(Exception):
    """Ответ не принят: ``code`` — ``already_paid`` либо ``already_decided``."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


@dataclass
class PaymentMonth:
    """Платёж в месяце: состояние, найденная трата и суммы для показа."""

    payment: RecurringPayment
    state: str
    due: date
    spend: matching.Spend | None = None
    added: bool = False  # трата добавлена ответом «по средней» (у «Оплатил» — нет: человек ввёл свою сумму)
    average: object = None  # Decimal | None: средняя найденных оплат за 12 месяцев до месяца включительно
    last: object = None  # последняя найденная оплата до месяца включительно
    previous: object = None  # прошлая найденная оплата, только если отличается от последней
    history: list = field(default_factory=list)  # [(Month, state)] за 6 месяцев по этот
    year: list = field(default_factory=list)  # [(Month, state, Spend | None)] за 12 месяцев по этот, новые сначала


@dataclass
class Question:
    payment: RecurringPayment
    month: Month
    due: date
    amount: object  # Decimal: средняя оплата либо ожидаемая сумма
    from_history: bool  # средняя посчитана по найденным оплатам


@dataclass
class SuggestionView:
    suggestion: matching.Suggestion
    name: str
    store_name: str
    category_name: str


@dataclass
class MonthView:
    month: Month
    today: date
    payments: list
    questions: list
    suggestions: list


def month_name(month):
    return f"{MONTH_NAMES[month.month - 1]} {month.year}"


def _months(first, last):
    result, current = [], first
    while (current.year, current.month) <= (last.year, last.month):
        result.append(current)
        current = matching.shift(current, 1)
    return result


def _before(a, b):
    return (a.year, a.month) < (b.year, b.month)


def _categories():
    rows = list(Category.objects.values_list("pk", "parent_id", "name"))
    parents = {pk: parent for pk, parent, _ in rows}
    names = {pk: name for pk, _, name in rows}
    unassigned = {pk for pk, _, name in rows if name == UNASSIGNED_NAME}
    return parents, names, unassigned


def load_spends(request, first, last, parents, unassigned):
    """Видимые траты с ``first`` по ``last`` включительно: два запроса.

    Категория траты — общий предок категорий её строк (строка без товара — своя категория,
    с товаром — категория его обобщённого продукта); «Не разобрано» не считается.
    """
    receipts = Receipt.objects.filter(visible_receipts_q(request), purchased_on__gte=first, purchased_on__lte=last)
    rows = list(receipts.values_list("id", "purchased_on", "store_id", "currency_id", "total", "payment_method"))
    lines = (ReceiptLine.objects.filter(receipt_id__in=receipts.values("id"))
             .annotate(line_category=Coalesce(F("category_id"), F("product__generic__category_id")))
             .filter(line_category__isnull=False).values_list("receipt_id", "line_category").distinct())
    categories = {}
    for receipt_id, category_id in lines:
        if category_id not in unassigned:
            categories.setdefault(receipt_id, set()).add(category_id)
    return [
        matching.Spend(pk, day, store_id, matching.common_category(categories.get(pk, ()), parents), currency, total, method)
        for pk, day, store_id, currency, total, method in rows
    ]


def load_incomes(request, first, last):
    """Доходы всей семьи (``owner_q``) с ``first`` по ``last`` как «траты» сверки: получен ли регулярный доход,
    решают все доходы семьи, а не только видимые запросу записи; один запрос."""
    from incomes.models import Income

    rows = Income.objects.filter(owner_q(request, since="received_on"), received_on__gte=first,
                                 received_on__lte=last)
    return [matching.Spend(pk, day, None, category_id, currency, amount) for pk, day, category_id, currency, amount
            in rows.values_list("id", "received_on", "category_id", "currency_id", "amount")]


def _plan(payment):
    category_id = payment.income_category_id if payment.kind == INCOME else payment.category_id
    return matching.Plan(payment.pk, payment.store_id, category_id, payment.currency_id, payment.amount,
                         payment.due_day)


def _in_plan_currencies(spends, currencies):
    """Траты и их копии в валютах платежей по курсу дня покупки: 225 $ оплачивают платёж в тенге.

    Копия — тот же id, поэтому трата по-прежнему закрывает один платёж; без курса копии нет. Курсы — один
    запрос на валюту платежа и только когда есть траты в другой валюте.
    """
    copies = []
    for currency in currencies:
        foreign = [spend for spend in spends if spend.currency != currency]
        if not foreign:
            continue
        rates = convert.converter(currency, {(spend.currency, spend.day) for spend in foreign})
        for spend in foreign:
            total = rates.convert(spend.total, spend.currency, spend.day)
            if total is not None:
                copies.append(replace(spend, currency=currency, total=total))
    return spends + copies


class _Ledger:
    """Сверка платежей запроса с тратами за месяцы ``first`` … ``last``."""

    def __init__(self, request, first, last, today):
        self.request, self.today = request, today
        self.payments = list(
            RecurringPayment.objects.filter(visible_payments_q(request))
            .select_related("store__merchant", "category", "income_category", "created_by").order_by("due_day", "name", "pk"))
        self.parents, self.names, unassigned = _categories()
        # Окно месяца начинается до его первого числа и кончается в следующем месяце.
        self.spends = load_spends(request, first.first - timedelta(days=matching.EARLY_DAYS),
                                  matching.shift(last, 1).last, self.parents, unassigned)
        self.months = _months(first, last)
        # С тратой ответа тем же запросом: её комментарий отличает «по средней» от «Оплатил».
        decisions = list(RecurringDecision.objects.filter(
            payment__in=[payment.pk for payment in self.payments], month__gte=first.first, month__lte=last.first)
            .select_related("receipt"))
        visible = {spend.id for spend in self.spends}
        missing = {item.receipt_id for item in decisions
                   if item.decision == RecurringDecision.Decision.ADDED and item.receipt_id not in visible}
        # Трата ответа удалена — ответа нет; скрыта главным — ответ остаётся, без траты.
        existing = set(Receipt.objects.filter(pk__in=missing).values_list("pk", flat=True)) if missing else set()
        self.decisions, fixed = {}, {}
        for item in decisions:
            key = (item.payment_id, Month.of(item.month))
            if item.decision == RecurringDecision.Decision.ADDED:
                if item.receipt_id in visible:
                    fixed[key] = item.receipt_id
                elif item.receipt_id not in existing:
                    continue
            self.decisions[key] = item
        plans = [_plan(payment) for payment in self.payments if payment.active and payment.kind == SPEND]
        pool = _in_plan_currencies(self.spends, {plan.currency for plan in plans})
        self.assigned = matching.assign(plans, pool, self.months, self.parents, fixed)
        self.taken = {spend.id for spend in self.assigned.values()}
        # Регулярный доход сверяется с доходами месяца тем же окном; запрос — только когда такой шаблон есть.
        incomes = [_plan(payment) for payment in self.payments if payment.active and payment.kind == INCOME]
        if incomes:
            found = load_incomes(request, first.first - timedelta(days=matching.EARLY_DAYS), matching.shift(last, 1).last)
            self.assigned.update(matching.assign(incomes, found, self.months, {}, score=matching.income_signals))
        self.paid_months = {}
        for (payment_id, month), spend in self.assigned.items():
            self.paid_months.setdefault(payment_id, []).append((month, spend))
        for items in self.paid_months.values():
            items.sort(key=lambda item: (item[0].year, item[0].month))

    def started(self, payment):
        created = Month.of(timezone.localtime(payment.created_at).date())
        found = self.paid_months.get(payment.pk)
        return found[0][0] if found and _before(found[0][0], created) else created

    def state(self, payment, month):
        if not payment.active:
            return INACTIVE
        if (payment.pk, month) in self.assigned:
            return PAID
        decision = self.decisions.get((payment.pk, month))
        if decision is not None:
            return PAID if decision.decision == RecurringDecision.Decision.ADDED else decision.decision
        if _before(month, self.started(payment)):
            return BEFORE
        return DUE if self.today <= matching.due_date(month, payment.due_day) else OVERDUE

    def average(self, payment, month):
        """Средняя найденных оплат за 12 месяцев по ``month`` включительно; ``None`` — оплат нет."""
        start = matching.shift(month, 1 - AVERAGE_MONTHS)
        return matching.average(spend.total for paid, spend in self.paid_months.get(payment.pk, ())
                                if not _before(paid, start) and not _before(month, paid))

    def of(self, payment, month):
        state = self.state(payment, month)
        decision = self.decisions.get((payment.pk, month))
        row = PaymentMonth(payment, state, matching.due_date(month, payment.due_day),
                           spend=self.assigned.get((payment.pk, month)),
                           added=decision is not None and decision.decision == RecurringDecision.Decision.ADDED
                           and decision.receipt is not None and decision.receipt.note.endswith(AVERAGE_NOTE))
        if state == INACTIVE:
            return row
        row.average = self.average(payment, month)
        found = [spend.total for paid, spend in self.paid_months.get(payment.pk, ()) if not _before(month, paid)]
        if found:
            row.last = found[-1]
            if len(found) > 1 and found[-2] != found[-1]:
                row.previous = found[-2]
        row.history = [(item, self.state(payment, item))
                       for item in (matching.shift(month, step - HISTORY_MONTHS + 1) for step in range(HISTORY_MONTHS))]
        row.year = [(item, self.state(payment, item), self.assigned.get((payment.pk, item)))
                    for item in (matching.shift(month, -step) for step in range(YEAR_MONTHS))]
        return row

    def question(self, payment, month):
        if self.state(payment, month) != OVERDUE:
            return None
        average = self.average(payment, month)
        return Question(payment, month, matching.due_date(month, payment.due_day),
                        average if average is not None else payment.amount, average is not None)

    def suggestions(self):
        """Предложения по тратам последних 12 месяцев без уже заведённых платежей и скрытых предложений."""
        start = matching.shift(Month.of(self.today), -LOOKBACK_MONTHS).first
        dismissed = set(DismissedSuggestion.objects.filter(payments_q(self.request))
                        .values_list("store_id", "category_id", "currency_id"))
        taken = self.taken

        def covered(store_id, category_id, currency, last):
            # Скрыто; последняя трата уже оплата какого-то платежа; у того же получателя есть платёж той же категории.
            # Аренда, квитанция и ОСИ у одного получателя — разные платежи: вложенность категорий и сумма не в счёт.
            if (store_id, category_id, currency) in dismissed or last.id in taken:
                return True
            return any((payment.store_id, payment.category_id, payment.currency_id) == (store_id, category_id, currency)
                       for payment in self.payments)

        found = matching.suggest([spend for spend in self.spends if spend.day >= start], self.today, covered)
        if not found:
            return []
        stores = {store.pk: store for store in Store.objects.select_related("merchant")
                  .filter(pk__in={item.store_id for item in found})}
        rows = []
        for item in found:
            store = stores.get(item.store_id)
            store_name = (store.merchant.brand_name or store.name) if store is not None else ""
            rows.append(SuggestionView(item, store_name or self.names.get(item.category_id, ""), store_name,
                                       self.names.get(item.category_id, "")))
        # Одна вывеска у нескольких предложений и платежей («Съемное жилье»: аренда, квитанция, ОСИ): имя — категория,
        # а если и она повторяется — вывеска и категория.
        names = [row.name for row in rows] + [payment.name for payment in self.payments]
        categories = [row.category_name for row in rows] + [payment.any_category.name for payment in self.payments]
        for row in rows:
            if names.count(row.name) > 1 and row.category_name:
                row.name = (row.category_name if categories.count(row.category_name) == 1
                            else f"{row.name} · {row.category_name}")[:100]
        return rows


def _ledger(request, month, today):
    current = Month.of(today)
    later = month if _before(current, month) else current
    earlier = month if _before(month, current) else current
    return _Ledger(request, matching.shift(earlier, -LOOKBACK_MONTHS), later, today)


def month_view(request, month, today=None, *, suggestions=True):
    """Платежи запроса в ``month``; вопросы о прошлом месяце — только когда ``month`` текущий."""
    today = today or timezone.localdate()
    ledger = _ledger(request, month, today)
    payments = [ledger.of(payment, month) for payment in ledger.payments]
    questions = []
    if month == Month.of(today):
        previous = month.previous()
        questions = [item for item in (ledger.question(payment, previous) for payment in ledger.payments
                                       if payment.active and payment.kind == SPEND) if item is not None]
    return MonthView(month, today, payments, questions, ledger.suggestions() if suggestions else [])


def unpaid(user, month, today=None):
    """Неоплаченные включённые платежи пользователя (его семьи) в ``month`` — для «можно тратить в день».

    Только платежи (траты): регулярный доход сюда не входит.

    ``month`` — ``budget.dashboard.Month`` либо дата внутри месяца. Каждый — ``{"id", "name",
    "amount" (Decimal, ожидаемая сумма), "currency", "due_date", "overdue"}``; оплаченные,
    отвеченные («не было», «оплачено иначе») и выключенные не входят. Валюты не складываются.
    """
    if isinstance(month, date):
        month = Month.of(month)
    view = month_view(as_request(user), month, today, suggestions=False)
    return [
        {"id": row.payment.pk, "name": row.payment.name, "amount": row.payment.amount,
         "currency": row.payment.currency_id, "due_date": row.due, "overdue": row.state == OVERDUE}
        for row in view.payments if row.state in UNPAID and row.payment.kind == SPEND
    ]


AVERAGE_NOTE = ": средняя оплата (платёж не найден)"


def spend_note(payment, month):
    return f"{payment.name} за {month_name(month)}{AVERAGE_NOTE}"


def _store_name(store):
    """Название места для ``receipts.manual.create``: вывеска либо название, не длиннее поля формы."""
    if store is None:
        return None
    name = (store.merchant.brand_name or store.name).strip()
    return name if 0 < len(name) <= manual.STORE_NAME_MAX else None


def decide(request, payment_id, month, decision, today=None):
    """Ответ на вопрос о месяце ``month`` (до текущего): ``added`` / ``skipped`` / ``elsewhere``.

    ``added`` создаёт ручную трату владельцем — пользователем запроса — в срок месяца на
    среднюю оплату. Платёж уже оплачен — ``DecisionRefused("already_paid")``, ответ уже есть —
    ``DecisionRefused("already_decided")``. Одна транзакция: трата и ответ вместе либо ничего.
    """
    def spend(payment, ledger):
        amount = ledger.average(payment, month) or payment.amount
        return {"total": f"{amount:.2f}", "purchased_on": matching.due_date(month, payment.due_day).isoformat(),
                "note": spend_note(payment, month)}

    return _answer(request, payment_id, month, decision, today,
                   spend if decision == RecurringDecision.Decision.ADDED else None)


def pay(request, payment_id, month, amount, method, day, today=None):
    """«Оплатил» (2026-10-13): трата на ``amount`` в день ``day`` способом ``method`` (``""`` — не указан) с местом и
    категорией платежа и комментарием «<название> за <месяц>» плюс ответ ``added`` с ней — месяц ``month`` оплачен,
    даже если сумма далеко от ожидаемой или у платежа нет места. Отказы и транзакция — как у ``decide``.
    """
    return _answer(request, payment_id, month, RecurringDecision.Decision.ADDED, today, lambda payment, ledger: {
        "total": f"{amount:.2f}", "purchased_on": day.isoformat(), "note": f"{payment.name} за {month_name(month)}",
        "payment_method": method})


def _answer(request, payment_id, month, decision, today, spend):
    """Ответ о месяце; ``spend(payment, ledger)`` — поля траты ответа (без валюты, категории и места), ``None`` — без траты."""
    today = today or timezone.localdate()
    with transaction.atomic():
        # Блокировка платежа упорядочивает ответы на один платёж: второй ждёт и видит первый.
        payment = RecurringPayment.objects.select_for_update().get(payments_q(request), pk=payment_id, kind=SPEND)
        stale = RecurringDecision.objects.filter(payment=payment, month=month.first).first()
        if stale is not None and stale.decision == RecurringDecision.Decision.ADDED \
                and not Receipt.objects.filter(pk=stale.receipt_id).exists():
            stale.delete()
        ledger = _ledger(request, month, today)
        payment = next(item for item in ledger.payments if item.pk == payment.pk)
        state = ledger.state(payment, month)
        if state == PAID:
            raise DecisionRefused("already_paid")
        if state in (SKIPPED, ELSEWHERE):
            raise DecisionRefused("already_decided")
        receipt = None
        if spend is not None:
            body = {"currency": payment.currency_id, "category": payment.category_id, **spend(payment, ledger)}
            store_name = _store_name(payment.store)
            if store_name:
                body["store_name"] = store_name
            receipt = manual.create(request_user(request), body)
        try:
            with transaction.atomic():
                return RecurringDecision.objects.create(
                    payment=payment, month=month.first, decision=decision, receipt=receipt,
                    decided_by=request_user(request))
        except IntegrityError:
            raise DecisionRefused("already_decided") from None


def accept(request, store_id, category_id, currency, today=None):
    """Завести платёж из предложения; ``None`` — такого предложения сейчас нет."""
    today = today or timezone.localdate()
    ledger = _ledger(request, Month.of(today), today)
    for row in ledger.suggestions():
        item = row.suggestion
        if (item.store_id, item.category_id, item.currency) == (store_id, category_id, currency):
            return RecurringPayment.objects.create(
                **owner_fields(request), name=row.name, store_id=item.store_id, category_id=item.category_id,
                currency_id=item.currency, amount=item.amount, due_day=item.due_day,
                created_by=request_user(request))
    return None


def dismiss(request, store_id, category_id, currency):
    """Скрыть предложение навсегда; повтор ничего не меняет."""
    try:
        with transaction.atomic():
            DismissedSuggestion.objects.get_or_create(
                **owner_fields(request), store_id=store_id, category_id=category_id, currency_id=currency,
                defaults={"dismissed_by": request_user(request)})
    except IntegrityError:
        pass  # тот же ответ пришёл одновременно
