"""The classifier interface, the explicit fake and the factory.

FakeClassifier(scenario="mixed", gate=threading.Event(), entered=threading.Event()).
``gate`` releases ``pause``; ``entered`` signals that the pause was reached.
Without a gate the pause lasts until the deadline or the cancellation.
The fake answer goes through the same ``validate_response`` as a real one.
"""
import os
import time
from typing import Protocol

from django.conf import settings

from classification import demo
from classification.dto import SCHEMA_VERSION, ClassificationRequest, ClassificationResponse, serialize
from classification.taxonomy import SERVICE_NAME, name_key
from classification.validation import ClassificationOutputError, validate_response
from recognition.providers.base import ProviderError, RunContext

FAKE_SCENARIOS = (
    "mixed", "existing", "new_category", "unknown", "provider_error", "auth_failure", "invalid_output",
    "foreign_product", "missing_product", "service_target", "rejected_again", "pause",
)
FAKE_SCENARIO_ENV = "PRODUCT_CLASSIFICATION_FAKE_SCENARIO"
TEST_GENERIC = ("Тестовый продукт", ("Тестовая категория", "Тестовая подкатегория"), "pcs")


class ProductClassifier(Protocol):
    name: str   # "codex_cli" | "fake"
    model: str  # "" for fake

    def classify(self, request: ClassificationRequest, run: RunContext) -> ClassificationResponse: ...


def _item(product_id, decision, *, generic_id=None, generic_name=None, category_path=None, base_unit=None):
    return {
        "product_id": product_id, "decision": decision, "generic_id": generic_id, "generic_name": generic_name,
        "category_path": None if category_path is None else list(category_path), "base_unit": base_unit,
        "confidence": None if decision == "unknown" else 1, "note": None,
    }


def _new(product_id, answer):
    name, path, base_unit = answer
    return _item(product_id, "new", generic_name=name, category_path=path, base_unit=base_unit)


class FakeClassifier:
    name = "fake"
    model = ""

    def __init__(self, scenario="mixed", *, gate=None, entered=None):
        if scenario not in FAKE_SCENARIOS:
            raise ProviderError("configuration_error")
        self.scenario = scenario
        self.gate, self.entered = gate, entered

    def _named(self, product_id, name, generics):
        """An existing generic product with this name when the input lists it."""
        for generic in generics:
            if name_key(generic["name"]) == name_key(name):
                return _item(product_id, "existing", generic_id=generic["id"])
        return None

    def _mixed(self, product, generics):
        answer = demo.MIXED.get(product["name"])
        if answer is None:
            return _item(product["id"], "unknown")
        if isinstance(answer, str):
            # The demo expects it in the catalog; without it the fake proposes it as new.
            return self._named(product["id"], answer, generics) or _new(
                product["id"], (answer, (demo.FOOD, demo.DAIRY), "l"))
        return _new(product["id"], answer)

    def _answer(self, product, generics):
        if self.scenario == "existing":
            if not generics:
                return _item(product["id"], "unknown")
            return _item(product["id"], "existing", generic_id=min(generic["id"] for generic in generics))
        if self.scenario == "new_category":
            return _new(product["id"], TEST_GENERIC)
        if self.scenario == "unknown":
            return _item(product["id"], "unknown")
        if self.scenario == "service_target":
            return _new(product["id"], (SERVICE_NAME, (SERVICE_NAME,), "pcs"))
        if self.scenario == "rejected_again" and product["rejected"]:
            name = product["rejected"][0]
            return self._named(product["id"], name, generics) or _new(product["id"], (name, TEST_GENERIC[1][:1], "pcs"))
        return self._mixed(product, generics)

    def _pause(self, run):
        if self.entered is not None:
            self.entered.set()
        while self.gate is None or not self.gate.is_set():
            run.check()
            if self.gate is None:
                time.sleep(0.02)
            else:
                self.gate.wait(0.02)

    def classify(self, request, run):
        run.stage("classify")
        if self.scenario == "provider_error":
            raise ProviderError("provider_unavailable")
        if self.scenario == "auth_failure":
            raise ProviderError("auth_required")
        if self.scenario == "pause":
            self._pause(run)
        products, generics = request.document["products"], request.document["generic_products"]
        data = {"schema_version": SCHEMA_VERSION, "items": [self._answer(product, generics) for product in products]}
        if self.scenario == "invalid_output":
            data["unexpected"] = True
        if self.scenario == "foreign_product":
            data["items"].append(_item(max(request.product_ids, default=0) + 1, "unknown"))
        if self.scenario == "missing_product":
            data["items"] = data["items"][:-1]
        try:
            response = validate_response(data, product_ids=request.product_ids)
        except ClassificationOutputError:
            error = ProviderError("invalid_output")
            error.private_output = serialize(data)  # worker-only diagnostics of the attempt
            raise error from None
        run.check()  # a late release never resurrects a cancelled result
        return response


def get_classifier(*, scenario=None):
    """Choose the classifier by ``RECEIPT_OCR_PROVIDER``. A failure never selects the fake.

    The fake scenario comes from the argument, else from the server-only
    environment variable ``PRODUCT_CLASSIFICATION_FAKE_SCENARIO``, else ``mixed``.
    """
    name = getattr(settings, "RECEIPT_OCR_PROVIDER", "codex_cli")
    if name == "fake":
        return FakeClassifier(scenario=scenario or os.environ.get(FAKE_SCENARIO_ENV) or "mixed")
    # The codex_cli branch (classification.codex.CodexClassifier) arrives with the worker step.
    raise ProviderError("configuration_error")
