from itertools import product
from threading import Barrier
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings
from rest_framework.exceptions import APIException
from rest_framework.test import APIClient


class HealthAPITests(SimpleTestCase):
    def setUp(self):
        self.client = APIClient()
        self.probes = {}
        for name in ("database", "redis", "celery"):
            probe = patch(f"health.probes.probe_{name}", return_value={"status": "ok"})
            self.probes[name] = probe.start()
            self.addCleanup(probe.stop)

    def assert_json(self, response, status_code, body):
        self.assertEqual(response.status_code, status_code)
        self.assertEqual(response.json(), body)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_anonymous_get_exact_success(self):
        self.assert_json(self.client.get("/api/health/"), 200, {
            "status": "ok",
            "checks": {name: {"status": "ok"} for name in self.probes},
        })

    def test_probes_can_progress_independently(self):
        barrier = Barrier(3, timeout=2)

        def independent_probe():
            barrier.wait()
            return {"status": "ok"}

        for probe in self.probes.values():
            probe.side_effect = independent_probe
        self.assert_json(self.client.get("/api/health/"), 200, {
            "status": "ok",
            "checks": {name: {"status": "ok"} for name in self.probes},
        })

    def test_query_parameters_and_auth_header_are_ignored(self):
        response = self.client.get(
            "/api/health/?unknown=yes&format=html",
            HTTP_AUTHORIZATION="Bearer invalid-token",
        )
        self.assert_json(response, 200, {
            "status": "ok",
            "checks": {name: {"status": "ok"} for name in self.probes},
        })

    def test_each_dependency_failure_and_all_combinations(self):
        codes = ("database_unavailable", "redis_unavailable", "worker_unavailable")
        for failed in product((False, True), repeat=3):
            if not any(failed):
                continue
            with self.subTest(failed=failed):
                checks = {}
                for (name, probe), is_failed, code in zip(self.probes.items(), failed, codes):
                    checks[name] = {"status": "error", "code": code} if is_failed else {"status": "ok"}
                    probe.return_value = checks[name]
                    probe.reset_mock()
                self.assert_json(self.client.get("/api/health/"), 503, {
                    "status": "degraded",
                    "checks": checks,
                    "error": {
                        "code": "dependency_unavailable",
                        "message": "Один или несколько сервисов недоступны.",
                    },
                })
                for probe in self.probes.values():
                    probe.assert_called_once_with()

    def test_redis_outage_reports_cache_and_broker(self):
        self.probes["redis"].return_value = {"status": "error", "code": "redis_unavailable"}
        self.probes["celery"].return_value = {"status": "error", "code": "broker_unavailable"}
        self.assert_json(self.client.get("/api/health/"), 503, {
            "status": "degraded",
            "checks": {
                "database": {"status": "ok"},
                "redis": {"status": "error", "code": "redis_unavailable"},
                "celery": {"status": "error", "code": "broker_unavailable"},
            },
            "error": {
                "code": "dependency_unavailable",
                "message": "Один или несколько сервисов недоступны.",
            },
        })

    def test_write_methods_are_not_allowed(self):
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)("/api/health/")
                self.assert_json(response, 405, {
                    "error": {"code": "method_not_allowed", "message": "Метод не поддерживается."},
                })
                self.assertEqual(response["Allow"], "GET, HEAD, OPTIONS")
        for probe in self.probes.values():
            probe.assert_not_called()

    def test_incompatible_accept_is_json_406(self):
        self.assert_json(self.client.get("/api/health/", HTTP_ACCEPT="text/html"), 406, {
            "error": {"code": "not_acceptable", "message": "Доступен только JSON."},
        })
        for probe in self.probes.values():
            probe.assert_not_called()

    def test_unexpected_exception_is_safe_even_in_debug(self):
        for debug, exception_type in product((True, False), (RuntimeError, APIException)):
            with self.subTest(debug=debug, exception=exception_type), override_settings(DEBUG=debug):
                self.probes["database"].side_effect = exception_type(
                    "postgres://internal-host:5432/password-secret traceback"
                )
                self.assert_json(self.client.get("/api/health/"), 500, {
                    "error": {"code": "internal_error", "message": "Внутренняя ошибка сервера."},
                })

    def test_health_does_not_publish_tasks(self):
        with patch("health.tasks.ping.apply_async") as publish:
            self.assertEqual(self.client.get("/api/health/").status_code, 200)
            publish.assert_not_called()
