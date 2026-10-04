import hashlib
import io
import tempfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import close_old_connections, connection
from django.test import TransactionTestCase, override_settings, tag
from PIL import Image

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
        with io.BytesIO() as stream, Image.new("RGB", (100, 200), "white") as image:
            image.save(stream, format="PNG")
            self.data = stream.getvalue()

    def upload(self):
        return SimpleUploadedFile("../../private.heic", self.data, content_type="image/heic")

    def prepared_job(self, detected=1):
        photo, _ = accept_upload(self.upload())
        create_job(photo)
        photo, job = prepare_photo(*fence(claim_job()))
        job = update_progress(*fence(job), detected_count=detected, stage="crop")
        return photo, job

    def files(self):
        return sorted(path for path in self.media.rglob("*") if path.is_file())

    def test_source_bytes_unchanged_and_exact_replay(self):
        photo, created = accept_upload(self.upload())
        self.assertTrue(created)
        self.assertEqual(media_path(photo.original_file.name).read_bytes(), self.data)
        self.assertEqual(photo.sha256, hashlib.sha256(self.data).hexdigest())
        self.assertEqual(photo.content_type, "image/png")
        self.assertIsNone(photo.upright_file.name)
        self.assertNotIn("private", photo.original_file.name)
        duplicate, created = accept_upload(self.upload())
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
            accept_upload(LyingUpload())
        self.assertEqual(caught.exception.code, "file_too_large")
        self.assertEqual(SourcePhoto.objects.count(), 0)
        self.assertEqual(self.files(), [])

    def test_invalid_upload_cleans_staging(self):
        with self.assertRaises(ImageError):
            accept_upload(io.BytesIO(b"invalid"))
        self.assertEqual(self.files(), [])
        self.assertFalse(list(self.root.glob(".*-recognition-staging-*")))

    def test_db_failure_removes_only_own_file(self):
        photo, _ = accept_upload(self.upload())
        protected = media_path(photo.original_file.name)
        stream = io.BytesIO()
        with Image.new("RGB", (4, 4), "black") as image:
            image.save(stream, format="PNG")
        stream.seek(0)
        with patch.object(SourcePhoto.objects, "get_or_create", side_effect=RuntimeError("synthetic DB failure")):
            with self.assertRaises(RuntimeError):
                accept_upload(stream)
        self.assertEqual(self.files(), [protected])
        self.assertEqual(SourcePhoto.objects.count(), 1)

    def test_missing_source_duplicate_is_storage_error(self):
        photo, _ = accept_upload(self.upload())
        media_path(photo.original_file.name).unlink()
        with self.assertRaises(StorageError):
            accept_upload(self.upload())

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
        photo, _ = accept_upload(self.upload())
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
                return accept_upload(self.upload())
            finally:
                connection.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(upload) for _ in range(2)]
            results = [future.result(timeout=10) for future in futures]
        self.assertEqual(len({photo.pk for photo, _ in results}), 1)
        self.assertEqual(sum(created for _, created in results), 1)
        self.assertEqual(SourcePhoto.objects.count(), 1)
        self.assertEqual(len(self.files()), 1)
