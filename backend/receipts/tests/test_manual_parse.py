"""«Трата словами»: очередь ``ManualParseRequest``, проверка ответа модели и исполнители.

Настоящая модель не вызывается: fake либо подменённый провайдер; Codex — несуществующий
исполняемый файл.
"""
from datetime import date, timedelta
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings, tag
from django.utils import timezone

from accounts.models import Household, Membership
from catalog.models import Category
from incomes.models import IncomeCategory
from receipts import manual, manual_parse
from receipts.manual_parse import CodexTextParser, FakeTextParser, ParseOutputError, draft_from_output
from receipts.models import ManualParseRequest, Receipt
from receipts.ownership import local_user
from recognition.providers.base import ProviderError
from recognition.queue import db_now

TODAY = date(2026, 10, 12)


def answer(**fields):
    """Ответ модели по схеме: все ключи, по умолчанию пустые."""
    base = {"kind": "spend", "total": None, "currency": None, "category": None, "purchased_on": None,
            "store_name": None, "note": None, "lines": []}
    return {**base, **fields}


class ParseFixture:
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.owner = local_user()
        cls.transport = Category.objects.create(name="Демо-транспорт")
        cls.taxi = Category.objects.create(name="Демо-такси", parent=cls.transport)
        cls.food = Category.objects.create(name="Демо-еда")

    def payload(self):
        return {"today": TODAY.isoformat(), "default_currency": "KZT", "categories": [], "currencies": ["KZT"],
                "text": "такси 4500"}

    def queued(self, text="такси до аэропорта 4500", **fields):
        return ManualParseRequest.objects.create(owner=self.owner, text=text, today=TODAY, **fields)


@tag("integration")
class DraftValidationTests(ParseFixture, TestCase):
    def test_simple_answer_becomes_post_body_with_defaults(self):
        draft = draft_from_output(answer(total="4500", category=self.taxi.pk, note=" до аэропорта "), self.payload())
        self.assertEqual(draft, {
            "total": "4500", "currency": "KZT", "category": self.taxi.pk, "purchased_on": "2026-10-12",
            "store_name": None, "note": "до аэропорта", "lines": [],
        })

    def test_lines_total_is_their_sum_and_named_values_are_kept(self):
        draft = draft_from_output(answer(
            total="1", currency="RUB", purchased_on="2026-10-11", store_name="Магнит", lines=[
                {"name": "Молоко", "amount": "450", "quantity": None, "category": self.food.pk},
                {"name": "Хлеб", "amount": "230.50", "quantity": "2", "category": None},
            ]), self.payload())
        self.assertEqual((draft["total"], draft["currency"], draft["purchased_on"], draft["store_name"]),
                         ("680.50", "RUB", "2026-10-11", "Магнит"))
        self.assertEqual(draft["lines"][1], {"name": "Хлеб", "amount": "230.50", "quantity": "2", "category": None})

    def test_bad_answers_are_invalid_output(self):
        bad = [
            {"total": "4500"},  # missing keys
            answer(total="4 500"),
            answer(total="12.345"),
            answer(currency="руб"),
            answer(currency="XYZ"),  # not in the catalog
            answer(category=999999),
            answer(category="1"),
            answer(purchased_on="2026-02-30"),
            answer(store_name="x" * 101),
            answer(lines=[{"name": " ", "amount": "1", "quantity": None, "category": None}]),
            answer(lines=[{"name": "a", "amount": "0", "quantity": None, "category": None}]),
            answer(extra=1),
            answer(kind="gift"),
            answer(kind="income", total="1", category=999999),  # not one of income_categories
            "not an object",
        ]
        for data in bad:
            with self.subTest(data=data), self.assertRaises(ParseOutputError):
                draft_from_output(data, self.payload())


    def test_income_answer_is_a_draft_of_an_income(self):
        payload = {**self.payload(), "income_categories": [{"id": 7, "name": "Зарплата"}]}
        draft = draft_from_output(answer(kind="income", total="650000", category=7, store_name="Работа",
                                         lines=[{"name": "x", "amount": "1", "quantity": None, "category": None}]), payload)
        self.assertEqual(draft, {"kind": "income", "total": "650000", "currency": "KZT", "category": 7,
                                 "purchased_on": "2026-10-12", "store_name": None, "note": "", "lines": []})
        with self.assertRaises(ParseOutputError):
            draft_from_output(answer(kind="income", total="0", category=7), payload)


@tag("integration")
class QueueTests(ParseFixture, TestCase):
    def test_request_and_limits(self):
        first = manual_parse.request(self.owner, "кофе 900")
        self.assertEqual((first.status, first.today), ("queued", timezone.localdate()))
        manual_parse.request(self.owner, "кофе 900", TODAY)
        manual_parse.request(self.owner, "кофе 900")
        with self.assertRaises(manual_parse.ParseLimit):
            manual_parse.request(self.owner, "кофе 900")
        ManualParseRequest.objects.update(status="succeeded")
        manual_parse.request(self.owner, "кофе 900")
        ManualParseRequest.objects.update(status="failed")
        for _ in range(manual_parse.MAX_PER_HOUR - ManualParseRequest.objects.count()):
            ManualParseRequest.objects.create(owner=self.owner, text="x", today=TODAY, status="failed")
        with self.assertRaises(manual_parse.ParseLimit):
            manual_parse.request(self.owner, "кофе 900")
        ManualParseRequest.objects.update(created_at=timezone.now() - timedelta(hours=2))
        manual_parse.request(self.owner, "кофе 900")

    def test_claim_takes_the_oldest_and_expires_stale(self):
        stale, first, second = self.queued(), self.queued(), self.queued()
        ManualParseRequest.objects.filter(pk=stale.pk).update(created_at=db_now() - timedelta(minutes=6))
        claimed = manual_parse.claim()
        self.assertEqual((claimed.pk, claimed.status), (first.pk, "running"))
        self.assertIsNotNone(claimed.run_token)
        self.assertGreater(claimed.lease_expires_at, db_now())
        stale.refresh_from_db()
        self.assertEqual((stale.status, stale.error_code), ("failed", "expired"))
        self.assertEqual(manual_parse.claim().pk, second.pk)
        self.assertIsNone(manual_parse.claim())

    def test_expired_lease_is_worker_lost_and_late_finish_is_dropped(self):
        self.queued()
        claimed = manual_parse.claim()
        ManualParseRequest.objects.filter(pk=claimed.pk).update(lease_expires_at=db_now() - timedelta(seconds=1))
        self.assertEqual(manual_parse.recover_expired(), 1)
        self.assertFalse(manual_parse.finish(claimed, draft={"total": "1"}))
        claimed.refresh_from_db()
        self.assertEqual((claimed.status, claimed.error_code, claimed.draft, claimed.run_token),
                         ("failed", "worker_lost", None, None))


@tag("integration")
class ExecuteTests(ParseFixture, TestCase):
    def run_one(self, parser, text="такси до аэропорта 4500"):
        self.queued(text)
        return manual_parse.execute(manual_parse.claim(), parser=parser)

    def test_fake_takes_the_last_number_the_first_category_and_today(self):
        receipts = Receipt.objects.count()
        row = self.run_one(FakeTextParser(), "молоко 450, хлеб 230,5")
        first = Category.objects.exclude(name="Не разобрано").order_by("pk").first()
        self.assertEqual((row.status, row.error_code), ("succeeded", ""))
        self.assertEqual(row.draft, {
            "total": "230.5", "currency": "KZT", "category": first.pk, "purchased_on": "2026-10-12",
            "store_name": None, "note": "", "lines": [],
        })
        self.assertEqual(Receipt.objects.count(), receipts)  # the parse saves nothing

    def test_fake_takes_a_salary_as_an_income_with_grouped_digits(self):
        salary = IncomeCategory.objects.get_or_create(name="Зарплата", household=None, user=None)[0]
        IncomeCategory.objects.get_or_create(name="Кэшбэк и проценты", household=None, user=None)
        row = self.run_one(FakeTextParser(), "зарплата 650 000")
        self.assertEqual(row.draft, {"kind": "income", "total": "650000", "currency": "KZT", "category": salary.pk,
                                     "purchased_on": "2026-10-12", "store_name": None, "note": "", "lines": []})
        cashback = IncomeCategory.objects.get(name="Кэшбэк и проценты", household=None, user=None)
        self.assertEqual(self.run_one(FakeTextParser(), "кэшбэк 3 200").draft["category"], cashback.pk)

    def test_fake_without_a_number_leaves_the_total_empty(self):
        self.assertIsNone(self.run_one(FakeTextParser(), "такси").draft["total"])

    def test_failures_have_their_codes_and_no_draft(self):
        for scenario, code in (("invalid_output", "invalid_output"), ("provider_error", "provider_unavailable"),
                               ("timeout", "timeout")):
            with self.subTest(scenario=scenario):
                row = self.run_one(FakeTextParser(scenario))
                self.assertEqual((row.status, row.error_code, row.draft), ("failed", code, None))

    def test_stop_of_the_worker_is_worker_lost(self):
        self.queued()
        row = manual_parse.execute(manual_parse.claim(), parser=FakeTextParser(), is_stopped=lambda: True)
        self.assertEqual((row.status, row.error_code), ("failed", "worker_lost"))

    def test_codex_parser_sends_prompt_input_and_schema(self):
        provider = Mock()
        provider.run_text.return_value = answer(total="4500", category=self.taxi.pk, store_name="Яндекс Такси")
        row = self.run_one(CodexTextParser(provider))
        self.assertEqual((row.status, row.draft["total"], row.draft["category"]), ("succeeded", "4500", self.taxi.pk))
        call = provider.run_text.call_args.kwargs
        self.assertEqual(call["schema"], manual_parse.SCHEMA_PATH)
        self.assertEqual(call["stage"], "parse")
        self.assertIn('"text": "такси до аэропорта 4500"', call["prompt"])
        self.assertIn('"today": "2026-10-12"', call["prompt"])
        self.assertIn(f'"id": {self.taxi.pk}, "name": "Демо-такси", "parent_id": {self.transport.pk}', call["prompt"])
        self.assertNotIn('"Не разобрано"', call["prompt"])
        self.assertIn('"income_categories": [', call["prompt"])

    def test_codex_errors_and_invalid_answers(self):
        provider = Mock()
        provider.run_text.side_effect = ProviderError("auth_required")
        self.assertEqual(self.run_one(CodexTextParser(provider)).error_code, "auth_required")
        provider.run_text.side_effect = None
        provider.run_text.return_value = answer(category=999999)
        self.assertEqual(self.run_one(CodexTextParser(provider)).error_code, "invalid_output")

    @override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_CODEX_EXECUTABLE="nonexistent-checkist-codex")
    def test_real_provider_without_codex_is_configuration_error(self):
        with patch("recognition.process_supervisor.ProcessSupervisor.run") as launch:
            row = self.run_one(manual_parse.get_parser())
        launch.assert_not_called()
        self.assertEqual((row.status, row.error_code), ("failed", "configuration_error"))

    def test_parser_choice(self):
        with override_settings(RECEIPT_OCR_PROVIDER="fake"):
            self.assertIsInstance(manual_parse.get_parser(), FakeTextParser)
            self.assertEqual(manual_parse.get_parser(scenario="timeout").scenario, "timeout")
        with self.assertRaises(ProviderError):
            FakeTextParser("unknown")


@tag("integration")
class HistoryInputTests(ParseFixture, TestCase):
    """Разбор словами с историей: похожие прошлые траты семьи и её места во входе модели."""

    def setUp(self):
        self.subs = Category.objects.create(name="Демо-подписки")
        for day in ("2026-08-12", "2026-09-12"):
            self.spend(self.owner, "CLAUDE.AI SUBSCRIPTION", "225", day, currency="USD")
        hidden = self.spend(self.owner, "Демо-секрет claude", "999", "2026-09-01")
        Receipt.objects.filter(pk=hidden.pk).update(hidden=True)

    def spend(self, owner, store, total, day, currency="KZT"):
        return manual.create(owner, {"total": total, "currency": currency, "category": self.subs.pk,
                                     "store_name": store, "purchased_on": day})

    def test_input_has_similar_spends_and_the_places_of_the_family_without_hidden_ones(self):
        payload = manual_parse.build_input(self.queued("claude подписка"))
        self.assertEqual([(item["store_name"], item["total"], item["currency"], item["category"], item["uses"])
                          for item in payload["history"]], [("CLAUDE.AI SUBSCRIPTION", "225.00", "USD", self.subs.pk, 2)])
        self.assertEqual(payload["stores"], [{"name": "CLAUDE.AI SUBSCRIPTION", "aliases": []}])
        self.assertEqual(manual_parse.build_input(self.queued("такси 4500"))["history"], [])

    def test_fake_repeats_the_same_spend_and_keeps_a_typed_amount(self):
        self.queued("claude подписка")
        row = manual_parse.execute(manual_parse.claim(), parser=FakeTextParser())
        self.assertEqual(row.draft, {
            "total": "225.00", "currency": "USD", "category": self.subs.pk, "purchased_on": "2026-10-12",
            "store_name": "CLAUDE.AI SUBSCRIPTION", "note": "", "lines": [],
        })
        self.queued("claude 230")
        self.assertEqual(manual_parse.execute(manual_parse.claim(), parser=FakeTextParser()).draft["total"], "230")

    @override_settings(CHECKIST_AUTH_MODE="accounts")
    def test_history_is_the_family_of_the_requester(self):
        users = get_user_model().objects
        first, second, outsider = (users.create_user(name) for name in ("synthetic-a", "synthetic-b", "synthetic-c"))
        family = Household.objects.create(name="Демо-семья")
        Membership.objects.create(user=first, household=family, role="head")
        Membership.objects.create(user=second, household=family)
        self.spend(second, "Демо-кофейня", "1500", "2026-10-01")
        self.spend(outsider, "Демо-чужое", "700", "2026-10-01")
        row = ManualParseRequest.objects.create(owner=first, text="кофейня", today=TODAY)
        payload = manual_parse.build_input(row)
        self.assertEqual([item["store_name"] for item in payload["history"]], ["Демо-кофейня"])
        self.assertEqual(payload["stores"], [{"name": "Демо-кофейня", "aliases": []}])
