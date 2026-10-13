"""«Магазины»: ``/api/store-merges/`` — список мест семьи, предложения, склейка и «Не то».

Данные вымышленные; модель не вызывается.
"""
from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal

from django.test import TestCase, tag
from rest_framework.test import APIClient

from api.tests.accounts_helpers import NOT_AUTHENTICATED, PERMISSION_DENIED, TwoUsers, accounts_mode, local_single_mode
from catalog.models import Category
from receipts import manual
from receipts.models import Receipt
from receipts.ownership import local_user
from stores.models import StoreMerge, StoreMergeSuggestion

STATE = "/api/store-merges/"
MERGE = "/api/store-merges/merge/"
DISMISS = "/api/store-merges/dismiss/"


class StoresMixin:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.food = Category.objects.create(name="Демо-еда")

    def spend(self, owner, store, day="2026-10-01"):
        return manual.create(owner, {"total": "1000", "currency": "KZT", "category": self.food.pk,
                                     "store_name": store, "purchased_on": day})


@tag("integration")
@local_single_mode()
class StoreMergesTests(StoresMixin, TestCase):
    def setUp(self):
        self.client = APIClient()
        owner = local_user()
        self.magnum = self.spend(owner, "MAGNUM").store
        self.spend(owner, "MAGNUM", "2026-10-02")
        self.city = self.spend(owner, "MAGNUM*ALMATY").store
        self.cafe = self.spend(owner, "Демо-кафе").store
        manual.find_or_create_store("Демо-пусто", "KZT")  # a store without spends of the family is not listed

    def test_state_lists_the_family_stores_by_name_with_counts_and_suggestions(self):
        self.assertEqual(self.client.get(STATE).json(), {
            "can_merge": True,
            "suggestions": [{"source": "similar", "stores": [self.magnum.pk, self.city.pk]}],
            "stores": [
                {"id": self.magnum.pk, "name": "MAGNUM", "receipts_count": 2, "aliases": []},
                {"id": self.city.pk, "name": "MAGNUM*ALMATY", "receipts_count": 1, "aliases": []},
                {"id": self.cafe.pk, "name": "Демо-кафе", "receipts_count": 1, "aliases": []},
            ],
        })

    def test_merge_answers_the_new_state_and_the_old_name_is_a_spelling(self):
        response = self.client.post(MERGE, {"store": self.magnum.pk, "merged": [self.city.pk]}, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), {
            "can_merge": True, "suggestions": [],
            "stores": [
                {"id": self.magnum.pk, "name": "MAGNUM", "receipts_count": 3, "aliases": ["MAGNUM*ALMATY"]},
                {"id": self.cafe.pk, "name": "Демо-кафе", "receipts_count": 1, "aliases": []},
            ],
        })
        self.assertEqual(StoreMerge.objects.get().created_by, local_user())
        self.assertNotIn(self.city.pk, [item["id"] for item in self.client.get("/api/stores/").json()["results"]])
        self.assertEqual(self.client.post("/api/receipts/manual/", {
            "total": "5", "category": self.food.pk, "store_name": "magnum*almaty"}, format="json").json()["store"]["id"],
            self.magnum.pk)

    def test_refusals(self):
        cases = [
            ({"store": "1", "merged": [self.city.pk]}, {"store": ["Ожидается номер магазина."]}),
            ({"merged": [self.city.pk]}, {"store": ["Выберите магазины для склейки."]}),
            ({"store": self.magnum.pk, "merged": "x"}, {"merged": ["Ожидается список номеров магазинов, не больше 50."]}),
            ({"store": self.magnum.pk, "merged": []}, {"merged": ["Выберите магазины для склейки."]}),
            ({"store": self.magnum.pk, "merged": [self.magnum.pk]}, {"merged": ["Главный магазин не склеивается сам с собой."]}),
            ({"store": 999999, "merged": [self.city.pk]}, {"store": ["Магазин не найден."]}),
            ({"store": self.magnum.pk, "merged": [self.city.pk], "extra": 1}, {"extra": ["Неизвестное поле."]}),
        ]
        for body, fields in cases:
            with self.subTest(body=body):
                response = self.client.post(MERGE, body, format="json")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["fields"], fields)
        self.assertFalse(StoreMerge.objects.exists())

    def test_conflict_of_equal_photo_receipts(self):
        moment = datetime(2026, 10, 1, 9, tzinfo=dt_timezone.utc)
        for store in (self.magnum, self.city):
            Receipt.objects.create(owner=local_user(), store=store, currency_id="KZT", operation="sale",
                                   purchased_at=moment, purchased_on=date(2026, 10, 1), total=Decimal("500.00"))
        response = self.client.post(MERGE, {"store": self.magnum.pk, "merged": [self.city.pk]}, format="json")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "store_merge_conflict"))
        self.assertFalse(StoreMerge.objects.exists())

    def test_dismiss(self):
        response = self.client.post(DISMISS, {"stores": [self.city.pk, self.magnum.pk]}, format="json")
        self.assertEqual((response.status_code, response.json()["suggestions"]), (200, []))
        self.assertEqual(StoreMergeSuggestion.objects.get().store_ids, sorted([self.magnum.pk, self.city.pk]))
        for body in ({"stores": [self.city.pk]}, {"stores": [self.city.pk, 999999]}, {"stores": "x"}, {}):
            with self.subTest(body=body):
                self.assertEqual(self.client.post(DISMISS, body, format="json").status_code, 400)


@tag("integration")
@accounts_mode()
class StoreMergesAccountsTests(StoresMixin, TwoUsers, TestCase):
    def test_anonymous_is_refused(self):
        self.assertEqual(APIClient().get(STATE).json(), NOT_AUTHENTICATED)

    def test_counts_are_of_the_family_and_only_a_moderator_merges(self):
        mine = self.spend(self.first, "MAGNUM").store
        city = self.spend(self.first, "MAGNUM*ALMATY").store
        self.spend(self.second, "Демо-чужое")
        body = self.client_of(self.first).get(STATE).json()
        self.assertEqual((body["can_merge"], body["suggestions"]), (False, []))
        self.assertEqual([item["name"] for item in body["stores"]], ["MAGNUM", "MAGNUM*ALMATY"])
        refused = self.client_of(self.first, csrf=True).post(MERGE, {"store": mine.pk, "merged": [city.pk]}, format="json")
        self.assertEqual((refused.status_code, refused.json()), (403, PERMISSION_DENIED))
        self.assertEqual(self.client_of(self.first, csrf=True).post(DISMISS, {"stores": [mine.pk, city.pk]}, format="json").status_code, 403)
        # The moderator sees no spends of the first user, yet merges the shared stores.
        moderator = self.client_of(self.moderator, csrf=True)
        self.assertEqual(moderator.get(STATE).json(), {"can_merge": True, "suggestions": [], "stores": []})
        self.assertEqual(moderator.post(MERGE, {"store": mine.pk, "merged": [city.pk]}, format="json").status_code, 200)
        self.assertEqual(self.client_of(self.first).get(STATE).json()["stores"],
                         [{"id": mine.pk, "name": "MAGNUM", "receipts_count": 2, "aliases": ["MAGNUM*ALMATY"]}])

    def test_csrf_is_required(self):
        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.moderator)
        self.assertEqual(client.post(DISMISS, {"stores": [1, 2]}, format="json").json()["error"]["code"], "csrf_failed")
