"""Вход, выход, смена пароля и «кто я»: контракт ``/api/auth/*`` и ``/api/me/``.

Эталоны ``fixtures/auth/*.json`` — тела ответов для клиента. В «Я» от запуска к запуску
меняются только ``user.id`` и ``csrf_token``: их форма проверяется отдельно, остальное
сравнивается с эталоном целиком.
"""
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from accounts.models import LoginFailure
from receipts.ownership import LOCAL_USERNAME, local_user

FIXTURES = Path(__file__).resolve().parent / "fixtures/auth"
CSRF = "/api/auth/csrf/"
LOGIN = "/api/auth/login/"
LOGOUT = "/api/auth/logout/"
PASSWORD_URL = "/api/auth/password/"
ME = "/api/me/"
ADMIN = "/admin/"
ADMIN_LOGIN = "/admin/login/"
ADMIN_LOGOUT = "/admin/logout/"

USERNAME = "synthetic-reader"
PASSWORD = "Synthetic-pass-41"
NEW_PASSWORD = "Quorum-blizzard-58"
FOREIGN_ADDRESS = "192.0.2.10"
T0 = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)

NOT_AUTHENTICATED = {"error": {"code": "not_authenticated", "message": "Требуется вход."}}
CSRF_FAILED = {"error": {"code": "csrf_failed", "message": "Проверка CSRF не пройдена."}}
INVALID_REQUEST = {"error": {"code": "invalid_request", "message": "Некорректный запрос."}}
NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}
METHOD_NOT_ALLOWED = {"error": {"code": "method_not_allowed", "message": "Метод не поддерживается."}}
INVALID_PARAMETER = "Некорректные параметры запроса."
REQUIRED = "Обязательное поле."
NOT_TEXT = "Ожидается непустая строка."


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


# A fresh override every time: one instance must not be entered twice.
def accounts():
    return override_settings(CHECKIST_AUTH_MODE="accounts")


def local_single():
    return override_settings(CHECKIST_AUTH_MODE="local_single")


def fast_hashing():
    # Счёт неудач требует десятков проверок пароля; настоящий PBKDF2 здесь только замедляет.
    return override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])


def user(username=USERNAME, password=PASSWORD, **fields):
    return get_user_model().objects.create_user(username, password=password, **fields)


def credentials(username=USERNAME, password=PASSWORD):
    return {"username": username, "password": password}


def sign_in(client, username=USERNAME, password=PASSWORD, **extra):
    return client.post(LOGIN, credentials(username, password), format="json", **extra)


def strict_client():
    """Клиент с настоящей проверкой CSRF и токеном гостя из ``/api/auth/csrf/``."""
    client = APIClient(enforce_csrf_checks=True)
    use_token(client, client.get(CSRF).json()["csrf_token"])
    return client


def use_token(client, token):
    client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")


class AuthMixin:
    def assert_me(self, response, name, account):
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        body, expected = response.json(), fixture(name)
        self.assertRegex(body["csrf_token"], r"^[A-Za-z0-9]{64}$")
        self.assertRegex(expected["csrf_token"], r"^[A-Za-z0-9]{64}$")
        self.assertIs(type(body["user"]["id"]), int)
        self.assertEqual(body["user"]["id"], account.pk)
        body["csrf_token"] = expected["csrf_token"]
        body["user"]["id"] = expected["user"]["id"]
        self.assertEqual(body, expected)

    def assert_error(self, response, status, body):
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response.json(), body)
        self.assertNotIn("WWW-Authenticate", response)
        self.assertEqual(response["Cache-Control"], "no-store")

    def assert_fields(self, response, fields):
        self.assert_error(response, 400, {
            "error": {"code": "invalid_parameter", "message": INVALID_PARAMETER, "fields": fields},
        })

    def assert_not_authenticated(self, response):
        self.assertEqual(response.status_code, 401, response.content)
        self.assertEqual(response.json(), NOT_AUTHENTICATED)
        self.assertEqual(response["WWW-Authenticate"], "Session")

    def assert_signed_in(self, client, account):
        response = client.get(ME)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["user"]["id"], account.pk)

    def assert_guest(self, client):
        self.assert_not_authenticated(client.get(ME))


@tag("integration")
@fast_hashing()
@accounts()
class LoginTests(AuthMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.account = user()
        cls.other = user("synthetic-other")
        cls.disabled = user("synthetic-disabled", is_active=False)

    def test_success_returns_me_and_opens_the_session(self):
        client = APIClient()
        self.assert_guest(client)
        response = sign_in(client)
        self.assert_me(response, "me.json", self.account)
        self.assertNotIn("WWW-Authenticate", response)
        self.assert_signed_in(client, self.account)
        # Сессия открывает и остальные API.
        self.assertEqual(client.get("/api/countries/").status_code, 200)

    def test_refusals_do_not_tell_why(self):
        expected = fixture("login_invalid.json")
        attempts = (
            credentials(password="Wrong-synthetic-00"),
            credentials("synthetic-missing"),
            credentials("synthetic-disabled"),
            credentials(USERNAME.upper()),
            credentials("x" * 300),
        )
        responses = []
        for body in attempts:
            with self.subTest(username=body["username"][:20]):
                client = APIClient()
                response = client.post(LOGIN, body, format="json")
                self.assert_error(response, 401, expected)
                self.assertNotIn("Retry-After", response)
                self.assert_guest(client)
                responses.append((response.status_code, response.content, sorted(response.headers.items())))
        self.assertEqual(len(set(map(repr, responses))), 1)

    def test_failed_sign_in_keeps_the_current_session(self):
        client = APIClient()
        sign_in(client)
        self.assert_error(sign_in(client, "synthetic-other", "Wrong-synthetic-00"), 401, fixture("login_invalid.json"))
        self.assert_signed_in(client, self.account)

    def test_sign_in_as_another_user_replaces_the_session(self):
        client = APIClient()
        sign_in(client)
        response = sign_in(client, "synthetic-other")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["user"], {"id": self.other.pk, "username": "synthetic-other", "is_staff": False})
        self.assert_signed_in(client, self.other)

    def test_sign_in_changes_the_csrf_token(self):
        client = strict_client()
        guest_token = client._credentials["HTTP_X_CSRFTOKEN"]
        response = sign_in(client)
        self.assert_me(response, "me.json", self.account)
        # Прежний токен после входа не действует, токен из ответа — действует.
        self.assert_error(client.post(LOGOUT, {}, format="json"), 403, CSRF_FAILED)
        self.assert_signed_in(client, self.account)
        self.assertNotEqual(response.json()["csrf_token"], guest_token)
        use_token(client, response.json()["csrf_token"])
        self.assertEqual(client.post(LOGOUT, {}, format="json").status_code, 204)

    def test_body_structure_errors(self):
        client = APIClient()
        cases = (
            ("{not json", "application/json"),
            ("[]", "application/json"),
            ('"text"', "application/json"),
            ("", "application/json"),
            (json.dumps({**credentials(), "remember": True}), "application/json"),
            ('{"username": "a", "username": "b", "password": "c"}', "application/json"),
            (json.dumps({"username": "a", "password": "x" * 5000}), "application/json"),
        )
        for content, content_type in cases:
            with self.subTest(content=content[:40]):
                self.assert_error(client.post(LOGIN, content, content_type=content_type), 400, INVALID_REQUEST)
        response = client.post(LOGIN, "username=a&password=b", content_type="application/x-www-form-urlencoded")
        self.assertEqual(response.status_code, 415, response.content)
        self.assertEqual(response.json()["error"]["code"], "unsupported_media_type")
        self.assertFalse(LoginFailure.objects.exists())

    def test_body_field_errors(self):
        client = APIClient()
        cases = (
            ({}, {"username": [REQUIRED], "password": [REQUIRED]}),
            ({"username": USERNAME}, {"password": [REQUIRED]}),
            ({"password": PASSWORD}, {"username": [REQUIRED]}),
            ({"username": "", "password": PASSWORD}, {"username": [NOT_TEXT]}),
            ({"username": USERNAME, "password": ""}, {"password": [NOT_TEXT]}),
            ({"username": 7, "password": None}, {"username": [NOT_TEXT], "password": [NOT_TEXT]}),
            ({"username": ["a"], "password": {"a": 1}}, {"username": [NOT_TEXT], "password": [NOT_TEXT]}),
            ({"username": "a\x00b", "password": "c\x00"}, {"username": [NOT_TEXT], "password": [NOT_TEXT]}),
        )
        for body, fields in cases:
            with self.subTest(body=repr(body)[:60]):
                self.assert_fields(client.post(LOGIN, body, format="json"), fields)
        self.assertFalse(LoginFailure.objects.exists())
        self.assert_guest(client)

    def test_only_post(self):
        client = APIClient()
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assert_error(getattr(client, method)(LOGIN), 405, METHOD_NOT_ALLOWED)

    def test_sixth_attempt_is_throttled_even_with_the_right_password(self):
        client = APIClient()
        with patch("accounts.throttle.now", return_value=T0):
            for attempt in range(5):
                with self.subTest(attempt=attempt):
                    self.assert_error(sign_in(client, password="Wrong-synthetic-00"), 401, fixture("login_invalid.json"))
            for password in (PASSWORD, "Wrong-synthetic-00"):
                with self.subTest(password=password):
                    response = sign_in(client, password=password)
                    self.assert_error(response, 429, fixture("login_throttled.json"))
                    self.assertEqual(response["Retry-After"], "900")
        self.assert_guest(client)
        # Отказанные попытки счётчик не увеличивают и окно не продлевают.
        self.assertEqual(
            sorted(LoginFailure.objects.values_list("failures", "window_started_at")), [(5, T0), (5, T0)],
        )

    def test_retry_after_counts_down_and_the_window_ends(self):
        client = APIClient()
        with patch("accounts.throttle.now", return_value=T0):
            for _attempt in range(5):
                sign_in(client, password="Wrong-synthetic-00")
        with patch("accounts.throttle.now", return_value=T0 + timedelta(seconds=600, milliseconds=500)):
            response = sign_in(client)
            self.assertEqual(response.status_code, 429, response.content)
            self.assertEqual(response.json()["retry_after"], 300)
            self.assertEqual(response["Retry-After"], "300")
        with patch("accounts.throttle.now", return_value=T0 + timedelta(seconds=899, milliseconds=900)):
            self.assertEqual(sign_in(client).json()["retry_after"], 1)
        with patch("accounts.throttle.now", return_value=T0 + timedelta(seconds=900)):
            self.assert_me(sign_in(client), "me.json", self.account)

    def test_throttle_is_per_login_and_address(self):
        client = APIClient()
        for _attempt in range(5):
            sign_in(client, password="Wrong-synthetic-00")
        self.assertEqual(sign_in(client).status_code, 429)
        # Регистр логина счётчик не различает: иначе перебор шёл бы под другим написанием.
        self.assertEqual(sign_in(client, USERNAME.upper(), PASSWORD).status_code, 429)
        # Другой логин с того же адреса и тот же логин с другого адреса входят.
        self.assertEqual(sign_in(client, "synthetic-other").status_code, 200)
        self.assert_me(sign_in(APIClient(), REMOTE_ADDR=FOREIGN_ADDRESS), "me.json", self.account)

    def test_unknown_and_disabled_logins_are_throttled_the_same_way(self):
        for username in ("synthetic-missing", "synthetic-disabled"):
            client = APIClient()
            for attempt in range(5):
                with self.subTest(username=username, attempt=attempt):
                    self.assert_error(sign_in(client, username), 401, fixture("login_invalid.json"))
            with self.subTest(username=username, attempt="sixth"):
                self.assertEqual(sign_in(client, username).status_code, 429)

    def test_success_resets_the_counter_of_the_pair(self):
        client = APIClient()
        for _round in range(2):
            for _attempt in range(4):
                self.assertEqual(sign_in(client, password="Wrong-synthetic-00").status_code, 401)
            self.assertEqual(sign_in(client).status_code, 200)
        self.assertFalse(LoginFailure.objects.filter(key__startswith="p:").exists())

    @override_settings(AUTH_LOGIN_IP_FAILURE_LIMIT=3)
    def test_address_limit_closes_sign_in_from_that_address_only(self):
        client = APIClient()
        for number in range(3):
            self.assertEqual(sign_in(client, f"synthetic-missing-{number}").status_code, 401)
        response = sign_in(client)
        self.assertEqual(response.status_code, 429, response.content)
        self.assertEqual(response.json()["error"], fixture("login_throttled.json")["error"])
        self.assertEqual(sign_in(APIClient(), REMOTE_ADDR=FOREIGN_ADDRESS).status_code, 200)

    @override_settings(TRUST_PROXY=True)
    def test_behind_a_trusted_proxy_the_address_is_the_forwarded_one(self):
        # Все запросы приходят с адреса прокси; клиентов различает последний элемент X-Forwarded-For.
        first = {"HTTP_X_FORWARDED_FOR": "198.51.100.1, 203.0.113.7"}
        second = {"HTTP_X_FORWARDED_FOR": "203.0.113.7, 198.51.100.1"}
        for _attempt in range(5):
            sign_in(APIClient(), password="Wrong-synthetic-00", **first)
        self.assertEqual(sign_in(APIClient(), **first).status_code, 429)
        self.assertEqual(sign_in(APIClient(), **second).status_code, 200)

    def test_forwarded_header_is_ignored_without_a_trusted_proxy(self):
        for number in range(5):
            sign_in(APIClient(), password="Wrong-synthetic-00", HTTP_X_FORWARDED_FOR=f"203.0.113.{number}")
        self.assertEqual(sign_in(APIClient(), HTTP_X_FORWARDED_FOR="203.0.113.99").status_code, 429)

    def test_local_single_has_no_sign_in(self):
        strict = APIClient(enforce_csrf_checks=True)
        with local_single():
            for path, body in ((LOGIN, credentials()), (LOGOUT, {}), (PASSWORD_URL, {})):
                for client in (APIClient(), strict):
                    with self.subTest(path=path, strict=client is strict), self.assertNumQueries(0):
                        self.assert_error(client.post(path, body, format="json"), 404, NOT_FOUND)
                with self.subTest(path=path, method="get"), self.assertNumQueries(0):
                    self.assert_error(APIClient().get(path), 404, NOT_FOUND)
        self.assertFalse(LoginFailure.objects.exists())


@tag("integration")
@fast_hashing()
@accounts()
class LogoutTests(AuthMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.account = user()

    def test_sign_out_closes_the_session(self):
        client = APIClient()
        sign_in(client)
        response = client.post(LOGOUT, {}, format="json")
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(response.content, b"")
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assert_guest(client)
        self.assert_not_authenticated(client.get("/api/countries/"))

    def test_guest_gets_204_too(self):
        client = APIClient()
        for _attempt in range(2):
            response = client.post(LOGOUT, {}, format="json")
            self.assertEqual(response.status_code, 204, response.content)
            self.assertEqual(response.content, b"")

    def test_other_sessions_of_the_user_stay_open(self):
        first, second = APIClient(), APIClient()
        sign_in(first)
        sign_in(second)
        first.post(LOGOUT, {}, format="json")
        self.assert_guest(first)
        self.assert_signed_in(second, self.account)

    def test_body_must_be_an_empty_object(self):
        client = APIClient()
        sign_in(client)
        for content in ("", "[]", '{"all": true}', "{not json"):
            with self.subTest(content=content):
                self.assert_error(client.post(LOGOUT, content, content_type="application/json"), 400, INVALID_REQUEST)
        self.assertEqual(client.post(LOGOUT, "{}", content_type="text/plain").status_code, 415)
        self.assert_signed_in(client, self.account)

    def test_only_post(self):
        client = APIClient()
        sign_in(client)
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assert_error(getattr(client, method)(LOGOUT), 405, METHOD_NOT_ALLOWED)
        self.assert_signed_in(client, self.account)


@tag("integration")
@fast_hashing()
@accounts()
class PasswordTests(AuthMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.account = user()

    def change(self, client, current=PASSWORD, new=NEW_PASSWORD, **extra):
        return client.post(PASSWORD_URL, {"current_password": current, "new_password": new}, format="json", **extra)

    def assert_password(self, password):
        self.account.refresh_from_db()
        self.assertTrue(self.account.check_password(password))

    def test_success_changes_the_password_and_keeps_this_session(self):
        client = APIClient()
        sign_in(client)
        self.assert_me(self.change(client), "me.json", self.account)
        self.assert_password(NEW_PASSWORD)
        self.assert_signed_in(client, self.account)
        self.assert_error(sign_in(APIClient()), 401, fixture("login_invalid.json"))
        self.assert_me(sign_in(APIClient(), password=NEW_PASSWORD), "me.json", self.account)

    def test_success_ends_the_other_sessions_of_the_user(self):
        current, other, forced = APIClient(), APIClient(), APIClient()
        sign_in(current)
        sign_in(other)
        forced.force_login(self.account)
        self.assertEqual(self.change(current).status_code, 200)
        self.assert_signed_in(current, self.account)
        self.assert_guest(other)
        self.assert_guest(forced)

    def test_token_of_the_answer_opens_the_next_unsafe_request(self):
        client = strict_client()
        use_token(client, sign_in(client).json()["csrf_token"])
        response = self.change(client)
        self.assert_me(response, "me.json", self.account)
        use_token(client, response.json()["csrf_token"])
        self.assertEqual(client.post(LOGOUT, {}, format="json").status_code, 204)

    def test_wrong_current_password_changes_nothing(self):
        client = APIClient()
        sign_in(client)
        response = self.change(client, current="Wrong-synthetic-00")
        self.assert_fields(response, {"current_password": ["Неверный текущий пароль."]})
        self.assertNotIn("password_issues", response.json())
        self.assert_password(PASSWORD)
        self.assert_signed_in(client, self.account)
        # Сначала проверяется текущий пароль: о слабом новом при неверном текущем не сообщается.
        self.assert_fields(
            self.change(client, current="Wrong-synthetic-00", new="1"),
            {"current_password": ["Неверный текущий пароль."]},
        )

    def test_rejected_new_password_names_the_reasons(self):
        client = APIClient()
        sign_in(client)
        self.assert_error(self.change(client, new="7302915"), 400, fixture("password_invalid.json"))
        cases = (
            ("kx9", ["too_short"], ["Пароль слишком короткий."]),
            ("password123", ["too_common"], ["Пароль слишком распространён."]),
            ("73029158467302", ["entirely_numeric"], ["Пароль не может состоять только из цифр."]),
            (USERNAME, ["too_similar"], ["Пароль слишком похож на данные учётной записи."]),
        )
        for new, issues, messages in cases:
            with self.subTest(new=new):
                self.assert_error(self.change(client, new=new), 400, {
                    "error": {"code": "invalid_parameter", "message": INVALID_PARAMETER,
                              "fields": {"new_password": messages}},
                    "password_issues": issues,
                })
        self.assert_password(PASSWORD)
        self.assert_signed_in(client, self.account)
        # Верный текущий пароль неудачей не считается.
        self.assertFalse(LoginFailure.objects.exists())

    def test_body_errors(self):
        client = APIClient()
        sign_in(client)
        for content in ("", "[]", "{not json", json.dumps({"current_password": "a", "new_password": "b", "c": 1})):
            with self.subTest(content=content[:30]):
                self.assert_error(client.post(PASSWORD_URL, content, content_type="application/json"), 400, INVALID_REQUEST)
        cases = (
            ({}, {"current_password": [REQUIRED], "new_password": [REQUIRED]}),
            ({"current_password": PASSWORD}, {"new_password": [REQUIRED]}),
            ({"current_password": "", "new_password": 5}, {"current_password": [NOT_TEXT], "new_password": [NOT_TEXT]}),
            ({"current_password": PASSWORD, "new_password": "a\x00"}, {"new_password": [NOT_TEXT]}),
        )
        for body, fields in cases:
            with self.subTest(body=repr(body)[:60]):
                self.assert_fields(client.post(PASSWORD_URL, body, format="json"), fields)
        self.assert_password(PASSWORD)

    def test_guest_gets_401_before_csrf_and_body(self):
        for client in (APIClient(), APIClient(enforce_csrf_checks=True)):
            self.assert_not_authenticated(self.change(client))
            self.assert_not_authenticated(client.post(PASSWORD_URL, "{not json", content_type="application/json"))
            self.assert_not_authenticated(client.get(PASSWORD_URL))
        self.assert_password(PASSWORD)

    def test_disabled_user_with_a_live_session_gets_401(self):
        client = APIClient()
        sign_in(client)
        get_user_model().objects.filter(pk=self.account.pk).update(is_active=False)
        self.assert_not_authenticated(self.change(client))
        self.assert_password(PASSWORD)

    def test_wrong_current_password_is_throttled_like_sign_in(self):
        client = APIClient()
        sign_in(client)
        with patch("accounts.throttle.now", return_value=T0):
            for attempt in range(5):
                with self.subTest(attempt=attempt):
                    self.assert_fields(
                        self.change(client, current="Wrong-synthetic-00"),
                        {"current_password": ["Неверный текущий пароль."]},
                    )
            response = self.change(client)
            self.assert_error(response, 429, fixture("login_throttled.json"))
            self.assertEqual(response["Retry-After"], "900")
            # Счётчик общий со входом: та же пара «логин и адрес».
            self.assert_error(sign_in(APIClient()), 429, fixture("login_throttled.json"))
        self.assert_password(PASSWORD)
        self.assert_signed_in(client, self.account)
        with patch("accounts.throttle.now", return_value=T0 + timedelta(seconds=900)):
            self.assertEqual(self.change(client).status_code, 200)
        self.assert_password(NEW_PASSWORD)

    def test_only_post(self):
        client = APIClient()
        sign_in(client)
        for method in ("get", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assert_error(getattr(client, method)(PASSWORD_URL), 405, METHOD_NOT_ALLOWED)


@tag("integration")
@fast_hashing()
@accounts()
class MeTests(AuthMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.account = user()
        cls.moderator = user("synthetic-moderator")
        cls.moderator.user_permissions.add(
            Permission.objects.get(content_type__app_label="catalog", codename="moderate_catalog"),
        )
        cls.staff = user("synthetic-staff", is_staff=True)
        cls.superuser = get_user_model().objects.create_superuser("synthetic-superuser", password=PASSWORD)

    def me(self, account):
        client = APIClient()
        client.force_login(account)
        return client.get(ME)

    def test_guest_gets_401(self):
        client = APIClient()
        with self.assertNumQueries(0):
            self.assert_not_authenticated(client.get(ME))
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assert_not_authenticated(getattr(client, method)(ME))

    def test_signed_in_user(self):
        self.assert_me(self.me(self.account), "me.json", self.account)

    def test_same_form_after_sign_in_and_on_me(self):
        client = APIClient()
        signed, read = sign_in(client).json(), client.get(ME).json()
        self.assertEqual(set(read), {"mode", "user", "permissions", "csrf_token"})
        self.assertEqual({**signed, "csrf_token": ""}, {**read, "csrf_token": ""})

    def test_permissions_and_staff_flag(self):
        cases = (
            (self.account, False, False), (self.moderator, False, True), (self.staff, True, False),
            (self.superuser, True, True),
        )
        for account, is_staff, moderate in cases:
            with self.subTest(account=account.username):
                body = self.me(account).json()
                self.assertEqual(body["mode"], "accounts")
                self.assertEqual(body["user"], {"id": account.pk, "username": account.username, "is_staff": is_staff})
                self.assertEqual(body["permissions"], {"moderate_catalog": moderate})

    def test_disabled_user_with_a_live_session_gets_401(self):
        client = APIClient()
        client.force_login(self.account)
        get_user_model().objects.filter(pk=self.account.pk).update(is_active=False)
        self.assert_not_authenticated(client.get(ME))

    def test_only_get(self):
        client = APIClient()
        client.force_login(self.account)
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assert_error(getattr(client, method)(ME), 405, METHOD_NOT_ALLOWED)

    def test_local_single_answers_without_sign_in(self):
        with local_single():
            local = local_user()
            self.assert_me(APIClient().get(ME), "me_local_single.json", local)
            # Как чтение каталога: без DEBUG, флага локального API и loopback.
            with override_settings(DEBUG=False, ALLOW_LOCAL_RECOGNITION_API=False):
                self.assert_me(APIClient().get(ME, REMOTE_ADDR=FOREIGN_ADDRESS), "me_local_single.json", local)
            # Сессия в local_single не читается: вошедший в админку остаётся local.
            self.assert_me(self.me(self.superuser), "me_local_single.json", local)
            self.assertEqual(local.username, LOCAL_USERNAME)


@tag("integration")
@fast_hashing()
@accounts()
class CsrfTests(AuthMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.account = user()

    def test_token_is_given_to_a_guest_in_both_modes(self):
        for override in (accounts, local_single):
            with self.subTest(mode=override.__name__), override():
                client = APIClient()
                with self.assertNumQueries(0):
                    response = client.get(CSRF, REMOTE_ADDR=FOREIGN_ADDRESS)
                self.assertEqual(response.status_code, 200, response.content)
                self.assertEqual(set(response.json()), {"csrf_token"})
                self.assertRegex(response.json()["csrf_token"], r"^[A-Za-z0-9]{64}$")
                self.assertEqual(response["Cache-Control"], "no-store")
                self.assertIn("csrftoken", response.cookies)
                self.assertNotIn("sessionid", response.cookies)

    def test_csrf_route_is_read_only(self):
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assert_error(getattr(APIClient(), method)(CSRF), 405, METHOD_NOT_ALLOWED)

    def test_every_post_requires_the_token(self):
        bodies = ((LOGIN, credentials()), (LOGOUT, {}), (PASSWORD_URL, {"current_password": PASSWORD, "new_password": NEW_PASSWORD}))
        for path, body in bodies:
            with self.subTest(path=path, case="no cookie and no token"):
                client = APIClient(enforce_csrf_checks=True)
                client.force_login(self.account)
                self.assert_error(client.post(path, body, format="json"), 403, CSRF_FAILED)
            with self.subTest(path=path, case="cookie without the header"):
                client = APIClient(enforce_csrf_checks=True)
                client.force_login(self.account)
                client.get(CSRF)
                self.assert_error(client.post(path, body, format="json"), 403, CSRF_FAILED)
            with self.subTest(path=path, case="token of another client"):
                client = APIClient(enforce_csrf_checks=True)
                client.force_login(self.account)
                client.get(CSRF)
                use_token(client, APIClient().get(CSRF).json()["csrf_token"])
                self.assert_error(client.post(path, body, format="json"), 403, CSRF_FAILED)
            with self.subTest(path=path, case="foreign origin"):
                client = APIClient(enforce_csrf_checks=True)
                client.force_login(self.account)
                token = client.get(CSRF).json()["csrf_token"]
                client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://evil.example")
                self.assert_error(client.post(path, body, format="json"), 403, CSRF_FAILED)
            with self.subTest(path=path, case="token in the body is not accepted"):
                client = APIClient(enforce_csrf_checks=True)
                client.force_login(self.account)
                token = client.get(CSRF).json()["csrf_token"]
                self.assert_error(
                    client.post(path, {**body, "csrfmiddlewaretoken": token}, format="json"), 403, CSRF_FAILED,
                )
        self.account.refresh_from_db()
        self.assertTrue(self.account.check_password(PASSWORD))
        self.assertFalse(LoginFailure.objects.exists())

    def test_csrf_failure_does_not_count_as_a_failed_sign_in(self):
        client = APIClient(enforce_csrf_checks=True)
        for _attempt in range(6):
            self.assert_error(sign_in(client, password="Wrong-synthetic-00"), 403, CSRF_FAILED)
        self.assertFalse(LoginFailure.objects.exists())

    def test_guest_token_opens_sign_in_and_the_whole_flow(self):
        client = strict_client()
        response = sign_in(client)
        self.assert_me(response, "me.json", self.account)
        use_token(client, response.json()["csrf_token"])
        response = client.post(
            PASSWORD_URL, {"current_password": PASSWORD, "new_password": NEW_PASSWORD}, format="json",
        )
        self.assert_me(response, "me.json", self.account)
        use_token(client, response.json()["csrf_token"])
        self.assertEqual(client.post(LOGOUT, {}, format="json").status_code, 204)
        self.assert_guest(client)
        # После выхода токен гостя берётся заново.
        use_token(client, client.get(CSRF).json()["csrf_token"])
        self.assert_me(sign_in(client, password=NEW_PASSWORD), "me.json", self.account)

    def test_token_of_me_opens_unsafe_requests(self):
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.account)
        use_token(client, client.get(ME).json()["csrf_token"])
        self.assertEqual(client.post(LOGOUT, {}, format="json").status_code, 204)

    def test_guest_sign_out_requires_the_token_too(self):
        self.assert_error(APIClient(enforce_csrf_checks=True).post(LOGOUT, {}, format="json"), 403, CSRF_FAILED)
        self.assertEqual(strict_client().post(LOGOUT, {}, format="json").status_code, 204)


@tag("integration")
@fast_hashing()
@accounts()
class SharedSessionTests(AuthMixin, TestCase):
    """Одна cookie сессии у админки и приложения: вход и выход действуют в обе стороны."""

    @classmethod
    def setUpTestData(cls):
        cls.staff = user("synthetic-staff", is_staff=True)
        cls.account = user()

    def admin_sign_in(self, client, username="synthetic-staff", password=PASSWORD):
        return client.post(ADMIN_LOGIN, {"username": username, "password": password, "next": ADMIN})

    def assert_admin_open(self, client):
        self.assertEqual(client.get(ADMIN).status_code, 200)

    def assert_admin_closed(self, client):
        response = client.get(ADMIN)
        self.assertEqual(response.status_code, 302, response.content)
        self.assertTrue(response["Location"].startswith(ADMIN_LOGIN), response["Location"])

    def test_admin_sign_in_opens_the_api(self):
        client = APIClient()
        self.assert_guest(client)
        response = self.admin_sign_in(client)
        self.assertEqual(response.status_code, 302, response.content)
        self.assertEqual(response["Location"], ADMIN)
        body = client.get(ME).json()
        self.assertEqual(body["user"], {"id": self.staff.pk, "username": "synthetic-staff", "is_staff": True})
        self.assertEqual(client.get("/api/countries/").status_code, 200)

    def test_api_sign_in_opens_the_admin(self):
        client = APIClient()
        self.assert_admin_closed(client)
        self.assertEqual(sign_in(client, "synthetic-staff").status_code, 200)
        self.assert_admin_open(client)

    def test_api_sign_in_of_a_plain_user_does_not_open_the_admin(self):
        client = APIClient()
        self.assertEqual(sign_in(client).status_code, 200)
        self.assert_admin_closed(client)
        self.assert_signed_in(client, self.account)

    def test_api_sign_out_closes_the_admin(self):
        client = APIClient()
        self.admin_sign_in(client)
        self.assert_admin_open(client)
        self.assertEqual(client.post(LOGOUT, {}, format="json").status_code, 204)
        self.assert_admin_closed(client)
        self.assert_guest(client)

    def test_admin_sign_out_closes_the_api(self):
        client = APIClient()
        sign_in(client, "synthetic-staff")
        self.assert_signed_in(client, self.staff)
        self.assertEqual(client.post(ADMIN_LOGOUT).status_code, 200)
        self.assert_guest(client)
        self.assert_admin_closed(client)

    def test_admin_sign_in_replaces_the_api_user(self):
        client = APIClient()
        sign_in(client)
        self.assert_signed_in(client, self.account)
        self.admin_sign_in(client)
        self.assert_signed_in(client, self.staff)

    def test_password_change_in_the_api_ends_the_admin_session_elsewhere(self):
        api, admin_client = APIClient(), APIClient()
        sign_in(api, "synthetic-staff")
        self.admin_sign_in(admin_client)
        self.assert_admin_open(admin_client)
        response = api.post(
            PASSWORD_URL, {"current_password": PASSWORD, "new_password": NEW_PASSWORD}, format="json",
        )
        self.assertEqual(response.status_code, 200, response.content)
        self.assert_admin_closed(admin_client)
        self.assert_admin_open(api)

    def test_local_single_does_not_read_the_admin_session(self):
        client = APIClient()
        self.admin_sign_in(client)
        with local_single():
            self.assertEqual(client.get(ME).json()["user"]["username"], LOCAL_USERNAME)
        self.assert_admin_open(client)
