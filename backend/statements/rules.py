"""Правила «получатель → категория (+ магазин) | пропускать | свои счета / семья».

Владелец правила — как у лимитов (``budget.access``): семья, если она есть, иначе
пользователь; вью передают сюда ``limit_owner(request)`` и ``limits_q(request)``.
Правило подходит строке, когда слова его ``key`` стоят подряд в нормализованном
получателе; из подходящих берётся самое длинное (самое точное).
"""
import re

from django.db import IntegrityError, transaction
from django.db.models import Q

from .models import StatementRule

PATTERN_MAX = 200
STORE_MAX = 100
_NON_WORD = re.compile(r"[^\w]+")


def normalize(text):
    """Ключ получателя: строчные буквы, «ё» как «е», знаки препинания — пробелы."""
    return " ".join(_NON_WORD.sub(" ", (text or "").casefold().replace("ё", "е")).split())[:PATTERN_MAX]


def owner_of(user):
    """Владелец правил пользователя вне запроса (команды, демо) — как ``budget.access.limit_owner``."""
    from accounts.access import LOCAL_SINGLE, mode
    from accounts.models import Household

    family = None if mode() == LOCAL_SINGLE else Household.objects.filter(memberships__user_id=user.pk).first()
    return {"household": family, "user": None} if family is not None else {"household": None, "user": user}


def scope_of(user):
    """Правила, видимые пользователю вне запроса, — как ``budget.access.limits_q``."""
    owner = owner_of(user)
    if owner["household"] is not None:
        return Q(household=owner["household"])
    return Q(user=owner["user"], household__isnull=True)


class RuleBook:
    """Правила владельца, загруженные один раз на черновик."""

    def __init__(self, rules):
        self.rules = sorted(rules, key=lambda rule: (-len(rule.key), rule.pk))

    @classmethod
    def load(cls, scope):
        """``scope`` — Q видимых запросу правил (``budget.access.limits_q``)."""
        return cls(list(StatementRule.objects.filter(scope).select_related("category")))

    def match(self, merchant):
        """Самое длинное правило, чьи слова стоят подряд в получателе; ``None`` — правила нет."""
        text = f" {normalize(merchant)} "
        if not text.strip():
            return None
        for rule in self.rules:
            if f" {rule.key} " in text:
                return rule
        return None


def learn(owner, *, merchant, category_id, store_name, actor):
    """Правка категории или места для получателя → правило владельца ``owner``; ``True`` — правило изменено.

    ``owner`` — ``{"household": …, "user": …}`` из ``limit_owner``. Ручное правило того же
    получателя тоже переписывается: человек только что выбрал другое.
    """
    key = normalize(merchant)
    if not key:
        return False
    fields = {"pattern": merchant.strip()[:PATTERN_MAX], "action": StatementRule.Action.CATEGORY,
              "category_id": category_id, "store_name": (store_name or "")[:STORE_MAX]}
    lookup = {"household": owner["household"], "user": owner["user"], "key": key}
    with transaction.atomic():
        rule = StatementRule.objects.select_for_update().filter(**lookup).first()
        if rule is None:
            try:
                with transaction.atomic():
                    StatementRule.objects.create(**lookup, **fields, origin=StatementRule.Origin.LEARNED, created_by=actor)
                return True
            except IntegrityError:  # тот же получатель только что выучен другим запросом
                rule = StatementRule.objects.select_for_update().get(**lookup)
        if (rule.action, rule.category_id, rule.store_name) == (fields["action"], category_id, fields["store_name"]):
            return False
        for name, value in fields.items():
            if name != "pattern":
                setattr(rule, name, value)
        rule.save(update_fields=["action", "category", "store_name", "updated_at"])
        return True
