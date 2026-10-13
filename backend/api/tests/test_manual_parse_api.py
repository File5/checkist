"""«Трата словами»: ``POST /api/receipts/manual/parse/`` и ``GET .../parse/{id}/``.

Модель не вызывается: разбор выполняет fake прямо в тесте (как воркер).
"""
from datetime import timedelta

from django.test import TestCase, tag
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from catalog.models import Category
from api.tests.accounts_helpers import NOT_AUTHENTICATED, NOT_FOUND, TwoUsers, accounts_mode, allow_ai, local_single_mode
from receipts import manual_parse
from receipts.models import ManualParseRequest, Receipt

PARSE = "/api/receipts/manual/parse/"


def run_worker_step():
    row = manual_parse.claim()
    return manual_parse.execute(row, parser=manual_parse.FakeTextParser())


@tag("integration")
@local_single_mode()
class ManualParseLocalTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        Category.objects.create(name="Демо-транспорт")

    def test_post_queues_and_get_returns_the_draft(self):
        response = self.client.post(PARSE, {"text": "  такси до аэропорта 4500 "}, format="json")
        self.assertEqual(response.status_code, 202, response.content)
        body = response.json()
        self.assertEqual((body["status"], body["draft"], body["error"], body["finished_at"]), ("queued", None, None, None))
        self.assertEqual(set(body["executor"]), {"available", "state", "last_seen_at"})
        row = ManualParseRequest.objects.get(pk=body["id"])
        self.assertEqual((row.text, row.today), ("такси до аэропорта 4500", timezone.localdate()))
        self.assertEqual(self.client.get(f"{PARSE}{row.pk}/").json()["status"], "queued")
        receipts = Receipt.objects.count()
        run_worker_step()
        detail = self.client.get(f"{PARSE}{row.pk}/")
        self.assertEqual(detail.status_code, 200)
        data = detail.json()
        self.assertEqual(data["status"], "succeeded")
        self.assertEqual(set(data["draft"]), {"total", "currency", "category", "purchased_on", "store_name", "note", "payment_method",
                                             "lines"})
        self.assertEqual(data["draft"]["total"], "4500")
        self.assertIsNotNone(data["finished_at"])
        self.assertEqual(Receipt.objects.count(), receipts)
        # The draft is a body the manual save accepts as it is.
        saved = self.client.post("/api/receipts/manual/", data["draft"], format="json")
        self.assertEqual(saved.status_code, 201, saved.content)

    def test_failed_request_carries_a_fixed_message(self):
        response = self.client.post(PARSE, {"text": "кофе"}, format="json")
        row = manual_parse.claim()
        manual_parse.execute(row, parser=manual_parse.FakeTextParser("invalid_output"))
        data = self.client.get(f"{PARSE}{response.json()['id']}/").json()
        self.assertEqual((data["status"], data["draft"]), ("failed", None))
        self.assertEqual(data["error"], {"code": "invalid_output",
                                         "message": "Не удалось разобрать текст. Заполните форму вручную."})

    def test_client_today(self):
        today = timezone.localdate()
        response = self.client.post(PARSE, {"text": "кофе 900", "today": (today - timedelta(days=1)).isoformat()},
                                    format="json")
        self.assertEqual(ManualParseRequest.objects.get(pk=response.json()["id"]).today, today - timedelta(days=1))
        for value in ((today - timedelta(days=3)).isoformat(), "2026-13-01", 20261012):
            with self.subTest(value=value):
                refused = self.client.post(PARSE, {"text": "кофе", "today": value}, format="json")
                self.assertEqual(refused.status_code, 400)
                self.assertEqual(list(refused.json()["error"]["fields"]), ["today"])

    def test_invalid_bodies(self):
        for body, field in (({}, "text"), ({"text": "   "}, "text"), ({"text": 5}, "text"),
                            ({"text": "x" * 501}, "text"), ({"text": "кофе", "total": "1"}, "total")):
            with self.subTest(body=body):
                response = self.client.post(PARSE, body, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertIn(field, response.json()["error"]["fields"])
        self.assertEqual(self.client.post(PARSE, "[]", content_type="application/json").status_code, 400)
        self.assertEqual(ManualParseRequest.objects.count(), 0)

    def test_rate_limit(self):
        for _ in range(manual_parse.MAX_UNFINISHED):
            self.assertEqual(self.client.post(PARSE, {"text": "кофе 900"}, format="json").status_code, 202)
        refused = self.client.post(PARSE, {"text": "кофе 900"}, format="json")
        self.assertEqual(refused.status_code, 429)
        self.assertEqual(refused.json()["error"]["code"], "parse_limit")
        self.assertEqual(ManualParseRequest.objects.count(), manual_parse.MAX_UNFINISHED)

    def test_methods_and_missing(self):
        self.assertEqual(self.client.get(PARSE).status_code, 405)
        self.assertEqual(self.client.get(f"{PARSE}999999/").json(), NOT_FOUND)
        self.assertEqual(self.client.post(f"{PARSE}1/", {}, format="json").status_code, 405)


@tag("integration")
@accounts_mode()
class ManualParseAccountsTests(TwoUsers, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        allow_ai(cls.first, cls.second)

    def test_anonymous_is_refused(self):
        self.assertEqual(APIClient().post(PARSE, {"text": "кофе"}, format="json").json(), NOT_AUTHENTICATED)
        self.assertEqual(APIClient().get(f"{PARSE}1/").json(), NOT_AUTHENTICATED)

    def test_csrf_is_required(self):
        response = self.client_of(self.first, csrf=True).post(PARSE, {"text": "кофе"}, format="json")
        self.assertEqual(response.status_code, 202)
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.first)
        self.assertEqual(client.post(PARSE, {"text": "кофе"}, format="json").json()["error"]["code"], "csrf_failed")

    def test_another_family_sees_404_and_own_family_sees_the_request(self):
        response = self.client_of(self.first, csrf=True).post(PARSE, {"text": "кофе 900"}, format="json")
        url = f"{PARSE}{response.json()['id']}/"
        self.assertEqual(ManualParseRequest.objects.get().owner, self.first)
        self.assertEqual(self.client_of(self.first).get(url).status_code, 200)
        self.assertEqual(self.client_of(self.second).get(url).json(), NOT_FOUND)
        family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=self.first, household=family)
        Membership.objects.create(user=self.second, household=family)
        self.assertEqual(self.client_of(self.second).get(url).status_code, 200)

    def test_limits_are_per_user(self):
        for _ in range(manual_parse.MAX_UNFINISHED):
            self.client_of(self.first, csrf=True).post(PARSE, {"text": "кофе"}, format="json")
        self.assertEqual(self.client_of(self.first, csrf=True).post(PARSE, {"text": "кофе"}, format="json").status_code, 429)
        self.assertEqual(self.client_of(self.second, csrf=True).post(PARSE, {"text": "кофе"}, format="json").status_code, 202)
