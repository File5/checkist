import os
import subprocess
import sys
from unittest.mock import patch

from django.conf import settings
from django.test import SimpleTestCase, override_settings

from accounts import access
from config.test_runner import Runner

NAME = "CHECKIST_AUTH_MODE"
# Fictional key: DEBUG=0 refuses the development placeholder.
SERVER_KEY = "test-only-9f3b7c1e5a2d8046bd17c93e60fa4852-Qx7Lm2Zr8Vt5Hn"


class AuthModeSettingsTests(SimpleTestCase):
    def load(self, **overrides):
        environment = os.environ.copy()
        for name in (NAME, "DJANGO_DEBUG", "DJANGO_SECRET_KEY"):
            environment.pop(name, None)
        environment.update(overrides)
        # The process environment and the defaults, independently of any local root .env.
        return subprocess.run(
            [sys.executable, "-X", "utf8", "-c",
             "from unittest.mock import patch\n"
             "with patch('dotenv.load_dotenv'):\n"
             "    import config.settings as s\n"
             f"    print(s.{NAME}, s.DEBUG)\n"],
            cwd=settings.BASE_DIR, env=environment, capture_output=True, text=True, encoding="utf-8", timeout=20,
        )

    def assert_loaded(self, expected, **overrides):
        result = self.load(**overrides)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), expected)

    def assert_rejected(self, message, **overrides):
        result = self.load(**overrides)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"ImproperlyConfigured: {NAME}: {message}", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_default_is_accounts(self):
        self.assert_loaded(["accounts", "True"])
        self.assert_loaded(["accounts", "False"], DJANGO_DEBUG="0", DJANGO_SECRET_KEY=SERVER_KEY)

    def test_both_modes_are_accepted_with_debug(self):
        for value in ("accounts", "local_single"):
            with self.subTest(value=value):
                self.assert_loaded([value, "True"], **{NAME: value})
                self.assert_loaded([value, "True"], **{NAME: value, "DJANGO_DEBUG": "true"})

    def test_accounts_is_accepted_without_debug(self):
        self.assert_loaded(
            ["accounts", "False"], **{NAME: "accounts", "DJANGO_DEBUG": "0", "DJANGO_SECRET_KEY": SERVER_KEY},
        )

    def test_unknown_value_is_rejected_at_settings_load(self):
        for value in ("", "local", "single", "Accounts", "LOCAL_SINGLE", "accounts ", "0", "1", "local-single"):
            with self.subTest(value=value):
                self.assert_rejected("expected", **{NAME: value})

    def test_local_single_without_debug_is_rejected_at_settings_load(self):
        for debug in ("0", "false", "FALSE"):
            with self.subTest(debug=debug):
                self.assert_rejected(
                    "local_single requires DJANGO_DEBUG=1.",
                    **{NAME: "local_single", "DJANGO_DEBUG": debug, "DJANGO_SECRET_KEY": SERVER_KEY},
                )

    def test_mode_is_refused_before_the_development_key(self):
        # One message names the cause: the mode, not the key that a local .env also carries.
        result = self.load(**{NAME: "local_single", "DJANGO_DEBUG": "0"})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"ImproperlyConfigured: {NAME}:", result.stderr)
        self.assertNotIn("DJANGO_SECRET_KEY:", result.stderr)

    def test_application_is_installed(self):
        self.assertIn("accounts.apps.AccountsConfig", settings.INSTALLED_APPS)

    def test_env_example_sets_local_single_next_to_the_local_api_flag(self):
        lines = (settings.BASE_DIR.parent / ".env.example").read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines.count(f"{NAME}=local_single"), 1)
        self.assertEqual([line for line in lines if line.startswith(NAME)], [f"{NAME}=local_single"])
        flag, mode = lines.index("ALLOW_LOCAL_RECOGNITION_API=0"), lines.index(f"{NAME}=local_single")
        between = lines[flag + 1:mode]
        self.assertLess(flag, mode)
        self.assertTrue(all(line.startswith("#") for line in between), between)

    def test_runner_runs_the_tests_in_local_single(self):
        self.assertEqual(settings.CHECKIST_AUTH_MODE, "local_single")
        self.assertEqual(access.mode(), "local_single")

    def test_mode_follows_override_settings(self):
        with override_settings(CHECKIST_AUTH_MODE="accounts"):
            self.assertEqual(access.mode(), "accounts")
        self.assertEqual(access.mode(), "local_single")

    def test_runner_sets_the_mode_and_restores_it(self):
        runner = Runner.__new__(Runner)
        with override_settings(CHECKIST_AUTH_MODE="accounts"), \
                patch("django.test.runner.DiscoverRunner.setup_test_environment") as setup, \
                patch("django.test.runner.DiscoverRunner.teardown_test_environment") as teardown:
            runner.setup_test_environment()
            self.assertEqual(settings.CHECKIST_AUTH_MODE, "local_single")
            runner.teardown_test_environment()
            self.assertEqual(settings.CHECKIST_AUTH_MODE, "accounts")
        setup.assert_called_once_with()
        teardown.assert_called_once_with()
