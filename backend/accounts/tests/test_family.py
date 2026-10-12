"""«Семья» из клиента: ``/api/family/…``. Пользователи и пароли вымышленные."""
import json
from datetime import date, timedelta

from django.contrib.auth import get_user_model
from django.test import TestCase, tag
from django.utils import timezone

from accounts.models import Household, Invite, Membership
from api.tests.accounts_helpers import accounts_mode, local_single_mode, make_user
from api.tests.test_owner_isolation import IsolationMixin, milk, purchase
from receipts.models import Receipt
from receipts.tests import samples

STRONG = "Synthetic-Pass-2026!"


@tag("integration")
@accounts_mode()
class FamilyApiTests(IsolationMixin, TestCase):
    """``first`` создаёт семью и становится главным; ``second`` и ``third`` — без семьи."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")

    def setUp(self):
        self.temporary_media()

    def call(self, account, method, url, body=None):
        client = self.client_of(account, csrf=True)
        data = json.dumps(body) if body is not None else ""
        return getattr(client, method)(url, data, content_type="application/json")

    def create_family(self):
        response = self.call(self.first, "post", "/api/family/", {"name": "Демо-семья"})
        self.assertEqual(response.status_code, 201, response.content)
        return Household.objects.get()

    def join(self, account, family):
        Membership.objects.create(user=account, household=family)

    def test_creator_becomes_head(self):
        body = self.call(self.first, "post", "/api/family/", {"name": " Демо-семья "}).json()
        self.assertTrue(body["is_head"])
        self.assertEqual(body["household"]["name"], "Демо-семья")
        self.assertEqual(body["household"]["members"][0]["role"], "head")
        again = self.call(self.first, "post", "/api/family/", {"name": "Вторая"})
        self.assertEqual((again.status_code, again.json()["error"]["code"]), (409, "already_in_family"))
        self.assertEqual(self.call(self.second, "post", "/api/family/", {"name": ""}).status_code, 400)
        self.assertIsNone(self.client_of(self.second).get("/api/family/").json()["household"])

    def test_head_adds_member_with_one_time_password(self):
        family = self.create_family()
        response = self.call(self.first, "post", "/api/family/members/", {"username": "synthetic-kid", "first_name": "Лиза"})
        self.assertEqual(response.status_code, 201, response.content)
        password = response.json()["password"]
        user = get_user_model().objects.get(username="synthetic-kid")
        self.assertTrue(user.check_password(password))
        self.assertNotEqual(user.password, password)
        self.assertEqual(user.first_name, "Лиза")
        self.assertTrue(Membership.objects.filter(user=user, household=family, role="member").exists())
        self.assertNotIn(password, self.client_of(self.first).get("/api/family/").content.decode())
        weak = self.call(self.first, "post", "/api/family/members/", {"username": "synthetic-kid2", "password": "123"})
        self.assertEqual(weak.status_code, 400)
        self.assertIn("password", weak.json()["error"]["fields"])
        taken = self.call(self.first, "post", "/api/family/members/", {"username": "SYNTHETIC-KID", "password": STRONG})
        self.assertIn("username", taken.json()["error"]["fields"])
        typed = self.call(self.first, "post", "/api/family/members/", {"username": "synthetic-kid3", "password": STRONG})
        self.assertEqual((typed.status_code, typed.json()["password"]), (201, STRONG))

    def test_head_only_and_outsider_404(self):
        family = self.create_family()
        self.join(self.third, family)
        for method, url, body in (("post", "/api/family/members/", {"username": "synthetic-x"}),
                                  ("post", "/api/family/invites/", None), ("post", "/api/family/head/", {"username": "synthetic-user-three"}),
                                  ("patch", "/api/family/", {"name": "Новая"}),
                                  ("delete", f"/api/family/members/{self.first.username}/", None)):
            with self.subTest(url=url):
                member = self.call(self.third, method, url, body)
                self.assertEqual((member.status_code, member.json()["error"]["code"]), (403, "head_only"))
                self.assertEqual(self.call(self.second, method, url, body).status_code, 404)
        self.assertEqual(self.client.get("/api/family/").status_code, 401)

    @local_single_mode()
    def test_local_single_has_no_family_routes(self):
        self.assertEqual(self.client.get("/api/family/").status_code, 404)

    def test_remove_and_leave_keep_receipts(self):
        family = self.create_family()
        self.join(self.second, family)
        self.join(self.third, family)
        store, product = samples.lidl_store(), milk()
        kept = purchase(self.third, store, "EUR", date(2026, 3, 5), "5.00", product)
        left = purchase(self.second, store, "EUR", date(2026, 3, 6), "6.00", product)
        self.assertEqual(self.call(self.first, "delete", f"/api/family/members/{self.third.username}/").status_code, 204)
        self.assertEqual(self.call(self.second, "post", "/api/family/leave/").status_code, 200)
        self.assertEqual(Membership.objects.filter(household=family).count(), 1)
        self.assertEqual(Receipt.objects.get(pk=kept.pk).owner_id, self.third.pk)
        self.assertEqual(self.client_of(self.first).get(f"/api/receipts/{kept.pk}/").status_code, 404)
        self.assertEqual(self.client_of(self.third).get(f"/api/receipts/{kept.pk}/").status_code, 200)
        self.assertEqual(self.client_of(self.second).get(f"/api/receipts/{left.pk}/").status_code, 200)
        head_leaves = self.call(self.first, "post", "/api/family/leave/")
        self.assertEqual((head_leaves.status_code, head_leaves.json()["error"]["code"]), (409, "head_must_transfer"))
        self.assertEqual(self.call(self.first, "delete", f"/api/family/members/{self.first.username}/").status_code, 409)

    def test_transfer_head_keeps_one_head(self):
        family = self.create_family()
        self.join(self.third, family)
        body = self.call(self.first, "post", "/api/family/head/", {"username": self.third.username}).json()
        self.assertFalse(body["is_head"])
        roles = dict(Membership.objects.filter(household=family).values_list("user__username", "role"))
        self.assertEqual(roles, {self.first.username: "member", self.third.username: "head"})
        self.assertEqual(self.call(self.third, "post", "/api/family/head/", {"username": self.second.username}).status_code, 404)

    def test_invite_is_single_use_and_expires(self):
        family = self.create_family()
        created = self.call(self.first, "post", "/api/family/invites/")
        self.assertEqual(created.status_code, 201, created.content)
        token = created.json()["token"]
        self.assertFalse(Invite.objects.filter(token_hash=token).exists())  # хранится только хеш
        self.assertEqual(len(self.client_of(self.first).get("/api/family/").json()["invites"]), 1)
        joined = self.call(self.second, "post", "/api/family/join/", {"token": token})
        self.assertEqual(joined.status_code, 200, joined.content)
        self.assertEqual(joined.json()["household"]["id"], family.pk)
        reused = self.call(self.third, "post", "/api/family/join/", {"token": token})
        self.assertEqual((reused.status_code, reused.json()["error"]["code"]), (400, "invite_invalid"))
        expired_token = self.call(self.first, "post", "/api/family/invites/").json()["token"]
        Invite.objects.filter(used_at__isnull=True).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(self.call(self.third, "post", "/api/family/join/", {"token": expired_token}).status_code, 400)
        fresh = self.call(self.first, "post", "/api/family/invites/").json()
        self.assertEqual(self.call(self.first, "delete", f"/api/family/invites/{fresh['id']}/").status_code, 204)
        self.assertEqual(self.call(self.third, "post", "/api/family/join/", {"token": fresh["token"]}).status_code, 400)

    def test_join_refuses_member_of_another_family_and_throttles(self):
        self.create_family()
        token = self.call(self.first, "post", "/api/family/invites/").json()["token"]
        Membership.objects.create(user=self.third, household=Household.objects.create(name="Другая"))
        busy = self.call(self.third, "post", "/api/family/join/", {"token": token})
        self.assertEqual((busy.status_code, busy.json()["error"]["code"]), (409, "already_in_family"))
        codes = [self.call(self.second, "post", "/api/family/join/", {"token": f"wrong-{n}"}).status_code for n in range(6)]
        self.assertEqual(codes[:5], [400] * 5)
        self.assertEqual(codes[5], 429)
        self.assertEqual(self.call(self.second, "post", "/api/family/join/", {"token": token}).status_code, 429)
