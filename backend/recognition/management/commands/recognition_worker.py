"""Host worker; PostgreSQL owns both the queue and the singleton lock.

Two kinds of work: a recognition job always comes first; when none waits, one
batch of a product classification run is executed (classification/QUEUE.md).
"""
import logging
import os
import re
import shutil
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from threading import Event, Thread

import psycopg
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import DatabaseError, InterfaceError, OperationalError, connections, transaction

from classification import queue as classification_queue
from classification.classifier import FAKE_SCENARIOS, get_classifier
from classification.worker import process_batch
from recognition import queue
from recognition.models import ProcessingJob
from recognition.pipeline import process_job
from recognition.process_supervisor import ProcessSupervisor
from recognition.providers.base import ProviderError, RunContext
from recognition.providers.codex_cli import child_environment
from recognition.providers.factory import get_provider
from recognition.providers.fake import SCENARIOS
from recognition.statuses import EXECUTING_JOB_STATUSES

logger = logging.getLogger(__name__)


@contextmanager
def worker_slot():
    # This dedicated connection never participates in job transactions or
    # close_old_connections. Losing its session ends this worker's ownership.
    slot = connections["default"].copy(alias="recognition_worker_slot")
    try:
        if slot.vendor != "postgresql":
            raise CommandError("recognition_worker requires PostgreSQL.")
        with slot.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_lock(%s, %s)", queue.WORKER_LOCK)
            if not cursor.fetchone()[0]:
                raise CommandError("Recognition worker is already running: worker slot is occupied.")
        yield slot
    finally:
        # Session close releases the lock, including startup/processing errors.
        slot.close()


def validate_startup(*, fake_scenario=None):
    lease, heartbeat = settings.RECEIPT_OCR_LEASE_SECONDS, settings.RECEIPT_OCR_HEARTBEAT_SECONDS
    if (settings.RECEIPT_OCR_MAX_CONCURRENCY != 1 or settings.RECEIPT_OCR_MAX_ATTEMPTS not in (1, 2)
            or not 10 <= lease <= 300 or not 0 < heartbeat * 2 < lease):
        raise CommandError("Invalid recognition lease, heartbeat or concurrency settings.")
    roots = [Path(settings.MEDIA_ROOT), Path(settings.RECEIPT_OCR_TEMP_ROOT)]
    if any(not root.is_absolute() for root in roots):
        raise CommandError("MEDIA_ROOT and RECEIPT_OCR_TEMP_ROOT must be absolute paths.")
    media, scratch = (root.resolve() for root in roots)
    if media.is_relative_to(scratch) or scratch.is_relative_to(media):
        raise CommandError("MEDIA_ROOT and provider scratch must be separate directories.")
    try:
        # Storage stages atomic renames next to MEDIA, so check that parent too.
        for root in (media, scratch, media.parent):
            root.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryFile(dir=root) as stream:
                stream.write(b"recognition startup probe")
                stream.flush()
    except OSError:
        raise CommandError("Recognition MEDIA/staging/scratch storage is unavailable.") from None
    if fake_scenario and settings.RECEIPT_OCR_PROVIDER != "fake":
        raise CommandError("--fake-scenario requires RECEIPT_OCR_PROVIDER=fake.")
    try:
        provider = get_provider(scenario=fake_scenario or os.environ.get("RECEIPT_OCR_FAKE_SCENARIO"))
    except ProviderError:
        raise CommandError("Recognition provider configuration is invalid.") from None
    if settings.RECEIPT_OCR_PROVIDER == "codex_cli":
        executable = shutil.which(str(provider.config.executable))
        if executable is None or (os.name == "nt" and Path(executable).suffix.lower() != ".exe"):
            raise CommandError("Codex executable is unavailable; configure RECEIPT_OCR_CODEX_EXECUTABLE (native .exe on Windows).")
        probe_codex(provider, executable)
    return provider


def probe_codex(provider, executable):
    """Bounded local capability/auth probes, no image or model invocation."""
    supervisor = ProcessSupervisor(cancel_grace_seconds=provider.config.cancel_grace_seconds)
    outputs = []
    try:
        for arguments in (("--version",), ("exec", "--help"), ("login", "status")):
            with tempfile.TemporaryDirectory(prefix="startup-", dir=provider.config.temp_root) as folder:
                result = supervisor.run(
                    [executable, *arguments], cwd=folder, env=child_environment(provider.config.codex_home), stdin=b"",
                    run=RunContext(deadline=time.monotonic() + 10),
                )
            if result.returncode:
                raise CommandError("Codex authentication is unavailable; operator must check codex login status." if arguments[0] == "login"
                                   else "Codex startup capability check failed.")
            outputs.append(result.stdout.decode("utf-8", errors="replace"))
    except (ProviderError, OSError):
        raise CommandError("Codex startup probe failed or timed out.") from None
    if not all(flag in outputs[1] for flag in (
        "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--output-schema", "--json", "--disable",
    )):
        raise CommandError("Codex CLI lacks required recognition safety/output flags.")
    version = re.search(r"\b\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.]+)?\b", outputs[0])
    if not version:
        raise CommandError("Codex CLI version could not be determined.")
    provider.cli_version = version.group(0)[:64]


def check_slot(slot):
    raw = slot.connection
    if raw is None or raw.closed:
        raise queue.FenceLost()
    try:
        with raw.cursor() as cursor:
            cursor.execute("SELECT 1")
    except (psycopg.Error, OSError):
        raise queue.FenceLost() from None


class LeaseHeartbeat:
    """Own thread-local DB connection, closes it on every exit.

    Read version under the row lock: progress and durable cancellation increment
    it, but neither invalidates this owner's token. A lost DB/fence immediately
    tells the provider to stop. A disconnected singleton session is detected by
    the same thread before renewing work.
    """
    def __init__(self, job, slot):
        self.job_id, self.token, self.slot = job.pk, job.run_token, slot
        self.stop, self.lost = Event(), Event()
        self.renew_started = None
        self.thread = Thread(target=self._run, name="recognition-heartbeat", daemon=True)

    def __enter__(self):
        self.slot.inc_thread_sharing()
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.thread.join(timeout=10)
        self.slot.dec_thread_sharing()
        if self.thread.is_alive():
            self.lost.set()
            raise CommandError("Recognition heartbeat did not stop within its deadline.")

    def has_lost(self):
        # A stalled DB call must stop the provider even before the 30s lease
        # expires. This callback needs no DB connection of its own.
        if self.renew_started is not None and time.monotonic() - self.renew_started >= 5:
            self.lost.set()
        return self.lost.is_set()

    def _run(self):
        try:
            while not self.stop.wait(settings.RECEIPT_OCR_HEARTBEAT_SECONDS):
                self.renew_started = time.monotonic()
                # Do not reconnect the lock connection: a broken session must
                # never masquerade as ownership of its former advisory lock.
                check_slot(self.slot)
                with transaction.atomic():
                    job = ProcessingJob.objects.select_for_update().get(pk=self.job_id)
                    if job.run_token != self.token or job.status not in EXECUTING_JOB_STATUSES:
                        raise queue.FenceLost()
                    queue.heartbeat(job.pk, self.token, job.version)
                self.renew_started = None
        except Exception:
            self.lost.set()  # never expose connection diagnostics/DSN
        finally:
            connections["default"].close()


def build_classifier(*, fake_scenario=None):
    """The classifier of the same provider; a failure never selects the fake."""
    if fake_scenario and settings.RECEIPT_OCR_PROVIDER != "fake":
        raise CommandError("--classification-fake-scenario requires RECEIPT_OCR_PROVIDER=fake.")
    try:
        return get_classifier(scenario=fake_scenario)
    except ProviderError:
        raise CommandError("Product classification provider configuration is invalid.") from None


class SlotWatch:
    """is_stopped of a classification batch: the worker lost its singleton session.

    The batch has no heartbeat thread; the model request polls this instead, at
    most once a second. A lost slot stays lost.
    """
    def __init__(self, slot, interval=1.0):
        self.slot, self.interval = slot, interval
        self.lost, self.checked = False, time.monotonic()

    def __call__(self):
        if not self.lost and time.monotonic() - self.checked >= self.interval:
            self.checked = time.monotonic()
            try:
                check_slot(self.slot)
            except queue.FenceLost:
                self.lost = True
        return self.lost


def classify_batch(run, *, classifier, slot):
    """One batch; an unexpected error fails the run, never the worker.

    An unavailable database and Ctrl+C propagate, as for a recognition job.
    """
    try:
        return process_batch(run, classifier=classifier, is_stopped=SlotWatch(slot))
    except (OperationalError, InterfaceError):
        raise
    except Exception as error:
        logger.error("Product classification batch failed: %s", type(error).__name__)  # never its text
        try:
            return classification_queue.fail_run(run, "internal_error")
        except classification_queue.RunLost:
            run.refresh_from_db()
            return run


def release_active(job):
    current = ProcessingJob.objects.get(pk=job.pk)
    if current.run_token == job.run_token and current.status in EXECUTING_JOB_STATUSES:
        try:
            queue.release_job(current.pk, current.run_token, current.version)
        except queue.FenceLost:
            pass  # expired owner cannot requeue; the next worker recovers it


class Command(BaseCommand):
    help = "Process receipt recognition jobs on the host beside Codex (one worker)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--once", action="store_true",
            help="Recover leases and process at most one unit of work (a job, else one classification batch), then exit.",
        )
        parser.add_argument("--fake-scenario", choices=SCENARIOS, help="Server-only demo scenario; requires the fake provider.")
        parser.add_argument(
            "--classification-fake-scenario", choices=FAKE_SCENARIOS,
            help="Server-only demo scenario of product classification; requires the fake provider.",
        )

    def handle(self, *args, **options):
        active = active_run = None
        try:
            with worker_slot() as slot:
                provider = validate_startup(fake_scenario=options["fake_scenario"])
                classifier = build_classifier(fake_scenario=options.get("classification_fake_scenario"))
                self.stdout.write("Recognition worker ready.")
                try:
                    while True:
                        check_slot(slot)
                        queue.recover_expired_jobs()
                        classification_queue.recover_expired_runs()
                        active = queue.claim_job()
                        if active is not None:
                            with LeaseHeartbeat(active, slot) as heartbeat:
                                result = process_job(active, provider=provider, is_stopped=heartbeat.has_lost)
                            self.stdout.write(f"Job {result.pk}: {result.status}")
                            active = None
                        else:
                            # Lower priority: only when no recognition job waits, and one batch a pass.
                            active_run = classification_queue.claim_run()
                            if active_run is not None:
                                result = classify_batch(active_run, classifier=classifier, slot=slot)
                                self.stdout.write(f"Classification run {result.pk}: {result.status}")
                                active_run = None
                        if options["once"]:
                            return
                        # Signals interrupt this idle wait too; no further claim.
                        Event().wait(1)
                except KeyboardInterrupt:
                    if active is not None:
                        release_active(active)
                    if active_run is not None:
                        try:
                            classification_queue.release_run(active_run)
                        except classification_queue.RunLost:
                            pass  # closed by somebody else; nothing to give back
                    self.stdout.write("Recognition worker stopped; active work released.")
        except queue.FenceLost:
            raise CommandError("Recognition worker lost its lease or heartbeat; stopped without accepting late output.") from None
        except DatabaseError:
            raise CommandError("Recognition worker database is unavailable; unfinished work will be recovered after lease expiry.") from None
