"""Synthetic PDFs written byte by byte: no PDF writer is needed and the content is exact.

Each page draws a black square in its lower left corner, so a render shows where a page landed.
"""
import math

SQUARE = b"0 0 0 rg 0 0 50 50 re f"


def pdf_bytes(pages=1, size=(200, 300), encrypted=False, photo=False):
    """pdf_bytes(pages, size in points, encrypted) -> bytes of a valid PDF 1.4.

    ``encrypted`` adds a standard security handler whose user password is not empty: PDFium
    refuses to open the file without the password. ``photo`` covers each page with a
    picture of fine detail (like a scan): its render is far larger as a PNG than as a JPEG.
    """
    width, height = size
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", None]
    kids = []
    for _ in range(pages):
        page_number = len(objects) + 1
        kids.append(b"%d 0 R" % page_number)
        resources = b" /Resources << /XObject << /Im1 %d 0 R >> >>" % (page_number + 2) if photo else b""
        objects.append(b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Contents %d 0 R%s >>"
                       % (width, height, page_number + 1, resources))
        content = (b"q %d 0 0 %d 0 0 cm /Im1 Do Q\n" % (width, height) if photo else b"") + SQUARE
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content))
        if photo:
            objects.append(_picture(width, height))
    objects[1] = b"<< /Type /Pages /Kids [" + b" ".join(kids) + b"] /Count %d >>" % pages
    extra = b""
    if encrypted:
        objects.append(b"<< /Filter /Standard /V 1 /R 2 /O <" + b"11" * 32 + b"> /U <" + b"22" * 32 + b"> /P -4 >>")
        identifier = b"<00112233445566778899aabbccddeeff>"
        extra = b"/Encrypt %d 0 R /ID [%s %s] " % (len(objects), identifier, identifier)
    out = b"%PDF-1.4\n"
    offsets = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n%s\nendobj\n" % (number, body)
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    out += b"".join(b"%010d 00000 n \n" % offset for offset in offsets)
    out += b"trailer\n<< /Size %d /Root 1 0 R %s>>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, extra, xref)
    return out


def _picture(width, height):
    """A grey picture at one pixel per point: smooth waves, as a photo has, never repeated exactly."""
    pixels = bytes(int(127 + 60 * math.sin(x / 3.1) + 60 * math.cos(y / 2.3 + x / 7.7)) for y in range(height) for x in range(width))
    return (b"<< /Type /XObject /Subtype /Image /Width %d /Height %d /ColorSpace /DeviceGray /BitsPerComponent 8 /Length %d >>\nstream\n"
            % (width, height, len(pixels)) + pixels + b"\nendstream")
