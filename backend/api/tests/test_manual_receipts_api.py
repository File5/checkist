"""Трата без чека: ``/api/receipts/manual/``, ``PATCH`` / ``DELETE /api/receipts/{id}/``.

Данные вымышленные; модель распознавания не вызывается.
"""
from datetime import date, datetime, timezone as dt_timezone
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.test import TestCase, override_settings, tag
from django.utils import timezone
from rest_framework.test import APIClient

from api.tests.accounts_helpers import (
    NOT_AUTHENTICATED, NOT_FOUND, TwoUsers, accounts_mode, local_single_mode,
)
from api.tests.factories import make_product, make_receipt
from catalog.models import Category, GenericProduct
from receipts.models import Receipt, ReceiptLine
from receipts.ownership import local_user
from receipts.prices import price_history
from receipts.tests import samples
from receipts.tests.test_models import make_line
from stores.models import Store

D = Decimal
MANUAL = "/api/receipts/manual/"
READ_ONLY = {"error": {
    "code": "receipt_read_only",
    "message": "Чек с фото через API не правится: изменять можно только трату, внесённую вручную.",
}}


def fields(response):
    return response.json()["error"]["fields"]


class ManualMixin:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.food = Category.objects.create(name="Демо-еда")
        cls.cafe = Category.objects.create(name="Демо-кафе", parent=cls.food)
        cls.transport = Category.objects.create(name="Демо-транспорт")

    def post(self, client, body):
        return client.post(MANUAL, body, format="json")

    def lines(self, receipt_id):
        return list(ReceiptLine.objects.filter(receipt_id=receipt_id).order_by("position")
                    .values_list("raw_name", "amount", "quantity", "category_id", "product_id"))


@tag("integration")
@local_single_mode()
class ManualCreateTests(ManualMixin, TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_simple_spend_is_one_line_in_its_category(self):
        response = self.post(self.client, {"total": "450", "currency": "KZT", "category": self.cafe.pk,
                                           "purchased_on": "2026-10-01", "note": " кофе с другом "})
        self.assertEqual(response.status_code, 201, response.content)
        body = response.json()
        self.assertEqual(body["source"], "manual")
        self.assertIsNone(body["store"])
        self.assertEqual((body["total"], body["currency"], body["purchased_on"]), ("450.00", "KZT", "2026-10-01"))
        self.assertEqual(body["note"], "кофе с другом")
        self.assertEqual((body["lines_count"], body["unmatched_products_count"]), (1, 0))
        self.assertFalse(body["review_required"])
        self.assertEqual(self.lines(body["id"]), [("Демо-кафе", D("450.00"), D("1.000"), self.cafe.pk, None)])
        receipt = Receipt.objects.get(pk=body["id"])
        self.assertEqual(receipt.owner, local_user())
        self.assertEqual(receipt.operation, "sale")
        line = self.client.get(f"/api/receipts/{body['id']}/lines/").json()["results"][0]
        self.assertEqual(line["category"], {"id": self.cafe.pk, "name": "Демо-кафе"})
        self.assertIsNone(line["product"])
        listed = self.client.get("/api/receipts/").json()["results"]
        self.assertEqual([(item["id"], item["source"], item["store"]) for item in listed], [(body["id"], "manual", None)])
        self.assertEqual(self.client.get("/api/receipts/?q=другом").json()["count"], 1)

    def test_defaults_today_and_last_currency(self):
        response = self.post(self.client, {"total": 10, "category": self.food.pk})
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["currency"], "KZT")  # чеков ещё нет
        self.assertEqual(response.json()["purchased_on"], timezone.localdate().isoformat())
        store = samples.lidl_store()
        make_receipt(store, "EUR", date(2026, 9, 1), owner=local_user(), total=D("1.00"))
        later = self.post(self.client, {"total": "2.5", "category": self.food.pk, "purchased_on": "2020-01-01"})
        self.assertEqual(later.json()["currency"], "KZT")  # последний по моменту покупки — ручная трата сегодня
        Receipt.objects.filter(source="manual").delete()
        self.assertEqual(self.post(self.client, {"total": "2.5", "category": self.food.pk}).json()["currency"], "EUR")

    def test_two_identical_spends_are_two_spends(self):
        body = {"total": "300", "currency": "KZT", "category": self.cafe.pk, "purchased_on": "2026-10-01",
                "store_name": "Демо-кофейня"}
        first, second = self.post(self.client, body), self.post(self.client, body)
        self.assertEqual((first.status_code, second.status_code), (201, 201))
        self.assertNotEqual(first.json()["id"], second.json()["id"])
        self.assertEqual(first.json()["store"]["id"], second.json()["store"]["id"])
        Receipt.objects.filter(pk=second.json()["id"]).update(
            purchased_at=Receipt.objects.get(pk=first.json()["id"]).purchased_at)  # тот же момент, тот же итог
        self.assertEqual(Receipt.objects.filter(source="manual").count(), 2)

    def test_store_name_finds_existing_store_or_creates_one(self):
        store = samples.lidl_store()
        found = self.post(self.client, {"total": "5", "category": self.food.pk, "store_name": store.merchant.brand_name.upper()})
        self.assertEqual(found.json()["store"]["id"], store.pk)
        count = Store.objects.count()
        created = self.post(self.client, {"total": "5", "currency": "RUB", "category": self.food.pk,
                                          "store_name": "Демо-рынок у дома"})
        self.assertEqual(created.status_code, 201, created.content)
        self.assertEqual(Store.objects.count(), count + 1)
        new = Store.objects.get(pk=created.json()["store"]["id"])
        self.assertEqual((new.name, new.country_id, new.timezone, new.merchant.brand_name),
                         ("Демо-рынок у дома", "RU", "Europe/Moscow", "Демо-рынок у дома"))
        again = self.post(self.client, {"total": "6", "category": self.food.pk, "store_name": "демо-рынок у дома"})
        self.assertEqual(again.json()["store"]["id"], new.pk)
        self.assertIsNone(self.post(self.client, {"total": "1", "category": self.food.pk, "store_name": "  "}).json()["store"])

    def test_lines_named_by_person_with_total_from_lines(self):
        response = self.post(self.client, {"category": self.food.pk, "currency": "KZT", "lines": [
            {"name": "Хлеб", "amount": "250.50"},
            {"name": "Такси", "amount": 1200, "category": self.transport.pk},
            {"name": "Яблоки", "amount": "900", "quantity": "1.5"},
        ]})
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()["total"], "2350.50")
        self.assertEqual(self.lines(response.json()["id"]), [
            ("Хлеб", D("250.50"), D("1.000"), self.food.pk, None),
            ("Такси", D("1200.00"), D("1.000"), self.transport.pk, None),
            ("Яблоки", D("900.00"), D("1.500"), self.food.pk, None),
        ])
        self.assertEqual(ReceiptLine.objects.get(raw_name="Яблоки").unit_price, D("600.0000"))
        # Позиция без категории и без общей категории — несопоставленная строка, как у чека.
        loose = self.post(self.client, {"lines": [{"name": "Что-то", "amount": "10"}]})
        self.assertEqual(loose.status_code, 201, loose.content)
        self.assertEqual(loose.json()["unmatched_products_count"], 1)

    def test_validation_errors(self):
        cases = [
            ({}, {"total": ["Обязательное поле."], "category": ["Обязательное поле."]}),
            ({"total": "-5", "category": self.food.pk}, {"total": ["Сумма больше нуля, не больше двух знаков после запятой."]}),
            ({"total": "1.234", "category": self.food.pk}, {"total": ["Сумма больше нуля, не больше двух знаков после запятой."]}),
            ({"total": "0", "category": self.food.pk}, {"total": ["Сумма больше нуля, не больше двух знаков после запятой."]}),
            ({"total": True, "category": self.food.pk}, {"total": ["Сумма больше нуля, не больше двух знаков после запятой."]}),
            ({"total": "5", "category": 999999}, {"category": ["Значение не найдено."]}),
            ({"total": "5", "category": "1"}, {"category": ["Неверный тип значения."]}),
            ({"total": "5", "category": self.food.pk, "currency": "XYZ"}, {"currency": ["Значение не найдено."]}),
            ({"total": "5", "category": self.food.pk, "currency": "12"}, {"currency": ["Код валюты — три буквы."]}),
            ({"total": "5", "category": self.food.pk, "purchased_on": "2026-02-30"}, {"purchased_on": ["Дата в формате ГГГГ-ММ-ДД."]}),
            ({"total": "5", "category": self.food.pk, "store": 1}, {"store": ["Неизвестное поле."]}),
            ({"total": "5", "category": self.food.pk, "note": "x" * 1001}, {"note": ["Слишком длинное значение."]}),
            ({"total": "10", "lines": [{"name": "А", "amount": "4"}, {"name": "Б", "amount": "5"}]},
             {"total": ["Итог не совпадает с суммой позиций."]}),
            ({"lines": [{"name": " ", "amount": "4"}, {"amount": "x", "quantity": "-1", "category": 999999, "price": 1}]},
             {"lines.0.name": ["Значение не может быть пустым."], "lines.1.name": ["Неверный тип значения."],
              "lines.1.amount": ["Сумма больше нуля, не больше двух знаков после запятой."],
              "lines.1.quantity": ["Количество больше нуля, не больше трёх знаков после запятой."],
              "lines.1.category": ["Значение не найдено."], "lines.1.price": ["Неизвестное поле."]}),
            ({"lines": [{"name": "А", "amount": "1"}] * 101}, {"lines": ["Не больше 100 позиций."]}),
        ]
        for body, expected in cases:
            with self.subTest(body=str(body)[:80]):
                response = self.post(self.client, body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(response.json()["error"]["code"], "invalid_parameter")
                self.assertEqual(fields(response), expected)
        self.assertFalse(Receipt.objects.exists())

    def test_body_must_be_a_json_object(self):
        self.assertEqual(self.client.post(MANUAL, "[]", content_type="application/json").json()["error"]["code"],
                         "invalid_request")
        self.assertEqual(self.client.post(MANUAL, "", content_type="application/json").status_code, 400)
        self.assertEqual(self.client.post(MANUAL, {"total": "1"}).status_code, 415)

    def test_form_defaults(self):
        for _ in range(2):
            self.post(self.client, {"total": "1", "category": self.transport.pk})
        self.post(self.client, {"total": "1", "category": self.cafe.pk})
        response = self.client.get(MANUAL)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"currency": "KZT", "frequent_categories": [self.transport.pk, self.cafe.pk]})

    @override_settings(DEBUG=False)
    def test_local_single_writes_need_the_local_api(self):
        response = self.post(self.client, {"total": "1", "category": self.food.pk})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "permission_denied")

    def test_csrf_is_checked_in_local_single(self):
        client = APIClient(enforce_csrf_checks=True)
        response = self.post(client, {"total": "1", "category": self.food.pk})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["error"]["code"], "csrf_failed")


@tag("integration")
@local_single_mode()
class ManualChangeTests(ManualMixin, TestCase):
    def setUp(self):
        self.client = APIClient()
        self.spend = self.post(self.client, {"total": "450", "currency": "KZT", "category": self.cafe.pk,
                                             "purchased_on": "2026-10-01"}).json()
        self.url = f"/api/receipts/{self.spend['id']}/"

    def patch(self, body, url=None):
        return self.client.patch(url or self.url, body, format="json")

    def test_patch_simple_spend_total_and_category(self):
        response = self.patch({"total": "500", "category": self.transport.pk, "note": "такси"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual((response.json()["total"], response.json()["note"]), ("500.00", "такси"))
        # Строка «<категория>» следует за категорией.
        self.assertEqual(self.lines(self.spend["id"]), [("Демо-транспорт", D("500.00"), D("1.000"), self.transport.pk, None)])

    def test_patch_date_store_and_currency(self):
        response = self.patch({"purchased_on": "2026-09-30", "store_name": "Демо-кофейня", "currency": "RUB"})
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual((body["purchased_on"], body["store"]["name"], body["currency"]), ("2026-09-30", "Демо-кофейня", "RUB"))
        receipt = Receipt.objects.get(pk=self.spend["id"])
        self.assertEqual(receipt.purchased_at.astimezone(dt_timezone.utc).date(), date(2026, 9, 30))
        self.assertIsNone(self.patch({"store_name": None}).json()["store"])

    def test_patch_lines_replace_lines_and_back(self):
        response = self.patch({"lines": [{"name": "Капучино", "amount": "300"}, {"name": "Круассан", "amount": "250"}]})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], "550.00")
        self.assertEqual([row[0] for row in self.lines(self.spend["id"])], ["Капучино", "Круассан"])
        mismatch = self.patch({"total": "1"})
        self.assertEqual(fields(mismatch), {"total": ["Итог не совпадает с суммой позиций."]})
        itemized = self.patch({"category": self.food.pk})
        self.assertEqual(fields(itemized), {"category": ["У траты с позициями категорию задают позициям."]})
        simple = self.patch({"lines": [], "total": "100", "category": self.food.pk})
        self.assertEqual(simple.status_code, 200, simple.content)
        self.assertEqual(self.lines(self.spend["id"]), [("Демо-еда", D("100.00"), D("1.000"), self.food.pk, None)])

    def test_delete_manual_spend(self):
        response = self.client.delete(self.url)
        self.assertEqual(response.status_code, 204)
        self.assertFalse(Receipt.objects.filter(pk=self.spend["id"]).exists())
        self.assertFalse(ReceiptLine.objects.filter(receipt_id=self.spend["id"]).exists())
        self.assertEqual(self.client.delete(self.url).json(), NOT_FOUND)

    def test_photo_receipt_stays_read_only(self):
        photo = make_receipt(samples.lidl_store(), "EUR", date(2026, 9, 1), owner=local_user(), total=D("1.00"))
        url = f"/api/receipts/{photo.pk}/"
        response = self.patch({"total": "2"}, url)
        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json(), READ_ONLY)
        self.assertTrue(Receipt.objects.filter(pk=photo.pk, total=D("1.00")).exists())
        self.assertEqual(self.client.put(url, {}, format="json").status_code, 405)
        # A photo receipt can be deleted (test_receipt_delete_api), only not changed.
        self.assertEqual(self.client.delete(url).status_code, 204)

    def test_patch_validation_leaves_spend_unchanged(self):
        response = self.patch({"total": "-1", "category": 999999})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(fields(response)), {"total", "category"})
        self.assertEqual(self.lines(self.spend["id"]), [("Демо-кафе", D("450.00"), D("1.000"), self.cafe.pk, None)])

    def test_payment_method_is_set_changed_and_cleared(self):
        self.assertEqual(self.spend["payment_method"], "")  # не указан
        created = self.post(self.client, {"total": "1200", "category": self.cafe.pk, "payment_method": "kaspi_gold"})
        self.assertEqual((created.status_code, created.json()["payment_method"]), (201, "kaspi_gold"))
        for method in ("forte", "cash", "crypto", "card"):
            self.assertEqual(self.patch({"payment_method": method}).json()["payment_method"], method)
        self.assertEqual(self.patch({"total": "500"}).json()["payment_method"], "card")  # без ключа — прежний
        self.assertEqual(self.patch({"payment_method": None}).json()["payment_method"], "")
        wrong = self.patch({"payment_method": "visa"})
        self.assertEqual(fields(wrong), {"payment_method": ["Способ оплаты — kaspi_gold, forte, cash, crypto, card либо пусто."]})
        self.assertEqual(self.client.get("/api/receipts/").json()["results"][-1]["payment_method"], "")
        # У чека с фото поле есть, но правка по-прежнему не принимается.
        photo = make_receipt(samples.lidl_store(), "EUR", date(2026, 9, 1), owner=local_user(), total=D("1.00"))
        url = f"/api/receipts/{photo.pk}/"
        self.assertEqual(self.client.get(url).json()["payment_method"], "")
        self.assertEqual(self.patch({"payment_method": "cash"}, url).json(), READ_ONLY)
        self.assertEqual(Receipt.objects.get(pk=photo.pk).payment_method, "")


@tag("integration")
class ManualOwnerTests(ManualMixin, TwoUsers, TestCase):
    def test_owner_is_the_signed_in_user_and_others_see_404(self):
        with accounts_mode():
            created = self.post(self.client_of(self.first, csrf=True), {"total": "5", "category": self.food.pk})
            self.assertEqual(created.status_code, 201, created.content)
            receipt_id = created.json()["id"]
            self.assertEqual(Receipt.objects.get(pk=receipt_id).owner, self.first)
            other = self.client_of(self.second, csrf=True)
            url = f"/api/receipts/{receipt_id}/"
            for response in (other.get(url), other.patch(url, {"total": "1"}, format="json"), other.delete(url)):
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), NOT_FOUND)
            self.assertEqual(other.get("/api/receipts/").json()["count"], 0)
            self.assertEqual(Receipt.objects.get(pk=receipt_id).total, D("5.00"))

    def test_anonymous_and_csrf(self):
        with accounts_mode():
            anonymous = APIClient()
            response = self.post(anonymous, {"total": "5", "category": self.food.pk})
            self.assertEqual((response.status_code, response.json()), (401, NOT_AUTHENTICATED))
            no_token = APIClient(enforce_csrf_checks=True)
            no_token.force_login(self.first)
            self.assertEqual(self.post(no_token, {"total": "5", "category": self.food.pk}).json()["error"]["code"],
                             "csrf_failed")
            self.assertFalse(Receipt.objects.exists())


@tag("integration")
@local_single_mode()
class ManualStatsTests(ManualMixin, TestCase):
    def setUp(self):
        self.client = APIClient()
        self.store = samples.lidl_store()
        generic = GenericProduct.objects.create(name="Демо-булка", category=self.food, base_unit="pcs")
        self.bun = make_product(generic, "Демо-булка 1 шт")
        receipt = make_receipt(self.store, "EUR", date(2026, 9, 1), owner=local_user(), total=D("3.00"))
        make_line(receipt, product=self.bun, unit_price=D("3.00"), amount=D("3.00"))
        for body in ({"total": "5", "category": self.cafe.pk}, {"total": "2", "category": self.transport.pk}):
            self.post(self.client, {**body, "currency": "EUR", "purchased_on": "2026-09-02"})

    def spending(self, query=""):
        response = self.client.get(f"/api/stats/spending/?date_from=2026-09-01&date_to=2026-09-30{query}")
        self.assertEqual(response.status_code, 200, response.content)
        [block] = response.json()["currencies"]
        return block, [(item["kind"], item["id"], item["amount"]) for item in block["items"]]

    def test_manual_lines_are_in_their_category(self):
        block, items = self.spending()
        self.assertEqual(items, [("category", self.food.pk, "8.00"), ("category", self.transport.pk, "2.00")])
        self.assertEqual(block["totals"]["receipts_count"], 3)
        self.assertEqual(block["totals"]["difference"], "0.00")
        _, inside = self.spending(f"&category={self.food.pk}")
        self.assertEqual(inside, [("category", self.cafe.pk, "5.00"), ("category", self.food.pk, "3.00")])

    def test_generic_store_groupings(self):
        _, generic = self.spending("&group_by=generic")
        self.assertEqual(generic[0][0], "generic")
        self.assertEqual(generic[1:], [("no_product", None, "7.00")])
        _, stores = self.spending("&group_by=store")
        self.assertEqual(stores, [("store", self.store.pk, "3.00"), ("no_store", None, "7.00")])

    def test_manual_lines_are_not_price_observations(self):
        line = ReceiptLine.objects.filter(receipt__source="manual").first()
        line.product = self.bun
        line.save()
        self.assertEqual(list(price_history(product=self.bun).values_list("receipt__source", flat=True)), ["photo"])
        self.assertEqual(self.client.get(f"/api/products/{self.bun.pk}/prices/").json()["count"], 1)


@tag("integration")
class ManualConstraintTests(TestCase):
    def test_dedup_constraints_apply_only_to_photo_receipts(self):
        store = samples.lidl_store()
        owner = local_user()
        moment = datetime(2026, 10, 1, 9, 0, tzinfo=dt_timezone.utc)
        values = dict(owner=owner, store=store, currency_id="EUR", operation="sale", purchased_at=moment,
                      purchased_on=date(2026, 10, 1), total=D("3.00"))
        for _ in range(2):
            Receipt.objects.create(source="manual", **values)
        Receipt.objects.create(**values)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Receipt.objects.create(**values)
        for _ in range(2):
            Receipt.objects.create(source="manual", receipt_number="7", fiscal_key="demo:1", **values)
        self.assertEqual(Receipt.objects.filter(source="manual").count(), 4)
        self.assertEqual(Receipt._meta.get_field("source").default, "photo")
