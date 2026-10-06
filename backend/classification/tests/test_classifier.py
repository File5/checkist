import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from classification import demo
from classification.classifier import (
    FAKE_SCENARIO_ENV, FAKE_SCENARIOS, FakeClassifier, ProductClassifier, get_classifier,
)
from classification.dto import ClassificationRequest
from classification.validation import drop_reason
from recognition.providers.base import ProviderError, RunContext

MILK = {"id": 92, "name": "Молоко", "base_unit": "l", "category_id": 3}
CHEESE = {"id": 40, "name": "Сыр", "base_unit": "kg", "category_id": 3}


def product(product_id, name, rejected=()):
    return {
        "id": product_id, "name": name, "spellings": [name], "brand": None, "package": None,
        "merchants": ["Kategoriemarkt"], "units": ["pcs"], "rejected": list(rejected),
    }


def request(*products, generics=(MILK,)):
    return ClassificationRequest.build({
        "input_version": "1", "categories": [{"id": 3, "path": ["Продукты питания", "Молочные продукты"]}],
        "generic_products": list(generics), "examples": [], "products": list(products),
    })


def run(seconds=5, **fields):
    return RunContext(deadline=time.monotonic() + seconds, **fields)


DEMO = request(*[product(index, name) for index, (name, _facts) in enumerate(demo.PRODUCTS, 1)])


class FakeScenarioTests(SimpleTestCase):
    def classify(self, scenario, batch=DEMO):
        return FakeClassifier(scenario).classify(batch, run())

    def assertFails(self, scenario, code, batch=DEMO):
        with self.assertRaises(ProviderError) as caught:
            self.classify(scenario, batch)
        self.assertEqual(caught.exception.code, code)
        return caught.exception

    def test_scenario_list_is_the_contract_one(self):
        self.assertEqual(FAKE_SCENARIOS, (
            "mixed", "existing", "new_category", "unknown", "provider_error", "auth_failure", "invalid_output",
            "foreign_product", "missing_product", "service_target", "rejected_again", "pause",
        ))
        self.assertEqual((FakeClassifier.name, FakeClassifier.model), ("fake", ""))
        self.assertEqual(FakeClassifier().scenario, "mixed")
        with self.assertRaises(ProviderError) as caught:
            FakeClassifier("success2")
        self.assertEqual(caught.exception.code, "configuration_error")

    def test_fake_satisfies_the_protocol(self):
        classifier: ProductClassifier = FakeClassifier()
        self.assertTrue(callable(classifier.classify))

    def test_mixed_follows_the_demo_table(self):
        items = {item.product_id: item for item in self.classify("mixed").items}
        by_name = {name: items[index] for index, (name, _facts) in enumerate(demo.PRODUCTS, 1)}
        self.assertEqual(len(items), 12)
        milk = by_name["Demo Frischmilch 1,5%"]
        self.assertEqual((milk.decision, milk.generic_id, milk.generic_name), ("existing", 92, None))
        for name in ("Demo Kefir mild 500g", "Demo Kefir 1,5% 1L"):
            kefir = by_name[name]
            self.assertEqual(
                (kefir.decision, kefir.generic_name, kefir.category_path, kefir.base_unit),
                ("new", "Кефир", ("Продукты питания", "Молочные продукты"), "l"),
            )
        sausage = by_name["Demo Mettwurst fein"]
        self.assertEqual(sausage.category_path, ("Продукты питания", "Мясные продукты"))
        self.assertEqual(by_name["Demo Salami Sticks"].generic_name, "Колбаса")
        self.assertEqual(by_name["Demo Apfelsaft klar 1L"].category_path, ("Напитки",))
        self.assertEqual(by_name["Demo Spülmittel Zitr."].base_unit, "pcs")
        # Outside the table, and the explicit "do not know".
        for name in ("Demo Art. 4711", "Demo H-Milch 3,5% 1L", "Demo Pfand Leergut"):
            self.assertEqual(by_name[name].decision, "unknown")
        self.assertEqual(sum(item.decision == "unknown" for item in items.values()), 3)
        self.assertEqual({item.generic_name for item in items.values() if item.decision == "new"}, {
            "Кефир", "Сыр", "Колбаса", "Хлеб", "Сок", "Средство для мытья посуды",
        })
        self.assertTrue(all(drop_reason(item) in (None, "unknown") for item in items.values()))

    def test_mixed_proposes_milk_as_new_when_the_catalog_lacks_it(self):
        batch = request(product(1, "Demo Frischmilch 1,5%"), generics=())
        item = self.classify("mixed", batch).items[0]
        self.assertEqual((item.decision, item.generic_name, item.base_unit), ("new", "Молоко", "l"))

    def test_existing_takes_the_lowest_generic_id(self):
        batch = request(product(1, "A"), product(2, "B"), generics=(MILK, CHEESE))
        self.assertEqual(
            [(item.decision, item.generic_id) for item in self.classify("existing", batch).items],
            [("existing", 40), ("existing", 40)],
        )
        empty = request(product(1, "A"), generics=())
        self.assertEqual([item.decision for item in self.classify("existing", empty).items], ["unknown"])

    def test_new_category(self):
        for item in self.classify("new_category").items:
            self.assertEqual(
                (item.decision, item.generic_name, item.category_path, item.base_unit),
                ("new", "Тестовый продукт", ("Тестовая категория", "Тестовая подкатегория"), "pcs"),
            )
            self.assertIsNone(drop_reason(item))

    def test_unknown(self):
        self.assertEqual({item.decision for item in self.classify("unknown").items}, {"unknown"})

    def test_provider_error_is_retryable_and_auth_failure_is_not(self):
        self.assertTrue(self.assertFails("provider_error", "provider_unavailable").retryable)
        self.assertFalse(self.assertFails("auth_failure", "auth_required").retryable)

    def test_invalid_answers_fail_as_a_whole(self):
        for scenario in ("invalid_output", "foreign_product", "missing_product"):
            with self.subTest(scenario=scenario):
                error = self.assertFails(scenario, "invalid_output")
                self.assertFalse(error.retryable)
                # The private text of the attempt; never part of the public message.
                self.assertIn('"items"', error.private_output)
                self.assertNotIn("items", str(error))
        self.assertIn('"unexpected":true', self.assertFails("invalid_output", "invalid_output").private_output)

    def test_service_target_drops_every_item(self):
        items = self.classify("service_target").items
        self.assertEqual(len(items), 12)
        self.assertEqual({drop_reason(item) for item in items}, {"service_target"})

    def test_rejected_again_repeats_the_first_rejected_name(self):
        batch = request(
            product(1, "Demo Butterkäse Sch.", rejected=("Сыр", "Творог")),
            product(2, "Demo Toast Weizen", rejected=("Молоко",)),
            product(3, "Demo Kefir mild 500g"),
        )
        first, second, third = self.classify("rejected_again", batch).items
        self.assertEqual((first.decision, first.generic_name), ("new", "Сыр"))
        # A rejected name that is in the catalog comes back as the existing record.
        self.assertEqual((second.decision, second.generic_id), ("existing", 92))
        # Nothing rejected: the mixed answer.
        self.assertEqual((third.decision, third.generic_name), ("new", "Кефир"))

    def test_pause_waits_for_the_gate(self):
        gate, entered = threading.Event(), threading.Event()
        classifier = FakeClassifier("pause", gate=gate, entered=entered)
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(classifier.classify, DEMO, run())
            self.assertTrue(entered.wait(5))
            self.assertFalse(future.done())
            gate.set()
            self.assertEqual(len(future.result(timeout=5).items), 12)

    def test_pause_ends_with_cancellation_or_deadline(self):
        cancelled = threading.Event()
        classifier = FakeClassifier("pause", entered=threading.Event())
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(classifier.classify, DEMO, run(is_cancelled=cancelled.is_set))
            self.assertTrue(classifier.entered.wait(5))
            cancelled.set()
            with self.assertRaises(ProviderError) as caught:
                future.result(timeout=5)
        self.assertEqual(caught.exception.code, "cancelled")
        with self.assertRaises(ProviderError) as caught:
            FakeClassifier("pause").classify(DEMO, run(0.05))
        self.assertEqual(caught.exception.code, "timeout")

    def test_a_cancelled_run_gets_no_answer(self):
        with self.assertRaises(ProviderError) as caught:
            FakeClassifier("mixed").classify(DEMO, run(is_cancelled=lambda: True))
        self.assertEqual(caught.exception.code, "cancelled")

    def test_stage_is_reported(self):
        stages = []
        FakeClassifier("unknown").classify(DEMO, run(on_stage=stages.append))
        self.assertEqual(stages, ["classify"])


class FactoryTests(SimpleTestCase):
    @override_settings(RECEIPT_OCR_PROVIDER="fake")
    def test_fake_scenario_comes_from_the_argument_then_the_environment(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop(FAKE_SCENARIO_ENV, None)
            self.assertEqual(get_classifier().scenario, "mixed")
            self.assertEqual(get_classifier(scenario="unknown").scenario, "unknown")
            os.environ[FAKE_SCENARIO_ENV] = "existing"
            self.assertEqual(get_classifier().scenario, "existing")
            self.assertEqual(get_classifier(scenario="unknown").scenario, "unknown")
            os.environ[FAKE_SCENARIO_ENV] = "no_such_scenario"
            with self.assertRaises(ProviderError) as caught:
                get_classifier()
            self.assertEqual(caught.exception.code, "configuration_error")

    @override_settings(RECEIPT_OCR_PROVIDER="codex_cli")
    def test_another_provider_never_falls_back_to_the_fake(self):
        for scenario in (None, "mixed"):
            with self.subTest(scenario=scenario), self.assertRaises(ProviderError) as caught:
                get_classifier(scenario=scenario)
            self.assertEqual(caught.exception.code, "configuration_error")
