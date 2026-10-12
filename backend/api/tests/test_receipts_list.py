"""Список «Траты»: фильтр ``?owner=`` и поля строки ``category`` / ``first_line``."""
from datetime import date
from decimal import Decimal as D

from django.test import TestCase, tag

from accounts.models import Household, Membership
from api.tests.accounts_helpers import TwoUsers, accounts_mode, local_single_mode, make_user
from api.tests.factories import make_receipt
from catalog.models import Category, GenericProduct
from api.tests.factories import make_product
from receipts.tests import samples
from receipts.tests.test_models import make_line


def ids(response):
    assert response.status_code == 200, response.content
    return [item["id"] for item in response.json()["results"]]


@tag("integration")
@accounts_mode()
class OwnerFilterTests(TwoUsers, TestCase):
    """``first`` и ``third`` — одна семья, ``second`` — сам по себе."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=family)
        store = samples.lidl_store()
        cls.receipts = {account.pk: make_receipt(store, "EUR", date(2026, 10, day), owner=account, total=D("5.00"))
                        for day, account in ((1, cls.first), (2, cls.second), (3, cls.third))}

    def test_family_member_filters_by_each_member(self):
        client = self.client_of(self.first)
        self.assertEqual(ids(client.get("/api/receipts/")), [self.receipts[self.third.pk].pk, self.receipts[self.first.pk].pk])
        self.assertEqual(ids(client.get("/api/receipts/?owner=synthetic-user-three")), [self.receipts[self.third.pk].pk])
        self.assertEqual(ids(client.get("/api/receipts/?owner=synthetic-user-one")), [self.receipts[self.first.pk].pk])
        self.assertEqual(ids(self.client_of(self.third).get("/api/receipts/?owner=synthetic-user-one")),
                         [self.receipts[self.first.pk].pk])

    def test_outside_or_unknown_owner_is_an_empty_list_not_an_error(self):
        client = self.client_of(self.first)
        for owner in ("synthetic-user-two", "nobody-at-all", "synthetic-moderator", "x" * 300):
            with self.subTest(owner=owner):
                response = client.get("/api/receipts/", {"owner": owner})
                self.assertEqual(ids(response), [])
                self.assertEqual(response.json()["count"], 0)
        # Without a household only the own receipts can be found, even by a family member's name.
        self.assertEqual(ids(self.client_of(self.second).get("/api/receipts/?owner=synthetic-user-one")), [])
        self.assertEqual(ids(self.client_of(self.second).get("/api/receipts/?owner=synthetic-user-two")),
                         [self.receipts[self.second.pk].pk])

    def test_blank_owner_is_no_filter_and_combines_with_others(self):
        client = self.client_of(self.first)
        self.assertEqual(len(ids(client.get("/api/receipts/?owner=%20"))), 2)
        self.assertEqual(ids(client.get("/api/receipts/?owner=synthetic-user-three&date_to=2026-10-02")), [])
        self.assertEqual(ids(client.get("/api/receipts/?owner=synthetic-user-one&owner=synthetic-user-three")),
                         [self.receipts[self.third.pk].pk])

    def test_control_characters_are_refused(self):
        response = self.client_of(self.first).get("/api/receipts/", {"owner": "synthetic\x00user"})
        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(response.json()["error"]["code"], "invalid_parameter")
        self.assertIn("owner", response.json()["error"]["fields"])


@tag("integration")
@local_single_mode()
class LocalOwnerFilterTests(TestCase):
    def test_local_user_is_the_only_owner(self):
        receipt = make_receipt(samples.lidl_store(), "EUR", date(2026, 10, 1), total=D("1.00"))
        self.assertEqual(ids(self.client.get("/api/receipts/?owner=local")), [receipt.pk])
        self.assertEqual(ids(self.client.get("/api/receipts/?owner=someone")), [])


@tag("integration")
@local_single_mode()
class ListFieldsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.store = samples.lidl_store()
        cls.food = Category.objects.create(name="Демо-продукты")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)
        cls.cheese = Category.objects.create(name="Демо-сыры", parent=cls.dairy)
        cls.home = Category.objects.create(name="Демо-дом")
        milk = GenericProduct.objects.create(name="Демо-молоко", category=cls.dairy, base_unit="l")
        cls.milk = make_product(milk, "Демо-молоко 1 л")

    def receipt(self, day, *lines):
        receipt = make_receipt(self.store, "EUR", date(2026, 10, day), total=D("10.00"))
        for position, fields in enumerate(lines, start=1):
            make_line(receipt, position=position, **fields)
        return receipt

    def listed(self):
        return {item["id"]: item for item in self.client.get("/api/receipts/").json()["results"]}

    def test_one_top_level_category_through_products_and_lines(self):
        receipt = self.receipt(1, {"product": self.milk, "raw_name": "MILCH"}, {"category": self.cheese, "raw_name": "Käse"},
                               {"raw_name": "Unbekannt"})
        item = self.listed()[receipt.pk]
        self.assertEqual(item["category"], {"id": self.food.pk, "name": "Демо-продукты"})
        self.assertEqual(item["first_line"], "MILCH")

    def test_several_top_level_categories_or_none_give_null(self):
        mixed = self.receipt(1, {"product": self.milk}, {"category": self.home})
        bare = self.receipt(2, {"raw_name": "Ohne"})
        empty = self.receipt(3)
        listed = self.listed()
        self.assertIsNone(listed[mixed.pk]["category"])
        self.assertIsNone(listed[bare.pk]["category"])
        self.assertEqual(listed[bare.pk]["first_line"], "Ohne")
        self.assertIsNone(listed[empty.pk]["category"])
        self.assertIsNone(listed[empty.pk]["first_line"])

    def test_every_category_of_the_lines_by_name(self):
        mixed = self.receipt(1, {"product": self.milk}, {"category": self.home}, {"category": self.home}, {"raw_name": "X"})
        bare = self.receipt(2, {"raw_name": "Ohne"})
        listed = self.listed()
        milk = self.milk.generic.category
        self.assertEqual(listed[mixed.pk]["categories"],
                         sorted([{"id": milk.pk, "name": milk.name}, {"id": self.home.pk, "name": "Демо-дом"}],
                                key=lambda entry: (entry["name"], entry["id"])))
        self.assertEqual(listed[bare.pk]["categories"], [])
        self.assertNotIn("categories", self.client.get(f"/api/receipts/{mixed.pk}/").json())

    def test_first_line_follows_position_not_creation(self):
        receipt = make_receipt(self.store, "EUR", date(2026, 10, 4), total=D("10.00"))
        make_line(receipt, position=2, raw_name="Zweite", category=self.home)
        make_line(receipt, position=1, raw_name="Erste", category=self.home)
        item = self.listed()[receipt.pk]
        self.assertEqual(item["first_line"], "Erste")
        self.assertEqual(item["category"], {"id": self.home.pk, "name": "Демо-дом"})

    def test_detail_keeps_its_shape(self):
        receipt = self.receipt(1, {"product": self.milk})
        detail = self.client.get(f"/api/receipts/{receipt.pk}/").json()
        self.assertNotIn("category", detail)
        self.assertNotIn("first_line", detail)

    def test_queries_do_not_grow_with_the_page(self):
        for day in range(1, 6):
            self.receipt(day, {"product": self.milk}, {"category": self.home})
        # count + page + category tree; without categories on the page — no tree.
        for size in (1, 5):
            with self.subTest(size=size), self.assertNumQueries(3):
                self.assertEqual(self.client.get(f"/api/receipts/?page_size={size}").status_code, 200)
        with self.assertNumQueries(2):
            self.assertEqual(self.client.get("/api/receipts/?q=nothing-matches").status_code, 200)
