"""``DELETE /api/receipts/{id}/`` для чека с фото: без фото и с ``?with_photo=1``."""
import tempfile
import uuid
from datetime import date
from decimal import Decimal as D
from pathlib import Path
from unittest import mock

from django.test import TestCase, override_settings, tag
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_FOUND, TwoUsers, accounts_mode, local_single_mode, make_user
from api.tests.factories import make_receipt
from receipts import deletion
from receipts.models import Receipt, ReceiptDiscount, ReceiptLine
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line
from recognition.models import ProcessingJob, ReceiptImage, RecognitionAttempt, SourcePhoto
from recognition.tests.test_models import make_image, make_photo


def finished_job(photo, status="succeeded"):
    return ProcessingJob.objects.create(photo=photo, status=status, stage="finished", finished_at=timezone.now(),
                                        detected_count=1, completed_count=1)


def attempt(job, image):
    return RecognitionAttempt.objects.create(
        job=job, image=image, phase="recognize", run_token=uuid.uuid4(), provider="fake", schema_version="1",
        input_sha256="c" * 64, status="succeeded", finished_at=timezone.now())


class MediaMixin:
    """MEDIA во временном каталоге; файлы фото раскладываются как у ``recognition.storage``."""

    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        override = override_settings(MEDIA_ROOT=directory.name)
        override.enable()
        self.addCleanup(override.disable)
        self.media = Path(directory.name)

    def folders(self, photo):
        return [self.media / folder / str(photo.storage_uuid) for folder in deletion.MEDIA_FOLDERS]

    def write_files(self, photo, job):
        names = [photo.original_file.name, f"prepared/{photo.storage_uuid}/{uuid.uuid4()}/upright-v1.png",
                 f"crops/{photo.storage_uuid}/{job.pk}/1-{uuid.uuid4()}/crop.png"]
        for name in names:
            path = self.media / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"synthetic")

    def photo_receipt(self, owner, *, day=1, photo=None):
        """A photo receipt with two lines and a line discount, imported from a crop of ``photo``."""
        receipt = make_receipt(samples.lidl_store(), "EUR", date(2026, 10, day), owner=owner, total=D("19.60"))
        line = make_line(receipt, amount=D("10.00"))
        make_line(receipt, position=2, amount=D("10.00"))
        ReceiptDiscount.objects.create(receipt=receipt, line=line, position=1, name="Rabatt", amount=D("0.40"))
        if photo is None:
            photo = make_photo(owner, original_file=f"originals/{uuid.uuid4()}/source.png")
            photo.original_file.name = f"originals/{photo.storage_uuid}/source.png"
            photo.save(update_fields=["original_file"])
        job = finished_job(photo) if not photo.jobs.exists() else photo.jobs.first()
        position = photo.receipt_images.count() + 1
        image = make_image(job, position=position, status="imported", receipt=receipt,
                           outcome_snapshot={"receipt_id": receipt.pk})
        attempt(job, image)
        self.write_files(photo, job)
        return receipt, photo, job, image


@tag("integration")
@local_single_mode()
class PhotoReceiptDeleteTests(MediaMixin, TestCase):
    def setUp(self):
        super().setUp()
        self.client = APIClient()
        self.receipt, self.photo, self.job, self.image = self.photo_receipt(local_user())
        self.url = f"/api/receipts/{self.receipt.pk}/"
        # Another photo of the same owner: never touched.
        self.other, self.other_photo, _, _ = self.photo_receipt(local_user(), day=2)

    def test_delete_without_photo_keeps_the_crop_unlinked(self):
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            response = self.client.delete(self.url)
        self.assertEqual(response.status_code, 204, response.content)
        self.assertEqual(callbacks, [])
        self.assertFalse(Receipt.objects.filter(pk=self.receipt.pk).exists())
        self.assertFalse(ReceiptLine.objects.filter(receipt_id=self.receipt.pk).exists())
        self.assertFalse(ReceiptDiscount.objects.filter(receipt_id=self.receipt.pk).exists())
        self.image.refresh_from_db()
        self.assertIsNone(self.image.receipt_id)
        self.assertEqual(self.image.outcome_snapshot, {"receipt_id": self.receipt.pk})
        self.assertTrue(SourcePhoto.objects.filter(pk=self.photo.pk).exists())
        self.assertTrue(RecognitionAttempt.objects.filter(job=self.job).exists())
        self.assertTrue(all(path.is_dir() for path in self.folders(self.photo)))
        # The job page still shows the crop and says the receipt was deleted.
        crop = self.client.get(f"/api/recognition/receipt-images/{self.image.pk}/").json()
        self.assertEqual((crop["receipt_id"], crop["receipt_deleted"]), (None, True))
        self.assertEqual(self.client.delete(self.url).json(), NOT_FOUND)

    def test_delete_with_photo_removes_rows_and_then_files(self):
        with self.captureOnCommitCallbacks() as callbacks:
            response = self.client.delete(f"{self.url}?with_photo=1")
        self.assertEqual(response.status_code, 204, response.content)
        # Rows go in the transaction; files only after the commit.
        self.assertFalse(SourcePhoto.objects.filter(pk=self.photo.pk).exists())
        self.assertFalse(ProcessingJob.objects.filter(photo_id=self.photo.pk).exists())
        self.assertFalse(ReceiptImage.objects.filter(pk=self.image.pk).exists())
        self.assertFalse(RecognitionAttempt.objects.filter(job_id=self.job.pk).exists())
        self.assertFalse(Receipt.objects.filter(pk=self.receipt.pk).exists())
        self.assertTrue(all(path.is_dir() for path in self.folders(self.photo)))
        self.assertEqual(len(callbacks), 1)
        callbacks[0]()
        self.assertFalse(any(path.exists() for path in self.folders(self.photo)))
        # The other photo, its receipt and its files stay.
        self.assertTrue(Receipt.objects.filter(pk=self.other.pk).exists())
        self.assertTrue(all(path.is_dir() for path in self.folders(self.other_photo)))
        self.assertTrue(ReceiptImage.objects.filter(photo=self.other_photo, receipt=self.other).exists())

    def test_catalog_and_store_stay(self):
        store_id = self.receipt.store_id
        self.client.delete(f"{self.url}?with_photo=1")
        self.assertTrue(type(self.receipt.store).objects.filter(pk=store_id).exists())

    def test_active_job_refuses_with_and_without_photo(self):
        ProcessingJob.objects.create(photo=self.photo)
        for url in (self.url, f"{self.url}?with_photo=1"):
            with self.subTest(url=url):
                response = self.client.delete(url)
                self.assertEqual(response.status_code, 409)
                self.assertEqual(response.json()["error"]["code"], "job_active")
        self.assertTrue(Receipt.objects.filter(pk=self.receipt.pk).exists())
        self.assertEqual(ReceiptImage.objects.get(pk=self.image.pk).receipt_id, self.receipt.pk)
        self.assertTrue(SourcePhoto.objects.filter(pk=self.photo.pk).exists())

    def test_photo_shared_by_two_receipts(self):
        second, _, _, second_image = self.photo_receipt(local_user(), day=3, photo=self.photo)
        response = self.client.delete(f"{self.url}?with_photo=1")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"], {
            "code": "photo_shared", "message": "Из этого фото есть и другой чек: удалите этот чек без фото."})
        self.assertTrue(Receipt.objects.filter(pk=self.receipt.pk).exists())
        # Without the photo the receipt goes; the photo and the other receipt stay.
        self.assertEqual(self.client.delete(self.url).status_code, 204)
        self.assertTrue(SourcePhoto.objects.filter(pk=self.photo.pk).exists())
        self.assertEqual(ReceiptImage.objects.get(pk=second_image.pk).receipt_id, second.pk)
        # Now only the second receipt comes from the photo: it may take the photo along.
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.delete(f"/api/receipts/{second.pk}/?with_photo=1").status_code, 204)
        self.assertFalse(SourcePhoto.objects.filter(pk=self.photo.pk).exists())
        self.assertFalse(ReceiptImage.objects.filter(pk=self.image.pk).exists())

    def test_bad_flag_is_400_and_deletes_nothing(self):
        response = self.client.delete(f"{self.url}?with_photo=yes")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["fields"], {"with_photo": ["Ожидается 1 или 0."]})
        self.assertTrue(Receipt.objects.filter(pk=self.receipt.pk).exists())

    def test_file_errors_are_logged_not_raised(self):
        with mock.patch("receipts.deletion.shutil.rmtree", side_effect=OSError("busy")), \
                self.assertLogs("receipts.deletion", level="ERROR") as logs, \
                self.captureOnCommitCallbacks(execute=True):
            response = self.client.delete(f"{self.url}?with_photo=1")
        self.assertEqual(response.status_code, 204)
        self.assertEqual(len(logs.records), 3)
        self.assertFalse(SourcePhoto.objects.filter(pk=self.photo.pk).exists())

    def test_missing_folders_are_fine(self):
        for path in self.folders(self.photo):
            for item in sorted(path.rglob("*"), reverse=True):
                item.unlink() if item.is_file() else item.rmdir()
            path.rmdir()
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(self.client.delete(f"{self.url}?with_photo=1").status_code, 204)

    def test_patch_of_a_photo_receipt_is_still_read_only(self):
        response = self.client.patch(self.url, {"total": "1"}, format="json")
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["error"]["code"], "receipt_read_only")

    def test_manual_spend_ignores_the_photo_flag(self):
        spend = Receipt.objects.create(owner=local_user(), source="manual", currency=self.receipt.currency,
                                       operation="sale", purchased_at=timezone.now(), purchased_on=date(2026, 10, 5),
                                       total=D("5.00"))
        self.assertEqual(self.client.delete(f"/api/receipts/{spend.pk}/?with_photo=1").status_code, 204)
        self.assertFalse(Receipt.objects.filter(pk=spend.pk).exists())


@tag("integration")
@accounts_mode()
class FamilyDeleteTests(MediaMixin, TwoUsers, TestCase):
    """``first`` и ``third`` — одна семья, ``second`` — чужой."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=family)

    def test_family_member_deletes_and_outsider_sees_404(self):
        receipt, photo, _, _ = self.photo_receipt(self.first)
        url = f"/api/receipts/{receipt.pk}/?with_photo=1"
        outsider = self.client_of(self.second, csrf=True)
        response = outsider.delete(url)
        self.assertEqual((response.status_code, response.json()), (404, NOT_FOUND))
        self.assertTrue(Receipt.objects.filter(pk=receipt.pk).exists())
        self.assertTrue(SourcePhoto.objects.filter(pk=photo.pk).exists())
        with self.captureOnCommitCallbacks(execute=True):
            response = self.client_of(self.third, csrf=True).delete(url)
        self.assertEqual(response.status_code, 204, response.content)
        self.assertFalse(Receipt.objects.filter(pk=receipt.pk).exists())
        self.assertFalse(SourcePhoto.objects.filter(pk=photo.pk).exists())
        self.assertFalse(any(path.exists() for path in self.folders(photo)))

    def test_anonymous_and_csrf(self):
        receipt, _, _, _ = self.photo_receipt(self.first)
        url = f"/api/receipts/{receipt.pk}/"
        self.assertEqual(APIClient().delete(url).status_code, 401)
        no_token = APIClient(enforce_csrf_checks=True)
        no_token.force_login(self.first)
        self.assertEqual(no_token.delete(url).json()["error"]["code"], "csrf_failed")
        self.assertTrue(Receipt.objects.filter(pk=receipt.pk).exists())
