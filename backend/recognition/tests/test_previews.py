"""Display previews: WebP next to the source, written once, never read by recognition."""
import io
import json
import math
import random
import tempfile
import uuid
from pathlib import Path
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import SimpleTestCase, TestCase, override_settings, tag
from PIL import Image, ImageChops, ImageDraw, ImageStat

from receipts.ownership import local_user
from recognition.images import crop_receipt, scan_quad, write_preview
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
        self.assertEqual(variant_name("crops/u/3/1-x/crop.png", "thumb"), "crops/u/3/1-x/thumb-400-v2.webp")
        self.assertEqual(variant_url("originals/u/source.jpg", "thumb"), "/media/originals/u/thumb-400-v1.webp")
        self.assertIsNone(variant_url("", "thumb"))
        self.assertIsNone(variant_url(None, "display"))
        self.assertTrue(is_variant(["originals", "u", "preview-1600-v1.webp"]))
        self.assertTrue(is_variant(["crops", "u", "1", "1-x", "thumb-400-v2.webp"]))
        for segments in (["prepared", "u", "x", "preview-1600-v1.webp"], ["originals", "preview-1600-v1.webp"],
                         ["originals", "u", "source.png"], ["originals", "u", "preview-1600-v2.webp"],
                         ["crops", "u", "1", "1-x", "thumb-400-v1.webp"]):
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
        self.assertEqual(sorted(path.name for path in (self.media / crop).parent.iterdir()),
                         ["crop.png", "preview-1600-v2.webp", "thumb-400-v2.webp"])
        self.assertEqual(self.run_command(), {"dry_run": False, "written": 0, "present": 4, "missing_source": 1, "failed": 0})

    def test_unreadable_source_fails_the_command(self):
        storage_uuid = uuid.uuid4()
        original = f"originals/{storage_uuid}/source.png"
        (self.media / original).parent.mkdir(parents=True)
        (self.media / original).write_bytes(b"\x89PNG broken")
        make_photo(local_user(), storage_uuid=storage_uuid, original_file=original)
        with self.assertRaises(CommandError):
            self.run_command()


class ScanQuadTests(SimpleTestCase):
    """The quad of a crop becomes Pillow perspective data; implausible corners keep the bbox crop."""
    BOX = {"x_min": 0.2, "y_min": 0.1, "x_max": 0.6, "y_max": 0.9}
    QUAD = [{"x": 0.2, "y": 0.1}, {"x": 0.6, "y": 0.1}, {"x": 0.6, "y": 0.9}, {"x": 0.2, "y": 0.9}]
    TRANSFORM = {"source_width": 1000, "source_height": 1000, "pixel_bbox": [190, 90, 610, 910], "padding": 0.01}

    def test_upright_quad_is_its_rectangle_with_a_margin(self):
        size, (a, b, c, d, e, f, g, h) = scan_quad(self.BOX, self.QUAD, self.TRANSFORM)
        self.assertEqual(size, (412, 824))  # 400 × 800 and 1.5 % on each side
        # Output (0, 0) is 1.5 % outside the top left corner, crop pixel (10, 10): (10 - 6, 10 - 12).
        for value, expected in ((a, 400 * 1.03 / 412), (b, 0), (c, 4), (d, 0), (e, 800 * 1.03 / 824), (f, -2),
                                (g, 0), (h, 0)):
            self.assertAlmostEqual(value, expected)

    def test_implausible_corners_are_refused(self):
        q = self.QUAD
        cases = {
            "no quad": (self.BOX, None, self.TRANSFORM, 0),
            "no crop transform": (self.BOX, q, {}, 0),
            "counterclockwise": (self.BOX, q[::-1], self.TRANSFORM, 0),
            "half of the bbox": (self.BOX, [q[0], q[1], {"x": 0.6, "y": 0.5}, {"x": 0.2, "y": 0.5}], self.TRANSFORM, 0),
            "order against the text": (self.BOX, q[1:] + q[:1], self.TRANSFORM, 0),
            "steep perspective": (self.BOX, [{"x": 0.35, "y": 0.1}, {"x": 0.45, "y": 0.1}, q[2], q[3]], self.TRANSFORM, 0),
            "sliver": ({**self.BOX, "x_max": 0.23}, [q[0], {"x": 0.23, "y": 0.1}, {"x": 0.23, "y": 0.9}, q[3]],
                       self.TRANSFORM, 0),
        }
        for label, arguments in cases.items():
            with self.subTest(label):
                self.assertIsNone(scan_quad(*arguments))
        self.assertIsNotNone(scan_quad(self.BOX, q[1:] + q[:1], self.TRANSFORM, 90))  # text turned 90°: in order


PALETTE = ((220, 40, 40), (40, 170, 60), (40, 80, 220), (230, 190, 20), (190, 40, 190), (20, 190, 200))
PAPER, INK = (240, 238, 230), (25, 25, 25)


def receipt_photo(path, *, angle=22, taper=0.85, size=(300, 900), photo=(1000, 1200)):
    """A light 300 × 900 receipt with 18 dark lines and a dark block top left, turned ``angle``° clockwise,
    its top side ``taper`` of the bottom (perspective), on a busy background -> (bbox, quad, angle)."""
    rng, turn, (w, h) = random.Random(7), math.radians(angle), size

    def place(x, y):  # receipt-centred pixels -> photo pixels
        return (photo[0] / 2 + x * math.cos(turn) - y * math.sin(turn),
                photo[1] / 2 + x * math.sin(turn) + y * math.cos(turn))
    corners = [place(-w * taper / 2, -h / 2), place(w * taper / 2, -h / 2), place(w / 2, h / 2), place(-w / 2, h / 2)]

    def at(u, v):  # bilinear inside the quad: lines of the paper stay straight
        return tuple((1 - u) * (1 - v) * tl + u * (1 - v) * tr + u * v * br + (1 - u) * v * bl
                     for tl, tr, br, bl in zip(*corners))
    path.parent.mkdir(parents=True, exist_ok=True)
    with Image.new("RGB", photo, PALETTE[0]) as image:
        draw = ImageDraw.Draw(image)
        for _ in range(900):
            x, y = rng.randrange(photo[0]), rng.randrange(photo[1])
            draw.rectangle((x, y, x + rng.randrange(10, 90), y + rng.randrange(10, 90)), fill=rng.choice(PALETTE))
        draw.polygon(corners, fill=PAPER)
        lines = ((0.1, 0.1 + row * 0.048, 0.9, 0.114 + row * 0.048) for row in range(18))
        for u0, v0, u1, v1 in ((0.1, 0.02, 0.45, 0.06), *lines):
            draw.polygon([at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1)], fill=INK)
        image.save(path, format="PNG")
    quad = [{"x": x / photo[0], "y": y / photo[1]} for x, y in corners]
    bbox = {"x_min": min(p["x"] for p in quad), "y_min": min(p["y"] for p in quad),
            "x_max": max(p["x"] for p in quad), "y_max": max(p["y"] for p in quad)}
    return bbox, quad, angle


def saturated(image):
    """Share of the busy background: colourful pixels (max - min of RGB over 60); paper and ink are grey."""
    red, green, blue = image.convert("RGB").split()
    chroma = ImageChops.subtract(ImageChops.lighter(red, ImageChops.lighter(green, blue)),
                                 ImageChops.darker(red, ImageChops.darker(green, blue)))
    histogram = chroma.histogram()
    return sum(histogram[60:]) / sum(histogram)


def dark_rows(image):
    """Rows of the middle 60 % of the width that are dark from end to end: lines running straight across."""
    width, height = image.size
    gray = image.convert("L").crop((round(width * 0.2), 0, round(width * 0.8), height))
    dark = gray.point(lambda value: 255 if value < 110 else 0)
    return sum(ImageStat.Stat(dark.crop((0, y, dark.width, y + 1))).mean[0] > 0.95 * 255 for y in range(height))


@tag("integration")
class ScanPreviewTests(TestCase):
    """The v2 copies of a crop show the paper straightened; recognition still reads crop.png."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="checkist-previews-scan-")
        self.addCleanup(temp.cleanup)
        self.media = Path(temp.name) / "media"
        override = override_settings(MEDIA_ROOT=self.media)
        override.enable()
        self.addCleanup(override.disable)

    def crop(self, *, quad=True, document=False, **scene):
        storage_uuid = uuid.uuid4()
        source = self.media / f"prepared/{storage_uuid}/x/upright-v1.png"
        bbox, points, angle = receipt_photo(source, **scene)
        pdf = {"document_file": f"originals/{storage_uuid}/source.pdf", "document_bytes": 100, "document_pages": 1}
        photo = make_photo(local_user(), storage_uuid=storage_uuid, **(pdf if document else {}))
        job = ProcessingJob.objects.create(photo=photo)
        name = f"crops/{storage_uuid}/{job.pk}/1-{uuid.uuid4()}/crop.png"
        (self.media / name).parent.mkdir(parents=True)
        info = crop_receipt(source, self.media / name, bbox, quad=points if quad else None, rotation_degrees=angle)
        ReceiptImage.objects.create(photo=photo, job=job, position=1, file=name, sha256="c" * 64, width=info.width,
                                    height=info.height, bbox=info.bbox, quad=info.quad,
                                    rotation_degrees=info.rotation_degrees, crop_transform=info.crop_transform)
        return name

    def preview(self, name):
        target = self.media / variant_name(name, "display")
        self.assertEqual(target.name, "preview-1600-v2.webp")
        self.assertTrue(ensure_variant(target))
        return Image.open(target)

    def test_turned_receipt_in_perspective_is_straightened_text_up(self):
        name = self.crop()
        crop_bytes = (self.media / name).read_bytes()
        with self.preview(name) as image, Image.open(self.media / name) as crop:
            width, height = image.size
            # The paper at its own size with the 1.5 % margin: 300 × 900 -> 309 × 927.
            self.assertAlmostEqual(width, 309, delta=8)
            self.assertAlmostEqual(height, 927, delta=20)
            # Inside the thin margin nothing of the background is left; the bbox crop is half background.
            inner = (round(width * 0.04), round(height * 0.02), round(width * 0.96), round(height * 0.98))
            self.assertLess(saturated(image.crop(inner)), 0.002)
            self.assertGreater(saturated(crop), 0.3)
            # 18 lines of about 12 px run straight across; turned 22° in the crop, none does.
            self.assertGreater(dark_rows(image), 120)
            self.assertEqual(dark_rows(crop), 0)
            # Text up: the dark block is top left, the same place bottom right is paper.
            gray = image.convert("L")
            block = (round(width * 0.18), round(height * 0.045), round(width * 0.4), round(height * 0.065))
            mirrored = (width - block[2], height - block[3], width - block[0], height - block[1])
            self.assertLess(ImageStat.Stat(gray.crop(block)).mean[0], 80)
            self.assertGreater(ImageStat.Stat(gray.crop(mirrored)).mean[0], 200)
        self.assertEqual((self.media / name).read_bytes(), crop_bytes)  # recognition reads crop.png unchanged

    def test_without_usable_corners_or_for_a_pdf_the_crop_is_shown_as_it_is(self):
        for label, options in (("no quad", {"quad": False}), ("pdf", {"document": True}),
                               ("steep perspective", {"taper": 0.4})):
            with self.subTest(label):
                name = self.crop(**options)
                with self.preview(name) as image, Image.open(self.media / name) as crop:
                    self.assertEqual(image.size, crop.size)
                    self.assertGreater(saturated(image), 0.3)
