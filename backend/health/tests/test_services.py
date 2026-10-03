import io
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch
from uuid import uuid4

from celery.exceptions import TimeoutError as CeleryTimeoutError
from django.core.cache import cache
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import OperationalError, connection
from django.test import SimpleTestCase, TestCase, tag
from kombu.exceptions import OperationalError as BrokerError
from redis.exceptions import ConnectionError as RedisConnectionError

from health import probes


class ProbeTests(SimpleTestCase):
    def test_database_queries_and_checks_result(self):
        with patch("health.probes.connection") as db:
            cursor = db.cursor.return_value.__enter__.return_value
            cursor.fetchone.return_value = (1,)
            self.assertEqual(probes.probe_database(), {"status": "ok"})
            cursor.execute.assert_called_once_with("SELECT 1")
            cursor.fetchone.return_value = (0,)
            self.assertEqual(probes.probe_database(), {
                "status": "error", "code": "database_unavailable",
            })

    def test_database_failure_is_safe(self):
        with patch("health.probes.connection") as db:
            db.cursor.side_effect = OperationalError("password-secret internal-host")
            self.assertEqual(probes.probe_database(), {
                "status": "error", "code": "database_unavailable",
            })

    def test_cache_uses_unique_keys_ttl_and_cleanup(self):
        with patch("health.probes.cache") as mocked:
            mocked.get.side_effect = lambda key: mocked.set.call_args.args[1]
            for _ in range(2):
                self.assertEqual(probes.probe_redis(), {"status": "ok"})
            keys = [call.args[0] for call in mocked.set.call_args_list]
            self.assertNotEqual(keys[0], keys[1])
            for key in keys:
                self.assertTrue(key.startswith("health:"))
            for call in mocked.set.call_args_list:
                self.assertEqual(call.kwargs, {"timeout": 5})
            self.assertEqual(mocked.delete.call_args_list, mocked.get.call_args_list)

    def test_cache_mismatch_and_failures_still_clean_up(self):
        for operation in ("mismatch", "set", "get", "delete"):
            with self.subTest(operation=operation), patch("health.probes.cache") as mocked:
                mocked.get.side_effect = lambda key: mocked.set.call_args.args[1]
                if operation == "mismatch":
                    mocked.get.side_effect = None
                    mocked.get.return_value = "incorrect"
                else:
                    getattr(mocked, operation).side_effect = RedisConnectionError("password-secret")
                self.assertEqual(probes.probe_redis(), {
                    "status": "error", "code": "redis_unavailable",
                })
                mocked.delete.assert_called_once_with(mocked.set.call_args.args[0])

    def test_celery_reply_and_missing_worker(self):
        for reply, expected in (
            ({"internal-host": {"ok": "pong"}}, {"status": "ok"}),
            (None, {"status": "error", "code": "worker_unavailable"}),
            ({}, {"status": "error", "code": "worker_unavailable"}),
        ):
            with self.subTest(reply=reply), patch("health.probes.broker_connection") as factory, \
                    patch("health.probes.app.control.inspect") as inspect:
                broker = factory.return_value.__enter__.return_value
                inspect.return_value.ping.return_value = reply
                self.assertEqual(probes.probe_celery(), expected)
                broker.ensure_connection.assert_called_once_with(max_retries=0)
                inspect.assert_called_once_with(connection=broker, timeout=1, limit=1)

    def test_broker_failure_on_connect_or_publish(self):
        for phase in ("connect", "publish"):
            with self.subTest(phase=phase), patch("health.probes.broker_connection") as factory, \
                    patch("health.probes.app.control.inspect") as inspect:
                broker = factory.return_value.__enter__.return_value
                if phase == "connect":
                    broker.ensure_connection.side_effect = BrokerError("redis://password-secret")
                else:
                    inspect.return_value.ping.side_effect = RedisConnectionError("password-secret")
                self.assertEqual(probes.probe_celery(), {
                    "status": "error", "code": "broker_unavailable",
                })

    def test_control_publication_cannot_retry_after_connection_loss(self):
        broker = probes.broker_connection()
        publish = MagicMock(side_effect=RedisConnectionError("secret"))
        publish.__name__ = "publish"
        with broker:
            # A real Kombu ensure wrapper around a failing publication, without network IO.
            bounded_publish = broker.ensure(MagicMock(), publish, max_retries=10)
            with self.assertRaises(BrokerError):
                bounded_publish()
        publish.assert_called_once_with()


class CheckServicesTests(SimpleTestCase):
    def setUp(self):
        for name in ("database", "redis"):
            probe = patch(f"health.probes.probe_{name}", return_value={"status": "ok"})
            setattr(self, name, probe.start())
            self.addCleanup(probe.stop)
        connection_patch = patch("health.probes.broker_connection")
        self.broker = connection_patch.start().return_value.__enter__.return_value
        self.addCleanup(connection_patch.stop)
        publish = patch("health.management.commands.check_services.ping.apply_async")
        self.publish = publish.start()
        self.addCleanup(publish.stop)
        self.publish.return_value.get.return_value = {"message": "pong"}

    def test_publishes_and_waits_for_exact_result(self):
        output = io.StringIO()
        call_command("check_services", stdout=output)
        self.assertEqual(json.loads(output.getvalue()), {
            "database": "ok", "redis": "ok",
            "celery_task": {"status": "ok", "result": {"message": "pong"}},
        })
        self.publish.assert_called_once_with(connection=self.broker, retry=False, expires=10)
        self.publish.return_value.get.assert_called_once_with(timeout=5)

    def test_failure_result_is_safe_and_command_fails(self):
        for failure in ("timeout", "publication", "task_error", "wrong_result", "database"):
            with self.subTest(failure=failure):
                self.publish.side_effect = None
                self.publish.return_value.get.side_effect = None
                self.publish.return_value.get.return_value = {"message": "pong"}
                self.database.return_value = {"status": "ok"}
                if failure == "timeout":
                    self.publish.return_value.get.side_effect = CeleryTimeoutError("password-secret")
                elif failure == "publication":
                    self.publish.side_effect = BrokerError("password-secret")
                elif failure == "task_error":
                    self.publish.return_value.get.side_effect = RuntimeError("password-secret")
                elif failure == "wrong_result":
                    self.publish.return_value.get.return_value = {"secret": "password-secret"}
                else:
                    self.database.return_value = {"status": "error", "code": "database_unavailable"}
                output = io.StringIO()
                with self.assertRaises(CommandError) as raised:
                    call_command("check_services", stdout=output)
                self.assertNotIn("password-secret", output.getvalue() + str(raised.exception))
                body = json.loads(output.getvalue())
                if failure == "database":
                    self.assertEqual(body["database"], "database_unavailable")
                    self.assertEqual(body["celery_task"]["status"], "ok")
                else:
                    self.assertEqual(body["celery_task"]["status"], "error")

    def test_unexpected_probe_error_is_safe_and_other_checks_continue(self):
        self.database.side_effect = RuntimeError("postgres://password-secret@internal-host")
        output = io.StringIO()
        with self.assertRaises(CommandError):
            call_command("check_services", stdout=output)
        self.assertEqual(json.loads(output.getvalue()), {
            "database": "database_unavailable", "redis": "ok",
            "celery_task": {"status": "ok", "result": {"message": "pong"}},
        })
        self.redis.assert_called_once_with()
        self.publish.assert_called_once()


class SettingsTests(SimpleTestCase):
    def load_settings(self, overrides):
        # A subprocess ensures dotenv/import state cannot leak between configurations.
        env = os.environ.copy()
        env.update(overrides)
        return subprocess.run(
            [sys.executable, "-X", "utf8", "-c", "import config.settings"],
            cwd=Path(__file__).resolve().parents[2], env=env,
            capture_output=True, text=True, encoding="utf-8", timeout=10,
        )

    def test_invalid_env_fails_startup_without_echoing_secret(self):
        for name, value in (
            ("DJANGO_DEBUG", "perhaps"),
            ("POSTGRES_PORT", "65536"),
            ("REDIS_PORT", "0"),
            ("POSTGRES_HOST", "user:password-secret@host"),
            ("DJANGO_ALLOWED_HOSTS", "*"),
            ("DJANGO_ALLOWED_HOSTS", "[[127.0.0.1]]"),
            ("CELERY_BROKER_URL", "http://user:password-secret@host/0"),
            ("CELERY_RESULT_BACKEND", "redis://user:password-secret@host:no/1"),
            ("DJANGO_CACHE_URL", "redis://user:password-secret@host/2?socket_timeout=999"),
        ):
            with self.subTest(name=name):
                process = self.load_settings({name: value})
                self.assertNotEqual(process.returncode, 0)
                self.assertIn(f"{name}:", process.stderr)
                self.assertNotIn("password-secret", process.stderr)

    def test_production_rejects_dev_secret(self):
        rejected = self.load_settings({
            "DJANGO_DEBUG": "0", "DJANGO_SECRET_KEY": "dev-only-checkist-key-change-before-deployment",
        })
        self.assertNotEqual(rejected.returncode, 0)
        self.assertIn("DJANGO_SECRET_KEY:", rejected.stderr)
        accepted = self.load_settings({"DJANGO_DEBUG": "0", "DJANGO_SECRET_KEY": "custom-test-secret"})
        self.assertEqual(accepted.returncode, 0, accepted.stderr)


@tag("integration")
class ServiceIntegrationTests(TestCase):
    def test_real_postgres_query(self):
        self.assertEqual(connection.vendor, "postgresql")
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1, current_database()")
            value, database = cursor.fetchone()
        self.assertEqual(value, 1)
        self.assertEqual(database, connection.settings_dict["NAME"])
        self.assertTrue(database.startswith("test_"))
        self.assertEqual(probes.probe_database(), {"status": "ok"})

    def test_real_cache_round_trip_and_probe_cleanup(self):
        identifier = uuid4()
        key = f"health:{identifier}"
        try:
            cache.set(key, "integration", timeout=5)
            self.assertEqual(cache.get(key), "integration")
        finally:
            cache.delete(key)
        self.assertIsNone(cache.get(key))
        with patch("health.probes.uuid4", side_effect=[identifier, uuid4()]):
            self.assertEqual(probes.probe_redis(), {"status": "ok"})
        self.assertIsNone(cache.get(key))
