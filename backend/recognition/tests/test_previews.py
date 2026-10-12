"""Display previews: WebP next to the source, written once, never read by recognition."""
import io
import json
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, TestCase, override_settings, tag
from PIL import Image

from receipts.ownership import local_user
from recognition.images import write_preview
from recognition.models import ProcessingJob, ReceiptImage
from recognition.previews import ensure_variant, is_variant, variant_name, variant_url
from .test_models import make_photo


def picture(path, size, format="PNG", **options):
    path.parent.mkdir(parents=True, exist_ok=True)
    with Image.new("RGB", size, (200, 30, 30)) as image:
        image.save(path, format=format, **options)
    return path


class PreviewTests(SimpleTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="checkist-previews-")
        self.addCleanup(temp.cleanup)
        self.media = Path(temp.name) / "media"
        override = override_settings(MEDIA_ROOT=self.media)
        override.enable()
        self.addCleanup(override.disable)

    def test_names_sit_beside_the_source(self):
        self.assertEqual(variant_name("originals/u/source.jpg", "display"), "originals/u/preview-1600-v1.webp")
        self.assertEqual(variant_name("crops/u/3/1-x/crop.png", "thumb"), "crops/u/3/1-x/thumb-400-v1.webp")
        self.assertEqual(variant_url("originals/u/source.jpg", "thumb"), "/media/originals/u/thumb-400-v1.webp")
        self.assertIsNone(variant_url("", "thumb"))
        self.assertIsNone(variant_url(None, "display"))
        self.assertTrue(is_variant(["originals", "u", "preview-1600-v1.webp"]))
        self.assertTrue(is_variant(["crops", "u", "1", "1-x", "thumb-400-v1.webp"]))
        for segments in (["prepared", "u", "x", "preview-1600-v1.webp"], ["originals", "preview-1600-v1.webp"],
                         ["originals", "u", "source.png"], ["originals", "u", "preview-1600-v2.webp"]):
            with self.subTest(segments=segments):
                self.assertFalse(is_variant(segments))

    def test_preview_is_a_webp_with_the_longest_side_limited(self):
        picture(self.media / "originals/u/source.png", (4000, 3000))
        for kind, size in (("display", (1600, 1200)), ("thumb", (400, 300))):
            with self.subTest(kind=kind):
                target = self.media / variant_name("originals/u/source.png", kind)
                self.assertTrue(ensure_variant(target))
                with Image.open(target) as image:
                    self.assertEqual((image.format, image.size), ("WEBP", size))

    def test_small_source_is_not_enlarged_and_exif_is_applied(self):
        source = self.media / "originals/u/source.jpg"
        source.parent.mkdir(parents=True)
        with Image.new("RGB", (300, 100), "white") as image:
            exif = image.getexif()
            exif[274] = 6  # rotate 90° clockwise to show
            image.save(source, format="JPEG", exif=exif)
        target = self.media / "originals/u/preview-1600-v1.webp"
        self.assertTrue(ensure_variant(target))
        with Image.open(target) as image:
            self.assertEqual(image.size, (100, 300))
            self.assertNotIn("exif", image.info)

    def test_second_call_keeps_the_file(self):
        picture(self.media / "crops/u/1/1-x/crop.png", (800, 1600))
        target = self.media / "crops/u/1/1-x/thumb-400-v1.webp"
        self.assertTrue(ensure_variant(target))
        first = target.stat()
        with patch("recognition.previews.write_preview") as write:
            self.assertTrue(ensure_variant(target))
        write.assert_not_called()
        self.assertEqual((target.stat().st_mtime_ns, target.stat().st_size), (first.st_mtime_ns, first.st_size))
        # Nothing but the source and its variant: the staging directory is outside MEDIA.
        self.assertEqual(sorted(path.name for path in target.parent.iterdir()), ["crop.png", "thumb-400-v1.webp"])

    def test_no_source_or_unreadable_source_writes_nothing(self):
        directory = self.media / "originals/u"
        directory.mkdir(parents=True)
        self.assertFalse(ensure_variant(directory / "preview-1600-v1.webp"))
        (directory / "source.png").write_bytes(b"\x89PNG broken")
        self.assertFalse(ensure_variant(directory / "preview-1600-v1.webp"))
        self.assertFalse(ensure_variant(directory / "other.webp"))
        self.assertEqual([path.name for path in directory.iterdir()], ["source.png"])

    def test_write_preview_returns_its_size(self):
        source = picture(self.media / "a.png", (1000, 2000))
        self.assertEqual(write_preview(source, self.media / "a.webp", 400), (200, 400))


@tag("integration")
class BackfillTests(TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="checkist-previews-backfill-")
        self.addCleanup(temp.cleanup)
        self.media = Path(temp.name) / "media"
        override = override_settings(MEDIA_ROOT=self.media)
        override.enable()
        self.addCleanup(override.disable)

    def run_command(self, *args):
        out = io.StringIO()
        call_command("media_previews", "backfill", *args, stdout=out)
        return json.loads(out.getvalue())

    def test_backfill_writes_missing_previews_once(self):
        storage_uuid = uuid.uuid4()
        original = f"originals/{storage_uuid}/source.png"
        picture(self.media / original, (2000, 1000))
        photo = make_photo(local_user(), storage_uuid=storage_uuid, original_file=original)
        job = ProcessingJob.objects.create(photo=photo)
        crop = f"crops/{storage_uuid}/{job.pk}/1-{uuid.uuid4()}/crop.png"
        picture(self.media / crop, (500, 900))
        ReceiptImage.objects.create(photo=photo, job=job, position=1, file=crop, sha256="b" * 64, width=500,
                                    height=900, bbox={"x_min": 0.1, "y_min": 0.1, "x_max": 0.9, "y_max": 0.9})
        make_photo(local_user(), original_file=f"originals/{uuid.uuid4()}/source.png")  # its file is gone
        self.assertEqual(self.run_command("--dry-run"),
                         {"dry_run": True, "written": 4, "present": 0, "missing_source": 1, "failed": 0})
        self.assertFalse((self.media / variant_name(original, "display")).exists())
        self.assertEqual(self.run_command(), {"dry_run": False, "written": 4, "present": 0, "missing_source": 1, "failed": 0})
        for name in (original, crop):
            for kind in ("display", "thumb"):
                self.assertTrue((self.media / variant_name(name, kind)).is_file())
        self.assertEqual(self.run_command(), {"dry_run": False, "written": 0, "present": 4, "missing_source": 1, "failed": 0})

    def test_unreadable_source_fails_the_command(self):
        storage_uuid = uuid.uuid4()
        original = f"originals/{storage_uuid}/source.png"
        (self.media / original).parent.mkdir(parents=True)
        (self.media / original).write_bytes(b"\x89PNG broken")
        make_photo(local_user(), storage_uuid=storage_uuid, original_file=original)
        with self.assertRaises(CommandError):
            self.run_command()
