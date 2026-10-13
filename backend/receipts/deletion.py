"""Deleting a receipt of any source, optionally with its source photo.

A receipt goes with its lines, discounts and taxes (``CASCADE``). The crops it was imported from
(``ReceiptImage``) stay and lose the link (``SET_NULL``): the job page still shows the crop and says that the
receipt was deleted (``outcome_snapshot``). With ``with_photo`` the source photo goes too, with all its jobs,
crops and attempts and its MEDIA folders ``originals/``, ``prepared/``, ``crops/`` named by ``storage_uuid``.

Stores, products, aliases and categories created for the receipt stay: the catalog is shared. Database rows go
in one transaction; files are removed only after the commit, and a file error is logged, never raised: the rows
are already gone, and a leftover folder is an orphan, not a broken receipt.
"""
import logging
import shutil
from pathlib import Path

from django.conf import settings
from django.db import transaction

from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from recognition.statuses import ACTIVE_JOB_STATUSES

from .models import Receipt

logger = logging.getLogger(__name__)

MEDIA_FOLDERS = ("originals", "prepared", "crops")


class DeleteRefused(Exception):
    """``job_active`` — a job of the receipt's photo is queued or running; ``photo_shared`` — another receipt
    still comes from the photo that was asked to go."""

    def __init__(self, code):
        self.code = code
        super().__init__(code)


def delete_receipt(receipt_id, *, with_photo=False):
    """delete_receipt(receipt_id: int, *, with_photo: bool = False) -> list[uuid.UUID].

    Returns the ``storage_uuid`` of the deleted photos (empty without ``with_photo``). Raises
    ``Receipt.DoesNotExist`` when the receipt is already gone and ``DeleteRefused`` when it must stay.
    A receipt without photos (a manual spend) is deleted the same way; ``with_photo`` changes nothing for it.
    """
    with transaction.atomic():
        photo_ids = sorted(set(
            ReceiptImage.objects.filter(receipt_id=receipt_id).values_list("photo_id", flat=True)))
        # Photos first, in one order: the same lock a new job or a retry takes (``recognition.queue``).
        list(SourcePhoto.objects.select_for_update().filter(pk__in=photo_ids).order_by("pk").values_list("pk", flat=True))
        receipt = Receipt.objects.select_for_update().get(pk=receipt_id)
        # A job may still import into this receipt or link a crop to it.
        if ProcessingJob.objects.filter(photo_id__in=photo_ids, status__in=ACTIVE_JOB_STATUSES).exists():
            raise DeleteRefused("job_active")
        if with_photo and ReceiptImage.objects.filter(photo_id__in=photo_ids, receipt__isnull=False).exclude(
                receipt_id=receipt.pk).exists():
            raise DeleteRefused("photo_shared")
        receipt.delete()
        if not with_photo or not photo_ids:
            return []
        uuids = list(SourcePhoto.objects.filter(pk__in=photo_ids).values_list("storage_uuid", flat=True))
        # Jobs take their crops and attempts (CASCADE); the photo is PROTECTed by its jobs and crops, so it goes last.
        ReceiptImage.objects.filter(photo_id__in=photo_ids).delete()
        ProcessingJob.objects.filter(photo_id__in=photo_ids).delete()
        SourcePhoto.objects.filter(pk__in=photo_ids).delete()
        transaction.on_commit(lambda: remove_photo_files(uuids))
        return uuids


def remove_photo_files(storage_uuids):
    """Removes ``originals/``, ``prepared/`` and ``crops/`` folders of the photos; errors are logged only."""
    root = Path(settings.MEDIA_ROOT).resolve()
    for storage_uuid in storage_uuids:
        for folder in MEDIA_FOLDERS:
            path = (root / folder / str(storage_uuid)).resolve()
            if not path.is_relative_to(root / folder) or path == root / folder:
                logger.error("photo folder outside MEDIA_ROOT is not removed: %s", path)
                continue
            try:
                if path.is_dir() and not path.is_symlink():
                    shutil.rmtree(path)
                elif path.exists() or path.is_symlink():
                    path.unlink()
            except OSError:
                logger.exception("photo folder was not removed: %s", path)
