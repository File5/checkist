"""``/api/budget/limits/``: CRUD, проверка тела, семья видит общие лимиты, чужой — ``404``.

Данные вымышленные; модель распознавания не вызывается.
"""
from decimal import Decimal

from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import (
    NOT_AUTHENTICATED, NOT_FOUND, PERMISSION_DENIED, TwoUsers, accounts_mode, local_single_mode, make_user,
)
from budget.models import BudgetLimit
from catalog.models import Category
from receipts.ownership import local_user

D = Decimal
LIMITS = "/api/budget/limits/"


def fields(response):
    return response.json()["error"]["fields"]


class CategoriesMixin:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.food = Category.objects.create(name="Демо-продукты")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)
        cls.transport = Category.objects.create(name="Демо-транспорт")


@tag("integration")
@local_single_mode()
class LimitsLocalTests(CategoriesMixin, TestCase):
    def setUp(self):
        self.client = APIClient()

    def create(self, **body):
        body = {"category_id": self.food.pk, "currency": "KZT", "amount": "120000", **body}
        return self.client.post(LIMITS, body, format="json")

    def test_create_list_patch_delete(self):
        created = self.create()
        self.assertEqual(created.status_code, 201, created.content)
        item = created.json()
        self.assertEqual(item, {"id": item["id"], "category_id": self.food.pk, "category_name": "Демо-продукты",
                                "currency": "KZT", "amount": "120000.00"})
        limit = BudgetLimit.objects.get(pk=item["id"])
        self.assertEqual((limit.user, limit.household), (local_user(), None))
        self.assertEqual(self.create(category_id=self.transport.pk, currency="eur", amount=150.5).json()["currency"], "EUR")

        listed = self.client.get(LIMITS).json()
        self.assertEqual(listed["count"], 2)
        self.assertEqual([row["category_name"] for row in listed["results"]], ["Демо-продукты", "Демо-транспорт"])
        self.assertEqual(listed["results"][1]["amount"], "150.50")

        patched = self.client.patch(f"{LIMITS}{item['id']}/", {"amount": "99 999,5"}, format="json")
        self.assertEqual(patched.status_code, 400)
        patched = self.client.patch(f"{LIMITS}{item['id']}/", {"amount": "99999,5"}, format="json")
        self.assertEqual(patched.status_code, 200, patched.content)
        self.assertEqual(patched.json()["amount"], "99999.50")
        self.assertEqual(self.client.get(f"{LIMITS}{item['id']}/").json()["amount"], "99999.50")

        deleted = self.client.delete(f"{LIMITS}{item['id']}/")
        self.assertEqual(deleted.status_code, 204)
        self.assertFalse(BudgetLimit.objects.filter(pk=item["id"]).exists())
        self.assertEqual(self.client.get(f"{LIMITS}{item['id']}/").json(), NOT_FOUND)

    def test_validation(self):
        response = self.client.post(LIMITS, {"extra": 1}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["code"], "invalid_parameter")
        self.assertEqual(set(fields(response)), {"extra", "category_id", "currency", "amount"})
        self.assertEqual(fields(self.create(category_id=self.dairy.pk)), {"category_id": ["Категория верхнего уровня не найдена."]})
        self.assertIn("category_id", fields(self.create(category_id=999999999)))
        self.assertIn("category_id", fields(self.create(category_id=str(self.food.pk))))
        self.assertIn("category_id", fields(self.create(category_id=True)))
        self.assertEqual(fields(self.create(currency="XXQ")), {"currency": ["Валюта не найдена."]})
        for amount in ("0", "-5", "1.234", "", "abc", 0, True, None, "1e5", "1000000000000"):
            self.assertIn("amount", fields(self.create(amount=amount)), amount)
        self.assertEqual(BudgetLimit.objects.count(), 0)

    def test_duplicate_category_currency(self):
        self.assertEqual(self.create().status_code, 201)
        duplicate = self.create(amount="5")
        self.assertEqual(duplicate.status_code, 400)
        self.assertEqual(fields(duplicate), {"category_id": ["Лимит для этой категории и валюты уже есть."]})
        other = self.create(category_id=self.transport.pk).json()
        moved = self.client.patch(f"{LIMITS}{other['id']}/", {"category_id": self.food.pk}, format="json")
        self.assertEqual(fields(moved), {"category_id": ["Лимит для этой категории и валюты уже есть."]})
        self.assertEqual(BudgetLimit.objects.get(pk=other["id"]).category_id, self.transport.pk)

    def test_patch_needs_a_field_and_json(self):
        limit = self.create().json()
        empty = self.client.patch(f"{LIMITS}{limit['id']}/", {}, format="json")
        self.assertEqual(fields(empty), {"body": ["Укажите хотя бы одно поле."]})
        not_json = self.client.patch(f"{LIMITS}{limit['id']}/", "amount=5", content_type="text/plain")
        self.assertEqual(not_json.status_code, 415)
        self.assertEqual(self.client.put(f"{LIMITS}{limit['id']}/", {}, format="json").status_code, 405)

    @override_settings(ALLOW_LOCAL_RECOGNITION_API=False)
    def test_local_api_flag_required(self):
        self.assertEqual(self.client.get(LIMITS).json(), PERMISSION_DENIED)

    def test_csrf_required_for_writes(self):
        client = APIClient(enforce_csrf_checks=True)
        response = client.post(LIMITS, {"category_id": self.food.pk, "currency": "KZT", "amount": "1"}, format="json")
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "csrf_failed")


@tag("integration")
@accounts_mode()
class LimitsFamilyTests(CategoriesMixin, TwoUsers, TestCase):
    """``first`` и ``third`` — одна семья, ``second`` вне её."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        cls.family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=cls.family)

    def create(self, account, **body):
        body = {"category_id": self.food.pk, "currency": "KZT", "amount": "1000", **body}
        return self.client_of(account, csrf=True).post(LIMITS, body, format="json")

    def test_anonymous_gets_401(self):
        self.assertEqual(APIClient().get(LIMITS).json(), NOT_AUTHENTICATED)
        self.assertEqual(APIClient().get("/api/dashboard/").json(), NOT_AUTHENTICATED)

    def test_family_shares_limits(self):
        created = self.create(self.first)
        self.assertEqual(created.status_code, 201, created.content)
        limit = BudgetLimit.objects.get(pk=created.json()["id"])
        self.assertEqual((limit.household, limit.user), (self.family, None))
        self.assertEqual(self.client_of(self.third).get(LIMITS).json()["count"], 1)
        patched = self.client_of(self.third, csrf=True).patch(
            f"{LIMITS}{limit.pk}/", {"amount": "2000"}, format="json")
        self.assertEqual(patched.json()["amount"], "2000.00")
        self.assertEqual(fields(self.create(self.third)), {"category_id": ["Лимит для этой категории и валюты уже есть."]})

    def test_outsider_sees_nothing_and_gets_404(self):
        limit = self.create(self.first).json()
        outsider = self.client_of(self.second, csrf=True)
        self.assertEqual(self.client_of(self.second).get(LIMITS).json()["count"], 0)
        url = f"{LIMITS}{limit['id']}/"
        self.assertEqual(self.client_of(self.second).get(url).json(), NOT_FOUND)
        self.assertEqual(outsider.patch(url, {"amount": "1"}, format="json").json(), NOT_FOUND)
        self.assertEqual(outsider.delete(url).json(), NOT_FOUND)
        self.assertEqual(BudgetLimit.objects.get(pk=limit["id"]).amount, D("1000.00"))
        own = self.create(self.second)  # своя пара «категория и валюта» у человека без семьи
        self.assertEqual(own.status_code, 201, own.content)
        self.assertEqual(BudgetLimit.objects.get(pk=own.json()["id"]).user, self.second)
        self.assertEqual(self.client_of(self.first).get(LIMITS).json()["count"], 1)

    def test_personal_limits_hidden_after_joining_family(self):
        personal = BudgetLimit.objects.create(user=self.first, category=self.transport, currency_id="KZT", amount=D("5"))
        self.assertEqual(self.client_of(self.first).get(LIMITS).json()["count"], 0)
        self.assertEqual(self.client_of(self.first).get(f"{LIMITS}{personal.pk}/").json(), NOT_FOUND)
