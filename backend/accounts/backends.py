"""Проверка логина и пароля со счётчиком неудач: общая для ``/api/auth/login/`` и ``/admin/login/``."""
from django.contrib.auth import get_user_model
from django.contrib.auth.backends import ModelBackend
from django.core.exceptions import PermissionDenied

from . import throttle


class ThrottledModelBackend(ModelBackend):
    """``ModelBackend`` с защитой от перебора (``accounts.throttle``).

    Заблокированная попытка пароль не проверяет: бросает ``PermissionDenied`` (Django
    считает вход неудачным и остальные backend не спрашивает) и ставит на запрос
    ``login_retry_after`` — секунды до конца блокировки. Несуществующий логин, неверный
    пароль и выключенный пользователь считаются одинаково. Без ``request``
    (``Client.login``, команды) счётчик не действует.
    """

    def authenticate(self, request, username=None, password=None, **kwargs):
        if username is None:
            username = kwargs.get(get_user_model().USERNAME_FIELD)
        if request is None or username is None or password is None:
            return super().authenticate(request, username=username, password=password, **kwargs)
        login_keys = throttle.keys(request, username)
        seconds = throttle.retry_after(login_keys)
        if seconds:
            request.login_retry_after = seconds
            raise PermissionDenied
        user = super().authenticate(request, username=username, password=password, **kwargs)
        if user is None:
            throttle.record_failure(login_keys)
        else:
            throttle.reset(login_keys)
        return user
