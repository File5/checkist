"""Шаг ``recognition_worker``: вопрос о получателях выписки идёт после «Траты словами», до задания фото. Только fake."""
from datetime import date
from unittest.mock import patch

from django.test import tag

from catalog.models import Category
from receipts import manual_parse
from receipts.ownership import local_user
from recognition.management.commands import recognition_worker
from recognition.tests.test_worker_classification import WorkerClassificationEnvironment
from statements import ask, demo, drafts
from statements.models import StatementAsk
from statements.rules import scope_of
from stores.models import Currency

DAY = date(2026, 10, 5)


@tag("integration")
class WorkerStatementAskTests(WorkerClassificationEnvironment):
    def setUp(self):
        super().setUp()
        Currency.objects.get_or_create(code="KZT", defaults={"name": "Tenge"})
        Category.objects.create(name="Кафе и рестораны")

    def draft(self):
        text = "\n".join(demo.kaspi_header(DAY, DAY) + [demo.kaspi_line(DAY, -3200, "Покупка", "ИП Кофейня Зерно")])
        statement, _created = drafts.import_text(local_user(), text, sha256="f" * 64, rule_scope=scope_of(local_user()))
        return statement, StatementAsk.objects.get(statement=statement)

    def test_order_parse_then_statement_question_then_job(self):
        job = self.new_job()
        statement, question = self.draft()
        parse = manual_parse.request(local_user(), "такси 4500")
        self.assertEqual(self.worker(), [f"Manual parse {parse.pk}: succeeded"])
        self.assertEqual(self.worker(), [f"Statement question {question.pk}: succeeded"])
        row = statement.rows.get()
        self.assertEqual((row.ai, row.source, row.category.name), ("done", "model", "Кафе и рестораны"))
        self.assertEqual(self.job_state(job)["status"], "queued")
        self.assertEqual(self.worker(), [f"Job {job.pk}: succeeded"])

    def test_unexpected_error_fails_the_question_not_the_worker(self):
        statement, question = self.draft()
        with patch.object(ask, "build_input", side_effect=RuntimeError("boom")):
            self.assertEqual(self.worker(), [f"Statement question {question.pk}: failed"])
        question.refresh_from_db()
        self.assertEqual((question.status, question.error_code), ("failed", "internal_error"))
        self.assertEqual(statement.rows.get().ai, "failed")

    def test_fake_scenario_from_the_environment(self):
        _statement, question = self.draft()
        with patch.dict("os.environ", {ask.FAKE_SCENARIO_ENV: "timeout"}):
            self.worker()
        self.assertEqual(StatementAsk.objects.get(pk=question.pk).error_code, "timeout")

    def test_asker_configuration_error_stops_startup(self):
        with patch.object(ask, "get_asker", side_effect=ask.ProviderError("configuration_error")):
            with self.assertRaisesMessage(recognition_worker.CommandError, "Statement payee asker"):
                recognition_worker.build_statement_asker()
