import hashlib
import io
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Event
from unittest.mock import patch

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connections
from django.test import SimpleTestCase, override_settings, tag
from PIL import Image

from receipts.models import Receipt
from recognition import queue
from recognition.demo import DemoError, seed_demo
from recognition.management.commands.recognition_worker import LeaseHeartbeat, probe_codex, validate_startup, worker_slot
from recognition.process_supervisor.supervisor import ProcessResult
from recognition.providers.codex_cli import CodexCLIProvider
from recognition.models import ProcessingJob
from recognition.pipeline import JobPipeline, process_job
from recognition.providers.base import ProviderError
from recognition.providers.fake import FakeProvider
from .test_pipeline import PipelineEnvironment


def run_worker(**options):
    try:
        call_command("recognition_worker", stdout=io.StringIO(), **options)
    finally:
        connections.close_all()


@tag("integration")
class WorkerTests(PipelineEnvironment):
    def setUp(self):
        super().setUp()
        self.scratch = TemporaryDirectory(prefix="checkist-c4-scratch-")
        self.addCleanup(self.scratch.cleanup)
        override = override_settings(RECEIPT_OCR_TEMP_ROOT=self.scratch.name)
        override.enable()
        self.addCleanup(override.disable)

    def test_once_processes_one_job_then_exits(self):
        first = self.new_job()
        second = self.new_job(self.single)
        output = io.StringIO()
        call_command("recognition_worker", once=True, fake_scenario="success2", stdout=output)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual((first.status, second.status), ("succeeded", "queued"))
        self.assertIn(f"Job {first.pk}: succeeded", output.getvalue())
        self.assertEqual(Receipt.objects.count(), 2)

    def test_once_empty_queue_exits_without_writes(self):
        call_command("recognition_worker", once=True, stdout=io.StringIO())
        self.assertEqual(ProcessingJob.objects.count(), 0)

    def test_environment_selects_fake_scenario(self):
        job = self.new_job()
        with patch.dict(os.environ, {"RECEIPT_OCR_FAKE_SCENARIO": "no_receipts"}):
            call_command("recognition_worker", once=True, stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual((job.status, job.error_code), ("failed", "no_receipts"))

    def test_command_scenario_overrides_environment(self):
        job = self.new_job(self.single)
        with patch.dict(os.environ, {"RECEIPT_OCR_FAKE_SCENARIO": "no_receipts"}):
            call_command("recognition_worker", once=True, fake_scenario="one_receipt", stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual((job.status, job.detected_count), ("succeeded", 1))

    def test_second_session_cannot_acquire_live_worker_slot(self):
        with worker_slot(), self.assertRaisesMessage(CommandError, "already running"):
            call_command("recognition_worker", once=True, stdout=io.StringIO())
        # Closing the session releases the slot on every exit.
        call_command("recognition_worker", once=True, stdout=io.StringIO())

    @override_settings(RECEIPT_OCR_HEARTBEAT_SECONDS=1, RECEIPT_OCR_LEASE_SECONDS=10)
    def test_heartbeat_uses_other_connection_and_handles_current_version(self):
        job = self.new_job()
        entered = Event()
        class PauseSecond(FakeProvider):
            def recognize(self, crop, run):
                if crop.position == 2:
                    return FakeProvider("pause_recognize", entered=entered).recognize(crop, run)
                return super().recognize(crop, run)
        with patch("recognition.management.commands.recognition_worker.get_provider", return_value=PauseSecond()):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(run_worker, once=True)
                try:
                    self.assertTrue(entered.wait(5))
                    before = ProcessingJob.objects.get(pk=job.pk)
                    self.assertEqual(Receipt.objects.count(), 1)
                    until = time.monotonic() + 5
                    while time.monotonic() < until:
                        after = ProcessingJob.objects.get(pk=job.pk)
                        if after.heartbeat_at > before.heartbeat_at:
                            break
                        time.sleep(0.05)
                    self.assertGreater(after.heartbeat_at, before.heartbeat_at)
                    self.assertEqual(after.version, before.version)
                    self.assertGreater(after.lease_expires_at, before.lease_expires_at)
                    with self.assertRaisesMessage(CommandError, "already running"):
                        call_command("recognition_worker", once=True, stdout=io.StringIO())
                finally:
                    current = ProcessingJob.objects.get(pk=job.pk)
                    if current.status == "running":
                        queue.request_cancel(job.pk)
                future.result(5)
        job.refresh_from_db()
        self.assertEqual((job.status, job.imported_count), ("cancelled", 1))

    def test_ctrl_c_requeues_active_job_preserving_committed_receipt(self):
        job = self.new_job()
        class Interrupted(FakeProvider):
            def recognize(self, crop, run):
                if crop.position == 2:
                    raise KeyboardInterrupt
                return super().recognize(crop, run)
        with patch("recognition.management.commands.recognition_worker.get_provider", return_value=Interrupted()):
            call_command("recognition_worker", once=True, stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual((job.status, job.stage, job.run_token), ("queued", "waiting", None))
        first_id = Receipt.objects.get().pk
        with patch.object(JobPipeline, "_retry_delay", return_value=0):
            call_command("recognition_worker", once=True, fake_scenario="success2", stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual((job.status, job.claim_count, job.imported_count), ("succeeded", 2, 2))
        self.assertEqual(job.images.get(position=1).receipt_id, first_id)

    def test_ctrl_c_keeps_user_cancel_instead_of_requeue(self):
        job = self.new_job()
        def cancelled_interrupt(claimed, **kwargs):
            queue.request_cancel(claimed.pk)
            raise KeyboardInterrupt
        with patch("recognition.management.commands.recognition_worker.process_job", side_effect=cancelled_interrupt):
            call_command("recognition_worker", once=True, stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual(job.status, "cancelled")

    def test_once_recovers_expired_job_and_exhausted_second_claim(self):
        job = self.new_job()
        claimed = queue.claim_job()
        self.expire(claimed)
        call_command("recognition_worker", once=True, stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual((job.status, job.claim_count), ("succeeded", 2))
        another = self.new_job(self.single)
        claimed = queue.claim_job()
        self.expire(claimed)
        queue.recover_expired_jobs()
        claimed = queue.claim_job()
        self.expire(claimed)
        call_command("recognition_worker", once=True, stdout=io.StringIO())
        another.refresh_from_db()
        self.assertEqual((another.status, another.claim_count, another.error_code), ("failed", 2, "worker_lost"))

    def test_failed_startup_releases_slot_and_leaves_job_queued(self):
        job = self.new_job()
        with patch("recognition.management.commands.recognition_worker.validate_startup", side_effect=CommandError("unavailable")):
            with self.assertRaisesMessage(CommandError, "unavailable"):
                call_command("recognition_worker", once=True, stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual((job.status, job.claim_count), ("queued", 0))
        with worker_slot():
            pass

    def test_heartbeat_loss_stops_without_importing_or_acknowledging_cancel(self):
        job = self.new_job()
        def lost(claimed, **kwargs):
            return process_job(claimed, provider=FakeProvider(), is_stopped=lambda: True)
        with patch("recognition.management.commands.recognition_worker.process_job", side_effect=lost):
            with self.assertRaisesMessage(CommandError, "lost its lease"):
                call_command("recognition_worker", once=True, stdout=io.StringIO())
        job.refresh_from_db()
        self.assertEqual(job.status, "running")
        self.assertEqual(Receipt.objects.count(), 0)
        self.expire(job)
        queue.recover_expired_jobs()
        self.assertEqual(ProcessingJob.objects.get(pk=job.pk).status, "queued")

    def test_seed_command_creates_no_jobs_or_receipts(self):
        output = io.StringIO()
        call_command("seed_recognition_demo", stdout=output)
        self.assertIn(str(self.single), output.getvalue())
        self.assertIn(str(self.double), output.getvalue())
        self.assertEqual((ProcessingJob.objects.count(), Receipt.objects.count()), (0, 0))

    @override_settings(RECEIPT_OCR_HEARTBEAT_SECONDS=1, RECEIPT_OCR_LEASE_SECONDS=10)
    def test_lost_singleton_session_stops_heartbeat_without_reconnecting(self):
        self.new_job()
        claimed = queue.claim_job()
        with worker_slot() as slot, LeaseHeartbeat(claimed, slot) as heartbeat:
            slot.connection.close()
            self.assertTrue(heartbeat.lost.wait(3))
            self.assertTrue(heartbeat.has_lost())
        self.assertEqual(Receipt.objects.count(), 0)


class WorkerConfigurationTests(SimpleTestCase):
    def setUp(self):
        self.root = TemporaryDirectory(prefix="checkist-c4-config-")
        self.addCleanup(self.root.cleanup)
        override = override_settings(
            MEDIA_ROOT=str(Path(self.root.name) / "media"), RECEIPT_OCR_TEMP_ROOT=str(Path(self.root.name) / "scratch"),
            RECEIPT_OCR_PROVIDER="fake",
        )
        override.enable()
        self.addCleanup(override.disable)

    @override_settings(RECEIPT_OCR_HEARTBEAT_SECONDS=30, RECEIPT_OCR_LEASE_SECONDS=30)
    def test_bad_heartbeat_configuration(self):
        with self.assertRaisesMessage(CommandError, "Invalid recognition"):
            validate_startup()

    def test_unwritable_storage(self):
        with patch("recognition.management.commands.recognition_worker.tempfile.TemporaryFile", side_effect=PermissionError):
            with self.assertRaisesMessage(CommandError, "storage is unavailable"):
                validate_startup()

    def test_overlapping_scratch_is_rejected(self):
        with override_settings(RECEIPT_OCR_TEMP_ROOT=str(Path(settings.MEDIA_ROOT) / "scratch")):
            with self.assertRaisesMessage(CommandError, "separate directories"):
                validate_startup()

    @override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_CODEX_EXECUTABLE="nonexistent-checkist-codex")
    def test_missing_cli_is_rejected_without_starting_it(self):
        with self.assertRaisesMessage(CommandError, "Codex executable is unavailable"):
            validate_startup()

    @override_settings(RECEIPT_OCR_PROVIDER="codex_cli")
    def test_fake_scenario_is_not_allowed_for_real_provider(self):
        with self.assertRaisesMessage(CommandError, "requires RECEIPT_OCR_PROVIDER=fake"):
            validate_startup(fake_scenario="success2")

    def test_invalid_fake_environment_has_no_fallback(self):
        with patch.dict(os.environ, {"RECEIPT_OCR_FAKE_SCENARIO": "typo"}):
            with self.assertRaisesMessage(CommandError, "configuration is invalid"):
                validate_startup()

    def test_demo_is_idempotent_and_layout_matches_fake(self):
        databases = {"default": {"NAME": "checkist_qa_c4"}}
        with override_settings(DATABASES=databases):
            paths = seed_demo()
            before = [(p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest()) for p in paths]
            self.assertEqual(seed_demo(), paths)
            self.assertEqual(before, [(p.stat().st_mtime_ns, hashlib.sha256(p.read_bytes()).hexdigest()) for p in paths])
            for path, size in zip(paths, ((800, 1100), (1500, 1100))):
                with Image.open(path) as image:
                    self.assertEqual(image.size, size)
                    self.assertEqual(image.getpixel((120, 110)), (255, 255, 255))

    def test_demo_refuses_non_test_database_before_creating_files(self):
        for name in ("checkist_dev", "production", "production_qa", "checkist_qa_production/../dev"):
            with self.subTest(name=name), override_settings(DATABASES={"default": {"NAME": name}}):
                with self.assertRaises(DemoError):
                    seed_demo()
        self.assertFalse(Path(settings.MEDIA_ROOT).exists())

    def test_retry_after_exceeding_budget_or_limit_is_not_slept(self):
        run = object.__new__(JobPipeline)
        run.run = type("Budget", (), {"deadline": time.monotonic() + 1})()
        self.assertIsNone(run._retry_delay(ProviderError("rate_limited", retry_after=2)))
        run.run.deadline = time.monotonic() + 100
        self.assertIsNone(run._retry_delay(ProviderError("rate_limited", retry_after=31)))
        self.assertIsNone(run._retry_delay(ProviderError("auth_required")))
        self.assertEqual(run._retry_delay(ProviderError("rate_limited", retry_after=5)), 5)

    def test_codex_startup_probes_version_flags_and_login_without_model(self):
        provider = CodexCLIProvider()
        Path(provider.config.temp_root).mkdir(parents=True, exist_ok=True)
        flags = b"--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check --output-schema --json --disable"
        with patch("recognition.management.commands.recognition_worker.ProcessSupervisor.run", side_effect=[
            ProcessResult(0, b"codex-cli 0.160.0"), ProcessResult(0, flags), ProcessResult(0, b"logged in"),
        ]) as run:
            probe_codex(provider, "mock-codex.exe")
        self.assertEqual(provider.cli_version, "0.160.0")
        self.assertEqual([call.args[0][1:] for call in run.call_args_list], [["--version"], ["exec", "--help"], ["login", "status"]])

    def test_codex_startup_rejects_missing_flags_and_auth_failure(self):
        provider = CodexCLIProvider()
        Path(provider.config.temp_root).mkdir(parents=True, exist_ok=True)
        with patch("recognition.management.commands.recognition_worker.ProcessSupervisor.run", side_effect=[
            ProcessResult(0, b"codex-cli 0.160.0"), ProcessResult(0, b"old CLI"), ProcessResult(0),
        ]), self.assertRaisesMessage(CommandError, "required recognition"):
            probe_codex(provider, "mock-codex.exe")
        with patch("recognition.management.commands.recognition_worker.ProcessSupervisor.run", side_effect=[
            ProcessResult(0, b"codex-cli 0.160.0"), ProcessResult(0), ProcessResult(1),
        ]), self.assertRaisesMessage(CommandError, "authentication is unavailable"):
            probe_codex(provider, "mock-codex.exe")
