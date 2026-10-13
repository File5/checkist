"""Несколько семей по приглашению и ИИ у семьи (``accounts.family``, ``accounts.ai``).

Пользователи, пароли и названия вымышленные; модель не вызывается (fake либо только очередь).
"""
import json
from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase, tag
from django.utils import timezone
from rest_framework.test import APIClient

from accounts import ai
from accounts.models import AiUsage, Household, Invite, Membership
from api.tests.accounts_helpers import ORIGIN, accounts_mode, local_single_mode, make_user
from api.tests.test_owner_isolation import IsolationMixin
from api.tests.test_recognition_api import upload
from catalog.models import Category
from receipts import manual_parse
from receipts.models import ManualParseRequest
from recognition.models import ProcessingJob, SourcePhoto

STRONG = "Synthetic-Pass-2026!"
PARSE = "/api/receipts/manual/parse/"
PHOTOS = "/api/recognition/photos/"
NEW = "/api/auth/new-family/"
CHECK = "/api/auth/new-family/check/"


def guest(*, csrf=True):
    """Клиент без входа; токен CSRF — из ``/api/auth/csrf/``, как у формы входа."""
    client = APIClient(enforce_csrf_checks=True)
    if csrf:
        token = client.get("/api/auth/csrf/").json()["csrf_token"]
        client.credentials(HTTP_X_CSRFTOKEN=token, HTTP_ORIGIN=ORIGIN)
    return client


def account_body(token, **fields):
    return {"token": token, "name": "Синтетическая семья", "username": "synthetic-newcomer",
            "first_name": "Новичок", "password": STRONG, **fields}


@tag("integration")
@accounts_mode()
class NewFamilyInviteTests(IsolationMixin, TestCase):
    """``staff`` — администратор сервера; ``first`` и ``second`` — обычные пользователи."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.staff = make_user("synthetic-staff", is_staff=True)

    def setUp(self):
        self.temporary_media()

    def call(self, account, method, url, body=None):
        client = self.client_of(account, csrf=True)
        return getattr(client, method)(url, json.dumps(body) if body is not None else "", content_type="application/json")

    def invite(self):
        response = self.call(self.staff, "post", "/api/family/new-invites/")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()

    def test_only_staff_creates_and_sees_new_family_invites(self):
        created = self.invite()
        self.assertTrue(created["path"].startswith("/family/new?token="))
        self.assertTrue(created["path"].endswith(created["token"]))
        stored = Invite.objects.get(pk=created["id"])
        self.assertEqual((stored.kind, stored.household_id, stored.created_by_id), ("new_family", None, self.staff.pk))
        self.assertNotEqual(stored.token_hash, created["token"])  # хранится только хеш
        body = self.client_of(self.staff).get("/api/family/").json()
        self.assertTrue(body["can_invite_families"])
        self.assertEqual([item["id"] for item in body["family_invites"]], [created["id"]])
        self.assertNotIn(created["token"], json.dumps(body))
        refused = self.call(self.first, "post", "/api/family/new-invites/")
        self.assertEqual((refused.status_code, refused.json()["error"]["code"]), (403, "staff_only"))
        self.assertEqual(self.call(self.first, "delete", f"/api/family/new-invites/{created['id']}/").status_code, 403)
        plain = self.client_of(self.first).get("/api/family/").json()
        self.assertEqual((plain["can_invite_families"], plain["family_invites"]), (False, []))
        self.assertEqual(guest().post("/api/family/new-invites/", {}, format="json").status_code, 401)

    def test_guest_creates_account_and_becomes_head_of_a_new_family(self):
        token = self.invite()["token"]
        client = guest()
        checked = client.post(CHECK, {"token": token}, format="json")
        self.assertEqual(checked.status_code, 200, checked.content)
        self.assertIn("expires_at", checked.json())
        created = client.post(NEW, account_body(token), format="json")
        self.assertEqual(created.status_code, 201, created.content)
        me = created.json()
        self.assertEqual((me["user"]["username"], me["is_head"]), ("synthetic-newcomer", True))
        self.assertEqual(me["household"]["name"], "Синтетическая семья")
        user = get_user_model().objects.get(username="synthetic-newcomer")
        self.assertTrue(user.check_password(STRONG))
        self.assertFalse(user.is_staff)
        membership = Membership.objects.select_related("household").get(user=user)
        self.assertEqual(membership.role, "head")
        self.assertFalse(membership.household.ai_enabled)  # новая семья — ИИ выключен
        stored = Invite.objects.get(kind="new_family")
        self.assertEqual(stored.used_by_id, user.pk)
        self.assertIsNotNone(stored.used_at)
        # Сессия уже вошедшая: «Семья» и «Я» отвечают без отдельного входа.
        client.credentials(HTTP_X_CSRFTOKEN=me["csrf_token"], HTTP_ORIGIN=ORIGIN)
        self.assertEqual(client.get("/api/me/").json()["user"]["username"], "synthetic-newcomer")
        self.assertEqual(client.get("/api/family/").json()["ai"]["enabled"], False)
        self.assertEqual(self.client_of(self.staff).get("/api/family/").json()["family_invites"], [])

    def test_invite_is_single_use_expires_and_can_be_revoked(self):
        token = self.invite()["token"]
        self.assertEqual(guest().post(NEW, account_body(token), format="json").status_code, 201)
        reused = guest().post(NEW, account_body(token, username="synthetic-second"), format="json")
        self.assertEqual((reused.status_code, reused.json()["error"]["code"]), (400, "invite_invalid"))
        self.assertEqual(guest().post(CHECK, {"token": token}, format="json").status_code, 400)
        late = self.invite()["token"]
        Invite.objects.filter(used_at__isnull=True).update(expires_at=timezone.now() - timedelta(seconds=1))
        self.assertEqual(guest().post(NEW, account_body(late, username="synthetic-late"), format="json").status_code, 400)
        revoked = self.invite()
        self.assertEqual(self.call(self.staff, "delete", f"/api/family/new-invites/{revoked['id']}/").status_code, 204)
        self.assertEqual(self.call(self.staff, "delete", f"/api/family/new-invites/{revoked['id']}/").status_code, 404)
        gone = guest().post(NEW, account_body(revoked["token"], username="synthetic-gone"), format="json")
        self.assertEqual(gone.status_code, 400)
        self.assertFalse(get_user_model().objects.filter(username__in=["synthetic-second", "synthetic-late",
                                                                       "synthetic-gone"]).exists())

    def test_kinds_do_not_mix(self):
        """Токен «новая семья» не впускает в чужую семью, токен семьи не создаёт новую."""
        family_token = self.invite()["token"]
        self.assertEqual(self.call(self.first, "post", "/api/family/", {"name": "Семья первого"}).status_code, 201)
        join_token = self.call(self.first, "post", "/api/family/invites/").json()["token"]
        joined = self.call(self.second, "post", "/api/family/join/", {"token": family_token})
        self.assertEqual((joined.status_code, joined.json()["error"]["code"]), (400, "invite_invalid"))
        made = guest().post(NEW, account_body(join_token), format="json")
        self.assertEqual((made.status_code, made.json()["error"]["code"]), (400, "invite_invalid"))
        self.assertEqual(Invite.objects.filter(used_at__isnull=False).count(), 0)
        # Список приглашений главного — только его семьи.
        self.assertEqual(len(self.client_of(self.first).get("/api/family/").json()["invites"]), 1)

    def test_field_errors_keep_the_invite(self):
        token = self.invite()["token"]
        weak = guest().post(NEW, account_body(token, password="12345678"), format="json")
        self.assertEqual(weak.status_code, 400, weak.content)
        self.assertIn("password", weak.json()["error"]["fields"])
        self.assertIn("entirely_numeric", weak.json()["password_issues"])
        taken = guest().post(NEW, account_body(token, username=self.first.username.upper(), name=" "), format="json")
        self.assertEqual(set(taken.json()["error"]["fields"]), {"username", "name"})
        self.assertEqual(guest().post(NEW, account_body(token, password=""), format="json").status_code, 400)
        unknown = guest().post(NEW, {**account_body(token), "is_staff": True}, format="json")
        self.assertEqual(unknown.status_code, 400)
        self.assertEqual(Household.objects.count(), 0)
        self.assertIsNone(Invite.objects.get().used_at)
        self.assertEqual(guest().post(NEW, account_body(token), format="json").status_code, 201)

    def test_signed_in_and_csrf_and_local_single(self):
        token = self.invite()["token"]
        signed = self.call(self.first, "post", NEW, account_body(token))
        self.assertEqual((signed.status_code, signed.json()["error"]["code"]), (409, "already_signed_in"))
        no_csrf = guest(csrf=False).post(NEW, account_body(token), format="json")
        self.assertEqual((no_csrf.status_code, no_csrf.json()["error"]["code"]), (403, "csrf_failed"))
        self.assertIsNone(Invite.objects.get().used_at)
        with local_single_mode():
            self.assertEqual(APIClient().post(NEW, account_body(token), format="json").status_code, 404)

    def test_wrong_tokens_are_throttled(self):
        token = self.invite()["token"]
        client = guest()
        codes = [client.post(CHECK, {"token": f"synthetic-wrong-{n}"}, format="json").status_code for n in range(6)]
        self.assertEqual(codes, [400] * 5 + [429])
        blocked = client.post(NEW, account_body(token), format="json")
        self.assertEqual((blocked.status_code, blocked.json()["error"]["code"]), (429, "login_throttled"))
        self.assertIn("retry_after", blocked.json())
        self.assertIsNone(Invite.objects.get().used_at)


@tag("integration")
@accounts_mode()
class FamilyAiTests(IsolationMixin, TestCase):
    """``first`` — главный, ``third`` — член семьи; ``second`` — без семьи."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        cls.family = Household.objects.create(name="Демо-семья", ai_daily_limit=3)
        Membership.objects.create(user=cls.first, household=cls.family, role="head")
        Membership.objects.create(user=cls.third, household=cls.family)
        Category.objects.create(name="Демо-транспорт")

    def setUp(self):
        self.temporary_media()

    def call(self, account, method, url, body=None):
        client = self.client_of(account, csrf=True)
        return getattr(client, method)(url, json.dumps(body) if body is not None else "", content_type="application/json")

    def parse(self, account, text="кофе 900"):
        return self.client_of(account, csrf=True).post(PARSE, {"text": text}, format="json")

    def photo(self, account):
        return self.client_of(account, csrf=True).post(PHOTOS, {"file": upload()}, format="multipart")

    def switch(self, enabled):
        response = self.call(self.first, "patch", "/api/family/ai/", {"enabled": enabled})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_new_household_starts_with_ai_off(self):
        self.assertFalse(Household.objects.create(name="Ещё одна").ai_enabled)
        self.assertEqual(Household.objects.create(name="Ещё одна").ai_daily_limit, 50)

    def test_ai_off_refuses_parse_and_photo_with_nothing_queued(self):
        parsed = self.parse(self.third)
        self.assertEqual((parsed.status_code, parsed.json()["error"]["code"]), (403, "ai_disabled"))
        photo = self.photo(self.first)
        self.assertEqual((photo.status_code, photo.json()["error"]["code"]), (403, "ai_disabled"))
        self.assertFalse(ManualParseRequest.objects.exists())
        self.assertFalse(SourcePhoto.objects.exists())
        self.assertFalse(AiUsage.objects.exists())
        self.assertFalse(ai.ai_allowed(self.third))

    def test_only_head_switches_ai(self):
        body = self.switch(True)
        self.assertEqual(body["ai"], {"enabled": True, "daily_limit": 3, "used_today": 0,
                                      "resets_at": body["ai"]["resets_at"]})
        member = self.call(self.third, "patch", "/api/family/ai/", {"enabled": False})
        self.assertEqual((member.status_code, member.json()["error"]["code"]), (403, "head_only"))
        self.assertEqual(self.call(self.second, "patch", "/api/family/ai/", {"enabled": True}).status_code, 404)
        self.assertEqual(self.call(self.first, "patch", "/api/family/ai/", {"enabled": "yes"}).status_code, 400)
        self.assertEqual(self.call(self.first, "patch", "/api/family/ai/", {"enabled": True, "limit": 9}).status_code, 400)
        self.assertEqual(guest().patch("/api/family/ai/", {"enabled": True}, format="json").status_code, 401)
        self.family.refresh_from_db()
        self.assertEqual((self.family.ai_enabled, self.family.ai_daily_limit), (True, 3))
        # Член семьи видит состояние, но не меняет его.
        self.assertTrue(self.client_of(self.third).get("/api/family/").json()["ai"]["enabled"])
        self.assertEqual(self.parse(self.third).status_code, 202)

    def test_quota_counts_the_family_and_resets_next_day(self):
        self.switch(True)
        self.assertEqual(self.parse(self.first).status_code, 202)
        self.assertEqual(self.photo(self.third).status_code, 202)
        self.assertEqual(self.parse(self.third).status_code, 202)
        over = self.parse(self.first)
        self.assertEqual((over.status_code, over.json()["error"]["code"]), (429, "ai_quota"))
        tomorrow = timezone.localdate() + timedelta(days=1)
        self.assertEqual(over.json()["resets_at"], f"{tomorrow.isoformat()}T00:00:00Z")
        self.assertGreater(int(over["Retry-After"]), 0)
        self.assertEqual(self.photo(self.first).json()["error"]["code"], "ai_quota")
        self.assertEqual(ManualParseRequest.objects.count(), 2)
        self.assertEqual(self.client_of(self.third).get("/api/family/").json()["ai"]["used_today"], 3)
        self.assertFalse(ai.ai_allowed(self.first))
        # Пользователь без семьи квоты не имеет и ничего не считает.
        self.assertEqual(self.parse(self.second).status_code, 202)
        self.assertEqual(AiUsage.objects.get().count, 3)
        with mock.patch("django.utils.timezone.localdate", return_value=tomorrow):
            self.assertTrue(ai.ai_allowed(self.first))
            self.assertEqual(self.client_of(self.first).get("/api/family/").json()["ai"]["used_today"], 0)
            self.assertEqual(self.parse(self.first).status_code, 202)
        self.assertEqual(sorted(AiUsage.objects.values_list("count", flat=True)), [1, 3])

    def test_refusals_after_the_check_do_not_spend_the_quota(self):
        self.switch(True)
        Household.objects.filter(pk=self.family.pk).update(ai_daily_limit=10)
        for _ in range(manual_parse.MAX_UNFINISHED):
            self.assertEqual(self.parse(self.first).status_code, 202)
        limited = self.parse(self.first)
        self.assertEqual((limited.status_code, limited.json()["error"]["code"]), (429, "parse_limit"))
        self.assertEqual(AiUsage.objects.get().count, manual_parse.MAX_UNFINISHED)

    def test_retry_sends_the_photo_again_and_is_refused_when_off(self):
        self.switch(True)
        uploaded = self.photo(self.first).json()
        job = uploaded["job"]["id"]
        client = self.client_of(self.first, csrf=True)
        self.assertEqual(client.post(f"/api/recognition/jobs/{job}/cancel/", {}, format="json").status_code, 200)
        self.switch(False)
        refused = client.post(f"/api/recognition/jobs/{job}/retry/", {}, format="json")
        self.assertEqual((refused.status_code, refused.json()["error"]["code"]), (403, "ai_disabled"))
        self.assertEqual(ProcessingJob.objects.count(), 1)
        self.switch(True)
        self.assertEqual(client.post(f"/api/recognition/jobs/{job}/retry/", {}, format="json").status_code, 202)
        self.assertEqual(AiUsage.objects.get().count, 2)

    def test_users_without_family_are_not_affected(self):
        self.assertTrue(ai.ai_allowed(self.second))
        self.assertEqual(self.parse(self.second).status_code, 202)
        self.assertEqual(self.photo(self.second).status_code, 202)
        self.assertIsNone(self.client_of(self.second).get("/api/family/").json()["ai"])
        self.assertFalse(AiUsage.objects.exists())


@tag("integration")
@local_single_mode()
class LocalSingleAiTests(TestCase):
    def test_local_user_in_a_family_with_ai_off_keeps_working(self):
        from receipts.ownership import local_user

        Membership.objects.create(user=local_user(), household=Household.objects.create(name="Демо"), role="head")
        Category.objects.create(name="Демо-транспорт")
        self.assertTrue(ai.ai_allowed(local_user()))
        self.assertEqual(APIClient().post(PARSE, {"text": "кофе 900"}, format="json").status_code, 202)
        self.assertFalse(AiUsage.objects.exists())


@tag("integration")
class FamilyAiMigrationTests(TransactionTestCase):
    """``accounts.0004``: семьи, заведённые раньше, остаются с ИИ; откат и повтор проходят."""

    def migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate([target])
        return executor.loader.project_state([target]).apps

    def test_existing_households_keep_ai_and_rollback_drops_new_family_invites(self):
        try:
            old = self.migrate(("accounts", "0003_profile_head_invite"))
            old.get_model("accounts", "Household").objects.create(name="Прежняя семья")
            new = self.migrate(("accounts", "0004_families_ai_invites"))
            Household = new.get_model("accounts", "Household")
            self.assertTrue(Household.objects.get(name="Прежняя семья").ai_enabled)
            self.assertFalse(Household.objects.create(name="Новая семья").ai_enabled)
            new.get_model("accounts", "Invite").objects.create(
                kind="new_family", token_hash="f" * 64, expires_at=timezone.now())
            self.migrate(("accounts", "0003_profile_head_invite"))
            with connection.cursor() as cursor:
                cursor.execute("SELECT count(*) FROM accounts_invite")
                self.assertEqual(cursor.fetchone()[0], 0)
        finally:
            # The latest state of every app: the rollback also removed what depends on 0004.
            executor = MigrationExecutor(connection)
            executor.migrate(executor.loader.graph.leaf_nodes())
