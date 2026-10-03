from uuid import uuid4

from django.core.cache import cache
from django.db import DatabaseError, connection
from kombu import Connection
from kombu.exceptions import KombuError
from redis.exceptions import RedisError

from config.celery import app


class BoundedBrokerConnection(Connection):
    """Bound control publication retries, including Kombu's retry=True mailbox."""

    def ensure(self, obj, fun, **kwargs):
        kwargs["max_retries"] = 0
        return super().ensure(obj, fun, **kwargs)


def broker_connection():
    return BoundedBrokerConnection(
        app.conf.broker_url,
        connect_timeout=1,
        transport_options={
            **app.conf.broker_transport_options,
            "socket_connect_timeout": 1,
            "socket_timeout": 1,
            "retry_on_timeout": False,
            "max_retries": 0,
        },
    )


def probe_database():
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
            if cursor.fetchone() == (1,):
                return {"status": "ok"}
    except DatabaseError:
        pass
    return {"status": "error", "code": "database_unavailable"}


def probe_redis():
    key = f"health:{uuid4()}"
    value = uuid4().hex
    healthy = False
    try:
        cache.set(key, value, timeout=5)
        healthy = cache.get(key) == value
    except RedisError:
        pass
    finally:
        try:
            cache.delete(key)
        except RedisError:
            healthy = False
    return {"status": "ok"} if healthy else {"status": "error", "code": "redis_unavailable"}


def probe_celery():
    try:
        with broker_connection() as broker:
            broker.ensure_connection(max_retries=0)
            replies = app.control.inspect(connection=broker, timeout=1, limit=1).ping()
    except (KombuError, RedisError, OSError):
        return {"status": "error", "code": "broker_unavailable"}
    if replies and any(reply.get("ok") == "pong" for reply in replies.values()):
        return {"status": "ok"}
    return {"status": "error", "code": "worker_unavailable"}
