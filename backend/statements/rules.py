"""Правила «получатель → категория (+ магазин) | пропускать | свои счета / семья | → цель».

Владелец правила — как у лимитов (``budget.access``): семья, если она есть, иначе
пользователь; вью передают сюда ``limit_owner(request)``. Правило «→ цель» (перевод на
свой депозит — взнос в цель) личное: его владелец — пользователь, даже в семье, и видно оно
только ему и только пока видна цель (``visible_q`` / ``scope_of``).
Правило подходит строке, когда слова его ``key`` стоят подряд в нормализованном
получателе; из подходящих берётся самое длинное (самое точное), при равной длине — личное.
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


def _with_goals(shared, user, goal_scope):
    from goals.models import Goal

    goal = StatementRule.Action.GOAL
    return (shared & ~Q(action=goal)) | Q(
        action=goal, user=user, household__isnull=True, goal__in=Goal.objects.filter(goal_scope))


def scope_of(user):
    """Правила, видимые пользователю вне запроса, — как ``visible_q``."""
    from goals.access import as_request, goals_q

    owner = owner_of(user)
    if owner["household"] is not None:
        shared = Q(household=owner["household"])
    else:
        shared = Q(user=owner["user"], household__isnull=True)
    return _with_goals(shared, user, goals_q(as_request(user)))


def visible_q(request):
    """Правила запроса: общие, как лимиты (``budget.access.limits_q``), и свои «→ цель» на видимые цели."""
    from accounts.access import request_user
    from budget.access import limits_q
    from goals.access import goals_q

    return _with_goals(limits_q(request), request_user(request), goals_q(request))


class RuleBook:
    """Правила владельца, загруженные один раз на черновик."""

    def __init__(self, rules):
        self.rules = sorted(rules, key=lambda rule: (-len(rule.key), rule.household_id is not None, rule.pk))

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
              "category_id": category_id, "store_name": (store_name or "")[:STORE_MAX], "goal_id": None}
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
        rule.save(update_fields=["action", "category", "store_name", "goal", "updated_at"])
        return True


def remember_goal(user, *, merchant, goal_id, actor):
    """«Переводы этому получателю — взносы в цель»: личное правило ``user`` (новое либо переписанное)."""
    key = normalize(merchant)
    fields = {"pattern": merchant.strip()[:PATTERN_MAX], "action": StatementRule.Action.GOAL, "goal_id": goal_id,
              "category_id": None, "store_name": ""}
    lookup = {"household": None, "user": user, "key": key}
    with transaction.atomic():
        rule = StatementRule.objects.select_for_update().filter(**lookup).first()
        if rule is None:
            try:
                with transaction.atomic():
                    return StatementRule.objects.create(**lookup, **fields, created_by=actor)
            except IntegrityError:  # то же правило только что завёл соседний запрос
                rule = StatementRule.objects.select_for_update().get(**lookup)
        for name, value in fields.items():
            setattr(rule, name, value)
        rule.save()
        return rule
