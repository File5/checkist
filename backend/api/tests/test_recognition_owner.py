import tempfile
from pathlib import Path
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import RequestFactory, TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.views.recognition_base import request_owner
from receipts.ownership import LOCAL_USERNAME, local_user
from recognition.models import ProcessingJob, SourcePhoto

from .test_recognition_api import image_bytes, upload


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class UploadReuseOwnerTests(TestCase):
    """POST /api/recognition/photos/ reuses a photo only within the owner of the request."""

    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.first = User.objects.create_user("synthetic-owner-one")
        cls.second = User.objects.create_user("synthetic-owner-two")

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="checkist-owner-upload-test-")
        self.addCleanup(self.directory.cleanup)
        self.settings_override = override_settings(MEDIA_ROOT=self.directory.name)
        self.settings_override.enable()
        self.addCleanup(self.settings_override.disable)
        self.client = APIClient(enforce_csrf_checks=True)
        response = self.client.get("/api/recognition/csrf/")
        self.assertEqual(response.status_code, 200)
        self.client.credentials(HTTP_X_CSRFTOKEN=response.json()["csrf_token"], HTTP_ORIGIN="http://testserver")

    def post_photo(self, owner=None):
        def post():
            return self.client.post("/api/recognition/photos/", {"file": upload()}, format="multipart")
        if owner is None:
            return post()
        with patch("api.views.recognition.request_owner", return_value=owner) as identity:
            response = post()
        identity.assert_called_once()
        return response

    def sources(self):
        return sorted(path.resolve() for path in Path(self.directory.name).rglob("source.*"))

    def test_request_owner_is_local_user(self):
        owner = request_owner(RequestFactory().get("/api/recognition/photos/"))
        self.assertEqual(owner.username, LOCAL_USERNAME)
        self.assertEqual(owner.pk, local_user().pk)
        self.assertEqual(request_owner(RequestFactory().get("/api/recognition/photos/")).pk, owner.pk)

    def test_upload_without_substitution_belongs_to_local(self):
        response = self.post_photo()
        self.assertEqual(response.status_code, 202, response.content)
        self.assertEqual(SourcePhoto.objects.get().owner.username, LOCAL_USERNAME)
        replay = self.post_photo()
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertTrue(replay.json()["reused"])
        self.assertEqual(SourcePhoto.objects.count(), 1)

    def test_same_file_of_two_owners_gives_two_photos_and_two_jobs(self):
        first = self.post_photo(self.first)
        second = self.post_photo(self.second)
        self.assertEqual(first.status_code, 202, first.content)
        self.assertEqual(second.status_code, 202, second.content)
        first, second = first.json(), second.json()
        self.assertFalse(first["reused"])
        self.assertFalse(second["reused"])
        self.assertNotEqual(first["photo"]["id"], second["photo"]["id"])
        self.assertNotEqual(first["job"]["id"], second["job"]["id"])
        self.assertEqual(second["job"]["status"], "queued")
        self.assertEqual(SourcePhoto.objects.count(), 2)
        self.assertEqual(ProcessingJob.objects.count(), 2)
        photos = {photo.pk: photo for photo in SourcePhoto.objects.all()}
        mine, theirs = photos[first["photo"]["id"]], photos[second["photo"]["id"]]
        self.assertEqual((mine.owner_id, theirs.owner_id), (self.first.pk, self.second.pk))
        self.assertEqual(mine.sha256, theirs.sha256)
        self.assertEqual(ProcessingJob.objects.get(pk=first["job"]["id"]).photo_id, mine.pk)
        self.assertEqual(ProcessingJob.objects.get(pk=second["job"]["id"]).photo_id, theirs.pk)
        mine_path, theirs_path = Path(mine.original_file.path).resolve(), Path(theirs.original_file.path).resolve()
        self.assertNotEqual(mine_path.parent, theirs_path.parent)
        self.assertEqual((mine_path.read_bytes(), theirs_path.read_bytes()), (image_bytes(), image_bytes()))
        self.assertEqual(self.sources(), sorted([mine_path, theirs_path]))

    def test_replay_reuses_own_photo_and_own_job(self):
        first = self.post_photo(self.first).json()
        second = self.post_photo(self.second).json()
        for owner, value in ((self.second, second), (self.first, first)):
            with self.subTest(owner=owner.username):
                replay = self.post_photo(owner)
                self.assertEqual(replay.status_code, 200, replay.content)
                replay = replay.json()
                self.assertTrue(replay["reused"])
                self.assertEqual(replay["photo"]["id"], value["photo"]["id"])
                self.assertEqual(replay["job"]["id"], value["job"]["id"])
        self.assertEqual(SourcePhoto.objects.count(), 2)
        self.assertEqual(ProcessingJob.objects.count(), 2)
        self.assertEqual(len(self.sources()), 2)
