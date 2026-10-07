"""Queueing a generic product suggestion right after an import (``PRODUCT_CLASSIFICATION_AUTO_SUGGEST``).

The import only writes a row of the classification queue; the model is asked
later by the worker. Fake payloads and the fake classifier only.
"""
from unittest.mock import patch

from django.db import IntegrityError
from django.test import TestCase, override_settings, tag

from catalog.models import Product
from classification import queue as classification_queue
from classification import services
from classification.classifier import FakeClassifier
from classification.models import ClassificationRun, ProductClassification
from classification.worker import process_batch
from merges.models import ProductMerge
from receipts.models import Receipt, ReceiptLine
from recognition import review
from recognition.importer import import_receipt
from recognition.models import ProcessingJob

from .import_fixtures import live_image, observation
from .test_import_merges import FIRST, SECOND, ImportMergeTestCase, payload
from .test_review import body_of, fixed_body, review_image, wrong_total

LOG = "ERROR:recognition.importer:Product classification request after import failed: {}"


def product_ids(receipt):
    return sorted(set(
        ReceiptLine.objects.filter(receipt=receipt, kind="product", product__isnull=False).values_list(
            "product_id", flat=True)
    ))


def generics():
    return dict(Product.objects.values_list("name", "generic__name"))


class ImportClassificationTestCase(ImportMergeTestCase):
    def suggest(self, scenario="new_category"):
        """What the worker does later: one batch of the queued run."""
        return process_batch(classification_queue.claim_run(), classifier=FakeClassifier(scenario))


@tag("integration")
@override_settings(PRODUCT_CLASSIFICATION_AUTO_SUGGEST=False, PRODUCT_MERGE_AUTO_DETECT=False, RECEIPT_OCR_PROVIDER="fake")
class FlagOffTests(ImportClassificationTestCase):
    def test_import_behaves_as_before(self):
        with patch.object(services, "request_run", side_effect=AssertionError("must not be called")):
            result = self.run_import(FIRST, 1)
        self.assertEqual(ClassificationRun.objects.count(), 0)
        self.assertEqual(set(generics().values()), {"Не разобрано"})
        # A manual run finds what the import left unclassified.
        run, created = services.request_run(trigger="manual")
        self.assertEqual((created, run.product_ids), (True, product_ids(result.receipt)))

    def test_confirmation_does_not_queue_either(self):
        with patch.object(services, "request_run", side_effect=AssertionError("must not be called")):
            review.confirm(review_image().pk, fixed_body())
        self.assertEqual((Receipt.objects.count(), ClassificationRun.objects.count()), (1, 0))


@tag("integration")
@override_settings(PRODUCT_CLASSIFICATION_AUTO_SUGGEST=True, PRODUCT_MERGE_AUTO_DETECT=False, RECEIPT_OCR_PROVIDER="fake")
class FlagOnTests(ImportClassificationTestCase):
    def test_import_queues_a_run_for_the_products_of_the_receipt(self):
        result = self.run_import(FIRST, 1)
        run = ClassificationRun.objects.get()
        self.assertEqual((run.status, run.trigger, run.scope, run.cursor), ("queued", "import", "products", 0))
        self.assertEqual(run.product_ids, product_ids(result.receipt))
        self.assertEqual((run.requested_count, len(run.product_ids)), (3, 3))  # the deposit line has no product
        self.assertEqual(result.receipt.lines.count(), 4)
        self.assertEqual((run.provider, run.model), ("fake", ""))
        # Nothing was asked and nothing changed yet.
        self.assertEqual(run.attempts.count(), 0)
        self.assertEqual(ProductClassification.objects.count(), 0)
        self.assertEqual(set(generics().values()), {"Не разобрано"})

    def test_next_import_joins_the_waiting_run(self):
        first = self.run_import(FIRST, 1)
        second = self.run_import("Demo Joghurt 3,5%", 2)
        run = ClassificationRun.objects.get()
        self.assertEqual(run.product_ids, sorted(set(product_ids(first.receipt)) | set(product_ids(second.receipt))))
        self.assertEqual(run.requested_count, 4)  # one new product; the other lines are the same products

    def test_job_and_receipt_do_not_depend_on_the_outcome_of_the_run(self):
        for scenario, status, code in (
            ("auth_failure", "failed", "auth_required"), ("provider_error", "failed", "provider_unavailable"),
            ("invalid_output", "failed", "invalid_output"), ("unknown", "succeeded", ""),
            ("new_category", "succeeded", ""),
        ):
            with self.subTest(scenario=scenario):
                image, job = live_image()
                number = Receipt.objects.count() + 1
                result = import_receipt(
                    image, observation(payload(f"Demo Ware {number}", number)), run_token=job.run_token,
                    version=job.version)
                self.assertEqual((result.outcome, result.image.status), ("created", "imported"), result.issues)
                job_before = ProcessingJob.objects.filter(pk=job.pk).values().get()
                image_before = type(result.image).objects.filter(pk=result.image.pk).values().get()
                receipts = list(Receipt.objects.order_by("pk").values())
                lines = list(ReceiptLine.objects.order_by("pk").values())
                catalog = generics()
                with patch("classification.runner._wait"):
                    run = self.suggest(scenario)
                self.assertEqual((run.status, run.error_code), (status, code))
                self.assertEqual(ProcessingJob.objects.filter(pk=job.pk).values().get(), job_before)
                self.assertEqual(type(result.image).objects.filter(pk=result.image.pk).values().get(), image_before)
                self.assertEqual(list(Receipt.objects.order_by("pk").values()), receipts)
                self.assertEqual(list(ReceiptLine.objects.order_by("pk").values()), lines)
                if scenario != "new_category":
                    # An unavailable model, its error and an invalid answer leave the catalog alone.
                    self.assertEqual(generics(), catalog)
                    self.assertEqual(ProductClassification.objects.count(), 0)

    def test_suggested_and_confirmed_products_survive_a_repeated_photo_and_a_new_import(self):
        first = self.run_import(FIRST, 1)
        run = self.suggest("new_category")
        self.assertEqual((run.status, run.applied_count), ("succeeded", 3))
        self.assertEqual(set(generics().values()), {"Тестовый продукт"})
        confirmed = ProductClassification.objects.order_by("pk").first()
        services.confirm(confirmed.pk, version=confirmed.version, generic_id=confirmed.suggested_generic_ref)
        catalog, records = generics(), list(ProductClassification.objects.order_by("pk").values())

        # The same receipt on another photo: found as a duplicate, nothing is queued.
        image, job = live_image()
        again = import_receipt(image, observation(payload(FIRST, 1)), run_token=job.run_token, version=job.version)
        self.assertEqual((again.receipt.pk, again.image.status), (first.receipt.pk, "reused"), again.issues)
        self.assertEqual(ClassificationRun.objects.count(), 1)

        # Another receipt with the same products and one new: only the new product is queued.
        second = self.run_import("Demo Joghurt 3,5%", 2)
        queued = ClassificationRun.objects.get(status="queued")
        new = Product.objects.get(name="Demo Joghurt 3,5%")
        self.assertEqual(queued.product_ids, [new.pk])
        self.assertEqual(self.suggest("existing").applied_count, 1)
        self.assertEqual({name: value for name, value in generics().items() if name != new.name}, catalog)
        self.assertEqual(
            list(ProductClassification.objects.exclude(product_ref=new.pk).order_by("pk").values()), records)
        self.assertEqual(second.image.status, "imported")
        # A manual run has nothing left either.
        self.assertEqual(services.request_run(trigger="manual"), (None, False))

    def test_failed_queueing_does_not_cancel_the_import(self):
        with patch.object(services, "request_run", side_effect=RuntimeError("PRIVATE DETAIL")), \
                self.assertLogs("recognition.importer", level="ERROR") as logs:
            result = self.run_import(FIRST, 1)
        self.assertEqual(logs.output, [LOG.format("RuntimeError")])
        self.assertEqual((Receipt.objects.count(), result.receipt.lines.count()), (1, 4))
        self.assertEqual((result.image.status, result.image.receipt_id), ("imported", result.receipt.pk))
        self.assertEqual(ClassificationRun.objects.count(), 0)
        # A manual run catches up.
        self.assertEqual(services.request_run(trigger="manual")[0].product_ids, product_ids(result.receipt))

    def test_database_error_inside_the_step_rolls_back_only_its_savepoint(self):
        original, calls = services.request_run, []

        def broken(**kwargs):
            calls.append(kwargs)
            original(**kwargs)  # the queue row is already written inside the savepoint
            raise IntegrityError("PRIVATE DETAIL")

        with patch.object(services, "request_run", broken), \
                self.assertLogs("recognition.importer", level="ERROR") as logs:
            result = self.run_import(FIRST, 1)
        self.assertEqual(logs.output, [LOG.format("IntegrityError")])
        self.assertEqual(len(calls), 2)  # one repeat, then the failure is reported
        self.assertEqual(ClassificationRun.objects.count(), 0)
        self.assertEqual((result.image.status, result.image.receipt_id), ("imported", result.receipt.pk))
        self.assertEqual(Receipt.objects.count(), 1)

    def test_lost_race_for_the_queued_place_is_repeated_once(self):
        original, calls = services.request_run, []

        def racing(**kwargs):
            calls.append(kwargs)
            if len(calls) == 1:
                raise IntegrityError("classification_run_one_queued")
            return original(**kwargs)

        with patch.object(services, "request_run", racing):
            result = self.run_import(FIRST, 1)
        self.assertEqual(calls[0], {"trigger": "import", "product_ids": product_ids(result.receipt)})
        self.assertEqual(ClassificationRun.objects.get().product_ids, product_ids(result.receipt))

    def test_needs_review_does_not_queue(self):
        data = payload(FIRST, 1)
        data["total"] = "999.99"
        image, job = live_image()
        with patch.object(services, "request_run", side_effect=AssertionError("must not be called")):
            result = import_receipt(image, observation(data), run_token=job.run_token, version=job.version)
        self.assertEqual((result.image.status, result.receipt), ("needs_review", None))
        self.assertEqual(ClassificationRun.objects.count(), 0)

    @override_settings(PRODUCT_MERGE_AUTO_DETECT=True)
    def test_duplicate_search_runs_first_and_absorbed_products_are_not_queued(self):
        first = self.run_import(FIRST, 1)
        run = ClassificationRun.objects.get()
        self.assertEqual(run.product_ids, product_ids(first.receipt))
        self.run_import(SECOND, 2)
        self.assertEqual(ProductMerge.objects.count(), 1)
        absorbed = Product.objects.get(name=SECOND)
        run.refresh_from_db()
        self.assertEqual(ClassificationRun.objects.count(), 1)
        self.assertNotIn(absorbed.pk, run.product_ids)
        self.assertEqual(run.product_ids, product_ids(first.receipt))

    def test_confirmation_of_a_crop_queues_a_run(self):
        image = review_image()
        review.confirm(image.pk, fixed_body())
        receipt = Receipt.objects.get()
        run = ClassificationRun.objects.get()
        self.assertEqual((run.status, run.trigger, run.scope), ("queued", "import", "products"))
        self.assertEqual(run.product_ids, product_ids(receipt))
        self.assertEqual(len(run.product_ids), 3)
        image.refresh_from_db()
        self.assertEqual((image.status, image.receipt_id), ("imported", receipt.pk))
        # The same request again is a replay: nothing more is queued.
        review.confirm(image.pk, fixed_body())
        self.assertEqual(ClassificationRun.objects.count(), 1)

    def test_refused_confirmation_queues_nothing(self):
        image = review_image(wrong_total(2))
        with patch.object(services, "request_run", side_effect=AssertionError("must not be called")), \
                self.assertRaises(review.ReviewInvalid):
            review.confirm(image.pk, body_of(wrong_total(2)))
        self.assertEqual((Receipt.objects.count(), ClassificationRun.objects.count()), (0, 0))

    def test_failed_queueing_keeps_the_confirmed_receipt(self):
        image = review_image()
        with patch.object(services, "request_run", side_effect=RuntimeError("PRIVATE")), \
                self.assertLogs("recognition.importer", level="ERROR") as logs:
            review.confirm(image.pk, fixed_body())
        self.assertEqual(logs.output, [LOG.format("RuntimeError")])
        image.refresh_from_db()
        job = ProcessingJob.objects.get(pk=image.job_id)
        self.assertEqual((image.status, job.status, Receipt.objects.count()), ("imported", "succeeded", 1))
        self.assertEqual(ClassificationRun.objects.count(), 0)
