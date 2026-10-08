"""Confirmation against real PostgreSQL locks held by other connections."""
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.db import connection, connections, transaction
from django.test import TransactionTestCase, override_settings, tag
from rest_framework.test import APIClient

from receipts.models import Receipt, ReceiptLine
from receipts.ownership import local_user
from recognition import importer, review
from recognition.importer import IMPORT_LOCK, import_receipt
from recognition.models import ProcessingJob, ReceiptImage
from recognition.queue import claim_job, finish_job, save_image_result
from recognition.tests.import_fixtures import another_receipt, live_image, observation
from recognition.tests.test_models import make_image, make_photo
from stores.models import Country, Currency
from recognition.tests.test_review import (
    body_of, domain_counts, fixed_body, image_state, review_image, stored, wrong_total,
)


def local_client():
    client = APIClient(enforce_csrf_checks=True)
    token = client.get("/api/recognition/csrf/").json()["csrf_token"]
    client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN="http://testserver")
    return client


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class ReviewConcurrencyTests(TransactionTestCase):
    def setUp(self):
        # The flush of a TransactionTestCase removes the seeded reference rows.
        Country.objects.get_or_create(code="DE", defaults={"name": "Germany"})
        Currency.objects.get_or_create(code="EUR", defaults={"name": "Euro"})
        directory = tempfile.TemporaryDirectory(prefix="checkist-review-race-")
        self.addCleanup(directory.cleanup)
        settings = override_settings(MEDIA_ROOT=directory.name)
        settings.enable()
        self.addCleanup(settings.disable)

    def url(self, image):
        return f"/api/recognition/receipt-images/{image.pk}/confirm/"

    def request(self, image, body):
        """One confirmation on its own connection: (HTTP status, error code | None, backend pid)."""
        try:
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_backend_pid()")
                pid = cursor.fetchone()[0]
            response = local_client().post(self.url(image), body, format="json")
            return response.status_code, response.json().get("error", {}).get("code"), pid
        finally:
            connections.close_all()

    def hold(self, lock):
        """Context: another connection holds ``lock(cursor)`` inside an open transaction."""
        test = self

        class Holder:
            def __enter__(self):
                self.held, self.release = threading.Event(), threading.Event()
                self.pool = ThreadPoolExecutor(max_workers=1)
                self.future = self.pool.submit(self.run)
                test.assertTrue(self.held.wait(5), "The other connection did not take the lock")
                return self

            def run(self):
                try:
                    with transaction.atomic(), connection.cursor() as cursor:
                        lock(cursor)
                        self.held.set()
                        self.release.wait(15)
                finally:
                    connections.close_all()

            def __exit__(self, *exc):
                self.release.set()
                self.future.result(timeout=10)
                self.pool.shutdown()

        return Holder()

    def paused(self, first, second):
        """Run ``first`` until it is inside the import, then ``second`` to its end, then release."""
        entered, release = threading.Event(), threading.Event()
        original = importer._create_graph

        def pause(*args, **kwargs):
            entered.set()
            if not release.wait(10):
                raise AssertionError("The paused confirmation was not released")
            return original(*args, **kwargs)

        with ThreadPoolExecutor(max_workers=2) as pool, patch.object(importer, "_create_graph", side_effect=pause):
            running = pool.submit(first)
            try:
                self.assertTrue(entered.wait(10))
                other = pool.submit(second).result(timeout=10)
            finally:
                release.set()
            return running.result(timeout=10), other

    def test_two_confirmations_of_one_crop_create_one_receipt(self):
        image = review_image()
        before = image_state(image)
        started = time.monotonic()
        first, second = self.paused(lambda: self.request(image, fixed_body()),
                                    lambda: self.request(image, fixed_body(operation=None)))
        # The second one meets the import mutex of the first: refused at once, nothing written.
        self.assertEqual((first[:2], second[:2]), ((200, None), (409, "review_busy")))
        self.assertNotEqual(first[2], second[2])
        self.assertLess(time.monotonic() - started, 8)
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count()), (1, 4))
        after = image_state(image)
        self.assertNotEqual(after, before)
        self.assertEqual(ProcessingJob.objects.get(pk=image.job_id).version, 2)
        # After the first commit the repeated bodies are decided by the stored request identity.
        self.assertEqual(self.request(image, fixed_body(operation=None))[:2], (409, "review_resolved"))
        self.assertEqual(self.request(image, fixed_body())[:2], (200, None))
        self.assertEqual((image_state(image), Receipt.objects.count()), (after, 1))

    def test_unpaused_race_never_duplicates(self):
        for same in (True, False):
            Receipt.objects.all().delete()
            image = review_image()
            barrier = threading.Barrier(2)

            def send(body):
                barrier.wait(timeout=5)
                return self.request(image, body)

            bodies = (fixed_body(), fixed_body() if same else fixed_body(operation=None))
            with ThreadPoolExecutor(max_workers=2) as pool:
                results = [future.result(timeout=15) for future in [pool.submit(send, body) for body in bodies]]
            outcomes = sorted(result[:2] for result in results)
            with self.subTest(same=same):
                self.assertIn((200, None), outcomes)
                allowed = {(200, None), (409, "review_busy")} if same else {
                    (200, None), (409, "review_busy"), (409, "review_resolved")}
                self.assertLessEqual(set(outcomes), allowed)
                if not same:
                    self.assertEqual(outcomes.count((200, None)), 1)
                self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count()), (1, 4))
                self.assertEqual(ProcessingJob.objects.get(pk=image.job_id).version, 2)
                self.assertEqual(ReceiptImage.objects.get(pk=image.pk).status, "imported")

    def test_two_crops_of_one_receipt_are_confirmed_in_turn_without_duplicates(self):
        first, second = review_image(), review_image()
        one, two = self.paused(lambda: self.request(first, fixed_body()), lambda: self.request(second, fixed_body()))
        self.assertEqual((one[:2], two[:2]), ((200, None), (409, "review_busy")))
        self.assertEqual(ReceiptImage.objects.get(pk=second.pk).status, "needs_review")
        self.assertEqual(self.request(second, fixed_body())[:2], (200, None))
        second.refresh_from_db()
        self.assertEqual((second.status, second.receipt_id), ("reused", Receipt.objects.get().pk))
        self.assertEqual(domain_counts()[:4], (1, 4, 1, 2))

    def test_held_import_mutex_is_review_busy_at_once(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()
        client = local_client()
        with self.hold(lambda cursor: cursor.execute("SELECT pg_advisory_xact_lock(%s)", [IMPORT_LOCK])):
            started = time.monotonic()
            response = client.post(self.url(image), fixed_body(), format="json")
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "review_busy"))
            self.assertLess(time.monotonic() - started, 1.5)  # no waiting and no hidden retry
            # Reading stays available while the mutex is taken.
            self.assertEqual(client.get(f"/api/recognition/receipt-images/{image.pk}/").json()["status"], "needs_review")
            self.assertEqual((image_state(image), domain_counts()), (before, counts))
        self.assertEqual(client.post(self.url(image), fixed_body(), format="json").status_code, 200)

    def test_worker_import_and_confirmation_exclude_each_other(self):
        waiting = review_image()
        crop, job = live_image()

        def worker():
            try:
                return import_receipt(crop, observation(another_receipt()), run_token=job.run_token,
                                      version=job.version).outcome
            finally:
                connections.close_all()

        imported, refused = self.paused(worker, lambda: self.request(waiting, fixed_body()))
        self.assertEqual((imported, refused[:2]), ("created", (409, "review_busy")))
        self.assertEqual(ReceiptImage.objects.get(pk=waiting.pk).status, "needs_review")
        self.assertEqual(self.request(waiting, fixed_body())[:2], (200, None))
        self.assertEqual(Receipt.objects.count(), 2)

    def test_locked_rows_are_review_busy_after_the_statement_timeout(self):
        image = review_image()
        before, counts = image_state(image), domain_counts()
        client = local_client()
        locks = (
            lambda cursor: cursor.execute("SELECT 1 FROM recognition_processingjob WHERE id = %s FOR UPDATE", [image.job_id]),
            lambda cursor: cursor.execute("SELECT 1 FROM recognition_receiptimage WHERE id = %s FOR UPDATE", [image.pk]),
        )
        for lock in locks:
            with self.hold(lock):
                started = time.monotonic()
                response = client.post(self.url(image), fixed_body(), format="json")
                waited = time.monotonic() - started
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "review_busy"))
                self.assertGreater(waited, 1.5)  # the 2000 ms statement_timeout, once
                self.assertLess(waited, 6)
            self.assertEqual((image_state(image), domain_counts()), (before, counts))
        self.assertEqual(client.post(self.url(image), fixed_body(), format="json").status_code, 200)

    def test_active_job_is_refused_and_the_worker_finishes_it(self):
        photo = make_photo()
        ProcessingJob.objects.create(photo=photo)
        job = claim_job()
        ProcessingJob.objects.filter(pk=job.pk).update(detected_count=1)
        image = make_image(job, status="running")
        _, job = save_image_result(job.pk, job.run_token, job.version, image.pk, status="needs_review",
                                   normalized_result=stored(wrong_total()),
                                   issues=[{"code": "total_mismatch", "field": "/total", "message": "x"}])
        before, counts = image_state(image), domain_counts()
        client = local_client()
        # The crop already awaits a person, but its job is still the worker's.
        for body in (fixed_body(), body_of(wrong_total())):
            response = client.post(self.url(image), body, format="json")
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "job_active"))
        self.assertEqual((image_state(image), domain_counts()), (before, counts))

        # The worker terminalizes on another connection while a confirmation waits on the job row.
        def finish():
            try:
                with transaction.atomic():
                    finished = finish_job(job.pk, job.run_token, job.version, status="partial_succeeded")
                    locked.set()
                    release.wait(1)  # shorter than statement_timeout: the request waits, then proceeds
                return finished.status
            finally:
                connections.close_all()

        locked, release = threading.Event(), threading.Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            finishing = pool.submit(finish)
            self.assertTrue(locked.wait(5))
            response = client.post(self.url(image), fixed_body(), format="json")
            self.assertEqual(finishing.result(timeout=10), "partial_succeeded")
        self.assertEqual(response.status_code, 200, response.content)
        value = response.json()
        self.assertEqual((value["image"]["status"], value["job"]["status"], value["job"]["progress"]["review"]),
                         ("imported", "succeeded", 0))
        self.assertEqual(Receipt.objects.count(), 1)

    def test_known_unique_race_with_an_outside_writer_is_review_busy(self):
        # The shop is committed; a writer that bypasses the import mutex creates the same receipt
        # between the duplicate lookup and the insert of the confirmation.
        image = review_image()
        effective, _, derived = review.effective_observation(observation())
        with transaction.atomic():
            store = importer._import_domain(effective, derived, owner_id=local_user().pk)[0].store
        Receipt.objects.all().delete()
        before = image_state(image)
        original, raced = importer.clean_save, []

        def outside_writer():
            try:
                with transaction.atomic():
                    return importer._import_domain(effective, derived, owner_id=local_user().pk)[0].pk
            finally:
                connections.close_all()

        def concurrent_save(obj):
            if isinstance(obj, Receipt) and obj.pk is None and not raced:
                raced.append(True)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pool.submit(outside_writer).result(timeout=10)
            return original(obj)

        client = local_client()
        with patch.object(importer, "clean_save", side_effect=concurrent_save):
            response = client.post(self.url(image), fixed_body(), format="json")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "review_busy"))
        self.assertEqual(raced, [True])
        self.assertEqual((image_state(image), Receipt.objects.count()), (before, 1))  # only the outside receipt
        # The repeated request finds that receipt as a duplicate.
        value = client.post(self.url(image), fixed_body(), format="json").json()
        self.assertEqual((value["image"]["status"], value["image"]["receipt_id"]), ("reused", Receipt.objects.get().pk))
        self.assertEqual(Receipt.objects.get().store_id, store.pk)
