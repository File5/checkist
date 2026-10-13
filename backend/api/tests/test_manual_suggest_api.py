"""Подсказки «Новой траты» без модели: ``GET /api/receipts/manual/suggest/?q=``.

Данные вымышленные; модель не вызывается.
"""
from django.db import connection
from django.test import TestCase, tag
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_AUTHENTICATED, TwoUsers, accounts_mode, local_single_mode
from catalog.models import Category
from receipts import manual
from receipts.models import Receipt
from receipts.ownership import local_user

SUGGEST = "/api/receipts/manual/suggest/"


class SuggestMixin:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.subs = Category.objects.create(name="Демо-подписки")

    def spend(self, owner, store, total="225", day="2026-09-12", **fields):
        return manual.create(owner, {"total": total, "currency": "USD", "category": self.subs.pk,
                                     "store_name": store, "purchased_on": day, **fields})


@tag("integration")
@local_single_mode()
class SuggestTests(SuggestMixin, TestCase):
    def setUp(self):
        self.client = APIClient()
        owner = local_user()
        self.spend(owner, "CLAUDE.AI SUBSCRIPTION", "200", "2026-08-12")
        self.spend(owner, "CLAUDE.AI SUBSCRIPTION", "225", "2026-09-12", note="Claude Max")
        self.spend(owner, "Демо-кино", "15")

    def test_words_find_spends_and_no_words_give_frequent_ones(self):
        body = self.client.get(SUGGEST, {"q": "cla"}).json()
        self.assertEqual(body, {"results": [{
            "receipt_id": Receipt.objects.filter(note="Claude Max").get().pk, "store_name": "CLAUDE.AI SUBSCRIPTION",
            "category": {"id": self.subs.pk, "name": "Демо-подписки"}, "currency": "USD", "total": "225.00",
            "note": "Claude Max", "purchased_on": "2026-09-12", "lines": [], "uses": 2,
        }]})
        for query in ({}, {"q": ""}, {"q": "c"}, {"q": "225"}):
            with self.subTest(query=query):
                self.assertEqual([item["store_name"] for item in self.client.get(SUGGEST, query).json()["results"]],
                                 ["CLAUDE.AI SUBSCRIPTION"])  # «Демо-кино» once: not a repeat
        self.assertEqual(self.client.get(SUGGEST, {"q": "нет такого"}).json(), {"results": []})

    def test_hidden_payments_are_not_suggested(self):
        Receipt.objects.filter(store__name="CLAUDE.AI SUBSCRIPTION").update(hidden=True)
        self.assertEqual(self.client.get(SUGGEST, {"q": "claude"}).json(), {"results": []})
        self.assertEqual(self.client.get(SUGGEST).json(), {"results": []})

    def test_bad_query_and_methods(self):
        self.assertEqual(self.client.get(SUGGEST, {"q": "a\x01"}).status_code, 400)
        self.assertEqual(self.client.post(SUGGEST, {}, format="json").status_code, 405)

    def test_query_count_does_not_grow_with_spends(self):
        def count():
            with CaptureQueriesContext(connection) as queries:
                self.assertEqual(self.client.get(SUGGEST, {"q": "демо"}).status_code, 200)
                self.assertEqual(self.client.get(SUGGEST).status_code, 200)
            return len(queries)

        before = count()
        for day in range(1, 15):
            self.spend(local_user(), f"Демо-место {day}", day=f"2026-09-{day:02}")
        self.assertEqual(count(), before)


@tag("integration")
@accounts_mode()
class SuggestAccountsTests(SuggestMixin, TwoUsers, TestCase):
    def test_anonymous_is_refused(self):
        self.assertEqual(APIClient().get(SUGGEST).json(), NOT_AUTHENTICATED)

    def test_the_family_shares_its_history_and_nobody_else_sees_it(self):
        self.spend(self.first, "Демо-подписка", day="2026-08-12")
        self.spend(self.first, "Демо-подписка")
        self.assertEqual(len(self.client_of(self.first).get(SUGGEST).json()["results"]), 1)
        self.assertEqual(self.client_of(self.second).get(SUGGEST, {"q": "демо"}).json(), {"results": []})
        family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=self.first, household=family, role="head")
        Membership.objects.create(user=self.second, household=family)
        self.assertEqual([item["store_name"] for item in self.client_of(self.second).get(SUGGEST, {"q": "демо"}).json()["results"]],
                         ["Демо-подписка"])
        self.assertEqual(self.client_of(self.moderator).get(SUGGEST).json(), {"results": []})
