"""``GET /api/stats/category-spends/``: из каких чеков и трат сложилась категория за месяц.

Набор — октябрь 2026 дашборда (``budget.tests.test_dashboard_api.FixtureMixin``): фото-чек с молоком
(«Демо-продукты › Демо-молочное»), нечитаемой строкой, хлебом в «Не разобрано» и пакетом-услугой;
ручная трата «Демо-кафе › Демо-кофейни»; трата в EUR; соседние месяцы. Модель не вызывается.
"""
from datetime import date
from decimal import Decimal

from django.test import TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import TwoUsers, accounts_mode, local_single_mode, make_user
from api.tests.factories import make_product
from api.tests.test_stats_spending import absorb
from budget.tests.test_dashboard_api import FixtureMixin, spend
from catalog.models import Category, GenericProduct
from catalog.units import BaseUnit
from receipts import manual
from receipts.models import ReceiptLine
from receipts.ownership import local_user
from receipts.tests.test_models import make_line

D = Decimal
URL = "/api/stats/category-spends/"


def split_spend(owner, on, lines, **body):
    """Трата с позициями в разных категориях: ``lines`` — ``(название, сумма, категория)``."""
    return manual.create(owner, {"currency": "KZT", "purchased_on": on.isoformat(), **body,
                                 "lines": [{"name": name, "amount": amount, "category": category.pk}
                                           for name, amount, category in lines]})


@tag("integration")
@local_single_mode()
class CategorySpendsTests(FixtureMixin, TestCase):
    maxDiff = None

    @classmethod
    def fixture_owner(cls):
        return local_user()

    def get(self, query, status=200):
        response = APIClient().get(f"{URL}?{query}")
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def test_category_with_descendants_lists_receipts_and_their_lines(self):
        body = self.get(f"category={self.food.pk}&month=2026-10")
        self.assertEqual((body["month"], body["previous_month"]), ("2026-10", "2026-09"))
        self.assertEqual(body["category"], {"id": self.food.pk, "name": "Демо-продукты",
                                            "path": [{"id": self.food.pk, "name": "Демо-продукты"}]})
        self.assertEqual(body["children"], [{"id": self.dairy.pk, "name": "Демо-молочное"}])
        eur, kzt = body["currencies"]  # по коду валюты, не складываются
        self.assertEqual((eur["currency"], eur["total"], eur["receipts_count"]), ("EUR", "12.50", 1))
        self.assertEqual(eur["parts"], [{"id": self.food.pk, "name": "Демо-продукты", "direct": True, "children_count": 0,
                                         "amount": "12.50", "lines_count": 1}])
        self.assertEqual((kzt["total"], kzt["receipts_count"]), ("550.00", 1))
        self.assertEqual(kzt["parts"], [{"id": self.dairy.pk, "name": "Демо-молочное", "direct": False, "children_count": 0,
                                         "amount": "550.00", "lines_count": 1}])
        (item,) = kzt["items"]
        # Чек с молоком, хлебом «Не разобрано», нечитаемой строкой и пакетом: категории принадлежит только молоко.
        self.assertEqual({key: item[key] for key in ("receipt_id", "source", "purchased_on", "note", "owner", "owner_name",
                                                     "receipt_total", "category_amount")},
                         {"receipt_id": self.photo.pk, "source": "photo", "purchased_on": "2026-10-05", "note": "",
                          "owner": "local", "owner_name": "local", "receipt_total": "1000.00", "category_amount": "550.00"})
        self.assertEqual(item["store"]["id"], self.store.pk)
        self.assertEqual([(line["name"], line["amount"], line["category_id"], line["category_name"]) for line in item["lines"]],
                         [(item["lines"][0]["name"], "550.00", self.dairy.pk, "Демо-молочное")])

    def test_sub_category_parts_direct_spends_and_month_bounds(self):
        spend(local_user(), self.cafe, "100", date(2026, 10, 31), note="Обед")
        spend(local_user(), self.cafe, "5", date(2026, 11, 1))
        body = self.get(f"category={self.cafe.pk}&month=2026-10")
        (kzt,) = body["currencies"]
        self.assertEqual(kzt["total"], "550.00")
        # Подкатегория впереди по сумме, сама категория — последней.
        self.assertEqual([(part["name"], part["direct"], part["amount"]) for part in kzt["parts"]],
                         [("Демо-кофейни", False, "450.00"), ("Демо-кафе", True, "100.00")])
        # От новых к старым; 1 ноября и 31 августа (траты кафе) в октябрь не входят.
        self.assertEqual([(item["purchased_on"], item["note"], item["category_amount"]) for item in kzt["items"]],
                         [("2026-10-31", "Обед", "100.00"), ("2026-10-10", "Капучино", "450.00")])
        self.assertEqual(self.get(f"category={self.cafe.pk}&month=2026-08")["currencies"][0]["total"], "7.00")
        self.assertEqual(self.get(f"category={self.coffee.pk}&month=2026-09")["currencies"], [])

    def test_receipt_in_several_categories_shows_only_the_part_of_this_one(self):
        receipt = split_spend(local_user(), date(2026, 10, 20), [
            ("Сыр", "300", self.dairy), ("Кофе с собой", "200", self.coffee), ("Йогурт", "50.50", self.dairy)])
        kzt = self.get(f"category={self.food.pk}&month=2026-10")["currencies"][1]
        item = next(item for item in kzt["items"] if item["receipt_id"] == receipt.pk)
        self.assertEqual((item["receipt_total"], item["category_amount"]), ("550.50", "350.50"))
        self.assertEqual([(line["name"], line["amount"]) for line in item["lines"]], [("Сыр", "300.00"), ("Йогурт", "50.50")])
        self.assertEqual(kzt["total"], "900.50")
        cafe = self.get(f"category={self.cafe.pk}&month=2026-10")["currencies"][0]
        self.assertEqual(next(entry for entry in cafe["items"] if entry["receipt_id"] == receipt.pk)["category_amount"], "200.00")

    def test_service_charge_with_category_counts_and_deposit_does_not(self):
        make_line(self.photo, position=5, kind=ReceiptLine.Kind.SERVICE, raw_name="Чаевые", amount=D("80.00"),
                  category=self.cafe)
        make_line(self.photo, position=6, kind=ReceiptLine.Kind.DEPOSIT, raw_name="Залог", amount=D("30.00"),
                  category=self.cafe)
        kzt = self.get(f"category={self.cafe.pk}&month=2026-10")["currencies"][0]
        item = next(item for item in kzt["items"] if item["receipt_id"] == self.photo.pk)
        self.assertEqual((item["category_amount"], [line["amount"] for line in item["lines"]]), ("80.00", ["80.00"]))

    def test_absorbed_product_counts_at_the_target_category(self):
        stray = GenericProduct.objects.create(name="Демо-прочее", category=self.unassigned, base_unit=BaseUnit.PCS)
        duplicate = make_product(stray, "Демо-молоко дубль")
        make_line(self.photo, position=7, product=duplicate, amount=D("40.00"))
        self.assertEqual(self.get(f"category={self.food.pk}&month=2026-10")["currencies"][1]["total"], "550.00")
        absorb(make_product(GenericProduct.objects.get(name="Демо-молоко"), "Демо-молоко цель"), duplicate)
        self.assertEqual(self.get(f"category={self.food.pk}&month=2026-10")["currencies"][1]["total"], "590.00")

    def test_parameters(self):
        self.assertEqual(self.get("month=2026-10", status=400)["error"]["fields"], {"category": ["Обязательный параметр."]})
        self.assertEqual(list(self.get("category=x&month=2026-13", status=400)["error"]["fields"]), ["month", "category"])
        self.assertEqual(self.get("category=999999&month=2026-10", status=404)["error"]["code"], "not_found")
        self.assertEqual(APIClient().post(f"{URL}?category={self.food.pk}", {}, format="json").status_code, 405)
        with self.settings(ALLOW_LOCAL_RECOGNITION_API=False):
            self.assertEqual(APIClient().get(f"{URL}?category={self.food.pk}").status_code, 403)

    def test_query_count_does_not_grow_with_data(self):
        query = f"category={self.food.pk}&month=2026-10"
        # Категории, строки, категории товаров, чеки и основная валюта профиля (у демо несколько валют).
        with self.assertNumQueries(5):
            self.get(query)
        for number in range(25):
            leaf = Category.objects.create(name=f"Демо-лист {number}", parent=self.dairy)
            spend(local_user(), leaf, "10", date(2026, 10, 1 + number % 28), store_name=f"Демо-магазин {number}")
            split_spend(local_user(), date(2026, 10, 2), [("A", "1", leaf), ("B", "2", self.coffee)])
        with self.assertNumQueries(5):
            body = self.get(query)
        self.assertEqual(body["currencies"][1]["receipts_count"], 51)


@tag("integration")
@accounts_mode()
class CategorySpendsFamilyTests(FixtureMixin, TwoUsers, TestCase):
    """Чеки ``third`` видит ``first`` из той же семьи; ``second`` вне семьи — только свои."""

    @classmethod
    def fixture_owner(cls):
        cls.third = make_user("synthetic-user-three")
        family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=family)
        return cls.third

    def get(self, account, category):
        response = self.client_of(account).get(f"{URL}?category={category.pk}&month=2026-10")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_family_sees_family_spends_outsider_only_own(self):
        spend(self.first, self.coffee, "50", date(2026, 10, 11))
        spend(self.second, self.coffee, "70", date(2026, 10, 11))
        for account in (self.first, self.third):
            (kzt,) = self.get(account, self.cafe)["currencies"]
            self.assertEqual((kzt["total"], sorted(item["owner"] for item in kzt["items"])),
                             ("500.00", ["synthetic-user-one", "synthetic-user-three"]))
        (own,) = self.get(self.second, self.cafe)["currencies"]
        self.assertEqual((own["total"], [item["owner"] for item in own["items"]]), ("70.00", ["synthetic-user-two"]))

    def test_guest_is_not_authenticated(self):
        self.assertEqual(APIClient().get(f"{URL}?category={self.cafe.pk}").status_code, 401)
