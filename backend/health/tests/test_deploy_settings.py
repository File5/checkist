import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from django.conf import settings
from django.test import SimpleTestCase

NAMES = (
    "DJANGO_DEBUG", "DJANGO_SECRET_KEY", "DJANGO_ALLOWED_HOSTS", "DJANGO_CSRF_TRUSTED_ORIGINS",
    "DJANGO_TRUST_PROXY", "DJANGO_SECURE_COOKIES", "DJANGO_HSTS_SECONDS", "DJANGO_STATIC_ROOT",
)
REPORTED = (
    "DEBUG", "TRUST_PROXY", "SECURE_PROXY_SSL_HEADER", "SECURE_SSL_REDIRECT", "SESSION_COOKIE_SECURE",
    "CSRF_COOKIE_SECURE", "SESSION_COOKIE_HTTPONLY", "SESSION_COOKIE_SAMESITE", "CSRF_COOKIE_SAMESITE",
    "SECURE_HSTS_SECONDS", "SECURE_HSTS_INCLUDE_SUBDOMAINS", "SECURE_HSTS_PRELOAD", "STATIC_ROOT", "STATIC_URL",
    "CSRF_TRUSTED_ORIGINS",
)
# Fictional key: 50+ characters, so `check --deploy` does not report security.W009.
SERVER_KEY = "test-only-9f3b7c1e5a2d8046bd17c93e60fa4852-Qx7Lm2Zr8Vt5Hn"
# The auth mode is not read yet. Once it is, a QA environment carries `local_single`,
# which is refused with DEBUG=0: the server configurations name the server mode themselves.
SERVER = {"DJANGO_DEBUG": "0", "DJANGO_SECRET_KEY": SERVER_KEY, "CHECKIST_AUTH_MODE": "accounts"}
LOCAL_DEFAULTS = {
    "DEBUG": True, "TRUST_PROXY": False, "SECURE_PROXY_SSL_HEADER": None, "SECURE_SSL_REDIRECT": False,
    "SESSION_COOKIE_SECURE": False, "CSRF_COOKIE_SECURE": False, "SESSION_COOKIE_HTTPONLY": True,
    "SESSION_COOKIE_SAMESITE": "Lax", "CSRF_COOKIE_SAMESITE": "Lax", "SECURE_HSTS_SECONDS": 0,
    "SECURE_HSTS_INCLUDE_SUBDOMAINS": False, "SECURE_HSTS_PRELOAD": False, "STATIC_URL": "static/",
    "CSRF_TRUSTED_ORIGINS": [],
}


def environment(overrides):
    # The process environment and the defaults, independently of any local root .env.
    result = os.environ.copy()
    for name in NAMES:
        result.pop(name, None)
    result.update(overrides)
    return result


def load(**overrides):
    return subprocess.run(
        [sys.executable, "-X", "utf8", "-c",
         "import json\n"
         "from unittest.mock import patch\n"
         "with patch('dotenv.load_dotenv'):\n"
         "    import config.settings as s\n"
         f"print(json.dumps({{name: getattr(s, name) for name in {REPORTED!r}}}, default=str))\n"],
        cwd=settings.BASE_DIR, env=environment(overrides), capture_output=True, text=True, encoding="utf-8",
        timeout=20,
    )


class LoadMixin:
    def loaded(self, **overrides):
        result = load(**overrides)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def assert_rejected(self, name, **overrides):
        result = load(**overrides)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"ImproperlyConfigured: {name}:", result.stderr)
        self.assertEqual(result.stdout, "")


class CsrfOriginTests(LoadMixin, SimpleTestCase):
    HOSTS = "checkist.example,127.0.0.1,localhost"

    def origins(self, value, hosts=HOSTS):
        return self.loaded(DJANGO_ALLOWED_HOSTS=hosts, DJANGO_CSRF_TRUSTED_ORIGINS=value)["CSRF_TRUSTED_ORIGINS"]

    def test_empty_by_default(self):
        self.assertEqual(self.loaded()["CSRF_TRUSTED_ORIGINS"], [])

    def test_https_origin_of_an_allowed_host_is_accepted(self):
        self.assertEqual(self.origins("https://checkist.example"), ["https://checkist.example"])

    def test_local_origins_with_ports_are_accepted_as_before(self):
        value = "http://127.0.0.1:5173,http://localhost:15173, https://localhost:8443 ,http://[::1]:5173"
        self.assertEqual(self.origins(value, hosts="127.0.0.1,localhost"), [
            "http://127.0.0.1:5173", "http://localhost:15173", "https://localhost:8443", "http://[::1]:5173",
        ])

    def test_server_and_local_origins_together(self):
        self.assertEqual(
            self.origins("https://checkist.example,http://127.0.0.1:5173"),
            ["https://checkist.example", "http://127.0.0.1:5173"],
        )

    def test_host_comparison_ignores_the_case_of_allowed_hosts(self):
        self.assertEqual(
            self.origins("https://checkist.example", hosts="Checkist.Example"), ["https://checkist.example"],
        )

    def test_other_origins_are_rejected(self):
        for value in (
            "http://checkist.example",
            "https://other.example",
            "https://sub.checkist.example",
            "https://checkist.example:443",
            "https://checkist.example:8443",
            "https://checkist.example/",
            "https://checkist.example/app",
            "https://checkist.example?next=1",
            "https://checkist.example#top",
            "https://*.checkist.example",
            "https://*",
            "*",
            "https://user:password-secret@checkist.example",
            "https://user@checkist.example",
            "https://Checkist.Example",
            "checkist.example",
            "//checkist.example",
            "ftp://checkist.example",
            "https://checkist.example,https://other.example",
            "https://checkist.example,",
            # Loopback stays a local origin: the port is required, the short form is not accepted.
            "http://127.0.0.1",
            "http://localhost",
            "https://localhost",
            "https://127.0.0.1",
            "http://localhost:5173/path",
            "http://external.test:5173",
        ):
            with self.subTest(value=value):
                result = load(DJANGO_ALLOWED_HOSTS=self.HOSTS, DJANGO_CSRF_TRUSTED_ORIGINS=value)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("ImproperlyConfigured: DJANGO_CSRF_TRUSTED_ORIGINS: expected", result.stderr)
                self.assertNotIn("password-secret", result.stderr)

    def test_host_outside_allowed_hosts_is_rejected(self):
        self.assert_rejected(
            "DJANGO_CSRF_TRUSTED_ORIGINS",
            DJANGO_ALLOWED_HOSTS="127.0.0.1,localhost", DJANGO_CSRF_TRUSTED_ORIGINS="https://checkist.example",
        )


class SecureDefaultsTests(LoadMixin, SimpleTestCase):
    def test_local_defaults(self):
        values = self.loaded()
        static_root = Path(values.pop("STATIC_ROOT"))
        self.assertEqual(values, LOCAL_DEFAULTS)
        self.assertEqual(static_root, (settings.BASE_DIR.parent / "staticfiles").resolve())

    def test_explicit_debug_keeps_local_defaults(self):
        values = self.loaded(DJANGO_DEBUG="1")
        values.pop("STATIC_ROOT")
        self.assertEqual(values, LOCAL_DEFAULTS)

    def test_server_defaults(self):
        values = self.loaded(**SERVER)
        values.pop("STATIC_ROOT")
        self.assertEqual(values, {
            **LOCAL_DEFAULTS, "DEBUG": False, "SESSION_COOKIE_SECURE": True, "CSRF_COOKIE_SECURE": True,
            "SECURE_HSTS_SECONDS": 3600,
        })

    def test_trust_proxy(self):
        for mode, value, trusted in (
            ({}, "1", True), ({}, "TRUE", True), ({}, "0", False), ({}, "false", False), (SERVER, "1", True),
        ):
            with self.subTest(server=bool(mode), value=value):
                values = self.loaded(DJANGO_TRUST_PROXY=value, **mode)
                self.assertIs(values["TRUST_PROXY"], trusted)
                self.assertIs(values["SECURE_SSL_REDIRECT"], trusted)
                self.assertEqual(
                    values["SECURE_PROXY_SSL_HEADER"], ["HTTP_X_FORWARDED_PROTO", "https"] if trusted else None,
                )

    def test_secure_cookies_override_the_debug_default(self):
        for mode, value, expected in (({}, "1", True), ({}, "0", False), (SERVER, "0", False), (SERVER, "true", True)):
            with self.subTest(server=bool(mode), value=value):
                values = self.loaded(DJANGO_SECURE_COOKIES=value, **mode)
                self.assertIs(values["SESSION_COOKIE_SECURE"], expected)
                self.assertIs(values["CSRF_COOKIE_SECURE"], expected)

    def test_hsts_seconds_boundaries(self):
        for mode, value in (({}, "0"), ({}, "63072000"), (SERVER, "0"), (SERVER, "31536000")):
            with self.subTest(server=bool(mode), value=value):
                values = self.loaded(DJANGO_HSTS_SECONDS=value, **mode)
                self.assertEqual(values["SECURE_HSTS_SECONDS"], int(value))
                self.assertIs(values["SECURE_HSTS_INCLUDE_SUBDOMAINS"], False)
                self.assertIs(values["SECURE_HSTS_PRELOAD"], False)

    def test_static_root_from_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            values = self.loaded(DJANGO_STATIC_ROOT=directory)
            self.assertEqual(Path(values["STATIC_ROOT"]), Path(directory).resolve())

    def test_invalid_values_are_rejected_at_settings_load(self):
        cases = (
            ("DJANGO_TRUST_PROXY", ("maybe", "2", "yes", "")),
            ("DJANGO_SECURE_COOKIES", ("maybe", "2", "on", "")),
            ("DJANGO_HSTS_SECONDS", ("-1", "63072001", "1.5", "year", "")),
            ("DJANGO_STATIC_ROOT", ("staticfiles", "./staticfiles", "")),
        )
        for name, values in cases:
            for value in values:
                with self.subTest(name=name, value=value):
                    self.assert_rejected(name, **{name: value})

    def test_server_settings_add_no_required_variable(self):
        # DEBUG=0 with its own key still starts without any of the new variables.
        result = load(**SERVER)
        self.assertEqual(result.returncode, 0, result.stderr)


class DeployCheckTests(SimpleTestCase):
    # HSTS deliberately covers neither subdomains nor preload: the domain may have foreign subdomains.
    EXPECTED = {"security.W005", "security.W021"}

    def check(self, **overrides):
        return subprocess.run(
            [sys.executable, "-X", "utf8", "-c",
             "from unittest.mock import patch\n"
             "from django.core.management import execute_from_command_line\n"
             "with patch('dotenv.load_dotenv'):\n"
             "    execute_from_command_line(['manage.py', 'check', '--deploy'])\n"],
            cwd=settings.BASE_DIR,
            env=environment({"DJANGO_SETTINGS_MODULE": "config.settings", **overrides}),
            capture_output=True, text=True, encoding="utf-8", timeout=60,
        )

    @staticmethod
    def issues(result):
        return set(re.findall(r"\(([a-z_]+\.[A-Z][0-9]{3})\)", result.stdout + result.stderr))

    def test_server_configuration_passes_with_the_listed_warnings(self):
        result = self.check(
            **SERVER, DJANGO_ALLOWED_HOSTS="checkist.example", DJANGO_CSRF_TRUSTED_ORIGINS="https://checkist.example",
            DJANGO_TRUST_PROXY="1",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.issues(result), self.EXPECTED, result.stderr)

    def test_server_configuration_without_proxy_trust_reports_the_missing_redirect(self):
        result = self.check(**SERVER, DJANGO_ALLOWED_HOSTS="checkist.example")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.issues(result), self.EXPECTED | {"security.W008"}, result.stderr)


class EnvExampleTests(SimpleTestCase):
    NEW = ("DJANGO_TRUST_PROXY", "DJANGO_SECURE_COOKIES", "DJANGO_HSTS_SECONDS", "DJANGO_STATIC_ROOT")

    def setUp(self):
        self.text = (settings.BASE_DIR.parent / ".env.example").read_text(encoding="utf-8")

    def test_server_variables_are_listed_commented_out(self):
        for name in self.NEW:
            with self.subTest(name=name):
                self.assertEqual(len(re.findall(rf"^# {name}=\S+$", self.text, flags=re.MULTILINE)), 1)
                self.assertIsNone(re.search(rf"^\s*{name}\s*=", self.text, flags=re.MULTILINE))

    def test_server_block_is_the_end_of_the_file(self):
        last_active = max(
            self.text.index(line) for line in self.text.splitlines() if line and not line.startswith("#")
        )
        for name in self.NEW:
            with self.subTest(name=name):
                self.assertGreater(self.text.index(f"# {name}="), last_active)

    def test_sample_stays_a_local_configuration(self):
        self.assertIn("\nDJANGO_DEBUG=1\n", self.text)
        self.assertIn("\nDJANGO_ALLOWED_HOSTS=127.0.0.1,localhost\n", self.text)
        origins = re.findall(r"^DJANGO_CSRF_TRUSTED_ORIGINS=(.*)$", self.text, flags=re.MULTILINE)
        self.assertEqual(origins, [
            "http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:15173,http://localhost:15173",
        ])

    def test_collected_static_is_ignored_by_git(self):
        lines = (settings.BASE_DIR.parent / ".gitignore").read_text(encoding="utf-8").splitlines()
        self.assertIn("staticfiles/", lines)
