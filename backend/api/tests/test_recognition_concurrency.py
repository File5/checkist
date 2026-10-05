import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor

from django.db import connections
from django.test import TransactionTestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.test_recognition_api import make_photo, upload
from recognition.models import ProcessingJob, SourcePhoto
from recognition.queue import request_cancel


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class RecognitionConcurrencyTests(TransactionTestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="checkist-c5-race-")
        self.addCleanup(directory.cleanup)
        settings = override_settings(MEDIA_ROOT=directory.name)
        settings.enable()
        self.addCleanup(settings.disable)

    def concurrent(self, callback):
        barrier = threading.Barrier(2)

        def execute():
            try:
                client = APIClient(enforce_csrf_checks=True)
                token = client.get("/api/recognition/csrf/").json()["csrf_token"]
                client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")
                barrier.wait(timeout=5)
                return callback(client)
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(execute) for _ in range(2)]
            return [future.result(timeout=15) for future in futures]

    def test_concurrent_exact_upload_reuses_photo_and_job(self):
        results = self.concurrent(lambda client: client.post("/api/recognition/photos/", {"file": upload()}, format="multipart"))
        self.assertEqual(sorted(response.status_code for response in results), [200, 202])
        self.assertEqual(SourcePhoto.objects.count(), 1)
        self.assertEqual(ProcessingJob.objects.count(), 1)
        self.assertEqual(results[0].json()["job"]["id"], results[1].json()["job"]["id"])

    def test_concurrent_retry_creates_one_job(self):
        job = ProcessingJob.objects.create(photo=make_photo())
        request_cancel(job.pk)
        results = self.concurrent(lambda client: client.post(f"/api/recognition/jobs/{job.pk}/retry/", {}, format="json"))
        self.assertEqual(sorted(response.status_code for response in results), [202, 409])
        self.assertEqual(ProcessingJob.objects.filter(retry_of=job).count(), 1)
        refused = next(response for response in results if response.status_code == 409)
        self.assertEqual(refused.json()["error"]["code"], "job_active")
