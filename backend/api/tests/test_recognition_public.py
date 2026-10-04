import json
import tempfile
from pathlib import Path
from unittest.mock import patch

from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.test_recognition_api import NOW, PUBLIC, image_bytes, public_data, upload
from recognition.models import ProcessingJob, SourcePhoto


EXAMPLES = {
    "csrf.json": "/api/recognition/csrf/",
    "photo.json": "/api/recognition/photos/11/",
    "photos.json": "/api/recognition/photos/",
    "job.json": "/api/recognition/jobs/31/",
    "jobs.json": "/api/recognition/jobs/",
    "receipt-image.json": "/api/recognition/receipt-images/42/",
    "receipt-images.json": "/api/recognition/receipt-images/",
    "receipt.json": "/api/receipts/71/",
    "receipts.json": "/api/receipts/",
    "lines.json": "/api/receipts/71/lines/",
    "discounts.json": "/api/receipts/71/discounts/",
    "taxes.json": "/api/receipts/71/taxes/",
}


def normalize_upload(value):
    # Generated IDs, timestamps and opaque storage directory change per upload.
    # Only these nondeterministic VALUES are substituted, never keys or structure.
    value["photo"]["id"] = 11
    value["photo"]["latest_job_id"] = 31
    value["photo"]["created_at"] = "2026-10-04T12:35:00Z"
    value["photo"]["original_url"] = "/media/originals/test/source.png"
    value["job"]["id"] = 31
    value["job"]["photo_id"] = 11
    value["job"]["created_at"] = "2026-10-04T12:35:00Z"
    return value


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class PublicExamplesTests(TestCase):
    def setUp(self):
        self.client = APIClient(enforce_csrf_checks=True)
        directory = tempfile.TemporaryDirectory(prefix="checkist-c5-public-")
        self.addCleanup(directory.cleanup)
        settings = override_settings(MEDIA_ROOT=directory.name)
        settings.enable()
        self.addCleanup(settings.disable)
        self.media = Path(directory.name)

    def expected(self, name):
        return json.loads((PUBLIC / name).read_text(encoding="utf-8"))

    def test_public_examples_match_actual_http_responses(self):
        photo, job, receipt, line = public_data()
        path = Path(photo.original_file.path)
        path.parent.mkdir(parents=True)
        path.write_bytes(image_bytes())
        with patch("django.utils.timezone.now", return_value=NOW):
            for name, path in EXAMPLES.items():
                with self.subTest(name=name):
                    response = self.client.get(path)
                    self.assertEqual(response.status_code, 200, response.content)
                    value = response.json()
                    if name == "csrf.json":
                        self.assertEqual(len(value["csrf_token"]), 64)
                        value["csrf_token"] = "MASKED_CSRF_TOKEN"
                    self.assertEqual(value, self.expected(name))
            token = self.client.get("/api/recognition/csrf/").json()["csrf_token"]
            self.client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")
            replay = self.client.post("/api/recognition/photos/", {"file": upload()}, format="multipart")
            self.assertEqual(replay.status_code, 200)
            self.assertEqual(replay.json(), self.expected("upload-reused.json"))

    def test_new_upload_example_matches_actual_post(self):
        token = self.client.get("/api/recognition/csrf/").json()["csrf_token"]
        self.client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")
        response = self.client.post("/api/recognition/photos/", {"file": upload()}, format="multipart")
        self.assertEqual(response.status_code, 202)
        self.assertEqual(normalize_upload(response.json()), self.expected("upload-new.json"))

    def test_running_and_cancelled_job_examples(self):
        from recognition.queue import claim_job
        photo = SourcePhoto.objects.create(id=11, sha256="a" * 64, original_file="originals/test/source.png",
            content_type="image/png", bytes=80, raw_width=10, raw_height=20, width=10, height=20)
        job = ProcessingJob.objects.create(id=31, photo=photo)
        SourcePhoto.objects.filter(pk=11).update(created_at=NOW)
        ProcessingJob.objects.filter(pk=31).update(created_at=NOW, available_at=NOW)
        token = self.client.get("/api/recognition/csrf/").json()["csrf_token"]
        self.client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")
        with patch("recognition.queue.db_now", return_value=NOW), patch("django.utils.timezone.now", return_value=NOW):
            claim_job()
            self.assertEqual(self.client.get("/api/recognition/jobs/31/").json(), self.expected("job-running.json"))
            requested = self.client.post("/api/recognition/jobs/31/cancel/", {}, format="json")
            self.assertEqual(requested.status_code, 202)
            self.assertEqual(requested.json(), self.expected("job-cancel-requested.json"))
