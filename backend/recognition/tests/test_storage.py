import hashlib
import io
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections, connection
from django.test import TransactionTestCase, override_settings, tag
from PIL import Image

from receipts.ownership import local_user
from recognition.images import ImageError
from recognition.models import SourcePhoto
from recognition.queue import FenceLost, QueueError, claim_job, create_job, request_cancel, update_progress
from recognition.storage import StorageError, accept_upload, media_path, prepare_photo, save_crop
from .test_queue import fence

BOX = {"x_min": 0.1, "y_min": 0.1, "x_max": 0.9, "y_max": 0.9}


@tag("integration")
class StorageTests(TransactionTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="checkist-storage-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.media = self.root / "media"
        self.override = override_settings(MEDIA_ROOT=self.media, RECEIPT_OCR_TEMP_ROOT=self.root / "scratch")
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.owner = local_user()
        with io.BytesIO() as stream, Image.new("RGB", (100, 200), "white") as image:
            image.save(stream, format="PNG")
            self.data = stream.getvalue()

    def upload(self):
        return SimpleUploadedFile("../../private.heic", self.data, content_type="image/heic")

    def prepared_job(self, detected=1):
        photo, _ = accept_upload(self.upload(), owner=self.owner)
        create_job(photo)
        photo, job = prepare_photo(*fence(claim_job()))
        job = update_progress(*fence(job), detected_count=detected, stage="crop")
        return photo, job

    def files(self):
        return sorted(path for path in self.media.rglob("*") if path.is_file())

    def test_source_bytes_unchanged_and_exact_replay(self):
        photo, created = accept_upload(self.upload(), owner=self.owner)
        self.assertTrue(created)
        self.assertEqual(media_path(photo.original_file.name).read_bytes(), self.data)
        self.assertEqual(photo.sha256, hashlib.sha256(self.data).hexdigest())
        self.assertEqual(photo.content_type, "image/png")
        self.assertIsNone(photo.upright_file.name)
        self.assertNotIn("private", photo.original_file.name)
        duplicate, created = accept_upload(self.upload(), owner=self.owner)
        self.assertFalse(created)
        self.assertEqual(duplicate.pk, photo.pk)
        self.assertEqual(len(self.files()), 1)
        self.assertFalse(list(self.root.glob(".*-recognition-staging-*")))

    def test_actual_chunk_byte_limit_ignores_declared_size(self):
        class LyingUpload:
            size = 1
            def chunks(self, chunk_size):
                yield b"x" * 20971520
                yield b"x"
                raise AssertionError("must stop reading after limit")
        with self.assertRaises(ImageError) as caught:
            accept_upload(LyingUpload(), owner=self.owner)
        self.assertEqual(caught.exception.code, "file_too_large")
        self.assertEqual(SourcePhoto.objects.count(), 0)
        self.assertEqual(self.files(), [])

    def test_invalid_upload_cleans_staging(self):
        with self.assertRaises(ImageError):
            accept_upload(io.BytesIO(b"invalid"), owner=self.owner)
        self.assertEqual(self.files(), [])
        self.assertFalse(list(self.root.glob(".*-recognition-staging-*")))

    def test_db_failure_removes_only_own_file(self):
        photo, _ = accept_upload(self.upload(), owner=self.owner)
        protected = media_path(photo.original_file.name)
        stream = io.BytesIO()
        with Image.new("RGB", (4, 4), "black") as image:
            image.save(stream, format="PNG")
        stream.seek(0)
        with patch.object(SourcePhoto.objects, "get_or_create", side_effect=RuntimeError("synthetic DB failure")):
            with self.assertRaises(RuntimeError):
                accept_upload(stream, owner=self.owner)
        self.assertEqual(self.files(), [protected])
        self.assertEqual(SourcePhoto.objects.count(), 1)

    def test_missing_source_duplicate_is_storage_error(self):
        photo, _ = accept_upload(self.upload(), owner=self.owner)
        media_path(photo.original_file.name).unlink()
        with self.assertRaises(StorageError):
            accept_upload(self.upload(), owner=self.owner)

    def test_media_path_rejects_escape(self):
        for name in ("../private", "..\\private", "/absolute", "", "missing.png"):
            with self.subTest(name=name), self.assertRaises(StorageError):
                media_path(name)

    def test_preview_and_crop_reuse_on_recovery(self):
        photo, job = self.prepared_job()
        with Image.open(media_path(photo.upright_file.name)) as image:
            self.assertEqual((image.mode, image.size, dict(image.info)), ("RGB", (100, 200), {}))
        crop, job = save_crop(*fence(job), 1, BOX, rotation_degrees=12)
        self.assertEqual((crop.photo_id, crop.job_id, crop.position), (photo.pk, job.pk, 1))
        self.assertEqual(crop.sha256, hashlib.sha256(media_path(crop.file.name).read_bytes()).hexdigest())
        same, unchanged = save_crop(*fence(job), 1, BOX, rotation_degrees=12)
        self.assertEqual((same.pk, unchanged.version), (crop.pk, job.version))
        self.assertEqual(len(self.files()), 3)
        _, unchanged = prepare_photo(*fence(job))
        self.assertEqual(unchanged.version, job.version)
        with self.assertRaises(QueueError):
            save_crop(*fence(job), 1, BOX, rotation_degrees=0)

    def test_crop_rejects_out_of_detected_range_and_stale_fence(self):
        photo, job = self.prepared_job()
        with self.assertRaises(QueueError):
            save_crop(*fence(job), 2, BOX)
        request_cancel(job.pk)
        with self.assertRaises(FenceLost):
            save_crop(*fence(job), 1, BOX)
        self.assertEqual(len(self.files()), 2)

    def test_preview_write_after_cancel_cleans_own_file(self):
        photo, _ = accept_upload(self.upload(), owner=self.owner)
        create_job(photo)
        job = claim_job()
        request_cancel(job.pk)
        with self.assertRaises(FenceLost):
            prepare_photo(*fence(job))
        photo.refresh_from_db()
        self.assertFalse(photo.upright_file)
        self.assertEqual(len(self.files()), 1)

    def test_crop_database_failure_cleans_published_file(self):
        from recognition.models import ReceiptImage
        _, job = self.prepared_job()
        with patch.object(ReceiptImage.objects, "create", side_effect=RuntimeError("synthetic DB failure")):
            with self.assertRaises(RuntimeError):
                save_crop(*fence(job), 1, BOX)
        self.assertEqual(len(self.files()), 2)
        self.assertEqual(job.images.count(), 0)

    def test_concurrent_same_bytes_keeps_one_row_and_one_file(self):
        barrier = Barrier(2)
        def upload():
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return accept_upload(self.upload(), owner=self.owner)
            finally:
                connection.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(upload) for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual(len({photo.pk for photo, _ in results}), 1)
        self.assertEqual(sum(created for _, created in results), 1)
        self.assertEqual(SourcePhoto.objects.count(), 1)
        self.assertEqual(len(self.files()), 1)


@tag("integration")
class UploadOwnerTests(TransactionTestCase):
    """The same bytes belong to each owner separately: own row, own directory, own replay."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="checkist-storage-owner-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.media = self.root / "media"
        self.override = override_settings(MEDIA_ROOT=self.media, RECEIPT_OCR_TEMP_ROOT=self.root / "scratch")
        self.override.enable()
        self.addCleanup(self.override.disable)
        User = get_user_model()
        self.first = User.objects.create_user("synthetic-owner-one")
        self.second = User.objects.create_user("synthetic-owner-two")
        with io.BytesIO() as stream, Image.new("RGB", (100, 200), "white") as image:
            image.save(stream, format="PNG")
            self.data = stream.getvalue()

    def upload(self):
        return SimpleUploadedFile("receipt.png", self.data, content_type="image/png")

    def files(self):
        return sorted(path.resolve() for path in self.media.rglob("*") if path.is_file())

    def test_owner_is_a_required_keyword(self):
        with self.assertRaises(TypeError):
            accept_upload(self.upload())
        with self.assertRaises(TypeError):
            accept_upload(self.upload(), self.first)
        for owner in (None, "1", True, get_user_model()(username="synthetic-unsaved")):
            with self.subTest(owner=owner), self.assertRaises(TypeError):
                accept_upload(self.upload(), owner=owner)
        self.assertEqual(SourcePhoto.objects.count(), 0)
        self.assertEqual(self.files(), [])

    def test_same_bytes_of_two_owners_are_two_photos_in_two_directories(self):
        first, first_created = accept_upload(self.upload(), owner=self.first)
        second, second_created = accept_upload(self.upload(), owner=self.second)
        self.assertTrue(first_created)
        self.assertTrue(second_created)
        self.assertNotEqual(first.pk, second.pk)
        self.assertEqual((first.owner_id, second.owner_id), (self.first.pk, self.second.pk))
        self.assertEqual(first.sha256, second.sha256)
        self.assertNotEqual(first.storage_uuid, second.storage_uuid)
        first_path, second_path = media_path(first.original_file.name), media_path(second.original_file.name)
        self.assertNotEqual(first_path.parent, second_path.parent)
        self.assertEqual((first_path.read_bytes(), second_path.read_bytes()), (self.data, self.data))
        self.assertEqual(self.files(), sorted([first_path, second_path]))
        self.assertFalse(list(self.root.glob(".*-recognition-staging-*")))

    def test_replay_returns_only_own_photo(self):
        first, _ = accept_upload(self.upload(), owner=self.first)
        second, _ = accept_upload(self.upload(), owner=self.second)
        for owner, photo in ((self.first, first), (self.second, second)):
            with self.subTest(owner=owner.username):
                replay, created = accept_upload(self.upload(), owner=owner)
                self.assertFalse(created)
                self.assertEqual((replay.pk, replay.owner_id), (photo.pk, owner.pk))
        self.assertEqual(SourcePhoto.objects.count(), 2)
        self.assertEqual(len(self.files()), 2)

    def test_owner_may_be_an_id(self):
        photo, created = accept_upload(self.upload(), owner=self.first.pk)
        self.assertTrue(created)
        self.assertEqual(photo.owner_id, self.first.pk)
        replay, created = accept_upload(self.upload(), owner=self.first)
        self.assertFalse(created)
        self.assertEqual(replay.pk, photo.pk)

    def test_missing_file_of_another_owner_does_not_affect_upload(self):
        first, _ = accept_upload(self.upload(), owner=self.first)
        media_path(first.original_file.name).unlink()
        second, created = accept_upload(self.upload(), owner=self.second)
        self.assertTrue(created)
        self.assertEqual(media_path(second.original_file.name).read_bytes(), self.data)
        with self.assertRaises(StorageError):
            accept_upload(self.upload(), owner=self.first)
        self.assertEqual(SourcePhoto.objects.count(), 2)
        self.assertEqual(self.files(), [media_path(second.original_file.name)])

    def test_concurrent_same_bytes_of_two_owners_keep_two_rows_and_two_files(self):
        barrier = Barrier(2)
        def upload(owner_id):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return accept_upload(self.upload(), owner=owner_id)
            finally:
                connection.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(upload, owner.pk) for owner in (self.first, self.second)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual([created for _, created in results], [True, True])
        self.assertEqual([photo.owner_id for photo, _ in results], [self.first.pk, self.second.pk])
        self.assertEqual(SourcePhoto.objects.count(), 2)
        self.assertEqual(len(self.files()), 2)
