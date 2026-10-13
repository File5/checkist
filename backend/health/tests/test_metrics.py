import re
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import DatabaseError
from django.test import TestCase, override_settings
from django.utils import timezone

from accounts.models import AiUsage, Household, Membership
from health import metrics
from push.models import PushNotification, PushSubscription
from rates.models import Rate
from receipts.models import ManualParseRequest, Receipt
from recognition.models import ProcessingJob, SourcePhoto
from stores.models import Currency

TOKEN = "t" * 40
AUTH = {"HTTP_AUTHORIZATION": f"Bearer {TOKEN}"}
SECRET_NAMES = ("ivanov-secret", "Иван", "Семья Тайных", "Кофейня Тайная", "12345", "Секретный комментарий")
SAMPLE = re.compile(r'^[a-z_][a-z0-9_]*(\{[a-z_]+="[^"\\\n]*"(,[a-z_]+="[^"\\\n]*")*\})? -?[0-9.e+]+$')


def parse(text):
    """``{'name{labels}': value}`` of the samples; every line is a comment or a well-formed sample."""
    samples = {}
    for line in text.splitlines():
        if line.startswith("# HELP ") or line.startswith("# TYPE "):
            continue
        assert SAMPLE.match(line), line
        key, value = line.rsplit(" ", 1)
        samples[key] = float(value)
    return samples


@override_settings(METRICS_TOKEN=TOKEN)
class MetricsEndpointTests(TestCase):
    def test_without_a_configured_token_the_path_does_not_exist(self):
        with override_settings(METRICS_TOKEN=""):
            self.assertEqual(self.client.get("/metrics", **AUTH).status_code, 404)

    def test_a_missing_or_wrong_token_is_a_404(self):
        for headers in ({}, {"HTTP_AUTHORIZATION": "Bearer wrong"}, {"HTTP_AUTHORIZATION": TOKEN},
                        {"HTTP_AUTHORIZATION": f"Basic {TOKEN}"}):
            with self.subTest(headers=headers):
                response = self.client.get("/metrics", **headers)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.content, b"")

    def test_the_right_token_gets_the_text_format(self):
        response = self.client.get("/metrics", **AUTH)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], metrics.CONTENT_TYPE)
        self.assertEqual(parse(response.content.decode())["checkist_up"], 1)
        self.assertEqual(self.client.head("/metrics", **AUTH).content, b"")

    @override_settings(ALLOWED_HOSTS=["checkist.example"], SECURE_SSL_REDIRECT=True,
                       SECURE_PROXY_SSL_HEADER=("HTTP_X_FORWARDED_PROTO", "https"))
    def test_prometheus_scrapes_by_container_name_over_http(self):
        response = self.client.get("/metrics", HTTP_HOST="checkist-web-1:8000", **AUTH)
        self.assertEqual(response.status_code, 200)

    def test_a_database_failure_is_checkist_up_0(self):
        with patch.object(metrics, "collect", side_effect=DatabaseError("down")), \
                self.assertLogs("health.metrics", "WARNING"):
            self.assertEqual(parse(metrics.render()), {"checkist_up": 0})

    @patch.dict("os.environ", {"CHECKIST_COMMIT": "abc123"})
    def test_build_info_names_the_commit(self):
        self.assertEqual(parse(metrics.render())['checkist_build_info{commit="abc123"}'], 1)


class MetricsSeriesTests(TestCase):
    def setUp(self):
        self.now = timezone.now()
        self.user = get_user_model().objects.create_user("ivanov-secret", first_name="Иван")
        self.family = Household.objects.create(name="Семья Тайных", ai_enabled=True, ai_daily_limit=50)
        Membership.objects.create(user=self.user, household=self.family, role=Membership.Role.HEAD)
        self.currency, _ = Currency.objects.get_or_create(code="KZT", defaults={"name": "Тенге"})

    def ago(self, **delta):
        return self.now - timedelta(**delta)

    def fill(self, scale=1):
        today = timezone.localdate(self.now)
        AiUsage.objects.update_or_create(household=self.family, day=today, defaults={"count": 7})
        for index in range(scale):
            Receipt.objects.create(
                owner=self.user, source=Receipt.Source.MANUAL, currency=self.currency, operation="sale",
                purchased_at=self.now, purchased_on=today, total=Decimal("12345.67"), note="Секретный комментарий")
            photo = SourcePhoto.objects.create(
                owner=self.user, original_file=f"originals/{index}/source.jpg", sha256=f"{index:064x}",
                content_type="image/jpeg", bytes=100, raw_width=10, raw_height=10, width=10, height=10)
            ProcessingJob.objects.create(photo=photo)
            queued = ManualParseRequest.objects.create(owner=self.user, text="кофе 1200", today=today)
            ManualParseRequest.objects.filter(pk=queued.pk).update(created_at=self.ago(minutes=2))
            ManualParseRequest.objects.create(
                owner=self.user, text="такси", today=today, status="failed", error_code="timeout",
                started_at=self.ago(minutes=31), finished_at=self.ago(minutes=30))
            ManualParseRequest.objects.create(
                owner=self.user, text="хлеб", today=today, status="succeeded",
                started_at=self.ago(hours=2, seconds=10), finished_at=self.ago(hours=2))
            PushSubscription.objects.create(user=self.user, endpoint=f"https://push.example/{index}", p256dh="k",
                                            auth="a")
            PushNotification.objects.create(user=self.user, kind="weekly", key=f"sent-{index}", title="t", body="b",
                                            url="/", send_after=self.ago(hours=1), sent_at=self.ago(hours=1))
            PushNotification.objects.create(user=self.user, kind="weekly", key=f"due-{index}", title="t", body="b",
                                            url="/", send_after=self.ago(minutes=10))
        Rate.objects.create(currency="USD", day=today - timedelta(days=2), value=Decimal("480.5"), quant=1)

    def test_series_of_synthetic_data(self):
        self.fill()
        samples = parse(metrics.render(self.now))
        family = self.family.pk
        expected = {
            "checkist_up": 1,
            'checkist_queue_items{queue="manual_parse",status="queued"}': 1,
            'checkist_queue_items{queue="manual_parse",status="running"}': 0,
            'checkist_queue_items{queue="recognition",status="queued"}': 1,
            'checkist_queue_items{queue="recognition",status="cancel_requested"}': 0,
            'checkist_queue_items{queue="insight",status="queued"}': 0,
            'checkist_queue_items{queue="statement_ask",status="queued"}': 0,
            'checkist_queue_finished{queue="manual_parse",status="failed",window="1h"}': 1,
            'checkist_queue_finished{queue="manual_parse",status="failed",window="24h"}': 1,
            'checkist_queue_finished{queue="manual_parse",status="succeeded",window="1h"}': 0,
            'checkist_queue_finished{queue="manual_parse",status="succeeded",window="24h"}': 1,
            'checkist_queue_finished{queue="recognition",status="partial_succeeded",window="24h"}': 0,
            'checkist_queue_failures{queue="manual_parse",code="timeout",window="24h"}': 1,
            'checkist_queue_duration_seconds{queue="manual_parse",window="1h",quantile="0.5"}': 60,
            'checkist_queue_duration_seconds{queue="manual_parse",window="24h",quantile="0.5"}': 35,
            'checkist_queue_oldest_queued_seconds{queue="insight"}': 0,
            'checkist_recognition_worker{state="absent"}': 1,
            'checkist_recognition_worker{state="busy"}': 0,
            f'checkist_ai_requests_today{{household="{family}"}}': 7,
            f'checkist_ai_enabled{{household="{family}"}}': 1,
            f'checkist_ai_daily_limit{{household="{family}"}}': 50,
            "checkist_push_subscriptions": 1,
            "checkist_push_sent_24h": 1,
            "checkist_push_due": 1,
            "checkist_rates_age_days": 2,
            'checkist_receipts{source="manual"}': 1,
            'checkist_receipts{source="photo"}': 0,
            "checkist_photos": 1,
            # The migrations also leave the user `local`.
            "checkist_users": get_user_model().objects.filter(is_active=True).count(),
            "checkist_households": 1,
        }
        self.assertEqual({key: samples.get(key) for key in expected}, expected)
        self.assertAlmostEqual(samples['checkist_queue_oldest_queued_seconds{queue="manual_parse"}'], 120, delta=1)
        self.assertAlmostEqual(samples["checkist_push_due_oldest_seconds"], 600, delta=1)
        self.assertNotIn('checkist_queue_duration_seconds{queue="recognition",window="24h",quantile="0.5"}', samples)

    def test_no_money_and_no_names(self):
        self.fill()
        text = metrics.render(self.now)
        for secret in SECRET_NAMES:
            with self.subTest(secret=secret):
                self.assertNotIn(secret, text)

    def test_the_number_of_queries_does_not_grow_with_the_data(self):
        with self.assertNumQueries(6):
            metrics.render(self.now)
        self.fill(scale=3)
        Household.objects.create(name="Вторая")
        with self.assertNumQueries(6):
            samples = parse(metrics.render(self.now))
        self.assertEqual(samples['checkist_queue_items{queue="manual_parse",status="queued"}'], 3)
        self.assertEqual(samples["checkist_households"], 2)
