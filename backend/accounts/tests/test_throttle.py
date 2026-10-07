"""Счётчик неудачных входов и backend: пороги, окно, адрес клиента. HTTP — в ``api/tests/test_auth_api.py``."""
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import authenticate, get_user_model
from django.contrib.auth.backends import ModelBackend
from django.core.exceptions import PermissionDenied
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings, tag

from accounts import throttle
from accounts.backends import ThrottledModelBackend
from accounts.models import LoginFailure

USERNAME = "synthetic-reader"
PASSWORD = "Synthetic-pass-41"
WRONG = "Wrong-synthetic-00"
ADDRESS = "198.51.100.7"
OTHER_ADDRESS = "198.51.100.8"
T0 = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)


def fast_hashing():
    return override_settings(PASSWORD_HASHERS=["django.contrib.auth.hashers.MD5PasswordHasher"])


def request(address=ADDRESS, **extra):
    return RequestFactory().post("/api/auth/login/", REMOTE_ADDR=address, **extra)


def at(seconds=0):
    return patch("accounts.throttle.now", return_value=T0 + timedelta(seconds=seconds))


class AddressBucketTests(SimpleTestCase):
    def test_ipv4_is_kept_and_ipv6_is_reduced_to_its_64_network(self):
        cases = (
            ("198.51.100.7", "198.51.100.7"),
            ("127.0.0.1", "127.0.0.1"),
            ("2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"),
            ("2001:db8:1:2::1", "2001:db8:1:2::/64"),
            ("2001:0db8:0001:0002:ffff:ffff:ffff:ffff", "2001:db8:1:2::/64"),
            ("2001:db8:1:3::1", "2001:db8:1:3::/64"),
            ("::1", "::/64"),
            ("::ffff:198.51.100.7", "198.51.100.7"),
            ("", "unknown"),
            ("not-an-address", "unknown"),
        )
        for address, bucket in cases:
            with self.subTest(address=address):
                self.assertEqual(throttle.address_bucket(address), bucket)

    def test_keys_hide_the_login_and_ignore_its_case(self):
        keys = throttle.keys(request(), "Synthetic-Reader")
        self.assertEqual(keys, throttle.keys(request(), "SYNTHETIC-READER"))
        self.assertEqual(keys, throttle.keys(request(), USERNAME))
        self.assertNotEqual(keys.pair, throttle.keys(request(), "synthetic-other").pair)
        self.assertNotEqual(keys.pair, throttle.keys(request(OTHER_ADDRESS), USERNAME).pair)
        self.assertEqual(keys.address, f"a:{ADDRESS}")
        self.assertRegex(keys.pair, rf"^p:{ADDRESS}:[0-9a-f]{{64}}$")
        self.assertNotIn("synthetic", keys.pair.lower())

    def test_any_login_fits_the_key_column(self):
        longest = request("2001:db8:ffff:ffff:ffff:ffff:ffff:ffff")
        for username in ("x" * 5000, "a\x00b", "\ud800", "имя"):
            with self.subTest(username=repr(username[:10])):
                self.assertLessEqual(len(throttle.keys(longest, username).pair), 128)

    def test_address_comes_from_the_proxy_only_when_it_is_trusted(self):
        forwarded = {"HTTP_X_FORWARDED_FOR": "203.0.113.1, 203.0.113.9"}
        self.assertEqual(throttle.keys(request(**forwarded), USERNAME).address, f"a:{ADDRESS}")
        with override_settings(TRUST_PROXY=True):
            self.assertEqual(throttle.keys(request(**forwarded), USERNAME).address, "a:203.0.113.9")
            self.assertEqual(throttle.keys(request(), USERNAME).address, f"a:{ADDRESS}")
            ipv6 = {"HTTP_X_FORWARDED_FOR": "2001:db8:1:2:3:4:5:6"}
            self.assertEqual(throttle.keys(request(**ipv6), USERNAME).address, "a:2001:db8:1:2::/64")

    def test_defaults(self):
        self.assertEqual(settings.AUTH_LOGIN_FAILURE_LIMIT, 5)
        self.assertEqual(settings.AUTH_LOGIN_IP_FAILURE_LIMIT, 50)
        self.assertEqual(settings.AUTH_LOGIN_LOCK_SECONDS, 900)
        self.assertEqual(settings.AUTHENTICATION_BACKENDS, ["accounts.backends.ThrottledModelBackend"])


@tag("integration")
class ThrottleTests(TestCase):
    def setUp(self):
        self.keys = throttle.keys(request(), USERNAME)

    def fail(self, keys=None, times=1):
        for _attempt in range(times):
            throttle.record_failure(keys or self.keys)

    def counters(self):
        return dict(LoginFailure.objects.values_list("key", "failures"))

    def windows(self):
        return set(LoginFailure.objects.values_list("failures", "window_started_at"))

    def test_nothing_recorded_means_no_wait_and_one_query(self):
        with self.assertNumQueries(1):
            self.assertEqual(throttle.retry_after(self.keys), 0)

    def test_pair_is_refused_at_the_limit_until_the_window_ends(self):
        with at(0):
            self.fail(times=4)
            self.assertEqual(throttle.retry_after(self.keys), 0)
            self.fail()
            self.assertEqual(throttle.retry_after(self.keys), 900)
            self.assertEqual(self.counters(), {self.keys.pair: 5, self.keys.address: 5})
        with at(1):
            self.assertEqual(throttle.retry_after(self.keys), 899)
        with at(899.5):
            self.assertEqual(throttle.retry_after(self.keys), 1)
        with at(900):
            self.assertEqual(throttle.retry_after(self.keys), 0)

    def test_window_starts_at_the_first_failure(self):
        with at(0):
            self.fail(times=2)
        with at(600):
            self.fail(times=3)
            self.assertEqual(throttle.retry_after(self.keys), 300)
        self.assertEqual(self.windows(), {(5, T0)})

    def test_failure_after_the_window_starts_a_new_one(self):
        with at(0):
            self.fail(times=5)
        with at(900):
            self.fail()
            self.assertEqual(throttle.retry_after(self.keys), 0)
        self.assertEqual(self.windows(), {(1, T0 + timedelta(seconds=900))})

    def test_expired_rows_of_other_keys_are_removed_on_write(self):
        stale = throttle.keys(request(OTHER_ADDRESS), "synthetic-other")
        with at(0):
            self.fail(stale, times=2)
        with at(899):
            self.fail()
            self.assertEqual(LoginFailure.objects.count(), 4)
        with at(900):
            self.fail()
        self.assertEqual(self.counters(), {self.keys.pair: 2, self.keys.address: 2})

    def test_other_login_and_other_address_are_not_refused(self):
        with at(0):
            self.fail(times=5)
            self.assertEqual(throttle.retry_after(throttle.keys(request(), "synthetic-other")), 0)
            self.assertEqual(throttle.retry_after(throttle.keys(request(OTHER_ADDRESS), USERNAME)), 0)
            self.assertEqual(throttle.retry_after(throttle.keys(request(), USERNAME.upper())), 900)

    @override_settings(AUTH_LOGIN_IP_FAILURE_LIMIT=3)
    def test_address_limit_refuses_every_login_from_the_address(self):
        with at(0):
            for number in range(3):
                self.assertEqual(throttle.retry_after(self.keys), 0)
                self.fail(throttle.keys(request(), f"synthetic-{number}"))
            self.assertEqual(throttle.retry_after(self.keys), 900)
            self.assertEqual(throttle.retry_after(throttle.keys(request(), "synthetic-never-seen")), 900)
            self.assertEqual(throttle.retry_after(throttle.keys(request(OTHER_ADDRESS), USERNAME)), 0)

    @override_settings(AUTH_LOGIN_IP_FAILURE_LIMIT=3)
    def test_ipv6_addresses_of_one_64_network_share_the_counters(self):
        with at(0):
            for number in range(3):
                self.fail(throttle.keys(request(f"2001:db8:1:2::{number + 1}"), f"synthetic-{number}"))
            self.assertEqual(throttle.retry_after(throttle.keys(request("2001:db8:1:2:ffff::9"), USERNAME)), 900)
            self.assertEqual(throttle.retry_after(throttle.keys(request("2001:db8:1:3::1"), USERNAME)), 0)

    @override_settings(AUTH_LOGIN_IP_FAILURE_LIMIT=2, AUTH_LOGIN_FAILURE_LIMIT=1)
    def test_longest_wait_of_the_two_keys_wins(self):
        with at(0):
            self.fail(throttle.keys(request(), "synthetic-other"))
        with at(100):
            self.fail()
            # Пара закрыта до 1000-й секунды, адрес (окно с нуля) — до 900-й.
            self.assertEqual(throttle.retry_after(self.keys), 900)
        with at(950):
            self.assertEqual(throttle.retry_after(self.keys), 50)

    def test_reset_clears_the_pair_and_keeps_the_address(self):
        with at(0):
            self.fail(times=5)
            throttle.reset(self.keys)
            self.assertEqual(self.counters(), {self.keys.address: 5})
            self.assertEqual(throttle.retry_after(self.keys), 0)

    @override_settings(AUTH_LOGIN_FAILURE_LIMIT=2, AUTH_LOGIN_LOCK_SECONDS=60)
    def test_limits_and_window_come_from_settings(self):
        with at(0):
            self.fail(times=2)
            self.assertEqual(throttle.retry_after(self.keys), 60)
        with at(60):
            self.assertEqual(throttle.retry_after(self.keys), 0)


@tag("integration")
@fast_hashing()
class ThrottledBackendTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.account = get_user_model().objects.create_user(USERNAME, password=PASSWORD)
        cls.disabled = get_user_model().objects.create_user("synthetic-disabled", password=PASSWORD, is_active=False)

    def attempt(self, password=PASSWORD, username=USERNAME, address=ADDRESS):
        attempt_request = request(address)
        return authenticate(attempt_request, username=username, password=password), attempt_request

    def test_success_and_failure_through_django_authenticate(self):
        account, attempt_request = self.attempt()
        self.assertEqual(account, self.account)
        self.assertEqual(account.backend, "accounts.backends.ThrottledModelBackend")
        self.assertFalse(hasattr(attempt_request, "login_retry_after"))
        self.assertFalse(LoginFailure.objects.exists())
        account, attempt_request = self.attempt(WRONG)
        self.assertIsNone(account)
        self.assertFalse(hasattr(attempt_request, "login_retry_after"))
        self.assertEqual(LoginFailure.objects.count(), 2)

    def test_refused_attempt_does_not_check_the_password(self):
        with at(0):
            for _attempt in range(5):
                self.assertIsNone(self.attempt(WRONG)[0])
            with patch.object(ModelBackend, "authenticate") as check, self.assertNumQueries(1):
                account, attempt_request = self.attempt()
            check.assert_not_called()
            self.assertIsNone(account)
            self.assertEqual(attempt_request.login_retry_after, 900)
            with self.assertRaises(PermissionDenied):
                ThrottledModelBackend().authenticate(request(), username=USERNAME, password=PASSWORD)
        # Отказанные попытки не считаются.
        self.assertEqual(set(LoginFailure.objects.values_list("failures", flat=True)), {5})

    def test_unknown_wrong_and_disabled_count_the_same(self):
        cases = (("synthetic-missing", PASSWORD), (USERNAME, WRONG), ("synthetic-disabled", PASSWORD))
        for username, password in cases:
            with self.subTest(username=username):
                LoginFailure.objects.all().delete()
                for _attempt in range(5):
                    account, attempt_request = self.attempt(password, username)
                    self.assertIsNone(account)
                    self.assertFalse(hasattr(attempt_request, "login_retry_after"))
                account, attempt_request = self.attempt(password, username)
                self.assertIsNone(account)
                self.assertGreater(attempt_request.login_retry_after, 0)

    def test_success_resets_the_pair(self):
        for _attempt in range(4):
            self.attempt(WRONG)
        self.assertEqual(self.attempt()[0], self.account)
        self.assertEqual(
            dict(LoginFailure.objects.values_list("key", "failures")),
            {throttle.keys(request(), USERNAME).address: 4},
        )

    def test_other_address_signs_in_while_the_first_is_refused(self):
        for _attempt in range(5):
            self.attempt(WRONG)
        self.assertIsNone(self.attempt()[0])
        self.assertEqual(self.attempt(address=OTHER_ADDRESS)[0], self.account)

    def test_without_request_nothing_is_counted_or_refused(self):
        for _attempt in range(7):
            self.assertIsNone(authenticate(username=USERNAME, password=WRONG))
        self.assertFalse(LoginFailure.objects.exists())
        self.assertEqual(authenticate(username=USERNAME, password=PASSWORD), self.account)
        self.assertTrue(self.client.login(username=USERNAME, password=PASSWORD))

    def test_missing_credentials_are_not_counted(self):
        backend = ThrottledModelBackend()
        self.assertIsNone(backend.authenticate(request(), username=USERNAME, password=None))
        self.assertIsNone(backend.authenticate(request(), username=None, password=PASSWORD))
        self.assertFalse(LoginFailure.objects.exists())

    def test_force_login_uses_the_backend(self):
        self.client.force_login(self.account)
        self.assertEqual(self.client.session["_auth_user_backend"], "accounts.backends.ThrottledModelBackend")
