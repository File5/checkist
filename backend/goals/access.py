"""Кто видит и правит цели — одно правило поверх ``accounts.access``.

- общая цель семьи (``household``) — все члены этой семьи;
- личная (``user``) — её владелец и главный его семьи (``Membership.role == head``);
- пользователь без семьи — только свои; ``local_single`` — цели пользователя ``local``.

Кто видит цель, тот и правит её и взносы. Вью не читают ``request.user``: они берут
``goals_q`` и ``goal_owner`` отсюда; ``as_request(user)`` — то же правило вне HTTP-запроса.
"""
from django.db.models import Q

from accounts.access import LOCAL_SINGLE, household, mode, request_user
from receipts.ownership import LOCAL_USERNAME


class _UserRequest:
    """Запрос без HTTP: правила ``accounts.access`` читают только ``user``."""

    def __init__(self, user):
        self.user = user


def as_request(user):
    return _UserRequest(user)


def goals_q(request, prefix=""):
    """goals_q(request, prefix="") -> Q; цели, которые запрос видит и правит (``prefix`` — путь до ``Goal``)."""
    if mode() == LOCAL_SINGLE:
        return Q(**{f"{prefix}user__username": LOCAL_USERNAME})
    pk = request.user.pk
    if pk is None:
        return Q(**{f"{prefix}pk__in": []})
    from accounts.models import Membership

    mine = Membership.objects.filter(user_id=pk)
    headed = Membership.objects.filter(
        household_id__in=mine.filter(role=Membership.Role.HEAD).values("household_id")).values("user_id")
    return (Q(**{f"{prefix}user_id": pk}) | Q(**{f"{prefix}household_id__in": mine.values("household_id")})
            | Q(**{f"{prefix}user_id__in": headed}))


def goal_owner(request, shared):
    """Поля владельца цели: общая — семья запроса, личная — сам пользователь. Без семьи общей не бывает."""
    family = household(request) if shared else None
    if family is not None:
        return {"household": family, "user": None}
    return {"household": None, "user": request_user(request)}
