"""A photo of a store merged into another (stores.merging) goes to the main store: the merged one is a spelling."""
from tempfile import TemporaryDirectory

from django.test import TestCase, override_settings, tag

from receipts import manual
from recognition.importer import import_receipt
from recognition.providers.fake import receipt_payload
from stores import merging

from .import_fixtures import live_image, observation


@tag("integration")
class MergedStoreImportTests(TestCase):
    def setUp(self):
        media = TemporaryDirectory()
        self.addCleanup(media.cleanup)
        settings = override_settings(MEDIA_ROOT=media.name)
        settings.enable()
        self.addCleanup(settings.disable)

    def run_import(self, data=None):
        image, job = live_image()
        return import_receipt(image, observation(data or receipt_payload(2)), run_token=job.run_token, version=job.version)

    def test_photos_of_a_merged_store_go_to_the_main_store(self):
        first = self.run_import()
        merged = first.receipt.store
        main = manual.find_or_create_store("Демо-главный магазин", "EUR")
        merging.merge(main.pk, [merged.pk])
        again = self.run_import()
        self.assertEqual(again.receipt.pk, first.receipt.pk)
        self.assertEqual(again.receipt.store_id, main.pk)
        # A new receipt of the merged store is a receipt of the main one.
        later = receipt_payload(2)
        later.update(receipt_number="000778", local_time="17:00:00")
        later["fiscal"]["tse_transaction"] = "12346"
        later["timestamps"]["header"]["time"] = "17:00:00"
        new = self.run_import(later)
        self.assertEqual(new.outcome, "created")
        self.assertEqual(new.receipt.store_id, main.pk)
        self.assertFalse(merged.receipts.exists())
