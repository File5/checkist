import hashlib
import json
import tempfile
import uuid
from datetime import datetime, timedelta, timezone as dt_timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import OperationalError
from django.test import TestCase, override_settings, tag
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from recognition.queue import claim_job, request_cancel
from recognition.storage import StorageError


NOW = datetime(2026, 10, 4, 12, 35, tzinfo=dt_timezone.utc)
PUBLIC = Path(__file__).resolve().parents[2] / "recognition/tests/fixtures/public"
BBOX = {"x_min": 0.1, "y_min": 0.1, "x_max": 0.9, "y_max": 0.9}
QUAD = [{"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.1}, {"x": 0.9, "y": 0.9}, {"x": 0.1, "y": 0.9}]


def image_bytes(format="PNG", size=(10, 20)):
    stream = BytesIO()
    Image.new("RGB", size, "white").save(stream, format=format)
    return stream.getvalue()


def upload(data=None, name="receipt.png", content_type="image/png"):
    return SimpleUploadedFile(name, image_bytes() if data is None else data, content_type=content_type)


def make_photo(**fields):
    fields.setdefault("sha256", uuid.uuid4().hex * 2)
    return SourcePhoto.objects.create(original_file="originals/test/source.png", content_type="image/png",
        bytes=80, raw_width=10, raw_height=20, width=10, height=20, **fields)


def make_image(job, **fields):
    fields.setdefault("position", 1)
    fields.setdefault("bbox", BBOX)
    fields.setdefault("quad", QUAD)
    return ReceiptImage.objects.create(photo=job.photo, job=job, file="crops/test/crop.png",
        sha256="b" * 64, width=8, height=16, **fields)


def public_data():
    from catalog.models import Category, GenericProduct, Product
    from receipts.models import Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
    from stores.models import Merchant, Store, TaxRate
    photo = make_photo(id=11, sha256=hashlib.sha256(image_bytes()).hexdigest())
    job = ProcessingJob.objects.create(id=31, photo=photo)
    merchant = Merchant.objects.create(id=51, country_id="DE", legal_name="PRIVATE LEGAL", brand_name="Тестовый магазин", tax_id="PRIVATE TAX")
    store = Store.objects.create(id=51, merchant=merchant, country_id="DE", city="Berlin",
        address_raw="Teststrasse 12", timezone="Europe/Berlin")
    category = Category.objects.create(name="Тест")
    generic = GenericProduct.objects.create(name="Молоко", category=category, base_unit="l")
    product = Product.objects.create(id=61, generic=generic, name="Молоко 1 л")
    receipt = Receipt.objects.create(id=71, store=store, currency_id="EUR", operation="sale",
        purchased_at=NOW, purchased_on=NOW.date(), total="2.38", discount_total="0.20",
        raw_text="PRIVATE TEXT", fiscal={"secret": "PRIVATE FISCAL"}, extra={"stderr": "PRIVATE STDERR"},
        fiscal_key="PRIVATE KEY", receipt_number="PRIVATE NUMBER", register_code="PRIVATE REGISTER", shift_number="PRIVATE SHIFT")
    rate = TaxRate.objects.get(country_id="DE", rate="7.00")
    line = ReceiptLine.objects.create(id=101, receipt=receipt, position=1, kind="product",
        raw_name="MILCH 1 L", quantity="2.000", unit="pcs", unit_price="1.2900", amount="2.58",
        discount_amount="0.20", product=product, tax_rate=rate, tax_code="A", store_item_code="M1",
        extra={"raw_text": "PRIVATE LINE"})
    ReceiptDiscount.objects.create(id=201, receipt=receipt, line=line, position=1, name="Rabatt MILCH", amount="0.20")
    ReceiptTax.objects.create(id=301, receipt=receipt, tax_rate=rate, tax_code="A", net="2.22", tax="0.16", gross="2.38")
    make_image(job, id=41, status="imported", receipt=receipt, import_effect="created", outcome_snapshot={"receipt_id": 71})
    make_image(job, id=42, position=2, status="needs_review", normalized_result={
        "merchant": {"brand_name": "Тестовый магазин", "legal_name": "PRIVATE LEGAL", "tax_id": "PRIVATE TAX"},
        "store": {"address_raw": "Teststrasse 12"}, "currency_code": "EUR", "operation": "sale",
        "purchased_on": "2026-10-04", "local_time": "14:35", "total": "4.52", "discount_total": None,
        "prices_include_tax": True, "raw_text": "PRIVATE TEXT", "fiscal": {"secret": "PRIVATE FISCAL"},
        "lines": [{"position": 1, "kind": "product", "raw_name": "МОЛОКО", "quantity": None,
                   "unit": "pcs", "unit_price": "1.2900", "product_hint": {"secret": "PRIVATE HINT"}}],
        "discounts": [], "taxes": [], "fields": [{"note": "PRIVATE NOTE"}], "warnings": ["PRIVATE WARNING"],
    }, issues=[{"code": "missing_required", "field": "/lines/0/quantity", "message": "PRIVATE MESSAGE"}])
    for model in (SourcePhoto, ProcessingJob, ReceiptImage, Receipt):
        model.objects.all().update(created_at=NOW)
    Receipt.objects.all().update(updated_at=NOW)
    ProcessingJob.objects.filter(pk=job.pk).update(status="partial_succeeded", stage="finished", finished_at=NOW,
        detected_count=2, completed_count=2, imported_count=1, review_count=1)
    photo.refresh_from_db()
    return photo, job, receipt, line


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class RecognitionAPITests(TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="checkist-c5-test-")
        self.addCleanup(self.directory.cleanup)
        self.settings_override = override_settings(MEDIA_ROOT=self.directory.name)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.client = APIClient(enforce_csrf_checks=True)
        response = self.client.get("/api/recognition/csrf/")
        self.assertEqual(response.status_code, 200)
        self.token = response.json()["csrf_token"]
        self.client.credentials(HTTP_X_CSRFTOKEN=self.token, HTTP_ORIGIN="http://testserver")

    def post_photo(self, data=None):
        return self.client.post("/api/recognition/photos/", {"file": upload(data)}, format="multipart")

    def error(self, response, status, code):
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response.json()["error"]["code"], code)
        self.assertEqual(response["Cache-Control"], "no-store")

    def test_upload_replay_original_and_latest_job(self):
        response = self.post_photo()
        self.assertEqual(response.status_code, 202, response.content)
        value = response.json()
        self.assertFalse(value["reused"])
        self.assertEqual(value["job"]["status"], "queued")
        self.assertEqual(value["photo"]["bytes"], len(image_bytes()))
        self.assertIsNone(value["photo"]["preview_url"])
        self.assertEqual(response["Location"], f'/api/recognition/jobs/{value["job"]["id"]}/')
        photo = SourcePhoto.objects.get()
        self.assertEqual(Path(photo.original_file.path).read_bytes(), image_bytes())
        request_cancel(value["job"]["id"])
        retry = self.client.post(response["Location"] + "retry/", {}, format="json")
        self.assertEqual(retry.status_code, 202)
        replay = self.post_photo().json()
        self.assertTrue(replay["reused"])
        self.assertEqual(replay["job"]["id"], retry.json()["id"])
        self.assertEqual(SourcePhoto.objects.count(), 1)
        self.assertEqual(ProcessingJob.objects.count(), 2)
        self.assertEqual(len(list(Path(self.directory.name).rglob("source.*"))), 1)

    def test_repeat_terminal_keeps_job_and_repairs_photo_without_job(self):
        first = self.post_photo().json()
        request_cancel(first["job"]["id"])
        repeated = self.post_photo()
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.json()["job"]["status"], "cancelled")
        self.assertEqual(ProcessingJob.objects.count(), 1)
        ProcessingJob.objects.all().delete()
        repaired = self.post_photo()
        self.assertEqual(repaired.status_code, 200)
        self.assertEqual(repaired.json()["job"]["status"], "queued")

    def test_file_validation_and_no_records(self):
        cases = [(b"\x00\x00\x00\x18ftypheic" + b"\0" * 20, "unsupported_format"),
                 (b"\x89PNG\r\n\x1a\ninvalid", "invalid_image"),
                 (b"", "invalid_image"), (image_bytes("GIF"), "unsupported_format")]
        for data, code in cases:
            with self.subTest(code=code, size=len(data)):
                self.error(self.post_photo(data), 400, code)
        self.assertEqual(SourcePhoto.objects.count(), 0)
        self.assertEqual(ProcessingJob.objects.count(), 0)

    def test_actual_twenty_mib_file_limit(self):
        self.error(self.post_photo(b"x" * (20 * 1024 * 1024 + 1)), 413, "upload_too_large")
        self.assertEqual(SourcePhoto.objects.count(), 0)

    def test_twenty_mib_inclusive_boundary(self):
        data = image_bytes()
        response = self.post_photo(data + b"\0" * (20 * 1024 * 1024 - len(data)))
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(response.json()["photo"]["bytes"], 20971520)

    def test_actual_forty_mp_header_is_rejected_before_decode(self):
        import struct
        import zlib
        data = bytearray(image_bytes())
        data[16:24] = struct.pack(">II", 8000, 5001)
        data[29:33] = struct.pack(">I", zlib.crc32(data[12:29]))
        self.error(self.post_photo(bytes(data)), 400, "image_too_large")

    def test_actual_multipart_limit(self):
        self.error(self.client.post("/api/recognition/photos/", {"file": upload(), "junk": "x" * (21 * 1024 * 1024)},
                                   format="multipart"), 413, "upload_too_large")

    def test_pixel_limit_and_animation(self):
        with override_settings(RECEIPT_IMAGE_MAX_PIXELS=100):
            self.error(self.post_photo(), 400, "image_too_large")
        stream = BytesIO()
        images = [Image.new("RGB", (10, 20), color) for color in ("white", "black")]
        images[0].save(stream, format="PNG", save_all=True, append_images=images[1:])
        self.error(self.post_photo(stream.getvalue()), 400, "invalid_image")

    def test_all_supported_formats_ignore_filename_and_mime(self):
        for format in ("JPEG", "PNG", "WEBP"):
            with self.subTest(format=format):
                response = self.client.post("/api/recognition/photos/", {"file": upload(image_bytes(format), "bad.heic", "text/plain")}, format="multipart")
                self.assertEqual(response.status_code, 202, response.content)
                self.assertEqual(response.json()["photo"]["content_type"], "image/" + ("jpeg" if format == "JPEG" else format.lower()))

    def test_multipart_shape_and_media_type(self):
        self.error(self.client.post("/api/recognition/photos/", {}, format="multipart"), 400, "invalid_parameter")
        self.error(self.client.post("/api/recognition/photos/", {"file": [upload(), upload()]}, format="multipart"), 400, "invalid_parameter")
        self.error(self.client.post("/api/recognition/photos/", {"file": upload(), "other": "secret"}, format="multipart"), 400, "invalid_request")
        self.error(self.client.post("/api/recognition/photos/", {"file": "text"}, format="multipart"), 400, "invalid_parameter")
        self.error(self.client.post("/api/recognition/photos/", {}, format="json"), 415, "unsupported_media_type")
        self.error(self.client.post("/api/recognition/photos/", b"broken", content_type="multipart/form-data"), 400, "invalid_request")

    def test_anonymous_csrf_and_origin_before_reading_body(self):
        anonymous = APIClient(enforce_csrf_checks=True)
        with patch("api.views.recognition.accept_upload") as accept:
            self.error(anonymous.post("/api/recognition/photos/", {"file": upload()}, format="multipart"), 403, "csrf_failed")
            accept.assert_not_called()
        for headers in ({"HTTP_X_CSRFTOKEN": "wrong", "HTTP_ORIGIN": "http://testserver"},
                        {"HTTP_X_CSRFTOKEN": self.token, "HTTP_ORIGIN": "https://evil.example"}, {}):
            self.client.credentials(**headers)
            self.error(self.post_photo(), 403, "csrf_failed")

    @override_settings(CSRF_TRUSTED_ORIGINS=["http://127.0.0.1:15173"])
    def test_trusted_proxy_origin(self):
        self.client.credentials(HTTP_X_CSRFTOKEN=self.token, HTTP_ORIGIN="http://127.0.0.1:15173")
        self.assertEqual(self.post_photo().status_code, 202)

    def test_disabled_debug_flag_and_nonloopback_all_endpoints(self):
        paths = ["recognition/csrf/", "recognition/photos/", "recognition/photos/1/", "recognition/jobs/", "recognition/jobs/1/",
                 "recognition/receipt-images/", "recognition/receipt-images/1/", "receipts/", "receipts/1/",
                 "receipts/1/lines/", "receipts/1/discounts/", "receipts/1/taxes/"]
        for settings in ({"DEBUG": False}, {"ALLOW_LOCAL_RECOGNITION_API": False}):
            with override_settings(**settings):
                for path in paths:
                    self.error(self.client.get("/api/" + path), 403, "permission_denied")
                for path in ("recognition/photos/", "recognition/jobs/1/cancel/", "recognition/jobs/1/retry/"):
                    self.error(self.client.post("/api/" + path, {}, format="json"), 403, "permission_denied")
        for peer in ("192.0.2.1", "", "bad"):
            self.error(self.client.get("/api/recognition/csrf/", REMOTE_ADDR=peer, HTTP_X_FORWARDED_FOR="127.0.0.1"), 403, "permission_denied")
        self.assertEqual(self.client.get("/api/recognition/csrf/", REMOTE_ADDR="::1").status_code, 200)

    def test_cancel_running_and_cancel_requested(self):
        job = ProcessingJob.objects.create(photo=make_photo())
        running = claim_job()
        self.assertEqual(running.pk, job.pk)
        path = f"/api/recognition/jobs/{job.pk}/cancel/"
        response = self.client.post(path, {}, format="json")
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(response.json()["status"], "cancel_requested")
        self.assertEqual(response.json()["actions"], {"can_cancel": False, "can_retry": False})
        again = self.client.post(path, {}, format="json")
        self.assertEqual(again.status_code, 202)
        self.assertEqual(again.json()["version"], response.json()["version"])

    def test_cancel_and_retry_every_state(self):
        for state in ("queued", "running", "cancel_requested", "cancelled", "succeeded", "partial_succeeded", "failed"):
            with self.subTest(state=state):
                job = ProcessingJob.objects.create(photo=make_photo())
                if state in {"running", "cancel_requested"}:
                    now = timezone.now()
                    ProcessingJob.objects.filter(pk=job.pk).update(status=state, stage="detect", run_token=uuid.uuid4(),
                        started_at=now, heartbeat_at=now, lease_expires_at=now + timedelta(seconds=30),
                        processing_deadline_at=now + timedelta(minutes=5), cancel_requested_at=now if state == "cancel_requested" else None)
                elif state != "queued":
                    ProcessingJob.objects.filter(pk=job.pk).update(status=state, stage="finished", finished_at=timezone.now(),
                        cancel_requested_at=timezone.now() if state == "cancelled" else None)
                path = f"/api/recognition/jobs/{job.pk}/"
                retry = self.client.post(path + "retry/", {}, format="json")
                if state in {"queued", "running", "cancel_requested"}:
                    self.error(retry, 409, "job_active")
                elif state == "succeeded":
                    self.error(retry, 409, "retry_not_allowed")
                else:
                    self.assertEqual(retry.status_code, 202)
                    self.assertEqual(retry.json()["retry_of"], job.pk)
                    self.error(self.client.post(path + "retry/", {}, format="json"), 409, "job_active")
                cancel = self.client.post(path + "cancel/", {}, format="json")
                if state in {"succeeded", "partial_succeeded", "failed"}:
                    self.error(cancel, 409, "job_terminal")
                else:
                    self.assertEqual(cancel.status_code, 202 if state in {"running", "cancel_requested"} else 200)
                # Avoid another running job interfering with the next subcase.
                ProcessingJob.objects.filter(photo_id=job.photo_id).delete()

    def test_mutation_csrf_json_validation_404_405(self):
        job = ProcessingJob.objects.create(photo=make_photo())
        for action in ("cancel", "retry"):
            path = f"/api/recognition/jobs/{job.pk}/{action}/"
            no_csrf = APIClient(enforce_csrf_checks=True)
            self.error(no_csrf.post(path, {}, format="json"), 403, "csrf_failed")
            for data in (b"", b"[]", b"null", b'{"a":1}', b'{"a":1,"a":2}', b'{', b'{"a":NaN}', b'\xff'):
                self.error(self.client.post(path, data, content_type="application/json"), 400, "invalid_request")
            self.error(self.client.post(path, "{}", content_type="text/plain"), 415, "unsupported_media_type")
            self.error(self.client.get(path), 405, "method_not_allowed")
            self.error(self.client.post(f"/api/recognition/jobs/999/{action}/", {}, format="json"), 404, "not_found")

    def test_lists_details_filters_pages_and_methods(self):
        photo = make_photo()
        job = ProcessingJob.objects.create(photo=photo)
        image = make_image(job)
        for resource, pk in (("photos", photo.pk), ("jobs", job.pk), ("receipt-images", image.pk)):
            base = f"/api/recognition/{resource}/"
            self.assertEqual(self.client.get(base).json()["count"], 1)
            self.assertEqual(self.client.get(base + str(pk) + "/").json()["id"], pk)
            for missing in ("999999", "0", "no", "9223372036854775808", "9" * 5000):
                self.error(self.client.get(base + missing + "/"), 404, "not_found")
            self.error(self.client.get(base + "?page=2"), 404, "page_out_of_range")
            self.error(self.client.get(base + "?page_size=201"), 400, "invalid_parameter")
            self.error(self.client.get(base + "?ordering=x"), 400, "invalid_parameter")
            self.error(self.client.delete(base + str(pk) + "/"), 405, "method_not_allowed")
        self.assertEqual(self.client.get(f"/api/recognition/jobs/?photo={photo.pk}&status=queued").json()["count"], 1)
        self.assertEqual(self.client.get("/api/recognition/jobs/?photo=999").json()["count"], 0)
        self.error(self.client.get("/api/recognition/jobs/?status=bad&photo=abc"), 400, "invalid_parameter")
        self.assertEqual(self.client.get(f"/api/recognition/receipt-images/?photo={photo.pk}&job={job.pk}").json()["count"], 1)
        self.assertEqual(self.client.get("/api/recognition/receipt-images/?receipt=999").json()["count"], 0)
        self.error(self.client.get("/api/recognition/receipt-images/?job=0"), 400, "invalid_parameter")
        self.error(self.client.get("/api/recognition/photos/", HTTP_ACCEPT="text/html"), 406, "not_acceptable")
        slash = self.client.post("/api/recognition/photos", {}, format="json")
        self.assertEqual(slash.status_code, 400)
        self.assertEqual(slash.json()["error"]["code"], "invalid_request")

    def test_no_n_plus_one_on_lists(self):
        for _ in range(5):
            make_image(ProcessingJob.objects.create(photo=make_photo()))
        for size in (1, 5):
            for path, queries in (("photos", 2), ("jobs", 3), ("receipt-images", 2)):
                with self.subTest(path=path, size=size), self.assertNumQueries(queries):
                    response = self.client.get(f"/api/recognition/{path}/?page_size={size}")
                    self.assertEqual(response.status_code, 200)

    def test_safe_projection_and_deleted_receipt(self):
        photo, job, receipt, line = public_data()
        for path in (f"/api/recognition/jobs/{job.pk}/", "/api/recognition/receipt-images/", "/api/recognition/receipt-images/42/"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn("PRIVATE", response.content.decode())
            for name in ("draft_id", "review_state", "identity_strength", "raw_text", "tax_id", "fiscal", "stderr", "product_hint"):
                self.assertNotIn('"' + name + '"', response.content.decode())
        image = self.client.get("/api/recognition/receipt-images/42/").json()
        self.assertIsNone(image["normalized_result"]["lines"][0]["quantity"])
        self.assertEqual(image["issues"][0]["message"], "Не удалось прочитать обязательное поле.")
        receipt.delete()
        deleted = self.client.get("/api/recognition/receipt-images/41/").json()
        self.assertTrue(deleted["receipt_deleted"])
        self.assertIsNone(deleted["receipt_id"])

    def test_known_storage_db_errors_are_safe(self):
        for exception, code in ((StorageError(), "storage_unavailable"), (OperationalError("PRIVATE DSN"), "database_unavailable")):
            with patch("api.views.recognition.accept_upload", side_effect=exception):
                response = self.post_photo()
                self.error(response, 503, code)
                self.assertNotIn("PRIVATE", response.content.decode())
        self.assertEqual(SourcePhoto.objects.count(), 0)

    def test_executor_stalled_and_safe_error(self):
        job = ProcessingJob.objects.create(photo=make_photo())
        job = claim_job()
        response = self.client.get(f"/api/recognition/jobs/{job.pk}/").json()
        self.assertTrue(response["executor"]["available"])
        self.assertFalse(response["stalled"])
        ProcessingJob.objects.filter(pk=job.pk).update(lease_expires_at=timezone.now() - timedelta(seconds=1), error_code="auth_required")
        response = self.client.get(f"/api/recognition/jobs/{job.pk}/").json()
        self.assertFalse(response["executor"]["available"])
        self.assertTrue(response["stalled"])
        self.assertEqual(response["error"], {"code": "auth_required", "message": "Требуется вход в сервис распознавания."})

    def test_media_debug_only(self):
        import importlib
        import config.urls
        from django.urls import clear_url_caches
        path = Path(self.directory.name) / "originals/test/source.png"
        path.parent.mkdir(parents=True)
        path.write_bytes(image_bytes())
        # URLconf static() is evaluated when imported, just as at server startup.
        try:
            for debug, expected in ((True, 200), (False, 404)):
                with override_settings(DEBUG=debug):
                    importlib.reload(config.urls)
                    clear_url_caches()
                    response = self.client.get("/media/originals/test/source.png")
                    self.assertEqual(response.status_code, expected)
                    if expected == 200:
                        self.assertEqual(b"".join(response.streaming_content), image_bytes())
        finally:
            importlib.reload(config.urls)
            clear_url_caches()

    def test_closed_json_cannot_be_smuggled_through_issues_geometry_or_values(self):
        job = ProcessingJob.objects.create(photo=make_photo())
        image = make_image(job, status="needs_review", bbox={**BBOX, "secret": "PRIVATE"},
            normalized_result={"operation": {"secret": "PRIVATE"}, "total": {"secret": "PRIVATE"},
                "store": {"name": {"secret": "PRIVATE"}}, "lines": [{"kind": {}, "unit": {}, "tax_rate": {"kind": {}}}]},
            issues=[{"code": "PRIVATE", "field": "/fiscal/PRIVATE", "message": "PRIVATE"}])
        response = self.client.get(f"/api/recognition/receipt-images/{image.pk}/")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("PRIVATE", response.content.decode())
        self.assertIsNone(response.json()["bbox"])
        self.assertEqual(response.json()["issues"], [{"code": "invalid_value", "field": "/", "message": "Значение не прошло проверку."}])

    def test_unrelated_active_job_does_not_block_retry(self):
        previous = ProcessingJob.objects.create(photo=make_photo())
        request_cancel(previous.pk)
        ProcessingJob.objects.create(photo=make_photo())
        response = self.client.post(f"/api/recognition/jobs/{previous.pk}/retry/", {}, format="json")
        self.assertEqual(response.status_code, 202)

    def test_file_size_is_measured_even_if_upload_size_lies(self):
        file = upload(b"x" * (20 * 1024 * 1024 + 1))
        file.size = 1
        # Exercise the real S1 service used by the endpoint, with a dishonest
        # UploadedFile metadata value, without substituting file validation.
        from recognition.images import ImageError
        from recognition.storage import accept_upload
        with self.assertRaises(ImageError) as caught:
            accept_upload(file)
        self.assertEqual(caught.exception.code, "file_too_large")
        self.assertEqual(SourcePhoto.objects.count(), 0)
