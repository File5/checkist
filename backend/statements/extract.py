"""PDF выписки → текст в отдельном процессе (``pdf_text.py``) со сроком, памятью и CPU, как у ``recognition.pdf``.

PDF не пишется на диск: байты идут ребёнку через stdin, наружу — только текст. Отказы —
``StatementError`` с кодом ``unsupported_format`` (не PDF), ``invalid_pdf``, ``pdf_encrypted``,
``pdf_too_many_pages``, ``statement_too_large``, ``upload_too_large``.
"""
import json
import subprocess
import sys
from pathlib import Path

MAX_PAGES = 200
MAX_CHARS = 4_000_000
MAX_BYTES = 20 * 1024 * 1024
TIMEOUT_SECONDS = 60
MEMORY_BYTES = 1024 * 1024 * 1024
SCRIPT = Path(__file__).with_name("pdf_text.py")
_CODES = {"pdf_encrypted", "pdf_too_many_pages", "statement_too_large", "upload_too_large", "invalid_pdf"}


class StatementError(Exception):
    """Выписку нельзя принять: ``code`` — публичный код отказа API."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def _limit_child():
    """preexec_fn: потолок памяти и CPU там, где ОС их даёт (Linux в образе)."""
    try:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (MEMORY_BYTES, MEMORY_BYTES))
        resource.setrlimit(resource.RLIMIT_CPU, (TIMEOUT_SECONDS, TIMEOUT_SECONDS))
    except (ImportError, OSError, ValueError):
        pass  # macOS не даёт RLIMIT_AS; срок по-прежнему действует


def is_pdf(data):
    """По байтам: ``%PDF-`` в первом килобайте, как его ищут читалки."""
    return b"%PDF-" in data[:1024]


def pdf_text(data):
    """Текст всех страниц PDF ``data`` (bytes) либо ``StatementError``."""
    if len(data) > MAX_BYTES:
        raise StatementError("upload_too_large")
    if not is_pdf(data):
        raise StatementError("unsupported_format")
    command = [sys.executable, "-I", str(SCRIPT), str(MAX_PAGES), str(MAX_CHARS), str(MAX_BYTES)]
    try:
        completed = subprocess.run(command, input=data, capture_output=True, timeout=TIMEOUT_SECONDS, check=False,
                                   preexec_fn=_limit_child)
    except subprocess.TimeoutExpired:
        raise StatementError("invalid_pdf") from None
    try:
        answer = json.loads(completed.stdout.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise StatementError("invalid_pdf") from None
    if not isinstance(answer, dict) or completed.returncode != 0:
        raise StatementError("invalid_pdf")
    if "error" in answer:
        raise StatementError(answer["error"] if answer["error"] in _CODES else "invalid_pdf")
    text = answer.get("text")
    if not isinstance(text, str):
        raise StatementError("invalid_pdf")
    return text
