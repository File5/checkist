"""Владелец чеков и фото: пользователь ``local``.

Ему миграции ``receipts.0004`` и ``recognition.0003`` отдали все прежние чеки и фото.
Запись обычная: пароля нет, пока человек не задаст его (``manage.py changepassword local``).
"""
from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password

LOCAL_USERNAME = "local"


def local_user():
    """local_user() -> User; создаёт запись при отсутствии, существующую не меняет.

    На миграцию не опирается: ``TransactionTestCase`` очищает таблицы после теста.
    Кэша на уровне модуля нет по той же причине.
    """
    user, _created = get_user_model().objects.get_or_create(username=LOCAL_USERNAME, defaults={
        "is_active": True, "is_staff": False, "is_superuser": False, "password": make_password(None),
    })
    return user
