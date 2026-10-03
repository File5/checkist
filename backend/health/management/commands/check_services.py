import json

from django.core.management.base import BaseCommand, CommandError

from health import probes
from health.tasks import ping


def safe_probe(probe, code):
    try:
        return probe()
    except Exception:
        return {"status": "error", "code": code}


class Command(BaseCommand):
    help = "Check Postgres/cache and execute health.ping through the real broker and result backend."

    def handle(self, *args, **options):
        database = safe_probe(probes.probe_database, "database_unavailable")
        redis = safe_probe(probes.probe_redis, "redis_unavailable")
        celery_task = {"status": "error", "code": "celery_task_unavailable"}
        try:
            with probes.broker_connection() as broker:
                broker.ensure_connection(max_retries=0)
                pending = ping.apply_async(connection=broker, retry=False, expires=10)
                result = pending.get(timeout=5)
            if result == {"message": "pong"}:
                celery_task = {"status": "ok", "result": result}
            else:
                celery_task["code"] = "unexpected_task_result"
        except Exception:
            # Remote task failures can deserialize into arbitrary exception types.
            # Always fail the command using the safe, fixed diagnostic below.
            pass
        body = {
            "database": "ok" if database["status"] == "ok" else database["code"],
            "redis": "ok" if redis["status"] == "ok" else redis["code"],
            "celery_task": celery_task,
        }
        self.stdout.write(json.dumps(body, ensure_ascii=False))
        if any(check["status"] != "ok" for check in (database, redis, celery_task)):
            raise CommandError("Один или несколько сервисов недоступны.")
