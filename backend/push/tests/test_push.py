"""Web push: отправка без повторов и с тишиной, поводы тика, ``/api/push/``.

Сеть не трогается: ``webpush`` подменён (кроме одной проверки шифрования, где подменён сам POST).
Время — фиксированное ``now``; данные вымышленные.
"""
import base64
import json
import os
from datetime import date, datetime
from decimal import Decimal
from io import StringIO
from unittest import mock
from zoneinfo import ZoneInfo

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from django.core.management import call_command
from django.test import SimpleTestCase, TestCase, override_settings, tag
from pywebpush import WebPushException

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_AUTHENTICATED, accounts_mode, make_user, signed_in
from budget.models import BudgetLimit
from catalog.models import Category
from push import reasons, services
from push.models import PushNotification, PushSettings, PushSubscription
from receipts import manual
from receipts.models import Receipt
from recurring.models import RecurringPayment

ALMATY = ZoneInfo("Asia/Almaty")
D = Decimal
ENDPOINT = "https://fcm.googleapis.com/fcm/send/synthetic-device"
KEYS = {"p256dh": "BSyntheticPublicKeyOfTheBrowser", "auth": "SyntheticAuth"}


def at(*args):
    return datetime(*args, tzinfo=ALMATY)


def b64(data):
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def vapid_keys():
    out = StringIO()
    call_command("push", "keys", stdout=out)
    return dict(line.split("=", 1) for line in out.getvalue().splitlines() if line.startswith("WEBPUSH_VAPID_"))


VAPID = vapid_keys()
CONFIGURED = override_settings(WEBPUSH_VAPID_PUBLIC_KEY=VAPID["WEBPUSH_VAPID_PUBLIC_KEY"],
                               WEBPUSH_VAPID_PRIVATE_KEY=VAPID["WEBPUSH_VAPID_PRIVATE_KEY"],
                               WEBPUSH_VAPID_SUBJECT="mailto:push-test@example.invalid")


def device(user, endpoint=ENDPOINT):
    return PushSubscription.objects.create(user=user, endpoint=endpoint, **KEYS)


def spend(owner, category, total, on, currency="KZT", store=None):
    body = {"total": str(total), "currency": currency, "category": category.pk, "purchased_on": on.isoformat()}
    if store:
        body["store_name"] = store
    return manual.create(owner, body)


def sent(webpush):
    """Уведомления, переданные ``webpush``: ``[{"title", "body", "url"}]``."""
    return [json.loads(call.kwargs["data"]) for call in webpush.call_args_list]


class FormatTests(SimpleTestCase):
    def test_quiet_hours_hold_until_nine(self):
        self.assertEqual(services.release_at(at(2026, 10, 12, 21, 59)), at(2026, 10, 12, 21, 59))
        self.assertEqual(services.release_at(at(2026, 10, 12, 9, 0)), at(2026, 10, 12, 9, 0))
        self.assertEqual(services.release_at(at(2026, 10, 12, 22, 0)), at(2026, 10, 13, 9, 0))
        self.assertEqual(services.release_at(at(2026, 10, 13, 3, 30)), at(2026, 10, 13, 9, 0))
        # Время сервера — UTC: 17:00 UTC — уже 22:00 в Алматы.
        self.assertEqual(services.release_at(datetime(2026, 10, 12, 17, tzinfo=ZoneInfo("UTC"))), at(2026, 10, 13, 9))

    def test_money_is_whole_rounded_up_with_a_sign(self):
        self.assertEqual(services.money(D("9821.47"), "KZT"), "9 822 ₸")
        self.assertEqual(services.money(D("-0.40"), "USD"), "-1 $")
        self.assertEqual(services.money(D("100000"), "UZS"), "100 000 UZS")


@tag("integration")
@CONFIGURED
@mock.patch("push.services.webpush")
class NotifyTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = make_user("synthetic-push-user")
        device(cls.user)

    def test_sends_once_per_key(self, webpush):
        now = at(2026, 10, 12, 12)
        self.assertIsNotNone(services.notify(self.user, "weekly", "Траты", "Текст", "/stats", "week:1", now=now))
        self.assertIsNone(services.notify(self.user, "weekly", "Траты", "Текст", "/stats", "week:1", now=now))
        self.assertEqual(sent(webpush), [{"title": "Траты", "body": "Текст", "url": "/stats"}])
        call = webpush.call_args.kwargs
        self.assertEqual(call["subscription_info"], {"endpoint": ENDPOINT, "keys": KEYS})
        self.assertEqual(call["vapid_claims"], {"sub": "mailto:push-test@example.invalid"})
        self.assertEqual(PushNotification.objects.get().sent_at, now)

    def test_quiet_hours_defer_to_nine_and_flush_sends(self, webpush):
        services.notify(self.user, "weekly", "Траты", "Текст", "/stats", "week:1", now=at(2026, 10, 11, 23))
        webpush.assert_not_called()
        self.assertEqual(services.flush(at(2026, 10, 12, 8, 59)), 0)
        self.assertEqual(services.flush(at(2026, 10, 12, 9, 0)), 1)
        self.assertEqual(services.flush(at(2026, 10, 12, 9, 5)), 0)
        self.assertEqual(len(sent(webpush)), 1)

    def test_switched_off_kind_and_large_by_default_send_nothing(self, webpush):
        now = at(2026, 10, 12, 12)
        self.assertIsNone(services.notify(self.user, "large", "Крупная", "Текст", "/", "receipt:1", now=now))
        PushSettings.objects.create(user=self.user, weekly=False)
        self.assertIsNone(services.notify(self.user, "weekly", "Траты", "Текст", "/", "week:1", now=now))
        webpush.assert_not_called()
        self.assertFalse(PushNotification.objects.exists())

    def test_nobody_without_devices_and_nothing_without_keys(self, webpush):
        now = at(2026, 10, 12, 12)
        other = make_user("synthetic-push-nodevice")
        self.assertIsNone(services.notify(other, "weekly", "Т", "Т", "/", "k", now=now))
        with override_settings(WEBPUSH_VAPID_PRIVATE_KEY=""):
            self.assertIsNone(services.notify(self.user, "weekly", "Т", "Т", "/", "k", now=now))
        webpush.assert_not_called()

    def test_gone_device_is_removed_other_failures_keep_it(self, webpush):
        second = device(self.user, ENDPOINT + "-2")
        webpush.side_effect = [WebPushException("gone", response=mock.Mock(status_code=410)),
                               WebPushException("busy", response=mock.Mock(status_code=503))]
        with self.assertLogs("push.services", "WARNING") as logs:
            self.assertEqual(services.send(self.user, "Т", "Т", "/"), 0)
        self.assertEqual(logs.output, ["WARNING:push.services:push: fcm.googleapis.com answered 503"])
        self.assertEqual(list(PushSubscription.objects.filter(user=self.user)), [second])


@tag("integration")
@CONFIGURED
class EncryptionTests(TestCase):
    def test_real_encryption_and_vapid_signature_without_network(self):
        """Ключи ``push keys`` подходят ``pywebpush``: шифрование и подпись настоящие, POST подменён."""
        browser = ec.generate_private_key(ec.SECP256R1()).public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        user = make_user("synthetic-push-crypto")
        PushSubscription.objects.create(user=user, endpoint=ENDPOINT, p256dh=b64(browser), auth=b64(os.urandom(16)))
        with mock.patch("requests.post", return_value=mock.Mock(status_code=201)) as post:
            self.assertEqual(services.send(user, "Проверка", "Текст", "/account"), 1)
        headers = post.call_args.kwargs["headers"]
        self.assertTrue(headers["Authorization"].startswith("vapid t="))
        self.assertIn(f"k={VAPID['WEBPUSH_VAPID_PUBLIC_KEY']}", headers["Authorization"])
        self.assertEqual(headers["content-encoding"], "aes128gcm")
        self.assertEqual(post.call_args.args[0], ENDPOINT)


@tag("integration")
@CONFIGURED
@accounts_mode()
@mock.patch("push.services.webpush")
class ReasonTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.family = Household.objects.create(name="Синтетическая семья")
        cls.user = make_user("synthetic-push-head", first_name="Андрей")
        cls.other = make_user("synthetic-push-member", first_name="Лиза")
        Membership.objects.create(user=cls.user, household=cls.family, role="head")
        Membership.objects.create(user=cls.other, household=cls.family, role="member")
        device(cls.user)
        cls.food = Category.objects.create(name="Синтетика-еда")
        cls.home = Category.objects.create(name="Синтетика-жильё")

    def tick(self, now):
        return reasons.tick(now)

    def notes(self, kind):
        return list(PushNotification.objects.filter(user=self.user, kind=kind).order_by("pk")
                    .values_list("key", "title", "body", "url"))

    def test_recurring_soon_once_and_overdue(self, webpush):
        payment = RecurringPayment.objects.create(
            household=self.family, name="Аренда", category=self.home, currency_id="KZT", amount=D("200000"),
            due_day=15)
        RecurringPayment.objects.filter(pk=payment.pk).update(created_at=at(2026, 1, 1))
        self.tick(at(2026, 10, 12, 12))  # за 3 дня — рано
        self.assertEqual(self.notes("recurring"), [])
        self.tick(at(2026, 10, 13, 12))
        self.tick(at(2026, 10, 14, 12))  # за день — тот же срок уже был
        self.assertEqual(self.notes("recurring"), [
            (f"soon:{payment.pk}:2026-10-15", "Скоро платёж: Аренда",
             "200 000 ₸ — послезавтра, 15 октября.", "/recurring")])
        self.tick(at(2026, 10, 16, 12))
        self.assertEqual(self.notes("recurring")[-1], (
            f"overdue:{payment.pk}:2026-10-15", "Просрочен платёж: Аренда",
            "200 000 ₸, срок был 15 октября.", "/recurring"))
        spend(self.other, self.home, 200000, date(2026, 10, 16))
        self.tick(at(2026, 10, 17, 12))
        self.assertEqual(len(self.notes("recurring")), 2)

    def test_limit_80_then_100_once_per_month(self, webpush):
        BudgetLimit.objects.create(household=self.family, category=self.food, currency_id="KZT", amount=D("50000"))
        spend(self.other, self.food, 39000, date(2026, 10, 5))
        self.tick(at(2026, 10, 12, 12))
        self.assertEqual(self.notes("limits"), [])
        spend(self.other, self.food, 2000, date(2026, 10, 6))
        self.tick(at(2026, 10, 12, 12, 5))
        self.tick(at(2026, 10, 12, 12, 10))
        spend(self.other, self.food, 10000, date(2026, 10, 7))
        self.tick(at(2026, 10, 12, 12, 15))
        self.assertEqual(self.notes("limits"), [
            (f"2026-10:{self.food.pk}:80", "Синтетика-еда: 82 % лимита",
             "Потрачено 41 000 ₸ из 50 000 ₸. Осталось 9 000 ₸.", "/"),
            (f"2026-10:{self.food.pk}:100", "Синтетика-еда: лимит исчерпан",
             "Потрачено 51 000 ₸ из 50 000 ₸. Сверх лимита 1 000 ₸.", "/"),
        ])

    def test_total_of_limits_only_with_two_limits(self, webpush):
        BudgetLimit.objects.create(household=self.family, category=self.food, currency_id="KZT", amount=D("50000"))
        BudgetLimit.objects.create(household=self.family, category=self.home, currency_id="KZT", amount=D("50000"))
        spend(self.other, self.food, 45000, date(2026, 10, 5))
        spend(self.other, self.home, 40000, date(2026, 10, 5))
        self.tick(at(2026, 10, 12, 12))
        self.assertEqual([key for key, *_ in self.notes("limits")], [
            f"2026-10:{self.food.pk}:80", f"2026-10:{self.home.pk}:80", "2026-10:total:80"])
        self.assertEqual(self.notes("limits")[-1][1:3], (
            "Лимиты месяца: потрачено 85 %",
            "Потрачено 85 000 ₸ из 100 000 ₸. Осталось 15 000 ₸."))

    def test_weekly_on_sunday_evening(self, webpush):
        spend(self.other, self.food, 30000, date(2026, 10, 1))  # прошлая неделя (пн 28.09 – вс 4.10)
        spend(self.user, self.food, 20000, date(2026, 10, 5))
        spend(self.other, self.food, 13000, date(2026, 10, 11))
        hidden = spend(self.other, self.food, 99000, date(2026, 10, 6))
        Receipt.objects.filter(pk=hidden.pk).update(hidden=True)
        self.tick(at(2026, 10, 11, 19, 55))
        self.assertEqual(self.notes("weekly"), [])
        self.tick(at(2026, 10, 11, 20, 0))
        self.tick(at(2026, 10, 11, 21, 0))
        self.assertEqual(self.notes("weekly"), [(
            "week:2026-10-05", "Траты за неделю",
            "Потрачено 33 000 ₸ — на 10 % больше, чем на прошлой неделе (30 000 ₸).",
            "/stats?date_from=2026-10-05&date_to=2026-10-11")])

    def test_month_review_on_the_first_waits_for_nine(self, webpush):
        self.tick(at(2026, 11, 1, 0, 5))
        self.assertEqual(self.notes("monthly"), [(
            "review:2026-10", "Разбор октября", "Октябрь закончился: на что ушли деньги и что изменилось.",
            "/review?month=2026-10")])
        webpush.assert_not_called()
        self.tick(at(2026, 11, 1, 9, 0))
        self.assertEqual([item["title"] for item in sent(webpush)], ["Разбор октября"])
        self.tick(at(2026, 11, 2, 12))
        self.assertEqual(len(sent(webpush)), 1)

    def test_large_spend_of_another_member_when_switched_on(self, webpush):
        now = at(2026, 10, 12, 12)
        big = spend(self.other, self.food, 150000, date(2026, 10, 12), store="Синтетика-техника")
        mine = spend(self.user, self.food, 500000, date(2026, 10, 12))
        small = spend(self.other, self.food, 90000, date(2026, 10, 12))
        Receipt.objects.filter(pk__in=[big.pk, mine.pk, small.pk]).update(created_at=at(2026, 10, 12, 11))
        self.tick(now)
        self.assertEqual(self.notes("large"), [])  # по умолчанию выключено
        PushSettings.objects.create(user=self.user, large=True)
        self.tick(now)
        self.assertEqual(self.notes("large"), [(
            f"receipt:{big.pk}", "Крупная трата: Лиза", "150 000 ₸ — Синтетика-техника.",
            f"/receipts/{big.pk}")])
        PushSettings.objects.filter(user=self.user).update(large_threshold=D("80000"))
        Receipt.objects.filter(pk=small.pk).update(hidden=True)
        self.tick(now)
        self.assertEqual(len(self.notes("large")), 1)

    def test_tick_skips_people_without_devices_and_unconfigured_server(self, webpush):
        spend(self.other, self.food, 1000, date(2026, 10, 5))
        self.assertEqual(self.tick(at(2026, 11, 1, 10))["users"], 1)
        self.assertFalse(PushNotification.objects.filter(user=self.other).exists())
        with override_settings(WEBPUSH_VAPID_PUBLIC_KEY=""):
            self.assertEqual(self.tick(at(2026, 12, 1, 10)), {"users": 0, "notified": 0, "released": 0})


@tag("integration")
@accounts_mode()
@mock.patch("push.services.webpush")
class ApiTests(TestCase):
    URL = "/api/push/"

    @classmethod
    def setUpTestData(cls):
        cls.user = make_user("synthetic-push-api")
        cls.second = make_user("synthetic-push-api-two")

    def setUp(self):
        self.client = signed_in(self.user, csrf=True)

    def test_sign_in_required(self, webpush):
        from rest_framework.test import APIClient

        self.assertEqual(APIClient().get(self.URL).json(), NOT_AUTHENTICATED)

    def test_without_keys_push_is_off(self, webpush):
        answer = self.client.get(self.URL).json()
        self.assertEqual(answer, {
            "configured": False, "public_key": None, "devices": 0, "base_currency": "KZT",
            "settings": {"recurring": True, "limits": True, "weekly": True, "monthly": True, "large": False,
                         "large_threshold": "100000.00"}})
        for path, body in (("subscribe/", {"endpoint": ENDPOINT, "keys": KEYS}), ("test/", None)):
            response = self.client.post(self.URL + path, body, format="json")
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (409, "push_not_configured"))

    @CONFIGURED
    def test_subscribe_test_and_unsubscribe(self, webpush):
        answer = self.client.post(self.URL + "subscribe/", {"endpoint": ENDPOINT, "keys": KEYS, "expirationTime": None},
                                  format="json").json()
        self.assertEqual((answer["configured"], answer["public_key"], answer["devices"]),
                         (True, VAPID["WEBPUSH_VAPID_PUBLIC_KEY"], 1))
        response = self.client.post(self.URL + "test/")
        self.assertEqual(response.json()["sent"], 1)
        self.assertEqual(sent(webpush)[0]["title"], "Проверка уведомлений")
        # То же устройство под другим человеком — уже его.
        signed_in(self.second, csrf=True).post(self.URL + "subscribe/", {"endpoint": ENDPOINT, "keys": KEYS},
                                               format="json")
        self.assertEqual(PushSubscription.objects.get().user, self.second)
        self.assertEqual(self.client.post(self.URL + "test/").json()["sent"], 0)
        self.client.post(self.URL + "unsubscribe/", {"endpoint": ENDPOINT}, format="json")
        self.assertTrue(PushSubscription.objects.exists())  # чужое не трогается
        signed_in(self.second, csrf=True).post(self.URL + "unsubscribe/", {"endpoint": ENDPOINT}, format="json")
        self.assertFalse(PushSubscription.objects.exists())

    @CONFIGURED
    def test_subscription_must_point_to_a_browser_push_service(self, webpush):
        for endpoint in ("http://fcm.googleapis.com/x", "https://127.0.0.1/x", "https://evil.example/fcm.googleapis.com",
                         "https://fcm.googleapis.com.evil.example/x", "https://fcm.googleapis.com:8443/x"):
            response = self.client.post(self.URL + "subscribe/", {"endpoint": endpoint, "keys": KEYS}, format="json")
            self.assertEqual(response.json()["error"]["fields"], {"endpoint": ["Адрес push-сервиса браузера."]},
                             endpoint)
        response = self.client.post(self.URL + "subscribe/", {"endpoint": "https://web.push.apple.com/x",
                                                              "keys": {"p256dh": "a b"}}, format="json")
        self.assertEqual(list(response.json()["error"]["fields"]), ["keys"])
        self.assertFalse(PushSubscription.objects.exists())

    def test_settings_are_personal(self, webpush):
        answer = self.client.patch(self.URL, {"large": True, "large_threshold": "250000", "weekly": False},
                                   format="json").json()
        self.assertEqual(answer["settings"], {"recurring": True, "limits": True, "weekly": False, "monthly": True,
                                              "large": True, "large_threshold": "250000.00"})
        self.assertFalse(signed_in(self.second).get(self.URL).json()["settings"]["large"])
        response = self.client.patch(self.URL, {"large": "yes", "large_threshold": "0", "sound": True}, format="json")
        self.assertEqual(response.json()["error"]["fields"], {
            "large": ["Включатель — true или false."],
            "large_threshold": ["Сумма больше нуля, не больше двух знаков после запятой."],
            "sound": ["Неизвестное поле."]})

    def test_writes_need_csrf(self, webpush):
        from rest_framework.test import APIClient

        client = APIClient(enforce_csrf_checks=True)
        client.force_login(self.user)
        for path in ("", "subscribe/", "unsubscribe/", "test/"):
            method = client.patch if path == "" else client.post
            response = method(self.URL + path, {"weekly": False}, format="json")
            self.assertEqual((response.status_code, response.json()["error"]["code"]), (403, "csrf_failed"), path)
