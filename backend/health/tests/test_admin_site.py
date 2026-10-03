from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.test import Client, SimpleTestCase, TestCase, tag
from django.urls import resolve

LOGIN_REDIRECT = "/admin/login/?next=/admin/"


class AdminRouteTests(SimpleTestCase):
    def setUp(self):
        self.client = Client()

    def test_admin_index_is_routed_to_admin_site(self):
        match = resolve("/admin/")
        self.assertEqual(match.namespace, "admin")
        self.assertEqual(match.url_name, "index")

    def test_site_titles(self):
        self.assertEqual(admin.site.site_header, "Checkist — администрирование")
        self.assertEqual(admin.site.site_title, "Checkist")
        self.assertEqual(admin.site.index_title, "Данные чеков")

    def test_anonymous_is_redirected_to_login(self):
        response = self.client.get("/admin/")
        self.assertRedirects(response, LOGIN_REDIRECT, fetch_redirect_response=False)

    def test_login_page_is_available(self):
        response = self.client.get("/admin/login/")
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "admin/login.html")
        self.assertContains(response, "Checkist — администрирование")

    def test_health_is_still_anonymous_json(self):
        for name in ("database", "redis", "celery"):
            probe = patch(f"health.probes.probe_{name}", return_value={"status": "ok"})
            probe.start()
            self.addCleanup(probe.stop)
        response = self.client.get("/api/health/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response.json(), {
            "status": "ok",
            "checks": {name: {"status": "ok"} for name in ("database", "redis", "celery")},
        })


@tag("integration")
class AdminAccessTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        users = get_user_model().objects
        cls.plain_user = users.create_user("plain-user", password="test-only-password")
        cls.staff_user = users.create_user("staff-user", password="test-only-password", is_staff=True)
        cls.inactive_staff = users.create_user(
            "inactive-staff", password="test-only-password", is_staff=True, is_active=False,
        )
        cls.superuser = users.create_superuser("root-user", password="test-only-password")

    def setUp(self):
        self.client = Client()

    def assert_denied(self):
        response = self.client.get("/admin/")
        self.assertRedirects(response, LOGIN_REDIRECT, fetch_redirect_response=False)
        login = self.client.get(LOGIN_REDIRECT)
        self.assertEqual(login.status_code, 200)
        self.assertTemplateUsed(login, "admin/login.html")
        self.assertTemplateNotUsed(login, "admin/index.html")

    def test_user_without_is_staff_is_denied(self):
        self.client.force_login(self.plain_user)
        self.assert_denied()

    def test_inactive_staff_is_denied(self):
        self.client.force_login(self.inactive_staff)
        self.assert_denied()

    def test_user_without_is_staff_cannot_log_in_through_form(self):
        response = self.client.post(LOGIN_REDIRECT, {
            "username": "plain-user", "password": "test-only-password", "next": "/admin/",
        })
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "admin/login.html")
        self.assertNotIn("_auth_user_id", self.client.session)

    def test_staff_user_gets_index(self):
        self.client.force_login(self.staff_user)
        response = self.client.get("/admin/")
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "admin/index.html")

    def test_superuser_gets_index(self):
        self.client.force_login(self.superuser)
        response = self.client.get("/admin/")
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "admin/index.html")
        self.assertContains(response, "Checkist — администрирование")
        self.assertContains(response, "Данные чеков")
