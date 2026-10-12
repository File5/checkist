"""PDF upload: rendering in a child process, limits and the kept PDF beside its image."""
import hashlib
import math
import subprocess
import tempfile
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase, TransactionTestCase, override_settings, tag
from PIL import Image

from receipts.ownership import local_user
from recognition import queue
from recognition.images import ImageError
from recognition.models import ReceiptImage, SourcePhoto
from recognition.pdf import PDF_MAX_PAGES, is_pdf, render_pdf
from recognition.pipeline import process_job
from recognition.providers.fake import FakeProvider
from recognition.statuses import AttemptPhase
from recognition.storage import accept_upload, media_path

from .pdf_factories import pdf_bytes
from .test_pipeline import PipelineEnvironment

# 200 x 300 pt at 200 DPI.
PAGE = (math.ceil(200 * 200 / 72), math.ceil(300 * 200 / 72))


class RenderPdfTests(SimpleTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="checkist-pdf-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)

    def render(self, data):
        source = self.root / "source"
        source.write_bytes(data)
        return render_pdf(source, self.root)

    def code(self, data):
        with self.assertRaises(ImageError) as caught:
            self.render(data)
        return caught.exception.code

    def test_one_page_becomes_a_png_at_200_dpi(self):
        rendered = self.render(pdf_bytes())
        self.assertEqual((rendered.pages, rendered.path.name), (1, "rendered.png"))
        with Image.open(rendered.path) as image:
            self.assertEqual((image.format, image.mode), ("PNG", "RGB"))
            self.assertEqual(image.size, PAGE)
            # The black square of the page is in its lower left corner, the rest is white.
            self.assertEqual(image.getpixel((5, image.height - 5)), (0, 0, 0))
            self.assertEqual(image.getpixel((image.width - 5, 5)), (255, 255, 255))

    def test_three_pages_are_stacked_into_one_image(self):
        rendered = self.render(pdf_bytes(pages=3))
        self.assertEqual(rendered.pages, 3)
        with Image.open(rendered.path) as image:
            self.assertEqual(image.size, (PAGE[0], 3 * PAGE[1]))
            for page in range(3):
                self.assertEqual(image.getpixel((5, (page + 1) * PAGE[1] - 5)), (0, 0, 0))

    def test_more_pages_than_the_limit_are_refused(self):
        self.assertEqual(PDF_MAX_PAGES, 3)
        self.assertEqual(self.code(pdf_bytes(pages=4)), "pdf_too_many_pages")

    def test_password_protected_pdf_is_refused(self):
        self.assertEqual(self.code(pdf_bytes(encrypted=True)), "pdf_encrypted")

    def test_broken_or_empty_pdf_is_invalid(self):
        for data in (b"%PDF-1.4 garbage", pdf_bytes()[:120], b"%PDF-", pdf_bytes(pages=0)):
            with self.subTest(size=len(data)):
                self.assertEqual(self.code(data), "invalid_pdf")
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["source"])

    def test_scale_goes_down_to_the_pixel_limit(self):
        with override_settings(RECEIPT_IMAGE_MAX_PIXELS=100_000):
            rendered = self.render(pdf_bytes(pages=2, size=(595, 842)))
        with Image.open(rendered.path) as image:
            self.assertLessEqual(image.width * image.height, 100_000)
            self.assertGreater(image.width * image.height, 50_000)

    def test_a_png_over_the_byte_limit_is_written_as_jpeg(self):
        # A scan inside the PDF: about 190 KB as a PNG, about 80 KB as a JPEG.
        with override_settings(RECEIPT_IMAGE_MAX_BYTES=150_000):
            rendered = self.render(pdf_bytes(photo=True))
        self.assertEqual(rendered.path.name, "rendered.jpg")
        with Image.open(rendered.path) as image:
            self.assertEqual((image.format, image.size), ("JPEG", PAGE))
        with override_settings(RECEIPT_IMAGE_MAX_BYTES=10_000):
            self.assertEqual(self.code(pdf_bytes(photo=True)), "image_too_large")

    def test_timeout_and_crash_of_the_child_are_invalid_pdf(self):
        with patch("recognition.pdf.subprocess.run", side_effect=subprocess.TimeoutExpired("python", 30)):
            self.assertEqual(self.code(pdf_bytes()), "invalid_pdf")
        crashed = subprocess.CompletedProcess([], -9, stdout=b"", stderr=b"")
        with patch("recognition.pdf.subprocess.run", return_value=crashed):
            self.assertEqual(self.code(pdf_bytes()), "invalid_pdf")
        foreign = subprocess.CompletedProcess([], 0, stdout=b'{"pages": 1, "file": "/etc/passwd"}', stderr=b"")
        with patch("recognition.pdf.subprocess.run", return_value=foreign):
            self.assertEqual(self.code(pdf_bytes()), "invalid_pdf")

    def test_child_runs_isolated_with_a_timeout(self):
        with patch("recognition.pdf.subprocess.run", wraps=subprocess.run) as run:
            self.render(pdf_bytes())
        command, options = run.call_args.args[0], run.call_args.kwargs
        self.assertEqual(command[1], "-I")
        self.assertEqual(options["timeout"], 30)

    def test_is_pdf_reads_the_bytes(self):
        cases = {b"%PDF-1.7\n": True, b"\n\n%PDF-1.4": True, b"\x89PNG\r\n\x1a\n%PDF-": False,
                 b"\xff\xd8\xff%PDF-": False, b"PDF": False, b"": False}
        for data, expected in cases.items():
            with self.subTest(data=data):
                path = self.root / "probe"
                path.write_bytes(data)
                self.assertIs(is_pdf(path), expected)


@tag("integration")
class PdfUploadTests(TransactionTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="checkist-pdf-upload-")
        self.addCleanup(temp.cleanup)
        self.media = Path(temp.name) / "media"
        override = override_settings(MEDIA_ROOT=self.media)
        override.enable()
        self.addCleanup(override.disable)
        self.owner = local_user()

    def upload(self, data, name="bill.pdf"):
        return accept_upload(SimpleUploadedFile(name, data, content_type="application/pdf"), owner=self.owner)

    def files(self):
        return sorted(path.relative_to(self.media).as_posix() for path in self.media.rglob("*") if path.is_file())

    def test_pdf_is_kept_beside_its_rendered_image(self):
        data = pdf_bytes(pages=2)
        photo, created = self.upload(data)
        self.assertTrue(created)
        self.assertEqual((photo.content_type, photo.width, photo.height), ("image/png", PAGE[0], 2 * PAGE[1]))
        self.assertEqual(photo.original_file.name, f"originals/{photo.storage_uuid}/source.png")
        self.assertEqual(photo.document_file.name, f"originals/{photo.storage_uuid}/source.pdf")
        self.assertEqual((photo.document_bytes, photo.document_pages), (len(data), 2))
        self.assertEqual(media_path(photo.document_file.name).read_bytes(), data)
        # sha256 is that of the PDF the person sent, not of the image made from it.
        self.assertEqual(photo.sha256, hashlib.sha256(data).hexdigest())
        self.assertEqual(photo.bytes, media_path(photo.original_file.name).stat().st_size)
        self.assertEqual(self.files(), [photo.document_file.name, photo.original_file.name])

    def test_same_pdf_again_is_the_same_photo_without_rendering(self):
        data = pdf_bytes()
        photo, _ = self.upload(data)
        with patch("recognition.storage.render_pdf") as render:
            again, created = self.upload(data, name="other-name.pdf")
        render.assert_not_called()
        self.assertFalse(created)
        self.assertEqual(again.pk, photo.pk)
        self.assertEqual(SourcePhoto.objects.count(), 1)
        self.assertEqual(len(self.files()), 2)

    def test_refused_pdf_leaves_no_row_and_no_file(self):
        for data, code in ((pdf_bytes(pages=4), "pdf_too_many_pages"), (pdf_bytes(encrypted=True), "pdf_encrypted"),
                           (b"%PDF-1.4 broken", "invalid_pdf")):
            with self.subTest(code=code):
                with self.assertRaises(ImageError) as caught:
                    self.upload(data)
                self.assertEqual(caught.exception.code, code)
        self.assertEqual(SourcePhoto.objects.count(), 0)
        self.assertEqual(self.files(), [])

    def test_image_upload_has_no_document(self):
        with BytesIO() as stream, Image.new("RGB", (10, 20), "white") as image:
            image.save(stream, format="PNG")
            photo, _ = accept_upload(SimpleUploadedFile("a.png", stream.getvalue()), owner=self.owner)
        photo.refresh_from_db()
        self.assertFalse(photo.document_file)
        self.assertIsNone(photo.document_pages)


@tag("integration")
class PdfPipelineTests(PipelineEnvironment):
    def test_pdf_is_one_receipt_without_asking_the_model_to_detect(self):
        photo, _ = accept_upload(BytesIO(pdf_bytes(pages=2)), owner=local_user())
        self.assertTrue(photo.document_file)
        queue.create_job(photo)
        job = queue.claim_job()
        with patch.object(FakeProvider, "detect", side_effect=AssertionError("detect must not run")):
            result = process_job(job, provider=FakeProvider("one_receipt"))
        self.assertEqual((result.status, result.detected_count, result.imported_count), ("succeeded", 1, 1))
        image = ReceiptImage.objects.get(job=result)
        self.assertEqual(image.bbox, {"x_min": 0.0, "y_min": 0.0, "x_max": 1.0, "y_max": 1.0})
        self.assertEqual((image.width, image.height), (photo.width, photo.height))
        self.assertFalse(result.attempts.filter(phase=AttemptPhase.DETECT).exists())
        self.assertTrue(result.attempts.filter(phase=AttemptPhase.RECOGNIZE).exists())

    def test_photo_still_asks_the_model_to_detect(self):
        result = self.process("one_receipt")
        self.assertEqual(result.status, "succeeded")
        self.assertTrue(result.attempts.filter(phase=AttemptPhase.DETECT).exists())
