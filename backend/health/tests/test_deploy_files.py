import json
import os
import re
import runpy
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

from django.conf import settings
from django.test import SimpleTestCase

# A static comparison of the files in deploy/ with each other and with the settings.
# It starts neither gunicorn, nor Caddy, nor systemd: that is the manual server acceptance.
ROOT = settings.BASE_DIR.parent
DEPLOY = ROOT / "deploy"
UNITS = DEPLOY / "systemd"
SERVICES = ("checkist-web", "checkist-recognition", "checkist-celery", "checkist-backup")
FILES = (
    "gunicorn.conf.py", "Caddyfile", "checkist.env.example", "systemd/checkist-backup.timer",
    *(f"systemd/{name}.service" for name in SERVICES),
)
ENV_FILE = "/etc/checkist/checkist.env"
VENV_BIN = "/opt/checkist/backend/.venv/bin/"
DOMAIN = "checkist.example"
UPSTREAM = "127.0.0.1:8000"
SPA_ROOT = "/opt/checkist/frontend/dist"
SECRETS = ("DJANGO_SECRET_KEY", "POSTGRES_PASSWORD")
# Read by the settings only after the accounts stage; listed here until then.
AUTH_MODE = "CHECKIST_AUTH_MODE"
# Fictional values for a settings load.
SERVER_KEY = "test-only-9f3b7c1e5a2d8046bd17c93e60fa4852-Qx7Lm2Zr8Vt5Hn"
SERVER_PASSWORD = "test-only-database-password"


def text(name):
    return (DEPLOY / name).read_text(encoding="utf-8")


def uncommented(name):
    return "\n".join(
        line for line in text(name).splitlines() if line.strip() and not line.lstrip().startswith("#")
    )


def unit(name):
    """Sections of a systemd unit: {section: {key: [values in order]}}."""
    sections, current = {}, None
    for line in uncommented(f"systemd/{name}").splitlines():
        line = line.strip()
        if line.startswith("["):
            current = sections.setdefault(line.strip("[]"), {})
            continue
        key, separator, value = line.partition("=")
        assert separator and current is not None, line
        current.setdefault(key, []).append(value)
    return sections


def env_example():
    values = {}
    for line in uncommented("checkist.env.example").splitlines():
        name, separator, value = line.partition("=")
        assert separator and name not in values, line
        values[name] = value
    return values


def caddy_block(source, header):
    """Body of the first `<header> {` block, braces balanced."""
    start = source.index(header + " {") + len(header) + 2
    depth, position = 1, start
    while depth:
        depth += {"{": 1, "}": -1}.get(source[position], 0)
        position += 1
    return source[start:position - 1]


class DeployFilesTests(SimpleTestCase):
    def test_files_are_present_utf8_and_lf(self):
        for name in FILES:
            with self.subTest(name=name):
                data = (DEPLOY / name).read_bytes()
                self.assertNotIn(b"\r", data)
                self.assertTrue(data.endswith(b"\n"))
                data.decode("utf-8")

    def test_no_secret_values_in_deploy_files(self):
        for name in FILES:
            with self.subTest(name=name):
                source = text(name)
                self.assertNotIn(settings.DEV_SECRET_KEY, source)
                self.assertNotIn("checkist_dev_only", source)
                for secret in SECRETS:
                    self.assertIsNone(re.search(rf"{secret}[ \t]*=[ \t]*\S", source))
        for name in (*(f"{service}.service" for service in SERVICES), "checkist-backup.timer"):
            with self.subTest(unit=name):
                for values in unit(name).values():
                    for assignment in values.get("Environment", []):
                        self.assertNotRegex(assignment, r"(?i)secret|password|token|key")

    # gunicorn

    def test_gunicorn_listens_on_loopback_and_leaves_the_scheme_to_django(self):
        config = runpy.run_path(str(DEPLOY / "gunicorn.conf.py"))
        self.assertEqual(config["bind"], UPSTREAM)
        self.assertEqual(config["worker_class"], "gthread")
        self.assertGreaterEqual(config["threads"], 2)
        # An empty dictionary: X-Forwarded-Proto is honoured only by Django with DJANGO_TRUST_PROXY=1.
        self.assertEqual(config["secure_scheme_headers"], {})
        self.assertIsNone(config["accesslog"])
        self.assertIs(config["control_socket_disable"], True)
        self.assertNotIn("forwarded_allow_ips", config)

    def test_gunicorn_is_pinned_once_in_both_requirement_files(self):
        direct = (settings.BASE_DIR / "requirements.in").read_text(encoding="utf-8").splitlines()
        pinned = (settings.BASE_DIR / "requirements.txt").read_text(encoding="utf-8").splitlines()
        lines = [line for line in direct if line.lower().startswith("gunicorn")]
        self.assertEqual(len(lines), 1)
        self.assertRegex(lines[0], r"^gunicorn==\d+\.\d+\.\d+$")
        self.assertEqual([line for line in pinned if line.lower().startswith("gunicorn")], lines)

    # Caddy

    def setUp(self):
        self.caddy = uncommented("Caddyfile")

    def test_caddy_site_is_the_placeholder_domain_with_automatic_https(self):
        self.assertEqual(re.findall(r"^(\S.*) \{$", self.caddy, flags=re.MULTILINE), [DOMAIN])
        for forbidden in ("http://", "auto_https", "tls internal", "trusted_proxies"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, self.caddy)
        # No access log: paths and queries carry ids.
        self.assertIsNone(re.search(r"^\s*log\b", self.caddy, flags=re.MULTILINE))

    def test_caddy_headers_cover_every_response(self):
        site = caddy_block(self.caddy, DOMAIN)
        headers = [line.strip() for line in caddy_block(site, "\theader").splitlines() if line.strip()]
        self.assertIn('X-Robots-Tag "noindex, nofollow"', headers)
        self.assertIn("-Server", headers)
        # Deferred: the value replaces the one Django sent instead of duplicating it.
        self.assertIn("defer", headers)
        # The block stands at the site level, outside any `handle`.
        self.assertIn("\n\theader {\n", site)

    def test_caddy_hsts_equals_the_django_value(self):
        ages = re.findall(r'Strict-Transport-Security "max-age=(\d+)"', self.caddy)
        self.assertEqual(ages, [env_example()["DJANGO_HSTS_SECONDS"]])
        self.assertNotIn("includeSubDomains", self.caddy)
        self.assertNotIn("preload", self.caddy)

    def test_caddy_passes_django_paths_to_gunicorn(self):
        matcher = re.search(r"^\s*@django path (.+)$", self.caddy, flags=re.MULTILINE).group(1).split()
        self.assertEqual(set(matcher), {"/api/*", "/admin", "/admin/*", "/media/*", "/robots.txt"})
        block = caddy_block(self.caddy, "handle @django").split()
        self.assertEqual(block, ["reverse_proxy", UPSTREAM])
        self.assertEqual(self.caddy.count("reverse_proxy"), 1)

    def test_caddy_never_reads_media_from_disk(self):
        variables = env_example()
        self.assertNotIn(variables["MEDIA_ROOT"], self.caddy)
        self.assertNotIn(variables["RECEIPT_OCR_TEMP_ROOT"], self.caddy)
        roots = set(re.findall(r"^\s*root \* (\S+)$", self.caddy, flags=re.MULTILINE))
        self.assertEqual(roots, {variables["DJANGO_STATIC_ROOT"], SPA_ROOT})
        for root in roots:
            self.assertFalse(PurePosixPath(variables["MEDIA_ROOT"]).is_relative_to(root))
        # Every mention of media is the proxied path.
        self.assertEqual(re.findall(r"\S*media\S*", self.caddy, flags=re.IGNORECASE), ["/media/*"])

    def test_caddy_serves_static_and_the_spa(self):
        static = caddy_block(self.caddy, "handle /static/*")
        self.assertIn(f"root * {env_example()['DJANGO_STATIC_ROOT']}", static)
        self.assertIn("uri strip_prefix /static", static)
        self.assertIn("file_server", static)
        self.assertNotIn("try_files", static)
        self.assertEqual(settings.STATIC_URL.strip("/"), "static")
        assets = caddy_block(self.caddy, "handle /assets/*")
        self.assertIn("immutable", assets)
        self.assertNotIn("try_files", assets)
        fallback = caddy_block(self.caddy, "\thandle")
        self.assertIn(f"root * {SPA_ROOT}", fallback)
        self.assertIn("try_files {path} /index.html", fallback)
        self.assertIn('header Cache-Control "no-cache"', fallback)
        self.assertIn("file_server", fallback)
        self.assertEqual(self.caddy.count("try_files"), 1)

    def test_caddy_body_limit_fits_the_largest_upload(self):
        limit = re.search(r"max_size (\d+)MB", caddy_block(self.caddy, "request_body"))
        # Caddy reads MB as 10^6 bytes; the multipart envelope needs room above the image itself.
        self.assertGreater(int(limit.group(1)) * 10**6, settings.RECEIPT_IMAGE_MAX_BYTES + 2**20)

    # systemd

    def test_services_share_user_environment_file_and_virtualenv(self):
        for name in SERVICES:
            with self.subTest(name=name):
                service = unit(f"{name}.service")["Service"]
                self.assertEqual(service["User"], ["checkist"])
                self.assertEqual(service["EnvironmentFile"], [ENV_FILE])
                self.assertEqual(service["WorkingDirectory"], ["/opt/checkist/backend"])
                self.assertEqual(len(service["ExecStart"]), 1)
                self.assertTrue(service["ExecStart"][0].startswith(VENV_BIN), service["ExecStart"])

    def test_long_running_services_restart_and_start_at_boot(self):
        for name in SERVICES[:3]:
            with self.subTest(name=name):
                sections = unit(f"{name}.service")
                self.assertEqual(sections["Service"]["Restart"], ["on-failure"])
                self.assertEqual(sections["Install"]["WantedBy"], ["multi-user.target"])
                self.assertIn("postgresql.service", sections["Unit"]["After"][0].split())

    def test_web_service_runs_gunicorn_with_the_deploy_config(self):
        service = unit("checkist-web.service")["Service"]
        self.assertEqual(
            service["ExecStart"],
            [f"{VENV_BIN}gunicorn config.wsgi:application --config /opt/checkist/deploy/gunicorn.conf.py"],
        )
        self.assertEqual(settings.WSGI_APPLICATION, "config.wsgi.application")
        # The bind address comes from the config file only.
        self.assertNotRegex(service["ExecStart"][0], r"--bind|-b ")

    def test_recognition_worker_is_stopped_by_sigint(self):
        service = unit("checkist-recognition.service")["Service"]
        self.assertEqual(service["ExecStart"], [f"{VENV_BIN}python manage.py recognition_worker"])
        # The worker releases its job only on KeyboardInterrupt.
        self.assertEqual(service["KillSignal"], ["SIGINT"])
        self.assertEqual(service["KillMode"], ["mixed"])
        self.assertGreater(int(service["TimeoutStopSec"][0]), settings.RECEIPT_OCR_CANCEL_GRACE_SECONDS)
        # Codex CLI needs the home directory of the user and its own sandbox.
        for key in ("ProtectSystem", "ProtectHome", "InaccessiblePaths"):
            self.assertNotIn(key, service)

    def test_only_the_recognition_worker_can_read_the_codex_login(self):
        for name in ("checkist-web", "checkist-celery", "checkist-backup"):
            with self.subTest(name=name):
                service = unit(f"{name}.service")["Service"]
                self.assertEqual(service["InaccessiblePaths"], ["-/home/checkist/.codex"])
                self.assertEqual(service["NoNewPrivileges"], ["yes"])
                self.assertEqual(service["ProtectSystem"], ["strict"])
                # With ProtectSystem=strict a private /tmp is the only writable temporary directory.
                self.assertEqual(service["PrivateTmp"], ["yes"])
                self.assertNotIn("KillSignal", service)

    def test_writable_paths_match_the_environment(self):
        variables = env_example()
        web = unit("checkist-web.service")["Service"]["ReadWritePaths"]
        # Storage stages renames next to MEDIA, so the parent directory is writable as a whole.
        self.assertEqual(web, [str(PurePosixPath(variables["MEDIA_ROOT"]).parent)])
        self.assertNotIn("ReadWritePaths", unit("checkist-celery.service")["Service"])
        self.assertEqual(unit("checkist-backup.service")["Service"]["ReadWritePaths"], ["/var/backups/checkist"])

    def test_celery_service_matches_the_compose_worker(self):
        command = unit("checkist-celery.service")["Service"]["ExecStart"][0].split()
        self.assertEqual(command[:4], [f"{VENV_BIN}celery", "-A", "config", "worker"])
        self.assertIn("--pool=prefork", command)
        self.assertIn("--concurrency=1", command)
        self.assertIn("--hostname=checkist@worker", command)
        self.assertIn("--hostname=checkist@worker", (ROOT / "compose.yaml").read_text(encoding="utf-8"))

    def test_backup_service_and_timer(self):
        sections = unit("checkist-backup.service")
        service = sections["Service"]
        self.assertEqual(service["Type"], ["oneshot"])
        self.assertEqual(
            service["ExecStart"],
            [f"{VENV_BIN}python manage.py backup create --dir /var/backups/checkist --keep-days 14"],
        )
        self.assertEqual(service["UMask"], ["0077"])
        self.assertNotIn("Restart", service)
        # Started by the timer only.
        self.assertNotIn("Install", sections)
        timer = unit("checkist-backup.timer")
        self.assertEqual(timer["Timer"], {"OnCalendar": ["daily"], "Persistent": ["true"]})
        self.assertEqual(timer["Install"]["WantedBy"], ["timers.target"])

    # Environment sample

    def test_env_example_is_a_server_configuration(self):
        variables = env_example()
        expected = {
            AUTH_MODE: "accounts", "DJANGO_DEBUG": "0", "DJANGO_TRUST_PROXY": "1", "DJANGO_SECURE_COOKIES": "1",
            "DJANGO_ALLOWED_HOSTS": DOMAIN, "DJANGO_CSRF_TRUSTED_ORIGINS": f"https://{DOMAIN}",
            "ALLOW_LOCAL_RECOGNITION_API": "0", "PRODUCT_MERGE_AUTO_DETECT": "0",
            "PRODUCT_CLASSIFICATION_AUTO_SUGGEST": "0", "POSTGRES_HOST": "127.0.0.1",
            "RECEIPT_OCR_PROVIDER": "codex_cli",
        }
        self.assertEqual({name: variables[name] for name in expected}, expected)
        for name in SECRETS:
            with self.subTest(name=name):
                self.assertEqual(variables[name], "")
        for name in ("CELERY_BROKER_URL", "CELERY_RESULT_BACKEND", "DJANGO_CACHE_URL"):
            with self.subTest(name=name):
                self.assertTrue(variables[name].startswith("redis://127.0.0.1:"), variables[name])
        for name in ("MEDIA_ROOT", "RECEIPT_OCR_TEMP_ROOT", "DJANGO_STATIC_ROOT", "RECEIPT_OCR_CODEX_EXECUTABLE"):
            with self.subTest(name=name):
                self.assertTrue(variables[name].startswith("/"), variables[name])

    def test_env_example_is_a_plain_systemd_environment_file(self):
        for line in uncommented("checkist.env.example").splitlines():
            with self.subTest(line=line):
                self.assertRegex(line, r"^[A-Z][A-Z0-9_]*=[^\s\"'$`\\]*$")

    def test_env_example_names_only_variables_the_settings_read(self):
        source = (settings.BASE_DIR / "config" / "settings.py").read_text(encoding="utf-8")
        for name in env_example():
            with self.subTest(name=name):
                self.assertTrue(name == AUTH_MODE or f'"{name}"' in source)

    def load_settings(self, **overrides):
        with tempfile.TemporaryDirectory() as directory:
            # Server paths are POSIX; any absolute directories of this machine stand in for them.
            environment = {
                **os.environ, **env_example(),
                "MEDIA_ROOT": str(Path(directory) / "media"),
                "RECEIPT_OCR_TEMP_ROOT": str(Path(directory) / "ocr-scratch"),
                "DJANGO_STATIC_ROOT": str(Path(directory) / "static"),
                "DJANGO_SECRET_KEY": SERVER_KEY, "POSTGRES_PASSWORD": SERVER_PASSWORD, **overrides,
            }
            return subprocess.run(
                [sys.executable, "-X", "utf8", "-c",
                 "import json\n"
                 "from unittest.mock import patch\n"
                 "with patch('dotenv.load_dotenv'):\n"
                 "    import config.settings as s\n"
                 "print(json.dumps({name: getattr(s, name) for name in ('DEBUG', 'TRUST_PROXY', "
                 "'SECURE_SSL_REDIRECT', 'SESSION_COOKIE_SECURE', 'CSRF_COOKIE_SECURE', 'SECURE_HSTS_SECONDS', "
                 "'ALLOWED_HOSTS', 'CSRF_TRUSTED_ORIGINS', 'ALLOW_LOCAL_RECOGNITION_API')}))\n"],
                cwd=settings.BASE_DIR, env=environment, capture_output=True, text=True, encoding="utf-8",
                timeout=20,
            )

    def test_settings_load_from_the_env_example_once_secrets_are_filled(self):
        result = self.load_settings()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "DEBUG": False, "TRUST_PROXY": True, "SECURE_SSL_REDIRECT": True, "SESSION_COOKIE_SECURE": True,
            "CSRF_COOKIE_SECURE": True, "SECURE_HSTS_SECONDS": 3600, "ALLOWED_HOSTS": [DOMAIN],
            "CSRF_TRUSTED_ORIGINS": [f"https://{DOMAIN}"], "ALLOW_LOCAL_RECOGNITION_API": False,
        })

    def test_settings_refuse_the_env_example_with_an_empty_secret(self):
        for name in SECRETS:
            with self.subTest(name=name):
                result = self.load_settings(**{name: ""})
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(f"ImproperlyConfigured: {name}:", result.stderr)
                self.assertEqual(result.stdout, "")
