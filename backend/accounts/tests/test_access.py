"""Доступ по режимам: кто получает 401, 403 и ответ вью. Строки про 404 чужого — в тестах владельца."""
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import AnonymousUser, Group, Permission
from django.db.models import Q
from django.test import RequestFactory, TestCase, override_settings, tag
from rest_framework.request import Request
from rest_framework.test import APIClient

from accounts import access
from api.views.recognition_base import request_owner
from receipts.ownership import LOCAL_USERNAME, local_user
from recognition import auth as recognition_auth

MISSING = 999999999
NOT_AUTHENTICATED = {"error": {"code": "not_authenticated", "message": "Требуется вход."}}
PERMISSION_DENIED = {"error": {"code": "permission_denied", "message": "Доступ запрещён."}}
CSRF_FAILED = {"error": {"code": "csrf_failed", "message": "Проверка CSRF не пройдена."}}
INVALID_REQUEST = {"error": {"code": "invalid_request", "message": "Некорректный запрос."}}
NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}
FOREIGN_ADDRESS = "192.0.2.10"

PHOTOS = "/api/recognition/photos/"
# Чтение каталога и цен (ReadOnlyAPIView): списки на пустой базе отвечают 200.
READ_LISTS = (
    "/api/countries/", "/api/stores/", "/api/brands/", "/api/categories/", "/api/generic-products/",
    "/api/products/",
)
READ_OTHER = (
    f"/api/categories/{MISSING}/", f"/api/generic-products/{MISSING}/", f"/api/products/{MISSING}/",
    f"/api/products/{MISSING}/prices/", f"/api/products/{MISSING}/prices/summary/",
    f"/api/products/{MISSING}/prices/series/", f"/api/products/{MISSING}/alternatives/",
    f"/api/generic-products/{MISSING}/comparison/",
)
READ = READ_LISTS + READ_OTHER
# Локальные API (LocalAPIView).
LOCAL_LISTS = (
    "/api/receipts/", "/api/recognition/csrf/", PHOTOS, "/api/recognition/jobs/",
    "/api/recognition/receipt-images/", "/api/product-merges/", "/api/product-classifications/",
    "/api/product-classifications/status/", "/api/product-classifications/runs/",
)
LOCAL_OTHER = (
    f"/api/receipts/{MISSING}/", f"/api/receipts/{MISSING}/lines/", f"/api/receipts/{MISSING}/discounts/",
    f"/api/receipts/{MISSING}/taxes/", f"/api/recognition/photos/{MISSING}/", f"/api/recognition/jobs/{MISSING}/",
    f"/api/recognition/receipt-images/{MISSING}/", "/api/stats/spending/", "/api/stats/receipts/series/",
    "/api/stats/receipts/compare/", f"/api/product-merges/{MISSING}/", f"/api/product-merges/{MISSING}/lines/",
    f"/api/product-classifications/{MISSING}/", f"/api/product-classifications/runs/{MISSING}/",
)
# Неизвестные пути под префиксами локальных API закрыты так же, как сами API.
LOCAL_UNKNOWN = (
    "/api/receipts/unknown/", "/api/recognition/unknown/", "/api/stats/unknown/", "/api/product-merges/unknown/",
    "/api/product-classifications/unknown/",
)
LOCAL_GET = LOCAL_LISTS + LOCAL_OTHER + LOCAL_UNKNOWN
OWNER_POSTS = (
    PHOTOS, f"/api/recognition/jobs/{MISSING}/cancel/", f"/api/recognition/jobs/{MISSING}/retry/",
    f"/api/recognition/receipt-images/{MISSING}/confirm/",
)
MODERATOR_POSTS = (
    "/api/product-merges/detect/", f"/api/product-merges/{MISSING}/confirm/",
    f"/api/product-merges/{MISSING}/cancel/", f"/api/product-merges/{MISSING}/exclude/",
    "/api/product-classifications/confirm/", f"/api/product-classifications/{MISSING}/confirm/",
    f"/api/product-classifications/{MISSING}/reject/", "/api/product-classifications/runs/",
)
ROUTES = (
    *(("get", path) for path in READ + LOCAL_GET),
    *(("post", path) for path in OWNER_POSTS + MODERATOR_POSTS),
)


# A fresh override every time: one instance must not be entered twice.
def accounts():
    return override_settings(CHECKIST_AUTH_MODE="accounts")


def local_single():
    return override_settings(CHECKIST_AUTH_MODE="local_single")


def local_api():
    return override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)


def send(client, method, path, body=None, **extra):
    if method == "get":
        return client.get(path, **extra)
    if path == PHOTOS:
        return client.post(path, {"other": "1"}, format="multipart", **extra)
    return client.post(path, {} if body is None else body, format="json", **extra)


def user(username, **fields):
    return get_user_model().objects.create_user(username, **fields)


def moderate_catalog():
    return Permission.objects.get(content_type__app_label="catalog", codename="moderate_catalog")


def signed_in(account, *, enforce_csrf_checks=False):
    client = APIClient(enforce_csrf_checks=enforce_csrf_checks)
    client.force_login(account)
    return client


def with_csrf(client):
    """Токен берётся после входа: вход его меняет."""
    token = client.get("/api/recognition/csrf/").json()["csrf_token"]
    client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")
    return client


class AccessMixin:
    def assert_not_authenticated(self, response):
        self.assertEqual(response.status_code, 401, response.content)
        self.assertEqual(response.json(), NOT_AUTHENTICATED)
        self.assertEqual(response["WWW-Authenticate"], "Session")

    def assert_error(self, response, status, body):
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response.json(), body)
        self.assertNotIn("WWW-Authenticate", response)

    def baseline(self, method, path, body=None):
        """Ответ того же запроса без входа в ``local_single`` с включённым локальным API."""
        with local_single(), local_api():
            response = send(APIClient(), method, path, body)
        self.assertNotIn(response.status_code, (401, 403), (method, path, response.content))
        return response


@tag("integration")
@local_api()
@accounts()
class AccessMatrixTests(AccessMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.reader = user("synthetic-reader")
        cls.other = user("synthetic-other")
        cls.moderator = user("synthetic-moderator")
        cls.moderator.user_permissions.add(moderate_catalog())

    def test_anonymous_gets_401_with_session_challenge_everywhere(self):
        client = APIClient()
        for method, path in ROUTES:
            with self.subTest(method=method, path=path), self.assertNumQueries(0):
                self.assert_not_authenticated(send(client, method, path))

    def test_anonymous_gets_401_before_method_csrf_and_body_checks(self):
        strict = APIClient(enforce_csrf_checks=True)
        for method, path in ROUTES:
            other = "post" if method == "get" else "get"
            with self.subTest(method=other, path=path):
                self.assert_not_authenticated(send(APIClient(), other, path))
        for path in OWNER_POSTS + MODERATOR_POSTS:
            with self.subTest(path=path, check="csrf"):
                self.assert_not_authenticated(send(strict, "post", path))
            with self.subTest(path=path, check="body"):
                self.assert_not_authenticated(
                    APIClient().post(path, "{not json", content_type="application/json"),
                )
        for path in (READ[0], LOCAL_GET[0]):
            for method in ("head", "options", "put", "patch", "delete"):
                with self.subTest(path=path, method=method):
                    response = getattr(APIClient(), method)(path)
                    self.assertEqual(response.status_code, 401, response.content)
                    self.assertEqual(response["WWW-Authenticate"], "Session")

    def test_anonymous_challenge_ignores_other_credentials(self):
        for headers in ({"HTTP_AUTHORIZATION": "Bearer invalid-token"}, {"HTTP_AUTHORIZATION": "Basic bG9jYWw6eA=="}):
            for path in (READ[0], LOCAL_GET[0]):
                with self.subTest(path=path, headers=headers):
                    self.assert_not_authenticated(APIClient().get(path, **headers))

    def test_health_and_unknown_api_path_stay_open(self):
        client = APIClient()
        ok = {"status": "ok"}
        with patch("health.probes.probe_database", return_value=ok), \
                patch("health.probes.probe_redis", return_value=ok), \
                patch("health.probes.probe_celery", return_value=ok):
            response = client.get("/api/health/")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["status"], "ok")
        for method in ("get", "post", "put", "patch", "delete"):
            with self.subTest(method=method):
                self.assert_error(getattr(client, method)("/api/unknown/"), 404, NOT_FOUND)

    def test_signed_in_user_reads_the_lists(self):
        for account in (self.reader, self.other, self.moderator):
            client = signed_in(account)
            for path in READ_LISTS + LOCAL_LISTS:
                with self.subTest(account=account.username, path=path):
                    response = client.get(path)
                    self.assertEqual(response.status_code, 200, response.content)
                    self.assertNotIn("WWW-Authenticate", response)

    def test_signed_in_user_passes_access_like_local_single(self):
        routes = (*(("get", path) for path in READ + LOCAL_GET), *(("post", path) for path in OWNER_POSTS))
        for account in (self.reader, self.moderator):
            client = signed_in(account)
            for method, path in routes:
                with self.subTest(account=account.username, method=method, path=path):
                    expected = self.baseline(method, path)
                    response = send(client, method, path)
                    self.assertEqual(response.status_code, expected.status_code, response.content)

    def test_unsafe_method_requires_csrf_after_sign_in(self):
        strict = signed_in(self.moderator, enforce_csrf_checks=True)
        for path in OWNER_POSTS + MODERATOR_POSTS:
            with self.subTest(path=path, client="no token"):
                self.assert_error(send(strict, "post", path), 403, CSRF_FAILED)
        foreign = signed_in(self.moderator, enforce_csrf_checks=True)
        token = foreign.get("/api/recognition/csrf/").json()["csrf_token"]
        foreign.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://evil.example")
        for path in OWNER_POSTS + MODERATOR_POSTS:
            with self.subTest(path=path, client="foreign origin"):
                self.assert_error(send(foreign, "post", path), 403, CSRF_FAILED)
        # Чтение токена не требует.
        self.assertEqual(strict.get("/api/receipts/").status_code, 200)

    def test_csrf_token_of_the_session_opens_unsafe_methods(self):
        client = with_csrf(signed_in(self.reader, enforce_csrf_checks=True))
        for path in OWNER_POSTS:
            with self.subTest(path=path):
                expected = self.baseline("post", path)
                self.assertEqual(send(client, "post", path).status_code, expected.status_code)

    def test_csrf_endpoint_requires_sign_in_and_keeps_its_form(self):
        self.assert_not_authenticated(APIClient().get("/api/recognition/csrf/"))
        body = signed_in(self.reader).get("/api/recognition/csrf/").json()
        self.assertEqual(set(body), {"csrf_token", "limits", "executor"})

    def test_local_single_keeps_the_local_rule(self):
        client = APIClient()
        with local_single():
            for path in READ_LISTS + LOCAL_LISTS:
                with self.subTest(path=path):
                    self.assertEqual(client.get(path).status_code, 200)
            cases = (
                ({"ALLOW_LOCAL_RECOGNITION_API": False}, {}),
                ({"DEBUG": False}, {}),
                ({}, {"REMOTE_ADDR": FOREIGN_ADDRESS}),
                ({}, {"REMOTE_ADDR": "not-an-address"}),
            )
            for overrides, extra in cases:
                for method, path in ROUTES:
                    if path in READ:
                        continue
                    with self.subTest(overrides=overrides, extra=extra, path=path), \
                            override_settings(**overrides), self.assertNumQueries(0):
                        self.assert_error(send(client, method, path, **extra), 403, PERMISSION_DENIED)
                for path in READ_LISTS:
                    with self.subTest(overrides=overrides, extra=extra, path=path), override_settings(**overrides):
                        self.assertEqual(client.get(path, **extra).status_code, 200)

    def test_local_single_ignores_the_session(self):
        # Вошедший в админку ничего не меняет: запрос принадлежит local, сессия не читается.
        client = signed_in(self.reader)
        with local_single():
            for path in (READ[0], "/api/receipts/"):
                with self.subTest(path=path):
                    anonymous = self.baseline("get", path)
                    response = client.get(path)
                    self.assertEqual(response.status_code, 200, response.content)
                    self.assertEqual(response.json(), anonymous.json())
            with self.assertNumQueries(0), override_settings(DEBUG=False):
                self.assert_error(client.get("/api/receipts/"), 403, PERMISSION_DENIED)

    def test_local_single_post_requires_csrf_even_for_anonymous(self):
        strict = APIClient(enforce_csrf_checks=True)
        with local_single():
            for path in OWNER_POSTS + MODERATOR_POSTS:
                with self.subTest(path=path), self.assertNumQueries(0):
                    self.assert_error(send(strict, "post", path), 403, CSRF_FAILED)


@tag("integration")
@override_settings(DEBUG=False, ALLOW_LOCAL_RECOGNITION_API=False)
@accounts()
class AccessMatrixDebugOffTests(AccessMixin, TestCase):
    """Сервер: без DEBUG и флага локального API, запрос не с loopback."""

    @classmethod
    def setUpTestData(cls):
        cls.reader = user("synthetic-reader")
        cls.moderator = user("synthetic-moderator")
        cls.moderator.user_permissions.add(moderate_catalog())

    def test_anonymous_gets_401_everywhere(self):
        client = APIClient()
        for method, path in ROUTES:
            for extra in ({}, {"REMOTE_ADDR": FOREIGN_ADDRESS}):
                with self.subTest(method=method, path=path, extra=extra), self.assertNumQueries(0):
                    self.assert_not_authenticated(send(client, method, path, **extra))

    def test_signed_in_user_does_not_need_debug_flag_or_loopback(self):
        routes = (*(("get", path) for path in READ + LOCAL_GET), *(("post", path) for path in OWNER_POSTS))
        client = signed_in(self.reader)
        for method, path in routes:
            with self.subTest(method=method, path=path):
                expected = self.baseline(method, path)
                response = send(client, method, path, REMOTE_ADDR=FOREIGN_ADDRESS)
                self.assertEqual(response.status_code, expected.status_code, response.content)
        for path in READ_LISTS + LOCAL_LISTS:
            with self.subTest(path=path):
                self.assertEqual(client.get(path, REMOTE_ADDR=FOREIGN_ADDRESS).status_code, 200)

    def test_moderator_right_does_not_need_debug_flag_or_loopback(self):
        reader, moderator = signed_in(self.reader), signed_in(self.moderator)
        for path in MODERATOR_POSTS:
            with self.subTest(path=path):
                self.assert_error(
                    send(reader, "post", path, {"unexpected": 1}, REMOTE_ADDR=FOREIGN_ADDRESS), 403, PERMISSION_DENIED,
                )
                self.assert_error(
                    send(moderator, "post", path, {"unexpected": 1}, REMOTE_ADDR=FOREIGN_ADDRESS), 400, INVALID_REQUEST,
                )

    def test_health_stays_open(self):
        ok = {"status": "ok"}
        with patch("health.probes.probe_database", return_value=ok), \
                patch("health.probes.probe_redis", return_value=ok), \
                patch("health.probes.probe_celery", return_value=ok):
            response = APIClient().get("/api/health/", REMOTE_ADDR=FOREIGN_ADDRESS)
        self.assertEqual(response.status_code, 200, response.content)

    def test_local_single_at_run_time_opens_only_the_catalog(self):
        # Настройки такое сочетание не загрузят; правило доступа от этого не зависит.
        client = APIClient()
        with local_single():
            for path in READ_LISTS:
                with self.subTest(path=path):
                    self.assertEqual(client.get(path).status_code, 200)
            for method, path in ROUTES:
                if path in READ:
                    continue
                with self.subTest(method=method, path=path), self.assertNumQueries(0):
                    self.assert_error(send(client, method, path), 403, PERMISSION_DENIED)


@tag("integration")
@local_api()
@accounts()
class ModeratorPermissionTests(AccessMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        permission = moderate_catalog()
        cls.reader = user("synthetic-reader")
        cls.staff = user("synthetic-staff", is_staff=True)
        cls.moderator = user("synthetic-moderator")
        cls.moderator.user_permissions.add(permission)
        cls.group_moderator = user("synthetic-group-moderator")
        group = Group.objects.create(name="synthetic-moderators")
        group.permissions.add(permission)
        cls.group_moderator.groups.add(group)
        cls.superuser = get_user_model().objects.create_superuser("synthetic-superuser")

    def moderators(self):
        return self.moderator, self.group_moderator, self.superuser

    def test_permission_belongs_to_the_product_model(self):
        permission = moderate_catalog()
        self.assertEqual(permission.content_type.model, "product")
        self.assertEqual(Permission.objects.filter(codename="moderate_catalog").count(), 1)
        self.assertEqual(access.MODERATE_CATALOG, "catalog.moderate_catalog")

    def test_mutations_without_the_permission_are_403(self):
        for account in (self.reader, self.staff):
            client = with_csrf(signed_in(account, enforce_csrf_checks=True))
            for path in MODERATOR_POSTS:
                for body in ({}, {"unexpected": 1}):
                    with self.subTest(account=account.username, path=path, body=body):
                        self.assert_error(send(client, "post", path, body), 403, PERMISSION_DENIED)

    def test_permission_is_checked_after_csrf_and_before_the_body(self):
        strict = signed_in(self.reader, enforce_csrf_checks=True)
        for path in MODERATOR_POSTS:
            with self.subTest(path=path, check="csrf first"):
                self.assert_error(send(strict, "post", path), 403, CSRF_FAILED)
        client = signed_in(self.reader)
        for path in MODERATOR_POSTS:
            with self.subTest(path=path, check="before body"):
                self.assert_error(
                    client.post(path, "{not json", content_type="application/json"), 403, PERMISSION_DENIED,
                )
                self.assert_error(client.post(path, "x", content_type="text/plain"), 403, PERMISSION_DENIED)

    def test_mutations_with_the_permission_reach_the_view(self):
        for account in self.moderators():
            client = with_csrf(signed_in(account, enforce_csrf_checks=True))
            for path in MODERATOR_POSTS:
                with self.subTest(account=account.username, path=path, body="unexpected key"):
                    self.assert_error(send(client, "post", path, {"unexpected": 1}), 400, INVALID_REQUEST)
                with self.subTest(account=account.username, path=path, body="empty object"):
                    expected = self.baseline("post", path)
                    response = send(client, "post", path)
                    self.assertEqual(response.status_code, expected.status_code, response.content)

    def test_reading_does_not_need_the_permission(self):
        paths = (
            "/api/product-merges/", "/api/product-classifications/", "/api/product-classifications/status/",
            "/api/product-classifications/runs/",
        )
        missing = (
            f"/api/product-merges/{MISSING}/", f"/api/product-merges/{MISSING}/lines/",
            f"/api/product-classifications/{MISSING}/", f"/api/product-classifications/runs/{MISSING}/",
        )
        for account in (self.reader, self.staff, self.moderator):
            client = signed_in(account)
            for path in paths:
                with self.subTest(account=account.username, path=path):
                    self.assertEqual(client.get(path).status_code, 200)
            for path in missing:
                with self.subTest(account=account.username, path=path):
                    self.assert_error(client.get(path), 404, NOT_FOUND)

    def test_runs_route_separates_reading_from_queueing(self):
        client = signed_in(self.reader)
        path = "/api/product-classifications/runs/"
        self.assertEqual(client.get(path).status_code, 200)
        self.assertEqual(client.head(path).status_code, 200)
        self.assert_error(send(client, "post", path), 403, PERMISSION_DENIED)

    def test_local_single_always_has_the_permission(self):
        client = APIClient()
        with local_single():
            for path in MODERATOR_POSTS:
                with self.subTest(path=path):
                    self.assert_error(send(client, "post", path, {"unexpected": 1}), 400, INVALID_REQUEST)
            with override_settings(DEBUG=False):
                for path in MODERATOR_POSTS:
                    with self.subTest(path=path, debug=False), self.assertNumQueries(0):
                        self.assert_error(send(client, "post", path), 403, PERMISSION_DENIED)

    def test_is_moderator_by_mode_and_permission(self):
        def request(account):
            value = RequestFactory().get("/api/product-merges/")
            value.user = account
            return value

        expected = (
            (self.reader, False), (self.staff, False), (AnonymousUser(), False),
            (self.moderator, True), (self.group_moderator, True), (self.superuser, True),
        )
        for account, allowed in expected:
            with self.subTest(account=str(account)):
                self.assertIs(access.is_moderator(request(account)), allowed)
                with local_single(), self.assertNumQueries(0):
                    self.assertIs(access.is_moderator(request(account)), True)


@tag("integration")
@local_api()
@accounts()
class InactiveUserTests(AccessMixin, TestCase):
    def setUp(self):
        self.account = get_user_model().objects.create_superuser("synthetic-disabled")
        self.client = signed_in(self.account)

    def disable(self):
        get_user_model().objects.filter(pk=self.account.pk).update(is_active=False)

    def test_live_session_of_a_disabled_user_is_401(self):
        for path in (READ[0], "/api/receipts/"):
            self.assertEqual(self.client.get(path).status_code, 200)
        self.disable()
        for method, path in ROUTES:
            with self.subTest(method=method, path=path):
                self.assert_not_authenticated(send(self.client, method, path))

    def test_enabling_the_user_restores_the_session(self):
        self.disable()
        self.assert_not_authenticated(self.client.get("/api/receipts/"))
        get_user_model().objects.filter(pk=self.account.pk).update(is_active=True)
        self.assertEqual(self.client.get("/api/receipts/").status_code, 200)

    def test_authentication_does_not_trust_a_backend_that_returns_a_disabled_user(self):
        authentication = access.SessionUserAuthentication()
        self.account.is_active = False
        for candidate, expected in (
            (self.account, None), (AnonymousUser(), None), (None, None),
        ):
            with self.subTest(candidate=str(candidate)):
                request = SimpleNamespace(_request=SimpleNamespace(user=candidate))
                self.assertIs(authentication.authenticate(request), expected)
        self.account.is_active = True
        request = SimpleNamespace(_request=SimpleNamespace(user=self.account))
        self.assertEqual(authentication.authenticate(request), (self.account, None))
        with local_single():
            self.assertIsNone(authentication.authenticate(request))
        self.assertEqual(authentication.authenticate_header(request), "Session")

    def test_disabled_user_is_not_a_moderator(self):
        self.account.is_active = False
        request = RequestFactory().get("/api/product-merges/")
        request.user = self.account
        self.assertIs(access.is_moderator(request), False)


@tag("integration")
class RequestIdentityTests(TestCase):
    """``request_user`` и ``owner_q``: один ответ для запроса DRF и запроса Django."""

    @classmethod
    def setUpTestData(cls):
        cls.account = user("synthetic-reader")

    def requests(self, account):
        plain = RequestFactory().get("/api/receipts/")
        plain.user = account
        wrapped = RequestFactory().get("/api/receipts/")
        wrapped.user = account
        return plain, Request(wrapped, authenticators=[access.SessionUserAuthentication()])

    def test_local_single_request_belongs_to_local(self):
        for request in self.requests(self.account):
            with self.subTest(request=type(request).__name__):
                owner = access.request_user(request)
                self.assertEqual(owner.username, LOCAL_USERNAME)
                self.assertEqual(owner.pk, local_user().pk)
                self.assertEqual(request_owner(request).pk, owner.pk)
                with self.assertNumQueries(0):
                    self.assertIs(access.request_user(request), owner)
                    self.assertIs(request_owner(request), owner)

    def test_local_single_owner_filter_needs_no_query_for_the_user(self):
        for request in self.requests(self.account):
            with self.subTest(request=type(request).__name__), self.assertNumQueries(0):
                self.assertEqual(access.owner_q(request), Q(owner__username=LOCAL_USERNAME))
                self.assertEqual(access.owner_q(request, "receipt__"), Q(receipt__owner__username=LOCAL_USERNAME))
                self.assertEqual(access.owner_q(request, "photo__"), Q(photo__owner__username=LOCAL_USERNAME))

    @accounts()
    def test_accounts_request_belongs_to_the_signed_in_user(self):
        for request in self.requests(self.account):
            with self.subTest(request=type(request).__name__), self.assertNumQueries(0):
                self.assertEqual(access.request_user(request), self.account)
                self.assertEqual(request_owner(request), self.account)
                self.assertEqual(access.owner_q(request), Q(owner_id=self.account.pk))
                self.assertEqual(access.owner_q(request, "receipts__"), Q(receipts__owner_id=self.account.pk))

    @accounts()
    def test_accounts_anonymous_filter_matches_nothing(self):
        for request in self.requests(AnonymousUser()):
            with self.subTest(request=type(request).__name__):
                self.assertEqual(access.owner_q(request), Q(owner_id=None))
                self.assertFalse(access.request_user(request).is_authenticated)

    def test_former_permission_name_is_the_new_class(self):
        self.assertIs(recognition_auth.LocalRecognitionPermission, access.LocalOrSignedIn)
        self.assertTrue(issubclass(access.Moderator, access.LocalOrSignedIn))
        with self.assertRaises(AttributeError):
            recognition_auth.UnknownPermission
