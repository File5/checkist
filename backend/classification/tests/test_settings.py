import os
import subprocess
import sys

from django.conf import settings
from django.test import SimpleTestCase

NAMES = (
    "PRODUCT_CLASSIFICATION_AUTO_SUGGEST", "PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS",
    "PRODUCT_CLASSIFICATION_BATCH_SIZE", "PRODUCT_CLASSIFICATION_RUN_LIMIT",
)


class ClassificationSettingsTests(SimpleTestCase):
    def load(self, **overrides):
        environment = os.environ.copy()
        for name in NAMES:
            environment.pop(name, None)
        environment.update(overrides)
        # The process environment and the defaults, independently of any local root .env.
        return subprocess.run(
            [sys.executable, "-X", "utf8", "-c",
             "from unittest.mock import patch\n"
             "with patch('dotenv.load_dotenv'):\n"
             "    import config.settings as s\n"
             f"    print(*[getattr(s, name) for name in {NAMES!r}])\n"],
            cwd=settings.BASE_DIR, env=environment, capture_output=True, text=True, encoding="utf-8", timeout=20,
        )

    def test_defaults(self):
        result = self.load()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ["False", "180", "25", "200"])

    def test_boundaries_are_accepted(self):
        for overrides, expected in (
            ({"PRODUCT_CLASSIFICATION_AUTO_SUGGEST": "1", "PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS": "1",
              "PRODUCT_CLASSIFICATION_BATCH_SIZE": "1", "PRODUCT_CLASSIFICATION_RUN_LIMIT": "1"},
             ["True", "1", "1", "1"]),
            ({"PRODUCT_CLASSIFICATION_AUTO_SUGGEST": "TRUE", "PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS": "2400",
              "PRODUCT_CLASSIFICATION_BATCH_SIZE": "50", "PRODUCT_CLASSIFICATION_RUN_LIMIT": "1000"},
             ["True", "2400", "50", "1000"]),
            ({"PRODUCT_CLASSIFICATION_AUTO_SUGGEST": "false"}, ["False", "180", "25", "200"]),
        ):
            with self.subTest(overrides=overrides):
                result = self.load(**overrides)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.split(), expected)

    def test_values_outside_the_bounds_are_rejected_at_settings_load(self):
        cases = (
            ("PRODUCT_CLASSIFICATION_AUTO_SUGGEST", ("maybe", "2", "yes", "")),
            ("PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS", ("0", "2401", "-1", "1.5", "soon")),
            ("PRODUCT_CLASSIFICATION_BATCH_SIZE", ("0", "51", "ten")),
            ("PRODUCT_CLASSIFICATION_RUN_LIMIT", ("0", "1001", "-5")),
        )
        for name, values in cases:
            for value in values:
                with self.subTest(name=name, value=value):
                    result = self.load(**{name: value})
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(f"ImproperlyConfigured: {name}: expected", result.stderr)
                    self.assertEqual(result.stdout, "")

    def test_application_is_installed_between_merges_and_api(self):
        apps = settings.INSTALLED_APPS
        position = apps.index("classification.apps.ClassificationConfig")
        self.assertEqual(apps[position - 1], "merges.apps.MergesConfig")
        self.assertEqual(apps[position + 1], "api.apps.ApiConfig")

    def test_env_example_lists_the_settings_with_safe_defaults(self):
        text = (settings.BASE_DIR.parent / ".env.example").read_text(encoding="utf-8")
        for line in ("PRODUCT_CLASSIFICATION_AUTO_SUGGEST=0", "PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS=180",
                     "PRODUCT_CLASSIFICATION_BATCH_SIZE=25", "PRODUCT_CLASSIFICATION_RUN_LIMIT=200"):
            with self.subTest(line=line):
                self.assertIn(f"\n{line}\n", text)
        # The fake scenario is a server-only switch and stays out of the sample.
        self.assertNotIn("PRODUCT_CLASSIFICATION_FAKE_SCENARIO", text)
        self.assertLess(text.index("PRODUCT_MERGE_AUTO_DETECT=0"), text.index("PRODUCT_CLASSIFICATION_AUTO_SUGGEST=0"))
