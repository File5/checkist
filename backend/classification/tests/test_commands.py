import io
import json
import time
import uuid
from datetime import timedelta
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings, tag
from django.utils import timezone

from catalog.models import Category, GenericProduct, Product
from classification import context, demo, runner, services
from classification.classifier import FAKE_SCENARIOS, FakeClassifier
from classification.models import (
    ClassificationAttempt, ClassificationRun, CreatedCategory, CreatedGenericProduct, ProductClassification,
)
from classification.tests.factories import (
    CATALOG_MODELS, CHEESE, DEPOSIT, EXAMPLE, JUICE, KEFIR_A, MILK, SAUSAGE_A, UNKNOWN, apply, generic, generic_of,
    new, product, record, snapshot, suggest,
)
from merges.demo import DemoError
from receipts.models import ProductAlias, Receipt, ReceiptLine
from receipts.ownership import LOCAL_USERNAME
from recognition.providers.base import ProviderError, RunContext
from stores.models import Merchant, Store


def command(*arguments):
    output = io.StringIO()
    call_command(*arguments, stdout=output)
    return json.loads(output.getvalue())


@tag("integration")
class DemoTests(TestCase):
    def test_seed_creates_the_fictional_catalog_once(self):
        self.assertEqual(command("seed_product_classification_demo"), {
            "created": True, "merchants": 1, "products": 12, "receipts": 3, "lines": 14,
        })
        before = snapshot()
        self.assertEqual(command("seed_product_classification_demo"), {"created": False})
        self.assertEqual(demo.seed_demo(), {"created": False})
        self.assertEqual(snapshot(), before)
        merchant = Merchant.objects.get()
        self.assertEqual((merchant.brand_name, "вымышленный" in merchant.legal_name), ("Kategoriemarkt", True))
        self.assertEqual((Store.objects.count(), Receipt.objects.count(), ReceiptLine.objects.count()), (1, 3, 14))
        self.assertEqual((Product.objects.count(), ProductAlias.objects.count()), (12, 13))
        self.assertEqual(
            list(Category.objects.order_by("pk").values_list("name", "parent__name")),
            [("Не разобрано", None), ("Продукты питания", None), ("Молочные продукты", "Продукты питания")],
        )
        self.assertEqual(
            list(GenericProduct.objects.order_by("pk").values_list("name", "base_unit", "category__name")),
            [("Не разобрано", "pcs", "Не разобрано"), ("Молоко", "l", "Молочные продукты")],
        )
        self.assertEqual(generic_of(EXAMPLE), "Молоко")
        self.assertEqual(Product.objects.filter(generic__name="Не разобрано").count(), 11)
        self.assertEqual(
            list(ReceiptLine.objects.filter(product__name=DEPOSIT).values_list("kind", "parent__raw_name")),
            [("deposit", "Demo Apfelsaft klar 1L")],
        )
        self.assertEqual(services.candidates().count(), demo.EXPECTED["candidates"])
        # The answer table of the fake covers exactly the candidates.
        self.assertEqual(set(demo.MIXED), set(services.candidates().values_list("name", flat=True)))
        self.assertFalse(ProductClassification.objects.exists() or ClassificationRun.objects.exists())

    def test_seed_refuses_a_database_that_is_not_test_or_qa(self):
        for name in ("checkist_dev", "checkist", "postgres", "checkist_qa2", "production"):
            with self.subTest(name=name), patch.dict(settings.DATABASES["default"], {"NAME": name}):
                with self.assertRaises(DemoError):
                    demo.seed_demo()
                with self.assertRaises(CommandError):
                    call_command("seed_product_classification_demo", stdout=io.StringIO())
        self.assertFalse(Merchant.objects.exists() or Product.objects.exists())

    def test_every_demo_receipt_belongs_to_local(self):
        User = get_user_model()
        # The record may be left by a migration: the demo has to create it itself, exactly once.
        User.objects.filter(username=LOCAL_USERNAME).delete()
        with patch.dict(settings.DATABASES["default"], {"NAME": "checkist_dev"}), self.assertRaises(DemoError):
            demo.seed_demo()
        # A refusal creates no owner either.
        self.assertFalse(User.objects.filter(username=LOCAL_USERNAME).exists())

        self.assertTrue(command("seed_product_classification_demo")["created"])
        local = User.objects.get(username=LOCAL_USERNAME)
        self.assertEqual((local.is_active, local.is_staff, local.is_superuser), (True, False, False))
        self.assertFalse(local.has_usable_password())
        self.assertEqual(Receipt.objects.count(), 3)
        self.assertEqual(set(Receipt.objects.values_list("owner_id", flat=True)), {local.pk})
        people = list(User.objects.order_by("pk").values())
        self.assertEqual(command("seed_product_classification_demo"), {"created": False})
        self.assertEqual(list(User.objects.order_by("pk").values()), people)

    def test_seed_reuses_existing_catalog_records(self):
        Category.objects.create(parent=None, name="Продукты питания")
        GenericProduct.objects.create(
            name="МОЛОКО", category=Category.objects.get(name="Продукты питания"), base_unit="kg",
        )
        # An existing «Молоко» is reused as it is: the demo never rewrites catalog records.
        self.assertTrue(demo.seed_demo()["created"])
        self.assertEqual(GenericProduct.objects.filter(name__iexact="молоко").count(), 1)
        self.assertEqual(generic("МОЛОКО").base_unit, "kg")


@tag("integration")
@override_settings(RECEIPT_OCR_PROVIDER="fake")
class SuggestCommandTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()
        cls.original = snapshot(*CATALOG_MODELS)

    def suggest(self, *options):
        return command("product_classifications", "suggest", *options)

    def test_mixed_scenario_gives_the_demo_numbers_and_cancel_pending_returns_the_catalog(self):
        result = self.suggest("--fake-scenario", "mixed")
        self.assertEqual(
            {key: result[key] for key in ("dry_run", "status", "requested", "processed", "applied", "unknown",
                                          "skipped", "remaining", "error")},
            {"dry_run": False, "status": "succeeded", "requested": 10, "processed": 10, "applied": 9, "unknown": 1,
             "skipped": {}, "remaining": 0, "error": None},
        )
        self.assertEqual(result["record_ids"], list(ProductClassification.objects.order_by("pk").values_list("pk", flat=True)))
        pending = ProductClassification.objects.filter(status="pending")
        self.assertEqual(pending.count(), demo.EXPECTED["pending"])
        self.assertEqual(pending.values("suggested_generic_ref").distinct().count(), demo.EXPECTED["groups"])
        self.assertEqual(CreatedGenericProduct.objects.count(), demo.EXPECTED["created_generics"])
        self.assertEqual(CreatedCategory.objects.count(), demo.EXPECTED["created_categories"])
        self.assertEqual((GenericProduct.objects.count(), Category.objects.count()), (8, 7))
        run = ClassificationRun.objects.get(pk=result["run_id"])
        self.assertEqual((run.trigger, run.status, run.provider), ("command", "succeeded", "fake"))
        # The repeat asks only about the product the model did not know.
        again = self.suggest("--fake-scenario", "mixed")
        self.assertEqual((again["requested"], again["applied"], again["unknown"], again["record_ids"]), (1, 0, 1, []))
        cancelled = command("product_classifications", "cancel-pending")
        self.assertEqual((len(cancelled["cancelled"]), cancelled["removed_generics"], cancelled["removed_categories"]), (9, 6, 4))
        self.assertEqual(snapshot(*CATALOG_MODELS), self.original)
        self.assertEqual(Product.objects.filter(generic__name="Не разобрано").count(), 11)
        self.assertEqual(services.candidates().count(), 10)
        self.assertEqual(command("product_classifications", "cancel-pending")["cancelled"], [])

    def test_default_scenario_is_mixed(self):
        self.assertEqual(self.suggest()["applied"], 9)

    def test_dry_run_prints_suggestions_and_writes_nothing(self):
        before = snapshot()
        result = self.suggest("--dry-run", "--fake-scenario", "mixed")
        self.assertEqual(snapshot(), before)
        self.assertFalse(ClassificationRun.objects.exists() or ClassificationAttempt.objects.exists())
        self.assertEqual((result["dry_run"], result["run_id"], result["requested"], result["error"]), (True, None, 10, None))
        by_name = {entry["name"]: entry for entry in result["suggestions"]}
        self.assertEqual(len(by_name), 10)
        self.assertEqual((by_name[MILK]["decision"], by_name[MILK]["generic_id"]), ("existing", generic("Молоко").pk))
        self.assertEqual(
            (by_name[JUICE]["generic_name"], by_name[JUICE]["category_path"], by_name[JUICE]["base_unit"]),
            ("Сок", ["Напитки"], "l"),
        )
        self.assertEqual((by_name[UNKNOWN]["decision"], by_name[UNKNOWN]["skipped"]), ("unknown", "unknown"))
        self.assertIsNone(by_name[JUICE]["skipped"])
        dropped = self.suggest("--dry-run", "--fake-scenario", "service_target")["suggestions"]
        self.assertEqual({entry["skipped"] for entry in dropped}, {"service_target"})
        self.assertEqual(snapshot(), before)

    def test_products_and_limit(self):
        ids = [str(product(name).pk) for name in (JUICE, EXAMPLE, MILK)]
        result = self.suggest("--product", *ids)
        self.assertEqual((result["requested"], result["applied"]), (2, 2))
        self.assertEqual(ClassificationRun.objects.get().scope, "products")
        result = self.suggest("--limit", "3")
        self.assertEqual((result["requested"], result["applied"], result["remaining"]), (3, 3, 5))
        self.assertEqual(ClassificationRun.objects.latest("pk").scope, "all")
        result = self.suggest("--dry-run", "--limit", "2")
        self.assertEqual((result["requested"], len(result["suggestions"])), (2, 2))
        # Nothing left for these products.
        result = self.suggest("--product", *ids)
        self.assertEqual(result, {
            "dry_run": False, "run_id": None, "requested": 0, "applied": 0, "unknown": 0, "skipped": {},
        })

    @override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=3)
    def test_several_batches_give_the_same_result(self):
        result = self.suggest()
        self.assertEqual((result["requested"], result["processed"], result["applied"], result["unknown"]), (10, 10, 9, 1))
        attempts = list(ClassificationAttempt.objects.order_by("batch").values_list("batch", "ordinal", "status"))
        self.assertEqual(attempts, [(batch, 1, "succeeded") for batch in (1, 2, 3, 4)])
        self.assertEqual(
            [len(ids) for ids in ClassificationAttempt.objects.order_by("batch").values_list("product_ids", flat=True)],
            [3, 3, 3, 1],
        )
        # Products of one kind from different batches share the generic product created by the first.
        self.assertEqual(CreatedGenericProduct.objects.count(), 6)
        self.assertEqual(generic("Колбаса").products.count(), 2)

    def test_scenarios_without_a_failure(self):
        cases = {
            "unknown": (0, 10, {}), "service_target": (0, 0, {"service_target": 10}),
            "existing": (10, 0, {}), "new_category": (10, 0, {}),
        }
        for scenario, (applied, unknown, skipped) in cases.items():
            with self.subTest(scenario=scenario):
                result = self.suggest("--fake-scenario", scenario)
                self.assertEqual((result["status"], result["applied"], result["unknown"], result["skipped"]), (
                    "succeeded", applied, unknown, skipped))
                if scenario == "new_category":
                    self.assertEqual(generic("Тестовый продукт").products.count(), 10)
                    self.assertEqual(generic("Тестовый продукт").category.parent.name, "Тестовая категория")
                    self.assertEqual((CreatedGenericProduct.objects.count(), CreatedCategory.objects.count()), (1, 2))
                if scenario == "existing":
                    self.assertEqual(generic("Молоко").products.count(), 11)
                command("product_classifications", "cancel-pending")
                self.assertEqual(snapshot(*CATALOG_MODELS), self.original)

    def failing(self, scenario):
        before = snapshot(*CATALOG_MODELS, ProductClassification)
        output = io.StringIO()
        with patch.object(runner, "_retry_delay", lambda error, deadline: 0 if error.retryable else None), \
                self.assertRaises(CommandError) as caught:
            call_command("product_classifications", "suggest", "--fake-scenario", scenario, stdout=output)
        self.assertEqual(snapshot(*CATALOG_MODELS, ProductClassification), before)
        return json.loads(output.getvalue()), str(caught.exception)

    def test_provider_error_is_retried_and_fails_the_run(self):
        result, message = self.failing("provider_error")
        self.assertEqual(message, "The run failed: provider_unavailable.")
        self.assertEqual((result["status"], result["error"], result["processed"], result["applied"]), (
            "failed", "provider_unavailable", 0, 0))
        self.assertEqual(
            list(ClassificationAttempt.objects.order_by("ordinal").values_list("batch", "ordinal", "status", "error_code")),
            [(1, 1, "failed", "provider_unavailable"), (1, 2, "failed", "provider_unavailable")],
        )
        run = ClassificationRun.objects.get()
        self.assertEqual((run.status, run.error_code, run.run_token), ("failed", "provider_unavailable", None))
        self.assertIsNotNone(run.finished_at)

    def test_auth_failure_is_not_retried(self):
        result, message = self.failing("auth_failure")
        self.assertEqual((result["error"], message), ("auth_required", "The run failed: auth_required."))
        self.assertEqual(ClassificationAttempt.objects.count(), 1)

    def test_invalid_answers_fail_the_run_without_a_retry(self):
        for scenario in ("invalid_output", "foreign_product", "missing_product"):
            with self.subTest(scenario=scenario):
                ClassificationRun.objects.all().delete()
                result, _message = self.failing(scenario)
                self.assertEqual((result["status"], result["error"]), ("failed", "invalid_output"))
                attempt = ClassificationAttempt.objects.get()
                self.assertEqual((attempt.status, attempt.error_code, attempt.raw_payload), (
                    "failed", "invalid_output", None))
                # The private text of the answer is kept for diagnostics, bounded.
                self.assertIn('"items"', attempt.invalid_output_text)
                self.assertLessEqual(len(attempt.invalid_output_text), 65536)

    def test_batches_applied_before_a_failure_stay(self):
        classifier = FakeClassifier("mixed")
        real, calls = classifier.classify, []

        def flaky(request, run):
            calls.append(request.product_ids)
            if len(calls) == 2:
                raise ProviderError("auth_required")
            return real(request, run)

        classifier.classify = flaky
        with override_settings(PRODUCT_CLASSIFICATION_BATCH_SIZE=4):
            run = services.start_run(source=services.default_source(classifier))
            run, record_ids = runner.execute(run, classifier=classifier)
        self.assertEqual((run.status, run.error_code, run.cursor, run.applied_count), ("failed", "auth_required", 4, 4))
        self.assertEqual((len(record_ids), ProductClassification.objects.filter(status="pending").count()), (4, 4))
        self.assertEqual(generic_of(MILK), "Молоко")
        self.assertEqual(generic_of(SAUSAGE_A), "Не разобрано")

    def test_options_belong_to_suggest(self):
        for action in ("cancel-pending", "reconcile"):
            for option in (("--dry-run",), ("--product", "1"), ("--limit", "1"), ("--fake-scenario", "mixed")):
                with self.subTest(action=action, option=option), self.assertRaises(CommandError):
                    call_command("product_classifications", action, *option, stdout=io.StringIO())
        for option in (("--limit", "0"), ("--limit", "-1")):
            with self.subTest(option=option), self.assertRaises(CommandError):
                call_command("product_classifications", "suggest", *option, stdout=io.StringIO())
        with self.assertRaises(CommandError):
            call_command("product_classifications", "suggest", "--fake-scenario", "no_such", stdout=io.StringIO())
        self.assertFalse(ClassificationRun.objects.exists())

    def test_fake_scenario_needs_the_fake_provider(self):
        # The executable does not exist: the real classifier is selected, but no process can start here.
        with override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_CODEX_EXECUTABLE="nonexistent-checkist-codex"), \
                patch.object(FakeClassifier, "classify", side_effect=AssertionError("a failure never selects the fake")), \
                patch("recognition.process_supervisor.ProcessSupervisor.run",
                      side_effect=AssertionError("no process in tests")):
            with self.assertRaises(CommandError) as caught:
                call_command("product_classifications", "suggest", "--fake-scenario", "mixed", stdout=io.StringIO())
            self.assertIn("requires RECEIPT_OCR_PROVIDER=fake", str(caught.exception))
            self.assertFalse(ClassificationRun.objects.exists())
            with self.assertRaises(CommandError) as caught:
                call_command("product_classifications", "suggest", "--dry-run", stdout=io.StringIO())
            self.assertIn("The run failed: configuration_error", str(caught.exception))
            self.assertFalse(ClassificationRun.objects.exists())
            with self.assertRaises(CommandError) as caught:
                call_command("product_classifications", "suggest", stdout=io.StringIO())
            self.assertIn("The run failed: configuration_error", str(caught.exception))
        run = ClassificationRun.objects.get()
        self.assertEqual((run.status, run.error_code, run.provider), ("failed", "configuration_error", "codex_cli"))
        self.assertEqual(list(run.attempts.values_list("status", "error_code")), [("failed", "configuration_error")])
        self.assertEqual(snapshot(*CATALOG_MODELS), self.original)

    def test_broken_provider_settings_are_a_command_error(self):
        with override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_MODEL=""), \
                self.assertRaises(CommandError) as caught:
            call_command("product_classifications", "suggest", stdout=io.StringIO())
        self.assertIn("Classifier settings for RECEIPT_OCR_PROVIDER=codex_cli are invalid", str(caught.exception))
        self.assertFalse(ClassificationRun.objects.exists())

    def test_running_worker_batch_means_busy(self):
        now = timezone.now()
        ClassificationRun.objects.create(
            trigger="manual", scope="all", status="running", run_token=uuid.uuid4(), started_at=now,
            heartbeat_at=now, lease_expires_at=now + timedelta(seconds=60),
        )
        for action in (("suggest",), ("cancel-pending",)):
            with self.subTest(action=action), self.assertRaises(CommandError) as caught:
                call_command("product_classifications", *action, stdout=io.StringIO())
            self.assertIn("Retry later", str(caught.exception))
        self.assertFalse(ProductClassification.objects.exists())
        # A dry run only reads: it does not compete with the worker.
        self.assertEqual(self.suggest("--dry-run")["requested"], 10)

    def test_every_contract_scenario_is_accepted_by_the_command(self):
        failing = {"provider_error", "auth_failure", "invalid_output", "foreign_product", "missing_product"}
        self.assertEqual(len(FAKE_SCENARIOS), 12)
        with patch.object(runner, "_retry_delay", lambda error, deadline: None):
            for scenario in FAKE_SCENARIOS:
                if scenario == "pause":  # waits for a gate or the deadline; covered without the command
                    continue
                with self.subTest(scenario=scenario):
                    output = io.StringIO()
                    try:
                        call_command(
                            "product_classifications", "suggest", "--dry-run", "--fake-scenario", scenario,
                            stdout=output,
                        )
                        failed = False
                    except CommandError:
                        failed = True
                    self.assertEqual(failed, scenario in failing)
                    self.assertEqual(json.loads(output.getvalue())["error"] is not None, scenario in failing)
        self.assertEqual(snapshot(*CATALOG_MODELS), self.original)


@tag("integration")
class RunBatchTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def ids(self, *names):
        return [product(name).pk for name in names]

    def test_batch_without_a_run_applies_and_records_no_attempt(self):
        result = runner.run_batch(self.ids(MILK, JUICE, UNKNOWN), classifier=FakeClassifier())
        self.assertEqual(result.request.product_ids, tuple(self.ids(MILK, JUICE, UNKNOWN)))
        self.assertEqual((result.error_code, result.invalid_output_text, result.consumed), ("", "", 3))
        self.assertEqual((result.apply.applied, result.apply.unknown, result.apply.skipped), (2, 1, {}))
        self.assertEqual(result.raw_payload, result.response.to_dict())
        self.assertEqual(len(result.raw_payload["items"]), 3)
        self.assertEqual(set(ProductClassification.objects.values_list("run_id", "provider", "model")), {(None, "fake", "")})
        self.assertFalse(ClassificationAttempt.objects.exists())

    def test_dry_run_writes_nothing(self):
        before = snapshot()
        run = ClassificationRun.objects.create(trigger="manual", scope="all")
        result = runner.run_batch(self.ids(MILK, JUICE), classifier=FakeClassifier(), run=run, dry_run=True)
        self.assertEqual((len(result.response.items), result.apply, result.consumed), (2, None, 2))
        run.delete()
        self.assertEqual(snapshot(), before)

    def test_products_are_checked_again_before_the_model_is_asked(self):
        apply(new(MILK, "Напиток"))
        run = services.start_run(product_ids=self.ids(JUICE, CHEESE))
        ClassificationRun.objects.filter(pk=run.pk).update(product_ids=self.ids(MILK, EXAMPLE, CHEESE, JUICE) + [10**9])
        run.refresh_from_db()
        classifier = FakeClassifier()
        with patch.object(classifier, "classify", wraps=classifier.classify) as classify:
            result = runner.run_batch(run.product_ids, classifier=classifier, run=run)
        # Only the two that are still candidates are sent.
        self.assertEqual(classify.call_args.args[0].product_ids, tuple(self.ids(CHEESE, JUICE)))
        self.assertEqual((result.consumed, result.apply.applied, result.apply.skipped), (5, 2, {"not_eligible": 3}))
        run.refresh_from_db()
        self.assertEqual((run.applied_count, run.skipped_count, run.stats), (2, 3, {"not_eligible": 3}))
        self.assertEqual(ClassificationAttempt.objects.get().product_ids, self.ids(CHEESE, JUICE))

    def test_batch_without_candidates_does_not_call_the_model(self):
        run = services.start_run(product_ids=self.ids(JUICE))
        classifier = FakeClassifier()
        with patch.object(classifier, "classify") as classify:
            result = runner.run_batch(self.ids(EXAMPLE, DEPOSIT), classifier=classifier, run=run)
            empty = runner.run_batch([], classifier=classifier, run=run)
        classify.assert_not_called()
        self.assertEqual((result.request, result.response, result.error_code, result.consumed), (None, None, "", 2))
        self.assertEqual(result.apply, services.ApplyResult([], 0, 0, {"not_eligible": 2}))
        self.assertEqual((empty.consumed, empty.apply.skipped), (0, {}))
        run.refresh_from_db()
        self.assertEqual((run.skipped_count, run.stats), (2, {"not_eligible": 2}))
        self.assertFalse(ClassificationAttempt.objects.exists())

    def test_import_run_never_asks_about_a_product_that_had_a_record(self):
        run, _created = services.request_run(trigger="import", product_ids=self.ids(MILK, JUICE))
        apply(new(MILK, "Напиток"))
        services.reject(record(MILK).pk, version=1)
        result = runner.run_batch(run.product_ids, classifier=FakeClassifier(), run=run)
        self.assertEqual((result.request.product_ids, result.apply.skipped), (tuple(self.ids(JUICE)), {"not_eligible": 1}))
        self.assertEqual(generic_of(MILK), "Не разобрано")

    def test_input_is_halved_until_it_fits(self):
        ids = self.ids(MILK, KEFIR_A, CHEESE, SAUSAGE_A, JUICE)
        sizes = [len(context.build_request(ids[:count]).to_json().encode()) for count in (1, 2, 5)]
        self.assertLess(sizes[0], sizes[1])
        self.assertLess(sizes[1], sizes[2])
        run = services.start_run(product_ids=ids)
        with patch.object(context, "MAX_INPUT_BYTES", sizes[1]):
            result = runner.run_batch(ids, classifier=FakeClassifier(), run=run)
        # Five do not fit, half of five is two; the executor moves the cursor by what was dealt with.
        self.assertEqual((result.request.product_ids, result.consumed, result.apply.applied), (tuple(ids[:2]), 2, 2))
        run, _records = runner.execute(services.advance_run(run, result.consumed), classifier=FakeClassifier())
        self.assertEqual((run.status, run.cursor, run.applied_count), ("succeeded", 5, 5))
        self.assertEqual(
            [len(ids) for ids in ClassificationAttempt.objects.order_by("batch").values_list("product_ids", flat=True)],
            [2, 3],
        )

    def test_input_too_large_for_one_product_fails_the_run(self):
        run = services.start_run()
        with patch.object(context, "MAX_INPUT_BYTES", 10):
            result = runner.run_batch(run.product_ids, classifier=FakeClassifier(), run=run)
            self.assertEqual((result.request, result.error_code, result.consumed, result.apply), (
                None, "input_too_large", 0, None))
            run, record_ids = runner.execute(run, classifier=FakeClassifier())
        self.assertEqual((run.status, run.error_code, run.cursor, record_ids), ("failed", "input_too_large", 0, []))
        self.assertFalse(ClassificationAttempt.objects.exists() or ProductClassification.objects.exists())

    def test_busy_catalog_is_retried_three_times_then_the_batch_is_left(self):
        run = services.start_run(product_ids=self.ids(MILK, JUICE))
        before = snapshot(*CATALOG_MODELS, ProductClassification)
        with patch.object(services, "apply", side_effect=services.ClassificationBusy()) as applied, \
                patch.object(runner.time, "sleep") as sleep:
            result = runner.run_batch(run.product_ids, classifier=FakeClassifier(), run=run)
        self.assertEqual(applied.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [0.2, 0.4])
        # Not a failure of the run: the products simply stay without a suggestion.
        self.assertEqual((result.error_code, result.consumed, result.apply.skipped), ("", 2, {"catalog_busy": 2}))
        self.assertEqual(snapshot(*CATALOG_MODELS, ProductClassification), before)
        run.refresh_from_db()
        self.assertEqual((run.skipped_count, run.stats, run.status), (2, {"catalog_busy": 2}, "running"))
        self.assertEqual(ClassificationAttempt.objects.get().status, "succeeded")

    def test_busy_catalog_once_is_applied_on_the_retry(self):
        real, calls = services.apply, []

        def busy_once(*arguments, **options):
            calls.append(1)
            if len(calls) == 1:
                raise services.ClassificationBusy()
            return real(*arguments, **options)

        with patch.object(services, "apply", busy_once), patch.object(runner.time, "sleep"):
            result = runner.run_batch(self.ids(MILK), classifier=FakeClassifier())
        self.assertEqual((len(calls), result.apply.applied), (2, 1))

    def test_cancelled_context_stops_before_anything_is_written(self):
        run = services.start_run(product_ids=self.ids(MILK))
        stopped = RunContext(deadline=time.monotonic() + 5, is_cancelled=lambda: True)
        result = runner.run_batch(run.product_ids, classifier=FakeClassifier(), run=run, context=stopped)
        self.assertEqual((result.error_code, result.apply, result.consumed), ("cancelled", None, 0))
        self.assertEqual(generic_of(MILK), "Не разобрано")
        self.assertEqual(
            list(ClassificationAttempt.objects.values_list("status", "error_code")), [("failed", "cancelled")],
        )

    def test_unexpected_error_fails_the_run_and_is_raised(self):
        for error, code in ((RuntimeError("boom"), "internal_error"), (KeyboardInterrupt(), "worker_lost")):
            with self.subTest(code=code):
                ClassificationRun.objects.all().delete()
                classifier = FakeClassifier()
                run = services.start_run(product_ids=self.ids(MILK))
                with patch.object(classifier, "classify", side_effect=error), self.assertRaises(type(error)):
                    runner.execute(run, classifier=classifier)
                run.refresh_from_db()
                self.assertEqual((run.status, run.error_code), ("failed", code))
                self.assertEqual(ClassificationAttempt.objects.get().error_code, code)
        self.assertEqual(generic_of(MILK), "Не разобрано")

    def test_retry_delay_follows_recognition(self):
        retryable, final = ProviderError("provider_unavailable"), ProviderError("auth_required")
        self.assertIsNone(runner._retry_delay(final, None))
        self.assertTrue(2 <= runner._retry_delay(retryable, None) <= 3)
        self.assertEqual(runner._retry_delay(ProviderError("rate_limited", retry_after=10), None), 10)
        self.assertEqual(runner._retry_delay(ProviderError("rate_limited", retry_after=0.5), None), 2)
        self.assertIsNone(runner._retry_delay(ProviderError("rate_limited", retry_after=31), None))
        # No time left before the deadline of the outer context: do not retry.
        self.assertIsNone(runner._retry_delay(retryable, time.monotonic() + 1))
        self.assertIsNotNone(runner._retry_delay(retryable, time.monotonic() + 60))
