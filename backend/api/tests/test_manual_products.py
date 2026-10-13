"""Названная покупка траты вручную — товар каталога (2026-10-13).

«Что купили» (``item_name``) и позиции траты связываются с товаром по правилу импорта чеков
(``receipts.manual.find_or_create_products``); строка «<категория>» товаром не бывает. Цена такой
строки — наблюдение цены с признаком ``manual``, у траты без места ``store`` — ``null``. Категория
строки — из формы. Данные вымышленные; модель не вызывается.
"""
from datetime import date
from decimal import Decimal

from django.test import TestCase, tag
from django.utils import timezone
from rest_framework.test import APIClient

from api.tests.accounts_helpers import TwoUsers, accounts_mode, local_single_mode
from api.tests.factories import make_product, make_receipt
from accounts.models import Household, Membership
from catalog.models import Brand, Category, GenericProduct, Product
from classification.models import ProductClassification
from merges import services as merges
from merges.models import ProductMerge, ProductMergeMember
from receipts.models import ProductAlias, Receipt, ReceiptLine
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line

D = Decimal
MANUAL = "/api/receipts/manual/"


class NamedMixin:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.subs = Category.objects.create(name="Демо-подписки")
        cls.beauty = Category.objects.create(name="Демо-красота")

    def save(self, client=None, **body):
        body = {"total": "225", "currency": "USD", "category": self.subs.pk, "purchased_on": "2026-10-01", **body}
        response = (client or self.client).post(MANUAL, body, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()["id"]

    def line(self, receipt_id):
        return ReceiptLine.objects.select_related("product__generic__category", "receipt__store").get(receipt_id=receipt_id)

    def patch(self, receipt_id, body):
        response = self.client.patch(f"/api/receipts/{receipt_id}/", body, format="json")
        self.assertEqual(response.status_code, 200, response.content)
        return self.line(receipt_id)

    def pending_merge(self, kept, absorbed):
        group = ProductMerge.objects.create(target_ref=kept.pk, detector_version=1)
        for product, role in ((kept, "target"), (absorbed, "source")):
            ProductMergeMember.objects.create(group=group, product_ref=product.pk, active_product=product, role=role,
                                              name=product.name)
        return group


@tag("integration")
@local_single_mode()
class NamedPurchaseTests(NamedMixin, TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_item_name_names_the_line_and_makes_a_product_in_unassigned(self):
        line = self.line(self.save(item_name=" Подписка Claude Max 20x "))
        self.assertEqual((line.raw_name, line.quantity, line.unit_price, line.amount, line.category_id),
                         ("Подписка Claude Max 20x", D("1.000"), D("225.0000"), D("225.00"), self.subs.pk))
        self.assertEqual(line.product.name, "Подписка Claude Max 20x")
        self.assertEqual((line.product.generic.name, line.product.generic.category.name), ("Не разобрано", "Не разобрано"))
        self.assertIsNone(line.product.brand_id)
        [shown] = self.client.get(f"/api/receipts/{line.receipt_id}/lines/").json()["results"]
        self.assertEqual((shown["product"], shown["category"], shown["matching_status"]), (
            {"id": line.product_id, "name": "Подписка Claude Max 20x"}, {"id": self.subs.pk, "name": "Демо-подписки"},
            "matched"))
        self.assertEqual(self.client.get(f"/api/receipts/{line.receipt_id}/").json()["unmatched_products_count"], 0)

    def test_without_a_name_there_is_no_product(self):
        for name in (None, "", "   "):
            with self.subTest(name=name):
                line = self.line(self.save(**({} if name is None else {"item_name": name})))
                self.assertEqual((line.raw_name, line.product_id), ("Демо-подписки", None))
        self.assertFalse(Product.objects.exists())

    def test_the_same_name_finds_the_same_product(self):
        first = self.line(self.save(item_name="Стрижка", category=self.beauty.pk, total="5000", currency="KZT"))
        second = self.line(self.save(item_name="  стрижка ", category=self.beauty.pk, total="6000", currency="KZT"))
        self.assertEqual(first.product_id, second.product_id)
        self.assertEqual(second.raw_name, "стрижка")
        self.assertEqual(Product.objects.count(), 1)

    def test_a_product_of_receipts_is_found_by_name_and_the_line_keeps_its_category(self):
        generic = GenericProduct.objects.create(name="Демо-кроссовки", category=self.beauty, base_unit="pcs")
        sneakers = make_product(generic, "Кроссовки Nike Pegasus")
        line = self.line(self.save(item_name="кроссовки   nike pegasus"))
        self.assertEqual((line.product_id, line.category_id), (sneakers.pk, self.subs.pk))
        self.assertEqual(Product.objects.count(), 1)

    def test_two_products_of_one_name_are_ambiguous_as_in_the_import(self):
        generic = GenericProduct.objects.create(name="Демо-молоко", category=self.beauty, base_unit="l")
        for brand in ("Демо-А", "Демо-Б"):
            make_product(generic, "Молоко", brand=Brand.objects.create(name=brand))
        line = self.line(self.save(item_name="Молоко"))
        self.assertEqual((line.raw_name, line.product_id), ("Молоко", None))
        self.assertEqual(Product.objects.count(), 2)

    def test_positions_are_products_too(self):
        receipt_id = self.save(total=None, currency="KZT", lines=[
            {"name": "Шампунь", "amount": "2500", "category": self.beauty.pk}, {"name": "Стрижка", "amount": "5000"}])
        lines = ReceiptLine.objects.filter(receipt_id=receipt_id).order_by("position")
        self.assertEqual([(line.product.name, line.category_id) for line in lines],
                         [("Шампунь", self.beauty.pk), ("Стрижка", self.subs.pk)])
        refused = self.client.post(MANUAL, {"currency": "KZT", "item_name": "Стрижка",
                                            "lines": [{"name": "Шампунь", "amount": "1"}]}, format="json")
        self.assertEqual(refused.status_code, 400)
        self.assertEqual(refused.json()["error"]["fields"], {"item_name": ["У траты с позициями покупки называют позициями."]})

    def test_bad_item_names(self):
        for value, message in (("x" * 201, "Слишком длинное значение."), (5, "Неверный тип значения.")):
            with self.subTest(value=value):
                response = self.client.post(MANUAL, {"total": "1", "category": self.subs.pk, "item_name": value},
                                            format="json")
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json()["error"]["fields"], {"item_name": [message]})

    def test_the_spelling_of_the_place_leads_to_its_product_and_a_spend_writes_none(self):
        line = self.line(self.save(item_name="Claude Max", store_name="Anthropic"))
        self.assertFalse(ProductAlias.objects.exists())  # «Что купили» — личный текст: написанием не становится
        renamed = make_product(line.product.generic, "Подписка Claude Max 20x")
        ProductAlias.objects.create(merchant_id=line.receipt.store.merchant_id, product=renamed, name_key="claude max",
                                    raw_name="CLAUDE MAX")  # как запомнил бы импорт чека с фото
        self.assertEqual(self.line(self.save(item_name="CLAUDE MAX", store_name="Anthropic")).product_id, renamed.pk)
        # Без места написаний нет: товар — по названию.
        self.assertEqual(self.line(self.save(item_name="Claude Max")).product_id, line.product_id)
        self.assertEqual(line.product.scope, f"user:{local_user().pk}")

    def test_a_merged_duplicate_leads_to_the_kept_product(self):
        generic = GenericProduct.objects.create(name="Демо-подписка", category=self.subs, base_unit="pcs")
        kept = make_product(generic, "Подписка Claude Max 20x")
        absorbed = make_product(generic, "Claude Max подписка")
        group = self.pending_merge(kept, absorbed)
        receipt_id = self.save(item_name="claude max подписка")
        self.assertEqual(self.line(receipt_id).product_id, kept.pk)
        # Подтверждённое слияние: поглощённого товара нет, его название ведёт к оставляемому.
        gone = make_product(generic, "Claude подписка")
        confirmed = ProductMerge.objects.create(target_ref=kept.pk, detector_version=1, status="confirmed",
                                                resolved_at=timezone.now())
        ProductMergeMember.objects.create(group=confirmed, product_ref=gone.pk, role="source", name=gone.name)
        gone.delete()
        self.assertEqual(self.line(self.save(item_name="Claude подписка")).product_id, kept.pk)
        self.assertEqual(Product.objects.count(), 2)
        # Отмена ожидающего слияния не спотыкается о строку траты без места: она остаётся у оставляемого.
        merges.cancel(group.pk)
        self.assertEqual(self.line(receipt_id).product_id, kept.pk)

    def test_patch_renames_and_relinks_and_delete_keeps_the_product(self):
        receipt_id = self.save(item_name="Подписка ChatGPT Plus", total="20")
        old = self.line(receipt_id).product_id
        line = self.patch(receipt_id, {"item_name": "Подписка Claude Max 20x"})
        self.assertEqual((line.raw_name, line.amount, line.category_id), ("Подписка Claude Max 20x", D("20.00"), self.subs.pk))
        self.assertNotEqual(line.product_id, old)
        renamed = line.product_id
        # Сумма и категория без названия: покупка остаётся собой.
        line = self.patch(receipt_id, {"total": "225", "category": self.beauty.pk})
        self.assertEqual((line.raw_name, line.product_id, line.amount, line.category_id),
                         ("Подписка Claude Max 20x", renamed, D("225.00"), self.beauty.pk))
        # Форма шлёт lines: [] и item_name.
        line = self.patch(receipt_id, {"lines": [], "item_name": "Подписка Claude Max 20x", "total": "200",
                                       "category": self.subs.pk})
        self.assertEqual((line.raw_name, line.product_id, line.amount), ("Подписка Claude Max 20x", renamed, D("200.00")))
        # Пустое название — снова строка «<категория>» без товара, и она следует за категорией.
        line = self.patch(receipt_id, {"item_name": ""})
        self.assertEqual((line.raw_name, line.product_id), ("Демо-подписки", None))
        line = self.patch(receipt_id, {"category": self.beauty.pk})
        self.assertEqual((line.raw_name, line.product_id), ("Демо-красота", None))
        self.assertEqual(self.client.delete(f"/api/receipts/{receipt_id}/").status_code, 204)
        self.assertEqual(set(Product.objects.values_list("pk", flat=True)), {old, renamed})

    def test_itemized_spend_refuses_an_item_name(self):
        receipt_id = self.save(total=None, currency="KZT", lines=[{"name": "А", "amount": "1"}, {"name": "Б", "amount": "2"}])
        response = self.client.patch(f"/api/receipts/{receipt_id}/", {"item_name": "В"}, format="json")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["fields"], {"item_name": ["У траты с позициями покупки называют позициями."]})

    def test_the_category_of_the_line_stays_in_the_statistics(self):
        # Товар в «Не разобрано», строка — в категории формы: траты по категориям от товара не зависят.
        receipt_id = self.save(item_name="Подписка Claude Max 20x", total="225", currency="KZT")
        response = self.client.get("/api/stats/spending/?date_from=2026-10-01&date_to=2026-10-31")
        [block] = response.json()["currencies"]
        self.assertEqual([(item["kind"], item["id"], item["amount"]) for item in block["items"]],
                         [("category", self.subs.pk, "225.00")])
        by_product = self.client.get("/api/stats/spending/?date_from=2026-10-01&date_to=2026-10-31&group_by=product")
        self.assertEqual([item["name"] for item in by_product.json()["currencies"][0]["items"]], ["Подписка Claude Max 20x"])
        [listed] = self.client.get("/api/receipts/").json()["results"]
        self.assertEqual((listed["id"], listed["category"]), (receipt_id, {"id": self.subs.pk, "name": "Демо-подписки"}))
        dashboard = self.client.get("/api/dashboard/?month=2026-10").json()
        self.assertEqual([item["category_name"] for item in dashboard["recent"]], ["Демо-подписки"])


@tag("integration")
@local_single_mode()
class ManualPriceTests(NamedMixin, TestCase):
    """Цена названной покупки — в истории цен, графике, сводке и сравнении с признаком ``manual``."""

    def setUp(self):
        self.client = APIClient()
        self.store = samples.lidl_store()
        self.generic = GenericProduct.objects.create(name="Демо-подписка", category=self.subs, base_unit="pcs")
        self.product = make_product(self.generic, "Подписка Claude Max 20x")
        receipt = make_receipt(self.store, "EUR", date(2026, 9, 1), owner=local_user(), total=D("200.00"))
        make_line(receipt, product=self.product, raw_name="CLAUDE MAX", unit_price=D("200.0000"), amount=D("200.00"))
        self.receipt_id = self.save(item_name="Подписка Claude Max 20x", total="225", currency="USD")

    def get(self, url):
        response = self.client.get(url)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_points_carry_manual_and_no_place(self):
        points = self.get(f"/api/products/{self.product.pk}/prices/")["results"]
        self.assertEqual([(point["currency"], point["paid_unit_price"], point["manual"], point["store"]) for point in points], [
            ("EUR", "200.0000", False, {"id": self.store.pk, "name": "Lidl", "city": "Lindau", "country": "DE"}),
            ("USD", "225.0000", True, None)])
        self.assertEqual((points[1]["receipt_id"], points[1]["quantity"], points[1]["own"]), (self.receipt_id, "1.000", True))

    def test_product_list_and_card(self):
        [product] = self.get(f"/api/products/?q={self.product.name}")["results"]
        self.assertEqual([(price["country"], price["currency"], price["last"]["manual"], price["last"]["store_id"])
                          for price in product["prices"]], [("DE", "EUR", False, self.store.pk), (None, "USD", True, None)])
        card = self.get(f"/api/products/{self.product.pk}/")
        self.assertEqual([store["id"] for store in card["stores"]], [self.store.pk])  # без места — не магазин
        self.assertEqual(self.get(f"/api/generic-products/{self.generic.pk}/")["countries"], ["DE"])
        self.assertEqual(self.get("/api/products/?has_prices=1&q=Claude")["count"], 1)

    def test_series_of_manual_prices_are_their_own(self):
        body = self.get(f"/api/products/{self.product.pk}/prices/series/")
        self.assertEqual([(line["role"], line["store"] and line["store"]["id"], line["country"], line["currency"],
                           line["manual"], line["observations"]) for line in body["series"]],
                         [("own", self.store.pk, "DE", "EUR", False, 1), ("own", None, None, "USD", True, 1)])

    def test_summary_by_store_and_comparison(self):
        summary = self.get(f"/api/products/{self.product.pk}/prices/summary/?group_by=store")
        self.assertEqual([(group["store"] and group["store"]["id"], group["currency"]) for group in summary["groups"]],
                         [(self.store.pk, "EUR"), (None, "USD")])
        offers = self.get(f"/api/products/{self.product.pk}/alternatives/")["results"][0]["offers"]
        self.assertEqual([(offer["country"], offer["currency"], offer["last"]["store"], offer["last"]["manual"])
                          for offer in offers], [("DE", "EUR", offers[0]["last"]["store"], False), (None, "USD", None, True)])

    def test_hidden_spend_is_no_price(self):
        Receipt.objects.filter(pk=self.receipt_id).update(hidden=True)
        self.assertEqual(self.get(f"/api/products/{self.product.pk}/prices/")["count"], 1)

    def test_lines_of_a_merge_group_show_no_place(self):
        absorbed = make_product(self.generic, "Claude Max")
        group = self.pending_merge(self.product, absorbed)
        lines = self.get(f"/api/product-merges/{group.pk}/lines/")["results"]
        self.assertEqual([line["store"] and line["store"]["id"] for line in lines], [self.store.pk, None])


@tag("integration")
class PrivatePurchaseTests(TwoUsers, NamedMixin, TestCase):
    """«Что купили» — личный текст: товар только из чужих трат вручную и их цены другой семье не видны нигде.

    ``first`` и ``second`` — разные «семьи» (без общей семьи каждый видит только своё); модератор — третий.
    """

    def setUp(self):
        self.mode = accounts_mode()
        self.mode.enable()
        self.addCleanup(self.mode.disable)
        self.private = self.line(self.save(self.client_of(self.first), item_name="Психотерапевт", total="30000",
                                           currency="KZT")).product

    def get(self, account, url):
        return self.client_of(account).get(url)

    def test_a_private_product_is_not_in_the_catalogue_of_another_family(self):
        pk = self.private.pk
        for account, seen in ((self.first, True), (self.second, False), (self.moderator, False)):
            with self.subTest(account=account.username):
                found = self.get(account, "/api/products/?q=Психотерапевт").json()["results"]
                self.assertEqual([item["id"] for item in found], [pk] if seen else [])
                self.assertEqual(self.get(account, "/api/products/").json()["count"], 1 if seen else 0)
                for url in (f"/api/products/{pk}/", f"/api/products/{pk}/prices/", f"/api/products/{pk}/prices/series/",
                            f"/api/products/{pk}/prices/summary/", f"/api/products/{pk}/alternatives/"):
                    self.assertEqual(self.get(account, url).status_code, 200 if seen else 404, url)
                generic = self.private.generic
                [row] = [item for item in self.get(account, "/api/categories/").json()["results"]
                         if item["id"] == generic.category_id]
                self.assertEqual(row["products_count"], 1 if seen else 0)
                self.assertEqual(self.get(account, f"/api/generic-products/{generic.pk}/").json()["products_count"],
                                 1 if seen else 0)
                comparison = self.get(account, f"/api/generic-products/{generic.pk}/comparison/").json()
                self.assertEqual([item["product"]["id"] for item in comparison["results"]], [pk] if seen else [])

    def test_a_shared_product_shows_no_foreign_manual_point(self):
        store = samples.lidl_store()
        generic = GenericProduct.objects.create(name="Демо-молоко", category=self.subs, base_unit="pcs")
        milk = make_product(generic, "Молоко Демо 1 л")
        receipt = make_receipt(store, "EUR", date(2026, 9, 1), owner=self.second, total=D("1.00"))
        make_line(receipt, product=milk, raw_name="MILCH", unit_price=D("1.0000"), amount=D("1.00"))
        own = self.save(self.client_of(self.first), item_name="молоко демо 1 л", total="3", currency="EUR")
        self.assertEqual(self.line(own).product_id, milk.pk)
        for account, manual_points in ((self.first, [True]), (self.second, [])):
            with self.subTest(account=account.username):
                points = self.get(account, f"/api/products/{milk.pk}/prices/").json()["results"]
                self.assertEqual([point["manual"] for point in points if point["manual"]], manual_points)
                self.assertEqual(len(points), 1 + len(manual_points))
                [product] = self.get(account, "/api/products/?q=Молоко").json()["results"]
                self.assertEqual([price["last"]["manual"] for price in product["prices"]], [False, *manual_points])
                series = self.get(account, f"/api/products/{milk.pk}/prices/series/").json()["series"]
                self.assertEqual([line["manual"] for line in series], [False, *manual_points])
                summary = self.get(account, f"/api/products/{milk.pk}/prices/summary/?group_by=store").json()
                self.assertEqual(sum(group["total"]["count"] for group in summary["groups"]), 1 + len(manual_points))
                offers = self.get(account, f"/api/products/{milk.pk}/alternatives/").json()["results"][0]["offers"]
                self.assertEqual([offer["last"]["manual"] for offer in offers], [False, *manual_points])
                card = self.get(account, f"/api/products/{milk.pk}/").json()
                self.assertEqual([item["id"] for item in card["stores"]], [store.pk])

    def test_a_namesake_of_another_family_gets_a_product_of_its_own(self):
        theirs = self.line(self.save(self.client_of(self.second), item_name="Психотерапевт", total="25000",
                                     currency="KZT")).product
        self.assertNotEqual(theirs.pk, self.private.pk)
        self.assertEqual((theirs.name, theirs.scope, self.private.scope),
                         ("Психотерапевт", f"user:{self.second.pk}", f"user:{self.first.pk}"))
        for account, product in ((self.first, self.private), (self.second, theirs)):
            with self.subTest(account=account.username):
                found = self.get(account, "/api/products/?q=Психотерапевт").json()["results"]
                self.assertEqual([item["id"] for item in found], [product.pk])
                points = self.get(account, f"/api/products/{product.pk}/prices/").json()["results"]
                self.assertEqual([point["own"] for point in points], [True])
        # Свой тёзка находится: вторая трата той же семьи — тот же товар.
        again = self.line(self.save(self.client_of(self.second), item_name="психотерапевт", currency="KZT"))
        self.assertEqual(again.product_id, theirs.pk)

    def test_the_family_sees_its_product_and_manual_points(self):
        family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=self.first, household=family, role="head")
        Membership.objects.create(user=self.second, household=family)
        head = self.line(self.save(self.client_of(self.first), item_name="Семейный врач", total="30000", currency="KZT"))
        member = self.line(self.save(self.client_of(self.second), item_name="семейный врач", total="35000", currency="KZT"))
        self.assertEqual((member.product_id, head.product.scope), (head.product_id, f"household:{family.pk}"))
        for account in (self.first, self.second):
            with self.subTest(account=account.username):
                points = self.get(account, f"/api/products/{head.product_id}/prices/").json()["results"]
                self.assertEqual([(point["paid_unit_price"], point["manual"]) for point in points],
                                 [("30000.0000", True), ("35000.0000", True)])
        self.assertEqual(self.get(self.moderator, f"/api/products/{head.product_id}/").status_code, 404)
        # Товар, заведённый до семьи, — свой (user:<id>): член семьи его не видит и заводит семейный.
        self.assertEqual(self.get(self.second, f"/api/products/{self.private.pk}/").status_code, 404)

    def test_a_deleted_spend_opens_nothing(self):
        receipt_id = ReceiptLine.objects.get(product=self.private).receipt_id
        self.assertEqual(self.client_of(self.first).delete(f"/api/receipts/{receipt_id}/").status_code, 204)
        self.assertFalse(ReceiptLine.objects.filter(product=self.private).exists())
        self.assertEqual(self.get(self.second, f"/api/products/{self.private.pk}/").status_code, 404)
        self.assertEqual(self.get(self.second, "/api/products/?q=Психотерапевт").json()["results"], [])
        # Fail-closed: без видимой строки личный товар не виден и автору; новая трата с тем же названием вернёт его.
        self.assertEqual(self.get(self.first, f"/api/products/{self.private.pk}/").status_code, 404)
        again = self.line(self.save(self.client_of(self.first), item_name="Психотерапевт", currency="KZT"))
        self.assertEqual(again.product_id, self.private.pk)

    def test_a_hidden_payment_and_visible_from_hide_the_name_from_a_member(self):
        family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=self.first, household=family, role="head")
        membership = Membership.objects.create(user=self.second, household=family)
        hidden = self.line(self.save(self.client_of(self.first), item_name="Подарок Лене", currency="KZT"))
        early = self.line(self.save(self.client_of(self.first), item_name="Врач в июле", currency="KZT",
                                    purchased_on="2026-07-01"))
        Receipt.objects.filter(pk=hidden.receipt_id).update(hidden=True)
        membership.visible_from = date(2026, 9, 1)
        membership.save()
        for product in (hidden.product, early.product):
            with self.subTest(product=product.name):
                self.assertEqual(self.get(self.first, f"/api/products/{product.pk}/").status_code, 200)  # главный
                self.assertEqual(self.get(self.second, f"/api/products/{product.pk}/").status_code, 404)
                self.assertEqual(self.get(self.second, f"/api/products/?q={product.name}").json()["results"], [])
        # Член семьи с тем же названием в другом регистре получает свой товар: чужое написание не открывается.
        mine = self.line(self.save(self.client_of(self.second), item_name="подарок лене", currency="KZT")).product
        self.assertEqual(mine.name, "подарок лене")
        self.assertNotEqual(mine.pk, hidden.product_id)

    def test_own_private_namesake_wins_over_a_shared_one(self):
        shared = make_product(self.private.generic, "ПСИХОТЕРАПЕВТ")  # общий тёзка из чека с фото
        again = self.line(self.save(self.client_of(self.first), item_name="психотерапевт", currency="KZT"))
        self.assertEqual(again.product_id, self.private.pk)
        other = self.line(self.save(self.client_of(self.second), item_name="психотерапевт", currency="KZT"))
        self.assertEqual(other.product_id, shared.pk)  # у другой семьи — общий товар

    def test_a_receipt_with_a_photo_never_joins_a_private_product(self):
        from types import SimpleNamespace

        from recognition import importer

        hint = SimpleNamespace(gtin=None, name=None, brand=None, package_quantity=None, package_unit=None)
        observed = SimpleNamespace(kind="product", product_hint=hint, barcode=None, raw_name="ПСИХОТЕРАПЕВТ",
                                   store_item_code="")
        merchant = samples.lidl_store().merchant
        resolution = importer._resolve_product(observed, merchant, field="/lines/0/product_hint")
        shared = resolution.product
        self.assertEqual((shared.name, shared.scope, resolution.issues), ("ПСИХОТЕРАПЕВТ", "", []))
        self.assertNotEqual(shared.pk, self.private.pk)
        self.assertFalse(ProductAlias.objects.filter(product=self.private).exists())
        # Повтор находит общий товар по написанию; чек с фото самой семьи A — тоже общий, не её личный.
        self.assertEqual(importer._resolve_product(observed, merchant, field="/lines/0/product_hint").product.pk, shared.pk)
        own = importer._resolve_product(observed, samples.shop_store().merchant, field="/lines/0/product_hint")
        self.assertEqual((own.product.pk, own.issues), (shared.pk, []))
        self.assertFalse(ProductAlias.objects.filter(product__scope__gt="").exists())

    def test_duplicates_and_suggestions_do_not_show_a_private_product(self):
        theirs = self.line(self.save(self.client_of(self.second), item_name="Психотерапевт", currency="KZT")).product
        proposals = merges.detect(dry_run=True).proposals
        self.assertFalse([proposal for proposal in proposals
                          if {self.private.pk, theirs.pk} & set(proposal.get("product_ids", ()))])
        shared = make_product(self.private.generic, "Психотерапевт (каталог)")
        group = self.pending_merge(shared, self.private)
        self.assertEqual(self.get(self.moderator, "/api/product-merges/").json()["count"], 0)
        self.assertEqual(self.get(self.moderator, f"/api/product-merges/{group.pk}/").status_code, 404)
        self.assertEqual(self.get(self.first, f"/api/product-merges/{group.pk}/").status_code, 200)
        record = ProductClassification.objects.create(
            product_ref=self.private.pk, active_product=self.private, product_name=self.private.name,
            previous_generic_ref=self.private.generic_id, previous_generic_name="Не разобрано",
            previous_generic_base_unit="pcs", suggested_generic_ref=self.private.generic_id,
            suggested_generic_name="Психотерапия", suggested_base_unit="pcs", classifier_version=1, provider="fake",
            prompt_version="v1", schema_version="v1")
        self.assertEqual(self.get(self.second, "/api/product-classifications/").json()["count"], 0)
        self.assertEqual(self.get(self.second, f"/api/product-classifications/{record.pk}/").status_code, 404)
        self.assertEqual(self.get(self.first, "/api/product-classifications/").json()["count"], 1)
