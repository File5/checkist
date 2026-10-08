"""Fake scenario → host worker command → needs_review crop → HTTP confirm → receipt, one database.

APIClient dispatches the real routes in process with cookie/Origin/CSRF; MEDIA and
scratch are temporary. Every request body is built from the public projection of
the crop, the way a form does. No model call, no socket, no browser: runserver is
covered by the manual HTTP runs of the QA section in docs/development.md.
"""
import copy
import json
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import connection
from django.test import TransactionTestCase, override_settings, tag
from rest_framework.test import APIClient

from receipts.models import Receipt
from recognition.models import ReceiptImage
from recognition.tests.test_review import domain_counts
from stores.models import Country, Currency

# The two fictional receipts of fake.receipt_payload as the public API shows them once saved.
# Line: position, kind, name, quantity, unit, unit_price, amount, discount_amount, paid_amount, rate, tax_code.
RECEIPTS = {
    1: {"store": ("TESTMARKT", "Berlin", "Teststrasse 12, 10115 Berlin"), "number": "000123",
        "header": ("4.42", "0.20", "2026-10-04", "2026-10-04T12:35:20Z"),
        "lines": [(1, "product", "MILCH 1 L", "2.000", "pcs", "1.2900", "2.58", "0.20", "2.38", "7.00", "A"),
                  (2, "product", "APFEL", "0.500", "kg", "2.0000", "1.00", "0.00", "1.00", "7.00", "A"),
                  (3, "product", "MINERALWASSER 0.5 L", "1.000", "pcs", "0.7900", "0.79", "0.00", "0.79", "19.00", "B"),
                  (4, "deposit", "PFAND zu MINERALWASSER", "1.000", "pcs", "0.2500", "0.25", "0.00", "0.25", "19.00",
                   "B")],
        "parents": {4: 3}, "discounts": [(1, 1, "Rabatt MILCH", "0.20")],
        "taxes": [("A", "7.00", "3.16", "0.22", "3.38"), ("B", "19.00", "0.87", "0.17", "1.04")]},
    2: {"store": ("TESTSHOP", "Hamburg", "Beispielweg 4, 20095 Hamburg"), "number": "000777",
        "header": ("6.00", "0.00", "2026-10-04", "2026-10-04T14:10:00Z"),
        "lines": [(1, "product", "BROT", "1.000", "pcs", "1.5000", "1.50", "0.00", "1.50", "7.00", "A"),
                  (2, "product", "KAESE 200 G", "2.000", "pcs", "2.2500", "4.50", "0.00", "4.50", "7.00", "A")],
        "parents": {}, "discounts": [], "taxes": [("A", "7.00", "5.61", "0.39", "6.00")]},
}
# Last paid unit price of every created product, by the default name ordering of /api/products/.
PRODUCTS = [("APFEL", "2.0000", 1), ("BROT", "1.5000", 2), ("KAESE 200 G", "2.2500", 2), ("MILCH 1 L", "1.1900", 1),
            ("MINERALWASSER 0.5 L", "0.7900", 1)]
# Names of closed fields, private keys of the confirmation, closed values of both receipts.
CLOSED = ("receipt_number", "shift_number", "register_code", "register_serial", "tse_transaction", "signature",
          "fiscal", "legal_name", "tax_id", "raw_text", "product_hint", "request_sha256", "previous_issues",
          "outcome_snapshot", '"extra"', '"result"', '"warnings"', "TEST-KASSE-01", "TEST-KASSE-02", "TESTMARKT GmbH",
          "TESTSHOP GmbH", "SYNTHETIC RECEIPT", '"000123"', '"000777"', '"98765"', '"12345"')
PAGE = ["count", "page", "page_size", "pages", "results"]
STORE = ["id", "name", "city", "address", "country", "timezone"]
PRODUCT = ["id", "name", "brand", "model", "gtin", "package", "generic", "category", "last_observed_at", "prices"]
CATEGORY = ["id", "name", "parent_id", "depth", "path", "children_count", "generic_products_count", "products_count",
            "products_total"]
GENERIC = ["id", "name", "base_unit", "category", "products_count", "countries"]
COMPARISON = ["base", "generic", "unit", "conversion", "groups", *PAGE]
TOTAL_MISMATCH = {"code": "total_mismatch", "message": "Сумма чека не совпадает с суммой позиций.",
                  "reason": "total_mismatch", "severity": "error"}
# The tax table cannot add up to a wrong total either: it is left out, which alone refuses nothing.
WRONG_TOTAL = [{"code": "invalid_value", "field": "/taxes", "message": "Значение не прошло проверку.",
                "reason": "optional_omitted", "severity": "warning",
                "context": {"entity": "tax", "index": None, "position": None, "attribute": None}},
               {**TOTAL_MISMATCH, "field": "/total",
                "context": {"entity": "receipt", "index": None, "position": None, "attribute": "total"}}]
UNREAD = [{"code": "missing_required", "field": f"/lines/0/{name}", "message": "Не удалось прочитать обязательное поле.",
           "reason": "missing_required", "severity": "error",
           "context": {"entity": "line", "index": 0, "position": 1, "attribute": name}}
          for name in ("quantity", "unit_price")]


def progress(imported, review):
    return {"detected": 2, "current_position": None, "completed": 2, "imported": imported, "reused": 0,
            "review": review, "failed": 0, "cancelled": 0}


def form_body(image):
    """The request of an untouched form: the public projection of the crop, value by value."""
    result = image["normalized_result"]
    proposed = result["proposed_receipt"]
    return {
        "receipt": {"store_id": None, "store_name": proposed["store_display_name"],
                    "address": proposed["address_display"],
                    **{key: proposed[key] for key in ("country", "currency", "operation", "purchased_on", "local_time",
                                                      "total", "prices_include_tax")}},
        "lines": [{"source_position": line["position"],
                   **{key: line[key] for key in ("position", "kind", "parent_position", "name", "quantity", "unit",
                                                 "unit_price", "amount", "tax_rate", "tax_code")}}
                  for line in result["lines"]],
        "discounts": copy.deepcopy(result["discounts"]), "taxes": copy.deepcopy(result["taxes"]),
    }


def with_line(body, **values):
    body = copy.deepcopy(body)
    body["lines"][0].update(values)
    return body


def with_total(body, total):
    body = copy.deepcopy(body)
    body["receipt"]["total"] = total
    return body


@tag("integration")
class ReviewConfirmHttpTests(TransactionTestCase):
    maxDiff = None

    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        media = TemporaryDirectory(prefix="checkist-review-http-media-")
        scratch = TemporaryDirectory(prefix="checkist-review-http-scratch-")
        self.addCleanup(media.cleanup)
        self.addCleanup(scratch.cleanup)
        override = override_settings(
            DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True, MEDIA_ROOT=media.name,
            RECEIPT_OCR_TEMP_ROOT=scratch.name, RECEIPT_OCR_PROVIDER="fake", PRODUCT_MERGE_AUTO_DETECT=False,
        )
        override.enable()
        self.addCleanup(override.disable)
        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        call_command("seed_recognition_demo", stdout=StringIO())
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

    def job(self, job_id):
        return self.get(f"/api/recognition/jobs/{job_id}/")

    def image(self, image_id):
        return self.get(f"/api/recognition/receipt-images/{image_id}/")

    def process(self, scenario):
        response = self.client.post(
            "/api/recognition/photos/", {"file": SimpleUploadedFile("synthetic.png", self.double, "image/png")},
            format="multipart")
        self.assertEqual(response.status_code, 202, response.content)
        job_id = response.json()["job"]["id"]
        call_command("recognition_worker", once=True, fake_scenario=scenario, stdout=StringIO())
        return self.job(job_id)

    def post(self, url, body, status):
        response = self.client.post(url, body, format="json")
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.bodies.append(response.content.decode())
        return response.json()

    def confirm(self, image_id, body, status=200):
        return self.post(f"/api/recognition/receipt-images/{image_id}/confirm/", body, status)

    def refused(self, image_id, body, status, code):
        """A refusal saves nothing: the crop, its job and the domain tables stay as they were."""
        image = self.image(image_id)
        before = (image, self.job(image["job_id"]), domain_counts(), self.get("/api/receipts/")["count"])
        value = self.confirm(image_id, body, status)
        self.assertEqual(value["error"]["code"], code)
        self.assertEqual(list(value), ["error", "issues"] if code == "review_invalid" else ["error"])
        self.assertEqual((self.image(image_id), self.job(image["job_id"]), domain_counts(),
                          self.get("/api/receipts/")["count"]), before)
        return value

    def confirmed(self, image_id, body, *, status, imported, review):
        """A success answers with exactly the detail forms of the crop and of its recounted job."""
        before = self.job(self.image(image_id)["job_id"])
        value = self.confirm(image_id, body)
        self.assertEqual(list(value), ["image", "job"])
        image, job = value["image"], value["job"]
        self.assertEqual((image, job), (self.image(image_id), self.job(before["id"])))
        self.assertEqual((image["status"], image["normalized_result"], image["issues"], image["receipt_deleted"]),
                         ("imported", None, [], False))
        self.assertRegex(image["confirmed_at"], r"\A2[0-9]{3}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?Z\Z")
        retry = status != "succeeded"
        self.assertEqual((job["status"], job["version"], job["progress"], job["review_required"], job["actions"]),
                         (status, before["version"] + 1, progress(imported, review), retry,
                          {"can_cancel": False, "can_retry": retry}))
        # Only the outcome is recounted: the finished run itself is history.
        for key in ("stage", "finished_at", "started_at", "error", "photo_id", "retry_of", "items_count"):
            self.assertEqual(job[key], before[key], key)
        self.assertIn({"image_id": image_id, "position": image["position"], "status": "imported",
                       "receipt_id": image["receipt_id"]}, job["items"])
        return value

    def assert_review_job(self, job, statuses, issues):
        review = statuses.count("needs_review")
        self.assertEqual((job["status"], job["review_required"], job["error"], job["progress"], job["actions"]),
                         ("partial_succeeded", True, None, progress(2 - review, review),
                          {"can_cancel": False, "can_retry": True}))
        self.assertEqual([(item["position"], item["status"]) for item in job["items"]], list(enumerate(statuses, 1)))
        images = [self.image(item["image_id"]) for item in job["items"]]
        for item, image in zip(job["items"], images):
            if item["status"] == "needs_review":
                self.assertEqual((image["status"], image["receipt_id"], image["confirmed_at"], image["issues"]),
                                 ("needs_review", None, None, issues))
                self.assertIsNotNone(image["normalized_result"])
        return images

    def assert_receipt(self, position, receipt_id):
        expected = RECEIPTS[position]
        receipt = self.get(f"/api/receipts/{receipt_id}/")
        self.assertEqual(list(receipt["store"]), STORE)
        self.assertEqual((receipt["store"]["name"], receipt["store"]["city"], receipt["store"]["address"],
                          receipt["store"]["country"]), (*expected["store"], "DE"))
        self.assertEqual((receipt["total"], receipt["discount_total"], receipt["purchased_on"],
                          receipt["purchased_at"]), expected["header"])
        self.assertEqual((receipt["currency"], receipt["operation"], receipt["prices_include_tax"], receipt["origin"],
                          receipt["review_required"], receipt["lines_count"], receipt["unmatched_products_count"],
                          receipt["receipt_images_count"]),
                         ("EUR", "sale", True, "recognized", False, len(expected["lines"]), 0, 1))
        lines = self.get(receipt["lines_url"])["results"]
        self.assertEqual([(line["position"], line["kind"], line["name"], line["quantity"], line["unit"],
                           line["unit_price"], line["amount"], line["discount_amount"], line["paid_amount"],
                           line["tax_rate"]["rate"], line["tax_code"]) for line in lines], expected["lines"])
        ids = {line["position"]: line["id"] for line in lines}
        self.assertEqual({line["position"]: line["parent_id"] for line in lines},
                         {position: ids.get(expected["parents"].get(position)) for position in ids})
        for line in lines:
            self.assertEqual((line["tax_rate"]["kind"], line["tax_rate"]["country"]), ("vat", "DE"))
            if line["kind"] == "product":
                self.assertEqual((line["matching_status"], line["product"]["name"]), ("matched", line["name"]))
            else:
                self.assertEqual((line["matching_status"], line["product"]), ("unmatched", None))
        self.assertEqual([(item["position"], item["line_id"], item["name"], item["amount"])
                          for item in self.get(receipt["discounts_url"])["results"]],
                         [(number, ids[line], name, amount) for number, line, name, amount in expected["discounts"]])
        self.assertEqual([(tax["tax_code"], tax["tax_rate"]["rate"], tax["net"], tax["tax"], tax["gross"])
                          for tax in self.get(receipt["taxes_url"])["results"]], expected["taxes"])
        images = self.get(receipt["images_url"])["results"]
        self.assertEqual([(image["status"], image["receipt_id"], image["normalized_result"]) for image in images],
                         [("imported", receipt_id, None)])
        return receipt, images[0]

    def assert_catalog(self, receipts):
        """The 13 earlier GET of catalog and prices show the created stores and products in their forms."""
        stores = self.get("/api/stores/")
        self.assertEqual((list(stores), stores["count"]), (PAGE, 2))
        for store, position in zip(stores["results"], (1, 2)):
            self.assertEqual(list(store), STORE + ["receipts_count"])
            self.assertEqual((store["id"], store["name"], store["city"], store["address"], store["country"],
                              store["receipts_count"]),
                             (receipts[position]["store"]["id"], *RECEIPTS[position]["store"], "DE", 1))
        countries = self.get("/api/countries/")["results"]
        self.assertEqual([list(country) for country in countries],
                         [["code", "name", "currencies", "stores_count", "products_count"]])
        self.assertEqual({key: countries[0][key] for key in ("code", "currencies", "stores_count", "products_count")},
                         {"code": "DE", "currencies": ["EUR"], "stores_count": 2, "products_count": 5})
        self.assertEqual(self.get("/api/brands/"), {"count": 0, "page": 1, "page_size": 50, "pages": 0, "results": []})

        products = self.get("/api/products/")
        self.assertEqual((list(products), products["count"]), (PAGE, 5))
        generic, category = products["results"][0]["generic"], products["results"][0]["category"]
        for product, (name, price, position) in zip(products["results"], PRODUCTS, strict=True):
            self.assertEqual(list(product), PRODUCT)
            self.assertEqual((product["name"], product["brand"], product["package"], product["generic"],
                              product["category"], product["last_observed_at"]),
                             (name, None, None, generic, category, RECEIPTS[position]["header"][3]))
            self.assertEqual([(item["country"], item["currency"], item["observations"], item["last"]["paid_unit_price"],
                               item["last"]["purchased_on"], item["last"]["store_id"]) for item in product["prices"]],
                             [("DE", "EUR", 1, price, "2026-10-04", receipts[position]["store"]["id"])])
        categories = self.get("/api/categories/")["results"]
        self.assertEqual([list(item) for item in categories], [CATEGORY])
        self.assertEqual((categories[0]["id"], categories[0]["generic_products_count"], categories[0]["products_count"],
                          categories[0]["products_total"]), (category["id"], 1, 5, 5))
        detail = self.get(f"/api/categories/{category['id']}/")
        self.assertEqual(list(detail), CATEGORY + ["children", "generic_products"])
        self.assertEqual((detail["children"], detail["generic_products"]),
                         ([], [{**generic, "products_count": 5}]))
        generics = self.get("/api/generic-products/")
        self.assertEqual((list(generics), generics["count"], [list(item) for item in generics["results"]]),
                         (PAGE, 1, [GENERIC]))
        self.assertEqual(generics["results"][0], self.get(f"/api/generic-products/{generic['id']}/"))
        self.assertEqual({key: generics["results"][0][key] for key in ("id", "category", "products_count", "countries")},
                         {"id": generic["id"], "category": category, "products_count": 5, "countries": ["DE"]})

        # The discounted line: 2 x 1.2900 minus 0.20 for the line.
        milk, store = products["results"][3], receipts[1]["store"]
        detail = self.get(f"/api/products/{milk['id']}/")
        self.assertEqual(list(detail), PRODUCT + ["attributes", "aliases", "stores", "alternatives_count"])
        self.assertEqual({key: detail[key] for key in PRODUCT}, milk)
        self.assertEqual((detail["attributes"], detail["aliases"], detail["alternatives_count"]),
                         ({}, [{"store_name": "TESTMARKT", "raw_name": "MILCH 1 L", "store_item_code": ""}], 4))
        self.assertEqual(detail["stores"], [{**store, "observations": 1, "last_purchased_on": "2026-10-04"}])
        short = {key: store[key] for key in ("id", "name", "city", "country")}
        self.assertEqual(self.get(f"/api/products/{milk['id']}/prices/"), {
            "product": {"id": milk["id"], "name": "MILCH 1 L", "base_unit": generic["base_unit"]},
            "count": 1, "page": 1, "page_size": 200, "pages": 1, "results": [{
                "observed_at": "2026-10-04T12:35:20Z", "purchased_on": "2026-10-04", "store": short, "currency": "EUR",
                "quantity": "2.000", "unit": "pcs", "list_unit_price": "1.2900", "paid_unit_price": "1.1900",
                "discount_amount": "0.20", "normalized_price": None, "normalized_unit": None, "comparable": False,
                "receipt_id": receipts[1]["id"], "position": 1, "own": True}]})
        self.assertEqual(self.get(f"/api/products/{milk['id']}/prices/summary/"), {
            "product": {"id": milk["id"], "name": "MILCH 1 L", "base_unit": generic["base_unit"]},
            "price": "paid", "group_by": "country", "interval": "none", "groups": [{
                "country": "DE", "currency": "EUR", "unit": "pcs", "buckets": [], "total": {
                    "count": 1, "min": "1.1900", "max": "1.1900", "avg": "1.1900",
                    "first": {"price": "1.1900", "purchased_on": "2026-10-04"},
                    "last": {"price": "1.1900", "purchased_on": "2026-10-04"}, "change_percent": None}}]})
        alternatives = self.get(f"/api/products/{milk['id']}/alternatives/")
        comparison = self.get(f"/api/generic-products/{generic['id']}/comparison/")
        for value, base in ((alternatives, {"id": milk["id"], "name": "MILCH 1 L"}), (comparison, None)):
            self.assertEqual(list(value), COMPARISON)
            self.assertEqual((value["base"], value["generic"], value["conversion"], value["count"]),
                             (base, generic, None, 5))
            self.assertEqual(sorted(item["product"]["name"] for item in value["results"]),
                             [name for name, _, _ in PRODUCTS])
            for item in value["results"]:
                self.assertEqual((list(item), list(item["product"]), len(item["offers"])),
                                 (["product", "offers"], ["id", "name", "brand", "package", "is_base"], 1))
        self.assertEqual(alternatives["results"][0]["product"],
                         {"id": milk["id"], "name": "MILCH 1 L", "brand": None, "package": None, "is_base": True})

    def assert_final_state(self, job, *, confirmed):
        """Both receipts are saved once, whichever way each crop reached its receipt."""
        job = self.job(job["id"])
        self.assertEqual((job["status"], job["review_required"], job["error"], job["progress"], job["actions"]),
                         ("succeeded", False, None, progress(2, 0), {"can_cancel": False, "can_retry": False}))
        self.assertEqual([(item["position"], item["status"]) for item in job["items"]],
                         [(1, "imported"), (2, "imported")])
        self.assertEqual(self.post(f"/api/recognition/jobs/{job['id']}/retry/", {}, 409)["error"]["code"],
                         "retry_not_allowed")
        self.assertEqual(self.get("/api/receipts/")["count"], 2)
        receipts = {}
        for item in job["items"]:
            position = item["position"]
            receipts[position], image = self.assert_receipt(position, item["receipt_id"])
            self.assertEqual((image["id"], image["confirmed_at"] is not None),
                             (item["image_id"], position in confirmed))
            # Closed facts are carried from the stored recognition, never from the request.
            saved = Receipt.objects.get(pk=item["receipt_id"])
            self.assertEqual(saved.receipt_number, RECEIPTS[position]["number"])
            mark = saved.extra["recognition"].get("confirmed")
            self.assertEqual(mark and mark["image_id"], item["image_id"] if position in confirmed else None)
            snapshot = ReceiptImage.objects.get(pk=item["image_id"]).outcome_snapshot
            self.assertEqual("confirmed" in snapshot, position in confirmed)
        # Receipt, line, discount, tax, store, merchant, product, alias; tax rates may be seeded.
        self.assertEqual(domain_counts()[:8], (2, 6, 1, 3, 2, 2, 5, 5))
        self.assert_catalog(receipts)
        self.assert_no_closed_data()

    def assert_no_closed_data(self):
        self.assertTrue(self.bodies)
        for body in self.bodies:
            json.loads(body)
            for text in CLOSED:
                self.assertNotIn(text, body)

    def test_automatic_import_is_the_reference_state(self):
        # No person involved: the state every confirmed scenario below must reach.
        job = self.process("success2")
        self.assertEqual((job["status"], job["version"] > 0), ("succeeded", True))
        self.assert_final_state(job, confirmed=())

    def test_partial_success_second_crop_confirmed_finishes_the_job(self):
        job = self.process("partial_success")
        saved, review = self.assert_review_job(job, ["imported", "needs_review"], UNREAD)
        self.assertEqual((saved["status"], saved["receipt_id"], saved["normalized_result"], saved["confirmed_at"]),
                         ("imported", job["items"][0]["receipt_id"], None, None))
        self.assertEqual(self.get("/api/receipts/")["count"], 1)
        body = with_line(form_body(review), quantity="1.000", unit_price="1.5000")
        first = self.confirmed(review["id"], body, status="succeeded", imported=2, review=0)
        self.assertNotEqual(first["image"]["receipt_id"], saved["receipt_id"])

        # The same content again: the current state, no write. Key order and code case do not matter.
        state = (domain_counts(), ReceiptImage.objects.get(pk=review["id"]).outcome_snapshot)
        same = {key: body[key] for key in ("taxes", "discounts", "lines", "receipt")}
        same["receipt"] = {**same["receipt"], "country": "de", "currency": "eur"}
        for repeated in (body, same):
            self.assertEqual(self.confirm(review["id"], repeated), first)
        # Other content: refused, and neither the receipt nor the job moves.
        for other in (with_line(body, quantity="3.000", unit_price="0.5000"), with_total(body, "6.01"),
                      {**body, "discounts": [{"position": 1, "line_position": None, "name": "Rabatt", "amount": "0.10"}]}):
            self.assertEqual(self.refused(review["id"], other, 409, "review_resolved")["error"]["message"],
                             "Результат уже подтверждён.")
        self.assertEqual((domain_counts(), ReceiptImage.objects.get(pk=review["id"]).outcome_snapshot), state)
        self.assertEqual(self.job(job["id"]), first["job"])
        # The crop saved by the worker was never open for confirmation.
        self.refused(saved["id"], body, 409, "review_unavailable")
        self.assert_final_state(job, confirmed={2})

    def test_inconsistent_total_is_refused_until_the_total_is_corrected(self):
        job = self.process("inconsistent_total")
        images = self.assert_review_job(job, ["needs_review", "needs_review"], WRONG_TOTAL)
        self.assertEqual(domain_counts()[:8], (0,) * 8)
        self.assertEqual((self.get("/api/receipts/")["count"], self.get("/api/products/")["count"],
                          self.get("/api/stores/")["count"]), (0, 0, 0))
        for image, total, outcome in zip(images, ("4.42", "6.00"), (("partial_succeeded", 1, 1), ("succeeded", 2, 0))):
            body = form_body(image)
            self.assertEqual(body["receipt"]["total"], "123.45")
            for wrong in (body, with_total(body, "0.01")):
                value = self.refused(image["id"], wrong, 409, "review_invalid")
                self.assertEqual(value["error"], {"code": "review_invalid",
                                                  "message": "Исправленные данные не прошли проверку."})
                self.assertEqual(value["issues"], WRONG_TOTAL)
            status, imported, review = outcome
            self.confirmed(image["id"], with_total(body, total), status=status, imported=imported, review=review)
        self.assert_final_state(job, confirmed={1, 2})

    def test_partial_missing_quantity_needs_the_quantity_and_the_price(self):
        job = self.process("partial_missing_quantity")
        images = self.assert_review_job(job, ["needs_review", "needs_review"], UNREAD)
        entered = (("2.000", "1.2900"), ("1.000", "1.5000"))
        for image, (quantity, price), outcome in zip(images, entered, (("partial_succeeded", 1, 1), ("succeeded", 2, 0))):
            body = form_body(image)
            self.assertEqual((body["lines"][0]["quantity"], body["lines"][0]["unit_price"]), (None, None))
            # A number typed without its scale is a value error of the form, not a rounding.
            value = self.refused(image["id"], with_line(body, quantity="2", unit_price=1.29), 400, "invalid_parameter")
            self.assertEqual(sorted(value["error"]["fields"]), ["lines.0.quantity", "lines.0.unit_price"])
            # Well formed operands that do not give the printed amount.
            value = self.refused(image["id"], with_line(body, quantity=quantity, unit_price="9.9900"), 409,
                                 "review_invalid")
            self.assertEqual(value["issues"], [{
                **TOTAL_MISMATCH, "field": "/lines/0/amount",
                "context": {"entity": "line", "index": 0, "position": 1, "attribute": "amount"}}])
            status, imported, review = outcome
            self.confirmed(image["id"], with_line(body, quantity=quantity, unit_price=price), status=status,
                           imported=imported, review=review)
        self.assert_final_state(job, confirmed={1, 2})
