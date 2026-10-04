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
from recognition.models import ProcessingJob, ReceiptImage
from recognition.providers.fake import receipt_payload
from recognition.queue import FenceLost, db_now, request_cancel
from recognition.resolution import resolve_country, resolve_store
from stores.models import Country, Currency, Merchant, Store, TaxRate
from .import_fixtures import another_receipt, live_image, observation


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

    def test_second_k1_receipt_is_independently_imported(self):
        self.run_import()
        result = self.run_import(receipt_payload(2))
        self.assertEqual(result.outcome, "created")
        self.assertEqual(result.receipt.total, Decimal("6.00"))
        self.assertEqual((Receipt.objects.count(), Store.objects.count(), Product.objects.count()), (2, 2, 5))

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

    def test_ambiguous_good_imports_null_product_and_review(self):
        category = Category.objects.create(name="Молочные продукты")
        generic = GenericProduct.objects.create(category=category, name="Молоко", base_unit="l")
        for qty in ("1.000", "2.000"):
            Product.objects.create(generic=generic, name="MILCH 1 L", package_quantity=qty, package_unit="l")
        result = self.run_import()
        self.assertEqual(result.outcome, "needs_review")
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
        self.assertEqual(second.outcome, "needs_review")
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
        self.assertEqual(second.outcome, "needs_review")
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
            lambda p: p.update(local_time=None),
            lambda p: p["lines"][0].update(quantity=None),
            lambda p: p.update(total="123.45"),
            lambda p: p["lines"][3].update(parent_position=999),
            lambda p: p["discounts"][0].update(line_position=999),
            lambda p: p["lines"][0].update(quantity="-2.000", amount="-2.58"),
            lambda p: p.update(currency_code="XTS"),
            lambda p: p["taxes"][0].update(net="3.00"),
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

    def test_clipped_receipt_is_not_imported(self):
        result = self.run_import(clipped=True)
        self.assertEqual(result.outcome, "needs_review")
        self.assertEqual(result.issues[0]["code"], "receipt_clipped")
        self.assert_no_domain()

    def test_validator_failure_rolls_back_all_domain_rows(self):
        rates_before = TaxRate.objects.count()
        with patch.object(importer, "validate_receipt", return_value=["PRIVATE: detail"]):
            result = self.run_import()
        self.assertEqual(result.outcome, "needs_review")
        self.assert_no_domain()
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
        payload["lines"][0]["quantity"] = None
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

    def test_ambiguous_product_hint_preserves_line_without_creating_product(self):
        image, job = live_image()
        obs = observation()
        obs = replace(obs, fields=tuple(replace(f, status="ambiguous") if f.path == "/lines/0/product_hint/name" else f for f in obs.fields))
        result = import_receipt(image, obs, run_token=job.run_token, version=job.version)
        self.assertEqual(result.outcome, "needs_review")
        self.assertEqual(result.issues[0]["code"], "product_ambiguous")
        self.assertIsNone(result.receipt.lines.get(position=1).product_id)
        self.assertEqual(Product.objects.count(), 2)

    def test_filled_product_reference_preserved_but_package_conflict_reported(self):
        first = self.run_import()
        product_id = first.receipt.lines.get(position=1).product_id
        payload = receipt_payload()
        payload["lines"][0]["product_hint"].update(package_quantity="2.000", package_unit="l")
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "needs_review")
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
        self.assertEqual(result.outcome, "needs_review")
        self.assertEqual(result.receipt.fiscal_key, "")
        first.receipt.refresh_from_db()
        self.assertEqual(first.receipt.fiscal["register_serial"], "TEST-KASSE-02")

    def test_empty_header_fill_that_collides_with_another_key_links_without_mutation(self):
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
        self.assertEqual(result.outcome, "needs_review")
        self.assertEqual(result.image.import_effect, "linked")
        self.assertEqual(result.receipt.pk, first.receipt.pk)
        first.receipt.refresh_from_db()
        self.assertEqual(first.receipt.receipt_number, "")
        self.assertEqual(Receipt.objects.count(), 2)

    def test_global_fiscal_match_with_different_shop_does_not_leave_unused_store(self):
        first = self.run_import()
        payload = receipt_payload()
        payload["merchant"].update(legal_name="OTHER SYNTHETIC SELLER", brand_name="OTHER")
        payload["store"]["address_raw"] = "OTHER SYNTHETIC ADDRESS 12"
        result = self.run_import(payload)
        self.assertEqual(result.outcome, "needs_review")
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
        self.assertEqual(result.outcome, "needs_review")
        self.assertEqual(result.issues[0]["code"], "tax_rate_unconfirmed")
        self.assertFalse(TaxRate.objects.filter(country="DE", rate="9.00").exists())
        self.assert_no_domain()

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
