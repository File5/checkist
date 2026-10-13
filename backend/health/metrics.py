"""Prometheus metrics of the service: ``GET /metrics``, counted from the database at each scrape.

Only counts and times — no money, no names, no texts (docs/observability.md). Six queries whatever
the amount of data, so gunicorn needs no multiprocess mode: every worker answers from the database.
Prometheus reaches ``web:8000`` over the server's observability network with
``Authorization: Bearer <METRICS_TOKEN>``; Caddy answers 404 on this path from outside.
"""
import hmac
import logging
import os
from datetime import datetime, time, timedelta, timezone as dt_timezone

from django.apps import apps
from django.conf import settings
from django.db import DatabaseError, connection
from django.db.models import OuterRef, Subquery
from django.db.models.functions import Coalesce
from django.http import HttpResponse, HttpResponseNotFound
from django.utils import timezone
from django.utils.deprecation import MiddlewareMixin

PATH = "/metrics"
CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
ACTIVE = ("queued", "running", "cancel_requested")
QUANTILES = ("0.5", "0.9", "0.99")
logger = logging.getLogger(__name__)


class MetricsMiddleware(MiddlewareMixin):
    """Second line of MIDDLEWARE: answers GET/HEAD /metrics before the host check and the https redirect.

    Prometheus scrapes by the container name, which is not in ALLOWED_HOSTS, over plain http. Without
    ``METRICS_TOKEN`` or with another token the answer is a bare 404, as for a path that does not exist.
    """

    def process_request(self, request):
        if request.path_info != PATH or request.method not in ("GET", "HEAD"):
            return None
        token = settings.METRICS_TOKEN
        given = request.META.get("HTTP_AUTHORIZATION", "").encode()
        if not token or not hmac.compare_digest(given, f"Bearer {token}".encode()):
            return HttpResponseNotFound()
        body = render().encode()
        return HttpResponse(b"" if request.method == "HEAD" else body, content_type=CONTENT_TYPE)


class Metrics:
    """Gauges in the Prometheus text format: ``{name: (help, [(labels, value)])}``."""

    def __init__(self):
        self.families = {}

    def add(self, name, help_text, value, **labels):
        self.families.setdefault(name, (help_text, []))[1].append((labels, value))

    def text(self):
        lines = []
        for name, (help_text, samples) in self.families.items():
            lines += [f"# HELP {name} {help_text}", f"# TYPE {name} gauge"]
            for labels, value in samples:
                pairs = ",".join(f'{key}="{escape(item)}"' for key, item in labels.items())
                number = str(value) if isinstance(value, int) else repr(float(value))
                lines.append(f"{name}{{{pairs}}} {number}" if pairs else f"{name} {number}")
        return "\n".join(lines) + "\n"


def escape(value):
    return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def queues():
    """``{queue: model}`` of the worker queues; each has status, error_code and the four times."""
    return {name: apps.get_model(label) for name, label in (
        ("recognition", "recognition.ProcessingJob"), ("manual_parse", "receipts.ManualParseRequest"),
        ("statement_ask", "statements.StatementAsk"), ("insight", "insights.InsightRequest"))}


def queue_rows(where):
    """The rows of every queue as one UNION ALL: queue, status, error_code, created/started/finished."""
    quote = connection.ops.quote_name
    return " UNION ALL ".join(
        f"SELECT '{name}' AS queue, status, error_code, created_at, started_at, finished_at "
        f"FROM {quote(model._meta.db_table)} WHERE {where}"
        for name, model in queues().items()
    )


def table(label):
    return connection.ops.quote_name(apps.get_model(label)._meta.db_table)


def collect(metrics, now):
    # Imported here: the module is loaded with MIDDLEWARE, the API module pulls in the whole recognition app.
    from accounts.models import AiUsage, Household
    from api.recognition_serialization import executor_object
    from receipts.models import Receipt

    hour, day = now - timedelta(hours=1), now - timedelta(days=1)
    windows = {"since": day, "hour": hour, "day": day, "now": now}
    active = ", ".join(f"'{status}'" for status in ACTIVE)
    with connection.cursor() as cursor:
        cursor.execute(
            f"WITH q AS ({queue_rows(f'status IN ({active}) OR finished_at >= %(since)s')}) "
            f"SELECT queue, status, error_code, count(*) FILTER (WHERE status IN ({active})), "
            "count(*) FILTER (WHERE finished_at >= %(hour)s), count(*) FILTER (WHERE finished_at >= %(day)s), "
            "EXTRACT(EPOCH FROM %(now)s - min(created_at) FILTER (WHERE status = 'queued')) "
            "FROM q GROUP BY queue, status, error_code", windows)
        queue_counts = cursor.fetchall()
        cursor.execute(
            f"WITH q AS ({queue_rows('started_at IS NOT NULL AND finished_at >= %(since)s')}) "
            "SELECT queue, w.name, percentile_cont(ARRAY[0.5, 0.9, 0.99]) WITHIN GROUP "
            "(ORDER BY EXTRACT(EPOCH FROM finished_at - started_at)) "
            "FROM q, (VALUES ('1h', %(hour)s), ('24h', %(day)s)) AS w(name, since) "
            "WHERE q.finished_at >= w.since GROUP BY queue, w.name", windows)
        durations = cursor.fetchall()
        sources = list(Receipt.Source.values)
        cursor.execute(
            "SELECT " + ", ".join(
                [f"(SELECT count(*) FROM {table('receipts.Receipt')} WHERE source = %s)" for _ in sources]
                + [f"(SELECT count(*) FROM {table('recognition.SourcePhoto')})",
                   f"(SELECT count(*) FROM {table('auth.User')} WHERE is_active)",
                   f"(SELECT count(*) FROM {table('push.PushSubscription')})",
                   f"(SELECT count(*) FROM {table('push.PushNotification')} WHERE sent_at >= %s)",
                   f"(SELECT count(*) FROM {table('push.PushNotification')} WHERE sent_at IS NULL AND send_after <= %s)",
                   f"(SELECT EXTRACT(EPOCH FROM %s - min(send_after)) FROM {table('push.PushNotification')} "
                   "WHERE sent_at IS NULL AND send_after <= %s)",
                   f"(SELECT max(day) FROM {table('rates.Rate')})"]),
            [*sources, day, now, now, now])
        *receipts, photos, users, devices, sent, due, due_age, rate_day = cursor.fetchone()
    today = timezone.localdate(now)
    usage = AiUsage.objects.filter(household=OuterRef("pk"), day=today).values("count")
    families = list(Household.objects.order_by("pk").values_list(
        "pk", "ai_enabled", "ai_daily_limit", Coalesce(Subquery(usage), 0)))
    executor = executor_object()

    for name, model in queues().items():
        statuses = model._meta.get_field("status").choices
        seen = {status: [0, 0, 0] for status, _label in statuses}
        failures, oldest = {}, 0.0
        for queue, status, code, now_active, last_hour, last_day, age in queue_counts:
            if queue != name:
                continue
            counts = seen.setdefault(status, [0, 0, 0])
            counts[0], counts[1], counts[2] = counts[0] + now_active, counts[1] + last_hour, counts[2] + last_day
            if status == "failed" and last_day:
                failures[code or "unknown"] = failures.get(code or "unknown", 0) + last_day
            oldest = max(oldest, float(age or 0))
        for status, (now_active, last_hour, last_day) in seen.items():
            if status in ACTIVE:
                metrics.add("checkist_queue_items", "Unfinished items of a worker queue by status.",
                            now_active, queue=name, status=status)
            else:
                for window, value in (("1h", last_hour), ("24h", last_day)):
                    metrics.add("checkist_queue_finished", "Items of a worker queue finished within the window.",
                                value, queue=name, status=status, window=window)
        metrics.add("checkist_queue_oldest_queued_seconds", "Age of the oldest queued item, 0 when none.",
                    oldest, queue=name)
        for code, value in sorted(failures.items()):
            metrics.add("checkist_queue_failures", "Failed items of the last 24 hours by error code.",
                        value, queue=name, code=code, window="24h")
    for queue, window, values in durations:
        for quantile, value in zip(QUANTILES, values):
            metrics.add("checkist_queue_duration_seconds", "Quantiles of start-to-finish time of finished items.",
                        value, queue=queue, window=window, quantile=quantile)
    for state in ("idle", "busy", "absent"):
        metrics.add("checkist_recognition_worker", "Recognition worker: 1 for its current state.",
                    int(executor["state"] == state), state=state)
    for pk, enabled, limit, used in families:
        metrics.add("checkist_ai_requests_today", "Model requests of a family today (accounts.AiUsage).",
                    used, household=pk)
        metrics.add("checkist_ai_enabled", "1 when the family allows the model.", int(enabled), household=pk)
        if limit is not None:
            metrics.add("checkist_ai_daily_limit", "Daily model requests allowed to a family.", limit, household=pk)
    metrics.add("checkist_push_subscriptions", "Devices subscribed to web push.", devices)
    metrics.add("checkist_push_sent_24h", "Push notifications sent in the last 24 hours.", sent)
    metrics.add("checkist_push_due", "Push notifications due and not sent yet.", due)
    metrics.add("checkist_push_due_oldest_seconds", "How long the oldest due notification waits, 0 when none.",
                float(due_age or 0))
    if rate_day is not None:
        midnight = datetime.combine(rate_day, time(), tzinfo=dt_timezone.utc)
        metrics.add("checkist_rates_last_day_timestamp_seconds", "Day of the newest exchange rate.",
                    int(midnight.timestamp()))
        metrics.add("checkist_rates_age_days", "Days since the newest exchange rate.", (today - rate_day).days)
    for source, value in zip(sources, receipts):
        metrics.add("checkist_receipts", "Spends by source.", value, source=source)
    metrics.add("checkist_photos", "Uploaded photos and PDF.", photos)
    metrics.add("checkist_users", "Active user accounts.", users)
    metrics.add("checkist_households", "Families.", len(families))


def render(now=None):
    metrics = Metrics()
    try:
        collect(metrics, now or timezone.now())
        up = 1
    except DatabaseError as error:
        logger.warning("metrics: database query failed: %s", type(error).__name__)
        metrics, up = Metrics(), 0
    metrics.add("checkist_up", "1 when this scrape read the database.", up)
    commit = os.environ.get("CHECKIST_COMMIT", "").strip()
    if commit:
        metrics.add("checkist_build_info", "Commit of the running code.", 1, commit=commit[:40])
    return metrics.text()
