import io
import os
import subprocess
import struct
import sys
import tempfile
import zlib
from pathlib import Path
from unittest.mock import patch

from django.conf import settings
from django.test import SimpleTestCase, override_settings
from PIL import Image, ImageOps, PngImagePlugin

from recognition.images import ImageError, crop_receipt, inspect_image, prepare_upright, validate_geometry

BOX = {"x_min": 0.2, "y_min": 0.25, "x_max": 0.8, "y_max": 0.75}


class ImageTests(SimpleTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="checkist-images-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.override = override_settings(MEDIA_ROOT=self.root / "media", RECEIPT_OCR_TEMP_ROOT=self.root / "scratch")
        self.override.enable()
        self.addCleanup(self.override.disable)

    def source(self, format="PNG", size=(100, 200), **save_kwargs):
        path = self.root / f"source.{format.lower()}"
        with Image.new("RGB", size, "white") as image:
            image.save(path, format=format, **save_kwargs)
        return path

    def error(self, code, callback):
        with self.assertRaises(ImageError) as caught:
            callback()
        self.assertEqual(caught.exception.code, code)

    def test_formats_sniffed_and_decoded(self):
        for format, content_type in (("JPEG", "image/jpeg"), ("PNG", "image/png"), ("WEBP", "image/webp")):
            with self.subTest(format=format):
                source = self.source(format)
                renamed = source.with_name(f"{format}.heic")
                source.rename(renamed)
                info = inspect_image(renamed)
                self.assertEqual((info.content_type, info.width, info.height), (content_type, 100, 200))

    def test_byte_limit_inclusive_and_above(self):
        path = self.source()
        with path.open("ab") as stream:
            stream.write(b"\x00" * (settings.RECEIPT_IMAGE_MAX_BYTES - path.stat().st_size))
        self.assertEqual(inspect_image(path).bytes, 20971520)
        with path.open("ab") as stream:
            stream.write(b"x")
        self.error("file_too_large", lambda: inspect_image(path))

    def test_real_40mp_boundary_all_formats(self):
        for format in ("JPEG", "PNG", "WEBP"):
            with self.subTest(format=format):
                path = self.source(format, size=(8000, 5000))
                info = inspect_image(path)
                self.assertEqual(info.width * info.height, 40000000)

    def test_pixel_limit_before_full_decode(self):
        path = self.source("JPEG", size=(8001, 5000))
        from PIL.JpegImagePlugin import JpegImageFile
        with patch.object(JpegImageFile, "load", side_effect=AssertionError("must reject header before full decode")):
            self.error("image_too_large", lambda: inspect_image(path))

    def test_decompression_bomb_header_rejected(self):
        def chunk(kind, data):
            return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
        path = self.root / "bomb.png"
        path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 100000, 100000, 8, 2, 0, 0, 0))
                         + chunk(b"IDAT", zlib.compress(b"\x00")) + chunk(b"IEND", b""))
        self.error("image_too_large", lambda: inspect_image(path))

    def test_empty_corrupt_truncated_and_heic(self):
        cases = [(b"", "invalid_image"), (b"\xff\xd8broken", "invalid_image"),
                 (b"\x89PNG\r\n\x1a\n", "invalid_image"),
                 (b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heic", "unsupported_format"),
                 (b"<svg></svg>", "unsupported_format")]
        for index, (data, code) in enumerate(cases):
            path = self.root / str(index)
            path.write_bytes(data)
            with self.subTest(index=index):
                self.error(code, lambda: inspect_image(path))
        for format in ("JPEG", "PNG", "WEBP"):
            path = self.source(format)
            path.write_bytes(path.read_bytes()[:-20])
            with self.subTest(format=format):
                self.error("invalid_image", lambda: inspect_image(path))

    def test_animation_rejected(self):
        for format in ("PNG", "WEBP", "GIF"):
            path = self.root / f"animated.{format.lower()}"
            with Image.new("RGB", (10, 10), "white") as first, Image.new("RGB", (10, 10), "black") as second:
                first.save(path, format=format, save_all=True, append_images=[second], duration=50, loop=0)
            self.error("unsupported_format" if format == "GIF" else "invalid_image", lambda: inspect_image(path))

    def test_exif_all_orientations_and_no_metadata(self):
        for orientation in range(1, 9):
            with self.subTest(orientation=orientation), Image.new("RGB", (3, 2)) as original:
                original.putdata([(10, 20, 30), (40, 50, 60), (70, 80, 90), (100, 110, 120), (130, 140, 150), (160, 170, 180)])
                exif = Image.Exif()
                exif[274] = orientation
                exif[270] = "Private description"
                path = self.root / f"exif{orientation}.png"
                metadata = PngImagePlugin.PngInfo()
                metadata.add_text("Private", "Private text")
                original.save(path, exif=exif, pnginfo=metadata)
                source_bytes = path.read_bytes()
                target = self.root / f"upright{orientation}.png"
                info = prepare_upright(path, target)
                with Image.open(path) as encoded, Image.open(target) as upright:
                    with ImageOps.exif_transpose(encoded) as expected:
                        self.assertEqual(upright.tobytes(), expected.tobytes())
                        self.assertEqual(upright.size, (info.width, info.height))
                    self.assertEqual(upright.mode, "RGB")
                    self.assertEqual(len(upright.getexif()), 0)
                    self.assertEqual(upright.info, {})
                self.assertEqual(path.read_bytes(), source_bytes)

    def test_alpha_uses_white_background(self):
        path = self.root / "alpha.png"
        with Image.new("RGBA", (2, 1), (255, 0, 0, 0)) as image:
            image.putpixel((1, 0), (255, 0, 0, 255))
            image.save(path)
        target = self.root / "alpha-upright.png"
        prepare_upright(path, target)
        with Image.open(target) as image:
            self.assertEqual(image.getpixel((0, 0)), (255, 255, 255))
            self.assertEqual(image.getpixel((1, 0)), (255, 0, 0))

    def test_crop_padding_floor_ceil_clamp_and_rotation_metadata(self):
        path = self.source()
        target = self.root / "crop.png"
        quad = [{"x": .2, "y": .25}, {"x": .8, "y": .25}, {"x": .8, "y": .75}, {"x": .2, "y": .75}]
        info = crop_receipt(path, target, BOX, quad=quad, rotation_degrees=12)
        self.assertEqual(info.crop_transform["pixel_bbox"], [19, 48, 81, 152])
        self.assertEqual((info.width, info.height, info.rotation_degrees), (62, 104, 12))
        full = crop_receipt(path, target, {"x_min": 0, "y_min": 0, "x_max": 1, "y_max": 1})
        self.assertEqual(full.crop_transform["pixel_bbox"], [0, 0, 100, 200])
        fractional = crop_receipt(path, target, {"x_min": .205, "y_min": .255, "x_max": .805, "y_max": .755})
        self.assertEqual(fractional.crop_transform["pixel_bbox"], [19, 49, 82, 153])

    def test_invalid_geometry(self):
        boxes = [{}, {**BOX, "other": 1}, {**BOX, "x_min": True}, {**BOX, "x_min": float("nan")},
                 {**BOX, "y_max": float("inf")}, {**BOX, "x_min": -.1}, {**BOX, "x_max": 1.1},
                 {**BOX, "x_max": .1}, {**BOX, "y_max": .25}]
        for box in boxes:
            with self.subTest(box=box):
                self.error("geometry_requires_review", lambda: validate_geometry(box))
        quad = [{"x": .2, "y": .25}, {"x": .8, "y": .25}, {"x": .8, "y": .75}, {"x": .2, "y": .75}]
        for invalid in ([], quad[:3], list(reversed(quad)), [*quad[1:], quad[0]], [quad[0], quad[2], quad[1], quad[3]], [{"x": 0, "y": 0}, *quad[1:]]):
            self.error("geometry_requires_review", lambda: validate_geometry(BOX, invalid))
        for angle in (True, float("nan"), 181, -181):
            self.error("geometry_requires_review", lambda: validate_geometry(BOX, rotation_degrees=angle))


class RecognitionSettingsTests(SimpleTestCase):
    def test_invalid_recognition_configuration_rejected(self):
        for key, value in (("RECEIPT_OCR_PROVIDER", "auto"), ("ALLOW_LOCAL_RECOGNITION_API", "maybe"),
                           ("MEDIA_ROOT", "relative"), ("MEDIA_URL", "https://example.test/media/"),
                           ("RECEIPT_IMAGE_MAX_BYTES", "100"), ("RECEIPT_OCR_MAX_CONCURRENCY", "2"),
                           ("RECEIPT_OCR_DETECT_TIMEOUT_SECONDS", "0"),
                           ("DJANGO_CSRF_TRUSTED_ORIGINS", "http://external.test:5173"),
                           ("DJANGO_CSRF_TRUSTED_ORIGINS", "http://localhost:5173/path")):
            environment = os.environ.copy()
            environment[key] = value
            with self.subTest(key=key, value=value):
                result = subprocess.run([sys.executable, "-X", "utf8", "-c", "import config.settings"],
                                        cwd=settings.BASE_DIR, env=environment, capture_output=True, text=True, timeout=10)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("ImproperlyConfigured", result.stderr)

    def test_media_and_scratch_must_be_separate(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = os.environ.copy()
            environment.update(MEDIA_ROOT=directory, RECEIPT_OCR_TEMP_ROOT=str(Path(directory) / "private"))
            result = subprocess.run([sys.executable, "-X", "utf8", "-c", "import config.settings"],
                                    cwd=settings.BASE_DIR, env=environment, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be separate", result.stderr)
