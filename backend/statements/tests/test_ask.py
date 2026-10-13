"""Вопрос модели о незнакомых получателях: очередь, fake и подменённый Codex, предложения строкам.

Настоящая модель не вызывается: fake либо подменённый провайдер с несуществующим Codex.
"""
from datetime import date, timedelta
from unittest.mock import Mock

from django.test import TestCase, override_settings, tag

from catalog.models import Category
from receipts.ownership import local_user
from recognition.providers.base import ProviderError
from recognition.queue import db_now
from statements import ask, demo, drafts
from statements.models import StatementAsk, StatementRow
from statements.rules import owner_of, scope_of

DAY = date(2026, 10, 5)


@tag("integration")
class AskTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = local_user()
        cls.cafe = Category.objects.create(name="Кафе и рестораны")
        cls.health = Category.objects.create(name="Здоровье")

    def draft(self, *payees, sha="a" * 64):
        lines = [demo.kaspi_line(DAY, -1000 - index, "Покупка", payee) for index, payee in enumerate(payees)]
        statement, _created = drafts.import_text(self.owner, "\n".join(demo.kaspi_header(DAY, DAY) + lines),
                                                 sha256=sha, rule_scope=scope_of(self.owner))
        return statement

    def rows(self, statement):
        return [(row.merchant, row.ai, row.category_id, row.source, row.store_name)
                for row in statement.rows.order_by("position")]

    def test_fake_answer_suggests_categories_and_keeps_rows_in_review(self):
        statement = self.draft("ИП Кофейня Зерно", "ИП Кофейня Зерно", "Студия йоги Лотос", "MED CLINIC Sana")
        self.assertEqual(StatementAsk.objects.get().merchants, ["MED CLINIC Sana", "ИП Кофейня Зерно", "Студия йоги Лотос"])
        claimed = ask.claim()
        self.assertEqual((claimed.status, ask.claim()), ("running", None))
        result = ask.execute(claimed, asker=ask.FakeAsker())
        self.assertEqual((result.status, result.error_code), ("succeeded", ""))
        self.assertEqual(self.rows(statement), [
            ("ИП Кофейня Зерно", "done", self.cafe.pk, "model", "ИП Кофейня Зерно"),
            ("ИП Кофейня Зерно", "done", self.cafe.pk, "model", "ИП Кофейня Зерно"),
            ("Студия йоги Лотос", "unknown", None, "", "Студия йоги Лотос"),
            ("MED CLINIC Sana", "done", self.health.pk, "model", "MED CLINIC Sana"),
        ])
        self.assertEqual(set(statement.rows.values_list("state", flat=True)), {"review"})

    def test_store_name_of_the_model_and_rows_saved_meanwhile(self):
        statement = self.draft("ИП Кофейня Зерно", "ИП Кофейня Зерно")
        first = statement.rows.order_by("position").first()
        drafts.save(statement.pk, {"rows": [{"id": first.pk, "category": self.health.pk}]},
                    rule_owner=owner_of(self.owner), actor=self.owner)
        provider = Mock()
        provider.run_text.return_value = {"items": [{"id": 1, "category": self.cafe.pk, "store_name": "Кофейня «Зерно»"}]}
        ask.execute(ask.claim(), asker=ask.CodexAsker(provider))
        self.assertEqual(self.rows(statement)[1], ("ИП Кофейня Зерно", "done", self.cafe.pk, "model", "Кофейня «Зерно»"))
        first.refresh_from_db()
        self.assertEqual(first.category_id, None)  # the saved row is not touched
        prompt = provider.run_text.call_args.kwargs["prompt"]
        self.assertIn("INPUT JSON:", prompt)
        self.assertIn("ИП Кофейня Зерно", prompt)

    def test_bad_answers_and_failures_leave_rows_without_suggestion(self):
        cases = [
            ({"items": [{"id": 1, "category": 999999, "store_name": None}]}, "invalid_output"),
            ({"items": [{"id": 7, "category": None, "store_name": None}]}, "invalid_output"),
            ({"items": [{"id": 1, "category": None, "store_name": None}] * 2}, "invalid_output"),
            ({"items": [{"id": 1, "category": None}]}, "invalid_output"),
            (ProviderError("timeout"), "timeout"),
            (ProviderError("cancelled"), "worker_lost"),
        ]
        for index, (answer, code) in enumerate(cases):
            with self.subTest(code=code, index=index):
                statement = self.draft("Студия йоги Лотос", sha=f"{index:064d}")
                provider = Mock()
                if isinstance(answer, Exception):
                    provider.run_text.side_effect = answer
                else:
                    provider.run_text.return_value = answer
                result = ask.execute(ask.claim(), asker=ask.CodexAsker(provider))
                self.assertEqual((result.status, result.error_code), ("failed", code))
                self.assertEqual(self.rows(statement), [("Студия йоги Лотос", "failed", None, "", "Студия йоги Лотос")])

    def test_fake_scenarios(self):
        for scenario, code in (("invalid_output", "invalid_output"), ("provider_error", "provider_unavailable"),
                               ("timeout", "timeout")):
            with self.subTest(scenario=scenario):
                self.draft("Студия йоги Лотос", sha=scenario.ljust(64, "0"))
                result = ask.execute(ask.claim(), asker=ask.FakeAsker(scenario))
                self.assertEqual(result.error_code, code)

    def test_chunks_expiry_and_lost_worker(self):
        payees = [f"Незнакомое место {index:02d}" for index in range(ask.CHUNK + 3)]
        statement = self.draft(*payees)
        asks = list(StatementAsk.objects.order_by("pk"))
        self.assertEqual([len(item.merchants) for item in asks], [ask.CHUNK, 3])
        StatementAsk.objects.filter(pk=asks[1].pk).update(created_at=db_now() - ask.QUEUE_TTL - timedelta(seconds=1))
        claimed = ask.claim()
        self.assertEqual(claimed.pk, asks[0].pk)
        expired = StatementAsk.objects.get(pk=asks[1].pk)
        self.assertEqual((expired.status, expired.error_code), ("failed", "expired"))
        self.assertEqual(statement.rows.filter(merchant__in=expired.merchants, ai="failed").count(), 3)
        StatementAsk.objects.filter(pk=claimed.pk).update(lease_expires_at=db_now() - timedelta(seconds=1))
        self.assertEqual(ask.recover_expired(), 1)
        lost = StatementAsk.objects.get(pk=claimed.pk)
        self.assertEqual((lost.status, lost.error_code), ("failed", "worker_lost"))
        self.assertEqual(statement.rows.filter(ai="waiting").count(), 0)
        # A late answer of the lost owner is dropped.
        self.assertFalse(ask.finish(claimed, answers={}))

    @override_settings(RECEIPT_OCR_PROVIDER="fake")
    def test_get_asker_follows_the_provider(self):
        self.assertIsInstance(ask.get_asker(), ask.FakeAsker)
        with override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_CODEX_EXECUTABLE="nonexistent-checkist-codex"):
            self.assertIsInstance(ask.get_asker(), ask.CodexAsker)
        with override_settings(RECEIPT_OCR_PROVIDER="other"), self.assertRaises(ProviderError):
            ask.get_asker()

    def test_input_carries_categories_and_one_sample_per_payee(self):
        statement = self.draft("ИП Кофейня Зерно", "ИП Кофейня Зерно")
        payload = ask.build_input(StatementAsk.objects.get(statement=statement))
        self.assertEqual([item["name"] for item in payload["categories"]], ["Кафе и рестораны", "Здоровье"])
        self.assertEqual(payload["items"], [{"id": 1, "merchant": "ИП Кофейня Зерно", "operation": "Покупка", "mcc": None,
                                             "details": "ИП Кофейня Зерно", "amount": "1000.00", "currency": "KZT"}])
        self.assertEqual(StatementRow.objects.filter(statement=statement, ai="waiting").count(), 2)
