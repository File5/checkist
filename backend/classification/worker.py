"""One batch of a claimed run, for the host worker.

``runner.run_batch`` does the batch itself: input, the attempt rows, the model
call outside any transaction, the check, ``services.apply`` and the counters of
the run. This module adds what only the queue knows: the lease, the stop of
the worker and the transition of the run after the batch.
"""
import time

from django.conf import settings

from classification import queue, runner
from recognition.providers.base import RunContext

# Pause between attempts of one batch, at most (runner._retry_delay).
RETRY_PAUSE_SECONDS = 30


def process_batch(run, *, classifier, is_stopped=lambda: False):
    """process_batch(run, *, classifier, is_stopped) -> run after one batch.

    ``run`` is a run claimed by ``queue.claim_run``. ``is_stopped`` tells that
    the worker lost its slot: the model request is stopped and the run goes back
    to the queue. An exception leaves the run ``running`` for the caller:
    ``queue.release_run`` on Ctrl+C, ``queue.fail_run`` on an unexpected error.
    """
    lost = []

    def renew(stage):
        # The start of every model call renews the lease: no heartbeat thread.
        try:
            queue.heartbeat(run)
        except queue.RunLost:
            lost.append(stage)

    attempts = settings.RECEIPT_OCR_MAX_ATTEMPTS
    budget = attempts * (settings.PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS + RETRY_PAUSE_SECONDS)
    context = RunContext(
        deadline=time.monotonic() + budget, is_cancelled=lambda: bool(lost) or is_stopped(), on_stage=renew,
    )
    size = settings.PRODUCT_CLASSIFICATION_BATCH_SIZE
    result = runner.run_batch(
        run.product_ids[run.cursor:run.cursor + size], classifier=classifier, run=run, context=context,
    )
    try:
        if result.error_code == "cancelled":
            # Only the stop of the worker cancels a call; it is not a failure of the run.
            return queue.release_run(run)
        return queue.finish_batch(run, result)
    except queue.RunLost:
        # Closed by somebody else meanwhile; what the batch applied stays applied.
        run.refresh_from_db()
        return run
