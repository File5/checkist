"""Real Django routes, CSRF, PostgreSQL commits and MEDIA; no model/network OCR.

APIClient dispatches HTTP requests in process. The separate runserver/host-worker
smoke in docs/verification.md covers sockets; browser acceptance belongs to people.
"""
import hashlib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from io import BytesIO, StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from types import ModuleType

from django.conf import settings
from django.conf.urls.static import static
from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import connection, connections
from django.test import TransactionTestCase, override_settings, tag
from django.urls import URLPattern
from django.views.static import serve
from PIL import Image
from rest_framework.test import APIClient

from catalog.models import Product
from receipts.models import Receipt, ReceiptLine
from recognition import queue
from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from recognition.pipeline import process_job
from recognition.providers.fake import FakeProvider
from stores.models import Country, Currency


@tag("integration")
class RecognitionEndToEndTests(TransactionTestCase):
    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        media = TemporaryDirectory(prefix="checkist-c6-media-")
        scratch = TemporaryDirectory(prefix="checkist-c6-scratch-")
        self.addCleanup(media.cleanup)
        self.addCleanup(scratch.cleanup)
        self.media = Path(media.name)
        override = override_settings(
            DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True,
            MEDIA_ROOT=media.name, RECEIPT_OCR_TEMP_ROOT=scratch.name,
            RECEIPT_OCR_PROVIDER="fake",
        )
        override.enable()
        self.addCleanup(override.disable)

        # config.urls binds document_root when imported. Preserve its actual API
        # routes and bind only the DEBUG media route to this test's temporary root.
        from config.urls import urlpatterns
        urlconf = ModuleType("recognition_e2e_urls")
        urlconf.urlpatterns = [
            route for route in urlpatterns
            if not (isinstance(route, URLPattern) and route.callback is serve)
        ] + static(settings.MEDIA_URL, document_root=media.name)
        urls = override_settings(ROOT_URLCONF=urlconf)
        urls.enable()
        self.addCleanup(urls.disable)

        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        call_command("seed_recognition_demo", stdout=StringIO())
        self.single = (self.media / "demo/single.png").read_bytes()
        self.double = (self.media / "demo/double.png").read_bytes()
        self.client = APIClient(enforce_csrf_checks=True)
        csrf = self.get("/api/recognition/csrf/")
        self.client.credentials(
            HTTP_X_CSRFTOKEN=csrf["csrf_token"], HTTP_ORIGIN="http://testserver",
        )

    def get(self, url):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def post(self, url, expected=202):
        response = self.client.post(url, {}, format="json")
        self.assertEqual(response.status_code, expected, response.content)
        return response.json()

    def upload(self, data=None, expected=202):
        response = self.client.post(
            "/api/recognition/photos/",
            {"file": SimpleUploadedFile("synthetic.png", data or self.double, "image/png")},
            format="multipart",
        )
        self.assertEqual(response.status_code, expected, response.content)
        result = response.json()
        self.assertEqual(response["Location"], self.job_url(result["job"]["id"]))
        return result

    @staticmethod
    def job_url(job_id):
        return f"/api/recognition/jobs/{job_id}/"

    def run_once(self, job_id, scenario="success2"):
        output = StringIO()
        call_command("recognition_worker", once=True, fake_scenario=scenario, stdout=output)
        result = self.get(self.job_url(job_id))
        self.assertIn(f"Job {job_id}: {result['status']}", output.getvalue())
        return result

    def another_photo(self):
        # Identical fictional paper/pixels, different encoded bytes/SHA-256.
        data = BytesIO()
        with Image.open(BytesIO(self.single)) as image:
            image.save(data, format="PNG", compress_level=0)
        result = data.getvalue()
        self.assertNotEqual(hashlib.sha256(result).digest(), hashlib.sha256(self.single).digest())
        return result

    def assert_media(self, url, file):
        self.assertTrue(file.is_file())
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        try:
            content = b"".join(response.streaming_content)
        finally:
            response.close()
        self.assertEqual(content, file.read_bytes())

    def test_upload_two_receipts_worker_media_lines_and_exact_replay(self):
        uploaded = self.upload()
        self.assertFalse(uploaded["reused"])
        self.assertEqual(uploaded["job"]["status"], "queued")
        self.assertEqual(Receipt.objects.count(), 0)
        result = self.run_once(uploaded["job"]["id"])
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(result["items_count"], 2)
        self.assertEqual(result["progress"]["detected"], 2)
        self.assertEqual(result["progress"]["completed"], 2)
        self.assertEqual(result["progress"]["imported"], 2)
        self.assertTrue(all(item["status"] == "imported" for item in result["items"]))

        photo = self.get(f"/api/recognition/photos/{uploaded['photo']['id']}/")
        stored = SourcePhoto.objects.get(pk=photo["id"])
        self.assertEqual(Path(stored.original_file.path).read_bytes(), self.double)
        self.assert_media(photo["original_url"], Path(stored.original_file.path))
        self.assert_media(photo["preview_url"], Path(stored.upright_file.path))
        images = self.get(f"/api/recognition/receipt-images/?job={result['id']}")
        self.assertEqual(images["count"], 2)
        for image in images["results"]:
            file = Path(ReceiptImage.objects.get(pk=image["id"]).file.path)
            self.assert_media(image["image_url"], file)
            detail = self.get(f"/api/recognition/receipt-images/{image['id']}/")
            self.assertEqual(detail["receipt_id"], image["receipt_id"])

        receipts = self.get("/api/receipts/")
        self.assertEqual(receipts["count"], 2)
        self.assertEqual(sorted(r["total"] for r in receipts["results"]), ["4.42", "6.00"])
        lines_by_total = {}
        for receipt in receipts["results"]:
            self.assertEqual(self.get(f"/api/receipts/{receipt['id']}/")["id"], receipt["id"])
            lines_by_total[receipt["total"]] = self.get(receipt["lines_url"])["results"]
            for line in lines_by_total[receipt["total"]]:
                if line["kind"] == "product":
                    self.assertIsNotNone(line["product"])
                    self.assertEqual(line["matching_status"], "matched")
            self.get(receipt["discounts_url"])
            self.get(receipt["taxes_url"])
        self.assertEqual([line["name"] for line in lines_by_total["4.42"]],
                         ["MILCH 1 L", "APFEL", "MINERALWASSER 0.5 L", "PFAND zu MINERALWASSER"])
        self.assertEqual([line["name"] for line in lines_by_total["6.00"]], ["BROT", "KAESE 200 G"])
        self.assertEqual((ReceiptLine.objects.count(), Product.objects.count()), (6, 5))

        replay = self.upload(expected=200)
        self.assertTrue(replay["reused"])
        self.assertEqual(replay["photo"]["id"], photo["id"])
        self.assertEqual(replay["job"]["id"], result["id"])
        self.assertEqual((SourcePhoto.objects.count(), ProcessingJob.objects.count(),
                          Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()),
                         (1, 1, 2, 6, 5))

    def test_different_photo_reuses_strong_identity_without_duplicate_lines_or_products(self):
        first = self.run_once(self.upload(self.single)["job"]["id"], "one_receipt")
        receipt_id = first["items"][0]["receipt_id"]
        lines = list(ReceiptLine.objects.order_by("position").values())
        products = list(Product.objects.order_by("pk").values())
        second_upload = self.upload(self.another_photo())
        self.assertFalse(second_upload["reused"])
        second = self.run_once(second_upload["job"]["id"], "duplicate_strong")
        self.assertEqual(second["status"], "succeeded")
        self.assertEqual(second["items"][0]["receipt_id"], receipt_id)
        self.assertEqual((second["progress"]["imported"], second["progress"]["reused"]), (0, 1))
        self.assertEqual((Receipt.objects.count(), SourcePhoto.objects.count()), (1, 2))
        self.assertEqual(lines, list(ReceiptLine.objects.order_by("position").values()))
        self.assertEqual(products, list(Product.objects.order_by("pk").values()))
        self.assertEqual(self.get(f"/api/receipts/{receipt_id}/")["receipt_images_count"], 2)

    def test_different_photo_without_numbers_reuses_exact_store_time_total(self):
        class NoNumbers(FakeProvider):
            def recognize(self, crop, run):
                observation = super().recognize(crop, run)
                return replace(
                    observation, receipt_number=None, shift_number=None, register_code=None,
                    fields=tuple(f for f in observation.fields if f.path not in
                                 {"/receipt_number", "/shift_number", "/register_code"}),
                )
        first = self.run_once(self.upload(self.single)["job"]["id"], "one_receipt")
        self.upload(self.another_photo())
        result = process_job(queue.claim_job(), provider=NoNumbers("duplicate_weak"))
        second = self.get(self.job_url(result.pk))
        self.assertEqual(second["status"], "succeeded")
        self.assertEqual(second["items"][0]["receipt_id"], first["items"][0]["receipt_id"])
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (1, 4, 3))

    def test_http_cancel_queued_and_retry_cancelled(self):
        uploaded = self.upload()
        job_id = uploaded["job"]["id"]
        cancelled = self.post(self.job_url(job_id) + "cancel/", expected=200)
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["items"], [])
        self.assertIsNone(queue.claim_job())
        replay = self.upload(expected=200)
        self.assertEqual(replay["job"]["id"], job_id)
        retry = self.post(self.job_url(job_id) + "retry/")
        self.assertEqual((retry["retry_of"], retry["status"]), (job_id, "queued"))
        self.assertNotEqual(retry["id"], job_id)
        self.assertEqual(self.run_once(retry["id"])["status"], "succeeded")
        self.assertEqual(self.get(self.job_url(job_id))["status"], "cancelled")

    def test_http_retry_failed_job_preserves_failure(self):
        job_id = self.upload()["job"]["id"]
        failed = self.run_once(job_id, "no_receipts")
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error"]["code"], "no_receipts")
        retry = self.post(self.job_url(job_id) + "retry/")
        self.assertEqual(retry["retry_of"], job_id)
        self.assertEqual(self.run_once(retry["id"])["status"], "succeeded")
        self.assertEqual(self.get(self.job_url(job_id))["status"], "failed")
        self.assertEqual(Receipt.objects.count(), 2)

    def cancel_recognizing(self, position):
        gate, entered = Event(), Event()

        class PauseSelected(FakeProvider):
            def recognize(self, crop, run):
                provider = FakeProvider("pause_recognize", gate=gate, entered=entered)
                return provider.recognize(crop, run) if crop.position == position else super().recognize(crop, run)

        def worker(job):
            try:
                return process_job(job, provider=PauseSelected())
            finally:
                connections.close_all()

        job_id = self.upload()["job"]["id"]
        with ThreadPoolExecutor(max_workers=1) as executor:
            future = executor.submit(worker, queue.claim_job())
            try:
                self.assertTrue(entered.wait(10), "Worker never entered recognize")
                running = self.get(self.job_url(job_id))
                self.assertEqual((running["status"], running["stage"]), ("running", "recognize"))
                self.assertEqual(running["progress"]["current_position"], position)
                self.assertEqual(running["progress"]["imported"], position - 1)
                self.assertTrue(running["executor"]["available"])
                requested = self.post(self.job_url(job_id) + "cancel/")
                self.assertEqual(requested["status"], "cancel_requested")
                self.assertEqual(future.result(timeout=10).status, "cancelled")
            finally:
                gate.set()
                future.result(timeout=10)
        cancelled = self.get(self.job_url(job_id))
        self.assertEqual(cancelled["status"], "cancelled")
        self.assertEqual(cancelled["progress"]["imported"], position - 1)
        self.assertEqual(cancelled["progress"]["cancelled"], 3 - position)
        self.assertEqual(Receipt.objects.count(), position - 1)
        self.assertEqual([item["status"] for item in cancelled["items"]],
                         ["imported"] * (position - 1) + ["cancelled"] * (3 - position))
        retry = self.post(self.job_url(job_id) + "retry/")
        completed = self.run_once(retry["id"])
        self.assertEqual(completed["status"], "succeeded")
        self.assertEqual(completed["progress"]["reused"], position - 1)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (2, 6, 5))
        self.assertEqual(self.get(self.job_url(job_id))["status"], "cancelled")

    def test_http_cancel_during_first_recognition_prevents_import_and_can_retry(self):
        self.cancel_recognizing(1)

    def test_http_cancel_during_second_recognition_preserves_first_receipt_and_can_retry(self):
        self.cancel_recognizing(2)

    def test_incomplete_result_is_visible_with_review_reasons_and_crop_url(self):
        result = self.run_once(self.upload()["job"]["id"], "partial_success")
        self.assertEqual(result["status"], "partial_succeeded")
        self.assertEqual((result["progress"]["imported"], result["progress"]["review"]), (1, 1))
        item = next(item for item in result["items"] if item["status"] == "needs_review")
        image = self.get(f"/api/recognition/receipt-images/{item['image_id']}/")
        self.assertIsNone(image["receipt_id"])
        self.assertIsNone(image["normalized_result"]["lines"][0]["quantity"])
        self.assertIn(("missing_required", "/lines/0/quantity"),
                      [(reason["code"], reason["field"]) for reason in image["issues"]])
        self.assertTrue(all(reason["message"] for reason in image["issues"]))
        stored = ReceiptImage.objects.get(pk=item["image_id"])
        self.assertIsNotNone(stored.normalized_result)
        self.assert_media(image["image_url"], Path(stored.file.path))
        self.assertEqual(self.get("/api/receipts/")["count"], 1)

        retry = self.post(self.job_url(result["id"]) + "retry/")
        completed = self.run_once(retry["id"])
        self.assertEqual((completed["status"], completed["progress"]["reused"]), ("succeeded", 1))
        self.assertEqual(Receipt.objects.count(), 2)
        self.assertEqual(self.get(f"/api/recognition/receipt-images/{item['image_id']}/")["status"], "needs_review")

    def test_contradictory_totals_are_preserved_for_review_without_domain_writes(self):
        result = self.run_once(self.upload()["job"]["id"], "inconsistent_total")
        self.assertEqual((result["status"], result["progress"]["review"]), ("partial_succeeded", 2))
        self.assertEqual((Receipt.objects.count(), Product.objects.count()), (0, 0))
        for item in result["items"]:
            image = self.get(f"/api/recognition/receipt-images/{item['image_id']}/")
            self.assertEqual(image["status"], "needs_review")
            self.assertEqual(image["normalized_result"]["proposed_receipt"]["total"], "123.45")
            self.assertIn("total_mismatch", [reason["code"] for reason in image["issues"]])
