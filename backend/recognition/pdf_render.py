"""Child process of ``recognition.pdf.render_pdf``: one PDF in, one image out, a JSON line on stdout.

Runs as ``python -I pdf_render.py <source.pdf> <png> <jpg> <max_pixels> <max_bytes> <max_pages> <dpi>``.
It imports only pypdfium2 and Pillow (no Django): PDFium is not thread-safe and cannot be
interrupted, so the parent runs it in a process of its own and kills it on a timeout.

Every page (at most ``max_pages``) is rendered at ``dpi`` and pasted under the previous one into a
single white RGB image, left-aligned, without gaps: a bill of several pages reads as one long
receipt. The scale is lowered until the whole image fits ``max_pixels``. The image is a PNG (text
stays sharp); a PNG over ``max_bytes`` (a scanned photo inside the PDF) is written as a JPEG instead.

Output: ``{"pages": n, "file": "<png|jpg path>"}`` or ``{"error": "<code>"}`` with codes
``pdf_encrypted``, ``pdf_too_many_pages``, ``invalid_pdf``, ``image_too_large``.
"""
import json
import math
import sys
from os import path

JPEG_QUALITY = 90


def _answer(value):
    sys.stdout.write(json.dumps(value))
    sys.stdout.flush()


def render(source, png, jpg, max_pixels, max_bytes, max_pages, dpi):
    import pypdfium2 as pdfium
    from PIL import Image

    try:
        document = pdfium.PdfDocument(source)
    except pdfium.PdfiumError as exc:
        # FPDF_ERR_PASSWORD: a user password is required. An owner-only password (printing or
        # copying restrictions) opens without one and is rendered like any other PDF.
        return {"error": "pdf_encrypted" if exc.err_code == 4 else "invalid_pdf"}
    try:
        count = len(document)
        if count < 1:
            return {"error": "invalid_pdf"}
        if count > max_pages:
            return {"error": "pdf_too_many_pages"}
        pages = [document[index] for index in range(count)]
        sizes = [page.get_size() for page in pages]
        if any(not (math.isfinite(w) and math.isfinite(h)) or w <= 0 or h <= 0 for w, h in sizes):
            return {"error": "invalid_pdf"}
        # The longer side for both dimensions: whatever /Rotate does, the image is not larger.
        sides = [max(w, h) for w, h in sizes]
        scale = dpi / 72
        budget = max(sides) * sum(sides)
        if budget * scale * scale > max_pixels:
            scale = math.sqrt(max_pixels / budget) * 0.999
        rendered = []
        try:
            for page in pages:
                bitmap = page.render(scale=scale, fill_color=(255, 255, 255, 255))
                image = bitmap.to_pil().convert("RGB")
                rendered.append(image)
            width = max(image.width for image in rendered)
            height = sum(image.height for image in rendered)
            if width < 1 or height < 1:
                return {"error": "invalid_pdf"}
            if width * height > max_pixels:
                return {"error": "image_too_large"}
            canvas = Image.new("RGB", (width, height), "white")
            top = 0
            for image in rendered:
                canvas.paste(image, (0, top))
                top += image.height
        finally:
            for image in rendered:
                image.close()
        with canvas:
            canvas.save(png, format="PNG", compress_level=6)
            if path.getsize(png) <= max_bytes:
                return {"pages": count, "file": png}
            canvas.save(jpg, format="JPEG", quality=JPEG_QUALITY)
            if path.getsize(jpg) <= max_bytes:
                return {"pages": count, "file": jpg}
            return {"error": "image_too_large"}
    except pdfium.PdfiumError:
        return {"error": "invalid_pdf"}
    finally:
        document.close()


def main(argv):
    source, png, jpg, max_pixels, max_bytes, max_pages, dpi = argv
    try:
        result = render(source, png, jpg, int(max_pixels), int(max_bytes), int(max_pages), int(dpi))
    except (OSError, ValueError, MemoryError):
        result = {"error": "invalid_pdf"}
    _answer(result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
