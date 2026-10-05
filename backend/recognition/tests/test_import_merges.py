"""Duplicate search right after a receipt import (``PRODUCT_MERGE_AUTO_DETECT``). Fake payloads only."""
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.db import IntegrityError
from django.test import TestCase, override_settings, tag

from catalog.models import Product
from merges import services
from merges.models import ProductMerge, ProductMergeMember
from receipts.models import ProductAlias, Receipt, ReceiptLine
from recognition.importer import import_receipt
from recognition.providers.fake import receipt_payload

from .import_fixtures import live_image, observation

FIRST, SECOND, THIRD = "Steinhof.PizzaSpezial", "Steinof.PizzaSpezial", "Steinhof PizzaSpezial"


def payload(name, number):
    """The fictional receipt with its first line printed as ``name``; ``number`` makes the receipt distinct."""
    data = receipt_payload()
    data["lines"][0]["raw_name"] = name
    data["lines"][0]["product_hint"]["name"] = name
    data["receipt_number"] = f"00020{number}"
    data["fiscal"]["tse_transaction"] = f"9900{number}"
    data["local_time"] = f"15:0{number}:00"
    data["timestamps"]["header"]["time"] = data["local_time"]
    return data


class ImportMergeTestCase(TestCase):
    def setUp(self):
        media = TemporaryDirectory(prefix="checkist-merge-import-")
        self.addCleanup(media.cleanup)
        settings = override_settings(MEDIA_ROOT=media.name)
        settings.enable()
        self.addCleanup(settings.disable)

    def run_import(self, name, number):
        image, job = live_image()
        result = import_receipt(image, observation(payload(name, number)), run_token=job.run_token, version=job.version)
        self.assertEqual((result.outcome, result.image.status), ("created", "imported"), result.issues)
        return result

    def product_of(self, receipt):
        return receipt.lines.get(position=1).product


@tag("integration")
@override_settings(PRODUCT_MERGE_AUTO_DETECT=False)
class FlagOffTests(ImportMergeTestCase):
    def test_import_behaves_as_before(self):
        first, second = self.run_import(FIRST, 1), self.run_import(SECOND, 2)
        self.assertEqual(ProductMerge.objects.count(), 0)
        self.assertEqual(ProductMergeMember.objects.count(), 0)
        self.assertNotEqual(self.product_of(first.receipt), self.product_of(second.receipt))
        self.assertEqual(Product.objects.filter(name__in=(FIRST, SECOND)).count(), 2)
        self.assertEqual(self.product_of(second.receipt).name, SECOND)
        with patch.object(services, "detect", side_effect=AssertionError("must not be called")):
            self.run_import(THIRD, 3)
        # A manual run finds what the imports left apart.
        result = services.detect()
        self.assertEqual((result.created, len(result.group_ids)), (1, 1))
        self.assertEqual(ProductMerge.objects.get().members.count(), 3)


@tag("integration")
@override_settings(PRODUCT_MERGE_AUTO_DETECT=True)
class FlagOnTests(ImportMergeTestCase):
    def test_new_spelling_joins_a_group_right_after_the_import(self):
        first = self.run_import(FIRST, 1)
        self.assertEqual(ProductMerge.objects.count(), 0)  # one spelling is not a duplicate
        target = self.product_of(first.receipt)

        second = self.run_import(SECOND, 2)
        group = ProductMerge.objects.get()
        self.assertEqual((group.status, group.version, group.target_ref), ("pending", 1, target.pk))
        absorbed = Product.objects.get(name=SECOND)
        self.assertEqual(
            dict(group.members.values_list("product_ref", "role")), {target.pk: "target", absorbed.pk: "source"},
        )
        # The line of the new receipt and its alias already point at the surviving product.
        self.assertEqual(self.product_of(second.receipt), target)
        self.assertEqual(set(ProductAlias.objects.filter(product=target).values_list("raw_name", flat=True)),
                         {FIRST, SECOND})
        self.assertFalse(ReceiptLine.objects.filter(product=absorbed).exists())
        self.assertEqual(second.image.outcome_snapshot, {"receipt_id": second.receipt.pk})
        # Nothing but product_id changed on the imported lines.
        self.assertEqual(second.receipt.lines.count(), 4)
        self.assertEqual(second.receipt.lines.get(position=1).raw_name, SECOND)

        third = self.run_import(THIRD, 3)
        group.refresh_from_db()
        self.assertEqual((ProductMerge.objects.count(), group.version, group.members.count()), (1, 2, 3))
        self.assertEqual(self.product_of(third.receipt), target)

        # A known spelling resolves through the moved alias: no new product, the group is unchanged.
        products = Product.objects.count()
        fourth = self.run_import(SECOND, 4)
        group.refresh_from_db()
        self.assertEqual((Product.objects.count(), group.version), (products, 2))
        self.assertEqual(self.product_of(fourth.receipt), target)
        self.assertEqual(services.describe_group(group).new_lines_count, 1)

    def test_other_products_of_the_receipt_are_not_merged(self):
        self.run_import(FIRST, 1)
        self.run_import("Demo Joghurt 3,5%", 2)
        self.run_import("Demo Joghurt 1,5%", 3)
        self.assertEqual(ProductMerge.objects.count(), 0)

    def test_failed_step_does_not_cancel_the_import(self):
        self.run_import(FIRST, 1)
        with patch.object(services, "detect", side_effect=RuntimeError("PRIVATE DETAIL")), \
                self.assertLogs("recognition.importer", level="ERROR") as logs:
            result = self.run_import(SECOND, 2)
        self.assertEqual(logs.output, [
            "ERROR:recognition.importer:Product merge detection after import failed: RuntimeError",
        ])
        self.assertEqual(Receipt.objects.count(), 2)
        self.assertEqual(result.receipt.lines.count(), 4)
        self.assertEqual(self.product_of(result.receipt).name, SECOND)
        self.assertEqual(ProductMerge.objects.count(), 0)
        # The next run catches up.
        self.assertEqual(services.detect().created, 1)

    def test_database_error_inside_the_step_rolls_back_only_its_savepoint(self):
        self.run_import(FIRST, 1)
        original = services._absorb

        def broken(*args, **kwargs):
            original(*args, **kwargs)  # the links are already moved inside the savepoint
            raise IntegrityError("PRIVATE DETAIL")

        with patch.object(services, "_absorb", broken), \
                self.assertLogs("recognition.importer", level="ERROR") as logs:
            result = self.run_import(SECOND, 2)
        self.assertEqual(len(logs.output), 1)
        self.assertNotIn("PRIVATE", logs.output[0])
        self.assertEqual((ProductMerge.objects.count(), ProductMergeMember.objects.count()), (0, 0))
        self.assertEqual(self.product_of(result.receipt).name, SECOND)
        self.assertEqual(result.image.status, "imported")
        self.assertEqual(result.image.receipt_id, result.receipt.pk)

    def test_needs_review_does_not_run_the_step(self):
        data = payload(FIRST, 1)
        data["total"] = "999.99"
        image, job = live_image()
        with patch.object(services, "detect", side_effect=AssertionError("must not be called")):
            result = import_receipt(image, observation(data), run_token=job.run_token, version=job.version)
        self.assertEqual((result.outcome, result.receipt), ("needs_review", None))
