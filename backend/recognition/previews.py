"""Compressed display copies of stored photos and crops: made lazily, kept next to the source.

``originals/<uuid>/source.<ext>`` and ``crops/<uuid>/<job>/<position>-<uuid>/crop.png`` get, in the
same directory, ``preview-1600-v1.webp`` (longest side 1600 px) and ``thumb-400-v1.webp`` (400 px).
The source files never change and every directory is new, so a variant name never points at other
pixels: changing the size or quality means a new ``-vN`` name, never a rewrite.

A variant is written on its first request (``accounts.media.serve``) or by
``manage.py media_previews backfill``; atomically: rendered in the staging directory outside
MEDIA and renamed into place. Two concurrent requests write the same bytes; the last rename wins.
Display only: the prepare/detect/crop/recognize pipeline reads the source files, never these.
"""
import os
import posixpath
from pathlib import Path

from django.conf import settings

from .images import ImageError, write_preview
from .storage import StorageError, _staging

VARIANTS = {"display": ("preview-1600-v1.webp", 1600), "thumb": ("thumb-400-v1.webp", 400)}
VARIANT_SIZES = {name: size for name, size in VARIANTS.values()}
# Directories of MEDIA that have variants and the source file of each, in the order looked up.
VARIANT_DIRECTORIES = frozenset({"originals", "crops"})
SOURCE_NAMES = ("crop.png", "source.jpg", "source.png", "source.webp")


def variant_name(file_name, kind):
    """variant_name("originals/<uuid>/source.jpg", "display") -> "originals/<uuid>/preview-1600-v1.webp"."""
    return posixpath.join(posixpath.dirname(file_name), VARIANTS[kind][0])


def variant_url(file_name, kind):
    return settings.MEDIA_URL + variant_name(file_name, kind) if file_name else None


def is_variant(segments):
    """is_variant(path segments) -> bool; the path names a variant of an owned directory."""
    return len(segments) >= 3 and segments[0] in VARIANT_DIRECTORIES and segments[-1] in VARIANT_SIZES


def ensure_variant(target):
    """ensure_variant(target: Path) -> bool; True when ``target`` exists or has just been written.

    False — no source beside it or the source cannot be read: nothing is written.
    """
    target = Path(target)
    if target.is_file():
        return True
    size = VARIANT_SIZES.get(target.name)
    if size is None:
        return False
    source = next((target.parent / name for name in SOURCE_NAMES if (target.parent / name).is_file()), None)
    if source is None:
        return False
    try:
        with _staging() as directory:
            staged = Path(directory) / target.name
            write_preview(source, staged, size)
            os.replace(staged, target)
        return True
    except ImageError:
        return False
    except OSError:
        raise StorageError() from None
