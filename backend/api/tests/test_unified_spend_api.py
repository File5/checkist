"""Единая форма траты (2026-10-13): чек с фото, трата из выписки и ручная трата «как в чеке» правятся одним путём.

``PATCH /api/receipts/{id}/`` → ``receipts.manual.update`` для любого источника. Данные вымышленные; модель
распознавания не вызывается.
"""
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.test import TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_FOUND, TwoUsers, accounts_mode, local_single_mode
from api.tests.factories import make_receipt
from catalog.models import Category, Product
from receipts import manual
from receipts.dedup import find_duplicates
from receipts.models import Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.ownership import local_user
from receipts.prices import price_history
from receipts.tests import samples
from receipts.tests.test_models import make_line
from receipts.validation import validate_receipt
from statements.models import StatementImport, StatementRow

D = Decimal
MANUAL = "/api/receipts/manual/"


def fields(response):
    return response.json()["error"]["fields"]


def body_line(line, **changes):
    """Строка тела из строки ``GET …/lines/`` — как её отправляет форма."""
    return {"id": line["id"], "name": line["name"], "quantity": line["quantity"], "unit": line["unit"],
            "unit_price": line["unit_price"], "amount": line["amount"], "discount_amount": line["discount_amount"],
            "category": line["category"]["id"] if line["category"] else None, **changes}


class Api:
    def lines(self, receipt_id, client=None):
        return (client or self.client).get(f"/api/receipts/{receipt_id}/lines/").json()["results"]

    def patch(self, receipt_id, body, client=None):
        return (client or self.client).patch(f"/api/receipts/{receipt_id}/", body, format="json")


@tag("integration")
@local_single_mode()
class PhotoReceiptEditTests(Api, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.cafe = Category.objects.create(name="Демо-кафе")
        cls.tech = Category.objects.create(name="Демо-техника")

    def setUp(self):
        self.client = APIClient()
        self.receipt = samples.save_dns_kz()  # одна строка, НДС 16 %, итог 189 490 ₸

    def test_card_says_photo_and_no_statement(self):
        body = self.client.get(f"/api/receipts/{self.receipt.pk}/").json()
        self.assertEqual((body["source"], body["statement"]), ("photo", None))

    def test_same_name_keeps_product_and_printed_values(self):
        line = self.lines(self.receipt.pk)[0]
        product = line["product"]["id"]
        response = self.patch(self.receipt.pk, {"lines": [body_line(line, category=self.tech.pk)], "note": "домой"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual((response.json()["source"], response.json()["total"], response.json()["note"]),
                         ("photo", "189490.00", "домой"))
        saved = ReceiptLine.objects.get(pk=line["id"])
        self.assertEqual((saved.product_id, saved.category_id, saved.barcode, saved.tax_amount),
                         (product, self.tech.pk, "0200200605191", D("26136.55")))
        self.assertEqual(saved.name_i18n["kk"][:3], "SSD")  # название то же — перевод остаётся
        tax = ReceiptTax.objects.get(receipt=self.receipt)
        self.assertEqual((tax.net, tax.tax, tax.gross), (D("163353.45"), D("26136.55"), D("189490.00")))
        self.assertEqual(validate_receipt(Receipt.objects.get(pk=self.receipt.pk)), [])

    def test_money_edit_recounts_discounts_taxes_total_and_prices(self):
        line = self.lines(self.receipt.pk)[0]
        product = line["product"]["id"]
        response = self.patch(self.receipt.pk, {"lines": [
            body_line(line, quantity="2", unit_price="100000", amount="200000", discount_amount="10000"),
            {"name": "Кабель USB-C", "quantity": "1", "unit": "pcs", "amount": "5000", "category": self.tech.pk},
        ]})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual((response.json()["total"], response.json()["discount_total"]), ("195000.00", "10000.00"))
        receipt = Receipt.objects.get(pk=self.receipt.pk)
        self.assertEqual(validate_receipt(receipt), [])
        first, second = receipt.lines.order_by("position")
        self.assertEqual((first.product_id, first.quantity, first.unit_price, first.discount_amount, first.tax_amount),
                         (product, D("2.000"), D("100000.0000"), D("10000.00"), D("26206.90")))
        self.assertEqual(list(receipt.discounts.values_list("line_id", "name", "amount")),
                         [(first.pk, "Скидка", D("10000.00"))])
        # Новая строка чека с фото — товар по правилу трат: тёзки нет — личный товар владельца.
        self.assertEqual((second.raw_name, second.product.name, second.product.scope, second.category_id),
                         ("Кабель USB-C", "Кабель USB-C", f"user:{local_user().pk}", self.tech.pk))
        tax = receipt.taxes.get()
        self.assertEqual((tax.gross, tax.tax, tax.net), (D("195000.00"), D("26896.55"), D("168103.45")))
        # Наблюдение цены следует за строкой: (200 000 − 10 000) / 2.
        observed = price_history(product=product).get()
        self.assertEqual((observed.quantity, observed.paid_unit_price), (D("2.000"), D("95000.0000")))
        # Сумма без цены — цена считается; цена, не дающая сумму, — отказ.
        again = self.lines(self.receipt.pk)
        derived = self.patch(self.receipt.pk, {"lines": [
            {**body_line(again[0], quantity="3", amount="300000", discount_amount="0"), "unit_price": None},
            body_line(again[1])]})
        self.assertEqual(derived.status_code, 200, derived.content)
        self.assertEqual(ReceiptLine.objects.get(pk=first.pk).unit_price, D("100000.0000"))
        self.assertFalse(ReceiptDiscount.objects.filter(receipt=self.receipt).exists())
        wrong = self.patch(self.receipt.pk, {"lines": [body_line(again[0], quantity="3", unit_price="1", amount="300000")]})
        self.assertEqual(fields(wrong), {"lines.0.unit_price": ["Сумма позиции не равна количеству × цене."]})

    def test_renamed_line_takes_the_product_of_its_new_name(self):
        catalog = samples.save_catalog()
        line = self.lines(self.receipt.pk)[0]
        response = self.patch(self.receipt.pk, {"lines": [body_line(line, name=samples.SHOP_MILK_NAME)]})
        self.assertEqual(response.status_code, 200, response.content)
        saved = ReceiptLine.objects.get(pk=line["id"])
        self.assertEqual((saved.product_id, saved.name_i18n), (catalog["shop_milk"].pk, {}))
        # Чужого личного товара строка не находит: тёзка другого человека — новый свой.
        other = Product.objects.create(generic=catalog["ssd"].generic, name="Тайный подарок", scope="user:999999")
        renamed = self.patch(self.receipt.pk, {"lines": [body_line(self.lines(self.receipt.pk)[0], name="Тайный подарок")]})
        self.assertEqual(renamed.status_code, 200, renamed.content)
        self.assertNotEqual(ReceiptLine.objects.get(pk=line["id"]).product_id, other.pk)

    def test_place_is_required_and_date_keeps_the_printed_time(self):
        self.assertEqual(fields(self.patch(self.receipt.pk, {"store_name": ""})), {"store_name": ["Обязательное поле."]})
        response = self.patch(self.receipt.pk, {"purchased_on": "2026-09-12", "payment_method": "cash"})
        self.assertEqual(response.status_code, 200, response.content)
        receipt = Receipt.objects.get(pk=self.receipt.pk)
        self.assertEqual(receipt.purchased_at, datetime(2026, 9, 12, 16, 15, 44, tzinfo=ZoneInfo("Asia/Almaty")))
        self.assertEqual(receipt.payment_method, "cash")
        moved = self.patch(self.receipt.pk, {"store_name": "Демо-техномаркет"})
        self.assertEqual(moved.json()["store"]["name"], "Демо-техномаркет")
        self.assertEqual(Receipt.objects.get(pk=self.receipt.pk).purchased_at.astimezone(ZoneInfo("Asia/Almaty")).time(),
                         time(16, 15, 44))

    def test_dedup_keys_stay_and_a_copy_of_another_receipt_is_refused(self):
        keys = (self.receipt.fiscal_key, self.receipt.receipt_number, self.receipt.shift_number)
        line = self.lines(self.receipt.pk)[0]
        self.assertEqual(self.patch(self.receipt.pk, {"lines": [body_line(line, amount="189000", unit_price=None)]})
                         .status_code, 200)
        receipt = Receipt.objects.get(pk=self.receipt.pk)
        self.assertEqual((receipt.fiscal_key, receipt.receipt_number, receipt.shift_number), keys)
        # Повторное фото того же чека по-прежнему находит его (фискальный ключ), а не создаёт копию.
        header = {"owner_id": receipt.owner_id, "fiscal_key": receipt.fiscal_key, "store": receipt.store,
                  "purchased_on": receipt.purchased_on, "purchased_at": receipt.purchased_at, "total": D("189490.00"),
                  "receipt_number": "5", "shift_number": "139", "register_code": ""}
        self.assertEqual([found.pk for found in find_duplicates(header, owner=receipt.owner_id)], [receipt.pk])
        # Тот же номер, смена и место в другой день — чек уже есть: правка на этот день отказывает.
        make_receipt(receipt.store, "KZT", date(2026, 9, 12), receipt_number="5", shift_number="139")
        refused = self.patch(self.receipt.pk, {"purchased_on": "2026-09-12", "note": "не сохранится"})
        self.assertEqual(refused.status_code, 400, refused.content)
        self.assertEqual(fields(refused), {
            "receipt": ["Такой чек у вас уже есть: то же место и дата с тем же номером либо временем и суммой."]})
        receipt.refresh_from_db()
        self.assertEqual((receipt.purchased_on, receipt.note), (date(2026, 9, 11), ""))

    def test_whole_receipt_as_one_amount(self):
        response = self.patch(self.receipt.pk, {"lines": [], "total": "1000", "category": self.cafe.pk,
                                                "item_name": "Ремонт"})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], "1000.00")
        line = Receipt.objects.get(pk=self.receipt.pk).lines.get()
        self.assertEqual((line.raw_name, line.amount, line.category_id), ("Ремонт", D("1000.00"), self.cafe.pk))
        self.assertEqual(ReceiptTax.objects.get(receipt=self.receipt).gross, D("1000.00"))


@tag("integration")
@local_single_mode()
class MultiRateReceiptEditTests(Api, TestCase):
    """Lidl: две ставки, залоги, скидки и возврат тары отрицательной строкой."""

    def setUp(self):
        self.client = APIClient()
        self.receipts = samples.save_lidl_de()

    def test_removed_line_keeps_its_deposit_and_taxes_follow_the_rates(self):
        receipt = self.receipts[0]  # пицца, молоко (A), Fanta (B), залог Fanta (B), творог (A)
        lines = self.lines(receipt.pk)
        body = [body_line(line) for line in lines if line["name"] != "Fanta Orange"]
        body.reverse()
        response = self.patch(receipt.pk, {"lines": body})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()["total"], "6.28")
        receipt.refresh_from_db()
        self.assertEqual(validate_receipt(receipt), [])
        self.assertEqual([line.raw_name for line in receipt.lines.order_by("position")],
                         [samples.QUARK, samples.PFAND_B, samples.MILK, samples.PIZZA_HOT_DOG])
        self.assertIsNone(receipt.lines.get(raw_name=samples.PFAND_B).parent_id)
        taxes = {tax.tax_rate.rate: (tax.net, tax.tax, tax.gross) for tax in receipt.taxes.select_related("tax_rate")}
        self.assertEqual(taxes, {D("7.00"): (D("5.64"), D("0.39"), D("6.03")), D("19.00"): (D("0.21"), D("0.04"), D("0.25"))})

    def test_line_discounts_are_kept_or_replaced(self):
        receipt = self.receipts[3]  # три скидки на позиции, 2,40
        lines = self.lines(receipt.pk)
        body = [body_line(line) for line in lines]
        body[1]["discount_amount"] = "0.50"  # Leerdammer: 0,20 -> 0,50
        response = self.patch(receipt.pk, {"lines": body})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual((response.json()["total"], response.json()["discount_total"]), ("14.98", "2.70"))
        receipt.refresh_from_db()
        self.assertEqual(validate_receipt(receipt), [])
        self.assertEqual(sorted(receipt.discounts.values_list("name", "amount")),
                         [("Preisvorteil", D("2.00")), ("Rabatt Snack", D("0.20")), ("Скидка", D("0.50"))])
        too_big = self.patch(receipt.pk, {"lines": [body_line(lines[0], discount_amount="10")]})
        self.assertEqual(fields(too_big), {"lines.0.discount_amount": [
            "Скидка не меньше нуля и не больше суммы позиции, не больше двух знаков после запятой."]})

    def test_a_negative_line_keeps_its_sign(self):
        receipt = self.receipts[2]  # возврат тары −1,00 (−4 × 0,25)
        lines = self.lines(receipt.pk)
        returned = next(line for line in lines if line["name"] == samples.PFAND_RETURN)
        self.assertEqual((returned["quantity"], returned["amount"]), ("-4.000", "-1.00"))
        same = self.patch(receipt.pk, {"lines": [body_line(line) for line in lines]})
        self.assertEqual((same.status_code, same.json()["total"]), (200, "6.27"))
        body = [body_line(line) for line in lines]
        index = lines.index(returned)
        body[index] = body_line(returned, quantity="-8", unit_price="0.25", amount="-2.00")
        changed = self.patch(receipt.pk, {"lines": body})
        self.assertEqual((changed.status_code, changed.json()["total"]), (200, "5.27"))
        receipt.refresh_from_db()
        self.assertEqual(validate_receipt(receipt), [])
        body[index] = body_line(returned, quantity="4", unit_price="0.25", amount="1.00")
        self.assertEqual(set(fields(self.patch(receipt.pk, {"lines": body}))), {f"lines.{index}.amount"})
        fresh = self.patch(receipt.pk, {"lines": [*body[:index], {"name": "Возврат", "amount": "-1", "quantity": "-1"}]})
        self.assertEqual(set(fields(fresh)), {f"lines.{index}.amount", f"lines.{index}.quantity"})


@tag("integration")
@local_single_mode()
class StatementSpendEditTests(Api, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.cafe = Category.objects.create(name="Демо-кафе")

    def setUp(self):
        self.client = APIClient()
        owner = local_user()
        self.spend = manual.create(owner, {"total": "1800", "currency": "KZT", "category": self.cafe.pk,
                                           "purchased_on": "2026-10-02", "note": "COFFEE BOOM · Выписка Kaspi Gold",
                                           "payment_method": "kaspi_gold"})
        statement = StatementImport.objects.create(owner=owner, bank="kaspi_gold", sha256="0" * 64)
        StatementRow.objects.create(statement=statement, position=1, date=date(2026, 10, 2), amount=D("-1800"),
                                    currency="KZT", operation="Покупка", details="COFFEE BOOM", kind="spend",
                                    state="spend", receipt=self.spend)

    def test_statement_spend_is_edited_like_any_spend_and_stays_from_the_statement(self):
        card = self.client.get(f"/api/receipts/{self.spend.pk}/").json()
        self.assertEqual((card["source"], card["statement"]), ("manual", {"bank": "kaspi_gold", "label": "Выписка Kaspi Gold"}))
        response = self.patch(self.spend.pk, {
            "note": "кофе с коллегой", "store_name": "Демо-кофейня", "payment_method": "",
            "lines": [{"name": "Капучино", "quantity": "2", "unit": "pcs", "unit_price": "900", "amount": "1800",
                       "category": self.cafe.pk}]})
        self.assertEqual(response.status_code, 200, response.content)
        body = response.json()
        self.assertEqual((body["note"], body["payment_method"], body["total"], body["store"]["name"]),
                         ("кофе с коллегой · Выписка Kaspi Gold", "kaspi_gold", "1800.00", "Демо-кофейня"))
        self.assertEqual(body["statement"]["bank"], "kaspi_gold")
        line = Receipt.objects.get(pk=self.spend.pk).lines.get()
        self.assertEqual((line.raw_name, line.quantity, line.unit_price, line.product.name),
                         ("Капучино", D("2.000"), D("900.0000"), "Капучино"))
        self.assertEqual(self.patch(self.spend.pk, {"note": "кофе · Выписка Kaspi Gold"}).json()["note"],
                         "кофе · Выписка Kaspi Gold")
        self.assertEqual(self.patch(self.spend.pk, {"note": ""}).json()["note"], "· Выписка Kaspi Gold")
        self.assertEqual(fields(self.patch(self.spend.pk, {"payment_method": "cash"})),
                         {"payment_method": ["У траты из выписки способ оплаты — банк выписки."]})
        self.assertEqual(self.client.get("/api/export/?source=statement").json()["receipts"][0]["id"], self.spend.pk)


@tag("integration")
@local_single_mode()
class ManualAsReceiptTests(Api, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.cafe = Category.objects.create(name="Демо-кафе")
        cls.food = Category.objects.create(name="Демо-еда")

    def setUp(self):
        self.client = APIClient()

    def test_lines_like_a_receipt(self):
        response = self.client.post(MANUAL, {"currency": "KZT", "purchased_on": "2026-10-10", "store_name": "Демо-рынок",
                                             "category": self.food.pk, "lines": [
            {"name": "Панини", "quantity": "2", "unit": "pcs", "unit_price": "1790", "amount": "3580",
             "discount_amount": "80", "category": self.cafe.pk},
            {"name": "Сыр", "quantity": "0.350", "unit": "kg", "unit_price": "4200", "amount": "1470"},
        ]}, format="json")
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual((response.json()["total"], response.json()["discount_total"]), ("4970.00", "80.00"))
        receipt = Receipt.objects.get(pk=response.json()["id"])
        self.assertEqual(validate_receipt(receipt), [])
        panini, cheese = receipt.lines.order_by("position")
        self.assertEqual((panini.unit_price, panini.discount_amount, panini.category_id), (D("1790.0000"), D("80.00"), self.cafe.pk))
        self.assertEqual((cheese.unit, cheese.quantity, cheese.category_id), ("kg", D("0.350"), self.food.pk))
        self.assertEqual(price_history(product=cheese.product_id).count(), 0)  # без request ручных наблюдений нет
        lines = self.lines(receipt.pk)
        self.assertEqual((lines[0]["paid_amount"], lines[1]["unit"]), ("3500.00", "kg"))
        # Правка: то же название — тот же товар, новое — другой; убранная строка удаляется.
        product = panini.product_id
        changed = self.patch(receipt.pk, {"lines": [body_line(lines[0], quantity="3", unit_price="1790", amount="5370")]})
        self.assertEqual((changed.status_code, changed.json()["total"]), (200, "5290.00"))
        self.assertEqual(list(receipt.lines.values_list("pk", "product_id")), [(panini.pk, product)])

    def test_line_errors(self):
        cases = [
            ({"name": "А", "amount": "10", "quantity": "3", "unit_price": "3"},
             {"lines.0.unit_price": ["Сумма позиции не равна количеству × цене."]}),
            ({"name": "А", "amount": "10", "discount_amount": "11"},
             {"lines.0.discount_amount": ["Скидка не меньше нуля и не больше суммы позиции, не больше двух знаков после запятой."]}),
            ({"name": "А", "amount": "10", "unit": "box"}, {"lines.0.unit": ["Единица — pcs, g, kg, ml, l или m."]}),
            ({"name": "А", "amount": "10", "unit_price": "1.23456"},
             {"lines.0.unit_price": ["Цена за единицу не меньше нуля, не больше четырёх знаков после запятой."]}),
            ({"id": 1, "name": "А", "amount": "10"}, {"lines.0.id": ["Значение не найдено."]}),
            ({"name": "А", "amount": "-10", "quantity": "-1"},
             {"lines.0.amount": ["Сумма больше нуля, не больше двух знаков после запятой."],
              "lines.0.quantity": ["Количество больше нуля, не больше трёх знаков после запятой."]}),
        ]
        for line, expected in cases:
            with self.subTest(line=line):
                response = self.client.post(MANUAL, {"category": self.food.pk, "lines": [line]}, format="json")
                self.assertEqual(fields(response), expected)
        self.assertFalse(Receipt.objects.exists())

    def test_line_of_another_spend_is_not_this_one(self):
        first = manual.create(local_user(), {"category": self.food.pk, "lines": [{"name": "Хлеб", "amount": "200"}]})
        second = manual.create(local_user(), {"category": self.food.pk, "lines": [{"name": "Сок", "amount": "300"}]})
        foreign = first.lines.get()
        response = self.patch(second.pk, {"lines": [{"id": foreign.pk, "name": "Хлеб", "amount": "200"}]})
        self.assertEqual(fields(response), {"lines.0.id": ["Значение не найдено."]})
        self.assertEqual(first.lines.get().raw_name, "Хлеб")


@tag("integration")
class SpendEditRightsTests(Api, TwoUsers, TestCase):
    """Править — как удалять: видимая запросу трата (семья, «видит с»); скрытую — только главный."""

    def setUp(self):
        self.family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=self.first, household=self.family, role="head")
        self.membership = Membership.objects.create(user=self.second, household=self.family)
        store = samples.lidl_store()
        self.photo = make_receipt(store, "EUR", date(2026, 9, 3), owner=self.first, total=D("10.00"))
        make_line(self.photo, raw_name="Brot")

    def body(self):
        line = self.photo.lines.get()
        return {"lines": [{"id": line.pk, "name": "Brot", "amount": "10.00", "quantity": "1"}], "note": "семья"}

    def test_a_member_edits_a_family_receipt(self):
        with accounts_mode():
            response = self.patch(self.photo.pk, self.body(), self.client_of(self.second, csrf=True))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(Receipt.objects.get(pk=self.photo.pk).note, "семья")

    def test_visible_from_hidden_and_strangers(self):
        self.membership.visible_from = date(2026, 10, 1)
        self.membership.save()
        with accounts_mode():
            self.assertEqual(self.patch(self.photo.pk, self.body(), self.client_of(self.second, csrf=True)).json(), NOT_FOUND)
            Receipt.objects.filter(pk=self.photo.pk).update(hidden=True)
            self.membership.visible_from = None
            self.membership.save()
            self.assertEqual(self.patch(self.photo.pk, self.body(), self.client_of(self.second, csrf=True)).json(), NOT_FOUND)
            self.assertEqual(self.patch(self.photo.pk, self.body(), self.client_of(self.moderator, csrf=True)).json(), NOT_FOUND)
            head = self.patch(self.photo.pk, self.body(), self.client_of(self.first, csrf=True))
        self.assertEqual(head.status_code, 200, head.content)
        self.assertEqual(Receipt.objects.get(pk=self.photo.pk).note, "семья")
