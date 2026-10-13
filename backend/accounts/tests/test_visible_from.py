"""«Видит траты семьи с»: главный задаёт члену семьи месяц, раньше него чужие траты семьи не видны нигде.

Правило одно — ``accounts.access.owner_q`` (``since``): чеки — по дате покупки, фото, задания, вырезки и
MEDIA — по дню загрузки, доходы семьи — по дню получения; свои строки член семьи видит всегда, главный —
всё. В семье «Демо-семья» ``first`` — главный, ``third`` — член семьи с ограничением с апреля 2026;
``second`` вне семьи. Данные вымышленные, MEDIA временный, модель не вызывается.
"""
import json
import uuid
from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal
from pathlib import Path

from django.conf import settings
from django.test import TestCase, tag

from accounts.models import Household, Membership
from api.tests.accounts_helpers import MISSING, accounts_mode, make_user
from api.tests.test_owner_isolation import IsolationMixin, ids, milk, purchase
from budget.dashboard import Month
from incomes.models import Income, IncomeCategory
from insights import context
from receipts.models import Receipt
from receipts.tests import samples
from recognition.models import ProcessingJob, SourcePhoto
from recognition.tests.test_models import make_image, make_photo

APRIL = date(2026, 4, 1)
MARCH, MAY = date(2026, 3, 5), date(2026, 5, 6)


@tag("integration")
@accounts_mode()
class VisibleFromTests(IsolationMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        cls.family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=cls.first, household=cls.family, role=Membership.Role.HEAD)
        cls.membership = Membership.objects.create(user=cls.third, household=cls.family, visible_from=APRIL)
        cls.store, cls.product = store, product = samples.lidl_store(), milk()
        cls.head_march = purchase(cls.first, store, "KZT", MARCH, "500.00", product)
        cls.head_may = purchase(cls.first, store, "KZT", MAY, "700.00", product)
        cls.own_march = purchase(cls.third, store, "KZT", MARCH, "300.00", product)
        category = IncomeCategory.objects.create(name="Демо-доход")
        for owner, on, amount in ((cls.first, MARCH, "1000.00"), (cls.third, MARCH, "50.00"), (cls.first, MAY, "2000.00")):
            Income.objects.create(owner=owner, received_on=on, amount=Decimal(amount), currency_id="KZT", category=category)

    def setUp(self):
        self.temporary_media()

    def get(self, account, url):
        response = self.client_of(account).get(url)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def call(self, account, method, url, body=None):
        client = self.client_of(account, csrf=True)
        return getattr(client, method)(url, "" if body is None else json.dumps(body), content_type="application/json")

    def test_receipts_list_and_detail(self):
        self.assertEqual(sorted(ids(self.client_of(self.third).get("/api/receipts/"))),
                         sorted([self.own_march.pk, self.head_may.pk]))
        self.assertEqual(sorted(ids(self.client_of(self.first).get("/api/receipts/"))),
                         sorted([self.head_march.pk, self.head_may.pk, self.own_march.pk]))
        client = self.client_of(self.third)
        self.assert_same_as_missing(client.get(f"/api/receipts/{self.head_march.pk}/"),
                                    client.get(f"/api/receipts/{MISSING}/"))
        for receipt in (self.own_march, self.head_may):
            self.assertEqual(client.get(f"/api/receipts/{receipt.pk}/").status_code, 200)
        self.assertEqual(self.client_of(self.first).get(f"/api/receipts/{self.own_march.pk}/").status_code, 200)

    def test_without_visible_from_member_sees_everything(self):
        Membership.objects.filter(pk=self.membership.pk).update(visible_from=None)
        self.assertEqual(len(ids(self.client_of(self.third).get("/api/receipts/"))), 3)

    def test_dashboard_stats_and_trends_of_a_month_before(self):
        def march(account):
            dashboard = self.get(account, "/api/dashboard/?month=2026-03")
            block, = dashboard["currencies"]
            spending, = self.get(account, "/api/stats/spending/?date_from=2026-03-01&date_to=2026-03-31")["currencies"]
            trends, = self.get(account, "/api/stats/trends/monthly/?from=2026-03&to=2026-05")["currencies"]
            return (block["spent"], sorted(item["id"] for item in dashboard["recent"]),
                    spending["totals"]["receipts_total"], [month["total"] for month in trends["months"]])

        self.assertEqual(march(self.third), ("300.00", sorted([self.own_march.pk, self.head_may.pk]),
                                             "300.00", ["300.00", "0.00", "700.00"]))
        self.assertEqual(march(self.first), ("800.00", sorted([self.head_march.pk, self.head_may.pk, self.own_march.pk]),
                                             "800.00", ["800.00", "0.00", "700.00"]))

    def test_export_and_ai_summary(self):
        exported = self.get(self.third, "/api/export/?include=receipts")["receipts"]
        self.assertEqual(sorted(item["id"] for item in exported), sorted([self.own_march.pk, self.head_may.pk]))
        self.assertEqual(len(self.get(self.first, "/api/export/?include=receipts")["receipts"]), 3)
        summary = context.build(self.third, Month(2026, 5), today=date(2026, 5, 20))
        self.assertEqual(summary["totals"][-3:], ["300.00", "0.00", "700.00"])
        self.assertEqual(context.build(self.first, Month(2026, 5), today=date(2026, 5, 20))["totals"][-3:],
                         ["800.00", "0.00", "700.00"])

    def test_family_income_before_the_month_is_own_only(self):
        self.assertEqual(self.get(self.third, "/api/incomes/?month=2026-03")["family_total"], "50.00")
        self.assertEqual(self.get(self.third, "/api/incomes/?month=2026-05")["family_total"], "2000.00")
        self.assertEqual(self.get(self.first, "/api/incomes/?month=2026-03")["family_total"], "1050.00")

    def test_photos_jobs_crops_and_media_follow_upload_day_and_their_receipt(self):
        """Фото без чека — по дню загрузки; фото с вырезкой невидимого запросу чека не видно вместе с заданием,
        вырезками и MEDIA — и автору, если чек скрыл главный; главный видит всё."""
        root = Path(settings.MEDIA_ROOT)  # временный каталог temporary_media()
        hidden_head = purchase(self.first, self.store, "KZT", MAY, "100.00", self.product)
        hidden_own = purchase(self.third, self.store, "KZT", MAY, "200.00", self.product)
        Receipt.objects.filter(pk__in=[hidden_head.pk, hidden_own.pk]).update(hidden=True)
        rows = {}
        for key, owner, uploaded, receipt in (
            ("head_march", self.first, MARCH, None), ("head_may", self.first, MAY, None),
            ("own_march", self.third, MARCH, None),
            # Куплен раньше visible_from, сфотографирован позже; скрытые главным — чужой и свой.
            ("old_receipt", self.first, MAY, self.head_march), ("hidden_head", self.first, MAY, hidden_head),
            ("hidden_own", self.third, MAY, hidden_own),
        ):
            storage = uuid.uuid4()
            original = f"originals/{storage}/source.png"
            (root / original).parent.mkdir(parents=True)
            (root / original).write_bytes(b"\x89PNG synthetic")
            photo = make_photo(owner, storage_uuid=storage, original_file=original)
            SourcePhoto.objects.filter(pk=photo.pk).update(
                created_at=datetime.combine(uploaded, datetime.min.time(), tzinfo=dt_timezone.utc))
            job = ProcessingJob.objects.create(photo=photo)
            image = make_image(job) if receipt is None else make_image(
                job, status="imported", receipt=receipt, import_effect="created", outcome_snapshot={"receipt_id": receipt.pk})
            rows[key] = {"photos": photo.pk, "jobs": job.pk, "receipt-images": image.pk, "file": original}
        unseen = ("head_march", "old_receipt", "hidden_head", "hidden_own")
        for name in ("photos", "jobs", "receipt-images"):
            with self.subTest(name=name):
                self.assertEqual(sorted(ids(self.client_of(self.third).get(f"/api/recognition/{name}/"))),
                                 sorted([rows["own_march"][name], rows["head_may"][name]]))
                self.assertEqual(sorted(ids(self.client_of(self.first).get(f"/api/recognition/{name}/"))),
                                 sorted(row[name] for row in rows.values()))
                for key in unseen:
                    response = self.client_of(self.third).get(f"/api/recognition/{name}/{rows[key][name]}/")
                    self.assertEqual(response.status_code, 404, key)
                    self.assertEqual(self.client_of(self.first).get(f"/api/recognition/{name}/{rows[key][name]}/").status_code, 200)
        cancel = self.call(self.third, "post", f"/api/recognition/jobs/{rows['hidden_head']['jobs']}/cancel/", {})
        self.assertEqual(cancel.status_code, 404, cancel.content)
        for key in rows:
            for account, status in ((self.third, 404 if key in unseen else 200), (self.first, 200)):
                with self.subTest(media=key, account=account.username):
                    response = self.client_of(account).get(f"/media/{rows[key]['file']}")
                    self.assertEqual(response.status_code, status)
                    if response.streaming:
                        b"".join(response.streaming_content)

    def test_head_sets_the_month_member_never_sees_it(self):
        url = f"/api/family/members/{self.third.username}/"
        members = {row["username"]: row for row in self.get(self.first, "/api/family/")["household"]["members"]}
        self.assertEqual((members[self.third.username]["visible_from"], members[self.first.username]["visible_from"]),
                         ("2026-04", None))
        # Член семьи своего ограничения не получает ни в «Семье», ни в «Я».
        for path in ("/api/family/", "/api/me/"):
            self.assertNotIn("visible_from", self.client_of(self.third).get(path).content.decode())
        response = self.call(self.first, "patch", url, {"visible_from": "2026-09"})
        self.assertEqual(response.status_code, 200, response.content)
        member, = [row for row in response.json()["household"]["members"] if row["username"] == self.third.username]
        self.assertEqual(member["visible_from"], "2026-09")
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.visible_from, date(2026, 9, 1))
        self.assertEqual(self.call(self.first, "patch", url, {"visible_from": None}).status_code, 200)
        self.membership.refresh_from_db()
        self.assertIsNone(self.membership.visible_from)

    def test_patch_refusals(self):
        url = f"/api/family/members/{self.third.username}/"
        refused = self.call(self.third, "patch", url, {"visible_from": None})
        self.assertEqual((refused.status_code, refused.json()["error"]["code"]), (403, "head_only"))
        outsider = self.call(self.second, "patch", url, {"visible_from": None})
        self.assertEqual(outsider.status_code, 404)
        for body in ({}, {"visible_from": "2026-13"}, {"visible_from": "2026-4"}, {"visible_from": 202604},
                     {"visible_from": "2026-04-01"}, {"visible_from": None, "role": "head"}):
            with self.subTest(body=body):
                response = self.call(self.first, "patch", url, body)
                self.assertEqual(response.status_code, 400, response.content)
        own = self.call(self.first, "patch", f"/api/family/members/{self.first.username}/", {"visible_from": "2026-04"})
        self.assertEqual((own.status_code, list(own.json()["error"]["fields"])), (400, ["visible_from"]))
        missing = self.call(self.first, "patch", "/api/family/members/synthetic-nobody/", {"visible_from": None})
        self.assertEqual(missing.status_code, 404)
        self.membership.refresh_from_db()
        self.assertEqual(self.membership.visible_from, APRIL)

    def test_new_head_loses_the_restriction(self):
        response = self.call(self.first, "post", "/api/family/head/", {"username": self.third.username})
        self.assertEqual(response.status_code, 200, response.content)
        self.membership.refresh_from_db()
        self.assertEqual((self.membership.role, self.membership.visible_from), ("head", None))
        self.assertEqual(len(ids(self.client_of(self.third).get("/api/receipts/"))), 3)
