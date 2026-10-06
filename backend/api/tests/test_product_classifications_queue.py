"""Button → queue → host worker command → public HTTP of product classifications, one database.

The seam of the queue and the HTTP API: ``POST runs/`` only writes the row, the
``recognition_worker`` command executes it batch by batch, and ``status/``,
``runs/{id}/`` and the list of records show the queue, the progress and the
records. APIClient dispatches the real routes in process with cookie/Origin/CSRF;
MEDIA and scratch are temporary. Fake provider and fake classifier only: no model
call, no socket, no browser.
"""
from io import StringIO
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.core.management import call_command
from django.db import connection
from django.test import TransactionTestCase, override_settings, tag

from api.tests.classification_factories import local_client
from api.tests.test_product_classifications_api import CLOSED_KEYS, GROUPS, RUN_KEYS, keys
from classification import demo, runner
from classification.classifier import FakeClassifier
from classification.models import ClassificationRun
from recognition.management.commands.recognition_worker import worker_slot
from stores.models import Country, Currency

BASE = "/api/product-classifications/"
WORKER = "recognition.management.commands.recognition_worker"
ABSENT = {"available": False, "state": "absent", "last_seen_at": None}
IDLE = {"available": True, "state": "idle", "last_seen_at": None}
BUSY = {"available": True, "state": "busy", "last_seen_at": None}


@tag("integration")
@override_settings(
    PRODUCT_CLASSIFICATION_AUTO_SUGGEST=False, PRODUCT_MERGE_AUTO_DETECT=False, RECEIPT_OCR_MAX_ATTEMPTS=2,
    PRODUCT_CLASSIFICATION_BATCH_SIZE=25,
)
class QueueHttpEnvironment(TransactionTestCase):
    def setUp(self):
        self.assertEqual(connection.vendor, "postgresql")
        self.media = TemporaryDirectory(prefix="checkist-b1-media-")
        scratch = TemporaryDirectory(prefix="checkist-b1-scratch-")
        self.addCleanup(self.media.cleanup)
        self.addCleanup(scratch.cleanup)
        override = override_settings(
            DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True, MEDIA_ROOT=self.media.name,
            RECEIPT_OCR_TEMP_ROOT=scratch.name, RECEIPT_OCR_PROVIDER="fake",
        )
        override.enable()
        self.addCleanup(override.disable)
        pause = patch.object(runner, "_wait")  # the 2–3 s pause between attempts
        pause.start()
        self.addCleanup(pause.stop)
        self.bodies = []
        self.client = local_client()

    def get(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        if path.startswith(BASE):  # the closed names are checked in the classification answers only
            self.bodies.append(response.json())
        return response.json()

    def press(self, status):
        """The «Предложить категории» button."""
        response = self.client.post(BASE + "runs/", {}, format="json")
        self.assertEqual(response.status_code, status, response.content)
        self.bodies.append(response.json())
        return self.bodies[-1]

    def worker(self, scenario="mixed"):
        """One ``--once`` pass of the host worker; what it printed after the ready line."""
        output = StringIO()
        call_command(
            "recognition_worker", once=True, fake_scenario="success2", classification_fake_scenario=scenario,
            stdout=output,
        )
        lines = output.getvalue().splitlines()
        self.assertEqual(lines[0], "Recognition worker ready.")
        return lines[1:]

    def state(self):
        return self.get(BASE + "status/")

    def executors(self):
        """``executor`` of the classification API and of the recognition API."""
        return self.state()["executor"], self.get("/api/recognition/csrf/")["executor"]

    def assertNothingClosed(self):
        self.assertEqual(set().union(*(keys(body) for body in self.bodies)) & CLOSED_KEYS, set())


class ButtonThroughWorkerTests(QueueHttpEnvironment):
    @override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=4)
    def test_run_goes_from_the_button_through_the_worker_batch_by_batch(self):
        demo.seed_demo()
        expected = demo.EXPECTED
        state = self.state()
        self.assertEqual(
            (state["pending_count"], state["unclassified_count"], state["auto_suggest"], state["run"]),
            (0, expected["candidates"], False, None),
        )
        self.assertEqual(self.executors(), (ABSENT, ABSENT))

        created = self.press(202)
        run = created["run"]
        self.assertEqual(set(run), RUN_KEYS)
        self.assertEqual((created["created"], created["executor"]), (True, ABSENT))
        self.assertEqual((run["status"], run["trigger"], run["scope"], run["started_at"]), ("queued", "manual", "all", None))
        self.assertEqual(
            run["progress"], {"requested": 10, "processed": 0, "applied": 0, "unknown": 0, "skipped": 0})
        url = f"{BASE}runs/{run['id']}/"
        # Without a worker the run waits: nothing is suggested, the queue is visible.
        self.assertEqual(self.state()["run"], run)
        self.assertEqual(self.get(url), run)
        self.assertEqual([item["id"] for item in self.get(BASE + "runs/?status=queued")["results"]], [run["id"]])
        self.assertEqual(self.get(BASE + "?status=pending")["count"], 0)
        self.assertEqual(self.press(200), {"created": False, "run": run, "executor": ABSENT})

        # The first batch: the run waits in the queue again, already started.
        self.assertEqual(self.worker(), [f"Classification run {run['id']}: queued"])
        between = self.get(url)
        progress = between["progress"]
        self.assertEqual((between["status"], between["finished_at"], between["error"]), ("queued", None, None))
        self.assertIsNotNone(between["started_at"])
        self.assertGreater(between["version"], run["version"])
        self.assertEqual((progress["requested"], progress["processed"]), (10, 4))
        self.assertEqual(progress["applied"] + progress["unknown"] + progress["skipped"], 4)
        state = self.state()
        self.assertEqual(state["run"], between)
        self.assertEqual(
            (state["pending_count"], state["unclassified_count"]), (progress["applied"], 10 - progress["applied"]))
        self.assertEqual(self.get(f"{BASE}?status=pending&run={run['id']}")["count"], progress["applied"])
        self.assertEqual(self.executors(), (ABSENT, ABSENT))  # ``--once`` is seen only while it works
        # The button between batches returns the same run and keeps what its cursor passed.
        self.assertEqual(self.press(200), {"created": False, "run": between, "executor": ABSENT})

        self.assertEqual(self.worker(), [f"Classification run {run['id']}: queued"])
        self.assertEqual(self.get(url)["progress"]["processed"], 8)
        self.assertEqual(self.worker(), [f"Classification run {run['id']}: succeeded"])
        finished = self.get(url)
        self.assertEqual((finished["status"], finished["remaining"], finished["error"]), ("succeeded", 0, None))
        self.assertIsNotNone(finished["finished_at"])
        self.assertEqual(finished["progress"], {
            "requested": 10, "processed": 10, "applied": expected["pending"], "unknown": expected["unknown"],
            "skipped": 0,
        })
        state = self.state()
        self.assertEqual(
            (state["pending_count"], state["unclassified_count"], state["run"], state["executor"]),
            (expected["pending"], 1, finished, ABSENT),
        )
        page = self.get(BASE + "?status=pending")
        self.assertEqual(page["count"], expected["pending"])
        self.assertEqual(
            {(item["source"]["run_id"], item["source"]["trigger"], item["source"]["provider"])
             for item in page["results"]},
            {(run["id"], "manual", "fake")},
        )
        self.assertEqual(sorted({item["suggested"]["generic"]["name"] for item in page["results"]}), GROUPS)
        self.assertTrue(all(item["actions"]["can_confirm"] for item in page["results"]))
        self.assertEqual(self.get(f"{BASE}?run={run['id']}")["count"], expected["pending"])
        self.assertEqual(self.get(BASE + "runs/?status=queued")["count"], 0)
        self.assertEqual(self.worker(), [])  # the queue is empty

        # A finished run is not active: the button queues the product the model did not know.
        again = self.press(202)["run"]
        self.assertNotEqual(again["id"], run["id"])
        self.assertEqual((again["status"], again["progress"]["requested"]), ("queued", 1))
        self.assertEqual(self.state()["run"], again)
        self.assertEqual(self.worker(), [f"Classification run {again['id']}: succeeded"])
        self.assertEqual(self.get(f"{BASE}runs/{again['id']}/")["progress"], {
            "requested": 1, "processed": 1, "applied": 0, "unknown": 1, "skipped": 0,
        })
        self.assertEqual([item["id"] for item in self.get(BASE + "runs/")["results"]], [again["id"], run["id"]])
        self.assertEqual(self.get(BASE + "?status=pending")["count"], expected["pending"])
        self.assertNothingClosed()

    def test_executor_is_busy_during_a_batch_and_idle_beside_a_waiting_worker(self):
        demo.seed_demo()
        run = self.press(202)["run"]
        seen = []

        class Watching(FakeClassifier):
            def classify(inner, request, context):
                # The model is asked outside any transaction: both APIs see the committed claim.
                seen.append((self.state(), self.get("/api/recognition/csrf/")["executor"], self.press(200)))
                return super().classify(request, context)

        with patch(f"{WORKER}.get_classifier", return_value=Watching("mixed")):
            self.assertEqual(self.worker(), [f"Classification run {run['id']}: succeeded"])
        (state, recognition, pressed), = seen
        self.assertEqual((state["executor"], recognition), (BUSY, BUSY))
        self.assertEqual((state["run"]["id"], state["run"]["status"]), (run["id"], "running"))
        self.assertIsNotNone(state["run"]["started_at"])
        # The button during a batch returns the running run and queues nothing beside it.
        self.assertEqual((pressed["created"], pressed["run"], pressed["executor"]), (False, state["run"], BUSY))
        self.assertEqual(ClassificationRun.objects.count(), 1)
        self.assertEqual(self.executors(), (ABSENT, ABSENT))
        with worker_slot():
            self.assertEqual(self.executors(), (IDLE, IDLE))
        self.assertEqual(self.executors(), (ABSENT, ABSENT))
        self.assertNothingClosed()

    def test_failed_run_shows_the_public_error_and_the_button_queues_a_new_one(self):
        demo.seed_demo()
        run = self.press(202)["run"]
        self.assertEqual(self.worker("auth_failure"), [f"Classification run {run['id']}: failed"])
        failed = self.get(f"{BASE}runs/{run['id']}/")
        self.assertEqual(
            (failed["status"], failed["error"]),
            ("failed", {"code": "auth_required", "message": "Требуется вход в сервис модели."}),
        )
        self.assertIsNotNone(failed["finished_at"])
        self.assertEqual(
            failed["progress"], {"requested": 10, "processed": 0, "applied": 0, "unknown": 0, "skipped": 0})
        state = self.state()
        self.assertEqual((state["run"], state["pending_count"], state["unclassified_count"]), (failed, 0, 10))
        self.assertEqual([item["id"] for item in self.get(BASE + "runs/?status=failed")["results"]], [run["id"]])
        again = self.press(202)["run"]
        self.assertEqual(self.worker(), [f"Classification run {again['id']}: succeeded"])
        self.assertEqual(self.state()["pending_count"], demo.EXPECTED["pending"])
        self.assertNothingClosed()


class AutoSuggestHttpTests(QueueHttpEnvironment):
    def setUp(self):
        super().setUp()
        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        call_command("seed_recognition_demo", stdout=StringIO())
        self.double = (Path(self.media.name) / "demo/double.png").read_bytes()

    def upload(self):
        response = self.client.post(
            "/api/recognition/photos/", {"file": SimpleUploadedFile("synthetic.png", self.double, "image/png")},
            format="multipart")
        self.assertEqual(response.status_code, 202, response.content)
        return response.json()["job"]["id"]

    @override_settings(PRODUCT_CLASSIFICATION_AUTO_SUGGEST=True)
    def test_import_queues_a_run_and_the_next_pass_suggests(self):
        job_id = self.upload()
        self.assertEqual(self.worker("new_category"), [f"Job {job_id}: succeeded"])
        job = self.get(f"/api/recognition/jobs/{job_id}/")
        state = self.state()
        run = state["run"]
        self.assertEqual(
            (state["auto_suggest"], state["pending_count"], state["unclassified_count"]), (True, 0, 5))
        self.assertEqual(
            (run["status"], run["trigger"], run["scope"], run["started_at"]), ("queued", "import", "products", None))
        self.assertEqual(
            run["progress"], {"requested": 5, "processed": 0, "applied": 0, "unknown": 0, "skipped": 0})
        # The button does not queue a second run beside the one of the import.
        pressed = self.press(200)
        self.assertEqual((pressed["created"], pressed["run"]["id"], pressed["run"]["scope"]), (False, run["id"], "all"))

        self.assertEqual(self.worker("new_category"), [f"Classification run {run['id']}: succeeded"])
        state = self.state()
        self.assertEqual(
            (state["pending_count"], state["unclassified_count"], state["run"]["status"]), (5, 0, "succeeded"))
        page = self.get(BASE + "?status=pending")
        self.assertEqual(
            {(item["source"]["run_id"], item["source"]["trigger"]) for item in page["results"]},
            {(run["id"], "import")},
        )
        self.assertEqual(page["count"], 5)
        # The outcome of the run does not touch the recognition job.
        after = self.get(f"/api/recognition/jobs/{job_id}/")
        self.assertEqual(
            (after["status"], after["version"], after["progress"]), (job["status"], job["version"], job["progress"]))
        self.assertEqual(self.press(200), {"created": False, "run": None, "executor": ABSENT})
        self.assertNothingClosed()

    def test_flag_off_queues_nothing_until_the_button(self):
        job_id = self.upload()
        self.assertEqual(self.worker("new_category"), [f"Job {job_id}: succeeded"])
        state = self.state()
        self.assertEqual(
            (state["auto_suggest"], state["run"], state["pending_count"], state["unclassified_count"]),
            (False, None, 0, 5),
        )
        self.assertEqual(self.worker("new_category"), [])
        self.assertEqual(ClassificationRun.objects.count(), 0)
        run = self.press(202)["run"]
        self.assertEqual((run["trigger"], run["scope"], run["progress"]["requested"]), ("manual", "all", 5))
        self.assertEqual(self.worker("new_category"), [f"Classification run {run['id']}: succeeded"])
        self.assertEqual(self.state()["pending_count"], 5)
