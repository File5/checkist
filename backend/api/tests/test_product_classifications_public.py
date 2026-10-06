"""Эталонные JSON для клиента сверяются целиком с настоящими HTTP-ответами."""
import json
from datetime import timedelta
from unittest.mock import patch

from django.db import OperationalError
from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.classification_factories import (
    CURD_ID, KEFIR_ID, MEAT, MILK_ID, PRIVATE, PUBLIC, QUEUED, RESOLVED, SAUSAGE_ID, SERVICE_ID, expected, failed_run,
    local_client, public_classification_data, restart_ids, start_run,
)
from catalog.models import Category, GenericProduct, Product
from classification import services
from classification.models import ClassificationRun, ProductClassification

BASE = "/api/product-classifications/"
REQUESTS = {"confirm-request.json", "confirm-other-request.json", "reject-request.json", "confirm-many-request.json"}
EXAMPLES = REQUESTS | {
    "classifications.json", "classification-pending.json", "classification-confirmed.json",
    "classification-confirmed-other.json", "classification-rejected.json", "classification-superseded.json",
    "confirm-many.json", "status.json", "status-queued.json", "status-running.json", "status-empty.json",
    "run-created.json", "run-existing.json", "run-nothing.json", "run.json", "run-failed.json", "runs.json",
    "error-classification-resolved.json", "error-classification-resolved-items.json",
    "error-classification-changed.json", "error-classification-changed-items.json",
    "error-classification-busy.json", "error-invalid-parameter.json", "error-invalid-parameter-service.json",
    "error-invalid-parameter-items.json", "error-invalid-request.json", "error-permission-denied.json",
    "error-csrf-failed.json", "error-not-found.json", "error-page-out-of-range.json",
    "error-database-unavailable.json",
}
# Файлы пустой базы проверяет отдельный тест.
EMPTY = {"status-empty.json", "run-nothing.json"}


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True, PRODUCT_CLASSIFICATION_AUTO_SUGGEST=False)
class PublicExamplesTests(TestCase):
    def setUp(self):
        restart_ids()
        self.client = local_client()
        self.seen = set()

    def check(self, name, response, status=200):
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertNotIn(PRIVATE, response.content.decode("utf-8"))
        self.assertEqual(response.json(), expected(name), name)
        self.seen.add(name)

    def post(self, path, body):
        return self.client.post(BASE + path, body, format="json")

    def request(self, name):
        self.seen.add(name)
        return expected(name)

    def test_public_examples_match_actual_http_responses(self):
        public_classification_data()
        # Правка в админке: товар 18 уже в «Молоко», запись 8 ещё ждёт сверки.
        self.assertEqual(ProductClassification.objects.get(pk=8).status, "pending")
        with patch.object(services, "_db_now", return_value=RESOLVED):
            # Первая же операция над записью 8 закрывает её сверкой и отвечает отказом.
            self.check("error-classification-resolved.json", self.post("8/reject/", {"version": 1}), 409)
            self.check(
                "classification-confirmed-other.json",
                self.post("6/confirm/", self.request("confirm-other-request.json")),
            )
            self.check("classification-superseded.json", self.client.get(BASE + "8/"))

            self.check("classifications.json", self.client.get(BASE + "?status=pending"))
            self.check("classification-pending.json", self.client.get(BASE + "3/"))
            self.check("status.json", self.client.get(BASE + "status/"))
            self.check("run.json", self.client.get(BASE + "runs/1/"))

            with patch("django.utils.timezone.now", return_value=QUEUED):
                self.check("run-created.json", self.post("runs/", {}), 202)
            self.check("run-existing.json", self.post("runs/", {}))
            self.check("status-queued.json", self.client.get(BASE + "status/"))
            self.check("runs.json", self.client.get(BASE + "runs/"))
            start_run(2, started_at=QUEUED + timedelta(seconds=5))
            self.check("status-running.json", self.client.get(BASE + "status/"))
            failed_run()
            self.check("run-failed.json", self.client.get(BASE + "runs/3/"))

            # Отказы ничего не меняют: дальше те же записи подтверждаются и отклоняются с версией 1.
            self.check(
                "error-classification-changed.json",
                self.post("3/confirm/", {"version": 7, "generic_id": SAUSAGE_ID}), 409,
            )
            self.check("error-invalid-parameter.json", self.post("3/confirm/", {"version": 1, "generic_id": 999}), 400)
            self.check(
                "error-invalid-parameter-service.json",
                self.post("3/confirm/", {"version": 1, "generic_id": SERVICE_ID}), 400,
            )
            self.check(
                "error-classification-resolved-items.json",
                self.post("confirm/", {"items": [{"id": 1, "version": 1}, {"id": 5, "version": 2}]}), 409,
            )
            self.check(
                "error-classification-changed-items.json",
                self.post("confirm/", {"items": [{"id": 1, "version": 7}, {"id": 2, "version": 1}]}), 409,
            )
            self.check(
                "error-invalid-parameter-items.json",
                self.post("confirm/", {"items": [{"id": pk, "version": 1} for pk in range(1, 102)]}), 400,
            )
            self.check(
                "error-invalid-request.json",
                self.client.post(BASE + "3/reject/", b"", content_type="application/json"), 400,
            )
            self.check("error-not-found.json", self.client.get(BASE + "999/"), 404)
            self.check("error-page-out-of-range.json", self.client.get(BASE + "?page=2"), 404)
            self.check(
                "error-csrf-failed.json",
                APIClient(enforce_csrf_checks=True).post(BASE + "3/reject/", {"version": 1}, format="json"), 403,
            )
            with override_settings(ALLOW_LOCAL_RECOGNITION_API=False):
                self.check("error-permission-denied.json", self.client.get(BASE), 403)
            with patch.object(services, "reject", side_effect=services.ClassificationBusy()):
                self.check("error-classification-busy.json", self.post("3/reject/", {"version": 1}), 409)
            with patch.object(services, "records", side_effect=OperationalError("secret")):
                self.check("error-database-unavailable.json", self.client.get(BASE), 503)
            self.assertEqual(
                list(ProductClassification.objects.filter(pk__in=(1, 2, 3, 4)).values_list("status", "version")),
                [("pending", 1)] * 4,
            )

            self.check("classification-confirmed.json", self.post("4/confirm/", self.request("confirm-request.json")))
            self.check("classification-rejected.json", self.post("3/reject/", self.request("reject-request.json")))
            self.check("confirm-many.json", self.post("confirm/", self.request("confirm-many-request.json")))

        self.assertEqual(self.seen, EXAMPLES - EMPTY)
        # Отклонение убрало созданные «Колбаса» и «Мясные продукты»; подтверждение приняло «Кефир».
        self.assertFalse(GenericProduct.objects.filter(pk=SAUSAGE_ID).exists())
        self.assertFalse(Category.objects.filter(pk=MEAT).exists())
        self.assertEqual(
            dict(Product.objects.values_list("pk", "generic_id")),
            {11: KEFIR_ID, 12: KEFIR_ID, 13: SERVICE_ID, 14: MILK_ID, 15: SERVICE_ID, 16: CURD_ID, 17: MILK_ID,
             18: MILK_ID, 19: SERVICE_ID},
        )
        self.assertEqual(ClassificationRun.objects.count(), 3)

    def test_examples_of_an_empty_database(self):
        self.check("status-empty.json", self.client.get(BASE + "status/"))
        self.check("run-nothing.json", self.post("runs/", {}))
        self.assertEqual(self.seen, EMPTY)
        self.assertFalse(ClassificationRun.objects.exists())

    def test_examples_are_utf8_lf_json(self):
        self.assertEqual({path.name for path in PUBLIC.glob("*.json")}, EXAMPLES)
        for path in sorted(PUBLIC.glob("*.json")):
            with self.subTest(name=path.name):
                raw = path.read_bytes()
                self.assertNotIn(b"\r", raw)
                self.assertTrue(raw.endswith(b"\n"))
                self.assertEqual(
                    raw.decode("utf-8"), json.dumps(json.loads(raw), ensure_ascii=False, indent=2) + "\n",
                )
