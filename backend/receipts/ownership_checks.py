"""Проверка перед откатом владельца: какие чеки нарушат прежние глобальные ограничения.

Обратный ход ``receipts.0005`` возвращает три ограничения без ``owner`` и падает целиком,
если одинаковый чек есть у двух владельцев. Здесь только чтение: такие группы ищутся заранее.
У одного владельца дубль невозможен — его не пускают действующие ограничения с ``owner``.
"""
from collections import defaultdict
from dataclasses import dataclass
from functools import reduce
from operator import or_

from django.db.models import Count, Q

from .models import Receipt

# Столько групп ищется одним запросом строк: условие — OR по ключам групп.
GROUP_CHUNK = 200


@dataclass(frozen=True)
class RollbackRule:
    """Прежнее ограничение: уникальность ``fields`` среди строк, подходящих под ``condition``."""

    name: str
    constraint: str
    fields: tuple
    condition: Q | None = None


# Поля и условия — как в receipts.0001_initial; с историей миграций их сверяет тест.
RECEIPT_ROLLBACK_RULES = (
    RollbackRule(
        name="receipt_fiscal_key",
        constraint="receipts_receipt_fiscal_key_uniq",
        fields=("fiscal_key",),
        condition=~Q(fiscal_key=""),
    ),
    RollbackRule(
        name="receipt_store_number",
        constraint="receipts_receipt_store_number_uniq",
        fields=("store", "purchased_on", "shift_number", "register_code", "receipt_number"),
        condition=~Q(receipt_number=""),
    ),
    RollbackRule(
        name="receipt_store_time_total",
        constraint="receipts_receipt_store_time_total_uniq",
        fields=("store", "purchased_at", "total"),
        condition=Q(receipt_number="", fiscal_key=""),
    ),
)


def duplicate_groups(queryset, fields):
    """Группы строк ``queryset`` с одинаковыми ``fields``: ``[[(id, owner_id), ...], ...]``.

    В группе не меньше двух строк; строки — по id, группы — по наименьшему id. Значения полей
    наружу не выходят. Запросов — один на поиск ключей и по одному на ``GROUP_CHUNK`` групп.
    """
    keys = [
        {field: row[field] for field in fields}
        for row in queryset.order_by().values(*fields).annotate(group_size=Count("pk")).filter(group_size__gt=1)
    ]
    members = defaultdict(list)
    for start in range(0, len(keys), GROUP_CHUNK):
        match = reduce(or_, (Q(**key) for key in keys[start:start + GROUP_CHUNK]))
        for pk, owner_id, *key in queryset.filter(match).order_by("pk").values_list("pk", "owner_id", *fields):
            members[tuple(key)].append((pk, owner_id))
    # Строка могла исчезнуть между двумя запросами: группа из одной строки уже не нарушение.
    return sorted((rows for rows in members.values() if len(rows) > 1), key=lambda rows: rows[0][0])


def rule_groups(rule, queryset):
    queryset = queryset if rule.condition is None else queryset.filter(rule.condition)
    return duplicate_groups(queryset, rule.fields)


def receipt_rollback_conflicts():
    """``[(RollbackRule, [(receipt_id, owner_id), ...]), ...]`` — по правилам, затем по id чека."""
    return [
        (rule, rows)
        for rule in RECEIPT_ROLLBACK_RULES
        for rows in rule_groups(rule, Receipt.objects.all())
    ]
