"""Child process of ``statements.extract.pdf_text``: PDF bytes on stdin, its text as one JSON line on stdout.

Runs as ``python -I pdf_text.py <max_pages> <max_chars> <max_bytes>``. It imports only pypdfium2 (no Django):
PDFium is not thread-safe and cannot be interrupted, so the parent runs it in a process of its own and kills it
on a timeout. Nothing is written to disk: the statement PDF is never stored.

Output: ``{"pages": n, "text": "..."}`` or ``{"error": "<code>"}`` with codes ``pdf_encrypted``,
``pdf_too_many_pages``, ``statement_too_large``, ``upload_too_large``, ``invalid_pdf``.
"""
import json
import sys


def extract(data, max_pages, max_chars):
    import pypdfium2 as pdfium

    try:
        document = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as exc:
        # FPDF_ERR_PASSWORD: a user password is required to open it.
        return {"error": "pdf_encrypted" if exc.err_code == 4 else "invalid_pdf"}
    try:
        count = len(document)
        if count < 1:
            return {"error": "invalid_pdf"}
        if count > max_pages:
            return {"error": "pdf_too_many_pages"}
        parts, size = [], 0
        for index in range(count):
            page = document[index]
            try:
                textpage = page.get_textpage()
                try:
                    text = textpage.get_text_range()
                finally:
                    textpage.close()
            finally:
                page.close()
            size += len(text)
            if size > max_chars:
                return {"error": "statement_too_large"}
            parts.append(text)
        return {"pages": count, "text": "\n".join(parts)}
    except pdfium.PdfiumError:
        return {"error": "invalid_pdf"}
    finally:
        document.close()


def main(argv):
    max_pages, max_chars, max_bytes = (int(value) for value in argv)
    data = sys.stdin.buffer.read(max_bytes + 1)
    if len(data) > max_bytes:
        result = {"error": "upload_too_large"}
    else:
        try:
            result = extract(data, max_pages, max_chars)
        except (OSError, ValueError, MemoryError):
            result = {"error": "invalid_pdf"}
    sys.stdout.write(json.dumps(result))  # ASCII only: no dependence on the locale of the child
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
