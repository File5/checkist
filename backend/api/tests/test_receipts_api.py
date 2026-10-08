from datetime import timedelta
from decimal import localcontext

from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.test_recognition_api import public_data
from receipts.models import Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class ReceiptsAPITests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.photo, self.job, self.receipt, self.line = public_data()

    def test_header_and_children_safe_decimal_objects(self):
        response = self.client.get("/api/receipts/71/")
        self.assertEqual(response.status_code, 200, response.content)
        header = response.json()
        self.assertEqual(header["total"], "2.38")
        self.assertEqual(header["origin"], "recognized")
        self.assertEqual(header["lines_count"], 1)
        self.assertFalse(header["review_required"])
        for path in ("/api/receipts/", "/api/receipts/71/", "/api/receipts/71/lines/", "/api/receipts/71/discounts/", "/api/receipts/71/taxes/"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response["Cache-Control"], "no-store")
            self.assertNotIn("PRIVATE", response.content.decode())
            for hidden in ("raw_text", "fiscal", "fiscal_key", "extra", "legal_name", "tax_id", "receipt_number", "shift_number", "register_code", "stderr"):
                self.assertNotIn('"' + hidden + '"', response.content.decode())
        line = self.client.get("/api/receipts/71/lines/").json()["results"][0]
        self.assertEqual(line["name"], "MILCH 1 L")
        self.assertEqual(line["quantity"], "2.000")
        self.assertEqual(line["unit_price"], "1.2900")
        self.assertEqual(line["paid_amount"], "2.38")
        self.assertEqual(line["matching_status"], "matched")
        self.assertEqual(self.client.get("/api/receipts/71/discounts/").json()["results"][0]["line_id"], self.line.pk)
        self.assertEqual(self.client.get("/api/receipts/71/taxes/").json()["results"][0]["gross"], "2.38")

    def test_unmatched_products_and_legacy(self):
        self.line.product = None
        self.line.save()
        header = self.client.get("/api/receipts/71/").json()
        self.assertEqual(header["unmatched_products_count"], 1)
        self.assertTrue(header["review_required"])
        line = self.client.get("/api/receipts/71/lines/?matching=unmatched&kind=product").json()["results"][0]
        self.assertIsNone(line["product"])
        self.assertEqual(line["matching_status"], "unmatched")
        self.assertEqual(self.client.get("/api/receipts/71/lines/?matching=matched").json()["count"], 0)
        self.receipt.recognition_images.all().delete()
        legacy = self.client.get("/api/receipts/71/").json()
        self.assertEqual(legacy["origin"], "legacy/manual")
        self.assertIsNone(legacy["preview_image_url"])

    def test_successful_import_notices_do_not_request_job_or_receipt_review(self):
        self.job.images.filter(status="needs_review").delete()
        image = self.receipt.recognition_images.get()
        image.issues = [{"code": "operation_defaulted", "field": "/operation", "message": "PRIVATE"},
                        {"code": "optional_omitted", "field": "/fiscal/register_serial", "message": "PRIVATE"}]
        image.save()
        with self.assertNumQueries(1):
            header = self.client.get("/api/receipts/71/").json()
        self.assertFalse(header["review_required"])
        job = self.client.get(f"/api/recognition/jobs/{self.job.pk}/").json()
        self.assertFalse(job["review_required"])
        result = self.client.get(f"/api/recognition/receipt-images/{image.pk}/").json()
        self.assertEqual(result["status"], "imported")
        self.assertIsNone(result["normalized_result"])
        self.assertEqual([v["code"] for v in result["issues"]], ["invalid_value", "invalid_value"])
        self.assertNotIn("PRIVATE", str(result))
        self.assertEqual(result["issues"][1]["field"], "/")
        message = "Значение не прошло проверку."
        self.assertEqual(result["issues"], [
            {"code": "invalid_value", "field": "/operation", "message": message, "reason": "operation_defaulted",
             "severity": "info", "context": {"entity": "receipt", "index": None, "position": None,
                                             "attribute": "operation"}},
            {"code": "invalid_value", "field": "/", "message": message, "reason": "optional_omitted",
             "severity": "warning", "context": {"entity": "receipt", "index": None, "position": None,
                                                "attribute": "receipt_metadata"}}])
        for hidden in ("fiscal", "register_serial"):
            self.assertNotIn(hidden, str(result))

    def test_receipt_filters_search_and_no_duplicate_product_matches(self):
        ReceiptLine.objects.create(receipt=self.receipt, position=2, kind="product", raw_name="MILCH", product=self.line.product,
            quantity="1", unit_price="1", amount="1")
        for query in ("store=51", "product=61", "country=de&currency=eur", "operation=sale",
                      "date_from=2026-10-04&date_to=2026-10-04", "q=MILCH", "q=Молоко", "q=Тестовый"):
            with self.subTest(query=query):
                response = self.client.get("/api/receipts/?" + query)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["count"], 1)
        for query in ("store=999", "product=999", "country=RU", "currency=RUB", "operation=refund",
                      "date_from=2026-10-05", "date_to=2026-10-03", "q=PRIVATE", "store=999&product=61"):
            self.assertEqual(self.client.get("/api/receipts/?" + query).json()["count"], 0, query)
        for query in ("store=0", "product=x", "country=ZZ", "currency=ZZZ", "operation=no",
                      "date_from=2026-10-05&date_to=2026-10-01", "q=x", "ordering=no"):
            response = self.client.get("/api/receipts/?" + query)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.json()["error"]["code"], "invalid_parameter")

    def test_ordering_pagination_and_invalid_parent(self):
        self.receipt.pk = None
        self.receipt.fiscal_key = ""
        self.receipt.receipt_number = "OTHER PRIVATE NUMBER"
        self.receipt.purchased_at += timedelta(days=1)
        self.receipt.save()
        newer_id = self.receipt.pk
        for ordering, first_id in (("-purchased_at", newer_id), ("purchased_at", 71)):
            response = self.client.get(f"/api/receipts/?ordering={ordering}&page_size=1").json()
            self.assertEqual(response["results"][0]["id"], first_id)
            self.assertEqual(response["count"], 2)
            self.assertEqual(response["pages"], 2)
        for suffix in ("", "lines/", "discounts/", "taxes/"):
            self.assertEqual(self.client.get("/api/receipts/999/" + suffix).status_code, 404)
            self.assertEqual(self.client.post("/api/receipts/71/" + suffix, {}).status_code, 405)
            self.assertEqual(self.client.get("/api/receipts/71/" + suffix, HTTP_ACCEPT="text/html").status_code, 406)
        for suffix in ("lines/", "discounts/", "taxes/"):
            self.assertEqual(self.client.get("/api/receipts/71/" + suffix + "?page=2").status_code, 404)
            self.assertEqual(self.client.get("/api/receipts/71/" + suffix + "?page_size=0").status_code, 400)
        self.assertEqual(self.client.get("/api/receipts/71/lines/?matching=ambiguous").status_code, 400)
        self.assertEqual(self.client.get("/api/receipts/71/lines/?kind=bad").status_code, 400)

    def test_no_n_plus_one_for_headers_lines_discounts_taxes(self):
        ReceiptLine.objects.bulk_create([
            ReceiptLine(receipt_id=71, position=i, kind="product", raw_name="TEST", product=self.line.product,
                tax_rate=self.line.tax_rate, quantity="1", unit_price="1", amount="1") for i in range(2, 6)
        ])
        ReceiptDiscount.objects.bulk_create([
            ReceiptDiscount(receipt_id=71, line=self.line, position=i, name="TEST", amount="0.01") for i in range(2, 6)
        ])
        from stores.models import TaxRate
        rates = [TaxRate.objects.create(country_id="DE", kind="vat", rate=i) for i in range(1, 5)]
        ReceiptTax.objects.bulk_create([ReceiptTax(receipt_id=71, tax_rate=rate, net="1", tax="0", gross="1") for rate in rates])
        for i in range(2, 6):
            Receipt.objects.create(owner_id=self.receipt.owner_id, store=self.receipt.store, currency_id="EUR", operation="sale",
                purchased_at=self.receipt.purchased_at + timedelta(minutes=i), purchased_on=self.receipt.purchased_on,
                total="1", receipt_number=f"PRIVATE {i}")
        for size in (1, 5):
            for path, queries in (("/api/receipts/", 2), ("/api/receipts/71/lines/", 3),
                                  ("/api/receipts/71/discounts/", 3), ("/api/receipts/71/taxes/", 3)):
                with self.subTest(path=path, size=size), self.assertNumQueries(queries):
                    response = self.client.get(path + f"?page_size={size}")
                    self.assertEqual(response.status_code, 200)

    def test_paid_amount_at_full_precision_independent_of_context(self):
        ReceiptLine.objects.filter(pk=self.line.pk).update(amount="999999999999.99", discount_amount="0.01")
        with localcontext() as context:
            context.prec = 2
            line = self.client.get("/api/receipts/71/lines/").json()["results"][0]
        self.assertEqual(line["paid_amount"], "999999999999.98")

    def test_previous_thirteen_gets_unchanged_when_local_api_is_disabled(self):
        from api.tests.factories import save_samples
        data = save_samples()
        category_id = data.milk.category_id
        generic_id = data.milk.pk
        product_id = data.shop_milk.pk
        paths = ["/api/countries/", "/api/stores/", "/api/brands/", "/api/categories/",
            f"/api/categories/{category_id}/", "/api/generic-products/", f"/api/generic-products/{generic_id}/",
            "/api/products/", f"/api/products/{product_id}/", f"/api/products/{product_id}/prices/",
            f"/api/products/{product_id}/prices/summary/", f"/api/products/{product_id}/alternatives/",
            f"/api/generic-products/{generic_id}/comparison/"]
        for path in paths:
            enabled = self.client.get(path)
            self.assertEqual(enabled.status_code, 200, enabled.content)
            with override_settings(DEBUG=False, ALLOW_LOCAL_RECOGNITION_API=False):
                disabled = self.client.get(path)
            self.assertEqual(disabled.status_code, 200, disabled.content)
            self.assertEqual(disabled.json(), enabled.json())
