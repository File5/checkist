"""Правило «→ цель»: перевод на свой депозит в черновике — взнос в цель, а не трата; повтор не задваивает.

Выписки и люди вымышленные; модель не вызывается.
"""
from datetime import date
from decimal import Decimal

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_FOUND, accounts_mode, local_single_mode, make_user, signed_in
from catalog.models import Category
from goals.models import Contribution, Goal
from receipts.models import Receipt
from receipts.ownership import local_user
from statements import demo
from statements.models import StatementRow, StatementRule

END = date(2026, 10, 12)
LIST = "/api/statements/"
RULES = "/api/statements/rules/"


def pdf(*extra):
    lines = demo.kaspi_header(END, END) + [
        demo.kaspi_line(date(2026, 10, 3), -100000, "Перевод", "На Kaspi Депозит"),
        demo.kaspi_line(date(2026, 10, 4), -1450, "Покупка", "YANDEX.GO"),
        demo.kaspi_line(date(2026, 10, 5), -1500, "Покупка", "Kaspi Депозит кафе"),
        *extra,
    ]
    return SimpleUploadedFile("statement.pdf", demo.pdf_bytes(lines), content_type="application/pdf")


def by_merchant(detail):
    return {row["merchant"]: row for row in detail["rows"]}


def fields(response):
    return response.json()["error"]["fields"]


@tag("integration")
@local_single_mode()
class GoalRowTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.transport = Category.objects.create(name="Транспорт")
        cls.goal = Goal.objects.create(user=local_user(), name="Отпуск", amount=Decimal("600000"), currency_id="KZT")

    def setUp(self):
        self.client = APIClient()

    def upload(self, *extra):
        response = self.client.post(LIST, {"file": pdf(*extra)}, format="multipart")
        self.assertIn(response.status_code, (200, 201), response.content)
        return response.json()

    def test_transfer_to_the_deposit_becomes_a_contribution_not_a_spend(self):
        rule = self.client.post(RULES, {"pattern": "Kaspi Депозит", "action": "goal", "goal": self.goal.pk}, format="json")
        self.assertEqual(rule.status_code, 201, rule.content)
        self.assertEqual((rule.json()["goal"], rule.json()["category"]), ({"id": self.goal.pk, "name": "Отпуск"}, None))
        self.assertEqual(StatementRule.objects.get().user, local_user())
        statement_id = self.upload()["statement"]["id"]
        rows = by_merchant(self.client.get(f"{LIST}{statement_id}/").json())
        deposit = rows["На Kaspi Депозит"]
        self.assertEqual((deposit["kind"], deposit["state"], deposit["goal"], deposit["category"], deposit["contribution_id"]),
                         ("own_move", "goal", {"id": self.goal.pk, "name": "Отпуск"}, None, None))
        # Покупка у похожего получателя — не взнос: правило «→ цель» только для переводов.
        self.assertEqual((rows["Kaspi Депозит кафе"]["kind"], rows["Kaspi Депозит кафе"]["goal"]), ("spend", None))
        body = {"rows": [{"id": deposit["id"], "goal": self.goal.pk},
                         {"id": rows["YANDEX.GO"]["id"], "category": self.transport.pk, "store_name": "Yandex Go"}]}
        saved = self.client.post(f"{LIST}{statement_id}/save/", body, format="json").json()
        self.assertEqual((saved["created"], saved["contributed"]), (1, 1))
        contribution = Contribution.objects.get()
        self.assertEqual((contribution.goal, contribution.amount, contribution.currency_id, contribution.date,
                          contribution.user, contribution.note),
                         (self.goal, Decimal("100000.00"), "KZT", date(2026, 10, 3), local_user(), "Выписка Kaspi Gold"))
        row = StatementRow.objects.get(pk=deposit["id"])
        self.assertEqual((row.contribution_id, row.receipt_id), (contribution.pk, None))
        self.assertEqual(Receipt.objects.count(), 1)  # только поездка: взнос — не трата
        self.assertEqual(by_merchant(saved["statement"])["На Kaspi Депозит"]["contribution_id"], contribution.pk)
        # Повтор нажатия и повторная загрузка того же файла не задваивают.
        again = self.client.post(f"{LIST}{statement_id}/save/", body, format="json").json()
        self.assertEqual((again["created"], again["contributed"]), (0, 0))
        reused = self.upload()
        self.assertEqual((reused["reused"], reused["statement"]["id"]), (True, statement_id))
        # Другая выписка с тем же переводом: строка — дубль уже внесённого взноса, не отмечена.
        other = self.upload(demo.kaspi_line(date(2026, 10, 6), -900, "Покупка", "YANDEX.GO"))["statement"]["id"]
        twin = by_merchant(self.client.get(f"{LIST}{other}/").json())["На Kaspi Депозит"]
        self.assertEqual((twin["state"], twin["reason"], twin["goal"]["id"]), ("duplicate", "goal_duplicate", self.goal.pk))
        self.assertEqual((Contribution.objects.count(), Receipt.objects.count()), (1, 1))
        self.assertEqual(self.client.get(f"/api/goals/{self.goal.pk}/").json()["saved"], "100000.00")

    def test_this_is_a_contribution_from_a_row(self):
        statement_id = self.upload()["statement"]["id"]
        rows = by_merchant(self.client.get(f"{LIST}{statement_id}/").json())
        deposit = rows["На Kaspi Депозит"]
        self.assertEqual((deposit["state"], deposit["reason"]), ("skipped", "own_move"))
        url = f"{LIST}{statement_id}/goal/"
        refused = self.client.post(url, {"row": rows["YANDEX.GO"]["id"], "goal": self.goal.pk}, format="json")
        self.assertEqual(set(fields(refused)), {"row"})
        self.assertEqual(set(fields(self.client.post(url, {"row": deposit["id"], "goal": 999999}, format="json"))), {"goal"})
        answer = self.client.post(url, {"row": deposit["id"], "goal": self.goal.pk}, format="json").json()
        self.assertEqual(answer["applied"], 1)
        self.assertEqual(by_merchant(answer["statement"])["На Kaspi Депозит"]["state"], "goal")
        rule = StatementRule.objects.get()
        self.assertEqual((rule.pattern, rule.action, rule.goal, rule.user), ("На Kaspi Депозит", "goal", self.goal, local_user()))
        # Сохранение строки-взноса без цели в теле — как трата не проходит без категории.
        bad = self.client.post(f"{LIST}{statement_id}/save/", {"rows": [{"id": deposit["id"], "goal": self.goal.pk,
                                                                           "category": self.transport.pk}]}, format="json")
        self.assertEqual(set(fields(bad)), {"rows.0.category"})


@tag("integration")
@accounts_mode()
class GoalRuleAccessTests(TestCase):
    """Андрей — главный, Лиза — член семьи, Пётр — чужой."""

    @classmethod
    def setUpTestData(cls):
        cls.andrey, cls.liza, cls.petr = make_user("andrey"), make_user("liza"), make_user("petr")
        family = Household.objects.create(name="Вымышленная семья")
        Membership.objects.create(household=family, user=cls.andrey, role="head")
        Membership.objects.create(household=family, user=cls.liza, role="member")
        cls.family = family
        cls.shared = Goal.objects.create(household=family, name="Отпуск", amount=Decimal("600000"), currency_id="KZT")
        cls.andreys = Goal.objects.create(user=cls.andrey, name="Подарок", amount=Decimal("50000"), currency_id="KZT")
        cls.petrs = Goal.objects.create(user=cls.petr, name="Чужая", amount=Decimal("1000"), currency_id="KZT")

    def test_goal_rules_are_personal_and_point_to_visible_goals(self):
        andrey, liza = signed_in(self.andrey), signed_in(self.liza)
        statement_id = andrey.post(LIST, {"file": pdf()}, format="multipart").json()["statement"]["id"]
        deposit = by_merchant(andrey.get(f"{LIST}{statement_id}/").json())["На Kaspi Депозит"]
        self.assertEqual(liza.post(f"{LIST}{statement_id}/goal/", {"row": deposit["id"], "goal": self.shared.pk},
                                   format="json").json(), NOT_FOUND)
        hidden = andrey.post(f"{LIST}{statement_id}/goal/", {"row": deposit["id"], "goal": self.petrs.pk}, format="json")
        self.assertEqual(set(fields(hidden)), {"goal"})
        self.assertEqual(andrey.post(f"{LIST}{statement_id}/goal/", {"row": deposit["id"], "goal": self.shared.pk},
                                     format="json").json()["applied"], 1)
        rule = StatementRule.objects.get()
        self.assertEqual((rule.household_id, rule.user_id), (None, self.andrey.pk))
        # Правило Андрея — только его: Лиза его не видит и её выписка того же перевода взносом не делает.
        self.assertEqual([item["id"] for item in andrey.get(RULES).json()["results"]], [rule.pk])
        self.assertEqual(liza.get(RULES).json(), {"results": []})
        self.assertEqual(liza.patch(f"{RULES}{rule.pk}/", {"action": "skip"}, format="json").json(), NOT_FOUND)
        own = liza.post(LIST, {"file": pdf()}, format="multipart").json()["statement"]["id"]
        self.assertEqual(by_merchant(liza.get(f"{LIST}{own}/").json())["На Kaspi Депозит"]["state"], "skipped")
        # Личная цель Андрея Лизе не видна: правило на неё не завести, сохранить взнос в неё нельзя.
        refused = liza.post(RULES, {"pattern": "Депозит", "action": "goal", "goal": self.andreys.pk}, format="json")
        self.assertEqual(set(fields(refused)), {"goal"})
        lizas = by_merchant(liza.get(f"{LIST}{own}/").json())["На Kaspi Депозит"]
        save = liza.post(f"{LIST}{own}/save/", {"rows": [{"id": lizas["id"], "goal": self.andreys.pk}]}, format="json")
        self.assertEqual(set(fields(save)), {"rows.0.goal"})
        self.assertFalse(Contribution.objects.exists())

    def test_switching_a_rule_to_a_goal_moves_it_to_its_owner(self):
        andrey = signed_in(self.andrey)
        food = Category.objects.create(name="Еда и напитки")
        created = andrey.post(RULES, {"pattern": "Kaspi Депозит", "action": "category", "category": food.pk}, format="json").json()
        self.assertEqual(StatementRule.objects.get().household, self.family)
        changed = andrey.patch(f"{RULES}{created['id']}/", {"action": "goal", "goal": self.andreys.pk}, format="json")
        self.assertEqual((changed.status_code, changed.json()["category"]), (200, None))
        rule = StatementRule.objects.get()
        self.assertEqual((rule.household_id, rule.user_id, rule.goal), (None, self.andrey.pk, self.andreys))
        back = andrey.patch(f"{RULES}{created['id']}/", {"action": "skip"}, format="json").json()
        self.assertEqual(back["goal"], None)
        self.assertEqual(StatementRule.objects.get().household, self.family)
        missing = andrey.post(RULES, {"pattern": "Депозит", "action": "goal"}, format="json")
        self.assertEqual(set(fields(missing)), {"goal"})
