"""Чеки, распознавание и статистика по владельцу: чужое не видно и не меняется.

Чужой объект отвечает ``404`` тем же телом, что несуществующий, — и в чтении, и в
cancel / retry / confirm; фильтр с чужим id даёт пустую страницу; суммы двух
пользователей не складываются. Магазины и товары общие. Данные вымышленные, MEDIA
временный, модель не вызывается.
"""
import tempfile
from datetime import date
from decimal import Decimal

from django.test import TestCase, override_settings, tag
from django.utils import timezone
from rest_framework.test import APIClient

from api.tests.accounts_helpers import (
    MISSING, NOT_FOUND, TwoUsers, accounts_mode, local_single_mode, signed_in,
)
from api.tests.factories import make_product, make_receipt
from api.tests.test_recognition_api import upload
from catalog.models import Category, GenericProduct
from receipts.models import Receipt, ReceiptDiscount, ReceiptTax
from receipts.ownership import LOCAL_USERNAME, local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line
from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from recognition.tests.test_models import make_image, make_photo
from recognition.tests.test_owner_isolation import review_image_of
from recognition.tests.test_review import domain_counts, fixed_body, image_state
from stores.models import TaxRate

D = Decimal
CSRF_FAILED = {"error": {"code": "csrf_failed", "message": "Проверка CSRF не пройдена."}}
PERIODS = "base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-12-31"
SPENDING = "/api/stats/spending/"
SERIES = "/api/stats/receipts/series/"
COMPARE = "/api/stats/receipts/compare/"


def milk():
    category = Category.objects.create(name="Демо-продукты питания")
    generic = GenericProduct.objects.create(name="Демо-молоко", category=category, base_unit="pcs")
    return make_product(generic, "Демо-молоко 1 л")


def purchase(owner, store, currency, on, total, product, **line):
    """Чек владельца с одной товарной строкой на всю сумму."""
    receipt = make_receipt(store, currency, on, owner=owner, total=D(total))
    make_line(receipt, product=product, unit_price=D(total), amount=D(total), **line)
    return receipt


def finish(job, status="failed"):
    ProcessingJob.objects.filter(pk=job.pk).update(status=status, stage="finished", finished_at=timezone.now())
    job.refresh_from_db()
    return job


def job_state(job):
    job = ProcessingJob.objects.get(pk=job.pk)
    return job.status, job.stage, job.version, job.cancel_requested_at, job.finished_at


def ids(response):
    assert response.status_code == 200, response.content
    return [item["id"] for item in response.json()["results"]]


def count(response):
    assert response.status_code == 200, response.content
    return response.json()["count"]


class IsolationMixin(TwoUsers):
    def temporary_media(self):
        directory = tempfile.TemporaryDirectory(prefix="checkist-owner-api-test-")
        self.addCleanup(directory.cleanup)
        override = override_settings(MEDIA_ROOT=directory.name, PRODUCT_MERGE_AUTO_DETECT=False,
                                     PRODUCT_CLASSIFICATION_AUTO_SUGGEST=False)
        override.enable()
        self.addCleanup(override.disable)

    def assert_same_as_missing(self, response, missing):
        """Чужой объект неотличим от несуществующего: статус, тело и заголовки ответа."""
        self.assertEqual(response.status_code, 404, response.content)
        self.assertEqual(response.json(), NOT_FOUND)
        self.assertEqual((missing.status_code, missing.content), (response.status_code, response.content))
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response["Content-Type"], missing["Content-Type"])
        self.assertNotIn("WWW-Authenticate", response)


@tag("integration")
@accounts_mode()
class ReceiptIsolationTests(IsolationMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.store, cls.product = samples.lidl_store(), milk()
        cls.receipts = {}
        rate = TaxRate.objects.get(country_id="DE", rate="7.00")
        for account, name, total in ((cls.first, "SYNTH EINS", "10.00"), (cls.second, "SYNTH ZWEI", "7.00")):
            receipt = purchase(account, cls.store, "EUR", date(2026, 3, 5), total, cls.product, raw_name=name)
            ReceiptDiscount.objects.create(receipt=receipt, line=receipt.lines.get(), position=1, name="Rabatt",
                                           amount="0.10")
            ReceiptTax.objects.create(receipt=receipt, tax_rate=rate, tax_code="A", net="1.00", tax="0.07",
                                      gross="1.07")
            cls.receipts[account.pk] = receipt

    def pairs(self):
        first, second = self.receipts[self.first.pk], self.receipts[self.second.pk]
        return ((self.first, first, second), (self.second, second, first))

    def test_list_holds_only_own_receipts(self):
        for account, own, _other in self.pairs():
            with self.subTest(account=account.username):
                response = self.client_of(account).get("/api/receipts/")
                self.assertEqual(ids(response), [own.pk])
                self.assertEqual(response.json()["count"], 1)
        self.assertEqual(count(self.client_of(self.moderator).get("/api/receipts/")), 0)

    def test_filters_by_shared_store_and_product_keep_only_own(self):
        queries = (f"store={self.store.pk}", f"product={self.product.pk}", "country=DE", "currency=EUR",
                   "operation=sale", "date_from=2026-03-05&date_to=2026-03-05", "search=SYNTH", "search=молоко")
        for account, own, _other in self.pairs():
            for query in queries:
                with self.subTest(account=account.username, query=query):
                    self.assertEqual(ids(self.client_of(account).get(f"/api/receipts/?{query}")), [own.pk])
        # Текст строки чужого чека своих чеков не находит.
        self.assertEqual(count(self.client_of(self.first).get("/api/receipts/?search=ZWEI")), 0)
        self.assertEqual(count(self.client_of(self.second).get("/api/receipts/?search=EINS")), 0)

    def test_own_receipt_and_children_are_read(self):
        for account, own, _other in self.pairs():
            client = self.client_of(account)
            with self.subTest(account=account.username):
                header = client.get(f"/api/receipts/{own.pk}/")
                self.assertEqual(header.status_code, 200, header.content)
                self.assertEqual((header.json()["id"], header.json()["total"]), (own.pk, str(own.total)))
                lines = client.get(f"/api/receipts/{own.pk}/lines/").json()["results"]
                self.assertEqual([line["id"] for line in lines], [own.lines.get().pk])
                self.assertEqual(ids(client.get(f"/api/receipts/{own.pk}/discounts/")), [own.discounts.get().pk])
                self.assertEqual(ids(client.get(f"/api/receipts/{own.pk}/taxes/")), [own.taxes.get().pk])

    def test_foreign_receipt_and_children_answer_as_missing(self):
        tails = ("", "lines/", "discounts/", "taxes/", "lines/?kind=product&matching=matched", "lines/?page_size=999",
                 "discounts/?page=7", "taxes/?unknown=1")
        cases = [(account, other) for account, _own, other in self.pairs()]
        cases += [(self.moderator, receipt) for receipt in self.receipts.values()]
        for account, other in cases:
            client = self.client_of(account)
            for tail in tails:
                with self.subTest(account=account.username, tail=tail):
                    self.assert_same_as_missing(client.get(f"/api/receipts/{other.pk}/{tail}"),
                                                client.get(f"/api/receipts/{MISSING}/{tail}"))

    def test_local_single_reads_only_receipts_of_local(self):
        own = purchase(local_user(), self.store, "EUR", date(2026, 3, 6), "3.00", self.product)
        other = self.receipts[self.first.pk]
        with local_single_mode():
            client = APIClient()
            self.assertEqual(ids(client.get("/api/receipts/")), [own.pk])
            self.assertEqual(client.get(f"/api/receipts/{own.pk}/lines/").status_code, 200)
            for tail in ("", "lines/", "discounts/", "taxes/"):
                with self.subTest(tail=tail):
                    self.assert_same_as_missing(client.get(f"/api/receipts/{other.pk}/{tail}"),
                                                client.get(f"/api/receipts/{MISSING}/{tail}"))


@tag("integration")
@accounts_mode()
class RecognitionIsolationTests(IsolationMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        store, product = samples.lidl_store(), milk()
        cls.rows = {}
        for account in (cls.first, cls.second):
            receipt = purchase(account, store, "EUR", date(2026, 3, 5), "5.00", product)
            photo = make_photo(owner=account)
            job = ProcessingJob.objects.create(photo=photo)
            image = make_image(job, status="imported", receipt=receipt, import_effect="created",
                               outcome_snapshot={"receipt_id": receipt.pk})
            cls.rows[account.pk] = {"photos": photo, "jobs": job, "receipt-images": image, "receipt": receipt}

    def setUp(self):
        self.temporary_media()

    def pairs(self):
        first, second = self.rows[self.first.pk], self.rows[self.second.pk]
        return ((self.first, first, second), (self.second, second, first))

    def test_lists_hold_only_own_rows(self):
        for account, own, _other in self.pairs():
            client = self.client_of(account)
            for resource in ("photos", "jobs", "receipt-images"):
                with self.subTest(account=account.username, resource=resource):
                    self.assertEqual(ids(client.get(f"/api/recognition/{resource}/")), [own[resource].pk])
        for resource in ("photos", "jobs", "receipt-images"):
            with self.subTest(account="moderator", resource=resource):
                self.assertEqual(count(self.client_of(self.moderator).get(f"/api/recognition/{resource}/")), 0)

    def test_own_details_carry_own_ids(self):
        for account, own, _other in self.pairs():
            client = self.client_of(account)
            with self.subTest(account=account.username):
                photo = client.get(f"/api/recognition/photos/{own['photos'].pk}/").json()
                self.assertEqual((photo["id"], photo["latest_job_id"], photo["receipt_images_count"]),
                                 (own["photos"].pk, own["jobs"].pk, 1))
                job = client.get(f"/api/recognition/jobs/{own['jobs'].pk}/").json()
                self.assertEqual((job["id"], job["photo_id"], job["items_count"]),
                                 (own["jobs"].pk, own["photos"].pk, 1))
                self.assertEqual(job["items"], [{"image_id": own["receipt-images"].pk, "position": 1,
                                                 "status": "imported", "receipt_id": own["receipt"].pk}])
                image = client.get(f"/api/recognition/receipt-images/{own['receipt-images'].pk}/").json()
                self.assertEqual((image["id"], image["receipt_id"]), (own["receipt-images"].pk, own["receipt"].pk))

    def test_foreign_details_answer_as_missing(self):
        cases = [(account, other) for account, _own, other in self.pairs()]
        cases += [(self.moderator, rows) for rows in self.rows.values()]
        for account, other in cases:
            client = self.client_of(account)
            for resource in ("photos", "jobs", "receipt-images"):
                with self.subTest(account=account.username, resource=resource):
                    base = f"/api/recognition/{resource}/"
                    self.assert_same_as_missing(client.get(f"{base}{other[resource].pk}/"),
                                                client.get(f"{base}{MISSING}/"))

    def test_filter_by_foreign_id_gives_an_empty_page(self):
        for account, own, other in self.pairs():
            client = self.client_of(account)
            for rows, expected in ((own, 1), (other, 0)):
                queries = (
                    f"jobs/?photo={rows['photos'].pk}",
                    f"jobs/?photo={rows['photos'].pk}&status=queued",
                    f"receipt-images/?photo={rows['photos'].pk}",
                    f"receipt-images/?job={rows['jobs'].pk}",
                    f"receipt-images/?receipt={rows['receipt'].pk}",
                    f"receipt-images/?photo={rows['photos'].pk}&job={rows['jobs'].pk}&receipt={rows['receipt'].pk}",
                )
                for query in queries:
                    with self.subTest(account=account.username, query=query, expected=expected):
                        response = client.get(f"/api/recognition/{query}")
                        self.assertEqual(count(response), expected)
                        self.assertEqual(len(response.json()["results"]), expected)
            # Свой фильтр вместе с чужим — тоже пусто, а не свои строки.
            mixed = f"receipt-images/?photo={own['photos'].pk}&job={other['jobs'].pk}"
            self.assertEqual(count(client.get(f"/api/recognition/{mixed}")), 0)

    def test_cancel_and_retry_of_a_foreign_job_answer_as_missing(self):
        queued = self.rows[self.second.pk]["jobs"]
        failed = finish(ProcessingJob.objects.create(photo=make_photo(owner=self.second)))
        before = (job_state(queued), job_state(failed), ProcessingJob.objects.count())
        for account in (self.first, self.moderator):
            client = self.client_of(account, csrf=True)
            for job, action in ((queued, "cancel"), (failed, "retry"), (queued, "retry"), (failed, "cancel")):
                path, missing = (f"/api/recognition/jobs/{pk}/{action}/" for pk in (job.pk, MISSING))
                with self.subTest(account=account.username, action=action, status=job.status):
                    self.assert_same_as_missing(client.post(path, {}, format="json"),
                                                client.post(missing, {}, format="json"))
                    # Плохое тело отклоняется раньше поиска: ответы тоже совпадают.
                    wrong, wrong_missing = (
                        client.post(url, b'{"a":1}', content_type="application/json") for url in (path, missing))
                    self.assertEqual(wrong.status_code, 400, wrong.content)
                    self.assertEqual((wrong.status_code, wrong.content),
                                     (wrong_missing.status_code, wrong_missing.content))
        self.assertEqual((job_state(queued), job_state(failed), ProcessingJob.objects.count()), before)

    def test_csrf_is_checked_before_the_owner(self):
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.first)
        job = self.rows[self.second.pk]["jobs"]
        for pk in (job.pk, MISSING):
            for action in ("cancel", "retry"):
                with self.subTest(pk=pk, action=action):
                    response = client.post(f"/api/recognition/jobs/{pk}/{action}/", {}, format="json")
                    self.assertEqual((response.status_code, response.json()), (403, CSRF_FAILED))

    def test_owner_cancels_and_retries_own_job(self):
        client = self.client_of(self.second, csrf=True)
        queued = self.rows[self.second.pk]["jobs"]
        cancelled = client.post(f"/api/recognition/jobs/{queued.pk}/cancel/", {}, format="json")
        self.assertEqual(cancelled.status_code, 200, cancelled.content)
        self.assertEqual((cancelled.json()["id"], cancelled.json()["status"]), (queued.pk, "cancelled"))
        retry = client.post(f"/api/recognition/jobs/{queued.pk}/retry/", {}, format="json")
        self.assertEqual(retry.status_code, 202, retry.content)
        self.assertEqual((retry.json()["retry_of"], retry.json()["photo_id"]), (queued.pk, queued.photo_id))
        self.assertEqual(retry["Location"], f"/api/recognition/jobs/{retry.json()['id']}/")
        # Новое задание — того же фото, значит того же владельца.
        other = self.client_of(self.first)
        self.assert_same_as_missing(other.get(retry["Location"]), other.get(f"/api/recognition/jobs/{MISSING}/"))
        self.assertEqual(ids(other.get("/api/recognition/jobs/")), [self.rows[self.first.pk]["jobs"].pk])

    def test_same_file_of_the_second_user_is_a_new_photo(self):
        def post(account):
            return self.client_of(account, csrf=True).post(
                "/api/recognition/photos/", {"file": upload()}, format="multipart")

        first, second = post(self.first), post(self.second)
        self.assertEqual((first.status_code, second.status_code), (202, 202), (first.content, second.content))
        first, second = first.json(), second.json()
        self.assertEqual((first["reused"], second["reused"]), (False, False))
        self.assertNotEqual(first["photo"]["id"], second["photo"]["id"])
        self.assertNotEqual(first["job"]["id"], second["job"]["id"])
        self.assertEqual(second["job"]["status"], "queued")
        photos = {photo.pk: photo for photo in SourcePhoto.objects.filter(
            pk__in=(first["photo"]["id"], second["photo"]["id"]))}
        mine, theirs = photos[first["photo"]["id"]], photos[second["photo"]["id"]]
        self.assertEqual((mine.owner_id, theirs.owner_id), (self.first.pk, self.second.pk))
        self.assertEqual(mine.sha256, theirs.sha256)
        self.assertNotEqual(mine.original_file.name, theirs.original_file.name)
        self.assertNotEqual(first["photo"]["original_url"], second["photo"]["original_url"])

        for account, value in ((self.second, second), (self.first, first)):
            with self.subTest(replay=account.username):
                replay = post(account)
                self.assertEqual(replay.status_code, 200, replay.content)
                replay = replay.json()
                self.assertTrue(replay["reused"])
                self.assertEqual((replay["photo"]["id"], replay["job"]["id"]),
                                 (value["photo"]["id"], value["job"]["id"]))
        self.assertEqual(SourcePhoto.objects.filter(sha256=mine.sha256).count(), 2)
        self.assertEqual(ProcessingJob.objects.filter(photo__sha256=mine.sha256).count(), 2)
        for account, own, other in ((self.first, first, second), (self.second, second, first)):
            client = self.client_of(account)
            with self.subTest(account=account.username):
                self.assertIn(own["photo"]["id"], ids(client.get("/api/recognition/photos/")))
                self.assertNotIn(other["photo"]["id"], ids(client.get("/api/recognition/photos/")))
                self.assertNotIn(other["job"]["id"], ids(client.get("/api/recognition/jobs/")))
                self.assert_same_as_missing(client.get(f"/api/recognition/jobs/{other['job']['id']}/"),
                                            client.get(f"/api/recognition/jobs/{MISSING}/"))

    def test_local_single_reads_only_rows_of_local(self):
        photo = make_photo(owner=local_user())
        job = ProcessingJob.objects.create(photo=photo)
        image = make_image(job)
        other = self.rows[self.first.pk]
        with local_single_mode():
            client = APIClient()
            for resource, row in (("photos", photo), ("jobs", job), ("receipt-images", image)):
                with self.subTest(resource=resource):
                    base = f"/api/recognition/{resource}/"
                    self.assertEqual(ids(client.get(base)), [row.pk])
                    self.assert_same_as_missing(client.get(f"{base}{other[resource].pk}/"),
                                                client.get(f"{base}{MISSING}/"))
            for action in ("cancel", "retry"):
                with self.subTest(action=action):
                    self.assert_same_as_missing(
                        client.post(f"/api/recognition/jobs/{other['jobs'].pk}/{action}/", {}, format="json"),
                        client.post(f"/api/recognition/jobs/{MISSING}/{action}/", {}, format="json"))
            self.assertEqual(count(client.get(f"/api/recognition/jobs/?photo={other['photos'].pk}")), 0)
            uploaded = client.post("/api/recognition/photos/", {"file": upload()}, format="multipart")
            self.assertEqual(uploaded.status_code, 202, uploaded.content)
            self.assertEqual(SourcePhoto.objects.get(pk=uploaded.json()["photo"]["id"]).owner.username, LOCAL_USERNAME)
        self.assertEqual(job_state(other["jobs"])[0], "queued")


@tag("integration")
@accounts_mode()
class ReviewOwnerTests(IsolationMixin, TestCase):
    """``POST …/receipt-images/{id}/confirm/``: подтверждает только владелец вырезки."""

    def setUp(self):
        self.temporary_media()

    def url(self, pk):
        return f"/api/recognition/receipt-images/{pk}/confirm/"

    def post(self, account, pk, body):
        return self.client_of(account, csrf=True).post(self.url(pk), body, format="json")

    def test_foreign_crop_answers_as_missing_for_any_body_and_saves_nothing(self):
        image = review_image_of(self.second)
        before, counts = image_state(image), domain_counts()
        bodies = {"valid": fixed_body(), "bad value": fixed_body(total=1)}
        for account in (self.first, self.moderator):
            for name, body in bodies.items():
                with self.subTest(account=account.username, body=name):
                    self.assert_same_as_missing(self.post(account, image.pk, body), self.post(account, MISSING, body))
            with self.subTest(account=account.username, body="unknown structure"):
                wrong, missing = (self.post(account, pk, {"unknown": 1}) for pk in (image.pk, MISSING))
                self.assertEqual(wrong.status_code, 400, wrong.content)
                self.assertEqual((wrong.status_code, wrong.content), (missing.status_code, missing.content))
        self.assertEqual((image_state(image), domain_counts()), (before, counts))

    def test_csrf_is_checked_before_the_owner(self):
        image = review_image_of(self.second)
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.first)
        for pk in (image.pk, MISSING):
            with self.subTest(pk=pk):
                response = client.post(self.url(pk), fixed_body(), format="json")
                self.assertEqual((response.status_code, response.json()), (403, CSRF_FAILED))

    def test_owner_confirms_and_the_receipt_is_the_owners(self):
        image = review_image_of(self.second)
        response = self.post(self.second, image.pk, fixed_body())
        self.assertEqual(response.status_code, 200, response.content)
        value = response.json()
        receipt = Receipt.objects.get()
        self.assertEqual(receipt.owner_id, self.second.pk)
        self.assertEqual((value["image"]["id"], value["image"]["status"], value["image"]["receipt_id"]),
                         (image.pk, "imported", receipt.pk))
        self.assertEqual((value["job"]["id"], value["job"]["items"][0]["receipt_id"]), (image.job_id, receipt.pk))
        self.assertEqual(ids(self.client_of(self.second).get("/api/receipts/")), [receipt.pk])
        self.assertEqual(count(self.client_of(self.first).get("/api/receipts/")), 0)
        self.assert_same_as_missing(self.client_of(self.first).get(f"/api/receipts/{receipt.pk}/"),
                                    self.client_of(self.first).get(f"/api/receipts/{MISSING}/"))

        # Повтор тем же телом: владельцу — текущее состояние, чужому — по-прежнему 404.
        state, counts = image_state(image), domain_counts()
        for account in (self.first, self.moderator):
            with self.subTest(replay=account.username):
                self.assert_same_as_missing(self.post(account, image.pk, fixed_body()),
                                            self.post(account, MISSING, fixed_body()))
        replay = self.post(self.second, image.pk, fixed_body())
        self.assertEqual(replay.status_code, 200, replay.content)
        self.assertEqual(replay.json()["image"]["receipt_id"], receipt.pk)
        self.assertEqual((image_state(image), domain_counts()), (state, counts))

    def test_same_receipt_confirmed_by_two_users_is_two_receipts(self):
        first, second = review_image_of(self.first), review_image_of(self.second)
        for account, image in ((self.first, first), (self.second, second)):
            response = self.post(account, image.pk, fixed_body())
            self.assertEqual(response.status_code, 200, response.content)
            self.assertEqual(response.json()["image"]["status"], "imported")
        receipts = dict(Receipt.objects.values_list("owner_id", "pk"))
        self.assertEqual(set(receipts), {self.first.pk, self.second.pk})
        self.assertEqual(ReceiptImage.objects.get(pk=first.pk).receipt_id, receipts[self.first.pk])
        self.assertEqual(ReceiptImage.objects.get(pk=second.pk).receipt_id, receipts[self.second.pk])
        for account in (self.first, self.second):
            with self.subTest(account=account.username):
                self.assertEqual(ids(self.client_of(account).get("/api/receipts/")), [receipts[account.pk]])

    def test_local_single_confirms_only_crops_of_local(self):
        other = review_image_of(self.first)
        own = review_image_of(local_user())
        before, counts = image_state(other), domain_counts()
        with local_single_mode():
            client = APIClient()
            self.assert_same_as_missing(client.post(self.url(other.pk), fixed_body(), format="json"),
                                        client.post(self.url(MISSING), fixed_body(), format="json"))
            self.assertEqual((image_state(other), domain_counts()), (before, counts))
            response = client.post(self.url(own.pk), fixed_body(), format="json")
            self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(Receipt.objects.get().owner.username, LOCAL_USERNAME)


@tag("integration")
@accounts_mode()
class StatsIsolationTests(IsolationMixin, TestCase):
    """Первый: EUR 4.00 в 2020 и 10.00 в 2026. Второй: EUR 2.00 и 7.00, ещё KZT 500.00 в 2026."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.lidl, cls.dns, cls.product = samples.lidl_store(), samples.dns_store(), milk()
        purchase(cls.first, cls.lidl, "EUR", date(2020, 1, 6), "4.00", cls.product)
        purchase(cls.first, cls.lidl, "EUR", date(2026, 3, 5), "10.00", cls.product)
        purchase(cls.second, cls.lidl, "EUR", date(2020, 1, 7), "2.00", cls.product)
        purchase(cls.second, cls.lidl, "EUR", date(2026, 3, 6), "7.00", cls.product)
        purchase(cls.second, cls.dns, "KZT", date(2026, 3, 7), "500.00", cls.product)

    def get(self, account, url, query=""):
        response = self.client_of(account).get(f"{url}?{query}")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def block(self, account, url, query="", currency="EUR"):
        return next(item for item in self.get(account, url, query)["currencies"] if item["currency"] == currency)

    def currencies(self, account, url, query=""):
        return [item["currency"] for item in self.get(account, url, query)["currencies"]]

    def test_spending_totals_are_per_user(self):
        for account, receipts, total in ((self.first, 2, "14.00"), (self.second, 2, "9.00")):
            with self.subTest(account=account.username):
                totals = self.block(account, SPENDING)["totals"]
                self.assertEqual((totals["receipts_count"], totals["receipts_total"], totals["lines_paid"]),
                                 (receipts, total, total))
                items = self.block(account, SPENDING, "group_by=product")["items"]
                item, = (item for item in items if item["kind"] == "product")
                self.assertEqual((item["id"], item["amount"], item["lines_count"], item["receipts_count"]),
                                 (self.product.pk, total, 2, 2))
        self.assertEqual(self.currencies(self.first, SPENDING), ["EUR"])
        self.assertEqual(self.currencies(self.second, SPENDING), ["EUR", "KZT"])
        self.assertEqual(self.block(self.second, SPENDING, currency="KZT")["totals"]["receipts_total"], "500.00")
        march = "date_from=2026-03-01&date_to=2026-03-31"
        self.assertEqual(self.block(self.first, SPENDING, march)["totals"]["receipts_total"], "10.00")
        self.assertEqual(self.block(self.second, SPENDING, march)["totals"]["receipts_total"], "7.00")

    def test_spending_by_store_lists_only_stores_of_own_receipts(self):
        def stores(account):
            found = self.get(account, SPENDING, "group_by=store")["currencies"]
            return {item["id"] for block in found for item in block["items"]}

        self.assertEqual(stores(self.first), {self.lidl.pk})
        self.assertEqual(stores(self.second), {self.lidl.pk, self.dns.pk})

    def test_shared_store_without_own_receipts_is_empty_not_an_error(self):
        # Магазин — общий справочник: фильтр по нему допустим, чужих чеков он не открывает.
        for url, query in ((SPENDING, ""), (SERIES, ""), (COMPARE, PERIODS)):
            with self.subTest(url=url):
                self.assertEqual(self.get(self.first, url, f"{query}&store={self.dns.pk}")["currencies"], [])
                self.assertEqual(self.currencies(self.first, url, f"{query}&currency=KZT"), [])
                self.assertEqual(self.currencies(self.first, url, f"{query}&country=KZ"), [])
        self.assertEqual(self.currencies(self.second, SPENDING, f"store={self.dns.pk}"), ["KZT"])

    def test_series_buckets_are_per_user(self):
        for account, totals in ((self.first, ["4.00", "10.00"]), (self.second, ["2.00", "7.00"])):
            with self.subTest(account=account.username):
                buckets = self.block(account, SERIES, "interval=year")["buckets"]
                visited = [bucket for bucket in buckets if bucket["receipts_count"]]
                self.assertEqual([bucket["total"] for bucket in visited], totals)
                self.assertEqual([bucket["receipts_count"] for bucket in visited], [1, 1])
        self.assertEqual(self.currencies(self.first, SERIES), ["EUR"])
        self.assertEqual(self.currencies(self.second, SERIES), ["EUR", "KZT"])

    def test_compare_sides_and_products_are_per_user(self):
        for account, base, current in ((self.first, "4.00", "10.00"), (self.second, "2.00", "7.00")):
            with self.subTest(account=account.username):
                block = self.block(account, COMPARE, PERIODS)
                self.assertEqual((block["base"]["receipts_count"], block["base"]["total"]), (1, base))
                self.assertEqual((block["current"]["receipts_count"], block["current"]["total"]), (1, current))
                pair, = block["products"]
                self.assertEqual((pair["product"]["id"], pair["base"]["amount"], pair["current"]["amount"]),
                                 (self.product.pk, base, current))
                self.assertEqual(block["products_total"], 1)
        self.assertEqual(self.currencies(self.first, COMPARE, PERIODS), ["EUR"])

    def test_user_without_receipts_gets_empty_statistics(self):
        for url, query in ((SPENDING, ""), (SPENDING, "group_by=store"), (SERIES, ""), (COMPARE, PERIODS)):
            with self.subTest(url=url, query=query):
                self.assertEqual(self.get(self.moderator, url, query)["currencies"], [])

    def test_local_single_counts_only_receipts_of_local(self):
        purchase(local_user(), self.lidl, "EUR", date(2026, 3, 8), "1.00", self.product)
        with local_single_mode():
            client = APIClient()
            spending, = client.get(SPENDING).json()["currencies"]
            self.assertEqual((spending["currency"], spending["totals"]["receipts_count"],
                              spending["totals"]["receipts_total"]), ("EUR", 1, "1.00"))
            series, = client.get(f"{SERIES}?interval=year").json()["currencies"]
            self.assertEqual([bucket["total"] for bucket in series["buckets"] if bucket["receipts_count"]], ["1.00"])
            compare, = client.get(f"{COMPARE}?{PERIODS}").json()["currencies"]
            self.assertEqual((compare["base"]["receipts_count"], compare["current"]["total"]), (0, "1.00"))


@tag("integration")
class QueryCountTests(IsolationMixin, TestCase):
    """Число запросов не растёт от чужих данных и размера страницы.

    ``local_single``: прежние числа — владелец проверяется соединением с пользователем
    ``local``, отдельного запроса за ним нет. ``accounts``: на два запроса больше на
    каждом маршруте — сессия и пользователь.
    """

    SESSION_AND_USER = 2

    def build(self, owner, other):
        store, product = samples.lidl_store(), milk()
        rate = TaxRate.objects.get(country_id="DE", rate="7.00")
        found = None
        for account in (owner, other):
            for number in range(5):
                on = date(2020, 1, 6 + number) if number < 2 else date(2026, 3, 1 + number)
                receipt = purchase(account, store, "EUR", on, "2.00", product)
                line = receipt.lines.get()
                ReceiptDiscount.objects.create(receipt=receipt, line=line, position=1, name="Rabatt", amount="0.10")
                ReceiptTax.objects.create(receipt=receipt, tax_rate=rate, tax_code="A", net="1.00", tax="0.07",
                                          gross="1.07")
                job = ProcessingJob.objects.create(photo=make_photo(owner=account))
                image = make_image(job, status="imported", receipt=receipt)
                if account is owner and found is None:
                    found = {"receipt": receipt, "photo": job.photo, "job": job, "image": image}
        return found

    def measure(self, client, own, extra):
        receipt = f"/api/receipts/{own['receipt'].pk}/"
        # Путь, число запросов, число своих строк: чужие пять в счёт и на страницу не попадают.
        lists = (
            ("/api/receipts/", 2, 5), (receipt + "lines/", 3, 1), (receipt + "discounts/", 3, 1),
            (receipt + "taxes/", 3, 1), ("/api/recognition/photos/", 2, 5),
            ("/api/recognition/jobs/", 4, 5),  # count + page + executing lease + worker slot
            ("/api/recognition/receipt-images/", 2, 5),
        )
        for size in (1, 5):
            for path, queries, rows in lists:
                with self.subTest(path=path, size=size), self.assertNumQueries(queries + extra):
                    response = client.get(f"{path}?page_size={size}")
                self.assertEqual(response.status_code, 200, response.content)
                self.assertEqual(response.json()["count"], rows)
                self.assertEqual(len(response.json()["results"]), min(rows, size))
        details = (
            (receipt, 1), (f"/api/recognition/photos/{own['photo'].pk}/", 1),
            (f"/api/recognition/jobs/{own['job'].pk}/", 4),  # job + items + executor
            (f"/api/recognition/receipt-images/{own['image'].pk}/", 1),
            # spending: дерево категорий + три запроса расчёта; compare: расчёт + названия товаров.
            (SPENDING, 4), (f"{SPENDING}?group_by=product", 3), (SERIES, 3), (f"{COMPARE}?{PERIODS}", 3),
        )
        for path, queries in details:
            with self.subTest(path=path), self.assertNumQueries(queries + extra):
                response = client.get(path)
            self.assertEqual(response.status_code, 200, response.content)
        totals = client.get(SPENDING).json()["currencies"][0]["totals"]
        self.assertEqual((totals["receipts_count"], totals["receipts_total"]), (5, "10.00"))

    def test_local_single_keeps_the_former_counts(self):
        own = self.build(local_user(), self.second)
        with local_single_mode():
            self.measure(APIClient(), own, 0)

    @accounts_mode()
    def test_accounts_adds_the_session_and_the_user(self):
        own = self.build(self.first, self.second)
        self.measure(signed_in(self.first), own, self.SESSION_AND_USER)

    @accounts_mode()
    def test_foreign_and_missing_ids_cost_the_same(self):
        own = self.build(self.first, self.second)
        client = signed_in(self.second)
        paths = (("/api/receipts/{}/", "receipt"), ("/api/receipts/{}/lines/", "receipt"),
                 ("/api/recognition/photos/{}/", "photo"), ("/api/recognition/jobs/{}/", "job"),
                 ("/api/recognition/receipt-images/{}/", "image"))
        for template, key in paths:
            for pk in (own[key].pk, MISSING):
                with self.subTest(path=template, pk=pk), self.assertNumQueries(1 + self.SESSION_AND_USER):
                    self.assertEqual(client.get(template.format(pk)).status_code, 404)
