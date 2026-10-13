"""Настройки профиля (основная валюта) и скрытые платежи главного в семье.

В семье «Демо-семья» ``first`` — главный, ``third`` — член; ``second`` вне семьи (сам себе
главный). Скрытый платёж пропадает у членов семьи везде и не входит ни в какие суммы,
в том числе у главного; главный видит его в списке только с ``?hidden=1``. Данные
вымышленные, модель не вызывается.
"""
import json
from datetime import date

from django.db import IntegrityError, transaction
from django.test import TestCase, tag

from accounts import profile
from accounts.models import Household, Membership, Profile
from api.tests.accounts_helpers import accounts_mode, local_single_mode, make_user
from api.tests.test_owner_isolation import IsolationMixin, milk, purchase
from receipts import manual
from receipts.models import Receipt
from receipts.ownership import local_user
from receipts.tests import samples

HIDDEN_MARK = "SYNTH HIDDEN PAYMENT"
VISIBLE_MARK = "SYNTH VISIBLE PAYMENT"


class HeadFamilyMixin(IsolationMixin):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        cls.family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=cls.first, household=cls.family, role=Membership.Role.HEAD)
        Membership.objects.create(user=cls.third, household=cls.family)
        store, cls.product = samples.lidl_store(), milk()
        cls.visible = purchase(cls.third, store, "EUR", date(2026, 3, 5), "5.00", cls.product, raw_name=VISIBLE_MARK)
        cls.secret = purchase(cls.third, store, "EUR", date(2026, 3, 6), "7.00", cls.product, raw_name=HIDDEN_MARK)
        cls.secret.note = HIDDEN_MARK
        cls.secret.save(update_fields=["note"])

    def setUp(self):
        self.temporary_media()

    def hide(self, account, receipt, action="hide"):
        return self.client_of(account, csrf=True).post(f"/api/receipts/{receipt.pk}/{action}/", {}, format="json")


@tag("integration")
class HeadConstraintTests(TestCase):
    def test_one_head_per_household(self):
        family = Household.objects.create(name="Семья")
        Membership.objects.create(user=make_user("synthetic-a"), household=family, role=Membership.Role.HEAD)
        Membership.objects.create(user=make_user("synthetic-b"), household=family)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Membership.objects.create(user=make_user("synthetic-c"), household=family, role=Membership.Role.HEAD)
        other = Household.objects.create(name="Другая")
        Membership.objects.create(user=make_user("synthetic-d"), household=other, role=Membership.Role.HEAD)

    def test_new_membership_is_member(self):
        row = Membership.objects.create(user=make_user("synthetic-e"), household=Household.objects.create(name="С"))
        self.assertEqual(row.role, "member")


@tag("integration")
@accounts_mode()
class HideTests(HeadFamilyMixin, TestCase):
    def test_only_head_hides_and_unhides(self):
        refused = self.hide(self.third, self.visible)
        self.assertEqual(refused.status_code, 403, refused.content)
        self.assertEqual(refused.json()["error"]["code"], "head_only")
        outsider = self.hide(self.second, self.visible)
        self.assertEqual(outsider.status_code, 404)

        done = self.hide(self.first, self.secret)
        self.assertEqual(done.status_code, 200, done.content)
        self.assertTrue(done.json()["hidden"])
        self.secret.refresh_from_db()
        self.assertEqual((self.secret.hidden, self.secret.hidden_by_id), (True, self.first.pk))
        self.assertIsNotNone(self.secret.hidden_at)
        # Повтор безопасен; член семьи скрытый платёж не находит вовсе.
        self.assertEqual(self.hide(self.first, self.secret).status_code, 200)
        self.assertEqual(self.hide(self.third, self.secret, "unhide").status_code, 404)

        shown = self.hide(self.first, self.secret, "unhide")
        self.assertEqual(shown.status_code, 200, shown.content)
        self.assertFalse(shown.json()["hidden"])
        self.secret.refresh_from_db()
        self.assertEqual((self.secret.hidden, self.secret.hidden_by_id, self.secret.hidden_at), (False, None, None))

    def test_user_without_household_hides_own(self):
        own = purchase(self.second, samples.lidl_store(), "EUR", date(2026, 3, 7), "3.00", self.product)
        self.assertEqual(self.hide(self.second, own).status_code, 200)
        self.assertTrue(self.client_of(self.second).get("/api/me/").json()["is_head"])

    def test_me_names_the_head(self):
        member = self.client_of(self.third).get("/api/me/").json()
        self.assertEqual((member["is_head"], member["household"]["head"]), (False, self.first.username))
        self.assertTrue(self.client_of(self.first).get("/api/me/").json()["is_head"])

    @local_single_mode()
    def test_local_single_user_is_head(self):
        self.assertTrue(self.client.get("/api/me/").json()["is_head"])


@tag("integration")
@accounts_mode()
class HiddenEverywhereTests(HeadFamilyMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        Receipt.objects.filter(pk=cls.secret.pk).update(hidden=True)

    READS = (
        "/api/receipts/",
        "/api/receipts/?hidden=1",
        "/api/dashboard/?month=2026-03",
        "/api/stats/spending/",
        "/api/stats/receipts/series/",
        "/api/stats/receipts/compare/?base_from=2026-02-01&base_to=2026-02-28&current_from=2026-03-01&current_to=2026-03-31",
        "/api/stats/trends/monthly/?month=2026-03",
        "/api/stats/trends/prices/?month=2026-03",
        "/api/stats/trends/range/",
        "/api/stats/trends/monthly/?from=2026-01&to=2026-03",
        "/api/stats/trends/prices/?from=2026-01&to=2026-03",
        "/api/export/?include=receipts,lines,media,stores,summary",
        "/api/export/",
        "/api/receipts/manual/",
        "/api/stores/",
    )

    def bodies(self, account):
        client = self.client_of(account)
        urls = list(self.READS) + [
            f"/api/stats/category-spends/?month=2026-03&category={self.product.generic.category_id}",
            f"/api/stats/trends/category/?month=2026-03&category={self.product.generic.category_id}",
            f"/api/stats/trends/category/?from=2026-01&to=2026-03&category={self.product.generic.category_id}",
            f"/api/products/{self.product.pk}/prices/",
            f"/api/products/{self.product.pk}/",
        ]
        for url in urls:
            response = client.get(url)
            with self.subTest(account=account.username, url=url):
                self.assertEqual(response.status_code, 200, response.content[:300])
            yield url, response

    def test_member_sees_hidden_nowhere(self):
        for url, response in self.bodies(self.third):
            with self.subTest(url=url):
                self.assertNotIn(HIDDEN_MARK, response.content.decode())
                self.assertNotIn("12.00", response.content.decode())
        client = self.client_of(self.third)
        # Контроль: видимый платёж с тем же товаром в выгрузке есть.
        self.assertIn(VISIBLE_MARK, client.get("/api/export/").content.decode())
        for path in ("", "lines/", "discounts/", "taxes/"):
            self.assertEqual(client.get(f"/api/receipts/{self.secret.pk}/{path}").status_code, 404)
        # Границы данных трендов — только по видимым платежам (скрытый — 6 марта).
        self.assertNotIn("2026-03-06", client.get("/api/stats/trends/range/").content.decode())
        listed = client.get("/api/receipts/?hidden=1").json()["results"]
        self.assertEqual([item["id"] for item in listed], [self.visible.pk])

    def test_head_totals_exclude_hidden(self):
        for url, response in self.bodies(self.first):
            if "hidden=1" in url:
                continue
            with self.subTest(url=url):
                self.assertNotIn(HIDDEN_MARK, response.content.decode())
                self.assertNotIn("12.00", response.content.decode())
        spending = self.client_of(self.first).get("/api/stats/spending/").json()
        block, = spending["currencies"]
        self.assertEqual((block["totals"]["receipts_count"], block["totals"]["receipts_total"]), (1, "5.00"))
        dashboard = self.client_of(self.first).get("/api/dashboard/?month=2026-03").json()
        self.assertEqual(dashboard["currencies"][0]["spent"], "5.00")

    def test_head_lists_hidden_only_with_filter(self):
        client = self.client_of(self.first)
        plain = client.get("/api/receipts/").json()["results"]
        self.assertEqual([item["id"] for item in plain], [self.visible.pk])
        listed = {item["id"]: item["hidden"] for item in client.get("/api/receipts/?hidden=1").json()["results"]}
        self.assertEqual(listed, {self.secret.pk: True, self.visible.pk: False})
        detail = client.get(f"/api/receipts/{self.secret.pk}/")
        self.assertEqual(detail.status_code, 200)
        self.assertTrue(detail.json()["hidden"])
        self.assertEqual(client.get("/api/receipts/?hidden=2").status_code, 400)


@tag("integration")
@accounts_mode()
class SettingsApiTests(HeadFamilyMixin, TestCase):
    def test_get_and_patch_default_currency(self):
        client = self.client_of(self.third, csrf=True)
        body = client.get("/api/me/settings/").json()
        self.assertIsNone(body["default_currency"])
        self.assertIn({"code": "EUR", "name": body["currencies"][[c["code"] for c in body["currencies"]].index("EUR")]["name"]},
                      body["currencies"])
        saved = client.patch("/api/me/settings/", json.dumps({"default_currency": "rub"}), content_type="application/json")
        self.assertEqual(saved.status_code, 200, saved.content)
        self.assertEqual(saved.json()["default_currency"], "RUB")
        self.assertEqual(self.client_of(self.third).get("/api/me/").json()["settings"], {"default_currency": "RUB"})
        cleared = client.patch("/api/me/settings/", json.dumps({"default_currency": None}), content_type="application/json")
        self.assertIsNone(cleared.json()["default_currency"])

    def test_patch_refusals(self):
        client = self.client_of(self.third, csrf=True)
        for body, field in (({"default_currency": "XXX"}, "default_currency"), ({"default_currency": 5}, "default_currency"),
                            ({"theme": "dark"}, "theme")):
            response = client.patch("/api/me/settings/", json.dumps(body), content_type="application/json")
            with self.subTest(body=body):
                self.assertEqual(response.status_code, 400, response.content)
                self.assertIn(field, response.json()["error"]["fields"])
        self.assertFalse(Profile.objects.filter(user=self.third).exists())

    def test_settings_need_sign_in(self):
        self.assertEqual(self.client.get("/api/me/settings/").status_code, 401)

    def test_manual_default_currency_prefers_profile(self):
        client = self.client_of(self.third)
        self.assertEqual(client.get("/api/receipts/manual/").json()["currency"], "EUR")  # последний чек
        profile.save(self.third, default_currency="KZT")
        self.assertEqual(client.get("/api/receipts/manual/").json()["currency"], "KZT")
        self.assertEqual(manual.default_currency(Receipt.objects.none(), self.third), "KZT")
        self.assertEqual(manual.default_currency(Receipt.objects.none(), self.second), manual.DEFAULT_CURRENCY)

    def test_primary_currency_block_first(self):
        purchase(self.third, samples.lidl_store(), "KZT", date(2026, 3, 8), "4.00", self.product)
        client = self.client_of(self.third)

        def order(url):
            return [block["currency"] for block in client.get(url).json()["currencies"]]

        self.assertEqual(order("/api/stats/spending/"), ["EUR", "KZT"])
        profile.save(self.third, default_currency="KZT")
        for url in ("/api/stats/spending/", "/api/dashboard/?month=2026-03", "/api/stats/trends/monthly/?month=2026-03"):
            with self.subTest(url=url):
                self.assertEqual(order(url), ["KZT", "EUR"])


@tag("integration")
@local_single_mode()
class SettingsLocalSingleTests(TestCase):
    def test_get_works_without_sign_in(self):
        local_user()
        self.assertEqual(self.client.get("/api/me/settings/").status_code, 200)
