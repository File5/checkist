import uuid
from datetime import date

from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.models import ProtectedError
from django.test import TestCase, TransactionTestCase, tag
from django.utils import timezone

from catalog.models import Category, GenericProduct, Product
from receipts.models import Receipt, ReceiptLine
from recognition.models import ProcessingJob, ReceiptImage, RecognitionAttempt, SourcePhoto
from recognition.statuses import PROGRESS_FIELDS
from stores.models import Country, Currency, Merchant, Store

BOX = {"x_min": 0.1, "y_min": 0.1, "x_max": 0.9, "y_max": 0.9}


def make_photo(**fields):
    defaults = dict(original_file=f"originals/{uuid.uuid4()}/source.png", sha256=uuid.uuid4().hex * 2,
                    content_type="image/png", bytes=100, raw_width=100, raw_height=200, width=100, height=200)
    defaults.update(fields)
    return SourcePhoto.objects.create(**defaults)


def make_image(job, **fields):
    defaults = dict(photo=job.photo, job=job, position=1, file=f"crops/{uuid.uuid4()}/crop.png",
                    sha256="b" * 64, width=80, height=160, bbox=BOX)
    defaults.update(fields)
    return ReceiptImage.objects.create(**defaults)


def make_receipt():
    country, _ = Country.objects.get_or_create(code="XA", defaults={"name": "Synthetic country"})
    currency, _ = Currency.objects.get_or_create(code="XTS", defaults={"name": "Synthetic currency"})
    merchant = Merchant.objects.create(country=country, legal_name="Synthetic merchant")
    store = Store.objects.create(merchant=merchant, country=country, address_raw="Synthetic street 1", timezone="UTC")
    return Receipt.objects.create(store=store, currency=currency, operation="sale", purchased_at=timezone.now(),
                                  purchased_on=date(2026, 10, 4), total="4.00")


@tag("integration")
class RecognitionModelTests(TestCase):
    def setUp(self):
        self.photo = make_photo()
        self.job = ProcessingJob.objects.create(photo=self.photo)

    def rejected(self, constraint, operation):
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            operation()
        self.assertEqual(caught.exception.__cause__.diag.constraint_name, constraint)

    def test_unique_source_hash(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            make_photo(sha256=self.photo.sha256)

    def test_unique_storage_uuid(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            make_photo(storage_uuid=self.photo.storage_uuid)

    def test_source_limits(self):
        for fields, constraint in [
            ({"bytes": 0}, "rec_photo_bytes_check"), ({"bytes": 20971521}, "rec_photo_bytes_check"),
            ({"width": 0}, "rec_photo_pixels_check"), ({"raw_height": 0}, "rec_photo_pixels_check"),
            ({"width": 8001, "height": 5000}, "rec_photo_pixels_check"),
            ({"raw_width": 2000000000, "raw_height": 2000000000}, "rec_photo_pixels_check"),
            ({"content_type": "image/heic"}, "rec_photo_type_check"),
            ({"exif_orientation": 9}, "rec_photo_orientation_check"),
        ]:
            with self.subTest(fields=fields):
                self.rejected(constraint, lambda: make_photo(**fields))
        make_photo(bytes=20971520, raw_width=8000, raw_height=5000, width=8000, height=5000)

    def test_one_active_job_per_photo(self):
        self.rejected("rec_job_active_photo_uniq", lambda: ProcessingJob.objects.create(photo=self.photo))
        self.job.status = "failed"
        self.job.stage = "finished"
        self.job.finished_at = timezone.now()
        self.job.save()
        ProcessingJob.objects.create(photo=self.photo)

    def test_job_lifecycle_checks(self):
        for fields, constraint in [
            ({"stage": "unknown"}, "rec_job_stage_check"),
            ({"version": 0}, "rec_job_version_check"), ({"detected_count": 11}, "rec_job_detected_check"),
            ({"status": "succeeded"}, "rec_job_finished_check"),
            ({"status": "running"}, "rec_job_ownership_check"),
            ({"cancel_requested_at": timezone.now()}, "rec_job_cancel_check"),
            ({"current_position": 1}, "rec_job_position_check"),
        ]:
            with self.subTest(fields=fields):
                self.rejected(constraint, lambda: ProcessingJob.objects.filter(pk=self.job.pk).update(**fields))
        # Invalid status violates several independent lifecycle checks; PostgreSQL
        # is free to report any of them. The write must be rejected in all cases.
        with self.assertRaises(IntegrityError), transaction.atomic():
            ProcessingJob.objects.filter(pk=self.job.pk).update(status="unknown")

    def test_progress_bounds_including_null_detection(self):
        for field in PROGRESS_FIELDS:
            for fields in ({field: 1}, {"detected_count": 1, field: 2}, {"detected_count": 10, field: 11}):
                with self.subTest(fields=fields):
                    self.rejected(f"rec_job_{field}_check", lambda: ProcessingJob.objects.filter(pk=self.job.pk).update(**fields))
        ProcessingJob.objects.filter(pk=self.job.pk).update(detected_count=10, **{field: 10 for field in PROGRESS_FIELDS})

    def test_crop_checks_and_uniqueness(self):
        for fields, constraint in [({"position": 0}, "rec_image_position_check"), ({"position": 11}, "rec_image_position_check"),
                                   ({"width": 0}, "rec_image_pixels_check"), ({"status": "other"}, "rec_image_status_check"),
                                   ({"import_effect": "other"}, "rec_image_effect_check"), ({"rotation_degrees": float("nan")}, "rec_image_rotation_check")]:
            with self.subTest(fields=fields):
                self.rejected(constraint, lambda: make_image(self.job, **fields))
        image = make_image(self.job)
        self.rejected("rec_image_position_uniq", lambda: make_image(self.job))
        image.photo = make_photo()
        with self.assertRaises(ValidationError):
            image.clean()
        image.photo = self.photo
        image.bbox = {}
        with self.assertRaises(ValidationError):
            image.clean()

    def test_attempt_checks_null_uniqueness_and_image_membership(self):
        fields = dict(job=self.job, phase="detect", ordinal=1, run_token=uuid.uuid4(), provider="fake", schema_version="1", input_sha256=self.photo.sha256)
        RecognitionAttempt.objects.create(**fields)
        self.rejected("rec_attempt_ordinal_uniq", lambda: RecognitionAttempt.objects.create(**fields))
        fields["ordinal"] = 2
        self.rejected("rec_attempt_phase_check", lambda: RecognitionAttempt.objects.create(**{**fields, "phase": "recognize"}))
        self.rejected("rec_attempt_finished_check", lambda: RecognitionAttempt.objects.create(**{**fields, "status": "succeeded"}))
        other = ProcessingJob.objects.create(photo=make_photo())
        attempt = RecognitionAttempt(**{**fields, "phase": "recognize", "image": make_image(other)})
        with self.assertRaises(ValidationError):
            attempt.clean()

    def test_deletion_provenance_and_domain_receipt(self):
        receipt = make_receipt()
        image = make_image(self.job, receipt=receipt, outcome_snapshot={"receipt_id": receipt.pk})
        with self.assertRaises(ProtectedError):
            self.photo.delete()
        receipt_id = receipt.pk
        receipt.delete()
        image.refresh_from_db()
        self.assertIsNone(image.receipt_id)
        self.assertEqual(image.outcome_snapshot["receipt_id"], receipt_id)
        receipt = make_receipt()
        image.receipt = receipt
        image.save()
        self.job.delete()
        self.assertTrue(Receipt.objects.filter(pk=receipt.pk).exists())
        self.assertFalse(ReceiptImage.objects.filter(pk=image.pk).exists())


@tag("integration")
class RecognitionMigrationTests(TransactionTestCase):
    def test_reverse_reapply_preserves_existing_domain_data(self):
        receipt = make_receipt()
        category = Category.objects.create(name="Synthetic category")
        generic = GenericProduct.objects.create(name="Synthetic product", category=category, base_unit="pcs")
        product = Product.objects.create(name="Synthetic package", generic=generic)
        ReceiptLine.objects.create(receipt=receipt, position=1, kind="product", product=product,
                                   raw_name="Synthetic package", quantity="1.000", unit_price="4.0000", amount="4.00")
        models = (Country, Currency, Merchant, Store, Category, GenericProduct, Product, Receipt, ReceiptLine)
        before = [list(model.objects.order_by("pk").values()) for model in models]
        photo = make_photo()
        job = ProcessingJob.objects.create(photo=photo)
        make_image(job, receipt=receipt)
        try:
            MigrationExecutor(connection).migrate([("recognition", None)])
            self.assertFalse(any(name.startswith("recognition_") for name in connection.introspection.table_names()))
            self.assertEqual(before, [list(model.objects.order_by("pk").values()) for model in models])
        finally:
            MigrationExecutor(connection).migrate([("recognition", "0001_initial")])
        self.assertEqual(before, [list(model.objects.order_by("pk").values()) for model in models])
        self.assertEqual(SourcePhoto.objects.count(), 0)
