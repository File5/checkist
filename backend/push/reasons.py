"""Поводы push и тик (``manage.py push tick`` строкой cron раз в 5 минут).

Поводы читаются из чужих приложений, сигналов в них нет:

- ``recurring`` — неоплаченный регулярный платёж за 1–2 дня до срока и просроченный
  (``recurring.services.unpaid``), по разу на платёж и срок;
- ``limits`` — 80 % и 100 % лимита категории и всех лимитов месяца в основной валюте
  (расчёт Главной ``budget.dashboard``), по разу на порог, категорию и месяц;
- ``weekly`` — воскресенье с 20:00: траты недели (пн–вс) против прошлой;
- ``monthly`` — 1-го числа: «Разбор <месяца>» со ссылкой ``/review?month=ГГГГ-ММ``;
- ``large`` — трата другого члена семьи не меньше порога человека (в основной валюте), за сутки.

Траты — ``accounts.access.visible_receipts_q`` (скрытые платежи не видны никому), деньги разных
валют — ``rates.convert``. Часы и даты — ``services.LOCAL_TZ``.
"""
import logging
from datetime import timedelta
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Sum
from django.utils import timezone

from accounts.access import visible_receipts_q
from accounts.people import display_name
from api import common, stats_common
from budget import dashboard, history
from budget.access import limits_q
from budget.models import BudgetLimit
from rates.convert import base_currency, converter
from receipts.models import Receipt
from recurring import services as recurring
from recurring.access import as_request

from . import services
from .services import money

logger = logging.getLogger(__name__)

WEEKLY_HOUR = 20
MONTHS = ("январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь",
          "декабрь")
MONTHS_OF = ("января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября",
             "декабря")


def _day(day):
    return f"{day.day}{services.NBSP}{MONTHS_OF[day.month - 1]}"


def recurring_due(user, now, prefs):
    today = now.astimezone(services.LOCAL_TZ).date()
    for row in recurring.unpaid(user, today, today):
        due, amount = row["due_date"], money(row["amount"], row["currency"])
        if row["overdue"]:
            yield (f"overdue:{row['id']}:{due}", f"Просрочен платёж: {row['name']}",
                   f"{amount}, срок был {_day(due)}.", "/recurring")
        elif 1 <= (due - today).days <= 2:
            when = "завтра" if (due - today).days == 1 else "послезавтра"
            yield (f"soon:{row['id']}:{due}", f"Скоро платёж: {row['name']}", f"{amount} — {when}, {_day(due)}.",
                   "/recurring")


def _limit(month, key, name, spent, limit, currency):
    if not limit or spent < limit * Decimal("0.8"):
        return []
    over = "бюджета" if key == "budget" else "лимита"
    left = f" Осталось {money(limit - spent, currency)}." if spent < limit else (
        f" Сверх {over} {money(spent - limit, currency)}." if spent > limit else "")
    full, percent = spent >= limit, f"{int(spent * 100 // limit)}{services.NBSP}%"
    if key == "budget":
        title = "Бюджет месяца исчерпан" if full else f"Бюджет месяца: потрачено {percent}"
    elif key == "total":
        title = "Лимиты месяца исчерпаны" if full else f"Лимиты месяца: потрачено {percent}"
    else:
        title = f"{name}: лимит исчерпан" if full else f"{name}: {percent} лимита"
    return [(f"{month.label()}:{key}:{100 if full else 80}", title,
             f"Потрачено {money(spent, currency)} из {money(limit, currency)}.{left}", "/")]


def limits(user, now, prefs):
    request = as_request(user)
    today = now.astimezone(services.LOCAL_TZ).date()
    month = dashboard.Month.of(today)
    found_limits = list(BudgetLimit.objects.filter(limits_q(request)).select_related("category").order_by("pk"))
    # Общий бюджет месяца (``budget.MonthlyBudget``): как полоса на Главной — все видимые траты месяца.
    budget = history.budget_at(limits_q(request), month.first)
    if budget is not None and budget.amount is None:
        budget = None
    if not found_limits and budget is None:
        return
    tree = common.CategoryTree.load()
    found = dashboard.collect_month(Receipt.objects.filter(visible_receipts_q(request)), month,
                                    stats_common.owner_product_id())
    rate_day = dashboard.limit_day(month, today)
    rates = stats_common.converter(request, found.needs() | {(item.currency_id, rate_day) for item in found_limits}
                                   | ({(budget.currency_id, rate_day)} if budget is not None else set()))
    block = stats_common.base_block(
        dashboard.currency_blocks(found, found_limits, month, tree, rates, today), rates.base)
    if block is None:
        return
    if budget is not None:
        amount = rates.convert(budget.amount, budget.currency_id, rate_day)
        if amount:
            yield from _limit(month, "budget", "", block.spent, amount, block.currency)
    limited, rows = [], list(block.categories)
    while rows:
        row = rows.pop(0)
        rows.extend(row.children)
        if row.limit:
            limited.append(row)
    for row in limited:
        yield from _limit(month, row.category_id, row.name, row.spent, row.limit, block.currency)
    if len(limited) > 1:
        yield from _limit(month, "total", "", block.limited_spent or Decimal(0), block.limit_total,
                          block.currency)


def weekly(user, now, prefs):
    local = now.astimezone(services.LOCAL_TZ)
    if local.weekday() != 6 or local.hour < WEEKLY_HOUR:
        return
    today = local.date()
    start, before = today - timedelta(days=6), today - timedelta(days=13)
    rows = list(Receipt.objects.filter(visible_receipts_q(as_request(user)), purchased_on__gte=before,
                                       purchased_on__lte=today)
                .values("purchased_on", "currency_id").annotate(sum=Sum("total")).order_by()
                .values_list("purchased_on", "currency_id", "sum"))
    rates = converter(base_currency(user), {(currency, day) for day, currency, _ in rows})
    week, previous = Decimal(0), Decimal(0)
    for day, currency, total in rows:
        amount = rates.convert(total, currency, day) or Decimal(0)
        if day >= start:
            week += amount
        else:
            previous += amount
    if not week and not previous:
        return
    spent = money(week, rates.base)
    if not previous:
        text = f"Потрачено {spent}. На прошлой неделе трат не было."
    elif week == previous:
        text = f"Потрачено {spent} — столько же, сколько на прошлой неделе."
    else:
        change = int(abs(week - previous) * 100 // previous)
        more = "больше" if week > previous else "меньше"
        text = f"Потрачено {spent} — на {change}{services.NBSP}% {more}, чем на прошлой неделе ({money(previous, rates.base)})."
    yield (f"week:{start}", "Траты за неделю", text, f"/stats?date_from={start}&date_to={today}")


def monthly(user, now, prefs):
    local = now.astimezone(services.LOCAL_TZ)
    if local.day != 1:
        return
    month = dashboard.Month.of(local.date()).previous()
    yield (f"review:{month.label()}", f"Разбор {MONTHS_OF[month.month - 1]}",
           f"{MONTHS[month.month - 1].capitalize()} закончился: на что ушли деньги и что изменилось.",
           f"/review?month={month.label()}")


def large(user, now, prefs):
    today = now.astimezone(services.LOCAL_TZ).date()
    found = list(Receipt.objects.filter(visible_receipts_q(as_request(user)), created_at__gte=now - timedelta(days=1),
                                        purchased_on__gte=today - timedelta(days=1))
                 .exclude(owner=user).select_related("owner", "store__merchant").order_by("pk"))
    if not found:
        return
    rates = converter(base_currency(user), {(item.currency_id, item.purchased_on) for item in found})
    for receipt in found:
        amount = rates.convert(receipt.total, receipt.currency_id, receipt.purchased_on)
        if amount is None or amount < prefs.large_threshold:
            continue
        place = common.store_name(receipt.store) if receipt.store_id else (receipt.note or "без места")
        total = money(receipt.total, receipt.currency_id)
        if receipt.currency_id != rates.base:
            total += f" (≈{services.NBSP}{money(amount, rates.base)})"
        yield (f"receipt:{receipt.pk}", f"Крупная трата: {display_name(receipt.owner)}", f"{total} — {place}.",
               f"/receipts/{receipt.pk}")


REASONS = {"recurring": recurring_due, "limits": limits, "weekly": weekly, "monthly": monthly, "large": large}


def refresh(notification):
    """Отложенное уведомление перед отправкой: ``(title, body, url)`` из того, что человек видит сейчас, либо ``None``.

    Повод ищется заново на момент, когда он был найден (``created_at``), но по нынешним данным: человек вышел из
    семьи, трата скрыта или удалена, платёж оплачен, повод выключен — ключа больше нет, уведомление не уходит.
    """
    user = notification.user
    prefs = services.preferences(user)
    if not user.is_active or not getattr(prefs, notification.kind, False):
        return None
    find = REASONS.get(notification.kind)
    if find is None:
        return notification.title, notification.body, notification.url
    for key, title, body, url in find(user, notification.created_at, prefs):
        if key == notification.key:
            return title, body, url
    return None


def tick(now=None):
    """Найти поводы людей с устройствами и отправить отложенное; ``{"users", "notified", "released"}``."""
    now = now or timezone.now()
    if not services.configured():
        return {"users": 0, "notified": 0, "released": 0}
    users = list(get_user_model().objects.filter(is_active=True, push_subscriptions__isnull=False).distinct())
    notified = 0
    for user in users:
        prefs = services.preferences(user)
        for kind, find in REASONS.items():
            if not getattr(prefs, kind):
                continue
            try:
                for key, title, body, url in find(user, now, prefs):
                    notified += services.notify(user, kind, title, body, url, key, now=now) is not None
            except Exception:  # один сломанный повод не останавливает остальных
                logger.exception("push: reason %s failed for user %s", kind, user.pk)
    return {"users": len(users), "notified": notified, "released": services.flush(now)}
