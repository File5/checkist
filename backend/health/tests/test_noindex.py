from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.http import HttpResponse
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings, tag
from django.urls import path

from config.proxy import client_address

NOINDEX = "noindex, nofollow"
ROBOTS = b"User-agent: *\nDisallow: /\n"
TRUSTED = {
    "SECURE_PROXY_SSL_HEADER": ("HTTP_X_FORWARDED_PROTO", "https"), "SECURE_SSL_REDIRECT": True,
    "SECURE_HSTS_SECONDS": 3600,
}
UNTRUSTED = {"SECURE_PROXY_SSL_HEADER": None, "SECURE_SSL_REDIRECT": False, "SECURE_HSTS_SECONDS": 3600}


def boom(request):
    raise RuntimeError("test-only failure")


def plain(request):
    return HttpResponse("ok", headers={"X-Robots-Tag": "all"})


# URLconf of the two tests that need a view of their own.
urlpatterns = [path("boom/", boom), path("plain/", plain)]


class NoIndexHeaderTests(SimpleTestCase):
    def assert_noindex(self, response, status):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response["X-Robots-Tag"], NOINDEX)

    def test_middleware_is_the_first_line_and_the_only_change(self):
        self.assertEqual(settings.MIDDLEWARE, [
            "config.robots.NoIndexMiddleware",
            "django.middleware.security.SecurityMiddleware",
            "django.contrib.sessions.middleware.SessionMiddleware",
            "config.requests.ApiCommonMiddleware",
            "django.middleware.csrf.CsrfViewMiddleware",
            "django.contrib.auth.middleware.AuthenticationMiddleware",
            "django.contrib.messages.middleware.MessageMiddleware",
            "django.middleware.clickjacking.XFrameOptionsMiddleware",
        ])

    def test_health(self):
        for name in ("database", "redis", "celery"):
            probe = patch(f"health.probes.probe_{name}", return_value={"status": "ok"})
            probe.start()
            self.addCleanup(probe.stop)
        response = self.client.get("/api/health/")
        self.assert_noindex(response, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_admin_login_page(self):
        self.assert_noindex(self.client.get("/admin/login/"), 200)

    def test_admin_redirect(self):
        response = self.client.get("/admin/")
        self.assert_noindex(response, 302)
        self.assertEqual(response["Location"], "/admin/login/?next=/admin/")

    def test_not_found(self):
        for target in ("/no-such-page/", "/api/no-such-endpoint/", "/media/no-such-file.jpg", "/static/no-such.css"):
            with self.subTest(target=target):
                self.assert_noindex(self.client.get(target), 404)

    def test_request_rejected_by_the_api_middleware(self):
        response = self.client.get("/api/health/?value=%zz")
        self.assert_noindex(response, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_request")

    def test_disallowed_host(self):
        with self.assertLogs("django.security.DisallowedHost", "ERROR"):
            self.assert_noindex(self.client.get("/admin/login/", HTTP_HOST="not-allowed.invalid"), 400)

    def test_disallowed_host_of_an_api_request(self):
        response = self.client.get("/api/health/", HTTP_HOST="not-allowed.invalid")
        self.assert_noindex(response, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_request")

    @override_settings(ROOT_URLCONF=__name__)
    def test_server_error(self):
        client = Client(raise_request_exception=False)
        with self.assertLogs("django.request", "ERROR"):
            self.assert_noindex(client.get("/boom/"), 500)

    @override_settings(ROOT_URLCONF=__name__)
    def test_view_cannot_weaken_the_header(self):
        self.assert_noindex(self.client.get("/plain/"), 200)

    def test_robots_txt(self):
        response = self.client.get("/robots.txt")
        self.assert_noindex(response, 200)
        self.assertEqual(response["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(response["Content-Length"], str(len(ROBOTS)))
        self.assertEqual(response.content, ROBOTS)

    def test_robots_txt_head(self):
        response = self.client.head("/robots.txt")
        self.assert_noindex(response, 200)
        self.assertEqual(response["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(response["Content-Length"], str(len(ROBOTS)))
        self.assertEqual(response.content, b"")

    def test_robots_txt_ignores_the_query(self):
        self.assertEqual(self.client.get("/robots.txt?page=2").content, ROBOTS)

    def test_robots_txt_other_methods_and_paths_are_ordinary_requests(self):
        for method, target in (("post", "/robots.txt"), ("put", "/robots.txt"), ("delete", "/robots.txt"),
                               ("get", "/robots.txt/"), ("get", "/api/robots.txt/"), ("get", "/Robots.txt")):
            with self.subTest(method=method, target=target):
                response = getattr(self.client, method)(target)
                self.assert_noindex(response, 404)
                self.assertNotIn(ROBOTS, response.content)
        # /api without the trailing slash keeps its former contract: a redirect to the path with it.
        with self.subTest(method="get", target="/api/robots.txt"):
            response = self.client.get("/api/robots.txt")
            self.assert_noindex(response, 301)
            self.assertEqual(response["Location"], "/api/robots.txt/")
            self.assertNotIn(ROBOTS, response.content)

    @override_settings(**TRUSTED)
    def test_robots_txt_is_answered_before_the_https_redirect(self):
        self.assertEqual(Client().get("/robots.txt").content, ROBOTS)


class ProxySchemeTests(SimpleTestCase):
    # SecurityMiddleware reads its settings once per handler: every case takes a new client.
    def get(self, proto=None, **overrides):
        with override_settings(**overrides):
            extra = {} if proto is None else {"HTTP_X_FORWARDED_PROTO": proto}
            return Client().get("/admin/login/", **extra)

    def test_settings_are_consistent(self):
        self.assertIsInstance(settings.TRUST_PROXY, bool)
        self.assertEqual(settings.SECURE_PROXY_SSL_HEADER is not None, settings.TRUST_PROXY)
        self.assertEqual(settings.SECURE_SSL_REDIRECT, settings.TRUST_PROXY)

    def test_trusted_request_without_the_header_is_redirected_to_https(self):
        for proto in (None, "http", "HTTPS", "http, https"):
            with self.subTest(proto=proto):
                response = self.get(proto, **TRUSTED)
                self.assertEqual(response.status_code, 301)
                self.assertEqual(response["Location"], "https://testserver/admin/login/")
                self.assertEqual(response["X-Robots-Tag"], NOINDEX)
                self.assertNotIn("Strict-Transport-Security", response)

    def test_trusted_https_header_makes_the_request_secure(self):
        response = self.get("https", **TRUSTED)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Strict-Transport-Security"], "max-age=3600")
        self.assertEqual(response["X-Robots-Tag"], NOINDEX)

    def test_header_is_ignored_without_trust(self):
        response = self.get("https", **UNTRUSTED)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Strict-Transport-Security", response)

    def test_header_does_not_stop_the_redirect_without_trust(self):
        response = self.get("https", **{**UNTRUSTED, "SECURE_SSL_REDIRECT": True})
        self.assertEqual(response.status_code, 301)
        self.assertEqual(response["Location"], "https://testserver/admin/login/")

    def test_no_hsts_with_zero_seconds(self):
        response = self.get("https", **{**TRUSTED, "SECURE_HSTS_SECONDS": 0})
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("Strict-Transport-Security", response)


@tag("integration")
class SecureCookieTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.staff_user = get_user_model().objects.create_user(
            "cookie-staff", password="test-only-password", is_staff=True,
        )

    def log_in(self):
        client = Client()
        page = client.get("/admin/login/", secure=True)
        self.assertEqual(page.status_code, 200)
        page_cookie = page.cookies[settings.CSRF_COOKIE_NAME]
        response = client.post("/admin/login/?next=/admin/", {
            "username": "cookie-staff", "password": "test-only-password", "next": "/admin/",
        }, secure=True)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response["Location"], "/admin/")
        self.assertIn("_auth_user_id", client.session)
        return page_cookie, response.cookies[settings.CSRF_COOKIE_NAME], response.cookies[settings.SESSION_COOKIE_NAME]

    @override_settings(SESSION_COOKIE_SECURE=True, CSRF_COOKIE_SECURE=True)
    def test_secure_cookies(self):
        page_csrf, csrf, session = self.log_in()
        for name, cookie in (("page csrf", page_csrf), ("csrf", csrf), ("session", session)):
            with self.subTest(cookie=name):
                self.assertIs(cookie["secure"], True)
                self.assertEqual(cookie["samesite"], "Lax")
        self.assertIs(session["httponly"], True)

    @override_settings(SESSION_COOKIE_SECURE=False, CSRF_COOKIE_SECURE=False)
    def test_local_cookies_are_not_secure(self):
        page_csrf, csrf, session = self.log_in()
        for name, cookie in (("page csrf", page_csrf), ("csrf", csrf), ("session", session)):
            with self.subTest(cookie=name):
                self.assertEqual(cookie["secure"], "")
                self.assertEqual(cookie["samesite"], "Lax")
        self.assertIs(session["httponly"], True)


class ClientAddressTests(SimpleTestCase):
    MISSING = object()

    def address(self, remote, forwarded=MISSING):
        extra = {} if forwarded is self.MISSING else {"HTTP_X_FORWARDED_FOR": forwarded}
        request = RequestFactory().get("/api/health/", **extra)
        if remote is self.MISSING:
            del request.META["REMOTE_ADDR"]
        else:
            request.META["REMOTE_ADDR"] = remote
        return client_address(request)

    @override_settings(TRUST_PROXY=False)
    def test_without_trust_only_the_remote_address_counts(self):
        for remote, forwarded, expected in (
            ("203.0.113.7", self.MISSING, "203.0.113.7"),
            ("203.0.113.7", "198.51.100.1", "203.0.113.7"),
            ("203.0.113.7", "198.51.100.1, 198.51.100.2", "203.0.113.7"),
            ("127.0.0.1", "198.51.100.1", "127.0.0.1"),
            ("2001:DB8::1", self.MISSING, "2001:db8::1"),
            (" 203.0.113.7 ", self.MISSING, "203.0.113.7"),
            ("", "198.51.100.1", ""),
            (self.MISSING, "198.51.100.1", ""),
            ("not-an-address", "198.51.100.1", ""),
            ("203.0.113.7:8000", self.MISSING, ""),
        ):
            with self.subTest(remote=remote, forwarded=forwarded):
                self.assertEqual(self.address(remote, forwarded), expected)

    @override_settings(TRUST_PROXY=True)
    def test_with_trust_the_last_forwarded_address_counts(self):
        for remote, forwarded, expected in (
            ("127.0.0.1", "198.51.100.1", "198.51.100.1"),
            # The left values come from the client; the proxy appends the right one.
            ("127.0.0.1", "10.0.0.1, 198.51.100.1", "198.51.100.1"),
            ("127.0.0.1", "10.0.0.1,198.51.100.1,203.0.113.9", "203.0.113.9"),
            ("127.0.0.1", "  198.51.100.1  ", "198.51.100.1"),
            ("127.0.0.1", "2001:DB8::2", "2001:db8::2"),
            ("127.0.0.1", self.MISSING, "127.0.0.1"),
            ("127.0.0.1", "", "127.0.0.1"),
            ("127.0.0.1", "198.51.100.1, unknown", "127.0.0.1"),
            ("127.0.0.1", "198.51.100.1,", "127.0.0.1"),
            ("127.0.0.1", "198.51.100.1:4711", "127.0.0.1"),
            ("127.0.0.1", "unknown", "127.0.0.1"),
            ("", "198.51.100.1", "198.51.100.1"),
            ("", "unknown", ""),
            (self.MISSING, self.MISSING, ""),
            ("not-an-address", "", ""),
        ):
            with self.subTest(remote=remote, forwarded=forwarded):
                self.assertEqual(self.address(remote, forwarded), expected)

    def test_result_is_always_a_string(self):
        for trusted in (False, True):
            with self.subTest(trusted=trusted), override_settings(TRUST_PROXY=trusted):
                self.assertIsInstance(self.address("203.0.113.7", "198.51.100.1"), str)
                self.assertIsInstance(self.address(self.MISSING), str)
