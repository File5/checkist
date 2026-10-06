"""Codex CLI classifier: the prompt file, the input document and one text-only call.

No ORM and no fake fallback: a failure is a ``ProviderError`` of the shared
provider codes. The answer goes through the same ``validate_response`` as the
fake one.
"""
from pathlib import Path

from django.conf import settings

from classification.dto import serialize
from classification.validation import SCHEMA_PATH, ClassificationOutputError, validate_response
from recognition.providers.base import ProviderError

PROMPT_PATH = Path(__file__).resolve().parent / "prompts" / "classification.txt"
INPUT_MARKER = "INPUT JSON:"
PRIVATE_OUTPUT_LIMIT = 65536


def build_prompt(request):
    """The prompt file has no placeholders: the input follows it after the marker line."""
    text = PROMPT_PATH.read_text(encoding="utf-8").rstrip("\n")
    return f"{text}\n{INPUT_MARKER}\n{request.to_json()}\n"


class CodexClassifier:
    name = "codex_cli"

    def __init__(self, provider=None):
        if provider is None:
            from recognition.providers.codex_cli import CodexCLIProvider

            provider = CodexCLIProvider()
        self.provider = provider
        self.model = provider.config.model

    def classify(self, request, run):
        try:
            prompt = build_prompt(request)
        except OSError:
            raise ProviderError("configuration_error") from None
        data = self.provider.run_text(
            prompt=prompt, schema=SCHEMA_PATH, timeout_seconds=settings.PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS,
            run=run,
        )
        try:
            response = validate_response(data, product_ids=request.product_ids)
        except ClassificationOutputError:
            error = ProviderError("invalid_output")
            # Worker-only diagnostics of the attempt; never API, progress or logs.
            error.private_output = serialize(data)[:PRIVATE_OUTPUT_LIMIT]
            raise error from None
        run.check()  # a late answer never survives a stop of the worker
        return response
