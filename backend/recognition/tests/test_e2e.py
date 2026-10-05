"""Real Django routes, CSRF, PostgreSQL commits and MEDIA; no model/network OCR.

APIClient dispatches HTTP requests in process. The separate runserver/host-worker
smoke in docs/verification.md covers sockets; browser acceptance belongs to people.
"""
import hashlib
import math
import os
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from io import BytesIO, StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from types import ModuleType
from unittest.mock import patch

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
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from recognition import queue
from recognition.demo import seed_demo
from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from recognition.pipeline import process_job
from recognition.providers.fake import FakeProvider
from recognition.tests.import_fixtures import lidl_format_payload, observation, sparse_lidl_format_payload
from recognition.dto import FieldObservation, PreparedImage
from recognition.images import validate_geometry
from recognition.providers.base import RunContext
from recognition.schema_validation import validate_observation
from stores.models import Country, Currency, Merchant, Store


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
        self.assertTrue(url.startswith("/media/"), url)
        self.assertTrue(file.is_file())
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "image/png")
        try:
            content = b"".join(response.streaming_content)
        finally:
            response.close()
        self.assertEqual(content, file.read_bytes())

    def assert_rotated_end_to_end(self, *, single):
        paths = seed_demo(rotated=True)
        source = paths[0 if single else 1]
        uploaded = self.upload(source.read_bytes())
        inputs = []
        original = FakeProvider.recognize

        def capture(provider, crop, run):
            inputs.append(crop)
            return original(provider, crop, run)

        with patch.object(FakeProvider, "recognize", capture):
            job = self.run_once(uploaded["job"]["id"], "rotated_receipt" if single else "rotated_two_receipts")
        count = 1 if single else 2
        self.assertEqual((job["status"], job["progress"]["imported"], job["progress"]["completed"]),
                         ("succeeded", count, count))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()),
                         (1, 4, 3) if single else (2, 6, 5))
        self.assertEqual([crop.rotation_degrees for crop in inputs], [-12] if single else [0, -12])
        expected = FakeProvider("rotated_receipt" if single else "rotated_two_receipts")
        with Image.open(source) as image:
            detection = expected.detect(PreparedImage(source, "a" * 64, *image.size), RunContext(time.monotonic() + 5))
        rows = self.get(f"/api/recognition/receipt-images/?job={job['id']}")["results"]
        self.assertEqual(len(rows), count)
        for public in rows:
            stored = ReceiptImage.objects.get(pk=public["id"])
            geometry = detection.receipts[stored.position - 1]
            quad = [point.to_dict() for point in geometry.quad]
            self.assertEqual(stored.quad, quad)
            self.assertEqual(stored.bbox, geometry.bbox.to_dict())
            self.assertEqual(stored.rotation_degrees, geometry.rotation_degrees)
            detail = self.get(f"/api/recognition/receipt-images/{stored.pk}/")
            # List contains bbox; only detail exposes quad and rotation.
            self.assertEqual(public["bbox"], stored.bbox)
            self.assertEqual(public["receipt_id"], stored.receipt_id)
            self.assertEqual(detail["quad"], quad)
            self.assertEqual(detail["bbox"], stored.bbox)
            self.assertEqual(detail["rotation_degrees"], stored.rotation_degrees)
            self.assertEqual(detail["receipt_id"], stored.receipt_id)
            validate_geometry(stored.bbox, quad, stored.rotation_degrees)
            self.assertEqual(inputs[stored.position - 1].rotation_degrees, stored.rotation_degrees)
            self.assertEqual(inputs[stored.position - 1].sha256, stored.sha256)
            self.assert_media(detail["image_url"], Path(stored.file.path))
            with Image.open(source) as original_image, Image.open(stored.file.path) as crop:
                box = stored.bbox
                expected_bbox = [math.floor(max(0, box["x_min"] - .01) * original_image.width),
                                 math.floor(max(0, box["y_min"] - .01) * original_image.height),
                                 math.ceil(min(1, box["x_max"] + .01) * original_image.width),
                                 math.ceil(min(1, box["y_max"] + .01) * original_image.height)]
                self.assertEqual(stored.crop_transform["pixel_bbox"], expected_bbox)
                with original_image.crop(expected_bbox) as expected_crop:
                    self.assertEqual(crop.tobytes(), expected_crop.tobytes())
            receipt = self.get(f"/api/receipts/{stored.receipt_id}/")
            self.assertEqual(receipt["total"], "4.42" if stored.position == 1 else "6.00")
            self.assertEqual(self.get(receipt["lines_url"])["count"], 4 if stored.position == 1 else 2)
        self.assertEqual(self.upload(source.read_bytes(), expected=200)["job"]["id"], job["id"])
        self.assertEqual(Receipt.objects.count(), count)

    def test_single_rotated_receipt_worker_crop_rotation_import_and_api(self):
        self.assert_rotated_end_to_end(single=True)

    def test_two_receipts_one_rotated_worker_crop_rotation_import_and_api(self):
        self.assert_rotated_end_to_end(single=False)

    def assert_tax_id_completeness_http_roundtrip(self, first_id, second_id):
        receipt_id = None
        for index, (tax_id, photo) in enumerate(((first_id, self.single), (second_id, self.another_photo()))):
            uploaded = self.upload(photo)
            self.assertFalse(uploaded["reused"])
            scenario = "tax_id_present" if tax_id else "tax_id_absent"
            job = process_job(queue.claim_job(), provider=FakeProvider(scenario))
            self.assertEqual(job.pk, uploaded["job"]["id"])
            public = self.get(self.job_url(job.pk))
            self.assertEqual((public["status"], public["progress"]["review"]), ("succeeded", 0))
            self.assertFalse(public["review_required"])
            linked_id = public["items"][0]["receipt_id"]
            receipt = Receipt.objects.get(pk=linked_id)
            self.assertEqual((receipt.fiscal_key, receipt.receipt_number), ("", ""))
            if index == 0:
                receipt_id = linked_id
                lines = self.get(f"/api/receipts/{receipt_id}/lines/")
                discounts = self.get(f"/api/receipts/{receipt_id}/discounts/")
                taxes = self.get(f"/api/receipts/{receipt_id}/taxes/")
            else:
                self.assertEqual(linked_id, receipt_id)
                self.assertEqual(public["progress"]["reused"], 1)
        receipts = self.get("/api/receipts/")
        self.assertEqual(receipts["count"], 1)
        self.assertEqual(receipts["results"][0]["receipt_images_count"], 2)
        self.assertFalse(receipts["results"][0]["review_required"])
        self.assertEqual(self.get(f"/api/receipts/{receipt_id}/lines/"), lines)
        self.assertEqual(self.get(f"/api/receipts/{receipt_id}/discounts/"), discounts)
        self.assertEqual(self.get(f"/api/receipts/{receipt_id}/taxes/"), taxes)
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Receipt.objects.count()), (1, 1, 1))
        self.assertEqual((ReceiptLine.objects.count(), ReceiptDiscount.objects.count(), ReceiptTax.objects.count(),
                          Product.objects.count(), ProductAlias.objects.count()), (4, 1, 2, 3, 3))
        self.assertEqual((SourcePhoto.objects.count(), ProcessingJob.objects.count(), ReceiptImage.objects.count()), (2, 2, 2))
        self.assertEqual(ReceiptImage.objects.filter(receipt_id=receipt_id).count(), 2)
        self.assertEqual(Merchant.objects.get().tax_id, "DE999999994")

    def test_http_tax_id_then_absent_links_one_receipt(self):
        self.assert_tax_id_completeness_http_roundtrip("DE999999994", None)

    def test_http_absent_then_tax_id_links_one_receipt(self):
        self.assert_tax_id_completeness_http_roundtrip(None, "DE999999994")

    def test_http_ambiguous_sellers_require_review_without_a_new_receipt(self):
        for tax_id in ("DE999999994", "DE999999995"):
            merchant = Merchant.objects.create(country_id="DE", legal_name="TESTMARKT GmbH", tax_id=tax_id)
            Store.objects.create(merchant=merchant, country_id="DE", name="TESTMARKT",
                                 address_raw="Teststrasse 12, 10115 Berlin", timezone="Europe/Berlin")
        uploaded = self.upload(self.single)
        process_job(queue.claim_job(), provider=FakeProvider("tax_id_absent"))
        public = self.get(self.job_url(uploaded["job"]["id"]))
        self.assertEqual((public["status"], public["progress"]["review"]), ("partial_succeeded", 1))
        self.assertTrue(public["review_required"])
        item = public["items"][0]
        self.assertEqual(item["status"], "needs_review")
        self.assertIsNone(item["receipt_id"])
        image = self.get(f"/api/recognition/receipt-images/{item['image_id']}/")
        self.assertEqual(image["issues"][0]["field"], "/store")
        self.assertIsNotNone(image["normalized_result"])
        self.assertEqual(self.get("/api/receipts/")["count"], 0)
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Product.objects.count()), (2, 2, 0))
        self.assertEqual(ReceiptImage.objects.get().issues[0]["code"], "store_ambiguous")

    def test_c6_observation_with_notices_finishes_succeeded_and_replays_without_duplicates(self):
        class C6Provider(FakeProvider):
            def recognize(self, crop, run):
                value = observation()
                return replace(value, operation=None, fiscal=replace(value.fiscal, register_serial=None),
                               fields=tuple(f for f in value.fields if f.path not in {"/operation", "/fiscal/register_serial"}) + (
                                   FieldObservation("/operation", "absent", None, None),
                                   FieldObservation("/fiscal/register_serial", "ambiguous", None, None),
                               ))

        upload = self.upload(self.single)
        job = process_job(queue.claim_job(), provider=C6Provider("one_receipt"))
        self.assertEqual(job.status, "succeeded")
        self.assertEqual((job.imported_count, job.review_count), (1, 0))
        public = self.get(self.job_url(job.pk))
        self.assertFalse(public["review_required"])
        image = self.get(f"/api/recognition/receipt-images/{public['items'][0]['image_id']}/")
        self.assertEqual(image["status"], "imported")
        self.assertTrue(image["issues"])
        self.assertFalse(self.get(f"/api/receipts/{image['receipt_id']}/")["review_required"])
        replay = self.upload(self.single, expected=200)
        self.assertEqual(replay["job"]["id"], upload["job"]["id"])
        new = self.upload(self.another_photo())
        job = process_job(queue.claim_job(), provider=C6Provider("one_receipt"))
        self.assertEqual(job.pk, new["job"]["id"])
        self.assertEqual((job.status, job.reused_count, job.review_count), ("succeeded", 1, 0))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (1, 4, 3))

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
            self.assertEqual(detail["image_url"], image["image_url"])

        receipts = self.get("/api/receipts/")
        self.assertEqual(receipts["count"], 2)
        self.assertEqual(sorted(r["total"] for r in receipts["results"]), ["4.42", "6.00"])
        lines_by_total = {}
        for receipt in receipts["results"]:
            detail = self.get(f"/api/receipts/{receipt['id']}/")
            self.assertEqual(detail["id"], receipt["id"])
            file = Path(ReceiptImage.objects.filter(receipt_id=receipt["id"]).get().file.path)
            self.assert_media(receipt["preview_image_url"], file)
            self.assertEqual(detail["preview_image_url"], receipt["preview_image_url"])
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

    def test_safe_line_inferences_and_known_store_currency_finish_succeeded_without_duplicates(self):
        class MissingValues(FakeProvider):
            missing_currency = False

            def recognize(self, crop, run):
                value = super().recognize(crop, run)
                missing = {"/lines/0/quantity", "/lines/1/unit_price", "/lines/2/amount", "/lines/3/unit"}
                if self.missing_currency:
                    missing.add("/currency_code")
                return replace(value, currency_code=None if self.missing_currency else value.currency_code,
                    lines=tuple(replace(line, **{("quantity", "unit_price", "amount", "unit")[i]: None})
                                for i, line in enumerate(value.lines)),
                    fields=tuple(f for f in value.fields if f.path not in missing)
                    + tuple(FieldObservation(path, "absent", None, None)
                            for path in sorted(missing)))

        first = self.upload(self.single)
        result = process_job(queue.claim_job(), provider=MissingValues("one_receipt"))
        self.assertEqual((result.status, result.imported_count, result.review_count), ("succeeded", 1, 0))
        public = self.get(self.job_url(first["job"]["id"]))
        receipt_id = public["items"][0]["receipt_id"]
        lines = self.get(f"/api/receipts/{receipt_id}/lines/")["results"]
        self.assertEqual((lines[0]["quantity"], lines[1]["unit_price"], lines[2]["amount"], lines[3]["unit"]),
                         ("2.000", "2.0000", "0.79", "pcs"))
        self.assertFalse(public["review_required"])
        self.upload(self.another_photo())
        provider = MissingValues("one_receipt")
        provider.missing_currency = True
        result = process_job(queue.claim_job(), provider=provider)
        self.assertEqual((result.status, result.reused_count, result.review_count), ("succeeded", 1, 0))
        public = self.get(self.job_url(result.pk))
        self.assertEqual(public["items"][0]["receipt_id"], receipt_id)
        self.assertFalse(public["review_required"])
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (1, 4, 3))

    def assert_lidl_worker_http_receipt_and_photo_replay(self, payload_factory, *, tax_count):
        class LidlFormat(FakeProvider):
            def recognize(self, crop, run):
                self._stage("recognize", run)
                return validate_observation(payload_factory())

        first = self.upload(self.single)
        with patch("recognition.management.commands.recognition_worker.get_provider", return_value=LidlFormat("one_receipt")):
            result = self.run_once(first["job"]["id"], "one_receipt")
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual((result["progress"]["imported"], result["progress"]["review"]), (1, 0))
        self.assertFalse(result["review_required"])
        receipt_id = result["items"][0]["receipt_id"]
        detail = self.get(f"/api/receipts/{receipt_id}/")
        self.assertEqual(detail["total"], "40.80")
        self.assertEqual(detail["purchased_at"], "2026-10-01T17:01:56Z")
        lines = self.get(detail["lines_url"])["results"]
        self.assertEqual((lines[1]["quantity"], lines[1]["unit"], lines[1]["unit_price"]), ("1.000", "pcs", "3.4900"))
        self.assertEqual((lines[2]["quantity"], lines[2]["unit"]), ("2.000", "pcs"))
        self.assertEqual((lines[0]["quantity"], lines[0]["unit"]), ("0.294", "kg"))
        self.assertEqual((lines[21]["quantity"], lines[21]["unit_price"]), ("-5.000", "0.2500"))
        self.assertEqual(lines[17]["parent_id"], lines[16]["id"])
        self.assertEqual(lines[18]["amount"], "1.99")
        self.assertEqual(lines[18]["discount_amount"], "0.20")
        self.assertEqual(self.get(detail["discounts_url"])["count"], 3)
        self.assertEqual(self.get(detail["taxes_url"])["count"], tax_count)
        self.assertEqual(ProcessingJob.objects.get(pk=result["id"]).attempts.get(phase="recognize").prompt_version, "5")
        self.assertEqual(ReceiptImage.objects.get(job_id=result["id"]).normalized_result,
                         validate_observation(payload_factory()).to_dict())

        replay = self.upload(self.single, expected=200)
        self.assertTrue(replay["reused"])
        self.assertEqual(replay["job"]["id"], result["id"])
        second = self.upload(self.another_photo())
        with patch("recognition.management.commands.recognition_worker.get_provider", return_value=LidlFormat("one_receipt")):
            repeated = self.run_once(second["job"]["id"], "one_receipt")
        self.assertEqual((repeated["status"], repeated["progress"]["reused"], repeated["progress"]["review"]), ("succeeded", 1, 0))
        self.assertEqual(repeated["items"][0]["receipt_id"], receipt_id)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (1, 22, 20))

    def test_lidl_observation_worker_http_receipt_and_photo_replay(self):
        self.assert_lidl_worker_http_receipt_and_photo_replay(lidl_format_payload, tax_count=2)

    def test_sparse_lidl_observation_worker_http_receipt_and_photo_replay(self):
        self.assert_lidl_worker_http_receipt_and_photo_replay(sparse_lidl_format_payload, tax_count=0)

    def test_sparse_response_explicit_uncertainty_worker_http_remains_review(self):
        class UnreadableQuantity(FakeProvider):
            def recognize(self, crop, run):
                self._stage("recognize", run)
                payload = sparse_lidl_format_payload()
                payload["lines"][2]["quantity"] = None
                payload["fields"].append({"path": "/lines/2/quantity", "status": "unreadable",
                                          "confidence": None, "note": None})
                return validate_observation(payload)

        uploaded = self.upload(self.single)
        job = process_job(queue.claim_job(), provider=UnreadableQuantity("one_receipt"))
        public = self.get(self.job_url(uploaded["job"]["id"]))
        self.assertEqual((job.status, job.imported_count, job.review_count), ("partial_succeeded", 0, 1))
        self.assertTrue(public["review_required"])
        self.assertIsNone(public["items"][0]["receipt_id"])
        image = self.get(f"/api/recognition/receipt-images/{public['items'][0]['image_id']}/")
        self.assertEqual(image["status"], "needs_review")
        self.assertIsNone(image["normalized_result"]["lines"][2]["quantity"])
        self.assertIn(("missing_required", "/lines/2/quantity"),
                      [(v["code"], v["field"]) for v in image["issues"]])
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (0, 0, 0))

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

    def assert_tax_evidence_job(self, job, *, tax_evidence, receipts):
        self.assertEqual(job["status"], "succeeded")
        self.assertEqual((job["progress"]["imported"], job["progress"]["review"], job["progress"]["reused"]), (1, 0, 0))
        self.assertFalse(job["review_required"])
        image = ReceiptImage.objects.get(job_id=job["id"])
        self.assertEqual((image.status, image.import_effect), ("imported", "created"))
        expected = ["/receipt_number", "/fiscal/signature"]
        if not tax_evidence:
            expected += [f"/lines/{i}/tax_rate" for i in range(25)] + ["/taxes/0", "/taxes/1"]
        self.assertEqual(len(image.issues), 2 if tax_evidence else 29)
        self.assertEqual([(v["code"], v["field"]) for v in image.issues],
                         [("optional_omitted", path) for path in expected])
        attempt = ProcessingJob.objects.get(pk=job["id"]).attempts.get(phase="recognize")
        self.assertEqual((attempt.prompt_version, attempt.schema_version), ("5", "2"))
        receipt = Receipt.objects.get(pk=image.receipt_id)
        lines = list(receipt.lines.select_related("tax_rate").order_by("position"))
        self.assertEqual(([line.kind for line in lines].count("product"), [line.kind for line in lines].count("deposit"),
                          len(lines)), (21, 4, 25))
        self.assertEqual([line.tax_code for line in lines], ["A"] * 17 + ["B"] * 8)
        self.assertEqual([line.tax_rate and str(line.tax_rate.rate) for line in lines],
                         ["7.00"] * 17 + ["19.00"] * 8 if tax_evidence else [None] * 25)
        self.assertEqual(receipt.taxes.count(), 2 if tax_evidence else 0)
        detail = self.get(f"/api/receipts/{receipt.pk}/")
        self.assertEqual((detail["total"], detail["review_required"]), ("23.95", False))
        self.assertEqual(self.get(detail["lines_url"])["count"], 25)
        self.assertEqual(self.get(detail["taxes_url"])["count"], 2 if tax_evidence else 0)
        public = self.get(f"/api/recognition/receipt-images/{image.pk}/")
        self.assertEqual((public["status"], public["receipt_id"], len(public["issues"])),
                         ("imported", receipt.pk, len(expected)))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), ReceiptTax.objects.count()), receipts)
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Product.objects.count(),
                          ProductAlias.objects.count()), (1, 1, 21, 21))
        return receipt

    def test_tax_evidence_missing_worker_imports_with_29_notices(self):
        job = self.run_once(self.upload(self.single)["job"]["id"], "tax_evidence_missing")
        self.assert_tax_evidence_job(job, tax_evidence=False, receipts=(1, 25, 0))

    def test_tax_evidence_present_worker_imports_rates_and_taxes_with_2_notices(self):
        job = self.run_once(self.upload(self.single)["job"]["id"], "tax_evidence_present")
        self.assert_tax_evidence_job(job, tax_evidence=True, receipts=(1, 25, 2))

    def test_tax_evidence_present_after_missing_reuses_store_and_products_in_one_database(self):
        first_job = self.run_once(self.upload(self.single)["job"]["id"], "tax_evidence_missing")
        first = self.assert_tax_evidence_job(first_job, tax_evidence=False, receipts=(1, 25, 0))
        products = set(Product.objects.values_list("pk", flat=True))
        # The second file is selected by the server environment, as an operator would.
        uploaded = self.upload(self.double)
        with patch.dict(os.environ, {"RECEIPT_OCR_FAKE_SCENARIO": "tax_evidence_present"}):
            second_job = self.run_once(uploaded["job"]["id"], None)
        second = self.assert_tax_evidence_job(second_job, tax_evidence=True, receipts=(2, 50, 2))
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual(first.store_id, second.store_id)
        self.assertEqual(set(Product.objects.values_list("pk", flat=True)), products)
        self.assertEqual(first.lines.filter(tax_rate=None).count(), 25)
        self.assertEqual(len(ReceiptImage.objects.get(job_id=first_job["id"]).issues), 29)
