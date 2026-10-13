"""``/api/recurring/``: месяц, предложения, ответы на вопрос, правка платежей, семья и чужие.

Сегодня в тестах — 13 октября 2026. Данные вымышленные; модель распознавания не вызывается.
"""
from datetime import date, datetime
from decimal import Decimal
from unittest import mock
from zoneinfo import ZoneInfo

from django.db import connection
from django.test import TestCase, override_settings, tag
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import (
    NOT_AUTHENTICATED, NOT_FOUND, PERMISSION_DENIED, TwoUsers, accounts_mode, local_single_mode, make_user,
)
from budget.dashboard import Month
from catalog.models import Category
from receipts import manual
from receipts.models import Receipt
from receipts.ownership import local_user
from recurring import services
from recurring.models import DismissedSuggestion, RecurringDecision, RecurringPayment

D = Decimal
URL = "/api/recurring/"
TODAY = date(2026, 10, 13)
LONG_AGO = datetime(2026, 1, 1, 12, tzinfo=ZoneInfo("Asia/Almaty"))


def today(day=TODAY):
    return mock.patch("api.views.recurring.timezone.localdate", return_value=day)


def spend(owner, category, total, on, store=None, currency="KZT"):
    body = {"total": str(total), "currency": currency, "category": category.pk, "purchased_on": on.isoformat()}
    if store:
        body["store_name"] = store
    return manual.create(owner, body)


def fields(response):
    return response.json()["error"]["fields"]


class Fixture:
    """Аренда 5-го числа май–октябрь, интернет 3-го май–август и октябрь (сентябрь забыли), продукты часто."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        owner = cls.spender()
        cls.home = Category.objects.create(name="Демо-жильё")
        cls.rent = Category.objects.create(name="Демо-аренда", parent=cls.home)
        cls.subs = Category.objects.create(name="Демо-подписки")
        cls.food = Category.objects.create(name="Демо-продукты")
        cls.rent_spends = [spend(owner, cls.rent, 220000, date(2026, month, 5), "Демо-хозяин") for month in range(5, 11)]
        cls.net_spends = [spend(owner, cls.subs, 6700, date(2026, month, 3), "Демо-интернет") for month in (5, 6, 7, 8, 10)]
        for month in range(5, 11):
            for day in (2, 11, 20):
                spend(owner, cls.food, 3000 + day, date(2026, month, day), "Демо-магазин")

    @classmethod
    def spender(cls):
        return local_user()


def payment_body(**body):
    return {"name": "Интернет", "store_name": "Демо-интернет", "category_id": None, "currency": "KZT",
            "amount": "6700", "due_day": 3, **body}


@tag("integration")
@local_single_mode()
class RecurringLocalTests(Fixture, TestCase):
    def setUp(self):
        self.client = APIClient()

    def month(self, **query):
        with today():
            response = self.client.get(URL, query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def create(self, **body):
        with today():
            response = self.client.post(URL, payment_body(**{"category_id": self.subs.pk, **body}), format="json")
        self.assertEqual(response.status_code, 201, response.content)
        RecurringPayment.objects.filter(pk=response.json()["id"]).update(created_at=LONG_AGO)
        return response.json()

    def decide(self, payment_id, month, decision):
        with today():
            return self.client.post(f"{URL}{payment_id}/decision/", {"month": month, "decision": decision}, format="json")

    def payment(self, data, payment_id):
        return next(row for row in data["payments"] if row["id"] == payment_id)

    def test_suggestions_from_history_and_accept_in_one_tap(self):
        data = self.month()
        self.assertEqual((data["month"], data["previous_month"], data["today"]), ("2026-10", "2026-09", "2026-10-13"))
        self.assertEqual(data["payments"], [])
        suggestions = {row["store_name"]: row for row in data["suggestions"]}
        self.assertEqual(set(suggestions), {"Демо-хозяин", "Демо-интернет"})  # продукты — частые покупки, не платёж
        rent = suggestions["Демо-хозяин"]
        self.assertEqual(rent, {
            "store_id": self.rent_spends[0].store_id, "store_name": "Демо-хозяин", "category_id": self.rent.pk,
            "category_name": "Демо-аренда", "currency": "KZT", "amount": "220000.00", "due_day": 5, "months": 6,
            "last_date": "2026-10-05", "name": "Демо-хозяин",
        })
        self.assertEqual(suggestions["Демо-интернет"]["months"], 4)  # май–август: пропуск сентября не прячет

        key = {"store_id": rent["store_id"], "category_id": self.rent.pk, "currency": "KZT"}
        with today():
            accepted = self.client.post(f"{URL}suggestions/accept/", key, format="json")
        self.assertEqual(accepted.status_code, 201, accepted.content)
        created = accepted.json()
        self.assertEqual({name: created[name] for name in ("name", "store", "category", "amount", "due_day", "active")}, {
            "name": "Демо-хозяин", "store": {"id": rent["store_id"], "name": "Демо-хозяин"},
            "category": {"id": self.rent.pk, "name": "Демо-аренда"}, "amount": "220000.00", "due_day": 5, "active": True,
        })
        data = self.month()
        self.assertEqual([row["store_name"] for row in data["suggestions"]], ["Демо-интернет"])
        row = self.payment(data, created["id"])
        self.assertEqual((row["state"], row["due_date"], row["paid"]), (
            "paid", "2026-10-05", {"receipt_id": self.rent_spends[-1].pk, "purchased_on": "2026-10-05", "total": "220000.00"}))
        self.assertEqual(row["history"], [{"month": f"2026-{month:02d}", "state": "paid"} for month in range(5, 11)])
        self.assertEqual((row["average"], row["last_amount"], row["previous_amount"]), ("220000.00", "220000.00", None))
        self.assertEqual(data["totals"], [{"currency": "KZT", "payments": 1, "done": 1, "left": None}])
        with today():
            again = self.client.post(f"{URL}suggestions/accept/", key, format="json")
        self.assertEqual(again.json(), NOT_FOUND)

    def test_another_payment_to_the_same_payee_stays_suggested(self):
        bills = Category.objects.create(name="Демо-квитанция", parent=self.home)
        for month in range(5, 11):
            spend(local_user(), bills, 9000 + month, date(2026, month, 9), "Демо-хозяин")
        rent = next(row for row in self.month()["suggestions"] if row["category_id"] == self.rent.pk)
        bill = next(row for row in self.month()["suggestions"] if row["category_id"] == bills.pk)
        # Одна вывеска у двух предложений: имя — категория.
        self.assertEqual((rent["name"], bill["name"]), ("Демо-аренда", "Демо-квитанция"))
        key = {"store_id": rent["store_id"], "category_id": self.rent.pk, "currency": "KZT"}
        self.assertEqual(self.client.post(f"{URL}suggestions/accept/", key, format="json").status_code, 201)
        left = {row["category_id"] for row in self.month()["suggestions"]}
        self.assertEqual(left, {bills.pk, self.subs.pk})

    def test_dismissed_suggestion_is_not_offered_again(self):
        net = self.net_spends[0]
        key = {"store_id": net.store_id, "category_id": self.subs.pk, "currency": "KZT"}
        for _ in range(2):
            dismissed = self.client.post(f"{URL}suggestions/dismiss/", {**key, "currency": "kzt"}, format="json")
            self.assertEqual((dismissed.status_code, dismissed.json()), (200, key))
        self.assertEqual(DismissedSuggestion.objects.count(), 1)
        self.assertEqual([row["store_name"] for row in self.month()["suggestions"]], ["Демо-хозяин"])
        bad = self.client.post(f"{URL}suggestions/dismiss/", {**key, "store_id": 999999999, "x": 1}, format="json")
        self.assertEqual(set(fields(bad)), {"store_id", "x"})

    def test_question_about_last_month_and_add_by_average(self):
        net = self.create()
        data = self.month()
        self.assertEqual(self.payment(data, net["id"])["state"], "paid")
        self.assertEqual(data["questions"], [{
            "payment_id": net["id"], "name": "Интернет", "month": "2026-09", "due_date": "2026-09-03",
            "currency": "KZT", "amount": "6700.00", "from_history": True,
        }])
        self.assertEqual(self.month(month="2026-09")["questions"], [])  # вопросы — только у текущего месяца

        added = self.decide(net["id"], "2026-09", "added")
        self.assertEqual(added.status_code, 201, added.content)
        receipt = Receipt.objects.get(pk=added.json()["receipt_id"])
        self.assertEqual(added.json(), {"payment_id": net["id"], "month": "2026-09", "decision": "added",
                                        "receipt_id": receipt.pk})
        self.assertEqual((receipt.source, receipt.owner, receipt.purchased_on, receipt.total, receipt.currency_id),
                         ("manual", local_user(), date(2026, 9, 3), D("6700.00"), "KZT"))
        self.assertEqual(receipt.note, "Интернет за сентябрь 2026: средняя оплата (платёж не найден)")
        self.assertEqual(receipt.store_id, self.net_spends[0].store_id)
        self.assertEqual(list(receipt.lines.values_list("category_id", flat=True)), [self.subs.pk])
        data = self.month()
        self.assertEqual(data["questions"], [])
        self.assertEqual(self.payment(data, net["id"])["history"][-2], {"month": "2026-09", "state": "paid"})
        self.assertEqual(self.decide(net["id"], "2026-09", "skipped").json()["error"]["code"], "already_paid")
        self.assertEqual(Receipt.objects.filter(note__startswith="Интернет за").count(), 1)

        # Удалили добавленную трату — вопрос вернулся; «не было» закрывает его без траты.
        manual.delete(receipt.pk)
        self.assertEqual(len(self.month()["questions"]), 1)
        skipped = self.decide(net["id"], "2026-09", "skipped")
        self.assertEqual((skipped.status_code, skipped.json()["receipt_id"]), (201, None))
        data = self.month()
        self.assertEqual((data["questions"], self.payment(data, net["id"])["history"][-2]),
                         ([], {"month": "2026-09", "state": "skipped"}))
        conflict = self.decide(net["id"], "2026-09", "elsewhere")
        self.assertEqual((conflict.status_code, conflict.json()["error"]["code"]), (409, "already_decided"))
        self.assertEqual(RecurringDecision.objects.get().decision, "skipped")

    def test_average_falls_back_to_the_expected_amount(self):
        other = self.create(name="Подписка", store_name="Демо-нигде", amount="1990", due_day=20)
        question = next(item for item in self.month()["questions"] if item["payment_id"] == other["id"])
        self.assertEqual((question["amount"], question["from_history"]), ("1990.00", False))

    def test_decision_validation_and_conflicts(self):
        net = self.create()
        for month in ("2026-10", "2026-11", "2025-09", "2026-13", "2026-9", None):
            self.assertEqual(set(fields(self.decide(net["id"], month, "skipped"))), {"month"}, month)
        self.assertEqual(set(fields(self.decide(net["id"], "2026-09", "maybe"))), {"decision"})
        self.assertEqual(self.decide(net["id"], "2026-08", "skipped").json()["error"]["code"], "already_paid")
        self.assertEqual(self.decide(999999999, "2026-09", "skipped").json(), NOT_FOUND)
        self.assertEqual(RecurringDecision.objects.count(), 0)

    def test_states_of_the_month_and_totals(self):
        rent = self.create(name="Аренда", store_name="Демо-хозяин", category_id=self.rent.pk, amount="220000", due_day=5)
        later = self.create(name="Связь", store_name=None, amount="3990", due_day=25)
        Receipt.objects.filter(pk=self.rent_spends[-1].pk).delete()
        data = self.month()
        states = {row["name"]: (row["state"], row["paid"] is not None) for row in data["payments"]}
        self.assertEqual(states, {"Аренда": ("overdue", False), "Связь": ("due", False)})
        self.assertEqual(data["totals"], [{"currency": "KZT", "payments": 2, "done": 0, "left": "223990.00"}])
        self.assertEqual(self.payment(data, rent["id"])["history"][-1], {"month": "2026-10", "state": "overdue"})
        self.assertIsNone(self.payment(data, later["id"])["store"])
        # Платёж начинается с месяца создания либо первой найденной оплаты (май), что раньше.
        RecurringPayment.objects.filter(pk=rent["id"]).update(created_at=datetime(2026, 10, 1, tzinfo=ZoneInfo("UTC")))
        april = self.month(month="2026-04")
        self.assertEqual((self.payment(april, rent["id"])["state"], self.payment(april, later["id"])["state"]),
                         ("before", "overdue"))

    def test_amount_change_is_shown(self):
        net = self.create()
        Receipt.objects.filter(pk=self.net_spends[-1].pk).delete()
        spend(local_user(), self.subs, 7200, date(2026, 10, 1), "Демо-интернет")  # подорожал в октябре
        row = self.payment(self.month(), net["id"])
        self.assertEqual((row["last_amount"], row["previous_amount"]), ("7200.00", "6700.00"))

    def test_crud_and_validation(self):
        missing = self.client.post(URL, {"extra": 1}, format="json")
        self.assertEqual(set(fields(missing)), {"extra", "name", "category_id", "currency", "amount", "due_day"})
        wrong = self.client.post(URL, payment_body(category_id=999999999, currency="XXQ", amount="0", due_day=32,
                                                   name=" ", store_name="x" * 101, active="yes"), format="json")
        self.assertEqual(set(fields(wrong)), {"category_id", "currency", "amount", "due_day", "name", "store_name", "active"})
        for due_day in (0, "5", True, 1.5):
            self.assertIn("due_day", fields(self.client.post(URL, payment_body(category_id=self.subs.pk, due_day=due_day),
                                                             format="json")))
        self.assertEqual(RecurringPayment.objects.count(), 0)

        net = self.create(currency="kzt")
        payment = RecurringPayment.objects.get(pk=net["id"])
        self.assertEqual((payment.user, payment.household, payment.created_by), (local_user(), None, local_user()))
        url = f"{URL}{net['id']}/"
        self.assertEqual(self.client.get(url).json(), net)
        patched = self.client.patch(url, {"amount": "7000,50", "active": False, "store_name": None}, format="json")
        self.assertEqual(patched.status_code, 200, patched.content)
        self.assertEqual((patched.json()["amount"], patched.json()["active"], patched.json()["store"]), ("7000.50", False, None))
        data = self.month()
        self.assertEqual((self.payment(data, net["id"])["state"], data["questions"], data["totals"]), ("inactive", [], []))
        self.assertEqual(fields(self.client.patch(url, {}, format="json")), {"body": ["Укажите хотя бы одно поле."]})
        self.assertEqual(self.client.put(url, {}, format="json").status_code, 405)
        self.assertEqual(self.client.delete(url).status_code, 204)
        self.assertEqual(self.client.get(url).json(), NOT_FOUND)
        self.assertEqual(self.client.get(f"{URL}abc/").json(), NOT_FOUND)

    def test_month_parameter(self):
        response = self.client.get(URL, {"month": "2026-13"})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(set(fields(response)), {"month"})

    def test_queries_do_not_grow_with_payments(self):
        def count():
            with today(), CaptureQueriesContext(connection) as context:
                self.assertEqual(self.client.get(URL).status_code, 200)
            return len(context.captured_queries)

        # Без магазина и в продуктах: предложения аренды и интернета остаются в обоих замерах.
        self.create(name="Один", store_name=None, category_id=self.food.pk)
        self.create(name="Два", store_name=None, category_id=self.food.pk, due_day=20)
        few = count()
        for index in range(4):
            self.create(name=f"Ещё {index}", store_name=None, category_id=self.food.pk, due_day=index + 1)
        self.assertEqual(count(), few)

    def test_unpaid_for_wave_two(self):
        net = self.create()
        rent = self.create(name="Аренда", store_name="Демо-хозяин", category_id=self.rent.pk, amount="220000", due_day=5)
        self.create(name="Выключен", amount="100", due_day=28)
        RecurringPayment.objects.filter(name="Выключен").update(active=False)
        Receipt.objects.filter(pk=self.rent_spends[-1].pk).delete()
        self.assertEqual(services.unpaid(local_user(), Month(2026, 10), today=TODAY), [
            {"id": rent["id"], "name": "Аренда", "amount": D("220000.00"), "currency": "KZT",
             "due_date": date(2026, 10, 5), "overdue": True},
        ])
        self.assertEqual([row["id"] for row in services.unpaid(local_user(), date(2026, 9, 1), today=TODAY)], [net["id"]])

    @override_settings(ALLOW_LOCAL_RECOGNITION_API=False)
    def test_local_api_flag_required(self):
        self.assertEqual(self.client.get(URL).json(), PERMISSION_DENIED)

    def test_csrf_required_for_writes(self):
        response = APIClient(enforce_csrf_checks=True).post(URL, payment_body(category_id=self.subs.pk), format="json")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"))


@tag("integration")
@accounts_mode()
class RecurringFamilyTests(Fixture, TwoUsers, TestCase):
    """``first`` и ``third`` — одна семья (траты — у ``third``), ``second`` вне её."""

    @classmethod
    def spender(cls):
        cls.third = make_user("synthetic-user-three")
        return cls.third

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=cls.family)

    def get(self, account, url=URL):
        with today():
            return self.client_of(account).get(url)

    def create(self, account, **body):
        with today():
            response = self.client_of(account, csrf=True).post(URL, payment_body(**{"category_id": self.subs.pk, **body}), format="json")
        self.assertEqual(response.status_code, 201, response.content)
        RecurringPayment.objects.filter(pk=response.json()["id"]).update(created_at=LONG_AGO)
        return response.json()

    def test_anonymous_gets_401(self):
        self.assertEqual(APIClient().get(URL).json(), NOT_AUTHENTICATED)

    def test_family_shares_payments_and_spends(self):
        net = self.create(self.first)
        payment = RecurringPayment.objects.get(pk=net["id"])
        self.assertEqual((payment.household, payment.user, payment.created_by), (self.family, None, self.first))
        rows = self.get(self.third).json()["payments"]
        self.assertEqual([(row["id"], row["state"], row["created_by"]) for row in rows],
                         [(net["id"], "paid", {"username": "synthetic-user-one", "display_name": "synthetic-user-one"})])
        with today():
            patched = self.client_of(self.third, csrf=True).patch(f"{URL}{net['id']}/", {"amount": "6800"}, format="json")
        self.assertEqual(patched.json()["amount"], "6800.00")
        with today():
            added = self.client_of(self.third, csrf=True).post(
                f"{URL}{net['id']}/decision/", {"month": "2026-09", "decision": "added"}, format="json")
        self.assertEqual(added.status_code, 201, added.content)
        self.assertEqual(Receipt.objects.get(pk=added.json()["receipt_id"]).owner, self.third)
        self.assertEqual(self.get(self.first).json()["questions"], [])

    def test_outsider_sees_nothing_and_gets_404(self):
        net = self.create(self.first)
        outsider = self.client_of(self.second, csrf=True)
        data = self.get(self.second).json()
        self.assertEqual((data["payments"], data["suggestions"], data["questions"]), ([], [], []))
        url = f"{URL}{net['id']}/"
        with today():
            self.assertEqual(self.client_of(self.second).get(url).json(), NOT_FOUND)
            self.assertEqual(outsider.patch(url, {"amount": "1"}, format="json").json(), NOT_FOUND)
            self.assertEqual(outsider.post(f"{url}decision/", {"month": "2026-09", "decision": "skipped"},
                                           format="json").json(), NOT_FOUND)
            self.assertEqual(outsider.delete(url).json(), NOT_FOUND)
        self.assertTrue(RecurringPayment.objects.filter(pk=net["id"], amount=D("6700")).exists())
        # Траты чужого — не оплата семейного платежа; его собственный платёж свои траты видит.
        spend(self.second, self.subs, 6700, date(2026, 9, 3), "Демо-интернет")
        self.assertEqual(len(self.get(self.first).json()["questions"]), 1)
        own = self.create(self.second)
        self.assertEqual(RecurringPayment.objects.get(pk=own["id"]).user, self.second)
        rows = self.get(self.second).json()["payments"]
        self.assertEqual([(row["id"], row["history"][-2]["state"]) for row in rows], [(own["id"], "paid")])

    def test_hidden_payment_never_pays(self):
        net = self.create(self.first)
        Receipt.objects.filter(pk=self.net_spends[-1].pk).update(hidden=True)
        rows = self.get(self.third).json()["payments"]
        self.assertEqual(rows[0]["state"], "overdue")
        self.assertEqual(rows[0]["id"], net["id"])
