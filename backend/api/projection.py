"""«Своё / чужое» в общих данных: чьё наблюдение цены или строка чека.

Цены, магазины и товары общие для всех вошедших, чеки — личные. Чужое наблюдение
остаётся в ответе (цена, день, магазин), но без полей, по которым находится чужой чек:
вью помечает строки ``own_annotation`` и обнуляет такие поля у строк с ``own=False``.
Владельца определяет только ``accounts.access.owner_q``: в ``local_single`` своё — чеки
пользователя ``local``.
"""
from django.db.models import BooleanField, ExpressionWrapper

from accounts.access import owner_q


def own_annotation(request, prefix="receipt__"):
    """own_annotation(request, prefix="receipt__") -> булево выражение «чек принадлежит запросу».

    ``prefix`` — путь до модели с ``owner``, как у ``owner_q``: ``"receipt__"`` от строки
    чека. Выражение — для ``annotate(own=...)``: отдельного запроса не добавляет, в
    ``local_single`` даёт JOIN с пользователем. ``owner`` не бывает NULL, значение — всегда
    ``True`` либо ``False``.
    """
    return ExpressionWrapper(owner_q(request, prefix), output_field=BooleanField())
