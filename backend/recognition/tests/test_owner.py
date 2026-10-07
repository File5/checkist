import uuid

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.test import TestCase, tag

from recognition.models import SourcePhoto

User = get_user_model()

SHA256 = "a" * 64


def photo(owner, **fields):
    values = dict(
        owner=owner, original_file=f"originals/{uuid.uuid4()}/source.png", sha256=SHA256,
        content_type="image/png", bytes=100, raw_width=100, raw_height=200, width=100, height=200,
    )
    values.update(fields)
    return SourcePhoto.objects.create(**values)


@tag("integration")
class PhotoOwnerConstraintTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user("synthetic-owner-one")
        cls.other_owner = User.objects.create_user("synthetic-owner-two")

    def assertRejected(self, name, operation):
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            operation()
        self.assertIn(name, str(caught.exception))

    def test_owner_is_required(self):
        self.assertRejected("owner_id", lambda: photo(None))
        self.assertFalse(SourcePhoto.objects.exists())

    def test_owner_field_has_no_default_and_no_null(self):
        field = SourcePhoto._meta.get_field("owner")
        self.assertFalse(field.null)
        self.assertFalse(field.blank)
        self.assertFalse(field.has_default())
        self.assertIs(field.related_model, User)

    def test_owner_with_photos_is_protected(self):
        source = photo(self.owner)
        with self.assertRaises(ProtectedError), transaction.atomic():
            self.owner.delete()
        self.assertTrue(SourcePhoto.objects.filter(pk=source.pk).exists())

    def test_related_name(self):
        source = photo(self.owner)
        self.assertEqual(list(self.owner.source_photos.all()), [source])
        self.assertEqual(list(self.other_owner.source_photos.all()), [])

    def test_same_file_of_one_owner_is_rejected(self):
        photo(self.owner)
        self.assertRejected("rec_photo_owner_sha256_uniq", lambda: photo(self.owner))
        self.assertEqual(SourcePhoto.objects.count(), 1)

    def test_same_file_of_two_owners_is_allowed(self):
        first = photo(self.owner)
        second = photo(self.other_owner)
        self.assertNotEqual(first.pk, second.pk)
        self.assertNotEqual(first.storage_uuid, second.storage_uuid)
        self.assertEqual(SourcePhoto.objects.filter(sha256=SHA256).count(), 2)
        # Another owner's copy does not lift the ban on an own duplicate.
        self.assertRejected("rec_photo_owner_sha256_uniq", lambda: photo(self.other_owner))

    def test_different_files_of_one_owner_are_allowed(self):
        photo(self.owner)
        photo(self.owner, sha256="b" * 64)
        self.assertEqual(self.owner.source_photos.count(), 2)

    def test_sha256_is_unique_only_with_owner(self):
        self.assertFalse(SourcePhoto._meta.get_field("sha256").unique)
        unique = [c for c in SourcePhoto._meta.constraints if c.name == "rec_photo_owner_sha256_uniq"]
        self.assertEqual(len(unique), 1)
        self.assertEqual(tuple(unique[0].fields), ("owner", "sha256"))
        self.assertIsNone(unique[0].condition)

    def test_index_names(self):
        self.assertEqual(
            {index.name: index.fields for index in SourcePhoto._meta.indexes},
            {
                "rec_photo_created_idx": ["created_at", "id"],
                "rec_photo_owner_created_idx": ["owner", "created_at", "id"],
            },
        )
