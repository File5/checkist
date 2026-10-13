"""Черновик выписки: решение строк, возвраты того же дня, дубли, сохранение трат и обучение правил.

Выписки вымышленные; модель не вызывается (вопросы лишь ставятся в очередь).
"""
import re
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, tag

from api.export import STATEMENT_NOTE_REGEX
from catalog.models import Category
from receipts import manual
from receipts.models import Receipt
from receipts.ownership import local_user
from statements import ask, demo, drafts
from statements.extract import StatementError
from statements.models import StatementAsk, StatementImport, StatementRow, StatementRule
from statements.rules import owner_of, scope_of

END = date(2026, 10, 12)


def kaspi(*lines):
    return "\n".join(demo.kaspi_header(END, END) + list(lines))


def day(number):
    return date(2026, 10, number)


class DraftFixture:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.owner = local_user()
        cls.food = Category.objects.create(name="Еда и напитки")
        cls.transport = Category.objects.create(name="Транспорт")
        cls.cafe = Category.objects.create(name="Кафе и рестораны")
        cls.bank = Category.objects.create(name="Банк и комиссии")
        cls.home = Category.objects.create(name="Жильё")
        cls.rent = Category.objects.create(name="Аренда", parent=cls.home)
        cls.utilities = Category.objects.create(name="Коммунальные услуги", parent=cls.home)
        cls.fun = Category.objects.create(name="Развлечения")

    def draft(self, *lines, sha="a" * 64):
        statement, created = drafts.import_text(self.owner, kaspi(*lines), sha256=sha, rule_scope=scope_of(self.owner))
        self.assertTrue(created)
        return statement, list(statement.rows.order_by("position"))

    def rule(self, pattern, action="category", category=None, store_name=""):
        from statements.rules import normalize

        return StatementRule.objects.create(user=self.owner, pattern=pattern, key=normalize(pattern), action=action,
                                            category=category, store_name=store_name)

    def spend(self, when, amount, category, store=None, lines=None):
        if lines:
            return manual.create(self.owner, {
                "currency": "KZT", "purchased_on": when.isoformat(), "store_name": store,
                "lines": [{"name": name, "amount": str(value), "category": cat.pk} for name, value, cat in lines]})
        data = {"currency": "KZT", "purchased_on": when.isoformat(), "total": str(amount), "category": category.pk}
        if store:
            data["store_name"] = store
        return manual.create(self.owner, data)


@tag("integration")
class ClassifyTests(DraftFixture, TestCase):
    def test_kinds_states_and_suggestions(self):
        statement, rows = self.draft(
            demo.kaspi_line(day(1), -18450, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
            demo.kaspi_line(day(2), -1450, "Покупка", "YANDEX.GO"),
            demo.kaspi_line(day(3), -3200, "Покупка", "ИП Кофейня Зерно"),
            demo.kaspi_line(day(4), -50000, "Перевод", "Мария К."),
            demo.kaspi_line(day(5), -20000, "Снятие", "Банкомат Kaspi"),
            demo.kaspi_line(day(6), 150000, "Пополнение", "С Kaspi Депозита"),
            demo.kaspi_line(day(7), 35000, "Перевод", "Дмитрий С."),
            demo.kaspi_line(day(8), 412, "Разное", "Kaspi Бонус: кэшбэк"),
            demo.kaspi_line(day(9), -990, "Разное", "Комиссия за перевод"),
            demo.kaspi_line(day(10), -7000, "Перевод", "На Kaspi Депозит"),
        )
        got = [(row.kind, row.state, row.reason, row.category_id, row.store_name, row.source) for row in rows]
        self.assertEqual(got, [
            ("spend", "spend", "", self.food.pk, "MAGNUM", "builtin"),
            ("spend", "spend", "", self.transport.pk, "Yandex Go", "builtin"),
            ("spend", "review", "", None, "ИП Кофейня Зерно", ""),
            ("transfer", "skipped", "transfer", None, "", ""),
            ("cash", "skipped", "cash", None, "", ""),
            ("own_move", "skipped", "own_move", None, "", ""),
            ("income", "skipped", "income", None, "", ""),
            ("income", "skipped", "income", None, "", ""),
            ("spend", "spend", "", self.bank.pk, "", "builtin"),
            ("own_move", "skipped", "own_move", None, "", ""),
        ])
        # Incoming rows are kept with their counterparty for later: never dropped.
        self.assertEqual(rows[6].merchant, "Дмитрий С.")
        self.assertEqual((statement.bank, statement.date_from, statement.date_to), ("kaspi_gold", day(1), day(10)))
        # Only the unknown payee goes to the model, once.
        self.assertEqual(list(StatementAsk.objects.values_list("merchants", flat=True)), [["ИП Кофейня Зерно"]])
        self.assertEqual(rows[2].ai, "waiting")

    def test_rules_beat_defaults_and_name_people(self):
        self.rule("Олег Б", category=self.rent, store_name="Съёмное жильё")
        self.rule("magnum cash", category=self.fun)
        self.rule("Мария К", action="skip")
        self.rule("Екатерина П", action="own")
        _statement, rows = self.draft(
            demo.kaspi_line(day(1), -220000, "Перевод", "Олег Б."),
            demo.kaspi_line(day(2), -18450, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
            demo.kaspi_line(day(3), -500, "Покупка", "Мария К."),
            demo.kaspi_line(day(4), -30000, "Перевод", "Екатерина П."),
            demo.kaspi_line(day(5), 30000, "Перевод", "Екатерина П."),
        )
        self.assertEqual([(row.kind, row.state, row.reason, row.category_id, row.store_name, row.source) for row in rows], [
            ("transfer", "spend", "", self.rent.pk, "Съёмное жильё", "rule"),
            ("spend", "spend", "", self.fun.pk, "MAGNUM", "rule"),
            ("spend", "skipped", "rule", None, "", "rule"),
            ("own_move", "skipped", "own_move", None, "", "rule"),
            ("own_move", "skipped", "own_move", None, "", "rule"),
        ])

    def test_longest_rule_wins(self):
        self.rule("magnum", category=self.food)
        self.rule("magnum cash carry", category=self.fun)
        _statement, rows = self.draft(demo.kaspi_line(day(1), -100, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'))
        self.assertEqual(rows[0].category_id, self.fun.pk)

    def test_missing_default_category_leaves_the_row_to_the_model(self):
        _statement, rows = self.draft(demo.kaspi_line(day(1), -1000, "Покупка", "STEAM PURCHASE"))
        self.assertEqual((rows[0].state, rows[0].category_id), ("spend", self.fun.pk))
        Category.objects.filter(pk=self.fun.pk).delete()
        _statement, rows = self.draft(demo.kaspi_line(day(1), -1000, "Покупка", "STEAM PURCHASE"), sha="b" * 64)
        self.assertEqual((rows[0].state, rows[0].category_id), ("review", None))

    def test_without_the_right_to_the_model_nothing_is_asked(self):
        with patch.object(ask, "_ai_allowed", return_value=False):
            _statement, rows = self.draft(demo.kaspi_line(day(1), -3200, "Покупка", "ИП Кофейня Зерно"))
        self.assertEqual(rows[0].ai, "off")
        self.assertFalse(StatementAsk.objects.exists())

    def test_family_ai_switch_and_quota_decide_the_question(self):
        from accounts.models import AiUsage, Household, Membership
        from api.tests.accounts_helpers import accounts_mode

        family = Household.objects.create(name="Демо-семья")  # новая семья: ИИ выключен, предел 50
        Membership.objects.create(user=self.owner, household=family, role="head")
        with accounts_mode():
            _statement, rows = self.draft(demo.kaspi_line(day(1), -3200, "Покупка", "ИП Кофейня Зерно"))
            self.assertEqual(rows[0].ai, "off")
            self.assertFalse(StatementAsk.objects.exists())
            Household.objects.filter(pk=family.pk).update(ai_enabled=True)
            _statement, rows = self.draft(demo.kaspi_line(day(1), -3200, "Покупка", "ИП Кофейня Зерно"), sha="d" * 64)
            self.assertEqual(rows[0].ai, "waiting")
        self.assertEqual(StatementAsk.objects.count(), 1)
        self.assertEqual(AiUsage.objects.get(household=family).count, 1)

    def test_unsupported_bank_and_empty_statement(self):
        for text, code in (("АО «Halyk Bank»\nВыписка", "statement_unsupported_bank"),
                           (kaspi("Итого: 0"), "statement_empty")):
            with self.subTest(code=code), self.assertRaises(StatementError) as raised:
                drafts.import_text(self.owner, text, sha256="c" * 64, rule_scope=scope_of(self.owner))
            self.assertEqual(raised.exception.code, code)
        self.assertFalse(StatementImport.objects.exists())


@tag("integration")
class RefundTests(DraftFixture, TestCase):
    def test_same_day_refund_reduces_the_purchase(self):
        _statement, rows = self.draft(
            demo.kaspi_line(day(3), -6400, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
            demo.kaspi_line(day(3), 1200, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
            demo.kaspi_line(day(4), -2000, "Покупка", "YANDEX.GO"),
            demo.kaspi_line(day(4), 2000, "Покупка", "YANDEX.GO"),
            demo.kaspi_line(day(5), 700, "Покупка", "Другой магазин"),
        )
        purchase, refund, ride, back, lonely = rows
        self.assertEqual((purchase.state, purchase.refund, drafts.spend_amount(purchase)),
                         ("spend", Decimal("1200.00"), Decimal("5200.00")))
        self.assertEqual((refund.kind, refund.state, refund.reason), ("refund", "skipped", "refund"))
        self.assertEqual((ride.state, ride.reason), ("skipped", "refunded"))
        self.assertEqual(back.kind, "refund")
        # No purchase that day: an incoming, kept as such.
        self.assertEqual((lonely.kind, lonely.reason), ("income", "income"))


@tag("integration")
class DuplicateTests(DraftFixture, TestCase):
    def test_same_amount_within_a_day_is_a_duplicate_once(self):
        existing = self.spend(day(4), "3200.00", self.cafe, "Кофейня")
        _statement, rows = self.draft(
            demo.kaspi_line(day(5), -3200, "Покупка", "ИП Кофейня Зерно"),
            demo.kaspi_line(day(5), -3200, "Покупка", "ИП Кофейня Зерно"),
            demo.kaspi_line(day(8), -3200, "Покупка", "ИП Кофейня Зерно"),
        )
        self.assertEqual([(row.state, row.reason, row.duplicate_of_id) for row in rows], [
            ("duplicate", "duplicate", existing.pk), ("review", "", None), ("review", "", None)])
        # A duplicate is not asked about.
        self.assertEqual(StatementAsk.objects.get().merchants, ["ИП Кофейня Зерно"])

    def test_spend_of_another_person_is_not_a_duplicate(self):
        from django.contrib.auth import get_user_model

        other = get_user_model().objects.create_user("vera")
        manual.create(other, {"currency": "KZT", "purchased_on": day(5).isoformat(), "total": "3200", "category": self.cafe.pk})
        _statement, rows = self.draft(demo.kaspi_line(day(5), -3200, "Покупка", "ИП Кофейня Зерно"))
        self.assertEqual(rows[0].state, "review")

    def test_housing_transfer_matches_an_entered_bill(self):
        self.rule("Олег Б", category=self.utilities)
        bill = self.spend(day(2), None, None, "Съёмное жильё", lines=[
            ("Электроэнергия", Decimal("6200.72"), self.utilities), ("Вода", Decimal("1500.00"), self.utilities)])
        _statement, rows = self.draft(
            demo.kaspi_line(day(9), -7701, "Перевод", "Олег Б."),
            demo.kaspi_line(day(9), -7701, "Перевод", "Олег Б."),
        )
        self.assertEqual([(row.state, row.reason, row.duplicate_of_id) for row in rows], [
            ("duplicate", "bill", bill.pk), ("spend", "", None)])


@tag("integration")
class SaveTests(DraftFixture, TestCase):
    def saved(self, statement, *items):
        return drafts.save(statement.pk, {"rows": list(items)}, rule_owner=owner_of(self.owner), actor=self.owner)[:2]

    def test_spends_are_created_for_the_uploader_with_the_statement_note(self):
        statement, rows = self.draft(
            demo.kaspi_line(day(3), -6400, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
            demo.kaspi_line(day(3), 1200, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
            demo.kaspi_line(day(9), -990, "Разное", "Комиссия за перевод"),
        )
        created, learned = self.saved(
            statement, {"id": rows[0].pk, "category": self.food.pk, "store_name": "MAGNUM"},
            {"id": rows[2].pk, "category": self.bank.pk, "store_name": ""})
        self.assertEqual((created, learned), (2, 0))
        purchase = Receipt.objects.get(pk=StatementRow.objects.get(pk=rows[0].pk).receipt_id)
        self.assertEqual((purchase.owner, purchase.source, purchase.total, purchase.purchased_on, purchase.store.name),
                         (self.owner, "manual", Decimal("5200.00"), day(3), "MAGNUM"))
        self.assertEqual(purchase.note, "с учётом возврата 1200.00 · Выписка Kaspi Gold")
        fee = Receipt.objects.get(pk=StatementRow.objects.get(pk=rows[2].pk).receipt_id)
        self.assertEqual((fee.store, fee.note), (None, "Комиссия за перевод · Выписка Kaspi Gold"))
        for receipt, category in ((purchase, self.food), (fee, self.bank)):
            self.assertTrue(re.search(STATEMENT_NOTE_REGEX, receipt.note))
            self.assertEqual(receipt.lines.get().category_id, category.pk)
            self.assertEqual(receipt.payment_method, "kaspi_gold")
        statement.refresh_from_db()
        self.assertIsNotNone(statement.saved_at)

    def test_forte_spends_are_paid_by_forte(self):
        text = "\n".join(demo.forte_header(END, END) + [demo.forte_line(day(3), -1450, "Покупка", "YANDEX.GO")])
        statement, _ = drafts.import_text(self.owner, text, sha256="f" * 64, rule_scope=scope_of(self.owner))
        row = statement.rows.get()
        self.saved(statement, {"id": row.pk, "category": self.transport.pk, "store_name": "Yandex Go"})
        receipt = Receipt.objects.get()
        self.assertEqual((receipt.note.endswith("· Выписка ForteBank"), receipt.payment_method), (True, "forte"))

    def test_a_plain_spend_note_still_marks_the_statement(self):
        statement, rows = self.draft(demo.kaspi_line(day(3), -1450, "Покупка", "YANDEX.GO"))
        self.saved(statement, {"id": rows[0].pk, "category": self.transport.pk, "store_name": "Yandex Go"})
        note = Receipt.objects.get().note
        self.assertEqual(note, "· Выписка Kaspi Gold")
        self.assertTrue(re.search(STATEMENT_NOTE_REGEX, note))

    def test_repeat_is_safe_and_income_is_refused(self):
        statement, rows = self.draft(
            demo.kaspi_line(day(3), -1450, "Покупка", "YANDEX.GO"),
            demo.kaspi_line(day(4), 35000, "Перевод", "Дмитрий С."),
        )
        item = {"id": rows[0].pk, "category": self.transport.pk, "store_name": "Yandex Go"}
        self.assertEqual(self.saved(statement, item), (1, 0))
        self.assertEqual(self.saved(statement, item), (0, 0))
        self.assertEqual(Receipt.objects.count(), 1)
        with self.assertRaises(drafts.SaveInvalid) as raised:
            self.saved(statement, {"id": rows[1].pk, "category": self.food.pk})
        self.assertEqual(raised.exception.fields, {"rows.0.id": "income"})

    def test_bad_bodies(self):
        statement, rows = self.draft(demo.kaspi_line(day(3), -1450, "Покупка", "YANDEX.GO"))
        other, other_rows = self.draft(demo.kaspi_line(day(3), -1450, "Покупка", "YANDEX.GO"), sha="d" * 64)
        cases = [
            ({}, {"rows": "required"}),
            ({"rows": "x"}, {"rows": "type"}),
            ({"rows": [{"id": rows[0].pk}]}, {"rows.0.category": "required"}),
            ({"rows": [{"id": rows[0].pk, "category": self.food.pk, "x": 1}]}, {"rows.0.x": "unknown_field"}),
            ({"rows": [{"id": rows[0].pk, "category": self.food.pk}, {"id": rows[0].pk, "category": self.food.pk}]},
             {"rows.1.id": "repeated"}),
            ({"rows": [{"id": other_rows[0].pk, "category": self.food.pk}]}, {"rows.0.id": "unknown"}),
            ({"rows": [{"id": rows[0].pk, "category": 999999}]}, {"rows.0.category": "unknown"}),
            ({"rows": [{"id": rows[0].pk, "category": self.food.pk, "store_name": "x" * 101}]}, {"rows.0.store_name": "too_long"}),
        ]
        for body, fields in cases:
            with self.subTest(body=body), self.assertRaises(drafts.SaveInvalid) as raised:
                drafts.save(statement.pk, body, rule_owner=owner_of(self.owner), actor=self.owner)
            self.assertEqual(raised.exception.fields, fields)
        self.assertFalse(Receipt.objects.exists())

    def test_corrections_teach_rules(self):
        statement, rows = self.draft(
            demo.kaspi_line(day(1), -1450, "Покупка", "YANDEX.GO"),
            demo.kaspi_line(day(2), -3200, "Покупка", "ИП Кофейня Зерно"),
            demo.kaspi_line(day(3), -220000, "Перевод", "Олег Б."),
        )
        created, learned = self.saved(
            statement,
            {"id": rows[0].pk, "category": self.transport.pk, "store_name": "Yandex Go"},  # as suggested: nothing to learn
            {"id": rows[1].pk, "category": self.cafe.pk, "store_name": "Кофейня Зерно"},
            {"id": rows[2].pk, "category": self.rent.pk, "store_name": "Съёмное жильё"},
        )
        self.assertEqual((created, learned), (3, 2))
        rules = {rule.key: (rule.action, rule.category_id, rule.store_name, rule.origin, rule.user_id)
                 for rule in StatementRule.objects.all()}
        self.assertEqual(rules, {
            "ип кофейня зерно": ("category", self.cafe.pk, "Кофейня Зерно", "learned", self.owner.pk),
            "олег б": ("category", self.rent.pk, "Съёмное жильё", "learned", self.owner.pk),
        })
        # The next statement knows both payees.
        _next, next_rows = self.draft(
            demo.kaspi_line(day(11), -3300, "Покупка", "ИП Кофейня Зерно"),
            demo.kaspi_line(day(11), -230000, "Перевод", "Олег Б."), sha="e" * 64)
        self.assertEqual([(row.state, row.category_id, row.store_name, row.source) for row in next_rows], [
            ("spend", self.cafe.pk, "Кофейня Зерно", "rule"), ("spend", self.rent.pk, "Съёмное жильё", "rule")])

    def test_learning_updates_the_family_rule(self):
        from accounts.models import Household, Membership
        from django.test import override_settings

        family = Household.objects.create(name="Вымышленная семья")
        Membership.objects.create(household=family, user=self.owner, role="head")
        with override_settings(CHECKIST_AUTH_MODE="accounts"):
            owner = owner_of(self.owner)
        self.assertEqual(owner, {"household": family, "user": None})
        StatementRule.objects.create(household=family, pattern="YANDEX.GO", key="yandex go", category=self.food)
        statement, rows = self.draft(demo.kaspi_line(day(1), -1450, "Покупка", "YANDEX.GO"))
        drafts.save(statement.pk, {"rows": [{"id": rows[0].pk, "category": self.transport.pk}]}, rule_owner=owner,
                    actor=self.owner)
        rule = StatementRule.objects.get()
        self.assertEqual((rule.household_id, rule.category_id, rule.store_name), (family.pk, self.transport.pk, ""))


@tag("integration")
class AcceptTests(DraftFixture, TestCase):
    def test_the_same_file_is_the_same_draft(self):
        data = demo.pdf_bytes(demo.demo_kaspi_lines(END))
        first, created = drafts.accept(self.owner, data, rule_scope=scope_of(self.owner))
        again, created_again = drafts.accept(self.owner, data, rule_scope=scope_of(self.owner))
        self.assertEqual((created, created_again, again.pk), (True, False, first.pk))
        self.assertEqual(StatementImport.objects.count(), 1)
        self.assertEqual(first.rows.count(), 20)
        self.assertEqual(len(first.sha256), 64)
