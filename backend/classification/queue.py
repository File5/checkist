"""PostgreSQL queue of classification runs for the host worker.

A run is ``running`` only while the worker executes one batch of it; after the
batch it goes back to ``queued`` (products left) or gets a final status. So a
recognition job never waits longer than one model request.

Every transition of a claimed run is fenced by its ``run_token``: a run that
somebody else closed meanwhile (``suggest`` and ``cancel-pending`` close a run
whose lease expired) raises ``RunLost`` and is left as it is.

There is no heartbeat thread. The lease is ``PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS``
plus a margin and is renewed by ``heartbeat`` at the start of every model call.
"""
import uuid

from django.conf import settings
from django.db import DatabaseError, IntegrityError, transaction

from classification import services
from classification.models import ClassificationAttempt, ClassificationRun
from recognition.queue import db_now

Status = ClassificationRun.Status
MAX_RECOVERIES = 2
# A concurrent import may queue its own run while this one is being requeued.
REQUEUE_ATTEMPTS = 5


class RunLost(Exception):
    """The run is no longer owned by this claim; nothing was written."""


def _owned(run):
    """Lock the run of this claim, or ``RunLost``."""
    row = ClassificationRun.objects.select_for_update().filter(
        pk=run.pk, status=Status.RUNNING, run_token=run.run_token,
    ).first()
    if row is None or run.run_token is None:
        raise RunLost()
    return row


def _fail_attempts(run, error_code, now):
    """An attempt left ``running`` belongs to a call that will never report."""
    run.attempts.filter(status=ClassificationAttempt.Status.RUNNING).update(
        status=ClassificationAttempt.Status.FAILED, error_code=error_code, finished_at=now,
    )


def _finish(run, status, error_code, now):
    run.status, run.error_code, run.finished_at = status, error_code, now
    run.run_token = run.heartbeat_at = run.lease_expires_at = None
    run.version += 1
    run.save()


def _absorb(run, other):
    """Take the products of a run queued during the batch; that run never started and is removed.

    Only one run may wait. Products already in this run are not added twice;
    what does not fit the run limit is counted as remaining.
    """
    limit = settings.PRODUCT_CLASSIFICATION_RUN_LIMIT
    known = set(run.product_ids)
    merged = run.product_ids + [pk for pk in other.product_ids[other.cursor:] if pk not in known]
    if other.scope == ClassificationRun.Scope.ALL:
        run.scope = ClassificationRun.Scope.ALL
    run.product_ids = merged[:max(limit, run.cursor)]
    run.requested_count = len(run.product_ids)
    run.remaining_count = (
        (run.remaining_count or 0) + (other.remaining_count or 0) + len(merged) - len(run.product_ids)
    )
    other.delete()


def _requeue(run, now):
    """``running → queued``; ``False`` when another run that already started waits."""
    other = ClassificationRun.objects.select_for_update().filter(status=Status.QUEUED).first()
    if other is not None:
        if other.started_at is not None or other.attempts.exists() or other.records.exists():
            return False
        _absorb(run, other)
    run.status = Status.QUEUED
    run.run_token = run.heartbeat_at = run.lease_expires_at = None
    run.version += 1
    run.save()
    return True


def _retrying(operation):
    """Repeat a requeue that lost a race for the single ``queued`` place or a row lock."""
    for attempt in range(REQUEUE_ATTEMPTS):
        try:
            with transaction.atomic():
                return operation()
        except IntegrityError:
            if attempt == REQUEUE_ATTEMPTS - 1:
                raise
        except DatabaseError as error:
            if (getattr(error.__cause__, "sqlstate", None) not in services.BUSY_SQLSTATES
                    or attempt == REQUEUE_ATTEMPTS - 1):
                raise


def claim_run():
    """claim_run() -> ClassificationRun | None: the queued run becomes ``running`` for one batch.

    Nothing is claimed while another run executes: recovery fences an expired
    one first, the ``suggest`` command finishes its own.
    """
    with transaction.atomic():
        run = ClassificationRun.objects.select_for_update(skip_locked=True).filter(
            status=Status.QUEUED).order_by("pk").first()
        if run is None or ClassificationRun.objects.filter(status=Status.RUNNING).exists():
            return None
        now = db_now()
        run.status = Status.RUNNING
        run.run_token = uuid.uuid4()
        run.started_at = run.started_at or now
        run.heartbeat_at, run.lease_expires_at = now, services.lease_until(now)
        run.version += 1
        run.save()
        return run


def heartbeat(run):
    """Renew the lease of a claimed run before a model call; ``RunLost`` when it is not ours."""
    with transaction.atomic():
        row = _owned(run)
        now = db_now()
        row.heartbeat_at, row.lease_expires_at = now, services.lease_until(now)
        row.save(update_fields=["heartbeat_at", "lease_expires_at"])
        return row


def finish_batch(run, result):
    """finish_batch(run, result: BatchResult) -> run after one batch.

    A failed model call — ``failed`` with its code; batches applied before stay
    applied. Otherwise the cursor moves by ``result.consumed``: nothing left —
    ``succeeded``, else back to ``queued``.
    """
    def operation():
        row = _owned(run)
        now = db_now()
        _fail_attempts(row, "internal_error", now)
        if result.error_code:
            _finish(row, Status.FAILED, result.error_code, now)
            return row
        row.cursor = min(len(row.product_ids), row.cursor + result.consumed)
        if row.cursor >= len(row.product_ids):
            _finish(row, Status.SUCCEEDED, "", now)
        elif not result.consumed or not _requeue(row, now):
            # A batch that consumed nothing would repeat forever.
            _finish(row, Status.FAILED, "internal_error", now)
        return row

    return _retrying(operation)


def fail_run(run, error_code):
    """fail_run(run, error_code) -> run: ``failed``; applied batches stay applied."""
    with transaction.atomic():
        row = _owned(run)
        now = db_now()
        _fail_attempts(row, error_code, now)
        _finish(row, Status.FAILED, error_code, now)
        return row


def release_run(run):
    """release_run(run) -> run: the worker stops during a batch; ``queued``, ``recoveries`` unchanged."""
    def operation():
        row = _owned(run)
        now = db_now()
        _fail_attempts(row, "worker_lost", now)
        if not _requeue(row, now):
            _finish(row, Status.FAILED, "worker_lost", now)
        return row

    return _retrying(operation)


def recover_expired_runs():
    """recover_expired_runs() -> list[run]: fence runs whose lease expired; the model is not called.

    Back to ``queued`` twice (``recoveries``), then ``failed`` / ``worker_lost``.
    The batch of the lost claim is executed again; products it already applied
    are no longer candidates and are skipped.
    """
    def operation():
        recovered = []
        now = db_now()
        for row in ClassificationRun.objects.select_for_update(skip_locked=True).filter(
                status=Status.RUNNING, lease_expires_at__lte=now).order_by("pk"):
            _fail_attempts(row, "worker_lost", now)
            if row.recoveries < MAX_RECOVERIES and _requeue(row, now):
                row.recoveries += 1
                row.save(update_fields=["recoveries"])
            else:
                _finish(row, Status.FAILED, "worker_lost", now)
            recovered.append(row)
        return recovered

    return _retrying(operation)
