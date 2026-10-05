import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal, localcontext
from tempfile import TemporaryDirectory
from threading import Event
from unittest.mock import patch

from django.db import IntegrityError, close_old_connections, connection, connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings, tag

from catalog.models import Brand, Category, GenericProduct, Product
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.validation import validate_receipt
from recognition import importer
from recognition.importer import ImportBusy, import_receipt
from recognition.dto import FieldObservation
from recognition.models import ProcessingJob, ReceiptImage
from recognition.providers.fake import receipt_payload
from recognition.queue import FenceLost, db_now, request_cancel
from recognition.resolution import resolve_country, resolve_store
from stores.models import Country, Currency, Merchant, Store, TaxRate
from .import_fixtures import another_receipt, lidl_format_payload, live_image, observation


@tag("integration")
class ImportTests(TestCase):
    def setUp(self):
        self.media = TemporaryDirectory()
        self.addCleanup(self.media.cleanup)
        self.settings_override = override_settings(MEDIA_ROOT=self.media.name)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)

    def run_import(self, data=None, **image_fields):
        image, job = live_image(**image_fields)
        return import_receipt(image, observation(data), run_token=job.run_token, version=job.version)

    def assert_no_domain(self):
        for model in (Merchant, Store, Category, GenericProduct, Brand, Product, ProductAlias,
                      Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax):
            self.assertEqual(model.objects.count(), 0, model.__name__)

    def test_k1_new_receipt_on_empty_catalog_and_stores(self):
        result = self.run_import()
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.issues, [])
        receipt = result.receipt
        self.assertEqual(receipt.total, Decimal("4.42"))
        self.assertEqual(receipt.purchased_at.isoformat(), "2026-10-04T12:35:20+00:00")
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Product.objects.count()), (1, 1, 3))
        self.assertEqual((receipt.lines.count(), receipt.discounts.count(), receipt.taxes.count()), (4, 1, 2))
        deposit = receipt.lines.get(kind="deposit")
        self.assertEqual(deposit.parent.position, 3)
        self.assertIsNone(deposit.product_id)
        self.assertEqual(receipt.discounts.get().line.position, 1)
        self.assertEqual(receipt.lines.get(position=1).discount_amount, Decimal("0.20"))
        self.assertEqual(receipt.taxes.get(tax_rate__rate="7.00").gross, Decimal("3.38"))
        self.assertEqual(validate_receipt(receipt), [])
        self.assertIn("/taxes/0/gross", receipt.extra["recognition"]["derived"])
        self.assertEqual(result.image.normalized_result["taxes"][0]["gross"], None)
        self.assertEqual(result.image.import_effect, "created")
        self.assertEqual(result.image.status, "imported")
        self.assertEqual(result.image.outcome_snapshot, {"receipt_id": receipt.pk})
        self.assertEqual(result.job_version, result.image.job.version)
        self.assertEqual(result.image.job.imported_count, 1)

    def test_c6_codex_null_operation_and_ambiguous_optional_fiscal_autoimport(self):
        payload = receipt_payload()
        payload["operation"] = None
        payload["fiscal"]["register_serial"] = None
        obs = observation(payload)
        obs = replace(obs, fields=obs.fields + (
            FieldObservation("/operation", "absent", None, None),
            FieldObservation("/fiscal/register_serial", "ambiguous", None, None),
        ))
        image, job = live_image()
        result = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.image.status, "imported")
        self.assertEqual(result.receipt.operation, "sale")
        self.assertEqual(result.receipt.total, Decimal("4.42"))
        self.assertEqual((result.receipt.lines.count(), Product.objects.count()), (4, 3))
        self.assertEqual(result.receipt.fiscal_key, "")
        self.assertNotIn("register_serial", result.receipt.fiscal)
        self.assertIsNone(result.image.normalized_result["operation"])
        self.assertIn("operation_defaulted", [v["code"] for v in result.issues])
        self.assertIn("optional_omitted", [v["code"] for v in result.issues])

    def test_second_k1_receipt_is_independently_imported(self):
        self.run_import()
        result = self.run_import(receipt_payload(2))
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.total, Decimal("6.00"))
        self.assertEqual((Receipt.objects.count(), Store.objects.count(), Product.objects.count()), (2, 2, 5))

    def test_lidl_format_import_defaults_utc_discounts_taxes_and_repeat(self):
        payload = lidl_format_payload()
        result = self.run_import(payload)
        self.assertEqual((result.outcome, result.image.status), ("created", "imported"))
        self.assertEqual([(v["code"], v["field"]) for v in result.issues], [("optional_omitted", "/receipt_number")])
        receipt = result.receipt
        self.assertEqual(receipt.purchased_at.isoformat(), "2026-10-01T17:01:56+00:00")
        self.assertEqual(receipt.store.timezone, "Europe/Berlin")
        self.assertEqual(receipt.store.address_raw, "Testweg 17, 88131 Lindau")
        self.assertEqual(receipt.extra["recognition"]["utc_offset_printed"], "+00:00")
        self.assertEqual(receipt.total, Decimal("40.80"))
        derived = receipt.extra["recognition"]["derived"]
        for saved, observed in zip(receipt.lines.order_by("position"), payload["lines"], strict=True):
            if observed["quantity"] is None:
                self.assertEqual((saved.quantity, saved.unit, saved.unit_price, saved.amount),
                                 (Decimal("1.000"), "pcs", Decimal(observed["amount"]), Decimal(observed["amount"])))
                for key in ("quantity", "unit", "unit_price"):
                    self.assertIn(f"/lines/{saved.position - 1}/{key}", derived)
            elif saved.position == 1:
                self.assertEqual((saved.quantity, saved.unit, saved.unit_price),
                                 (Decimal("0.294"), "kg", Decimal("2.9900")))
            else:
                self.assertEqual(saved.unit, "pcs")
        self.assertEqual(receipt.lines.get(position=3).quantity, Decimal("2.000"))
        self.assertEqual(receipt.lines.get(position=22).quantity, Decimal("-5.000"))
        self.assertEqual(receipt.lines.get(position=18).parent.position, 17)
        self.assertEqual(receipt.lines.get(position=19).amount, Decimal("1.99"))
        self.assertEqual(receipt.lines.get(position=19).discount_amount, Decimal("0.20"))
        self.assertEqual(list(receipt.discounts.order_by("position").values_list("line__position", "name", "amount")),
                         [(9, "Preisvorteil", Decimal("0.20")), (21, "Preisvorteil", Decimal("2.00")),
                          (19, "Rabatt Snack", Decimal("0.20"))])
        self.assertEqual(list(receipt.taxes.order_by("tax_code").values_list("tax_code", "gross")),
                         [("A", Decimal("39.70")), ("B", Decimal("1.10"))])
        self.assertEqual(validate_receipt(receipt), [])
        self.assertIsNone(result.image.normalized_result["lines"][1]["quantity"])

        # R2 plus exact weak identity: punctuation and tax-ID completeness must
        # not create a new store/receipt even without a strong fiscal key.
        payload["store"]["address_raw"] = "Testweg 17 88131 Lindau"
        payload["merchant"].update(tax_id=None, tax_id_type=None)
        payload["fiscal"] = {key: None for key in payload["fiscal"]}
        repeated = self.run_import(payload)
        self.assertEqual((repeated.outcome, repeated.receipt.pk), ("linked", receipt.pk))
        exact = self.run_import(lidl_format_payload())
        self.assertEqual((exact.outcome, exact.receipt.pk), ("linked", receipt.pk))
        self.assertEqual((Receipt.objects.count(), Store.objects.count(), Merchant.objects.count()), (1, 1, 1))
        self.assertEqual((ReceiptLine.objects.count(), ReceiptDiscount.objects.count(), ReceiptTax.objects.count()), (22, 3, 2))
        self.assertEqual((Product.objects.count(), ProductAlias.objects.count()), (20, 20))

    def test_missing_quantity_and_price_with_amount_now_imports(self):
        payload = receipt_payload()
        payload["lines"][0].update(quantity=None, unit_price=None, unit=None)
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        line = result.receipt.lines.get(position=1)
        self.assertEqual((line.quantity, line.unit, line.unit_price), (Decimal("1.000"), "pcs", Decimal("2.5800")))
        self.assertEqual(validate_receipt(result.receipt), [])

    def test_amount_only_deposit_return_defaults_negative_quantity_and_positive_price(self):
        payload = receipt_payload()
        payload["lines"][3].update(kind="deposit_return", parent_position=None, quantity=None, unit=None,
                                    unit_price=None, amount="-0.25")
        payload["total"] = "3.92"
        payload["taxes"][1].update(net="0.45", tax="0.09", gross="0.54")
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        line = result.receipt.lines.get(position=4)
        self.assertEqual((line.quantity, line.unit, line.unit_price), (Decimal("-1.000"), "pcs", Decimal("0.2500")))
        self.assertEqual(validate_receipt(result.receipt), [])

    @staticmethod
    def tax_id_payload(tax_id):
        data = receipt_payload()
        data["merchant"].update(tax_id=tax_id, tax_id_type="vat_id" if tax_id else None)
        data["fiscal"] = {key: None for key in data["fiscal"]}
        for key in ("receipt_number", "register_code", "shift_number"):
            data[key] = None
        return data

    def assert_tax_id_completeness_links_weak_receipt(self, first_id, second_id):
        first = self.run_import(self.tax_id_payload(first_id))
        self.assertEqual(first.outcome, "created")
        self.assertEqual((first.receipt.fiscal_key, first.receipt.receipt_number), ("", ""))
        models = (Store, Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax, Product, ProductAlias)
        saved = {model: list(model.objects.order_by("pk").values()) for model in models}
        second = self.run_import(self.tax_id_payload(second_id))
        self.assertEqual(second.outcome, "linked")
        self.assertEqual(second.issues, [])
        self.assertEqual(second.receipt.pk, first.receipt.pk)
        self.assertEqual(second.image.receipt_id, first.receipt.pk)
        for model in models:
            self.assertEqual(list(model.objects.order_by("pk").values()), saved[model], model.__name__)
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Receipt.objects.count()), (1, 1, 1))
        self.assertEqual(ReceiptImage.objects.filter(receipt=first.receipt).count(), 2)
        self.assertEqual((ReceiptLine.objects.count(), ReceiptDiscount.objects.count(), ReceiptTax.objects.count(),
                          Product.objects.count(), ProductAlias.objects.count()), (4, 1, 2, 3, 3))
        merchant = Merchant.objects.get()
        self.assertEqual((merchant.tax_id, merchant.tax_id_type), ("DE999999994", "vat_id"))

    def test_tax_id_then_absent_links_weak_receipt_without_changes(self):
        self.assert_tax_id_completeness_links_weak_receipt("DE999999994", None)

    def test_absent_then_tax_id_links_weak_receipt_without_changes(self):
        self.assert_tax_id_completeness_links_weak_receipt(None, "DE999999994")

    def test_different_nonempty_tax_ids_do_not_link_weak_receipts(self):
        first = self.run_import(self.tax_id_payload("DE999999994"))
        second = self.run_import(self.tax_id_payload("DE999999995"))
        self.assertEqual((first.outcome, second.outcome), ("created", "created"))
        self.assertNotEqual(first.receipt.pk, second.receipt.pk)
        self.assertNotEqual(first.receipt.store_id, second.receipt.store_id)
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Receipt.objects.count()), (2, 2, 2))
        self.assertIn({"code": "merchant_conflict", "field": "/merchant/tax_id",
                       "message": "Результат требует проверки."}, second.issues)
        self.assertEqual(first.receipt.store.merchant.tax_id, "DE999999994")

    def test_missing_tax_id_with_multiple_known_sellers_requires_review(self):
        self.run_import(self.tax_id_payload("DE999999994"))
        self.run_import(self.tax_id_payload("DE999999995"))
        models = (Merchant, Store, Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax, ProductAlias)
        before = {model: list(model.objects.order_by("pk").values()) for model in models}
        result = self.run_import(self.tax_id_payload(None))
        self.assertEqual((result.outcome, result.image.status), ("needs_review", "needs_review"))
        self.assertIsNone(result.receipt)
        self.assertIsNone(result.image.receipt_id)
        self.assertEqual(result.issues[0]["code"], "store_ambiguous")
        self.assertIsNotNone(result.image.normalized_result)
        for model in models:
            self.assertEqual(list(model.objects.order_by("pk").values()), before[model], model.__name__)

    def test_new_tax_id_with_multiple_blank_sellers_requires_review(self):
        first = self.run_import(self.tax_id_payload(None))
        merchant = Merchant.objects.create(country_id="DE", legal_name=first.receipt.store.merchant.legal_name)
        Store.objects.create(merchant=merchant, country_id="DE", name=first.receipt.store.name,
                             address_raw=first.receipt.store.address_raw, timezone="Europe/Berlin")
        result = self.run_import(self.tax_id_payload("DE999999994"))
        self.assertEqual(result.outcome, "needs_review")
        self.assertEqual(result.issues[0]["code"], "store_ambiguous")
        self.assertEqual(Merchant.objects.filter(tax_id="").count(), 2)
        self.assertEqual((Store.objects.count(), Receipt.objects.count(), ReceiptLine.objects.count()), (2, 1, 4))

    def test_tax_id_completion_is_rolled_back_when_timestamp_requires_review(self):
        first = self.run_import(self.tax_id_payload(None))
        data = self.tax_id_payload("DE999999994")
        data.update(purchased_on="2026-10-25", local_time="02:30:00")
        data["timestamps"]["header"].update(date=data["purchased_on"], time=data["local_time"])
        result = self.run_import(data)
        self.assertEqual(result.outcome, "needs_review")
        self.assertEqual(result.issues[0]["code"], "timestamp_ambiguous")
        first.receipt.store.merchant.refresh_from_db()
        self.assertEqual(first.receipt.store.merchant.tax_id, "")
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Receipt.objects.count()), (1, 1, 1))

    def test_missing_currency_and_new_tax_id_resolve_existing_store(self):
        first = self.run_import(self.tax_id_payload(None))
        data = self.tax_id_payload("DE999999994")
        data["currency_code"] = None
        result = self.run_import(data)
        self.assertEqual(result.outcome, "linked")
        self.assertEqual(result.receipt.pk, first.receipt.pk)
        self.assertIn("currency_inferred", [v["code"] for v in result.issues])
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Receipt.objects.count()), (1, 1, 1))

    def test_optional_invalid_fields_import_and_do_not_create_tax_or_false_product_facts(self):
        payload = receipt_payload()
        payload["taxes"][0].update(net="3.00")
        payload["lines"][3].update(parent_position=999)
        payload["discounts"][0].update(line_position=999)
        payload["merchant"].update(tax_id="INVALID", tax_id_type="vat_id")
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.lines.count(), 4)
        self.assertEqual(result.receipt.taxes.count(), 0)
        self.assertIsNone(result.receipt.lines.get(position=4).parent_id)
        self.assertIsNone(result.receipt.discounts.get().line_id)
        self.assertEqual(result.receipt.store.merchant.tax_id, "")
        self.assertTrue(result.issues)

    def test_uncertain_numbers_and_fiscal_use_exact_weak_key_for_new_photo(self):
        obs = observation()
        uncertain = {"/receipt_number", "/register_code", "/shift_number", "/fiscal/register_serial"}
        obs = replace(obs, fields=tuple(replace(f, status="ambiguous") if f.path in uncertain else f for f in obs.fields))
        image, job = live_image()
        first = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        image, job = live_image()
        second = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        self.assertEqual((first.outcome, second.outcome), ("created", "linked"))
        self.assertEqual(first.receipt.pk, second.receipt.pk)
        self.assertEqual((first.receipt.fiscal_key, first.receipt.receipt_number), ("", ""))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (1, 4, 3))
        different = another_receipt()
        different["receipt_number"] = different["shift_number"] = different["register_code"] = None
        different["fiscal"] = {k: None for k in different["fiscal"]}
        self.assertEqual(self.run_import(different).outcome, "created")
        self.assertEqual(Receipt.objects.count(), 2)

    def test_two_complete_number_keys_conflict_at_same_weak_identity(self):
        payload = receipt_payload()
        payload["fiscal"] = {k: None for k in payload["fiscal"]}
        first = self.run_import(payload)
        payload["receipt_number"] = "OTHER-NUMBER"
        second = self.run_import(payload)
        self.assertEqual(second.outcome, "needs_review")
        self.assertIsNone(second.receipt)
        self.assertEqual(second.issues[0]["code"], "identity_conflict")
        self.assertEqual(Receipt.objects.count(), 1)
        first.receipt.refresh_from_db()
        self.assertEqual(first.receipt.receipt_number, "000123")

    def test_rounding_cent_is_nonblocking_but_gross_total_mismatch_blocks(self):
        payload = receipt_payload()
        payload["total"] = "4.43"
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.total, Decimal("4.43"))
        self.assertIn("receipt_invalid", [v["code"] for v in result.issues])
        payload = another_receipt()
        payload["total"] = "5.00"
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "needs_review")
        self.assertIsNone(result.receipt)
        self.assertEqual(Receipt.objects.count(), 1)

    def test_same_receipt_new_photo_links_without_duplicate_graph(self):
        first = self.run_import()
        ids = list(first.receipt.lines.values_list("pk", flat=True))
        second = self.run_import()
        self.assertEqual(second.outcome, "linked")
        self.assertEqual(second.receipt.pk, first.receipt.pk)
        self.assertEqual(list(second.receipt.lines.values_list("pk", flat=True)), ids)
        self.assertEqual((Receipt.objects.count(), Product.objects.count(), ProductAlias.objects.count()), (1, 3, 3))
        self.assertEqual((ReceiptDiscount.objects.count(), ReceiptTax.objects.count()), (1, 2))
        self.assertEqual(second.image.job.reused_count, 1)

    def test_replay_terminal_crop_is_immutable_and_does_not_bump_version(self):
        first = self.run_import()
        replay = import_receipt(first.image, observation(another_receipt()),
                                run_token=first.image.job.run_token, version=first.job_version)
        self.assertEqual(replay.outcome, "created")
        self.assertEqual(replay.job_version, first.job_version)
        self.assertEqual(replay.image.normalized_result, first.image.normalized_result)
        self.assertEqual(Receipt.objects.count(), 1)

    def test_exact_time_total_links_across_key_levels(self):
        partial = receipt_payload()
        partial["receipt_number"] = partial["shift_number"] = partial["register_code"] = None
        partial["fiscal"] = {key: None for key in partial["fiscal"]}
        first = self.run_import(partial)
        second = self.run_import()
        self.assertEqual(second.outcome, "updated")
        self.assertEqual(second.receipt.pk, first.receipt.pk)
        self.assertEqual(second.receipt.receipt_number, "000123")
        self.assertEqual(second.receipt.fiscal_key, "de:TEST-KASSE-02:98765")
        self.assertEqual(second.receipt.lines.count(), 4)

    def test_incomplete_header_and_unassigned_product_are_completed(self):
        first = self.run_import()
        receipt = first.receipt
        Receipt.objects.filter(pk=receipt.pk).update(receipt_number="", register_code="", shift_number="", raw_text="")
        receipt.lines.filter(position=1).update(product=None)
        second = self.run_import()
        self.assertEqual(second.outcome, "updated")
        self.assertEqual(second.receipt.pk, receipt.pk)
        self.assertEqual(second.receipt.receipt_number, "000123")
        self.assertIsNotNone(second.receipt.lines.get(position=1).product_id)
        self.assertEqual(Product.objects.count(), 3)

    def test_same_goods_in_another_receipt_reuse_products_and_aliases(self):
        first = self.run_import()
        second = self.run_import(another_receipt())
        self.assertEqual(second.outcome, "created")
        self.assertNotEqual(second.receipt.pk, first.receipt.pk)
        self.assertEqual(Product.objects.count(), 3)
        self.assertEqual(ProductAlias.objects.count(), 3)
        self.assertEqual(Store.objects.count(), 1)

    def test_ambiguous_good_imports_null_product_with_nonblocking_notice(self):
        category = Category.objects.create(name="Молочные продукты")
        generic = GenericProduct.objects.create(category=category, name="Молоко", base_unit="l")
        for qty in ("1.000", "2.000"):
            Product.objects.create(generic=generic, name="MILCH 1 L", package_quantity=qty, package_unit="l")
        result = self.run_import()
        self.assertEqual(result.outcome, "created")
        self.assertIsNotNone(result.receipt)
        self.assertEqual(result.image.import_effect, "created")
        self.assertIsNone(result.receipt.lines.get(position=1).product_id)
        self.assertIn("product_ambiguous", [v["code"] for v in result.issues])
        self.assertEqual(Product.objects.count(), 4)
        self.assertEqual(ProductAlias.objects.count(), 2)

    def test_later_alias_completes_previously_ambiguous_line(self):
        category = Category.objects.create(name="Молочные продукты")
        generic = GenericProduct.objects.create(category=category, name="Молоко", base_unit="l")
        first_product = Product.objects.create(generic=generic, name="MILCH 1 L", package_quantity="1.000", package_unit="l")
        Product.objects.create(generic=generic, name="MILCH 1 L", package_quantity="2.000", package_unit="l")
        first = self.run_import()
        ProductAlias.objects.create(merchant=first.receipt.store.merchant, product=first_product,
                                    name_key="milch 1 l", raw_name="MILCH 1 L")
        second = self.run_import()
        self.assertEqual(second.outcome, "updated")
        self.assertEqual(second.receipt.lines.get(position=1).product, first_product)
        self.assertEqual(Receipt.objects.count(), 1)

    def test_filled_header_line_and_products_are_never_replaced(self):
        first = self.run_import()
        payload = receipt_payload()
        payload["total"] = "4.62"
        payload["discount_total"] = "0.00"
        payload["discounts"] = []
        payload["lines"][0]["discount_amount"] = "0.00"
        payload["taxes"][0]["net"] = "3.36"
        payload["raw_text"] = "A new photograph"
        second = self.run_import(payload)
        self.assertEqual(second.outcome, "linked")
        self.assertEqual(second.receipt.pk, first.receipt.pk)
        self.assertEqual(second.image.import_effect, "linked")
        self.assertIn("receipt_conflict", [v["code"] for v in second.issues])
        first.receipt.refresh_from_db()
        self.assertEqual(first.receipt.total, Decimal("4.42"))
        self.assertEqual(first.receipt.raw_text, receipt_payload()["raw_text"])
        self.assertEqual(first.receipt.discounts.count(), 1)
        self.assertEqual(first.receipt.lines.get(position=1).discount_amount, Decimal("0.20"))
        self.assertEqual(second.image.normalized_result["total"], "4.62")

    def test_changed_line_composition_does_not_append_or_create_goods(self):
        first = self.run_import()
        payload = receipt_payload()
        payload["lines"][0]["raw_name"] = "CHANGED PRODUCT"
        payload["lines"][0]["product_hint"]["name"] = "CHANGED PRODUCT"
        second = self.run_import(payload)
        self.assertEqual(second.outcome, "linked")
        self.assertEqual(second.image.import_effect, "linked")
        self.assertEqual(Product.objects.count(), 3)
        self.assertEqual(first.receipt.lines.get(position=1).raw_name, "MILCH 1 L")

    def test_two_different_fiscal_keys_at_same_time_are_not_merged(self):
        first = self.run_import()
        payload = receipt_payload()
        payload["fiscal"]["tse_transaction"] = "OTHER-TRANSACTION"
        second = self.run_import(payload)
        self.assertEqual(second.outcome, "needs_review")
        self.assertIsNone(second.receipt)
        self.assertIn("identity_conflict", [v["code"] for v in second.issues])
        self.assertEqual(Receipt.objects.count(), 1)
        self.assertEqual(first.receipt.recognition_images.count(), 1)

    def test_incomplete_or_inconsistent_observation_preserved_without_domain_rows(self):
        mutations = [
            lambda p: p.update(total=None),
            lambda p: p.update(purchased_on=None),
            lambda p: (p["merchant"].update(legal_name=None, brand_name=None), p["store"].update(name=None)),
            lambda p: p.update(lines=[]),
            lambda p: p.update(local_time=None),
            lambda p: p["lines"][0].update(quantity=None, unit_price=None, amount=None),
            lambda p: p.update(total="123.45"),
            lambda p: p["lines"][0].update(quantity="-2.000", amount="-2.58"),
            lambda p: p.update(currency_code="XTS"),
        ]
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                payload = receipt_payload()
                mutate(payload)
                result = self.run_import(payload)
                self.assertEqual(result.outcome, "needs_review")
                self.assertIsNone(result.receipt)
                self.assertTrue(result.issues)
                self.assertIsNotNone(result.image.normalized_result)
                self.assert_no_domain()

    def test_country_can_be_inferred_from_currency(self):
        payload = receipt_payload()
        payload["merchant"]["country_code"] = payload["store"]["country_code"] = None
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.store.country_id, "DE")
        self.assertEqual(result.receipt.extra["recognition"]["country_source"], "fallback")

    def test_missing_currency_uses_country_of_existing_store_and_reuses_receipt(self):
        first = self.run_import()
        payload = receipt_payload()
        payload["currency_code"] = None
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "linked")
        self.assertEqual(result.receipt.pk, first.receipt.pk)
        self.assertEqual(result.receipt.currency_id, "EUR")
        self.assertIsNone(result.image.normalized_result["currency_code"])
        self.assertIn("currency_inferred", [v["code"] for v in result.issues])
        self.assertEqual((Receipt.objects.count(), Store.objects.count()), (1, 1))

    def test_missing_currency_does_not_guess_for_unresolved_new_store(self):
        payload = receipt_payload()
        payload["currency_code"] = None
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "needs_review")
        self.assert_no_domain()

    def test_currency_inference_for_new_receipt_records_provenance_and_printed_currency_wins(self):
        self.run_import()
        payload = another_receipt()
        payload["currency_code"] = None
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.currency_id, "EUR")
        self.assertIn("/currency_code", result.receipt.extra["recognition"]["derived"])
        payload = another_receipt()
        payload["currency_code"] = "RUB"
        payload["local_time"] = payload["timestamps"]["header"]["time"] = "17:00:00"
        payload["receipt_number"] = "000125"
        payload["fiscal"]["tse_transaction"] = "98767"
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.currency_id, "RUB")

    def test_null_ambiguous_quantity_can_be_recovered_from_two_observed_numbers(self):
        obs = observation()
        obs = replace(obs, lines=(replace(obs.lines[0], quantity=None),) + obs.lines[1:],
                      fields=tuple(replace(f, status="ambiguous") if f.path == "/lines/0/quantity" else f
                                   for f in obs.fields))
        image, job = live_image()
        result = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.lines.get(position=1).quantity, Decimal("2.000"))
        self.assertIsNone(result.image.normalized_result["lines"][0]["quantity"])

    def test_missing_line_quantity_is_derived_from_printed_price_and_amount(self):
        payload = receipt_payload()
        payload["lines"][0]["quantity"] = None
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.lines.get(position=1).quantity, Decimal("2.000"))
        self.assertIn("/lines/0/quantity", result.receipt.extra["recognition"]["derived"])
        self.assertIsNone(result.image.normalized_result["lines"][0]["quantity"])
        self.assertEqual(validate_receipt(result.receipt), [])

    def test_missing_line_price_is_derived_from_printed_quantity_and_amount(self):
        payload = receipt_payload()
        payload["lines"][0]["unit_price"] = None
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.lines.get(position=1).unit_price, Decimal("1.2900"))
        self.assertIn("/lines/0/unit_price", result.receipt.extra["recognition"]["derived"])
        self.assertEqual(validate_receipt(result.receipt), [])

    def test_missing_line_amount_is_derived_from_printed_quantity_and_price(self):
        payload = receipt_payload()
        payload["lines"][0]["amount"] = None
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.lines.get(position=1).amount, Decimal("2.58"))
        self.assertIn("/lines/0/amount", result.receipt.extra["recognition"]["derived"])
        self.assertEqual(validate_receipt(result.receipt), [])

    def test_piece_unit_default_does_not_guess_weighted_or_uncertain_unit(self):
        payload = receipt_payload()
        payload["lines"][0]["unit"] = None
        obs = observation(payload)
        obs = replace(obs, fields=obs.fields + (FieldObservation("/lines/0/unit", "absent", None, None),))
        image, job = live_image()
        result = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.lines.get(position=1).unit, "pcs")
        self.assertIn("/lines/0/unit", result.receipt.extra["recognition"]["derived"])
        payload = another_receipt()
        payload["lines"][1]["unit"] = None
        payload["lines"][1]["raw_name"] = "WEIGHTED / kg"
        self.assertEqual(self.run_import(payload).outcome, "needs_review")

    def test_clipped_but_readable_receipt_imports_with_notice(self):
        result = self.run_import(clipped=True)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.issues[0]["code"], "clipped")
        self.assertEqual(result.receipt.lines.count(), 4)

    def test_secondary_validator_warning_preserves_import_and_hides_facts(self):
        rates_before = TaxRate.objects.count()
        with patch.object(importer, "validate_receipt", return_value=["PRIVATE: detail"]):
            result = self.run_import()
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.lines.count(), 4)
        self.assertEqual(TaxRate.objects.count(), rates_before)
        self.assertNotIn("PRIVATE", str(result.issues))
        self.assertEqual(result.image.normalized_result["total"], "4.42")

    def test_database_failure_rolls_back_and_saves_safe_failed_result(self):
        original = importer.clean_save

        def fail_on_discount(obj):
            if isinstance(obj, ReceiptDiscount):
                raise IntegrityError("PRIVATE: DSN and provider text")
            return original(obj)

        with patch.object(importer, "clean_save", side_effect=fail_on_discount):
            result = self.run_import()
        self.assertEqual(result.outcome, "failed")
        self.assert_no_domain()
        self.assertEqual(result.image.import_effect, "none")
        self.assertNotIn("PRIVATE", str(result.issues))
        self.assertEqual(result.image.job.failed_count, 1)

    def test_cancelled_stale_and_expired_fences_write_nothing(self):
        for mode in ("cancel", "stale", "lease", "deadline"):
            with self.subTest(mode=mode):
                image, job = live_image()
                if mode == "cancel":
                    request_cancel(job.pk)
                elif mode == "lease":
                    ProcessingJob.objects.filter(pk=job.pk).update(lease_expires_at=db_now() - timedelta(seconds=1))
                elif mode == "deadline":
                    ProcessingJob.objects.filter(pk=job.pk).update(processing_deadline_at=db_now() - timedelta(seconds=1))
                with self.assertRaises(FenceLost):
                    import_receipt(image, observation(), run_token=uuid.uuid4() if mode == "stale" else job.run_token,
                                   version=job.version)
                image.refresh_from_db()
                self.assertEqual(image.status, "pending")
                self.assertIsNone(image.normalized_result)
                self.assert_no_domain()

    def test_decimal_context_is_local_and_arithmetic_stays_exact(self):
        with localcontext() as context:
            context.prec = 3
            result = self.run_import()
            self.assertEqual(context.prec, 3)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(validate_receipt(result.receipt), [])

    def test_refund_and_deposit_return_negative_amounts(self):
        payload = receipt_payload(2)
        payload["operation"] = "refund"
        for line in payload["lines"]:
            line["quantity"] = "-" + line["quantity"]
            line["amount"] = "-" + line["amount"]
        payload["lines"][1]["kind"] = "deposit_return"
        payload["total"] = "-6.00"
        payload["taxes"][0].update(net="-5.61", tax="-0.39")
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.lines.get(position=2).kind, "deposit_return")
        self.assertIsNone(result.receipt.lines.get(position=2).product)
        self.assertEqual(Product.objects.count(), 1)
        self.assertEqual(validate_receipt(result.receipt), [])

    def test_absent_discount_values_are_derived_only_after_sum_validation(self):
        payload = receipt_payload()
        payload["discount_total"] = None
        for line in payload["lines"]:
            line["discount_amount"] = None
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.discount_total, Decimal("0.20"))
        self.assertEqual(result.receipt.lines.get(position=1).discount_amount, Decimal("0.20"))
        self.assertIsNone(result.image.normalized_result["discount_total"])

    def test_partial_review_then_better_photo_creates_one_receipt(self):
        payload = receipt_payload()
        payload["lines"][0].update(quantity=None, unit_price=None, amount=None)
        partial = self.run_import(payload)
        complete = self.run_import()
        self.assertEqual((partial.outcome, complete.outcome), ("needs_review", "created"))
        partial.image.refresh_from_db()
        self.assertEqual(partial.image.status, "needs_review")
        self.assertIsNone(partial.image.normalized_result["lines"][0]["quantity"])
        self.assertEqual(Receipt.objects.count(), 1)

    def test_ambiguous_line_fact_does_not_become_a_readable_line(self):
        image, job = live_image()
        obs = observation()
        obs = replace(obs, fields=tuple(replace(f, status="ambiguous") if f.path == "/lines/0/quantity" else f for f in obs.fields))
        result = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "needs_review")
        self.assertEqual(result.issues[0]["code"], "ambiguous_value")
        self.assert_no_domain()

    def test_ambiguous_product_hint_uses_readable_raw_name_without_guessing_hint(self):
        image, job = live_image()
        obs = observation()
        obs = replace(obs, fields=tuple(replace(f, status="ambiguous") if f.path == "/lines/0/product_hint/name" else f for f in obs.fields))
        result = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.issues[0]["code"], "optional_omitted")
        self.assertEqual(result.receipt.lines.get(position=1).product.name, "MILCH 1 L")
        self.assertEqual(Product.objects.count(), 3)

    def test_filled_product_reference_preserved_but_package_conflict_reported(self):
        first = self.run_import()
        product_id = first.receipt.lines.get(position=1).product_id
        payload = receipt_payload()
        payload["lines"][0]["product_hint"].update(package_quantity="2.000", package_unit="l")
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "linked")
        self.assertEqual(result.issues[0]["code"], "product_conflict")
        self.assertEqual(result.issues[0]["field"], "/lines/0/product_hint")
        self.assertEqual(result.receipt.lines.get(position=1).product_id, product_id)
        self.assertEqual(Product.objects.count(), 3)

    def test_conflicting_partial_fiscal_fields_do_not_create_inconsistent_key(self):
        payload = receipt_payload()
        payload["fiscal"]["tse_transaction"] = None
        first = self.run_import(payload)
        more = receipt_payload()
        more["fiscal"]["register_serial"] = "DIFFERENT-KASSE"
        result = self.run_import(more)
        self.assertEqual(result.outcome, "linked")
        self.assertEqual(result.receipt.fiscal_key, "")
        first.receipt.refresh_from_db()
        self.assertEqual(first.receipt.fiscal["register_serial"], "TEST-KASSE-02")

    def test_incomplete_number_is_not_filled_as_a_strong_identity(self):
        first = self.run_import()
        Receipt.objects.filter(pk=first.receipt.pk).update(receipt_number="", shift_number="", register_code="")
        other = another_receipt()
        other["receipt_number"] = "000123"
        other["register_code"] = None
        second = self.run_import(other)
        self.assertEqual(second.outcome, "created")
        incoming = receipt_payload()
        incoming["register_code"] = None
        result = self.run_import(incoming)
        self.assertEqual(result.outcome, "updated")
        self.assertEqual(result.image.import_effect, "updated")
        self.assertEqual(result.receipt.pk, first.receipt.pk)
        first.receipt.refresh_from_db()
        self.assertEqual(first.receipt.receipt_number, "")
        self.assertEqual(Receipt.objects.count(), 2)

    def test_partial_number_without_fiscal_key_uses_only_exact_time_total(self):
        payload = receipt_payload()
        payload["register_code"] = payload["shift_number"] = None
        payload["fiscal"] = {key: None for key in payload["fiscal"]}
        first = self.run_import(payload)
        second = self.run_import(payload)
        payload["local_time"] = "15:35:20"
        payload["timestamps"]["header"]["time"] = payload["local_time"]
        third = self.run_import(payload)
        self.assertEqual((first.outcome, second.outcome, third.outcome), ("created", "linked", "created"))
        self.assertEqual(first.receipt.pk, second.receipt.pk)
        self.assertNotEqual(first.receipt.pk, third.receipt.pk)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (2, 8, 3))
        self.assertEqual(first.receipt.receipt_number, "")
        self.assertEqual(first.image.normalized_result["receipt_number"], "000123")

    def test_global_fiscal_match_with_different_shop_does_not_leave_unused_store(self):
        first = self.run_import()
        payload = receipt_payload()
        payload["merchant"].update(legal_name="OTHER SYNTHETIC SELLER", brand_name="OTHER")
        payload["store"]["address_raw"] = "OTHER SYNTHETIC ADDRESS 12"
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "linked")
        self.assertEqual(result.receipt.pk, first.receipt.pk)
        self.assertEqual(result.issues[0]["field"], "/store")
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Product.objects.count()), (1, 1, 3))

    def test_new_tax_rate_requires_observed_kind_and_rate(self):
        payload = receipt_payload()
        payload["lines"][0]["tax_rate"]["rate"] = "9.00"
        obs = observation(payload)
        obs = replace(obs, fields=tuple(f for f in obs.fields if not f.path.startswith("/lines/0/tax_rate/")))
        image, job = live_image()
        result = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.issues[0]["code"], "optional_omitted")
        self.assertFalse(TaxRate.objects.filter(country="DE", rate="9.00").exists())
        self.assertIsNone(result.receipt.lines.get(position=1).tax_rate)

    def test_dropping_tax_row_keeps_original_evidence_for_later_confirmed_rate(self):
        payload = receipt_payload()
        payload["taxes"][0].update(net=None, tax=None)
        payload["taxes"][1].update(net="4.00", tax="0.42", gross="4.42")
        payload["taxes"][1]["tax_rate"]["rate"] = "10.50"
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.taxes.count(), 1)
        self.assertEqual(result.receipt.taxes.get().tax_rate.rate, Decimal("10.50"))
        self.assertEqual(validate_receipt(result.receipt), [])

    def test_conflicting_optional_merchant_tax_type_does_not_block_known_seller(self):
        payload = receipt_payload()
        payload["merchant"].update(tax_id="DE999999999", tax_id_type="other")
        first = self.run_import(payload)
        payload["merchant"]["tax_id_type"] = "vat_id"
        second = self.run_import(payload)
        self.assertEqual(second.outcome, "linked")
        self.assertEqual(second.receipt.pk, first.receipt.pk)
        self.assertIn("merchant_conflict", [v["code"] for v in second.issues])
        self.assertEqual(Merchant.objects.count(), 1)
        first.receipt.store.merchant.refresh_from_db()
        self.assertEqual(first.receipt.store.merchant.tax_id_type, "other")

    def test_unexpected_write_error_is_failed_with_no_partial_graph(self):
        original = importer.clean_save

        def fail_on_discount(obj):
            if isinstance(obj, ReceiptDiscount):
                raise RuntimeError("Private signal failure")
            return original(obj)

        with patch.object(importer, "clean_save", side_effect=fail_on_discount):
            result = self.run_import()
        self.assertEqual(result.outcome, "failed")
        self.assertEqual(result.issues[0]["code"], "import_failed")
        self.assertNotIn("Private", str(result.issues))
        self.assert_no_domain()


@tag("integration")
class ImportConcurrencyTests(TransactionTestCase):
    def setUp(self):
        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        self.obs = observation()
        self.media = TemporaryDirectory()
        self.addCleanup(self.media.cleanup)
        override = override_settings(MEDIA_ROOT=self.media.name)
        override.enable()
        self.addCleanup(override.disable)

    def threaded_import(self, image, job):
        close_old_connections()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid = cursor.fetchone()[0]
            return import_receipt(image, self.obs, run_token=job.run_token, version=job.version), pid
        finally:
            connections.close_all()

    def test_parallel_same_receipt_short_busy_then_link_on_another_connection(self):
        first_image, first_job = live_image()
        second_image, second_job = live_image()
        entered, release = Event(), Event()
        original = importer._create_graph

        def pause_create(*args):
            entered.set()
            if not release.wait(10):
                raise AssertionError("Import lock test did not release")
            return original(*args)

        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(importer, "_create_graph", side_effect=pause_create):
            first = pool.submit(self.threaded_import, first_image, first_job)
            try:
                self.assertTrue(entered.wait(10))
                second = pool.submit(self.threaded_import, second_image, second_job)
                with self.assertRaises(ImportBusy):
                    second.result(timeout=10)
                second_image.refresh_from_db()
                self.assertEqual(second_image.status, "pending")
            finally:
                release.set()
            created, first_pid = first.result(timeout=10)
            linked, second_pid = pool.submit(self.threaded_import, second_image, second_job).result(timeout=10)
        self.assertNotEqual(first_pid, second_pid)
        self.assertEqual((created.outcome, linked.outcome), ("created", "linked"))
        self.assertEqual(created.receipt.pk, linked.receipt.pk)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (1, 4, 3))
        self.assertEqual((ProductAlias.objects.count(), ReceiptDiscount.objects.count(), ReceiptTax.objects.count()), (3, 1, 2))

    def test_cancel_commits_before_import_and_late_result_cannot_resurrect(self):
        image, job = live_image()
        with ThreadPoolExecutor(max_workers=1) as pool:
            def cancel():
                close_old_connections()
                try:
                    return request_cancel(job.pk)
                finally:
                    connections.close_all()
            pool.submit(cancel).result(timeout=10)
            with self.assertRaises(FenceLost):
                pool.submit(self.threaded_import, image, job).result(timeout=10)
        self.assertEqual(Receipt.objects.count(), 0)
        self.assertEqual(Store.objects.count(), 0)
        image.refresh_from_db()
        self.assertIsNone(image.normalized_result)

    def test_known_unique_race_with_external_writer_is_reread_and_linked(self):
        # Store is committed and visible to the independent ORM writer. The
        # writer deliberately bypasses the recognition advisory mutex.
        resolve_store(self.obs, resolve_country(self.obs))
        image, job = live_image()
        original = importer.clean_save
        raced = []

        def external_writer():
            close_old_connections()
            try:
                with transaction.atomic():
                    effective, derived = importer._domain_observation(self.obs)
                    return importer._import_domain(effective, derived)[0].pk
            finally:
                connections.close_all()

        def concurrent_save(obj):
            if isinstance(obj, Receipt) and obj.pk is None and not raced:
                raced.append(True)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pool.submit(external_writer).result(timeout=10)
            return original(obj)

        with patch.object(importer, "clean_save", side_effect=concurrent_save):
            result = import_receipt(image, self.obs, run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "linked")
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (1, 4, 3))

    def test_mutex_is_distinct_from_category_lock(self):
        from catalog.admin import CATEGORY_TREE_LOCK
        image, job = live_image()
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_xact_lock(%s, %s)", CATEGORY_TREE_LOCK)
            self.assertTrue(cursor.fetchone()[0])
            with ThreadPoolExecutor(max_workers=1) as pool:
                result, _ = pool.submit(self.threaded_import, image, job).result(timeout=10)
                self.assertEqual(result.outcome, "created")
