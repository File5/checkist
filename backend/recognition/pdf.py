"""PDF bills and e-receipts: the upload is rendered to one image and processed as that image.

The PDF itself is kept next to the image for download only; recognition never reads it.
Rendering runs in a child process (``pdf_render.py``) with a hard timeout: PDFium cannot be
interrupted and is not thread-safe, and a hostile PDF must not hold a web worker.
"""
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from django.conf import settings

from .images import ImageError

# At most this many pages; a longer PDF is refused (`pdf_too_many_pages`), never cut silently.
PDF_MAX_PAGES = 3
# Text of a bill stays legible for the model; the scale goes down when the pages would not fit
# RECEIPT_IMAGE_MAX_PIXELS together.
PDF_RENDER_DPI = 200
PDF_RENDER_TIMEOUT_SECONDS = 30
# A hostile PDF may unpack huge embedded images inside PDFium whatever the output size: the child
# gets its own memory and CPU ceiling, so it dies instead of the web container. 1 GiB holds a
# 3-page bill at 200 DPI with room to spare.
PDF_RENDER_MEMORY_BYTES = 1024 * 1024 * 1024
PDF_CONTENT_TYPE = "application/pdf"
RENDER_SCRIPT = Path(__file__).with_name("pdf_render.py")
_IMAGE_MAGIC = (b"\xff\xd8", b"\x89PNG\r\n\x1a\n", b"RIFF")
_CODES = {"pdf_encrypted", "pdf_too_many_pages", "invalid_pdf", "image_too_large"}


def _limit_child():
    """preexec_fn of the renderer: memory and CPU limits where the OS supports them (Linux in the image)."""
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (PDF_RENDER_MEMORY_BYTES, PDF_RENDER_MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (PDF_RENDER_TIMEOUT_SECONDS, PDF_RENDER_TIMEOUT_SECONDS))
    except (ImportError, OSError, ValueError):
        pass  # ponytail: macOS refuses RLIMIT_AS; the timeout still holds there


@dataclass(frozen=True)
class RenderedPdf:
    path: Path
    pages: int


def is_pdf(path):
    """is_pdf(path) -> bool; by the bytes only: ``%PDF-`` within the first KiB, as readers accept it."""
    with Path(path).open("rb") as stream:
        head = stream.read(1024)
    if head.startswith(_IMAGE_MAGIC):
        return False
    return b"%PDF-" in head


def render_pdf(source, directory):
    """render_pdf(source, directory) -> RenderedPdf; writes ``rendered.png`` or ``rendered.jpg`` into directory.

    Raises ImageError with ``pdf_encrypted`` (needs a password to open), ``pdf_too_many_pages``
    (more than PDF_MAX_PAGES), ``invalid_pdf`` (broken, empty, crashed or over the timeout) or
    ``image_too_large`` (the image would not fit the byte limit even as a JPEG).
    """
    directory = Path(directory)
    png, jpg = directory / "rendered.png", directory / "rendered.jpg"
    command = [
        sys.executable, "-I", str(RENDER_SCRIPT), str(source), str(png), str(jpg),
        str(settings.RECEIPT_IMAGE_MAX_PIXELS), str(settings.RECEIPT_IMAGE_MAX_BYTES),
        str(PDF_MAX_PAGES), str(PDF_RENDER_DPI),
    ]
    try:
        completed = subprocess.run(command, capture_output=True, timeout=PDF_RENDER_TIMEOUT_SECONDS, check=False, stdin=subprocess.DEVNULL,
            preexec_fn=_limit_child)
    except subprocess.TimeoutExpired:
        raise ImageError("invalid_pdf") from None
    try:
        answer = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ImageError("invalid_pdf") from None
    if not isinstance(answer, dict) or completed.returncode != 0:
        raise ImageError("invalid_pdf")
    if "error" in answer:
        raise ImageError(answer["error"] if answer["error"] in _CODES else "invalid_pdf")
    pages, written = answer.get("pages"), answer.get("file")
    if type(pages) is not int or not 1 <= pages <= PDF_MAX_PAGES or written not in (str(png), str(jpg)):
        raise ImageError("invalid_pdf")
    return RenderedPdf(Path(written), pages)
