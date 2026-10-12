"""Как показывать человека: имя из поля «Имя» (``first_name``) учётной записи, иначе логин.

Имя задаёт администратор в форме пользователя админки (``/admin/auth/user/…``, поле
«Имя» / «First name»). Логин остаётся ключом фильтров и записей; имя — только для показа.
"""


def display_name(user):
    """display_name(user) -> str; ``first_name`` без пробелов по краям, пустое — логин."""
    return (user.first_name or "").strip() or user.get_username()


def person(user):
    """person(user) -> {"username", "display_name"}."""
    return {"username": user.get_username(), "display_name": display_name(user)}


def household_people(family):
    """household_people(family) -> list; члены семьи ``person(...)`` по логину."""
    memberships = family.memberships.select_related("user").order_by("user__username")
    return [person(membership.user) for membership in memberships]
