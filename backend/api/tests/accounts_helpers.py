"""Пользователи и вошедшие клиенты для тестов режима ``accounts``.

Раннер ставит ``local_single``; тест режима ``accounts`` включает его сам::

    @accounts_mode()
    class SomeTests(TwoUsers, TestCase):
        def test_other_user_sees_nothing(self):
            self.assertEqual(self.client_of(self.second).get("/api/receipts/").json()["count"], 0)

В ``accounts`` локальному API не нужны ``DEBUG`` и флаг: достаточно входа. Имена
пользователей вымышленные; ``local`` среди них нет.
"""
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import override_settings
from rest_framework.test import APIClient

MISSING = 999999999
NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}
NOT_AUTHENTICATED = {"error": {"code": "not_authenticated", "message": "Требуется вход."}}
PERMISSION_DENIED = {"error": {"code": "permission_denied", "message": "Доступ запрещён."}}
CSRF_URL = "/api/recognition/csrf/"
ORIGIN = "http://testserver"


def accounts_mode():
    """Новый ``override_settings`` на каждый вызов: один экземпляр нельзя включить дважды."""
    return override_settings(CHECKIST_AUTH_MODE="accounts")


def local_single_mode():
    """``local_single`` с включённым локальным API, как у прежних тестов."""
    return override_settings(CHECKIST_AUTH_MODE="local_single", DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)


def make_user(username, **fields):
    """Обычный пользователь без пароля: в тестах входит через ``force_login``."""
    return get_user_model().objects.create_user(username, **fields)


def make_moderator(username, **fields):
    """Пользователь с правом ``catalog.moderate_catalog``; ``is_staff`` ему не нужен."""
    account = make_user(username, **fields)
    account.user_permissions.add(
        Permission.objects.get(content_type__app_label="catalog", codename="moderate_catalog"))
    return account


def with_csrf(client):
    """Ставит клиенту заголовки CSRF. Токен берётся после входа: вход его меняет."""
    response = client.get(CSRF_URL)
    assert response.status_code == 200, response.content
    client.credentials(HTTP_X_CSRFTOKEN=response.json()["csrf_token"], HTTP_ORIGIN=ORIGIN)
    return client


def signed_in(account, *, csrf=False):
    """Клиент с сессией пользователя. ``csrf=True`` — проверка CSRF включена, токен получен."""
    client = APIClient(enforce_csrf_checks=csrf)
    client.force_login(account)
    return with_csrf(client) if csrf else client


class TwoUsers:
    """Два обычных пользователя и модератор каталога; примесь к ``TestCase``.

    ``self.first``, ``self.second``, ``self.moderator`` создаются один раз на класс.
    ``client_of(account)`` — вошедший клиент, один на пользователя в пределах теста;
    ``client_of(account, csrf=True)`` — отдельный клиент с проверкой CSRF для POST.
    """

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.first = make_user("synthetic-user-one")
        cls.second = make_user("synthetic-user-two")
        cls.moderator = make_moderator("synthetic-moderator")

    def client_of(self, account, *, csrf=False):
        clients = self.__dict__.setdefault("_signed_in_clients", {})
        key = (account.pk, csrf)
        if key not in clients:
            clients[key] = signed_in(account, csrf=csrf)
        return clients[key]
