from django.conf import settings

from .base import ProviderError


def get_provider(*, scenario=None):
    """Choose provider explicitly. Failures never select a fake fallback.

    RECEIPT_OCR_FAKE_SCENARIO is an additive server-only demo setting. C1 must
    load it from root env for the host worker; HTTP request bodies do not set it.
    """
    name = getattr(settings, "RECEIPT_OCR_PROVIDER", "codex_cli")
    if name == "fake":
        from .fake import FakeProvider
        return FakeProvider(scenario=scenario or getattr(settings, "RECEIPT_OCR_FAKE_SCENARIO", "success2"))
    if name == "codex_cli":
        from .codex_cli import CodexCLIProvider
        return CodexCLIProvider()
    raise ProviderError("configuration_error")
