"""Настройки пользователя (``accounts.Profile``): чтение со значениями по умолчанию и правка.

Строки профиля может не быть: она создаётся при первом ``PATCH /api/me/settings/``.
"""
from accounts.models import Profile


def default_currency(user):
    """default_currency(user) -> str | None; основная валюта пользователя либо ``None``."""
    if user is None or user.pk is None:
        return None
    return Profile.objects.filter(user_id=user.pk).values_list("default_currency_id", flat=True).first()


def request_default_currency(request):
    """Основная валюта пользователя запроса одним запросом (в ``local_single`` — без чтения пользователя)."""
    from accounts.access import LOCAL_SINGLE, mode
    from receipts.ownership import LOCAL_USERNAME

    if mode() == LOCAL_SINGLE:
        rows = Profile.objects.filter(user__username=LOCAL_USERNAME)
    elif request.user.pk is None:
        return None
    else:
        rows = Profile.objects.filter(user_id=request.user.pk)
    return rows.values_list("default_currency_id", flat=True).first()


def save(user, *, default_currency=...):
    """Записать переданные настройки; ``...`` — поле не менять. Возвращает ``Profile``."""
    profile, _ = Profile.objects.get_or_create(user=user)
    if default_currency is not ...:
        profile.default_currency_id = default_currency
    profile.save()
    return profile
