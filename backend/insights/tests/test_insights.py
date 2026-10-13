"""ИИ о тратах: сводка, очередь, fake и подменённый Codex, API и шаг воркера.

Настоящая модель не вызывается: fake либо подменённый провайдер с несуществующим Codex. Имена и суммы вымышленные.
"""
import json
from datetime import date, timedelta
from decimal import Decimal
from unittest.mock import Mock, patch

from django.test import TestCase, override_settings, tag
from django.utils import timezone
from rest_framework.test import APIClient

from accounts.ai import AiRefused
from accounts.models import AiUsage, Household, Membership
from api.tests.accounts_helpers import accounts_mode, local_single_mode, make_user
from api.tests.test_owner_isolation import IsolationMixin
from budget.dashboard import Month
from budget.history import save_limit
from budget.models import BudgetLimit
from catalog.models import Category
from insights import context, queue
from insights.models import InsightRequest
from receipts import manual, manual_parse
from receipts.models import Receipt
from receipts.ownership import local_user
from recognition.management.commands import recognition_worker
from recognition.providers.base import ProviderError
from recognition.queue import db_now
from recognition.tests.test_worker_classification import WorkerClassificationEnvironment
from statements import demo, drafts
from statements.models import StatementAsk
from statements.rules import scope_of
from stores.models import Currency

REVIEW = "/api/insights/review/"
ASK = "/api/insights/ask/"


def spend(owner, day, total, category, store=None):
    data = {"currency": "KZT", "purchased_on": day.isoformat(), "total": f"{total:.2f}", "category": category.pk}
    if store:
        data["store_name"] = store
    return manual.create(owner, data)


def months_back(month, count):
    for _ in range(count):
        month = month.previous()
    return month


class Spends:
    """Траты ``owner`` за два месяца до ``month`` и в нём самом: еда, кафе (подкатегория еды), транспорт."""

    @classmethod
    def seed(cls, owner, month):
        cls.food = Category.objects.create(name="Синтетическая еда")
        cls.cafe = Category.objects.create(name="Синтетическое кафе", parent=cls.food)
        cls.taxi = Category.objects.create(name="Синтетическое такси")
        before, earlier = month.previous(), months_back(month, 2)
        spend(owner, earlier.first, 1000, cls.food, "Лавка")
        spend(owner, before.first, 3000, cls.food, "Лавка")
        spend(owner, month.first, 4000, cls.food, "Лавка")
        spend(owner, month.first + timedelta(days=1), 2500, cls.cafe, "Кофейня")
        spend(owner, month.first + timedelta(days=2), 700, cls.taxi)


@tag("integration")
class ContextTests(Spends, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.today = timezone.localdate()
        cls.month = Month.of(cls.today).previous()
        cls.seed(local_user(), cls.month)

    def test_summary_of_the_month_window_and_places(self):
        summary = context.build(local_user(), self.month, self.today)
        self.assertEqual((summary["month"], summary["currency"], len(summary["months"])), (self.month.label(), "KZT", 12))
        self.assertEqual(summary["months"][-1], self.month.label())
        self.assertEqual(summary["totals"][-3:], ["1000.00", "3000.00", "7200.00"])
        focus = summary["focus"]
        # The average: the earlier months from the first one with spends, not the empty ones before it.
        self.assertEqual((focus["spent"], focus["previous"], focus["average"]), ("7200.00", "3000.00", "2000.00"))
        self.assertEqual((focus["change_previous"], focus["change_average"]), ("4200.00", "5200.00"))
        self.assertEqual([(item["name"], item["spent"], item["previous"]) for item in focus["categories"]],
                         [("Синтетическая еда", "6500.00", "3000.00"), ("Синтетическое такси", "700.00", "0.00")])
        cafe = next(item for item in summary["categories"] if item["id"] == self.cafe.pk)
        self.assertEqual((cafe["parent_id"], cafe["amounts"][-1]), (self.food.pk, "2500.00"))
        self.assertEqual(focus["places"], [{"name": "Лавка", "spent": "4000.00", "count": 1},
                                           {"name": "Кофейня", "spent": "2500.00", "count": 1},
                                           {"name": "Без места", "spent": "700.00", "count": 1}])
        self.assertEqual(summary["places_year"][0], {"name": "Лавка", "spent": "8000.00", "count": 3})
        self.assertEqual((summary["incomes"], summary["without_rate"], summary["recurring"]), ([], [], []))

    def test_incomes_of_the_window_in_the_base_currency(self):
        from incomes.models import Income, IncomeCategory
        salary = IncomeCategory.objects.create(user=local_user(), name="Синтетическая зарплата")
        for day, total in ((self.month.first, 650000), (self.month.previous().first, 600000)):
            Income.objects.create(owner=local_user(), received_on=day, amount=Decimal(total), currency_id="KZT",
                                  category=salary)
        self.assertEqual(context.build(local_user(), self.month, self.today)["incomes"], [
            {"month": self.month.previous().label(), "total": "600000.00"},
            {"month": self.month.label(), "total": "650000.00"}])

    def test_limits_of_the_month_show_what_is_over(self):
        current = Month.of(self.today)
        spend(local_user(), self.today, 900, self.taxi)
        save_limit(BudgetLimit(user=local_user(), category=self.taxi, currency_id="KZT", amount=Decimal("500")))
        focus = context.build(local_user(), current, self.today)["focus"]
        self.assertEqual(focus["limits"], [{"category": "Синтетическое такси", "limit": "500.00", "spent": "900.00",
                                            "over": "400.00"}])
        self.assertEqual((focus["limit_total"], focus["limited_spent"]), ("500.00", "900.00"))

    def test_query_count_does_not_grow_with_data(self):
        with self.assertNumQueries(20):  # ponytail: incomes.services.totals также читает траты — один лишний запрос на разбор
            context.build(local_user(), self.month, self.today)
        spend(local_user(), self.month.first, 100, Category.objects.create(name="Ещё одна"), "Новое место")
        with self.assertNumQueries(20):  # ponytail: incomes.services.totals также читает траты — один лишний запрос на разбор
            context.build(local_user(), self.month, self.today)


@tag("integration")
@accounts_mode()
class VisibilityTests(TestCase):
    """``head`` и ``member`` — семья, ``stranger`` — без неё. Скрытый платёж главного не виден в сводке никому."""

    @classmethod
    def setUpTestData(cls):
        cls.head, cls.member, cls.stranger = make_user("synthetic-head"), make_user("synthetic-member"), make_user("synthetic-stranger")
        family = Household.objects.create(name="Синтетическая семья")
        Membership.objects.create(user=cls.head, household=family, role="head")
        Membership.objects.create(user=cls.member, household=family)
        cls.today = timezone.localdate()
        cls.month = Month.of(cls.today)
        food = Category.objects.create(name="Синтетическая еда")
        spend(cls.head, cls.month.first, 1000, food, "Лавка")
        spend(cls.member, cls.month.first, 300, food, "Лавка")
        hidden = spend(cls.head, cls.month.first, 50000, food, "Сюрприз")
        Receipt.objects.filter(pk=hidden.pk).update(hidden=True)
        spend(cls.stranger, cls.month.first, 7000, food, "Чужое место")

    def test_hidden_payment_and_other_families_stay_out(self):
        for account in (self.member, self.head):
            with self.subTest(account=account.username):
                summary = context.build(account, self.month, self.today)
                self.assertEqual(summary["focus"]["spent"], "1300.00")
                names = json.dumps(summary, ensure_ascii=False)
                self.assertNotIn("Сюрприз", names)
                self.assertNotIn("Чужое место", names)
        self.assertEqual(context.build(self.stranger, self.month, self.today)["focus"]["spent"], "7000.00")


@tag("integration")
class QueueTests(Spends, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.today = timezone.localdate()
        cls.month = Month.of(cls.today).previous()
        cls.seed(local_user(), cls.month)

    def review(self):
        return queue.request_review(local_user(), self.month, self.today)

    def ask(self, question="Сколько ушло на синтетическую еду?"):
        return queue.request_ask(local_user(), question, Month.of(self.today), self.today)

    def test_use_ai_comes_before_the_queue_and_its_refusal_queues_nothing(self):
        def refuse(user):
            self.assertFalse(InsightRequest.objects.exists())  # nothing is queued before the check
            raise AiRefused("ai_quota", resets_at=timezone.now() + timedelta(hours=1))

        with patch.object(queue, "use_ai", side_effect=refuse) as checked:
            for request in (self.review, self.ask):
                with self.subTest(request=request.__name__), self.assertRaises(AiRefused):
                    request()
        self.assertEqual(checked.call_count, 2)
        self.assertFalse(InsightRequest.objects.exists())

    def test_fake_review_uses_only_numbers_of_the_summary(self):
        row = self.review()
        self.assertEqual((row.status, row.kind, row.month), ("queued", "review", self.month.first))
        self.assertEqual(row.context["focus"]["spent"], "7200.00")
        claimed = queue.claim()
        self.assertEqual((claimed.pk, claimed.status, queue.claim()), (row.pk, "running", None))
        result = queue.execute(claimed, writer=queue.FakeWriter())
        self.assertEqual((result.status, result.error_code), ("succeeded", ""))
        self.assertIn("«Синтетическая еда»: 6\u00a0500\u00a0KZT", result.answer["summary"])
        self.assertEqual(len(result.answer["advice"]), 2)
        self.assertIsNone(result.answer["limits"])
        self.assertEqual(queue.unverified(result), [])

    def test_unfinished_review_of_the_month_is_reused_without_a_new_ai_request(self):
        with patch.object(queue, "use_ai") as checked:
            first, second = self.review(), self.review()
        self.assertEqual((first.pk, checked.call_count), (second.pk, 1))
        queue.execute(queue.claim(), writer=queue.FakeWriter())
        with patch.object(queue, "use_ai") as checked:
            third = self.review()
        self.assertNotEqual(third.pk, first.pk)  # «Обновить» after a finished review asks again
        self.assertEqual(checked.call_count, 1)

    def test_fake_answer_to_a_question(self):
        self.ask()
        result = queue.execute(queue.claim(), writer=queue.FakeWriter())
        self.assertEqual(result.answer, {"answer": "На «Синтетическая еда» в этом месяце ушло 0\u00a0KZT."})
        self.ask("Сколько стоит квартира в Астане?")
        result = queue.execute(queue.claim(), writer=queue.FakeWriter())
        self.assertTrue(result.answer["answer"].startswith("Не знаю: в данных нет"))

    def test_codex_prompt_carries_the_summary_and_the_question(self):
        self.ask("Почему этот месяц дороже?")
        provider = Mock()
        provider.run_text.return_value = {"answer": "Из-за\nкафе:  2 500 ₸."}
        result = queue.execute(queue.claim(), writer=queue.CodexWriter(provider))
        self.assertEqual((result.status, result.answer), ("succeeded", {"answer": "Из-за кафе: 2 500 ₸."}))
        call = provider.run_text.call_args.kwargs
        self.assertIn("INPUT JSON:", call["prompt"])
        self.assertIn("Почему этот месяц дороже?", call["prompt"])
        self.assertIn('"focus"', call["prompt"])
        self.assertEqual(call["schema"].name, "ask.schema.json")
        self.assertEqual(queue.unverified(result), [])  # 2 500 is the cafe of the month in the summary

    def test_bad_answers_and_failures(self):
        cases = [
            ({"summary": "Текст"}, "invalid_output"),
            ({"summary": "", "changes": None, "limits": None, "advice": []}, "invalid_output"),
            ({"summary": "Текст", "changes": None, "limits": None, "advice": ["a", "b", "c", "d"]}, "invalid_output"),
            ({"summary": "x" * 601, "changes": None, "limits": None, "advice": []}, "invalid_output"),
            ({"summary": "Текст", "changes": None, "limits": None, "advice": [], "extra": 1}, "invalid_output"),
            (ProviderError("timeout"), "timeout"),
            (ProviderError("cancelled"), "worker_lost"),
            (ProviderError("auth_required"), "auth_required"),
        ]
        for answer, code in cases:
            with self.subTest(code=code, answer=str(answer)[:40]):
                InsightRequest.objects.all().delete()
                self.review()
                provider = Mock()
                if isinstance(answer, Exception):
                    provider.run_text.side_effect = answer
                else:
                    provider.run_text.return_value = answer
                result = queue.execute(queue.claim(), writer=queue.CodexWriter(provider))
                self.assertEqual((result.status, result.error_code, result.answer), ("failed", code, None))

    def test_fake_scenarios(self):
        for scenario, code in (("invalid_output", "invalid_output"), ("provider_error", "provider_unavailable"),
                               ("timeout", "timeout")):
            with self.subTest(scenario=scenario):
                self.ask()
                self.assertEqual(queue.execute(queue.claim(), writer=queue.FakeWriter(scenario)).error_code, code)
        with self.assertRaises(ProviderError):
            queue.FakeWriter("other")

    def test_numbers_missing_from_the_summary_are_unverified(self):
        row = self.review()
        row.status, row.answer = "succeeded", {
            "summary": f"Ушло 7 200 KZT, на еду — 6 500, в {self.month.year} году; доля еды 90 %.",
            "changes": "Больше на 45 300,50 ₸ и на 12 месяцев.", "limits": None,
            "advice": ["Урежьте кафе до 1 999 ₸.", "Ещё раз: 45 300,50 ₸."]}
        self.assertEqual(queue.unverified(row), ["45 300,50", "1 999"])
        row.kind, row.question, row.answer = "ask", "Хватит ли 50 000 на отпуск?", {"answer": "50 000 — больше 7 200."}
        self.assertEqual(queue.unverified(row), [])

    def test_question_limits(self):
        with patch.object(queue, "use_ai") as checked:
            for _ in range(queue.MAX_UNFINISHED):
                self.ask()
            with self.assertRaises(queue.AskLimit):
                self.ask()
        self.assertEqual(checked.call_count, queue.MAX_UNFINISHED + 1)
        self.assertEqual(InsightRequest.objects.filter(kind="ask").count(), queue.MAX_UNFINISHED)

    def test_expiry_and_lost_worker(self):
        stale, waiting = self.ask(), self.review()
        InsightRequest.objects.filter(pk=stale.pk).update(created_at=db_now() - queue.QUEUE_TTL - timedelta(seconds=1))
        claimed = queue.claim()
        self.assertEqual(claimed.pk, waiting.pk)
        stale.refresh_from_db()
        self.assertEqual((stale.status, stale.error_code), ("failed", "expired"))
        InsightRequest.objects.filter(pk=claimed.pk).update(lease_expires_at=db_now() - timedelta(seconds=1))
        self.assertEqual(queue.recover_expired(), 1)
        lost = InsightRequest.objects.get(pk=claimed.pk)
        self.assertEqual((lost.status, lost.error_code), ("failed", "worker_lost"))
        self.assertFalse(queue.finish(claimed, answer={"answer": "поздно"}))  # a late answer of the lost owner

    @override_settings(RECEIPT_OCR_PROVIDER="fake")
    def test_get_writer_follows_the_provider(self):
        self.assertIsInstance(queue.get_writer(), queue.FakeWriter)
        with override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_CODEX_EXECUTABLE="nonexistent-checkist-codex"):
            self.assertIsInstance(queue.get_writer(), queue.CodexWriter)
        with override_settings(RECEIPT_OCR_PROVIDER="other"), self.assertRaises(ProviderError):
            queue.get_writer()


@tag("integration")
@local_single_mode()
class LocalApiTests(Spends, TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.month = Month.of(timezone.localdate()).previous()
        cls.seed(local_user(), cls.month)

    def post(self, url, body):
        return APIClient().post(url, body, format="json")

    def test_review_figures_without_a_review_then_the_queue_and_the_answer(self):
        client = APIClient()
        empty = client.get(REVIEW).json()  # the previous month by default
        self.assertEqual((empty["month"], empty["review"], empty["pending"]), (self.month.label(), None, None))
        self.assertEqual((empty["figures"]["spent"], empty["figures"]["currency"]), ("7200.00", "KZT"))
        queued = self.post(REVIEW, {"month": self.month.label()})
        self.assertEqual(queued.status_code, 202, queued.content)
        body = queued.json()
        self.assertEqual((body["status"], body["kind"], body["answer"], body["figures"]["spent"]),
                         ("queued", "review", None, "7200.00"))
        self.assertEqual(self.post(REVIEW, {}).json()["id"], body["id"])  # the same unfinished review
        self.assertEqual(client.get(REVIEW).json()["review"]["id"], body["id"])
        queue.execute(queue.claim(), writer=queue.FakeWriter())
        done = client.get(f"/api/insights/{body['id']}/").json()
        self.assertEqual((done["status"], done["unverified"], done["error"]), ("succeeded", [], None))
        self.assertTrue(done["answer"]["summary"])
        # «Обновить»: the finished review stays the review, the new one is pending until it is done.
        again = self.post(REVIEW, {"month": self.month.label()}).json()
        state = client.get(f"{REVIEW}?month={self.month.label()}").json()
        self.assertEqual((state["review"]["id"], state["pending"]["id"]), (body["id"], again["id"]))

    def test_refused_parameters(self):
        today = timezone.localdate()
        future = Month(today.year + (today.month == 12), today.month % 12 + 1)
        cases = [
            (self.post(REVIEW, {"month": future.label()}), "month"),
            (self.post(REVIEW, {"month": 202609}), "month"),
            (self.post(REVIEW, {"month": "2026-9"}), "month"),
            (self.post(REVIEW, {"other": 1}), "other"),
            (self.post(ASK, {"question": " "}), "question"),
            (self.post(ASK, {"question": "x" * 301}), "question"),
            (APIClient().get(f"{REVIEW}?month={future.label()}"), "month"),
        ]
        for response, field in cases:
            with self.subTest(field=field):
                self.assertEqual(response.status_code, 400, response.content)
                self.assertIn(field, response.json()["error"]["fields"])
        self.assertFalse(InsightRequest.objects.exists())

    def test_questions_history_and_limit(self):
        first = self.post(ASK, {"question": "  Сколько ушло на еду?  "})
        self.assertEqual(first.status_code, 202, first.content)
        self.assertEqual((first.json()["question"], first.json()["kind"]), ("Сколько ушло на еду?", "ask"))
        self.post(ASK, {"question": "А на такси?"})
        refused = self.post(ASK, {"question": "И ещё?"})
        self.assertEqual((refused.status_code, refused.json()["error"]["code"]), (429, "parse_limit"))
        history = APIClient().get(ASK).json()["results"]
        self.assertEqual([item["question"] for item in history], ["А на такси?", "Сколько ушло на еду?"])
        self.assertNotIn("figures", history[0])


@tag("integration")
@accounts_mode()
class AccountsApiTests(IsolationMixin, TestCase):
    """``first`` — главный, ``third`` — член семьи с ИИ; ``second`` — без семьи и не администратор."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three")
        cls.family = Household.objects.create(name="Синтетическая семья", ai_enabled=True, ai_daily_limit=2)
        Membership.objects.create(user=cls.first, household=cls.family, role="head")
        Membership.objects.create(user=cls.third, household=cls.family)
        Category.objects.create(name="Синтетическая еда")

    def post(self, account, url, body):
        return self.client_of(account, csrf=True).post(url, body, format="json")

    def test_refusals_of_the_family_ai_queue_nothing_but_the_figures_stay(self):
        refused = self.post(self.second, ASK, {"question": "Сколько?"})
        self.assertEqual((refused.status_code, refused.json()["error"]["code"]), (403, "ai_disabled"))
        Household.objects.filter(pk=self.family.pk).update(ai_enabled=False)
        refused = self.post(self.third, REVIEW, {})
        self.assertEqual((refused.status_code, refused.json()["error"]["code"]), (403, "ai_disabled"))
        figures = self.client_of(self.third).get(REVIEW)
        self.assertEqual((figures.status_code, figures.json()["review"], figures.json()["figures"]["spent"]),
                         (200, None, "0.00"))
        Household.objects.filter(pk=self.family.pk).update(ai_enabled=True)
        self.assertEqual(self.post(self.third, REVIEW, {}).status_code, 202)
        self.assertEqual(self.post(self.first, ASK, {"question": "Сколько?"}).status_code, 202)
        quota = self.post(self.first, ASK, {"question": "А ещё?"})
        self.assertEqual((quota.status_code, quota.json()["error"]["code"]), (429, "ai_quota"))
        self.assertIn("resets_at", quota.json())
        self.assertEqual(InsightRequest.objects.count(), 2)
        self.assertEqual(AiUsage.objects.get(household=self.family).count, 2)

    def test_reviews_and_questions_are_seen_only_by_their_owner(self):
        mine = self.post(self.first, ASK, {"question": "Мой вопрос"}).json()
        review = self.post(self.first, REVIEW, {}).json()
        for row in (mine, review):
            with self.subTest(kind=row["kind"]):
                own = self.client_of(self.first).get(f"/api/insights/{row['id']}/")
                self.assertEqual(own.status_code, 200)
                self.assert_same_as_missing(self.client_of(self.third).get(f"/api/insights/{row['id']}/"),
                                            self.client_of(self.third).get("/api/insights/999999999/"))
        self.assertEqual(self.client_of(self.third).get(ASK).json()["results"], [])
        self.assertIsNone(self.client_of(self.third).get(REVIEW).json()["review"])
        self.assertEqual(APIClient().get(ASK).status_code, 401)


@tag("integration")
class WorkerInsightTests(WorkerClassificationEnvironment):
    def setUp(self):
        super().setUp()
        Currency.objects.get_or_create(code="KZT", defaults={"name": "Tenge"})
        Category.objects.create(name="Кафе и рестораны")
        self.month = Month.of(timezone.localdate())

    def statement_question(self):
        day = date(2026, 10, 5)
        text = "\n".join(demo.kaspi_header(day, day) + [demo.kaspi_line(day, -3200, "Покупка", "ИП Кофейня Зерно")])
        statement, _created = drafts.import_text(local_user(), text, sha256="e" * 64, rule_scope=scope_of(local_user()))
        return StatementAsk.objects.get(statement=statement)

    def test_order_parse_then_statement_then_insight_then_job(self):
        job = self.new_job()
        insight = queue.request_ask(local_user(), "Сколько ушло на кафе?", self.month)
        question = self.statement_question()
        parse = manual_parse.request(local_user(), "такси 4500")
        self.assertEqual(self.worker(), [f"Manual parse {parse.pk}: succeeded"])
        self.assertEqual(self.worker(), [f"Statement question {question.pk}: succeeded"])
        self.assertEqual(self.worker(), [f"Insight {insight.pk}: succeeded"])
        self.assertEqual(self.job_state(job)["status"], "queued")
        self.assertEqual(self.worker(), [f"Job {job.pk}: succeeded"])

    def test_unexpected_error_fails_the_request_not_the_worker(self):
        row = queue.request_review(local_user(), self.month)
        with patch.object(queue, "build_input", side_effect=RuntimeError("boom")):
            self.assertEqual(self.worker(), [f"Insight {row.pk}: failed"])
        row.refresh_from_db()
        self.assertEqual((row.status, row.error_code), ("failed", "internal_error"))

    def test_fake_scenario_from_the_environment(self):
        row = queue.request_review(local_user(), self.month)
        with patch.dict("os.environ", {queue.FAKE_SCENARIO_ENV: "invalid_output"}):
            self.worker()
        self.assertEqual(InsightRequest.objects.get(pk=row.pk).error_code, "invalid_output")

    def test_writer_configuration_error_stops_startup(self):
        with patch.object(queue, "get_writer", side_effect=ProviderError("configuration_error")):
            with self.assertRaisesMessage(recognition_worker.CommandError, "Insights writer"):
                recognition_worker.build_insight_writer()
