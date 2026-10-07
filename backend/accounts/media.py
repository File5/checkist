"""Files under ``MEDIA_ROOT``: a photo and everything made from it go only to its owner.

The route has no ``DEBUG`` condition, the rule depends on ``mode()``:

- ``accounts`` — the path is ``originals|prepared|crops/{storage_uuid}/…`` and the photo with
  this ``storage_uuid`` belongs to the user of the session; ``DEBUG`` is not consulted;
- ``local_single`` — any file under ``MEDIA_ROOT`` while ``DEBUG`` is on, as ``static()`` did.

Every refusal is the same empty ``404``: a foreign file, an anonymous request, a missing
file, ``demo/``, a path that tries to leave its directory. Nothing in the answer tells them
apart, so a path cannot be probed for existence.
"""
import uuid
from pathlib import Path

from django.conf import settings
from django.core.exceptions import SuspiciousFileOperation
from django.http import FileResponse, HttpResponseNotFound
from django.utils._os import safe_join
from django.views.decorators.http import require_http_methods

from accounts.access import LOCAL_SINGLE, mode, owner_q
from recognition.models import SourcePhoto

OWNED_DIRECTORIES = frozenset({"originals", "prepared", "crops"})
CACHE_CONTROL = "private, no-store"
# A segment with any of these is never a name written by ``recognition.storage``: the
# backslash and the colon are a separator, a drive and a data stream on Windows.
_FORBIDDEN = frozenset('\\:\x00')


def _not_found():
    response = HttpResponseNotFound(content_type="text/plain")
    response["Cache-Control"] = CACHE_CONTROL
    return response


def _segments(path):
    """_segments(path) -> list[str] | None; None unless every segment is a plain name.

    ``safe_join`` only keeps the path under ``MEDIA_ROOT``; ``..`` inside it would lead from
    one's own photo directory to a foreign one, so it is refused before the owner check.
    """
    segments = path.split("/")
    for segment in segments:
        if segment in ("", ".", "..") or not _FORBIDDEN.isdisjoint(segment):
            return None
    return segments


def _signed_in(request):
    user = getattr(request, "user", None)
    return bool(user is not None and user.is_authenticated and user.is_active)


def _allowed(request, segments):
    if mode() == LOCAL_SINGLE:
        return bool(settings.DEBUG and segments)
    # The session is read first and on every path, so all refusals carry the same headers.
    if not _signed_in(request) or not segments:
        return False
    if len(segments) < 3 or segments[0] not in OWNED_DIRECTORIES:
        return False
    try:
        storage_uuid = uuid.UUID(segments[1])
    except ValueError:
        return False
    # Only the spelling used on disk: ``UUID()`` also reads braces, ``urn:`` and no hyphens.
    if str(storage_uuid) != segments[1]:
        return False
    return SourcePhoto.objects.filter(owner_q(request), storage_uuid=storage_uuid).exists()


@require_http_methods(["GET", "HEAD"])
def serve(request, path):
    """serve(request, path) -> FileResponse | empty 404; ``path`` is relative to ``MEDIA_ROOT``."""
    segments = _segments(path)
    if not _allowed(request, segments):
        return _not_found()
    try:
        full_path = Path(safe_join(settings.MEDIA_ROOT, *segments))
        if not full_path.is_file():
            return _not_found()
        opened = full_path.open("rb")
    except (SuspiciousFileOperation, OSError, ValueError):
        return _not_found()
    response = FileResponse(opened)
    response["Cache-Control"] = CACHE_CONTROL
    return response
