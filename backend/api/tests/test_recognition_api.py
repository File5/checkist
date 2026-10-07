import hashlib
import json
import tempfile
import uuid
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta, timezone as dt_timezone
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import OperationalError, connection, connections
from django.test import SimpleTestCase, TestCase, override_settings, tag
from django.utils import timezone
from PIL import Image
from rest_framework.test import APIClient

from api.recognition_serialization import public_issues
from receipts.ownership import local_user
from recognition.management.commands.recognition_worker import worker_slot
from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from recognition.queue import WORKER_LOCK, claim_job, request_cancel
from recognition.storage import StorageError


NOW = datetime(2026, 10, 4, 12, 35, tzinfo=dt_timezone.utc)
PUBLIC = Path(__file__).resolve().parents[2] / "recognition/tests/fixtures/public"
BBOX = {"x_min": 0.1, "y_min": 0.1, "x_max": 0.9, "y_max": 0.9}
QUAD = [{"x": 0.1, "y": 0.1}, {"x": 0.9, "y": 0.1}, {"x": 0.9, "y": 0.9}, {"x": 0.1, "y": 0.9}]
ABSENT = {"available": False, "state": "absent", "last_seen_at": None}
IDLE = {"available": True, "state": "idle", "last_seen_at": None}


INVALID = "Значение не прошло проверку."
PUBLIC_CODES = (
    "missing_required", "invalid_value", "total_mismatch", "tax_mismatch", "timezone_unknown", "time_ambiguous",
    "weak_identity", "identity_conflict", "product_unmatched", "product_ambiguous", "product_conflict",
    "geometry_requires_review", "clipped", "overlap", "timeout", "worker_lost", "storage_unavailable",
    "provider_error", "invalid_output", "auth_required", "rate_limited", "provider_unavailable",
    "network_unavailable", "configuration_error", "invalid_input", "cancelled", "no_receipts", "too_many_receipts",
)
INTERNAL_CODES = (
    "optional_omitted", "operation_defaulted", "currency_inferred", "ambiguous_value", "country_unknown",
    "currency_unknown", "import_busy", "import_failed", "merchant_conflict", "merchant_tax_id_invalid",
    "product_package_invalid", "receipt_conflict", "receipt_invalid", "receipt_line_conflict",
    "receipt_structure_conflict", "store_ambiguous", "store_conflict", "tax_rate_invalid", "tax_rate_unconfirmed",
    "timestamp_ambiguous", "timestamp_conflict",
)
UNKNOWN_CODES = ("invalid_image", "file_too_large", "unknown", "PRIVATE", "Optional_omitted", "optional_omitted ",
                 "", None, 7, True, 1.5, ["optional_omitted"], {"code": "clipped"})
IMAGE_STATUSES = ("pending", "running", "imported", "reused", "updated", "needs_review", "failed", "cancelled")
ENTITIES = {"receipt", "line", "tax", "discount", "geometry", "unknown"}
LINE_ATTRIBUTES = ("position", "kind", "parent_position", "raw_name", "name", "product", "quantity", "unit",
                   "unit_price", "amount", "discount_amount", "tax_amount", "tax_code", "tax_rate", "net", "tax",
                   "gross", "line_position", "barcode", "store_item_code", "is_excise", "is_marked")
HEADER_ATTRIBUTES = {
    "/identity": "identity", "/merchant": "merchant", "/store": "store", "/operation": "operation",
    "/currency": "currency", "/currency_code": "currency", "/purchased_on": "purchased_on",
    "/local_time": "local_time", "/total": "total", "/discount_total": "discount_total",
    "/prices_include_tax": "prices_include_tax", "/merchant/country_code": "merchant_country_code",
    "/merchant/brand_name": "merchant_brand_name", "/store/country_code": "store_country_code",
    "/store/name": "store_name", "/store/address_raw": "store_address_raw", "/store/city": "store_city",
}
GEOMETRY = {"/geometry": None, "/bbox": "bbox", "/quad": "quad", "/rotation_degrees": "rotation_degrees",
            "/clipped": "clipped"}
ATTRIBUTES = ({None, "receipt_metadata", "unknown"} | set(HEADER_ATTRIBUTES.values()) | set(GEOMETRY.values())
              | set(LINE_ATTRIBUTES) - {"raw_name"})
CLOSED_RECEIPT_FIELDS = ("/receipt_number", "/shift_number", "/register_code", "/fiscal", "/fiscal/signature",
                         "/fiscal/register_serial", "/merchant/tax_id", "/merchant/tax_id_type",
                         "/merchant/legal_name", "/store/postal_code", "/raw_text", "/a/b/c/d",
                         "/taxes/0/tax_rate/kind", "/taxes/0/secret", "/discounts/0/secret", "/discounts/0/line_id",
                         "/lines/12345/quantity", "/lines/x", "/lines/x/quantity", "/geometry/bbox", "/total/value")
NOT_POINTERS = (None, 5, True, 1.5, [], {}, ["/total"], "", "total", "/Total", "/lines/", "//", "/a/b/c/d/e",
                "/lines/0/PRIVATE", "/total\n", "\n/total", "/receipt number", "/тест", "/fiscal/PRIVATE",
                "/lines/0/product_hint/a/b/c/d", "/lines/-1/quantity", "/lines/0/product-hint", "/ ")
NORMALIZED = {"lines": [{"position": 1}, {"position": 7}], "discounts": [{"position": 3}],
              "taxes": [{"position": 5}]}


def context(entity, index, position, attribute):
    return {"entity": entity, "index": index, "position": position, "attribute": attribute}


def context_cases():
    """Source field -> (public field, context) for every branch of the agreed table."""
    cases = [("/", "/", context("receipt", None, None, None))]
    cases += [(field, field, context("geometry", None, None, attribute)) for field, attribute in GEOMETRY.items()]
    cases += [(field, field, context("receipt", None, None, attribute))
              for field, attribute in HEADER_ATTRIBUTES.items()]
    for collection, entity in (("lines", "line"), ("discounts", "discount"), ("taxes", "tax")):
        position = {"line": 1, "discount": 3, "tax": None}[entity]
        cases.append((f"/{collection}", f"/{collection}", context(entity, None, None, None)))
        cases.append((f"/{collection}/0", f"/{collection}/0", context(entity, 0, position, None)))
        cases.append((f"/{collection}/9999", f"/{collection}/9999", context(entity, 9999, None, None)))
        for name in LINE_ATTRIBUTES:
            field = f"/{collection}/0/{name}"
            cases.append((field, field, context(entity, 0, position, "name" if name == "raw_name" else name)))
    cases.append(("/lines/1/tax_rate", "/lines/1/tax_rate", context("line", 1, 7, "tax_rate")))
    cases.append(("/lines/0007/amount", "/lines/0007/amount", context("line", 7, None, "amount")))
    for field in ("/lines/1/product_hint", "/lines/1/product_hint/brand", "/lines/1/product_hint/package_quantity",
                  "/lines/1/product_hint/a/b/c"):
        cases.append((field, "/", context("line", 1, 7, "product")))
    for field in ("/lines/1/extra", "/lines/1/quantity/value", "/lines/1/tax_rate/kind", "/lines/1/product_hints",
                  "/lines/1/line_id"):
        cases.append((field, "/", context("line", 1, 7, "unknown")))
    cases.append(("/lines/55/product_hint", "/", context("line", 55, None, "product")))
    cases += [(field, "/", context("receipt", None, None, "receipt_metadata")) for field in CLOSED_RECEIPT_FIELDS]
    cases += [(field, "/", context("unknown", None, None, "unknown")) for field in NOT_POINTERS]
    return cases


def expected_severity(reason, status):
    if reason in ("operation_defaulted", "currency_inferred"):
        return "info"
    if reason in ("optional_omitted", "clipped", "cancelled"):
        return "warning"
    return "error" if status in ("needs_review", "failed") else "warning"


class PublicIssuesTableTests(SimpleTestCase):
    def one(self, issue, status="imported", normalized=None):
        result = public_issues([issue], status=status, normalized=normalized)
        self.assertEqual(len(result), 1)
        self.assertEqual(list(result[0]), ["code", "field", "message", "reason", "severity", "context"])
        self.assertEqual(list(result[0]["context"]), ["entity", "index", "position", "attribute"])
        return result[0]

    def test_reason_is_closed_list_of_fifty_values(self):
        self.assertEqual(len(PUBLIC_CODES), 28)
        self.assertEqual(len(INTERNAL_CODES), 21)
        self.assertEqual(len(set(PUBLIC_CODES + INTERNAL_CODES + ("unknown",))), 50)
        for code in PUBLIC_CODES:
            with self.subTest(code=code):
                issue = self.one({"code": code, "field": "/total"})
                self.assertEqual((issue["code"], issue["reason"]), (code, code))
        for code in INTERNAL_CODES:
            with self.subTest(code=code):
                issue = self.one({"code": code, "field": "/total"})
                self.assertEqual((issue["code"], issue["message"], issue["reason"]), ("invalid_value", INVALID, code))
        for code in UNKNOWN_CODES:
            with self.subTest(code=code):
                issue = self.one({"code": code, "field": "/total"})
                self.assertEqual((issue["code"], issue["message"], issue["reason"]),
                                 ("invalid_value", INVALID, "unknown"))
        self.assertEqual(self.one({"field": "/total"})["reason"], "unknown")

    def test_severity_table_for_every_reason_and_image_status(self):
        seen = set()
        for code in PUBLIC_CODES + INTERNAL_CODES + UNKNOWN_CODES:
            reason = code if isinstance(code, str) and code in PUBLIC_CODES + INTERNAL_CODES else "unknown"
            for status in IMAGE_STATUSES + (None, "", "PRIVATE", 5):
                with self.subTest(code=code, status=status):
                    issue = self.one({"code": code, "field": "/"}, status=status)
                    self.assertEqual(issue["severity"], expected_severity(reason, status))
                    seen.add(issue["severity"])
        self.assertEqual(seen, {"info", "warning", "error"})
        for status in IMAGE_STATUSES:
            self.assertEqual(self.one({"code": "operation_defaulted"}, status=status)["severity"], "info")
            self.assertEqual(self.one({"code": "currency_inferred"}, status=status)["severity"], "info")
            for code in ("optional_omitted", "clipped", "cancelled"):
                self.assertEqual(self.one({"code": code}, status=status)["severity"], "warning")
        self.assertEqual(self.one({"code": "total_mismatch"}, status="needs_review")["severity"], "error")
        self.assertEqual(self.one({"code": "PRIVATE"}, status="failed")["severity"], "error")
        self.assertEqual(self.one({"code": "total_mismatch"}, status="imported")["severity"], "warning")
        self.assertEqual(self.one({"code": "PRIVATE"}, status="cancelled")["severity"], "warning")

    def test_context_table_from_source_field(self):
        cases = context_cases()
        self.assertGreater(len(cases), 150)
        for source, public, expected in cases:
            with self.subTest(field=source):
                issue = self.one({"code": "invalid_value", "field": source}, normalized=NORMALIZED)
                self.assertEqual(issue["field"], public)
                self.assertEqual(issue["context"], expected)
                self.assertIn(issue["context"]["entity"], ENTITIES)
                self.assertIn(issue["context"]["attribute"], ATTRIBUTES)
        self.assertEqual(self.one({"code": "invalid_value"}, normalized=NORMALIZED)["context"],
                         context("unknown", None, None, "unknown"))

    def test_position_requires_intact_normalized_row(self):
        for value in (1, 2, 32767):
            for collection, entity in (("lines", "line"), ("discounts", "discount")):
                issue = self.one({"field": f"/{collection}/1/amount"},
                                 normalized={collection: [{}, {"position": value}]})
                self.assertEqual(issue["context"], context(entity, 1, value, "amount"))
        damaged = [None, "PRIVATE", 5, True, [], [{"position": 4}], {}, {"lines": None}, {"lines": "PRIVATE"},
                   {"lines": {"1": {"position": 4}}}, {"lines": []}, {"lines": [{"position": 4}]},
                   {"lines": [{}, None]}, {"lines": [{}, "PRIVATE"]}, {"lines": [{}, [4]]}, {"lines": [{}, {}]},
                   {"discounts": [{}, {"position": 4}]}]
        damaged += [{"lines": [{}, {"position": value}]} for value in
                    (None, True, False, 0, -1, 32768, 10 ** 30, "4", 4.0, 1.5, [4], {"position": 4})]
        for normalized in damaged:
            with self.subTest(normalized=normalized):
                for field, attribute in (("/lines/1/amount", "amount"), ("/lines/1/product_hint", "product")):
                    issue = self.one({"field": field}, normalized=normalized)
                    self.assertEqual(issue["context"], context("line", 1, None, attribute))
        # A tax total has no position even when a damaged row carries one.
        issue = self.one({"field": "/taxes/0/net"}, normalized={"taxes": [{"position": 5}]})
        self.assertEqual(issue["context"], context("tax", 0, None, "net"))

    def test_damaged_issue_lists_and_limit(self):
        for issues in (None, "PRIVATE", 5, {}, {"code": "clipped"}, True):
            self.assertEqual(public_issues(issues, status="needs_review", normalized=None), [])
        mixed = [None, "PRIVATE", 5, ["clipped"], {}, {"code": None, "field": None, "message": None}]
        expected = {"code": "invalid_value", "field": "/", "message": INVALID, "reason": "unknown",
                    "severity": "error", "context": context("unknown", None, None, "unknown")}
        self.assertEqual(public_issues(mixed, status="failed", normalized=NORMALIZED), [expected, expected])
        many = [{"code": "optional_omitted", "field": f"/lines/{index}/tax_rate"} for index in range(1001)]
        result = public_issues(many, status="imported", normalized=NORMALIZED)
        self.assertEqual(len(result), 1000)
        self.assertEqual(result[-1]["context"], context("line", 999, None, "tax_rate"))

    def test_previous_keys_are_unchanged_by_status_and_normalized(self):
        issues = [{"code": code, "field": field} for code in PUBLIC_CODES + INTERNAL_CODES + UNKNOWN_CODES[:4]
                  for field in ("/", "/total", "/lines/0/raw_name", "/receipt_number", None)]
        old = None
        for status in IMAGE_STATUSES:
            for normalized in (None, NORMALIZED, "PRIVATE"):
                projected = [{key: issue[key] for key in ("code", "field", "message")}
                             for issue in public_issues(issues, status=status, normalized=normalized)]
                old = old or projected
                self.assertEqual(projected, old)
        required = "Не удалось прочитать обязательное поле."
        self.assertEqual(old[:5], [
            {"code": "missing_required", "field": "/", "message": required},
            {"code": "missing_required", "field": "/total", "message": required},
            {"code": "missing_required", "field": "/lines/0/raw_name", "message": required},
            {"code": "missing_required", "field": "/", "message": required},
            {"code": "missing_required", "field": "/", "message": required}])
        self.assertEqual(old[-5:], [{"code": "invalid_value", "field": field, "message": INVALID}
                                    for field in ("/", "/total", "/lines/0/raw_name", "/", "/")])


def image_bytes(format="PNG", size=(10, 20)):
    stream = BytesIO()
    Image.new("RGB", size, "white").save(stream, format=format)
    return stream.getvalue()


def upload(data=None, name="receipt.png", content_type="image/png"):
    return SimpleUploadedFile(name, image_bytes() if data is None else data, content_type=content_type)


def make_photo(owner=None, **fields):
    fields.setdefault("sha256", uuid.uuid4().hex * 2)
    return SourcePhoto.objects.create(owner=owner or local_user(), original_file="originals/test/source.png", content_type="image/png",
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
    receipt = Receipt.objects.create(id=71, owner=photo.owner, store=store, currency_id="EUR", operation="sale",
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
        "store": {"address_raw": "Teststrasse 12", "country_code": "DE"}, "currency_code": "EUR", "operation": "sale",
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
            # jobs: count + page + executing lease + worker slot; the last two do not depend on the page.
            for path, queries in (("photos", 2), ("jobs", 4), ("receipt-images", 2)):
                with self.subTest(path=path, size=size), self.assertNumQueries(queries):
                    response = self.client.get(f"/api/recognition/{path}/?page_size={size}")
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(len(response.json()["results"]), size)
        with worker_slot():
            for size in (1, 5):
                with self.subTest(slot=True, size=size), self.assertNumQueries(4):
                    response = self.client.get(f"/api/recognition/jobs/?page_size={size}")
                self.assertEqual([job["executor"] for job in response.json()["results"]], [IDLE] * size)

    def test_executor_adds_one_constant_query(self):
        job = ProcessingJob.objects.create(photo=make_photo())
        make_image(job)
        for held in (False, True):
            with self.subTest(held=held), worker_slot() if held else nullcontext():
                with self.assertNumQueries(2):  # executing lease + worker slot
                    self.assertEqual(self.client.get("/api/recognition/csrf/").status_code, 200)
                with self.assertNumQueries(4):  # job + items + the same two
                    self.assertEqual(self.client.get(f"/api/recognition/jobs/{job.pk}/").status_code, 200)

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
        self.assertEqual(image["issues"], [{"code": "missing_required", "field": "/lines/0/quantity",
            "message": "Не удалось прочитать обязательное поле.", "reason": "missing_required", "severity": "error",
            "context": context("line", 0, 1, "quantity")}])
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
        self.assertEqual(response["executor"]["state"], "busy")
        self.assertFalse(response["stalled"])
        ProcessingJob.objects.filter(pk=job.pk).update(lease_expires_at=timezone.now() - timedelta(seconds=1), error_code="auth_required")
        response = self.client.get(f"/api/recognition/jobs/{job.pk}/").json()
        # No slot and no live lease: absent, though the stale heartbeat stays visible.
        self.assertFalse(response["executor"]["available"])
        self.assertEqual(response["executor"]["state"], "absent")
        self.assertEqual(response["executor"]["last_seen_at"], response["heartbeat_at"])
        self.assertIsNotNone(response["heartbeat_at"])
        self.assertTrue(response["stalled"])
        self.assertEqual(response["error"], {"code": "auth_required", "message": "Требуется вход в сервис распознавания."})
        # A restarted worker that has not recovered the stalled job yet is idle.
        with worker_slot():
            response = self.client.get(f"/api/recognition/jobs/{job.pk}/").json()
            self.assertEqual((response["executor"]["available"], response["executor"]["state"]), (True, "idle"))
            self.assertTrue(response["stalled"])

    def executors(self, job_id):
        """executor of every GET that carries one."""
        rows = self.client.get("/api/recognition/jobs/").json()["results"]
        self.assertTrue(rows)
        return [self.client.get("/api/recognition/csrf/").json()["executor"],
                *[row["executor"] for row in rows],
                self.client.get(f"/api/recognition/jobs/{job_id}/").json()["executor"]]

    @contextmanager
    def session_lock(self, cursor_factory, key):
        # A lock of another session; the API under test only reads pg_locks.
        with cursor_factory() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s, %s)", key)
            self.assertTrue(cursor.fetchone()[0], "The advisory key is occupied by a foreign session")
            yield

    def other_connection(self):
        other = connections["default"].copy(alias="executor_test_lock")
        self.addCleanup(other.close)
        return other

    def test_executor_absent_idle_and_absent_after_slot_release(self):
        self.assertEqual(self.client.get("/api/recognition/csrf/").json()["executor"], ABSENT)
        self.assertEqual(self.client.get("/api/recognition/jobs/").json()["results"], [])
        job = ProcessingJob.objects.create(photo=make_photo())
        ProcessingJob.objects.create(photo=make_photo())
        self.assertEqual(self.executors(job.pk), [ABSENT] * 4)
        with worker_slot():
            self.assertEqual(self.executors(job.pk), [IDLE] * 4)
            self.assertEqual(self.client.get(f"/api/recognition/jobs/{job.pk}/").json()["status"], "queued")
        self.assertEqual(self.executors(job.pk), [ABSENT] * 4)
        # The API read must not have taken the lock itself: a worker still starts.
        with worker_slot():
            self.assertEqual(self.executors(job.pk), [IDLE] * 4)
        self.assertEqual(self.executors(job.pk), [ABSENT] * 4)

    def test_executor_busy_with_and_without_worker_slot(self):
        for _ in range(2):
            ProcessingJob.objects.create(photo=make_photo())
        running = claim_job()
        waiting = ProcessingJob.objects.exclude(pk=running.pk).get()
        heartbeat = self.client.get(f"/api/recognition/jobs/{running.pk}/").json()["heartbeat_at"]
        self.assertIsNotNone(heartbeat)
        busy = {"available": True, "state": "busy", "last_seen_at": heartbeat}
        # The lease is alive although no session holds the slot (worker just died).
        self.assertEqual(self.executors(running.pk), [busy] * 4)
        with worker_slot():
            self.assertEqual(self.executors(running.pk), [busy] * 4)
            # A queued neighbour reports the same shared executor.
            neighbour = self.client.get(f"/api/recognition/jobs/{waiting.pk}/").json()
            self.assertEqual((neighbour["status"], neighbour["executor"]), ("queued", busy))
            requested = self.client.post(f"/api/recognition/jobs/{running.pk}/cancel/", {}, format="json")
            self.assertEqual(requested.status_code, 202, requested.content)
            self.assertEqual((requested.json()["status"], requested.json()["executor"]), ("cancel_requested", busy))
        self.assertEqual(self.executors(running.pk), [busy] * 4)

    def test_executor_busy_while_classification_batch_runs(self):
        from classification.models import ClassificationRun

        job = ProcessingJob.objects.create(photo=make_photo())
        make_image(job)
        now = timezone.now()
        queued = ClassificationRun.objects.create(trigger="manual", scope="all")
        # A queued run is not executing: the worker is still absent or idle.
        self.assertEqual(self.executors(job.pk), [ABSENT] * 3)
        ClassificationRun.objects.filter(pk=queued.pk).update(
            status="running", run_token=uuid.uuid4(), started_at=now, heartbeat_at=now,
            lease_expires_at=now + timedelta(seconds=60),
        )
        # No recognition job executes, so there is no heartbeat to show.
        busy = {"available": True, "state": "busy", "last_seen_at": None}
        self.assertEqual(self.executors(job.pk), [busy] * 3)
        for held in (False, True):
            with self.subTest(held=held), worker_slot() if held else nullcontext():
                self.assertEqual(self.executors(job.pk), [busy] * 3)
                # The same numbers of queries as without a classification run.
                with self.assertNumQueries(2):
                    self.assertEqual(self.client.get("/api/recognition/csrf/").json()["executor"], busy)
                with self.assertNumQueries(4):
                    self.assertEqual(self.client.get("/api/recognition/jobs/").json()["results"][0]["executor"], busy)
                with self.assertNumQueries(4):
                    self.assertEqual(self.client.get(f"/api/recognition/jobs/{job.pk}/").json()["executor"], busy)
        # An expired lease is a lost worker, not a busy one.
        ClassificationRun.objects.filter(pk=queued.pk).update(lease_expires_at=now - timedelta(seconds=1))
        self.assertEqual(self.executors(job.pk), [ABSENT] * 3)
        with worker_slot():
            self.assertEqual(self.executors(job.pk), [IDLE] * 3)
        # A recognition job and a batch together: the heartbeat of the job is shown.
        ClassificationRun.objects.filter(pk=queued.pk).update(lease_expires_at=now + timedelta(seconds=60))
        running = claim_job()
        heartbeat = self.client.get(f"/api/recognition/jobs/{running.pk}/").json()["heartbeat_at"]
        self.assertEqual(
            self.executors(running.pk), [{"available": True, "state": "busy", "last_seen_at": heartbeat}] * 3,
        )

    def test_executor_ignores_other_lock_key_and_other_database(self):
        job = ProcessingJob.objects.create(photo=make_photo())
        # Queue capacity key of the same namespace, as a session lock elsewhere.
        with self.session_lock(self.other_connection().cursor, (WORKER_LOCK[0], 1)):
            self.assertEqual(self.executors(job.pk), [ABSENT] * 2 + [ABSENT])
        # The worker key itself, held in the maintenance database of the same cluster.
        with self.session_lock(connection._nodb_cursor, WORKER_LOCK):
            with connection.cursor() as cursor:
                cursor.execute("SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted"
                               " AND classid = %s AND objid = %s AND objsubid = 2 AND database <>"
                               " (SELECT oid FROM pg_database WHERE datname = current_database())", WORKER_LOCK)
                # At least ours: a real worker of a neighbouring database may hold its own.
                self.assertGreaterEqual(cursor.fetchone()[0], 1)
            self.assertEqual(self.executors(job.pk), [ABSENT] * 3)
            with worker_slot():
                self.assertEqual(self.executors(job.pk), [IDLE] * 3)
            self.assertEqual(self.executors(job.pk), [ABSENT] * 3)

    def test_upload_and_retry_report_idle_while_slot_is_held(self):
        absent = self.post_photo(image_bytes(size=(11, 20)))
        self.assertEqual(absent.status_code, 202, absent.content)
        self.assertEqual(absent.json()["job"]["executor"], ABSENT)
        with worker_slot():
            created = self.post_photo()
            self.assertEqual(created.status_code, 202, created.content)
            job = created.json()["job"]
            self.assertEqual((job["status"], job["executor"]), ("queued", IDLE))
            replay = self.post_photo()
            self.assertEqual((replay.status_code, replay.json()["job"]["executor"]), (200, IDLE))
            path = "/api/recognition/jobs/%d/" % job["id"]
            cancelled = self.client.post(path + "cancel/", {}, format="json")
            self.assertEqual((cancelled.status_code, cancelled.json()["executor"]), (200, IDLE))
            retry = self.client.post(path + "retry/", {}, format="json")
            self.assertEqual(retry.status_code, 202, retry.content)
            self.assertEqual((retry.json()["status"], retry.json()["executor"]), ("queued", IDLE))
        self.assertEqual(self.client.get(path).json()["executor"], ABSENT)

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
        self.assertEqual(response.json()["issues"], [{"code": "invalid_value", "field": "/", "message": "Значение не прошло проверку.",
            "reason": "unknown", "severity": "error", "context": context("unknown", None, None, "unknown")}])

    def image_views(self, image):
        """The same image as it appears in the list and in the detail response."""
        rows = self.client.get(f"/api/recognition/receipt-images/?job={image.job_id}&page_size=200")
        detail = self.client.get(f"/api/recognition/receipt-images/{image.pk}/")
        self.assertEqual(rows.status_code, 200, rows.content)
        self.assertEqual(detail.status_code, 200, detail.content)
        row = next(value for value in rows.json()["results"] if value["id"] == image.pk)
        self.assertEqual(row["issues"], detail.json()["issues"])
        return row, detail.json(), rows.content.decode() + detail.content.decode()

    def test_issue_table_over_http_list_and_detail(self):
        cases = context_cases()
        codes = (PUBLIC_CODES + INTERNAL_CODES + UNKNOWN_CODES) * 4
        self.assertGreaterEqual(len(codes), len(cases))
        for status in ("imported", "needs_review", "failed"):
            job = ProcessingJob.objects.create(photo=make_photo())
            image = make_image(job, status=status, normalized_result=NORMALIZED,
                issues=[{"code": code, "field": field, "message": "PRIVATE"}
                        for code, (field, _, _) in zip(codes, cases)])
            row, detail, text = self.image_views(image)
            self.assertEqual(len(detail["issues"]), len(cases))
            self.assertNotIn("PRIVATE", text)
            for issue, code, (field, public, expected) in zip(detail["issues"], codes, cases):
                known = isinstance(code, str) and code in PUBLIC_CODES + INTERNAL_CODES
                reason = code if known else "unknown"
                public_code = code if known and code in PUBLIC_CODES else "invalid_value"
                with self.subTest(status=status, code=code, field=field):
                    self.assertEqual(issue, {"code": public_code, "field": public,
                        "message": issue["message"], "reason": reason,
                        "severity": expected_severity(reason, status), "context": expected})
                    self.assertEqual(issue["message"] == INVALID, public_code == "invalid_value")
            # normalized_result stays a needs_review-only projection.
            self.assertEqual(detail["normalized_result"] is None, status != "needs_review")
            self.assertEqual(row["normalized_result"] is None, status != "needs_review")

    def test_replica_of_29_optional_omissions_on_imported_image(self):
        _, job, receipt, _ = public_data()
        job.images.filter(status="needs_review").delete()
        ProcessingJob.objects.filter(pk=job.pk).update(status="succeeded", review_count=0, completed_count=1,
                                                       detected_count=1)
        issues = [{"code": "optional_omitted", "field": f"/lines/{i}/tax_rate", "message": "PRIVATE"} for i in range(25)]
        issues += [{"code": "optional_omitted", "field": f"/taxes/{i}", "message": "PRIVATE"} for i in range(2)]
        issues += [{"code": "optional_omitted", "field": "/receipt_number", "message": "PRIVATE"},
                   {"code": "optional_omitted", "field": "/fiscal/signature", "message": "PRIVATE"}]
        image = receipt.recognition_images.get()
        image.issues = issues
        image.normalized_result = {
            "receipt_number": None, "fiscal": {"signature": None}, "raw_text": "PRIVATE TEXT",
            "lines": [{"position": i + 1, "raw_name": f"TESTARTIKEL {i + 1:02d}", "tax_code": "A", "tax_rate": None}
                      for i in range(25)],
            "taxes": [{"tax_code": code, "net": "1.00", "tax": "0.07", "gross": None} for code in "AB"]}
        image.save()
        row, detail, text = self.image_views(image)
        expected = [{"code": "invalid_value", "field": f"/lines/{i}/tax_rate", "message": INVALID,
                     "reason": "optional_omitted", "severity": "warning",
                     "context": context("line", i, i + 1, "tax_rate")} for i in range(25)]
        expected += [{"code": "invalid_value", "field": f"/taxes/{i}", "message": INVALID,
                      "reason": "optional_omitted", "severity": "warning",
                      "context": context("tax", i, None, None)} for i in range(2)]
        expected += [{"code": "invalid_value", "field": "/", "message": INVALID,
                      "reason": "optional_omitted", "severity": "warning",
                      "context": context("receipt", None, None, "receipt_metadata")}] * 2
        self.assertEqual(len(detail["issues"]), 29)
        self.assertEqual(detail["issues"], expected)
        self.assertEqual((row["status"], detail["status"]), ("imported", "imported"))
        self.assertIsNone(detail["normalized_result"])
        self.assertEqual(detail["receipt_id"], receipt.pk)
        self.assertNotIn("PRIVATE", text)
        for hidden in ("receipt_number", "fiscal", "signature", "TESTARTIKEL"):
            self.assertNotIn(hidden, text)
        # Notices of a successful image do not change the job or the receipt.
        public_job = self.client.get(f"/api/recognition/jobs/{job.pk}/").json()
        self.assertEqual(public_job["status"], "succeeded")
        self.assertFalse(public_job["review_required"])
        self.assertEqual(public_job["progress"]["review"], 0)
        self.assertFalse(self.client.get(f"/api/receipts/{receipt.pk}/").json()["review_required"])

    def test_poisoned_issues_do_not_leak_through_new_keys(self):
        poison = [
            {"code": "PRIVATE_CODE", "field": "/receipt_number", "message": "PRIVATE 4711"},
            {"code": "secret_code_4711", "field": "/fiscal/PRIVATE", "message": "PRIVATE"},
            {"code": "optional_omitted", "field": "/iban_de4711", "message": "PRIVATE", "line_id": 4711001,
             "note": "PRIVATE NOTE", "raw_text": "PRIVATE TEXT", "value": "4711"},
            {"code": "merchant_tax_id_invalid", "field": "/merchant/tax_id", "message": "PRIVATE 4711"},
            {"code": "merchant_conflict", "field": "/merchant/legal_name", "message": "PRIVATE"},
            {"code": "optional_omitted", "field": "/shift_number"}, {"code": "optional_omitted", "field": "/register_code"},
            {"code": "product_conflict", "field": "/lines/0/product_hint/PRIVATE"},
            {"code": "product_conflict", "field": "/lines/0/product_hint/secret4711"},
            {"code": "receipt_line_conflict", "field": "/lines/0/secret4711/line_id"},
            {"code": "import_failed", "field": "/", "message": "Traceback PRIVATE: psycopg.OperationalError 4711"},
            {"code": "clipped", "field": "/clipped", "reason": "PRIVATE", "severity": "PRIVATE",
             "context": {"entity": "PRIVATE", "index": 4711, "position": 4711, "attribute": "secret4711"}},
            {"code": {"secret": "PRIVATE"}, "field": {"secret4711": "PRIVATE"}, "message": {"secret": "PRIVATE"}},
            {"code": ["PRIVATE"], "field": ["/secret4711"], "message": ["PRIVATE"]},
            {"code": 4711, "field": 4711, "message": 4711},
            {"PRIVATE": "PRIVATE", "secret4711": "/total"},
        ]
        job = ProcessingJob.objects.create(photo=make_photo(id=1, sha256="c" * 64))
        image = make_image(job, id=1, status="needs_review", issues=poison, normalized_result={
            "receipt_number": "PRIVATE 4711", "fiscal": {"signature": "PRIVATE"}, "raw_text": "PRIVATE",
            "merchant": {"tax_id": "4711", "legal_name": "PRIVATE"}, "fields": [{"note": "PRIVATE"}],
            "warnings": ["PRIVATE"], "lines": [{"position": 2, "line_id": 4711002, "raw_name": "ТЕСТ",
                                                "product_hint": {"secret4711": "PRIVATE"}}]})
        ReceiptImage.objects.filter(pk=image.pk).update(created_at=NOW)
        row, detail, text = self.image_views(image)
        self.assertEqual(len(detail["issues"]), len(poison))
        for hidden in ("PRIVATE", "4711", "secret", "iban", "receipt_number", "shift_number", "register_code",
                       "fiscal", "/tax_id", '"tax_id"', "legal_name", "product_hint", "line_id", "raw_text", "note",
                       "Traceback", "psycopg", "warnings", '"fields"', '"value"'):
            self.assertNotIn(hidden, text)
        # The only place the words "tax_id" may occur is the agreed closed reason itself.
        self.assertEqual(text.count("tax_id"), text.count('"reason":"merchant_tax_id_invalid"'))
        reasons = set(PUBLIC_CODES + INTERNAL_CODES + ("unknown",))
        for issue in detail["issues"]:
            self.assertEqual(set(issue), {"code", "field", "message", "reason", "severity", "context"})
            self.assertEqual(set(issue["context"]), {"entity", "index", "position", "attribute"})
            self.assertIn(issue["code"], PUBLIC_CODES)
            self.assertIn(issue["reason"], reasons)
            self.assertIn(issue["severity"], ("info", "warning", "error"))
            self.assertIn(issue["context"]["entity"], ENTITIES)
            self.assertIn(issue["context"]["attribute"], ATTRIBUTES)
            for key, low, high in (("index", 0, 9999), ("position", 1, 32767)):
                value = issue["context"][key]
                self.assertTrue(value is None or (type(value) is int and low <= value <= high), value)
        contexts = [issue["context"] for issue in detail["issues"]]
        metadata = context("receipt", None, None, "receipt_metadata")
        self.assertEqual(contexts[0], metadata)
        self.assertEqual(contexts[2:7], [metadata] * 5)
        self.assertEqual(contexts[8], context("line", 0, 2, "product"))
        self.assertEqual(contexts[9], context("line", 0, 2, "unknown"))
        self.assertEqual(contexts[10], context("receipt", None, None, None))
        self.assertEqual(contexts[11], context("geometry", None, None, "clipped"))
        self.assertEqual([detail["issues"][11]["reason"], detail["issues"][11]["severity"]], ["clipped", "warning"])
        self.assertEqual([issue["reason"] for issue in detail["issues"][:5]],
                         ["unknown", "unknown", "optional_omitted", "merchant_tax_id_invalid", "merchant_conflict"])
        for index in (1, 7, 12, 13, 14, 15):
            self.assertEqual(contexts[index], context("unknown", None, None, "unknown"))

    def test_damaged_issue_data_returns_200(self):
        issues = [{"code": "optional_omitted", "field": "/lines/3/tax_rate"},
                  {"code": "optional_omitted", "field": "/discounts/0/amount"},
                  {"code": None, "field": None}, {"code": 5, "field": 5}, {"code": [], "field": {}},
                  "PRIVATE", None, 5, ["PRIVATE"]]
        variants = [None, "PRIVATE", [1, 2], 5, {"lines": "PRIVATE", "discounts": None},
                    {"lines": [None, 1, "x"], "discounts": [[]]},
                    {"lines": [{}, {}, {}, {"position": "PRIVATE"}], "discounts": [{"position": True}]},
                    {"lines": [{}, {}, {}, {"position": 40000}], "discounts": [{"position": 0}]}]
        for status, normalized in ((status, value) for status in ("imported", "needs_review", "failed")
                                   for value in variants):
            job = ProcessingJob.objects.create(photo=make_photo())
            image = make_image(job, status=status, normalized_result=normalized, issues=issues)
            with self.subTest(status=status, normalized=normalized):
                row, detail, text = self.image_views(image)
                self.assertNotIn("PRIVATE", text)
                unknown = "error" if status != "imported" else "warning"
                self.assertEqual(detail["issues"], [
                    {"code": "invalid_value", "field": "/lines/3/tax_rate", "message": INVALID,
                     "reason": "optional_omitted", "severity": "warning", "context": context("line", 3, None, "tax_rate")},
                    {"code": "invalid_value", "field": "/discounts/0/amount", "message": INVALID,
                     "reason": "optional_omitted", "severity": "warning",
                     "context": context("discount", 0, None, "amount")},
                    *[{"code": "invalid_value", "field": "/", "message": INVALID, "reason": "unknown",
                       "severity": unknown, "context": context("unknown", None, None, "unknown")}] * 3])
        for damaged in ("PRIVATE", 5, {"code": "clipped"}):
            image = make_image(job, position=2, status="failed", issues=[])
            # The column normally holds a list; write past validation as a damaged row would.
            ReceiptImage.objects.filter(pk=image.pk).update(issues=damaged)
            with self.subTest(issues=damaged):
                row, detail, text = self.image_views(image)
                self.assertEqual(detail["issues"], [])
                self.assertNotIn("PRIVATE", text)
            image.delete()

    def test_thousand_issues_keep_query_counts_and_limit(self):
        lines = [{"position": index + 1} for index in range(1200)]
        issues = [{"code": "optional_omitted", "field": f"/lines/{index}/tax_rate"} for index in range(1200)]
        images = [make_image(ProcessingJob.objects.create(photo=make_photo()), status="imported",
                             normalized_result={"lines": lines}, issues=issues) for _ in range(3)]
        for size in (1, 3):
            with self.subTest(size=size), self.assertNumQueries(2):
                response = self.client.get(f"/api/recognition/receipt-images/?page_size={size}")
                self.assertEqual(response.status_code, 200)
            self.assertEqual([len(value["issues"]) for value in response.json()["results"]], [1000] * size)
        with self.assertNumQueries(1):
            response = self.client.get(f"/api/recognition/receipt-images/{images[0].pk}/")
            self.assertEqual(response.status_code, 200)
        value = response.json()["issues"]
        self.assertEqual(len(value), 1000)
        self.assertEqual(value[999], {"code": "invalid_value", "field": "/lines/999/tax_rate", "message": INVALID,
            "reason": "optional_omitted", "severity": "warning", "context": context("line", 999, 1000, "tax_rate")})

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
