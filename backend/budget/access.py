"""Чьи лимиты видит и правит запрос; правило рядом с ``accounts.access.owner_q``.

У пользователя с семьёй лимиты общие на семью (``household``), без семьи — свои
(``user``). В ``local_single`` семьи нет: лимиты пользователя ``local``. Вью не читают
``request.user``: они берут ``limits_q``, ``limit_owner`` и ``members`` отсюда.
"""
from django.db.models import Q

from accounts.access import household, request_user


def limit_owner(request):
    """limit_owner(request) -> dict; поля владельца нового лимита: ``household`` либо ``user``."""
    family = household(request)
    if family is not None:
        return {"household": family, "user": None}
    return {"household": None, "user": request_user(request)}


def limits_q(request, prefix=""):
    """limits_q(request) -> Q; лимиты, которые запрос видит и правит.

    С семьёй — только лимиты семьи (личные лимиты, заведённые до вступления, не видны),
    без семьи — только свои.
    """
    owner = limit_owner(request)
    if owner["household"] is not None:
        return Q(**{f"{prefix}household": owner["household"]})
    return Q(**{f"{prefix}user": owner["user"], f"{prefix}household__isnull": True})


def members(request):
    """members(request) -> list[str]; логины членов семьи по алфавиту, без семьи — ``[свой]``."""
    family = household(request)
    if family is None:
        return [request_user(request).get_username()]
    return sorted(family.memberships.values_list("user__username", flat=True))
