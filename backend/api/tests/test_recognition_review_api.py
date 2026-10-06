"""HTTP contract of ``POST /api/recognition/receipt-images/{id}/confirm/``."""
import json
import tempfile
from unittest.mock import patch

from django.db import OperationalError
from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.test_recognition_api import NOW, PUBLIC, public_data
from receipts.models import Receipt, ReceiptLine
from recognition.models import ProcessingJob, ReceiptImage
from recognition.tests.import_fixtures import live_image
from recognition.tests.test_review import (
    body_of, domain_counts, finished_job, fixed_body, image_state, missing_quantity, review_image, stored,
    wrong_total,
)
from stores.models import Merchant, Store

IMAGE_KEYS = ["id", "photo_id", "job_id", "position", "created_at", "status", "receipt_id", "receipt_deleted",
              "image_url", "width", "height", "bbox", "clipped", "issues", "normalized_result", "confirmed_at"]
JOB_KEYS = ["id", "photo_id", "retry_of", "status", "stage", "version", "created_at", "started_at", "finished_at",
            "cancel_requested_at", "heartbeat_at", "stalled", "executor", "progress", "review_required", "error",
            "actions", "items_count", "items"]
ISSUE_KEYS = ["code", "field", "message", "reason", "severity", "context"]
MESSAGES = {
    "review_unavailable": "Подтверждение для этой вырезки недоступно.",
    "review_resolved": "Результат уже подтверждён.",
    "review_busy": "Данные сейчас изменяются. Повторите позже.",
    "review_invalid": "Исправленные данные не прошли проверку.",
    "job_active": "Для фото уже есть активное задание.",
}


def private_payload():
    """``inconsistent_total`` whose every closed fact is marked: none may reach a response."""
    data = wrong_total()
    data["merchant"]["legal_name"] = "PRIVATE LEGAL GmbH"
    data.update(receipt_number="PRIVATE-NUMBER", shift_number="PRIVATE-SHIFT", register_code="PRIVATE-REGISTER",
                raw_text="PRIVATE TEXT\n", warnings=["PRIVATE WARNING"])
    data["fiscal"].update(register_serial="PRIVATE-SERIAL", tse_transaction="PRIVATE-TSE", signature="PRIVATE-SIGN")
    data["lines"][0].update(store_item_code="PRIVATE-CODE")
    data["lines"][0]["product_hint"]["brand"] = "PRIVATE BRAND"
    data["fields"] += [{"path": path, "status": "observed", "confidence": 1, "note": "PRIVATE NOTE"} for path in (
        "/fiscal/signature", "/lines/0/store_item_code", "/lines/0/product_hint/brand")]
    return data


class ReviewApiCase(TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="checkist-review-test-")
        self.addCleanup(directory.cleanup)
        settings = override_settings(MEDIA_ROOT=directory.name)
        settings.enable()
        self.addCleanup(settings.disable)
        self.client = APIClient(enforce_csrf_checks=True)
        token = self.client.get("/api/recognition/csrf/").json()["csrf_token"]
        self.client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")

    def url(self, image):
        return f"/api/recognition/receipt-images/{getattr(image, 'pk', image)}/confirm/"

    def post(self, image, body, **extra):
        if isinstance(body, (bytes, str)):
            return self.client.post(self.url(image), body, content_type="application/json", **extra)
        return self.client.post(self.url(image), body, format="json", **extra)

    def error(self, response, status, code, fields=None):
        self.assertEqual(response.status_code, status, response.content)
        value = response.json()
        self.assertEqual(value["error"]["code"], code)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response["Content-Type"], "application/json")
        if fields is None:
            self.assertEqual(set(value["error"]), {"code", "message"})
        else:
            self.assertEqual(set(value["error"]["fields"]), set(fields))
        if code in MESSAGES:
            self.assertEqual(value["error"]["message"], MESSAGES[code])
        self.assertEqual(set(value), {"error", "issues"} if code == "review_invalid" else {"error"})
        return value


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class ConfirmApiTests(ReviewApiCase):
    def test_success_returns_image_and_job_details(self):
        job = finished_job(detected_count=2, completed_count=2, imported_count=0, review_count=2)
        first = review_image(private_payload(), job=job)
        second = review_image(wrong_total(2), job=job, position=2)
        response = self.post(first, fixed_body())
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        value = response.json()
        self.assertEqual(list(value), ["image", "job"])
        image, receipt = value["image"], Receipt.objects.get()
        self.assertEqual(list(image), IMAGE_KEYS + ["quad", "rotation_degrees"])
        self.assertEqual((image["id"], image["status"], image["receipt_id"], image["receipt_deleted"]),
                         (first.pk, "imported", receipt.pk, False))
        self.assertIsNone(image["normalized_result"])
        self.assertEqual(image["issues"], [])
        self.assertRegex(image["confirmed_at"], r"\A2[0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\Z")
        self.assertEqual(image, self.client.get(f"/api/recognition/receipt-images/{first.pk}/").json())
        self.assertEqual(list(value["job"]), JOB_KEYS)
        self.assertEqual(value["job"], self.client.get(f"/api/recognition/jobs/{job.pk}/").json())
        self.assertEqual((value["job"]["status"], value["job"]["version"], value["job"]["review_required"]),
                         ("partial_succeeded", 2, True))
        self.assertEqual(value["job"]["progress"], {"detected": 2, "current_position": None, "completed": 2,
                                                    "imported": 1, "reused": 0, "review": 1, "failed": 0, "cancelled": 0})
        self.assertEqual(value["job"]["actions"], {"can_cancel": False, "can_retry": True})
        self.assertEqual(value["job"]["items"], [
            {"image_id": first.pk, "position": 1, "status": "imported", "receipt_id": receipt.pk},
            {"image_id": second.pk, "position": 2, "status": "needs_review", "receipt_id": None}])

        # Criterion 2: the last crop confirmed -> the job succeeded and offers no retry.
        done = self.post(second, fixed_body(2)).json()
        self.assertEqual((done["job"]["status"], done["job"]["version"], done["job"]["review_required"]),
                         ("succeeded", 3, False))
        self.assertEqual(done["job"]["actions"], {"can_cancel": False, "can_retry": False})
        self.assertEqual(done["job"]["progress"]["imported"], 2)
        self.assertEqual(done["job"]["progress"]["review"], 0)
        self.error(self.client.post(f"/api/recognition/jobs/{job.pk}/retry/", {}, format="json"), 409, "retry_not_allowed")

        saved = self.client.get(f"/api/receipts/{receipt.pk}/").json()
        self.assertEqual((saved["total"], saved["origin"], saved["review_required"], saved["lines_count"],
                          saved["receipt_images_count"]), ("4.42", "recognized", False, 4, 1))
        self.assertEqual(self.client.get(f"/api/receipts/{receipt.pk}/lines/").json()["count"], 4)
        self.assertEqual(self.client.get(f"/api/receipts/{receipt.pk}/discounts/").json()["count"], 1)
        self.assertEqual(self.client.get(f"/api/receipts/{receipt.pk}/taxes/").json()["count"], 2)

    def test_no_response_carries_closed_facts(self):
        image = review_image(private_payload())
        responses = [self.post(image, body_of(private_payload())), self.post(image, fixed_body(total=4.42)),
                     self.post(image, fixed_body())]
        self.assertEqual([response.status_code for response in responses], [409, 400, 200])
        receipt = Receipt.objects.get()
        self.assertEqual(receipt.receipt_number, "PRIVATE-NUMBER")
        self.assertEqual(ReceiptLine.objects.get(receipt=receipt, position=1).store_item_code, "PRIVATE-CODE")
        responses += [self.post(image, fixed_body()), self.post(image, fixed_body(total="9.99")),
                      self.client.get("/api/recognition/receipt-images/"),
                      self.client.get(f"/api/recognition/receipt-images/{image.pk}/"),
                      self.client.get(f"/api/recognition/jobs/{image.job_id}/"),
                      self.client.get(f"/api/receipts/{receipt.pk}/")]
        self.assertEqual([response.status_code for response in responses[3:]], [200, 409, 200, 200, 200, 200])
        for response in responses:
            text = response.content.decode()
            self.assertNotIn("PRIVATE", text)
            for name in ("raw_text", "fiscal", "receipt_number", "shift_number", "register_code", "legal_name",
                         "tax_id", "product_hint", "request_sha256", "previous_issues", "outcome_snapshot",
                         "result", "extra", "warnings"):
                self.assertNotIn(f'"{name}"', text)

    def test_review_invalid_carries_issues_by_request_indexes(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()
        body = fixed_body()
        body["lines"] = [body["lines"][1], body["lines"][0], *body["lines"][2:]]
        body["lines"][1].update(position=9, amount="9.99")
        body["discounts"][0]["line_position"] = 9
        value = self.error(self.post(image, body), 409, "review_invalid")
        for issue in value["issues"]:
            self.assertEqual(list(issue), ISSUE_KEYS)
        self.assertEqual(value["issues"], [
            {"code": "total_mismatch", "field": "/lines/1/amount", "message": "Сумма чека не совпадает с суммой позиций.",
             "reason": "total_mismatch", "severity": "error",
             "context": {"entity": "line", "index": 1, "position": 9, "attribute": "amount"}},
            {"code": "total_mismatch", "field": "/total", "message": "Сумма чека не совпадает с суммой позиций.",
             "reason": "total_mismatch", "severity": "error",
             "context": {"entity": "receipt", "index": None, "position": None, "attribute": "total"}},
        ])
        self.assertEqual((image_state(image), domain_counts()), (before, counts))
        self.assertEqual(self.client.get(f"/api/recognition/receipt-images/{image.pk}/").json()["status"], "needs_review")
        # A closed pointer stays "/" with receipt_metadata; nothing names the fact.
        Receipt.objects.all().delete()
        self.post(review_image(), fixed_body())
        data = wrong_total()
        data["fiscal"]["tse_transaction"] = "11111"
        value = self.error(self.post(review_image(data), fixed_body()), 409, "review_invalid")
        self.assertEqual(value["issues"], [{
            "code": "identity_conflict", "field": "/", "message": "Данные идентичности чека противоречат друг другу.",
            "reason": "identity_conflict", "severity": "error",
            "context": {"entity": "receipt", "index": None, "position": None, "attribute": "receipt_metadata"}}])

    def test_confirmation_notices_are_the_only_issues_and_point_into_the_request(self):
        image = review_image(missing_quantity(), issues=[
            {"code": "missing_required", "field": "/lines/0/quantity", "message": "PRIVATE"}])
        body = body_of(missing_quantity(), operation=None)
        moved = body["lines"].pop(0)
        moved.update(position=12, quantity="2.000", unit_price="1.2900",
                     tax_rate={"kind": "vat", "rate": "7.00"})
        body["lines"].append(moved)
        body["discounts"][0]["line_position"] = 12
        body["taxes"][1]["tax"] = "0.99"  # 0.87 + 0.99 is not the printed gross: the table is dropped
        body["taxes"][1]["gross"] = "1.04"
        value = self.post(image, body).json()
        self.assertEqual(value["image"]["status"], "imported")
        self.assertEqual([(issue["reason"], issue["severity"], issue["field"], issue["context"]["index"])
                          for issue in value["image"]["issues"]], [
            ("operation_defaulted", "info", "/operation", None), ("optional_omitted", "warning", "/taxes/1", 1),
            ("optional_omitted", "warning", "/taxes", None)])
        self.assertEqual(self.client.get(f"/api/receipts/{value['image']['receipt_id']}/taxes/").json()["count"], 0)
        # Context positions of a confirmed crop come from the corrected DTO, not the provider one.
        ReceiptImage.objects.filter(pk=image.pk).update(issues=[{"code": "product_conflict", "field": "/lines/3/product_hint"}])
        issue = self.client.get(f"/api/recognition/receipt-images/{image.pk}/").json()["issues"][0]
        self.assertEqual(issue["context"], {"entity": "line", "index": 3, "position": 12, "attribute": "product"})

    def test_existing_receipt_is_linked_with_conflict_notices(self):
        first = self.post(review_image(), fixed_body()).json()
        body = fixed_body(operation="refund")
        body["lines"][1]["name"] = "BIRNE"
        value = self.post(review_image(), body).json()
        self.assertEqual((value["image"]["status"], value["image"]["receipt_id"]),
                         ("reused", first["image"]["receipt_id"]))
        self.assertEqual(value["job"]["progress"]["reused"], 1)
        self.assertEqual({(issue["reason"], issue["field"], issue["severity"]) for issue in value["image"]["issues"]},
                         {("receipt_conflict", "/operation", "warning"), ("receipt_line_conflict", "/lines/1", "warning")})
        self.assertIsNotNone(value["image"]["confirmed_at"])
        saved = self.client.get(f"/api/receipts/{first['image']['receipt_id']}/").json()
        self.assertEqual((saved["operation"], saved["receipt_images_count"]), ("sale", 2))
        names = [line["name"] for line in self.client.get(saved["lines_url"]).json()["results"]]
        self.assertEqual(names, ["MILCH 1 L", "APFEL", "MINERALWASSER 0.5 L", "PFAND zu MINERALWASSER"])
        self.assertEqual(Receipt.objects.count(), 1)

    def test_chosen_store(self):
        merchant = Merchant.objects.create(country_id="DE", legal_name="ANDERER MARKT AG", brand_name="ANDERER")
        store = Store.objects.create(merchant=merchant, country_id="DE", address_raw="Hauptweg 5", timezone="Europe/Berlin")
        image = review_image()
        self.error(self.post(image, fixed_body(store_id=store.pk + 100)), 400, "invalid_parameter", ["receipt.store_id"])
        value = self.post(image, fixed_body(store_id=store.pk, store_name=None, address=None)).json()
        self.assertEqual(Receipt.objects.get(pk=value["image"]["receipt_id"]).store_id, store.pk)
        self.assertEqual(Store.objects.count(), 1)

    def test_replay_of_the_same_body_and_another_body(self):
        image = review_image()
        first = self.post(image, fixed_body())
        after, counts = image_state(image), domain_counts()
        reordered = {key: fixed_body(country="de")[key] for key in ("taxes", "discounts", "lines", "receipt")}
        for body, headers in ((fixed_body(), {}), (reordered, {"HTTP_IDEMPOTENCY_KEY": "another-key"}),
                              (json.dumps(fixed_body(), indent=3), {})):
            replay = self.post(image, body, **headers)
            self.assertEqual(replay.status_code, 200, replay.content)
            self.assertEqual(replay.json(), first.json())
            self.assertEqual((image_state(image), domain_counts()), (after, counts))
        self.error(self.post(image, fixed_body(operation=None)), 409, "review_resolved")
        self.error(self.post(image, body_of(wrong_total())), 409, "review_resolved")
        self.assertEqual((image_state(image), domain_counts()), (after, counts))
        Receipt.objects.all().delete()
        self.error(self.post(image, fixed_body()), 409, "review_unavailable")
        deleted = self.client.get(f"/api/recognition/receipt-images/{image.pk}/").json()
        self.assertEqual((deleted["receipt_deleted"], deleted["receipt_id"], deleted["status"]), (True, None, "imported"))
        self.assertIsNotNone(deleted["confirmed_at"])

    def test_state_conflicts(self):
        counts = domain_counts()
        for status in ("pending", "running", "imported", "reused", "updated", "failed", "cancelled"):
            image = review_image(status=status, job=finished_job(status="failed"))
            before = image_state(image)
            with self.subTest(status=status):
                self.error(self.post(image, fixed_body()), 409, "review_unavailable")
                self.assertEqual((image_state(image), domain_counts()), (before, counts))
        active, job = live_image(status="needs_review", normalized_result=stored(wrong_total()))
        before = image_state(active)
        # The state is checked before the import rules: an invalid total is still job_active.
        for body in (fixed_body(), body_of(wrong_total())):
            self.error(self.post(active, body), 409, "job_active")
        self.assertEqual((image_state(active), domain_counts()), (before, counts))

    def test_busy_mutex_and_database_errors(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()
        busy = OperationalError("PRIVATE DSN")
        busy.__cause__ = type("Cause", (Exception,), {"sqlstate": "55P03"})()
        with patch("recognition.review._import_domain", side_effect=busy):
            response = self.post(image, fixed_body())
            self.error(response, 409, "review_busy")
            self.assertNotIn("PRIVATE", response.content.decode())
        with patch("api.views.recognition_review.review.confirm", side_effect=OperationalError("PRIVATE DSN")):
            response = self.post(image, fixed_body())
            self.error(response, 503, "database_unavailable")
            self.assertNotIn("PRIVATE", response.content.decode())
        self.client.raise_request_exception = False
        with patch("recognition.review._import_domain", side_effect=RuntimeError("PRIVATE")):
            response = self.post(image, fixed_body())
            self.error(response, 500, "internal_error")
            self.assertNotIn("PRIVATE", response.content.decode())
        self.assertEqual((image_state(image), domain_counts()), (before, counts))

    def test_request_structure_is_invalid_request(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()
        good = json.dumps(fixed_body())
        limit = 1024 * 1024
        bodies = [b"", b"[]", b"null", b'"x"', b"5", b"{", b"\xff", good.encode("utf-16"),
                  good.replace('"total": "4.42"', '"total": NaN'), good.replace('"total": "4.42"', '"total": Infinity'),
                  good.replace('"receipt": {', '"receipt": {"total": "1.00", ', 1),  # repeated key, nested
                  good[:-1] + ', "lines": []}', good + " " * (limit + 1 - len(good.encode())),
                  b"[" * 100000]
        for path in ((), ("receipt",), ("lines", 0), ("lines", 3, "tax_rate"), ("discounts", 0), ("taxes", 0),
                     ("taxes", 1, "tax_rate")):
            body = fixed_body()
            target = body
            for key in path:
                target = target[key]
            target["product_id"] = 1
            bodies.append(json.dumps(body))
        for key in ("discount_total", "receipt_number", "fiscal", "raw_text", "discard_identifiers"):
            bodies.append(json.dumps(fixed_body(**{key: None})))
        for body in bodies:
            with self.subTest(body=body[:60]):
                self.error(self.post(image, body), 400, "invalid_request")
        # The structure is judged before the crop is looked up.
        self.error(self.post(999999, '{"x": 1}'), 400, "invalid_request")
        slash = self.client.post(self.url(image)[:-1], fixed_body(), format="json")
        self.assertEqual((slash.status_code, slash.json()["error"]["code"]), (400, "invalid_request"))
        self.assertEqual((image_state(image), domain_counts()), (before, counts))
        exact = good + " " * (limit - len(good.encode()))
        self.assertEqual(len(exact.encode()), limit)
        self.assertEqual(self.post(image, exact).status_code, 200)

    def test_field_values_are_invalid_parameter_with_dotted_paths(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()
        body = fixed_body(total=4.42, currency="ZZZ", country="de")
        body["lines"][0]["quantity"] = 2
        body["lines"][1]["source_position"] = 77
        body["lines"][3]["parent_position"] = 4
        body["taxes"][1]["tax_rate"]["rate"] = None
        body["discounts"][0]["amount"] = "0.00"
        del body["receipt"]["operation"]
        value = self.error(self.post(image, body), 400, "invalid_parameter", [
            "receipt.total", "receipt.currency", "receipt.operation", "lines.0.quantity", "lines.1.source_position",
            "lines.3.parent_position", "taxes.1.tax_rate.rate", "discounts.0.amount"])
        self.assertEqual(value["error"]["message"], "Некорректные параметры запроса.")
        self.assertEqual(value["error"]["fields"]["receipt.total"], ["Неверный тип значения."])
        self.assertEqual(value["error"]["fields"]["receipt.operation"], ["Обязательное поле."])
        self.assertEqual(value["error"]["fields"]["receipt.currency"], ["Значение не найдено."])
        self.assertEqual(value["error"]["fields"]["lines.3.parent_position"],
                         ["Ссылка на отсутствующую или неподходящую позицию."])
        for messages in value["error"]["fields"].values():
            self.assertEqual(len(messages), 1)
        self.error(self.post(image, {}), 400, "invalid_parameter", ["receipt", "lines", "discounts", "taxes"])
        # Money and quantities are strings only: a JSON number is refused, never rounded.
        for path, number in ((("receipt", "total"), 4.42), (("lines", 0, "amount"), 2.58),
                             (("lines", 0, "unit_price"), 1.29), (("discounts", 0, "amount"), 0.2),
                             (("taxes", 0, "net"), 3.16), (("taxes", 0, "tax_rate", "rate"), 7)):
            body = fixed_body()
            target = body
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = number
            name = ".".join(str(part) for part in path)
            self.assertEqual(self.error(self.post(image, body), 400, "invalid_parameter", [name])
                             ["error"]["fields"][name], ["Неверный тип значения."])
        self.assertEqual((image_state(image), domain_counts()), (before, counts))

    def test_order_of_checks(self):
        done = review_image(status="imported", job=finished_job(status="failed"))
        bad_values = fixed_body(total=1)
        # existence before values; values before state; state before the import rules.
        self.error(self.post(999999, bad_values), 404, "not_found")
        self.error(self.post(done, bad_values), 400, "invalid_parameter", ["receipt.total"])
        self.error(self.post(done, body_of(wrong_total())), 409, "review_unavailable")
        anonymous = APIClient(enforce_csrf_checks=True)
        # access and CSRF before everything, including the body and the method.
        for call in (lambda: anonymous.post(self.url(999999), b"{", content_type="application/json"),
                     lambda: anonymous.put(self.url(done), {}, format="json"),
                     lambda: anonymous.post(self.url(done), "x", content_type="text/plain")):
            self.error(call(), 403, "csrf_failed")

    def test_access_csrf_method_media_type_and_not_found(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()
        for settings in ({"DEBUG": False}, {"ALLOW_LOCAL_RECOGNITION_API": False}):
            with override_settings(**settings):
                self.error(self.post(image, fixed_body()), 403, "permission_denied")
        for peer in ("192.0.2.1", "", "bad"):
            self.error(self.post(image, fixed_body(), REMOTE_ADDR=peer, HTTP_X_FORWARDED_FOR="127.0.0.1"),
                       403, "permission_denied")
        anonymous = APIClient(enforce_csrf_checks=True)
        self.error(anonymous.post(self.url(image), fixed_body(), format="json"), 403, "csrf_failed")
        token = self.client.get("/api/recognition/csrf/").json()["csrf_token"]
        for headers in ({"HTTP_X_CSRFTOKEN": "wrong", "HTTP_ORIGIN": "http://testserver"},
                        {"HTTP_X_CSRFTOKEN": token, "HTTP_ORIGIN": "https://evil.example"}, {}):
            self.client.credentials(**headers)
            self.error(self.post(image, fixed_body()), 403, "csrf_failed")
        self.client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")
        self.error(self.client.get(self.url(image)), 405, "method_not_allowed")
        for method in (self.client.put, self.client.patch, self.client.delete):
            self.error(method(self.url(image), fixed_body(), format="json"), 405, "method_not_allowed")
        options = self.client.options(self.url(image))
        self.assertEqual((options.status_code, options["Cache-Control"]), (200, "no-store"))
        self.assertEqual(sorted(options["Allow"].split(", ")), ["OPTIONS", "POST"])
        self.error(self.post(image, fixed_body(), HTTP_ACCEPT="text/html"), 406, "not_acceptable")
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"):
            self.error(self.client.post(self.url(image), json.dumps(fixed_body()), content_type=content_type),
                       415, "unsupported_media_type")
        for missing in ("999999", "9223372036854775807", "9223372036854775808", "0", "x", "9" * 40):
            with self.subTest(missing=missing):
                self.error(self.post(missing, fixed_body()), 404, "not_found")
        self.error(self.client.post(self.url(image) + "extra/", fixed_body(), format="json"), 404, "not_found")
        self.assertEqual((image_state(image), domain_counts()), (before, counts))
        self.assertEqual(self.post(image, fixed_body(), REMOTE_ADDR="::1").status_code, 200)

    def test_additive_fields_keep_list_and_detail_query_counts(self):
        images = [review_image(wrong_total(), job=finished_job()) for _ in range(5)]
        self.assertEqual(self.post(images[0], fixed_body()).status_code, 200)
        self.assertEqual(self.post(images[1], fixed_body()).status_code, 200)
        for size in (1, 5):
            with self.subTest(size=size), self.assertNumQueries(2):
                page = self.client.get(f"/api/recognition/receipt-images/?page_size={size}&ordering=created_at").json()
        for image in images:
            with self.assertNumQueries(1):
                detail = self.client.get(f"/api/recognition/receipt-images/{image.pk}/").json()
            self.assertEqual(list(detail), IMAGE_KEYS + ["quad", "rotation_degrees"])
        for item in page["results"]:
            self.assertEqual(list(item), IMAGE_KEYS)
        confirmed = [item["confirmed_at"] is not None for item in page["results"]]
        self.assertEqual(confirmed, [True, True, False, False, False])
        self.assertEqual([item["status"] for item in page["results"]], ["imported", "reused"] + ["needs_review"] * 3)
        waiting = page["results"][2]
        self.assertEqual(waiting["normalized_result"]["proposed_receipt"]["country"], "DE")
        self.assertEqual(list(waiting["normalized_result"]["proposed_receipt"]), [
            "store", "store_display_name", "address_display", "country", "currency", "operation", "purchased_on",
            "local_time", "total", "discount_total", "prices_include_tax"])

    def test_country_and_confirmed_at_projections_are_safe(self):
        job = finished_job()
        cases = (({"store": {"country_code": "KZ"}, "merchant": {"country_code": "DE"}}, "KZ"),
                 ({"store": {"country_code": None}, "merchant": {"country_code": "DE"}}, "DE"),
                 ({"store": {"country_code": "kz"}, "merchant": {"country_code": "PRIVATE"}}, None),
                 ({"store": {"country_code": ["KZ"]}, "merchant": "PRIVATE"}, None), ({}, None))
        for position, (normalized, expected) in enumerate(cases, 1):
            image = review_image(job=job, position=position, normalized_result=normalized)
            value = self.client.get(f"/api/recognition/receipt-images/{image.pk}/").json()
            self.assertEqual(value["normalized_result"]["proposed_receipt"]["country"], expected)
            self.assertIsNone(value["confirmed_at"])
        image = review_image(job=finished_job(), status="imported")
        for snapshot in ("PRIVATE", [], {"confirmed": "PRIVATE"}, {"confirmed": {"at": "PRIVATE"}},
                         {"confirmed": {"at": 5}}, {"confirmed": {"at": "2026-10-04T12:35:00+02:00"}},
                         {"confirmed": {"result": "PRIVATE"}}, {"confirmed": []}):
            ReceiptImage.objects.filter(pk=image.pk).update(
                outcome_snapshot=snapshot, issues=[{"code": "product_conflict", "field": "/lines/0/product_hint"}])
            response = self.client.get(f"/api/recognition/receipt-images/{image.pk}/")
            self.assertEqual(response.status_code, 200)
            self.assertIsNone(response.json()["confirmed_at"])
            self.assertNotIn("PRIVATE", response.content.decode())
        ReceiptImage.objects.filter(pk=image.pk).update(outcome_snapshot={"confirmed": {"at": "2026-10-04T12:35:00.5Z"}})
        self.assertEqual(self.client.get(f"/api/recognition/receipt-images/{image.pk}/").json()["confirmed_at"],
                         "2026-10-04T12:35:00.5Z")


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class ReviewExamplesTests(ReviewApiCase):
    """The example files are whole real responses; a client is written against them."""

    def example(self, name):
        return json.loads((PUBLIC / name).read_text(encoding="utf-8"))

    def confirm(self, body):
        with patch("recognition.review.db_now", return_value=NOW), patch("django.utils.timezone.now", return_value=NOW):
            return self.post(42, body)

    def test_confirmed_example_matches_actual_response(self):
        public_data()
        response = self.confirm(self.example("review-confirm-request.json"))
        self.assertEqual(response.status_code, 200, response.content)
        value = response.json()
        # The id of the created receipt is generated: only this VALUE is substituted.
        created = Receipt.objects.exclude(pk=71).get().pk
        self.assertEqual((value["image"]["receipt_id"], value["job"]["items"][1]["receipt_id"]), (created, created))
        value["image"]["receipt_id"] = value["job"]["items"][1]["receipt_id"] = 72
        self.assertEqual(value, self.example("review-confirmed.json"))
        self.assertEqual((value["image"]["status"], value["job"]["status"], value["job"]["version"]),
                         ("imported", "succeeded", 2))
        self.assertEqual(ReceiptLine.objects.filter(receipt_id=created).count(), 2)
        # The earlier examples of this crop describe the same data before the confirmation.
        before = self.example("receipt-image.json")
        self.assertEqual({key for key in before if before[key] != value["image"][key]},
                         {"status", "receipt_id", "issues", "normalized_result", "confirmed_at"})

    def test_invalid_example_matches_actual_response(self):
        public_data()
        body = self.example("review-confirm-request.json")
        body["receipt"]["total"] = "4.52"  # the recognized total, left as it was
        response = self.confirm(body)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), self.example("review-invalid.json"))
        self.assertEqual(Receipt.objects.count(), 1)
        self.assertEqual(ProcessingJob.objects.get(pk=31).version, 1)

    def test_invalid_parameter_example_matches_actual_response(self):
        public_data()
        body = self.example("review-confirm-request.json")
        body["receipt"]["total"] = 2.63
        body["lines"][0]["quantity"] = "2"
        body["lines"][1]["source_position"] = 5
        body["discounts"][0]["line_position"] = 9
        body["taxes"][1]["tax_rate"]["rate"] = None
        response = self.confirm(body)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json(), self.example("review-invalid-parameter.json"))

    def test_request_example_is_the_form_of_the_image_example(self):
        request = self.example("review-confirm-request.json")
        shown = self.example("receipt-image.json")["normalized_result"]
        proposed = shown["proposed_receipt"]
        self.assertEqual(list(request), ["receipt", "lines", "discounts", "taxes"])
        self.assertEqual({key: request["receipt"][key] for key in ("store_name", "address", "country", "currency",
                                                                   "purchased_on", "local_time", "prices_include_tax")},
                         {"store_name": proposed["store_display_name"], "address": proposed["address_display"],
                          "country": proposed["country"], "currency": proposed["currency"],
                          "purchased_on": proposed["purchased_on"], "local_time": proposed["local_time"],
                          "prices_include_tax": proposed["prices_include_tax"]})
        line = request["lines"][0]
        self.assertEqual((line["source_position"], line["name"], line["unit_price"]),
                         (shown["lines"][0]["position"], shown["lines"][0]["name"], shown["lines"][0]["unit_price"]))
