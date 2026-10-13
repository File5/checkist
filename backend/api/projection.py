"""«Своё / чужое» в общих данных: чьё наблюдение цены или строка чека.

Цены, магазины и товары общие для всех вошедших, чеки — личные. Чужое наблюдение
остаётся в ответе (цена, день, магазин), но без полей, по которым находится чужой чек:
вью помечает строки ``own_annotation`` и обнуляет такие поля у строк с ``own=False``.
Владельца определяет только ``accounts.access.owner_q``: в ``local_single`` своё — чеки
пользователя ``local``.
"""
from django.db.models import BooleanField, ExpressionWrapper, Q

from accounts.access import visible_receipts_q
from merges.visibility import visible, visible_q
from receipts.prices import private_products


def own_annotation(request, prefix="receipt__"):
    """own_annotation(request, prefix="receipt__") -> булево выражение «чек принадлежит запросу».

    ``prefix`` — путь до модели с ``owner``, как у ``owner_q``: ``"receipt__"`` от строки
    чека. Выражение — для ``annotate(own=...)``: отдельного запроса не добавляет, в
    ``local_single`` даёт JOIN с пользователем. ``owner`` не бывает NULL, значение — всегда
    ``True`` либо ``False``.
    """
    return ExpressionWrapper(visible_receipts_q(request, prefix), output_field=BooleanField())


def seen_products(request, queryset):
    """Товары ``queryset``, которые видит запрос: без поглощённых слиянием (``merges.visibility.visible``) и без
    товаров, у которых есть лишь строки чужих трат вручную (``receipts.prices.private_products``) — их название
    личное («Что купили»). Один подзапрос, без нового запроса."""
    return visible(queryset).exclude(pk__in=private_products(request))


def seen_refs_q(request, *fields):
    """``Q`` записей журнала (группы дублей, предположения категорий), чьи ссылки на товар ``fields`` не ведут к
    товару, которого запрос не видит (``private_products``). Один подзапрос."""
    hidden = private_products(request)
    condition = Q()
    for field in fields:
        condition &= ~Q(**{f"{field}__in": hidden})
    return condition


def seen_products_q(request, prefix=""):
    """То же условие как ``Q`` по пути до ``Product``: для счётчиков ``Count("products", filter=...)``."""
    return visible_q(prefix) & ~Q(**{f"{prefix}pk__in": private_products(request)})
