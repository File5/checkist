"""Import and confirmation per owner: the same file or receipt of two users never meet.

Shops, products and their spellings stay shared; a receipt, its lines and the
photo belong to one user. Fictional data, fake payloads, temporary MEDIA.
"""
import io
import tempfile
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path
from threading import Event
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections, connections, transaction
from django.test import TestCase, TransactionTestCase, override_settings, tag
from django.utils import timezone
from PIL import Image

from catalog.models import Product
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.ownership import LOCAL_USERNAME
from recognition import importer, review
from recognition.importer import ImportBusy, OwnerMismatch, import_receipt
from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from recognition.providers.fake import receipt_payload
from recognition.queue import create_job, db_now
from recognition.resolution import resolve_country, resolve_store
from recognition.storage import accept_upload, media_path
from stores.models import Country, Currency, Merchant, Store

from .import_fixtures import observation
from .test_models import make_image, make_photo
from .test_review import fixed_body, image_state, review_image

User = get_user_model()

RECEIPT_FIELDS = ("owner_id", "store_id", "currency_id", "operation", "purchased_at", "purchased_on", "receipt_number",
                  "shift_number", "register_code", "fiscal", "fiscal_key", "total", "discount_total",
                  "prices_include_tax", "raw_text", "extra", "created_at", "updated_at")


def running(job):
    """Put a job under a live fence, as ``live_image`` does, without the single-worker claim."""
    now = db_now()
    ProcessingJob.objects.filter(pk=job.pk).update(
        status="running", stage="import", detected_count=1, run_token=uuid.uuid4(), started_at=now,
        heartbeat_at=now, lease_expires_at=now + timedelta(seconds=120),
        processing_deadline_at=now + timedelta(minutes=10),
    )
    job.refresh_from_db()
    return job


def live_image_of(owner, **fields):
    now = db_now()
    job = ProcessingJob.objects.create(
        photo=make_photo(owner=owner), status="running", stage="import", detected_count=1,
        run_token=uuid.uuid4(), started_at=now, heartbeat_at=now,
        lease_expires_at=now + timedelta(seconds=120), processing_deadline_at=now + timedelta(minutes=10),
    )
    return make_image(job, **fields), job


def import_for(owner, data=None):
    image, job = live_image_of(owner)
    return import_receipt(image, observation(data), run_token=job.run_token, version=job.version)


def review_image_of(owner, data=None):
    job = ProcessingJob.objects.create(
        photo=make_photo(owner=owner), status="partial_succeeded", stage="finished", finished_at=timezone.now(),
        detected_count=1, completed_count=1, review_count=1,
    )
    return review_image(data, job=job)


def without_fiscal(data=None):
    """Identity by store, day, shift, register and number: no fiscal key."""
    data = receipt_payload() if data is None else data
    data["fiscal"] = {key: None for key in data["fiscal"]}
    return data


def without_number(data=None):
    """Identity by store, moment and total only."""
    data = without_fiscal(data)
    data["receipt_number"] = data["shift_number"] = data["register_code"] = None
    return data


def receipt_state(receipt):
    """Everything of a saved receipt that an import of another owner must leave alone."""
    receipt = Receipt.objects.get(pk=receipt.pk)
    lines = list(receipt.lines.order_by("pk").values_list(
        "pk", "position", "product_id", "raw_name", "quantity", "unit_price", "amount", "discount_amount"))
    return (tuple(getattr(receipt, name) for name in RECEIPT_FIELDS), lines,
            list(receipt.discounts.order_by("pk").values_list("pk", "amount")),
            list(receipt.taxes.order_by("pk").values_list("pk", "net", "tax", "gross")))


def codes(issues):
    return [item["code"] for item in issues]


class TwoOwners:
    """Two ordinary users; ``local`` is neither of them."""

    def make_owners(self):
        self.first = User.objects.create_user("synthetic-owner-one")
        self.second = User.objects.create_user("synthetic-owner-two")

    def temporary_media(self):
        self.temp = tempfile.TemporaryDirectory(prefix="checkist-owner-isolation-")
        self.addCleanup(self.temp.cleanup)
        self.media = Path(self.temp.name) / "media"
        override = override_settings(MEDIA_ROOT=self.media, RECEIPT_OCR_TEMP_ROOT=Path(self.temp.name) / "scratch",
                                     PRODUCT_MERGE_AUTO_DETECT=False, PRODUCT_CLASSIFICATION_AUTO_SUGGEST=False)
        override.enable()
        self.addCleanup(override.disable)

    def assert_owned_by_photo(self, result):
        image = ReceiptImage.objects.select_related("photo", "receipt", "job__photo").get(pk=result.image.pk)
        self.assertEqual(image.receipt.owner_id, image.photo.owner_id)
        self.assertEqual(image.receipt.owner_id, image.job.photo.owner_id)


@tag("integration")
class SameFileTwoOwnersTests(TwoOwners, TransactionTestCase):
    """One file uploaded by two users: two photos, two jobs, two receipts."""

    def setUp(self):
        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        self.make_owners()
        self.temporary_media()
        with io.BytesIO() as stream, Image.new("RGB", (100, 200), "white") as image:
            image.save(stream, format="PNG")
            self.data = stream.getvalue()

    def upload(self, owner):
        return accept_upload(SimpleUploadedFile("receipt.png", self.data, content_type="image/png"), owner=owner)

    def test_same_file_is_two_photos_two_jobs_and_two_receipts(self):
        first_photo, first_created = self.upload(self.first)
        second_photo, second_created = self.upload(self.second)
        self.assertEqual((first_created, second_created), (True, True))  # the second upload is not a reuse
        self.assertNotEqual(first_photo.pk, second_photo.pk)
        self.assertEqual(first_photo.sha256, second_photo.sha256)
        self.assertEqual((first_photo.owner_id, second_photo.owner_id), (self.first.pk, self.second.pk))
        first_path = media_path(first_photo.original_file.name)
        second_path = media_path(second_photo.original_file.name)
        self.assertNotEqual(first_path.parent, second_path.parent)
        self.assertEqual(first_path.read_bytes(), second_path.read_bytes())

        results = []
        for photo in (first_photo, second_photo):
            job, created = create_job(photo)
            self.assertTrue(created)
            job = running(job)
            image = make_image(job)
            results.append(import_receipt(image, observation(), run_token=job.run_token, version=job.version))
        self.assertEqual([result.outcome for result in results], ["created", "created"])
        self.assertEqual([result.issues for result in results], [[], []])
        self.assertEqual([result.image.status for result in results], ["imported", "imported"])
        self.assertNotEqual(results[0].receipt.pk, results[1].receipt.pk)
        self.assertEqual([result.receipt.owner_id for result in results], [self.first.pk, self.second.pk])
        for result in results:
            self.assert_owned_by_photo(result)
        self.assertEqual((SourcePhoto.objects.count(), ProcessingJob.objects.count(), Receipt.objects.count()),
                         (2, 2, 2))
        self.assertEqual(ReceiptLine.objects.count(), 8)
        # The catalogue and the shops are shared.
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Product.objects.count(),
                          ProductAlias.objects.count()), (1, 1, 3, 3))

    def test_own_repeat_of_the_file_is_still_a_reuse(self):
        photo, created = self.upload(self.first)
        self.upload(self.second)
        again, again_created = self.upload(self.first)
        self.assertEqual((created, again_created, again.pk), (True, False, photo.pk))
        self.assertEqual(SourcePhoto.objects.count(), 2)


@tag("integration")
class SameReceiptTwoOwnersTests(TwoOwners, TestCase):
    """Different photos of one printed receipt, one per user, on each identity level."""

    def setUp(self):
        self.make_owners()
        self.temporary_media()

    def check_two_receipts(self, payload):
        first = import_for(self.first, payload())
        self.assertEqual(first.outcome, "created")
        before = receipt_state(first.receipt)

        second = import_for(self.second, payload())
        self.assertEqual((second.outcome, second.image.status, second.image.import_effect),
                         ("created", "imported", "created"))
        self.assertEqual(second.issues, [])
        self.assertNotEqual(second.receipt.pk, first.receipt.pk)
        self.assertEqual((first.receipt.owner_id, second.receipt.owner_id), (self.first.pk, self.second.pk))
        self.assert_owned_by_photo(first)
        self.assert_owned_by_photo(second)
        self.assertEqual(receipt_state(first.receipt), before)
        first.image.refresh_from_db()
        self.assertEqual((first.image.status, first.image.receipt_id), ("imported", first.receipt.pk))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), ReceiptDiscount.objects.count(),
                          ReceiptTax.objects.count()), (2, 8, 2, 4))
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), Product.objects.count(),
                          ProductAlias.objects.count()), (1, 1, 3, 3))
        self.assertEqual(second.receipt.store_id, first.receipt.store_id)
        return first, second

    def test_same_fiscal_key(self):
        first, second = self.check_two_receipts(receipt_payload)
        self.assertEqual((first.receipt.fiscal_key, second.receipt.fiscal_key),
                         ("de:TEST-KASSE-02:98765", "de:TEST-KASSE-02:98765"))

    def test_same_number_without_fiscal_key(self):
        first, second = self.check_two_receipts(without_fiscal)
        self.assertEqual((first.receipt.fiscal_key, second.receipt.fiscal_key), ("", ""))
        self.assertEqual((first.receipt.receipt_number, second.receipt.receipt_number), ("000123", "000123"))

    def test_same_moment_and_total_without_number(self):
        first, second = self.check_two_receipts(without_number)
        self.assertEqual((first.receipt.receipt_number, second.receipt.receipt_number), ("", ""))
        self.assertEqual(first.receipt.purchased_at, second.receipt.purchased_at)
        self.assertEqual(first.receipt.total, second.receipt.total)

    def test_fuller_photo_of_another_owner_does_not_complete_the_receipt(self):
        first = import_for(self.first, without_number())
        before = receipt_state(first.receipt)
        second = import_for(self.second)  # the same receipt with its number and fiscal data
        self.assertEqual(second.outcome, "created")
        self.assertEqual(second.receipt.receipt_number, "000123")
        self.assertEqual(receipt_state(first.receipt), before)
        self.assertEqual((Receipt.objects.get(pk=first.receipt.pk).receipt_number,
                          Receipt.objects.get(pk=first.receipt.pk).fiscal_key), ("", ""))

    def test_conflicting_identity_of_another_owner_is_not_a_conflict(self):
        # For one owner this pair is ``identity_conflict``: the same moment and total, another fiscal key.
        import_for(self.first)
        other = receipt_payload()
        other["fiscal"]["tse_transaction"] = "OTHER-TRANSACTION"
        second = import_for(self.second, other)
        self.assertEqual(second.outcome, "created")
        self.assertNotIn("identity_conflict", codes(second.issues))
        self.assertEqual(Receipt.objects.count(), 2)

    def test_receipt_of_another_owner_is_never_linked(self):
        # A program error (a foreign candidate) fails the crop and writes nothing.
        first = import_for(self.first)
        before = receipt_state(first.receipt)
        with patch.object(importer, "find_duplicates", return_value=[Receipt.objects.get(pk=first.receipt.pk)]):
            result = import_for(self.second)
        self.assertEqual((result.outcome, result.receipt, result.image.status), ("failed", None, "failed"))
        self.assertEqual(codes(result.issues), ["import_failed"])
        self.assertIsNone(result.image.receipt_id)
        self.assertEqual(receipt_state(first.receipt), before)
        self.assertEqual(Receipt.objects.count(), 1)


@tag("integration")
class OwnRepeatTests(TwoOwners, TestCase):
    """A repeat of the owner's own receipt behaves as before, next to the same receipt of another user."""

    def setUp(self):
        self.make_owners()
        self.temporary_media()

    def test_own_repeat_is_linked_to_the_own_receipt(self):
        first = import_for(self.first)
        other = import_for(self.second)
        before, other_before = receipt_state(first.receipt), receipt_state(other.receipt)
        counts = (Receipt.objects.count(), ReceiptLine.objects.count(), ReceiptDiscount.objects.count(),
                  ReceiptTax.objects.count(), Product.objects.count(), ProductAlias.objects.count())

        for owner, own in ((self.first, first), (self.second, other)):
            repeat = import_for(owner)
            self.assertEqual((repeat.outcome, repeat.image.status, repeat.image.import_effect),
                             ("linked", "reused", "linked"))
            self.assertEqual(repeat.receipt.pk, own.receipt.pk)
            self.assertEqual(repeat.image.job.reused_count, 1)
            self.assert_owned_by_photo(repeat)
        self.assertEqual(receipt_state(first.receipt), before)
        self.assertEqual(receipt_state(other.receipt), other_before)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), ReceiptDiscount.objects.count(),
                          ReceiptTax.objects.count(), Product.objects.count(), ProductAlias.objects.count()), counts)
        self.assertEqual(counts[:2], (2, 8))

    def test_own_fuller_photo_updates_only_the_own_receipt(self):
        first = import_for(self.first, without_number())
        other = import_for(self.second, without_number())
        other_before = receipt_state(other.receipt)

        repeat = import_for(self.first)
        self.assertEqual((repeat.outcome, repeat.image.status), ("updated", "updated"))
        self.assertEqual(repeat.receipt.pk, first.receipt.pk)
        self.assertEqual((repeat.receipt.receipt_number, repeat.receipt.fiscal_key),
                         ("000123", "de:TEST-KASSE-02:98765"))
        self.assertEqual(repeat.receipt.owner_id, self.first.pk)
        self.assertEqual(receipt_state(other.receipt), other_before)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count()), (2, 8))

    def test_owner_is_read_from_the_photo_of_the_job(self):
        # Nothing of the request or of ``local`` takes part: only the photo of the job decides.
        result = import_for(self.second)
        self.assertEqual(result.receipt.owner_id, self.second.pk)
        self.assertFalse(Receipt.objects.exclude(owner=self.second).exists())
        self.assertFalse(Receipt.objects.filter(owner__username=LOCAL_USERNAME).exists())


@tag("integration")
class OwnerRaceTests(TwoOwners, TransactionTestCase):
    """Two owners on separate connections do not collide; one owner races as before."""

    def setUp(self):
        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        self.make_owners()
        self.temporary_media()
        self.obs = observation()

    def threaded_import(self, image, job):
        close_old_connections()
        try:
            return import_receipt(image, self.obs, run_token=job.run_token, version=job.version)
        finally:
            connections.close_all()

    def outside_writer(self, owner):
        """A writer that bypasses the import mutex, on its own connection."""
        def write():
            close_old_connections()
            try:
                with transaction.atomic():
                    effective, derived = importer._domain_observation(self.obs)
                    return importer._import_domain(effective, derived, owner_id=owner.pk)[0].pk
            finally:
                connections.close_all()
        return write

    def import_against(self, writer_owner, owner):
        # The shop is committed and visible to the outside writer.
        resolve_store(self.obs, resolve_country(self.obs))
        image, job = live_image_of(owner)
        original, raced, written = importer.clean_save, [], []

        def concurrent_save(obj):
            # The patch is seen by the outside writer too: only the first new receipt starts it.
            if isinstance(obj, Receipt) and obj.pk is None and not raced:
                raced.append(True)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    written.append(pool.submit(self.outside_writer(writer_owner)).result(timeout=10))
            return original(obj)

        with patch.object(importer, "clean_save", side_effect=concurrent_save):
            result = import_receipt(image, self.obs, run_token=job.run_token, version=job.version)
        self.assertEqual(len(written), 1)
        return result, written[0]

    def test_parallel_imports_of_two_owners_both_create(self):
        first_image, first_job = live_image_of(self.first)
        second_image, second_job = live_image_of(self.second)
        entered, release = Event(), Event()
        original = importer._create_graph

        def pause_create(*args):
            entered.set()
            if not release.wait(10):
                raise AssertionError("Import lock test did not release")
            return original(*args)

        with ThreadPoolExecutor(max_workers=2) as pool, \
                patch.object(importer, "_create_graph", side_effect=pause_create):
            first = pool.submit(self.threaded_import, first_image, first_job)
            try:
                self.assertTrue(entered.wait(10))
                # Imports still go one at a time under the mutex, whoever the owner is.
                with self.assertRaises(ImportBusy):
                    pool.submit(self.threaded_import, second_image, second_job).result(timeout=10)
                second_image.refresh_from_db()
                self.assertEqual(second_image.status, "pending")
            finally:
                release.set()
            created = first.result(timeout=10)
            other = pool.submit(self.threaded_import, second_image, second_job).result(timeout=10)
        self.assertEqual((created.outcome, other.outcome), ("created", "created"))
        self.assertEqual((created.image.status, other.image.status), ("imported", "imported"))
        self.assertNotIn("identity_conflict", codes(created.issues) + codes(other.issues))
        self.assertNotEqual(created.receipt.pk, other.receipt.pk)
        self.assertEqual((created.receipt.owner_id, other.receipt.owner_id), (self.first.pk, self.second.pk))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (2, 8, 3))

    def test_outside_writer_of_another_owner_is_not_a_unique_race(self):
        result, written = self.import_against(self.second, self.first)
        self.assertEqual((result.outcome, result.image.status), ("created", "imported"))
        self.assertNotIn("identity_conflict", codes(result.issues))
        self.assertNotIn("import_failed", codes(result.issues))
        self.assertNotEqual(result.receipt.pk, written)
        self.assertEqual(result.receipt.owner_id, self.first.pk)
        self.assertEqual(Receipt.objects.get(pk=written).owner_id, self.second.pk)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (2, 8, 3))

    def test_outside_writer_of_the_same_owner_is_reread_and_linked(self):
        result, written = self.import_against(self.first, self.first)
        self.assertEqual((result.outcome, result.image.status), ("linked", "reused"))
        self.assertEqual(result.receipt.pk, written)
        self.assertEqual(result.receipt.owner_id, self.first.pk)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (1, 4, 3))


@tag("integration")
class ReviewOwnerTests(TwoOwners, TestCase):
    """A confirmed crop becomes a receipt of the owner of its photo."""

    def setUp(self):
        self.make_owners()
        self.temporary_media()

    def confirmed(self, image):
        result = review.confirm(image.pk, fixed_body())
        image.refresh_from_db()
        self.assertFalse(result.replayed)
        return image

    def test_confirmation_creates_a_receipt_of_the_crop_owner(self):
        image = self.confirmed(review_image_of(self.second))
        receipt = Receipt.objects.get()
        self.assertEqual((image.status, image.import_effect, image.receipt_id), ("imported", "created", receipt.pk))
        self.assertEqual(receipt.owner_id, self.second.pk)
        self.assertEqual(receipt.owner_id, image.photo.owner_id)
        self.assertEqual(receipt.extra["recognition"]["confirmed"]["image_id"], image.pk)
        self.assertFalse(Receipt.objects.filter(owner__username=LOCAL_USERNAME).exists())

    def test_same_receipt_of_another_owner_is_not_linked(self):
        existing = import_for(self.first)  # the receipt the corrected form describes
        before = receipt_state(existing.receipt)

        image = self.confirmed(review_image_of(self.second))
        self.assertEqual((image.status, image.import_effect), ("imported", "created"))
        self.assertEqual(image.issues, [])
        self.assertNotEqual(image.receipt_id, existing.receipt.pk)
        own = Receipt.objects.get(pk=image.receipt_id)
        self.assertEqual((own.owner_id, own.fiscal_key), (self.second.pk, existing.receipt.fiscal_key))
        self.assertEqual(receipt_state(existing.receipt), before)
        self.assertNotIn("confirmed", Receipt.objects.get(pk=existing.receipt.pk).extra["recognition"])
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count(), Product.objects.count()), (2, 8, 3))

    def test_confirmations_of_two_owners_are_two_receipts(self):
        first = self.confirmed(review_image_of(self.first))
        second = self.confirmed(review_image_of(self.second))
        self.assertEqual((first.status, second.status), ("imported", "imported"))
        self.assertNotEqual(first.receipt_id, second.receipt_id)
        self.assertEqual(
            list(Receipt.objects.order_by("pk").values_list("owner_id", flat=True)), [self.first.pk, self.second.pk])

    def test_own_existing_receipt_is_still_linked(self):
        other = import_for(self.first)
        own = import_for(self.second)
        other_before, own_before = receipt_state(other.receipt), receipt_state(own.receipt)

        image = self.confirmed(review_image_of(self.second))
        self.assertEqual((image.status, image.import_effect, image.receipt_id), ("reused", "linked", own.receipt.pk))
        self.assertEqual(receipt_state(own.receipt), own_before)
        self.assertEqual(receipt_state(other.receipt), other_before)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count()), (2, 8))

    def test_receipt_of_another_owner_is_never_linked(self):
        # A program error (a foreign candidate) is not a refusal of the person: it propagates, nothing is saved.
        existing = import_for(self.first)
        before = receipt_state(existing.receipt)
        image = review_image_of(self.second)
        state = image_state(image)
        with patch.object(importer, "find_duplicates", return_value=[Receipt.objects.get(pk=existing.receipt.pk)]), \
                self.assertRaises(OwnerMismatch):
            review.confirm(image.pk, fixed_body())
        self.assertEqual(image_state(image), state)
        self.assertEqual(receipt_state(existing.receipt), before)
        self.assertEqual(Receipt.objects.count(), 1)
