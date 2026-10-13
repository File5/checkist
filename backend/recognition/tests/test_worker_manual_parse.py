"""The host worker's first kind of work: a «Трата словами» parse request. Fake provider only."""
from unittest.mock import patch

from django.test import tag

from receipts import manual_parse
from receipts.models import ManualParseRequest
from receipts.ownership import local_user
from recognition.management.commands import recognition_worker
from stores.models import Currency

from .test_worker_classification import WorkerClassificationEnvironment


@tag("integration")
class WorkerManualParseTests(WorkerClassificationEnvironment):
    def setUp(self):
        super().setUp()
        Currency.objects.get_or_create(code="KZT", defaults={"name": "Tenge"})  # the default of a new owner

    def test_parse_request_comes_before_a_recognition_job(self):
        job = self.new_job()
        row = manual_parse.request(local_user(), "такси 4500")
        self.assertEqual(self.worker(), [f"Manual parse {row.pk}: succeeded"])
        row.refresh_from_db()
        self.assertEqual(row.draft["total"], "4500")
        self.assertEqual(self.job_state(job)["status"], "queued")
        self.assertEqual(self.worker(), [f"Job {job.pk}: succeeded"])

    def test_unexpected_error_fails_the_request_not_the_worker(self):
        row = manual_parse.request(local_user(), "такси 4500")
        with patch.object(manual_parse, "build_input", side_effect=RuntimeError("boom")):
            self.assertEqual(self.worker(), [f"Manual parse {row.pk}: failed"])
        row.refresh_from_db()
        self.assertEqual((row.status, row.error_code), ("failed", "internal_error"))

    def test_fake_scenario_from_the_environment(self):
        row = manual_parse.request(local_user(), "такси 4500")
        with patch.dict("os.environ", {manual_parse.FAKE_SCENARIO_ENV: "timeout"}):
            self.worker()
        self.assertEqual(ManualParseRequest.objects.get(pk=row.pk).error_code, "timeout")

    def test_text_parser_configuration_error_stops_startup(self):
        with patch.object(manual_parse, "get_parser", side_effect=manual_parse.ProviderError("configuration_error")):
            with self.assertRaisesMessage(recognition_worker.CommandError, "Manual spend parse provider"):
                recognition_worker.build_text_parser()
