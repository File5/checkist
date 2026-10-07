"""One batch without the queue: input → classifier → check → apply.

The classifier is called outside any transaction and holds no locks. The
worker's queue and the ``suggest`` command both build on ``run_batch``.
"""
import math
import random
import time
from dataclasses import dataclass

from django.conf import settings
from django.db.models import Max
from django.utils import timezone

from classification import context as input_context
from classification import services
from classification.dto import ClassificationRequest, ClassificationResponse
from classification.models import ClassificationAttempt, ClassificationRun
from recognition.providers.base import ProviderError, RunContext

APPLY_ATTEMPTS = 3
INVALID_OUTPUT_LIMIT = 65536


@dataclass
class BatchResult:
    """Outcome of one batch.

    ``request`` is ``None`` when no product of the batch is a candidate any more
    or the input does not fit. ``error_code`` is set when the model call failed:
    then nothing was applied. ``consumed`` — how many of the given ids the batch
    dealt with (the input may be cut to fit the size limit); the executor moves
    the run cursor by it.
    """

    request: ClassificationRequest | None
    response: ClassificationResponse | None = None
    raw_payload: dict | None = None
    error_code: str = ""
    invalid_output_text: str = ""
    apply: services.ApplyResult | None = None
    consumed: int = 0


def _retry_delay(error, deadline):
    """Pause before the next attempt, as recognition does; ``None`` — do not retry."""
    if not error.retryable:
        return None
    delay = error.retry_after
    if delay is None:
        delay = random.uniform(2, 3)
    if type(delay) not in (int, float) or not math.isfinite(delay) or delay < 0 or delay > 30:
        return None
    delay = max(2, delay)
    return delay if deadline is None or time.monotonic() + delay < deadline else None


def _wait(seconds, context):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        if context is not None:
            context.check()
        time.sleep(min(0.05, max(0, until - time.monotonic())))


def _finish_attempt(attempt, *, error_code="", raw_payload=None, invalid_output_text=""):
    if attempt is None:
        return
    attempt.status = ClassificationAttempt.Status.FAILED if error_code else ClassificationAttempt.Status.SUCCEEDED
    attempt.error_code, attempt.raw_payload = error_code, raw_payload
    attempt.invalid_output_text = invalid_output_text
    attempt.finished_at = timezone.now()
    attempt.save(update_fields=["status", "error_code", "raw_payload", "invalid_output_text", "finished_at"])


def _classify(request, *, classifier, run, context, record):
    """Call the classifier, retrying retryable errors.

    ``(response, attempt, "")`` on success (the caller finishes the attempt after
    ``apply``), else ``(None, error code, invalid output text)``.
    """
    timeout = settings.PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS
    attempts = settings.RECEIPT_OCR_MAX_ATTEMPTS
    batch = None
    if record:
        batch = (run.attempts.aggregate(last=Max("batch"))["last"] or 0) + 1
    for ordinal in range(1, attempts + 1):
        attempt = None
        if record:
            attempt = ClassificationAttempt.objects.create(
                run=run, batch=batch, ordinal=ordinal, input_sha256=request.sha256,
                product_ids=list(request.product_ids),
            )
        # The deadline of one model request; an outer context may only shorten it.
        call = context.limited(timeout) if context is not None else RunContext(deadline=time.monotonic() + timeout)
        try:
            response = classifier.classify(request, call)
        except ProviderError as error:
            text = (error.private_output or "")[:INVALID_OUTPUT_LIMIT] if isinstance(error.private_output, str) else ""
            _finish_attempt(attempt, error_code=error.code, invalid_output_text=text)
            delay = _retry_delay(error, context.deadline if context is not None else None)
            if ordinal == attempts or delay is None:
                return None, error.code, text
            try:
                _wait(delay, context)
            except ProviderError as stopped:
                return None, stopped.code, text
        except BaseException as error:
            # Ctrl+C of the worker is not a failure of the step.
            _finish_attempt(
                attempt, error_code="worker_lost" if isinstance(error, KeyboardInterrupt) else "internal_error",
            )
            raise
        else:
            return response, attempt, ""


def run_batch(product_ids, *, classifier, run=None, context=None, dry_run=False):
    """Suggest generic products for one batch of product ids and apply the answer.

    The products are checked again first: ids that are no longer candidates are
    skipped as ``not_eligible``. With ``run`` the attempts and the counters of
    the run are written; its cursor and status stay with the caller. ``context``
    (``RunContext``) carries the cancellation of the worker. ``dry_run`` reads
    and calls the classifier, but writes nothing: no catalog, no run, no attempt.
    A busy catalog is retried three times; then the batch is left without
    suggestions (``catalog_busy``) and the run goes on.
    """
    product_ids = list(product_ids)
    auto = run is not None and run.trigger == ClassificationRun.Trigger.IMPORT \
        and run.scope == ClassificationRun.Scope.PRODUCTS
    eligible = list(services.candidates(product_ids=product_ids, auto=auto).values_list("pk", flat=True))
    record = run is not None and not dry_run
    if not eligible:
        skipped = {"not_eligible": len(product_ids)} if product_ids else {}
        if record:
            services.count_skipped(run, "not_eligible", len(product_ids))
        return BatchResult(
            request=None, apply=None if dry_run else services.ApplyResult([], 0, 0, skipped),
            consumed=len(product_ids),
        )
    try:
        request = input_context.fit_request(eligible)
    except input_context.InputTooLarge as error:
        return BatchResult(request=None, error_code=error.code)
    taken = set(request.product_ids)
    left = [product_id for product_id in eligible if product_id not in taken]
    consumed = product_ids.index(left[0]) if left else len(product_ids)
    stale = sum(product_id not in taken for product_id in product_ids[:consumed])
    if not request.product_ids:
        # The candidates vanished between the check and the read.
        if record:
            services.count_skipped(run, "not_eligible", len(product_ids))
        return BatchResult(request=None, consumed=len(product_ids))

    response, attempt, invalid_text = _classify(
        request, classifier=classifier, run=run, context=context, record=record,
    )
    if response is None:
        return BatchResult(request=request, error_code=attempt, invalid_output_text=invalid_text)
    raw_payload = response.to_dict()
    if dry_run:
        return BatchResult(request=request, response=response, raw_payload=raw_payload, consumed=consumed)
    source = services.default_source(classifier)
    applied = None
    for ordinal in range(APPLY_ATTEMPTS):
        try:
            applied = services.apply(run, response, source=source)
            break
        except services.ClassificationBusy:
            if ordinal < APPLY_ATTEMPTS - 1:
                time.sleep(0.2 * (ordinal + 1))
    if applied is None:
        services.count_skipped(run, "catalog_busy", len(request.product_ids))
        applied = services.ApplyResult([], 0, 0, {"catalog_busy": len(request.product_ids)})
    if stale:
        services.count_skipped(run, "not_eligible", stale)
        applied = services.ApplyResult(
            applied.record_ids, applied.applied, applied.unknown,
            {**applied.skipped, "not_eligible": applied.skipped.get("not_eligible", 0) + stale},
        )
    _finish_attempt(attempt, raw_payload=raw_payload)
    return BatchResult(request=request, response=response, raw_payload=raw_payload, apply=applied, consumed=consumed)


def execute(run, *, classifier):
    """Run every batch of a ``running`` run in this process; ``(run, record ids)``.

    Used by the ``suggest`` command. A failed model call ends the run as
    ``failed``; batches applied before it stay applied.
    """
    size = settings.PRODUCT_CLASSIFICATION_BATCH_SIZE
    record_ids = []
    try:
        while run.cursor < len(run.product_ids):
            result = run_batch(run.product_ids[run.cursor:run.cursor + size], classifier=classifier, run=run)
            if result.apply is not None:
                record_ids += result.apply.record_ids
            if result.error_code or not result.consumed:
                return services.finish_run(run, error_code=result.error_code or "internal_error"), record_ids
            run = services.advance_run(run, result.consumed)
        return services.finish_run(run), record_ids
    except BaseException as error:
        try:
            services.finish_run(
                run, error_code="worker_lost" if isinstance(error, KeyboardInterrupt) else "internal_error",
            )
        except Exception:  # the original error matters more than a run left running
            pass
        raise
