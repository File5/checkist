"""Fake scenario → host worker command → import → public HTTP issues, one database.

APIClient dispatches the real routes in process with cookie/Origin/CSRF; MEDIA and
scratch are temporary. No model call, no socket, no browser: runserver and Vite
are covered by the manual HTTP runs in docs/verification.md.
"""
import json
from collections import Counter
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import connection
from django.test import TransactionTestCase, override_settings, tag
from rest_framework.test import APIClient

from stores.models import Country, Currency


def issue(field, entity, index, position, attribute):
    return {"code": "invalid_value", "field": field, "message": "Значение не прошло проверку.",
            "reason": "optional_omitted", "severity": "warning",
            "context": {"entity": entity, "index": index, "position": position, "attribute": attribute}}


# Stored order: closed requisites, then line rates, then tax totals.
REQUISITES = [issue("/", "receipt", None, None, "receipt_metadata")] * 2
MISSING = (REQUISITES + [issue(f"/lines/{i}/tax_rate", "line", i, i + 1, "tax_rate") for i in range(25)]
           + [issue(f"/taxes/{i}", "tax", i, None, None) for i in range(2)])
# Names and values of closed fields of the synthetic receipt, and private provider text.
CLOSED = ("receipt_number", "shift_number", "register_code", "register_serial", "tse_transaction", "signature",
          "fiscal", "legal_name", "tax_id", "raw_text", "TEST-KASSE-07", "550001", "550002",
          "TESTKAUF GmbH", "SYNTHETIC RECEIPT")


@tag("integration")
class TaxEvidenceHttpTests(TransactionTestCase):
    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        media = TemporaryDirectory(prefix="checkist-tax-http-media-")
        scratch = TemporaryDirectory(prefix="checkist-tax-http-scratch-")
        self.addCleanup(media.cleanup)
        self.addCleanup(scratch.cleanup)
        override = override_settings(
            DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True, MEDIA_ROOT=media.name,
            RECEIPT_OCR_TEMP_ROOT=scratch.name, RECEIPT_OCR_PROVIDER="fake",
        )
        override.enable()
        self.addCleanup(override.disable)
        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        call_command("seed_recognition_demo", stdout=StringIO())
        self.single = (Path(media.name) / "demo/single.png").read_bytes()
        self.double = (Path(media.name) / "demo/double.png").read_bytes()
        self.bodies = []
        self.client = APIClient(enforce_csrf_checks=True)
        csrf = self.get("/api/recognition/csrf/")
        self.client.credentials(HTTP_X_CSRFTOKEN=csrf["csrf_token"], HTTP_ORIGIN="http://testserver")

    def get(self, url):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, response.content)
        self.bodies.append(response.content.decode())
        return response.json()

    def process(self, data, scenario):
        response = self.client.post(
            "/api/recognition/photos/", {"file": SimpleUploadedFile("synthetic.png", data, "image/png")},
            format="multipart")
        self.assertEqual(response.status_code, 202, response.content)
        job_id = response.json()["job"]["id"]
        call_command("recognition_worker", once=True, fake_scenario=scenario, stdout=StringIO())
        return self.get(f"/api/recognition/jobs/{job_id}/")

    def assert_scenario(self, job, issues, *, rates, taxes):
        self.assertEqual((job["status"], job["review_required"], job["error"]), ("succeeded", False, None))
        self.assertEqual(job["progress"], {"detected": 1, "current_position": None, "completed": 1, "imported": 1,
                                           "reused": 0, "review": 0, "failed": 0, "cancelled": 0})
        self.assertEqual([item["status"] for item in job["items"]], ["imported"])
        image_id, receipt_id = job["items"][0]["image_id"], job["items"][0]["receipt_id"]

        by_job = self.get(f"/api/recognition/receipt-images/?job={job['id']}")
        by_receipt = self.get(f"/api/recognition/receipt-images/?receipt={receipt_id}")
        detail = self.get(f"/api/recognition/receipt-images/{image_id}/")
        self.assertEqual((by_job["count"], by_receipt["count"]), (1, 1))
        for image in (by_job["results"][0], by_receipt["results"][0], detail):
            self.assertEqual((image["id"], image["status"], image["receipt_id"], image["normalized_result"]),
                             (image_id, "imported", receipt_id, None))
            self.assertEqual(image["issues"], issues)

        receipt = self.get(f"/api/receipts/{receipt_id}/")
        self.assertEqual((receipt["total"], receipt["review_required"], receipt["lines_count"],
                          receipt["unmatched_products_count"], receipt["receipt_images_count"]),
                         ("23.95", False, 25, 0, 1))
        lines = self.get(receipt["lines_url"])
        self.assertEqual((lines["count"], len(lines["results"])), (25, 25))
        self.assertEqual([line["position"] for line in lines["results"]], list(range(1, 26)))
        self.assertEqual(Counter(line["kind"] for line in lines["results"]), {"product": 21, "deposit": 4})
        self.assertEqual([line["tax_code"] for line in lines["results"]], ["A"] * 17 + ["B"] * 8)
        self.assertEqual([line["tax_rate"] and (line["tax_rate"]["kind"], line["tax_rate"]["rate"])
                          for line in lines["results"]], rates)
        self.assertEqual([(tax["tax_code"], tax["tax_rate"]["rate"], tax["net"], tax["tax"])
                          for tax in self.get(receipt["taxes_url"])["results"]], taxes)
        self.assertEqual(self.get(receipt["discounts_url"])["count"], 0)
        return receipt, {line["product"]["id"] for line in lines["results"] if line["kind"] == "product"}

    def assert_no_closed_data(self):
        self.assertTrue(self.bodies)
        for body in self.bodies:
            json.loads(body)
            for text in CLOSED:
                self.assertNotIn(text, body)

    def test_tax_evidence_missing_publishes_29_grouped_warnings(self):
        job = self.process(self.single, "tax_evidence_missing")
        self.assertEqual(len(MISSING), 29)
        _, products = self.assert_scenario(job, MISSING, rates=[None] * 25, taxes=[])
        self.assertEqual(len(products), 21)
        self.assert_no_closed_data()

    def test_tax_evidence_present_publishes_two_requisite_warnings_rates_and_totals(self):
        job = self.process(self.single, "tax_evidence_present")
        _, products = self.assert_scenario(
            job, REQUISITES, rates=[("vat", "7.00")] * 17 + [("vat", "19.00")] * 8,
            taxes=[("A", "7.00", "17.00", "1.19"), ("B", "19.00", "4.84", "0.92")])
        self.assertEqual(len(products), 21)
        self.assert_no_closed_data()

    def test_present_after_missing_is_second_receipt_without_new_products(self):
        first, products = self.assert_scenario(
            self.process(self.single, "tax_evidence_missing"), MISSING, rates=[None] * 25, taxes=[])
        catalog = self.get("/api/products/")["count"]
        second, repeated = self.assert_scenario(
            self.process(self.double, "tax_evidence_present"), REQUISITES,
            rates=[("vat", "7.00")] * 17 + [("vat", "19.00")] * 8,
            taxes=[("A", "7.00", "17.00", "1.19"), ("B", "19.00", "4.84", "0.92")])
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual(first["store"], second["store"])
        self.assertEqual((repeated, self.get("/api/products/")["count"], catalog), (products, 21, 21))
        self.assertEqual(self.get("/api/receipts/")["count"], 2)
        # The earlier receipt keeps its empty rates and its 29 warnings.
        self.assertEqual(self.get(f"/api/receipts/{first['id']}/taxes/")["count"], 0)
        self.assertEqual(self.get(f"/api/recognition/receipt-images/?receipt={first['id']}")["results"][0]["issues"],
                         MISSING)
        self.assert_no_closed_data()

    def test_needs_review_reasons_are_errors_apart_from_warnings(self):
        job = self.process(self.double, "inconsistent_total")
        self.assertEqual((job["status"], job["review_required"], job["progress"]["review"]),
                         ("partial_succeeded", True, 2))
        for item in job["items"]:
            image = self.get(f"/api/recognition/receipt-images/{item['image_id']}/")
            self.assertEqual((image["status"], image["receipt_id"]), ("needs_review", None))
            self.assertIsNotNone(image["normalized_result"])
            self.assertIn({"code": "total_mismatch", "field": "/total",
                           "message": "Сумма чека не совпадает с суммой позиций.", "reason": "total_mismatch",
                           "severity": "error",
                           "context": {"entity": "receipt", "index": None, "position": None, "attribute": "total"}},
                          image["issues"])
            for value in image["issues"]:
                self.assertEqual(set(value), {"code", "field", "message", "reason", "severity", "context"})
                self.assertEqual(value["severity"], "warning" if value["reason"] == "optional_omitted" else "error")
        self.assertEqual(self.get("/api/receipts/")["count"], 0)
