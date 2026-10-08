"""Вход в админку считает неудачи тем же backend, что и ``/api/auth/login/``."""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase, override_settings, tag
from rest_framework.test import APIClient

from accounts.models import LoginFailure

ADMIN = "/admin/"
ADMIN_LOGIN = "/admin/login/"
LOGIN = "/api/auth/login/"
USERNAME = "synthetic-staff"
PASSWORD = "Synthetic-pass-41"
WRONG = "Wrong-synthetic-00"
FOREIGN_ADDRESS = "192.0.2.10"
T0 = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)


def at(seconds=0):
    return patch("accounts.throttle.now", return_value=T0 + timedelta(seconds=seconds))


@tag("integration")
@override_settings(
    CHECKIST_AUTH_MODE="accounts", PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"],
)
class AdminLoginThrottleTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.staff = get_user_model().objects.create_user(USERNAME, password=PASSWORD, is_staff=True)

    def admin_sign_in(self, client, password=PASSWORD, username=USERNAME, **extra):
        return client.post(ADMIN_LOGIN, {"username": username, "password": password, "next": ADMIN}, **extra)

    def api_sign_in(self, client, password=PASSWORD, username=USERNAME, **extra):
        return client.post(LOGIN, {"username": username, "password": password}, format="json", **extra)

    def assert_refused(self, response, client):
        """Обычная ошибка формы входа: страница входа, сессии нет."""
        self.assertEqual(response.status_code, 200, response.content[:200])
        self.assertTrue(response.context["form"].non_field_errors())
        self.assertNotIn("Retry-After", response)
        self.assertEqual(client.get(ADMIN).status_code, 302)

    def assert_signed_in(self, response, client):
        self.assertEqual(response.status_code, 302, response.content[:200])
        self.assertEqual(response["Location"], ADMIN)
        self.assertEqual(client.get(ADMIN).status_code, 200)

    def test_sign_in_works(self):
        client = APIClient()
        self.assert_signed_in(self.admin_sign_in(client), client)
        self.assertFalse(LoginFailure.objects.exists())

    def test_sixth_attempt_is_refused_even_with_the_right_password(self):
        client = APIClient()
        with at(0):
            failures = [self.admin_sign_in(client, WRONG) for _attempt in range(5)]
            for response in failures:
                self.assert_refused(response, client)
            refused = self.admin_sign_in(client)
            self.assert_refused(refused, client)
            # Отказ по блокировке неотличим от неверного пароля.
            self.assertEqual(
                refused.context["form"].non_field_errors(), failures[0].context["form"].non_field_errors(),
            )
            self.assertEqual(set(LoginFailure.objects.values_list("failures", flat=True)), {5})
        with at(900):
            self.assert_signed_in(self.admin_sign_in(client), client)

    def test_unknown_login_is_counted_and_refused_the_same_way(self):
        client = APIClient()
        for _attempt in range(6):
            self.assert_refused(self.admin_sign_in(client, username="synthetic-missing"), client)
        self.assertEqual(set(LoginFailure.objects.values_list("failures", flat=True)), {5})

    def test_other_address_signs_in(self):
        blocked, other = APIClient(), APIClient()
        for _attempt in range(5):
            self.admin_sign_in(blocked, WRONG)
        self.assert_refused(self.admin_sign_in(blocked), blocked)
        response = self.admin_sign_in(other, REMOTE_ADDR=FOREIGN_ADDRESS)
        self.assertEqual(response.status_code, 302, response.content[:200])
        self.assertEqual(response["Location"], ADMIN)

    def test_failures_in_the_admin_close_the_api_sign_in(self):
        client = APIClient()
        with at(0):
            for _attempt in range(5):
                self.admin_sign_in(client, WRONG)
            response = self.api_sign_in(client)
            self.assertEqual(response.status_code, 429, response.content)
            self.assertEqual(response.json()["error"]["code"], "login_throttled")
            self.assertEqual(response.json()["retry_after"], 900)

    def test_failures_in_the_api_close_the_admin_sign_in(self):
        client = APIClient()
        for _attempt in range(5):
            self.assertEqual(self.api_sign_in(client, WRONG).status_code, 401)
        self.assert_refused(self.admin_sign_in(client), client)

    def test_failures_of_both_forms_add_up(self):
        client = APIClient()
        for _attempt in range(3):
            self.admin_sign_in(client, WRONG)
        for _attempt in range(2):
            self.assertEqual(self.api_sign_in(client, WRONG).status_code, 401)
        self.assertEqual(self.api_sign_in(client).status_code, 429)
        self.assert_refused(self.admin_sign_in(client), client)

    def test_admin_sign_in_is_throttled_in_local_single_too(self):
        client = APIClient()
        with override_settings(CHECKIST_AUTH_MODE="local_single"):
            for _attempt in range(5):
                self.admin_sign_in(client, WRONG)
            self.assert_refused(self.admin_sign_in(client), client)

    def test_counters_are_read_only_in_the_admin(self):
        superuser = get_user_model().objects.create_superuser("synthetic-superuser", password=PASSWORD)
        self.admin_sign_in(APIClient(), WRONG, REMOTE_ADDR=FOREIGN_ADDRESS)
        row = LoginFailure.objects.get(key=f"a:{FOREIGN_ADDRESS}")
        client = APIClient()
        client.force_login(superuser)
        base = "/admin/accounts/loginfailure/"
        self.assertEqual(client.get(base).status_code, 200)
        self.assertEqual(client.get(f"{base}{row.pk}/change/").status_code, 200)
        self.assertEqual(client.get(f"{base}add/").status_code, 403)
        self.assertEqual(client.post(f"{base}{row.pk}/delete/", {"post": "yes"}).status_code, 403)
        self.assertTrue(LoginFailure.objects.filter(pk=row.pk).exists())
        request = RequestFactory().get(base)
        request.user = superuser
        model_admin = admin.site._registry[LoginFailure]
        self.assertFalse(model_admin.has_add_permission(request))
        self.assertFalse(model_admin.has_change_permission(request, row))
        self.assertFalse(model_admin.has_delete_permission(request, row))
