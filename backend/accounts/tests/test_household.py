"""Семья: члены видят чеки, фото, задания, вырезки и статистику друг друга.

Правило одно — ``accounts.access.owner_q``. В семье «Демо-семья» — ``first`` и ``third``;
``second`` вне семьи, у модератора семьи нет. ``owner`` значит «кто добавил»: новый чек
и фото пишутся на того, кто их добавил. Данные вымышленные, MEDIA временный, модель не
вызывается.
"""
from datetime import date

from django.contrib import admin
from django.db import IntegrityError, connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase, tag

from accounts.admin import HouseholdAdmin, MembershipInline
from accounts.models import Household, Membership
from api.tests.accounts_helpers import MISSING, accounts_mode, local_single_mode, make_user
from api.tests.factories import make_receipt
from api.tests.test_owner_isolation import SPENDING, IsolationMixin, count, finish, ids, milk, purchase
from receipts.models import Receipt
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line
from recognition.models import ProcessingJob
from recognition.tests.test_models import make_image, make_photo
from recognition.tests.test_owner_isolation import review_image_of
from recognition.tests.test_review import fixed_body

RECOGNITION = ("photos", "jobs", "receipt-images")


class FamilyMixin(IsolationMixin):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        cls.family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=cls.family)


@tag("integration")
class HouseholdModelTests(TestCase):
    def test_user_belongs_to_one_household_at_most(self):
        account = make_user("synthetic-member")
        Membership.objects.create(user=account, household=Household.objects.create(name="Первая"))
        with self.assertRaises(IntegrityError), transaction.atomic():
            Membership.objects.create(user=account, household=Household.objects.create(name="Вторая"))

    def test_admin_edits_households_with_members_inline(self):
        self.assertIsInstance(admin.site._registry[Household], HouseholdAdmin)
        self.assertEqual(HouseholdAdmin.inlines, (MembershipInline,))
        self.assertIs(MembershipInline.model, Membership)


@tag("integration")
class HouseholdMigrationTests(TransactionTestCase):
    """``accounts.0002_household_membership`` откатывается и применяется снова."""

    def tables(self):
        return set(connection.introspection.table_names())

    def migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate([target])

    def test_rollback_and_reapply(self):
        names = {"accounts_household", "accounts_membership"}
        self.assertLessEqual(names, self.tables())
        try:
            self.migrate(("accounts", "0001_initial"))
            self.assertFalse(names & self.tables())
            self.assertIn("accounts_loginfailure", self.tables())
        finally:
            self.migrate(("accounts", "0002_household_membership"))
        self.assertLessEqual(names, self.tables())


@tag("integration")
@accounts_mode()
class FamilyAccessTests(FamilyMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        store, product = samples.lidl_store(), milk()
        cls.rows = {}
        for account in (cls.first, cls.second, cls.third):
            receipt = purchase(account, store, "EUR", date(2026, 3, 5), "5.00", product)
            photo = make_photo(owner=account)
            job = ProcessingJob.objects.create(photo=photo, detected_count=1, completed_count=1, imported_count=1)
            image = make_image(job, status="imported", receipt=receipt, import_effect="created",
                               outcome_snapshot={"receipt_id": receipt.pk})
            cls.rows[account.pk] = {"photos": photo, "jobs": job, "receipt-images": image, "receipt": receipt}

    def setUp(self):
        self.temporary_media()

    def row_ids(self, name, *accounts):
        return sorted(self.rows[account.pk][name].pk for account in accounts)

    def test_members_see_rows_of_each_other(self):
        for account in (self.first, self.third):
            client = self.client_of(account)
            with self.subTest(account=account.username):
                self.assertEqual(sorted(ids(client.get("/api/receipts/"))),
                                 self.row_ids("receipt", self.first, self.third))
                for name in RECOGNITION:
                    self.assertEqual(sorted(ids(client.get(f"/api/recognition/{name}/"))),
                                     self.row_ids(name, self.first, self.third))
                for other in (self.first, self.third):
                    receipt = self.rows[other.pk]["receipt"]
                    response = client.get(f"/api/receipts/{receipt.pk}/")
                    self.assertEqual(response.status_code, 200, response.content)
                    self.assertEqual(response.json()["owner"], other.username)
                    for path in ("lines", "discounts", "taxes"):
                        self.assertEqual(client.get(f"/api/receipts/{receipt.pk}/{path}/").status_code, 200)
                    for name in RECOGNITION:
                        pk = self.rows[other.pk][name].pk
                        self.assertEqual(client.get(f"/api/recognition/{name}/{pk}/").status_code, 200)
                    job = client.get(f"/api/recognition/jobs/{self.rows[other.pk]['jobs'].pk}/").json()
                    self.assertEqual(job["owner"], other.username)

    def test_receipt_list_items_name_who_added_them(self):
        page = self.client_of(self.first).get("/api/receipts/").json()
        owners = {item["id"]: item["owner"] for item in page["results"]}
        self.assertEqual(owners, {self.rows[self.first.pk]["receipt"].pk: self.first.username,
                                  self.rows[self.third.pk]["receipt"].pk: self.third.username})
        jobs = self.client_of(self.first).get("/api/recognition/jobs/").json()["results"]
        self.assertEqual({job["owner"] for job in jobs}, {self.first.username, self.third.username})

    def test_outsider_gets_404_and_sees_only_own(self):
        client = self.client_of(self.second)
        self.assertEqual(ids(client.get("/api/receipts/")), [self.rows[self.second.pk]["receipt"].pk])
        for name in RECOGNITION:
            self.assertEqual(ids(client.get(f"/api/recognition/{name}/")), self.row_ids(name, self.second))
        for member in (self.first, self.third):
            receipt = self.rows[member.pk]["receipt"]
            self.assert_same_as_missing(client.get(f"/api/receipts/{receipt.pk}/"),
                                        client.get(f"/api/receipts/{MISSING}/"))
            for name in RECOGNITION:
                pk = self.rows[member.pk][name].pk
                self.assert_same_as_missing(client.get(f"/api/recognition/{name}/{pk}/"),
                                            client.get(f"/api/recognition/{name}/{MISSING}/"))
        # Член семьи не видит строк того, кто вне семьи.
        foreign = self.rows[self.second.pk]["receipt"]
        member = self.client_of(self.first)
        self.assert_same_as_missing(member.get(f"/api/receipts/{foreign.pk}/"),
                                    member.get(f"/api/receipts/{MISSING}/"))

    def test_user_without_household_sees_only_own(self):
        self.assertEqual(count(self.client_of(self.moderator).get("/api/receipts/")), 0)
        for name in RECOGNITION:
            self.assertEqual(count(self.client_of(self.moderator).get(f"/api/recognition/{name}/")), 0)

    def test_member_cancels_and_retries_a_job_of_another_member(self):
        client = self.client_of(self.first, csrf=True)
        queued = self.rows[self.third.pk]["jobs"]
        cancelled = client.post(f"/api/recognition/jobs/{queued.pk}/cancel/", {}, format="json")
        self.assertEqual((cancelled.status_code, cancelled.json()["status"]), (200, "cancelled"))
        retry = client.post(f"/api/recognition/jobs/{queued.pk}/retry/", {}, format="json")
        self.assertEqual(retry.status_code, 202, retry.content)
        self.assertEqual((retry.json()["retry_of"], retry.json()["owner"]), (queued.pk, self.third.username))
        outsider = self.client_of(self.second, csrf=True)
        failed = finish(self.rows[self.first.pk]["jobs"])
        self.assert_same_as_missing(outsider.post(f"/api/recognition/jobs/{failed.pk}/retry/", {}, format="json"),
                                    outsider.post(f"/api/recognition/jobs/{MISSING}/retry/", {}, format="json"))

    def test_spending_counts_receipts_of_the_whole_family(self):
        def totals(account):
            response = self.client_of(account).get(SPENDING)
            self.assertEqual(response.status_code, 200, response.content)
            block, = response.json()["currencies"]
            return block["totals"]["receipts_count"], block["totals"]["receipts_total"]

        self.assertEqual(totals(self.first), (2, "10.00"))
        self.assertEqual(totals(self.third), (2, "10.00"))
        self.assertEqual(totals(self.second), (1, "5.00"))


@tag("integration")
@accounts_mode()
class FamilyReviewTests(FamilyMixin, TestCase):
    def setUp(self):
        self.temporary_media()

    def test_member_confirms_a_crop_uploaded_by_another_member(self):
        image = review_image_of(self.third)
        url = f"/api/recognition/receipt-images/{image.pk}/confirm/"
        outsider = self.client_of(self.second, csrf=True)
        self.assert_same_as_missing(outsider.post(url, fixed_body(), format="json"),
                                    outsider.post(f"/api/recognition/receipt-images/{MISSING}/confirm/",
                                                  fixed_body(), format="json"))
        response = self.client_of(self.first, csrf=True).post(url, fixed_body(), format="json")
        self.assertEqual(response.status_code, 200, response.content)
        receipt = Receipt.objects.get()
        # Чек принадлежит тому, кто загрузил фото, и виден всей семье.
        self.assertEqual(receipt.owner_id, self.third.pk)
        for account in (self.first, self.third):
            self.assertEqual(ids(self.client_of(account).get("/api/receipts/")), [receipt.pk])
        self.assertEqual(count(self.client_of(self.second).get("/api/receipts/")), 0)


@tag("integration")
@accounts_mode()
class FamilyProjectionTests(FamilyMixin, TestCase):
    """«Своё» в общих данных — и строки членов семьи."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.store, cls.product = samples.lidl_store(), milk()
        receipt = make_receipt(cls.store, "EUR", date(2026, 6, 9), owner=cls.third)
        make_line(receipt, product=cls.product, unit_price="1.05", amount="1.05")
        cls.receipt = receipt

    def get(self, account, url):
        response = self.client_of(account).get(url)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_price_point_of_a_member_is_own(self):
        url = f"/api/products/{self.product.pk}/prices/"
        point, = self.get(self.first, url)["results"]
        self.assertEqual((point["own"], point["receipt_id"]), (True, self.receipt.pk))
        point, = self.get(self.second, url)["results"]
        self.assertEqual((point["own"], point["receipt_id"]), (False, None))

    def test_store_count_and_last_observation_count_the_family(self):
        stores = {item["id"]: item["receipts_count"] for item in self.get(self.first, "/api/stores/")["results"]}
        self.assertEqual(stores[self.store.pk], 1)
        stores = {item["id"]: item["receipts_count"] for item in self.get(self.second, "/api/stores/")["results"]}
        self.assertEqual(stores[self.store.pk], 0)
        self.assertIsNotNone(self.get(self.first, f"/api/products/{self.product.pk}/")["last_observed_at"])
        self.assertIsNone(self.get(self.second, f"/api/products/{self.product.pk}/")["last_observed_at"])


@tag("integration")
class FamilyMeTests(FamilyMixin, TestCase):
    @accounts_mode()
    def test_me_names_the_household_and_its_members(self):
        body = self.client_of(self.third).get("/api/me/").json()
        self.assertEqual(body["household"], {
            "id": self.family.pk, "name": "Демо-семья",
            "members": sorted([self.first.username, self.third.username]),
        })
        self.assertIsNone(self.client_of(self.second).get("/api/me/").json()["household"])

    @local_single_mode()
    def test_local_single_has_no_household(self):
        Membership.objects.create(user=local_user(), household=self.family)
        self.assertIsNone(self.client.get("/api/me/").json()["household"])
