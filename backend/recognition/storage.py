"""Local immutable MEDIA files. Random destinations; no client-controlled paths.

Functions own their file cleanup. A process crash between rename and DB commit
can leave an orphan; originals are never deleted by cancellation or retry.
"""
import hashlib
import os
import tempfile
import uuid
from pathlib import Path

from django.conf import settings
from django.db import transaction

from receipts.ownership import local_user

from .images import ImageError, crop_receipt, inspect_image, prepare_upright
from .models import ReceiptImage, SourcePhoto
from .queue import QueueError, fenced_job


class StorageError(ValueError):
    def __init__(self, code="storage_unavailable"):
        self.code = code
        super().__init__(code)


def media_path(name):
    """media_path(relative_name: str) -> Path; reject traversal/symlink escapes and missing files."""
    root = Path(settings.MEDIA_ROOT).resolve()
    if not isinstance(name, str) or not name or "\\" in name or Path(name).is_absolute() or ".." in Path(name).parts:
        raise StorageError()
    path = (root / name).resolve()
    if not path.is_relative_to(root) or not path.is_file():
        raise StorageError()
    return path


def _digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(64 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def _publish(staged, relative_name):
    root = Path(settings.MEDIA_ROOT).resolve()
    target = (root / relative_name).resolve()
    if not target.is_relative_to(root):
        raise StorageError()
    # Every caller uses a new UUID directory. Never replace a shared destination.
    target.parent.mkdir(parents=True, exist_ok=False)
    os.replace(staged, target)
    return target


def _staging():
    root = Path(settings.MEDIA_ROOT).resolve()
    root.mkdir(parents=True, exist_ok=True)
    # Outside served MEDIA, on the same volume for atomic rename.
    return tempfile.TemporaryDirectory(prefix=f".{root.name}-recognition-staging-", dir=root.parent)


def _remove_owned(path):
    if path is not None:
        path.unlink(missing_ok=True)
        path.parent.rmdir()


def _chunks(upload):
    if hasattr(upload, "chunks"):
        yield from upload.chunks(chunk_size=64 * 1024)
    elif hasattr(upload, "read"):
        yield from iter(lambda: upload.read(64 * 1024), b"")
    else:
        raise ImageError("invalid_image")


def accept_upload(upload):
    """accept_upload(file: UploadedFile|BinaryIO) -> (SourcePhoto, created).

    Streams actual bytes, ignores declared size/name/MIME, validates fully, then
    commits the source row. Call outside another transaction (durable commit).
    Duplicate uploads reuse the existing row/files, including concurrent uploads.
    Preview preparation happens separately in the fenced worker.
    """
    published = None
    try:
        with _staging() as directory:
            staged = Path(directory) / "source"
            digest = hashlib.sha256()
            size = 0
            with staged.open("xb") as stream:
                for chunk in _chunks(upload):
                    if not isinstance(chunk, bytes):
                        raise ImageError("invalid_image")
                    size += len(chunk)
                    if size > settings.RECEIPT_IMAGE_MAX_BYTES:
                        raise ImageError("file_too_large")
                    stream.write(chunk)
                    digest.update(chunk)
            info = inspect_image(staged)
            sha256 = digest.hexdigest()
            existing = SourcePhoto.objects.filter(sha256=sha256).first()
            if existing:
                media_path(existing.original_file.name)
                return existing, False
            storage_uuid = uuid.uuid4()
            name = f"originals/{storage_uuid}/source.{info.extension}"
            published = _publish(staged, name)
            with transaction.atomic(durable=True):
                photo, created = SourcePhoto.objects.get_or_create(sha256=sha256, defaults={
                    "storage_uuid": storage_uuid, "original_file": name, "content_type": info.content_type,
                    "bytes": info.bytes, "raw_width": info.raw_width, "raw_height": info.raw_height,
                    "width": info.width, "height": info.height, "exif_orientation": info.exif_orientation,
                    "owner": local_user(),  # temporary shim until accept_upload takes the owner
                })
                if not created:
                    media_path(photo.original_file.name)
            if not created:
                _remove_owned(published)
            published = None  # referenced and committed, or already removed.
            return photo, created
    except OSError:
        raise StorageError() from None
    finally:
        _remove_owned(published)


def prepare_photo(job_id, run_token, version):
    """prepare_photo(job_id, run_token, version) -> (SourcePhoto, updated_job).

    CPU/file work outside the lock, publish/link under fence. Returns a new version
    only when a preview is first persisted. A recovery reuses the existing preview.
    """
    from .models import ProcessingJob
    photo = ProcessingJob.objects.select_related("photo").get(pk=job_id).photo
    if photo.upright_file:
        with fenced_job(job_id, run_token, version) as job:
            media_path(photo.upright_file.name)
            return photo, job
    published = None
    try:
        with _staging() as directory:
            staged = Path(directory) / "upright.png"
            info = prepare_upright(media_path(photo.original_file.name), staged)
            name = f"prepared/{photo.storage_uuid}/{uuid.uuid4()}/upright-v1.png"
            with transaction.atomic(durable=True):
                with fenced_job(job_id, run_token, version) as job:
                    photo = SourcePhoto.objects.select_for_update().get(pk=job.photo_id)
                    if photo.upright_file:
                        media_path(photo.upright_file.name)
                        return photo, job
                    published = _publish(staged, name)
                    photo.upright_file = name
                    photo.width, photo.height = info.width, info.height
                    photo.preparation_version = 1
                    photo.save(update_fields=["upright_file", "width", "height", "preparation_version"])
                    job.version += 1
                    job.save(update_fields=["version"])
            published = None
            return photo, job
    except OSError:
        raise StorageError() from None
    finally:
        _remove_owned(published)


def save_crop(job_id, run_token, version, position, bbox, *, quad=None, rotation_degrees=0, clipped=False):
    """save_crop(...) -> (ReceiptImage, updated_job); geometry normalized on upright.

    Requires detected_count before the call. Existing position is reused only for
    exactly the same geometry (worker recovery); explicit retry has a new job.
    """
    from .models import ProcessingJob
    if type(position) is not int or not 1 <= position <= 10 or type(clipped) is not bool:
        raise QueueError("invalid_position")
    job = ProcessingJob.objects.select_related("photo").get(pk=job_id)
    photo = job.photo
    if not photo.upright_file:
        raise StorageError()
    published = None
    try:
        with _staging() as directory:
            staged = Path(directory) / "crop.png"
            info = crop_receipt(media_path(photo.upright_file.name), staged, bbox, quad=quad, rotation_degrees=rotation_degrees)
            sha256 = _digest(staged)
            # Keep a fresh directory so atomic publication cannot overwrite stale/other work.
            name = f"crops/{photo.storage_uuid}/{job_id}/{position}-{uuid.uuid4()}/crop.png"
            with transaction.atomic(durable=True):
                with fenced_job(job_id, run_token, version) as job:
                    if job.detected_count is None or position > job.detected_count:
                        raise QueueError("invalid_position")
                    existing = job.images.filter(position=position).first()
                    if existing:
                        if (existing.bbox != info.bbox or existing.quad != info.quad or existing.rotation_degrees != info.rotation_degrees or existing.clipped != clipped):
                            raise QueueError("crop_conflict")
                        media_path(existing.file.name)
                        return existing, job
                    published = _publish(staged, name)
                    image = ReceiptImage.objects.create(
                        photo=photo, job=job, position=position, file=name, sha256=sha256,
                        width=info.width, height=info.height, bbox=info.bbox, quad=info.quad,
                        rotation_degrees=info.rotation_degrees, crop_transform=info.crop_transform, clipped=clipped,
                    )
                    job.version += 1
                    job.save(update_fields=["version"])
            published = None
            return image, job
    except OSError:
        raise StorageError() from None
    finally:
        _remove_owned(published)
