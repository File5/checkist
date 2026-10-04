"""Cancellation and errors shared by CLI, future API adapters and fake."""
import math
import time
from dataclasses import dataclass, field, replace
from typing import Callable, Protocol
from uuid import uuid4

from recognition.dto import DetectionResult, PreparedImage, PreparedReceiptImage, ReceiptObservation


ERRORS = {
    "auth_required": ("Provider authentication is required.", False),
    "network_unavailable": ("Provider network is unavailable.", True),
    "rate_limited": ("Provider rate limit was reached.", True),
    "provider_unavailable": ("Recognition provider is unavailable.", True),
    "configuration_error": ("Recognition provider configuration is invalid.", False),
    "invalid_input": ("Recognition input is invalid.", False),
    "invalid_output": ("Recognition provider returned invalid output.", False),
    "timeout": ("Recognition deadline was exceeded.", True),
    "cancelled": ("Recognition was cancelled.", False),
}


class ProviderError(Exception):
    def __init__(self, code, *, retry_after=None, reason=None):
        message, self.retryable = ERRORS[code]
        self.code = code
        self.message = message
        self.retry_after = retry_after
        # Optional fixed domain hint, never raw diagnostics or provider text.
        self.reason = reason if reason in ("too_many_receipts",) else None
        # Worker-only bounded diagnostic fragment for RecognitionAttempt.
        # Never include this attribute in API errors, progress or logs.
        self.private_output = None
        super().__init__(message)


@dataclass(frozen=True)
class RunContext:
    """deadline is absolute time.monotonic(); callbacks are owned by the worker.

    on_stage(stage) may persist progress; is_cancelled() reads durable cancel.
    No raw provider output is passed to callbacks. Cancel takes priority over
    timeout and must also be checked by the caller before committing imports.
    """
    deadline: float
    is_cancelled: Callable[[], bool] = lambda: False
    on_stage: Callable[[str], None] = lambda stage: None
    run_id: str = field(default_factory=lambda: str(uuid4()))

    def __post_init__(self):
        if isinstance(self.deadline, bool) or not math.isfinite(self.deadline):
            raise ValueError("Expected a finite monotonic deadline.")

    def check(self):
        if self.is_cancelled():
            raise ProviderError("cancelled")
        if time.monotonic() >= self.deadline:
            raise ProviderError("timeout")

    def stage(self, name):
        self.check()
        self.on_stage(name)
        self.check()

    def limited(self, seconds):
        return replace(self, deadline=min(self.deadline, time.monotonic() + seconds))


class ReceiptRecognitionProvider(Protocol):
    def detect(self, prepared_image: PreparedImage, run: RunContext) -> DetectionResult: ...

    def recognize(self, prepared_crop: PreparedReceiptImage, run: RunContext) -> ReceiptObservation: ...
