"""``manage.py rates fetch|status`` без сети: загрузка дня подменена."""
import json
from datetime import date
from decimal import Decimal
from io import StringIO
from unittest import mock

from django.core.management import CommandError, call_command
from django.test import TestCase, tag

from catalog.models import Category
from rates import nbrk
from rates.models import Rate
from rates.nbrk import Item
from receipts import manual
from receipts.ownership import local_user

D = Decimal
TODAY = date(2026, 10, 13)
ITEMS = [Item("USD", D("448.94"), 1), Item("UZS", D("3.8"), 100)]


def run(*args):
    out, err = StringIO(), StringIO()
    pause = ("--pause", "0") if args[0] == "fetch" else ()
    with mock.patch("rates.management.commands.rates.timezone.localdate", return_value=TODAY):
        call_command("rates", *args, *pause, stdout=out, stderr=err)
    return json.loads(out.getvalue().strip().splitlines()[-1]), err.getvalue()


@tag("integration")
class FetchCommandTests(TestCase):
    def test_range_then_only_missing_days_then_force(self):
        with mock.patch("rates.services.nbrk.fetch", return_value=ITEMS) as fetch:
            result, _ = run("fetch", "--from", "2026-10-08", "--to", "2026-10-10")
            self.assertEqual(result, {"from": "2026-10-08", "to": "2026-10-10", "loaded_days": 3, "empty_days": 0,
                                      "failed_days": 0})
            self.assertEqual(Rate.objects.count(), 6)
            uzs = Rate.objects.get(currency="UZS", day=date(2026, 10, 9))
            self.assertEqual((uzs.value, uzs.quant), (D("3.800000"), 100))
            run("fetch", "--from", "2026-10-08", "--to", "2026-10-11")
            self.assertEqual(fetch.call_args_list[-1].args[0], date(2026, 10, 11))
            self.assertEqual(fetch.call_count, 4)  # три дня уже были
            run("fetch", "--from", "2026-10-08", "--to", "2026-10-08", "--force")
            self.assertEqual(fetch.call_count, 5)

    def test_default_is_the_last_week_and_a_future_end_stops_today(self):
        with mock.patch("rates.services.nbrk.fetch", return_value=[]) as fetch:
            result, _ = run("fetch", "--to", "2026-12-31")
        self.assertEqual((result["from"], result["to"], result["empty_days"]), ("2026-10-07", "2026-10-13", 7))
        self.assertEqual(fetch.call_count, 7)

    def test_from_the_first_receipt(self):
        food = Category.objects.create(name="Демо-еда")
        manual.create(local_user(), {"total": "10", "currency": "USD", "category": food.pk, "purchased_on": "2026-10-11"})
        with mock.patch("rates.services.nbrk.fetch", return_value=ITEMS):
            result, _ = run("fetch", "--receipts")
        self.assertEqual((result["from"], result["loaded_days"]), ("2026-10-11", 3))

    def test_failed_days_are_reported_and_fail_the_command(self):
        with mock.patch("rates.services.nbrk.fetch", side_effect=[ITEMS, nbrk.FetchError("down"), ITEMS]):
            with self.assertRaisesMessage(CommandError, "1 day(s) failed"):
                run("fetch", "--from", "2026-10-08", "--to", "2026-10-10")
        self.assertEqual(sorted(set(Rate.objects.values_list("day", flat=True))), [date(2026, 10, 8), date(2026, 10, 10)])

    def test_bad_arguments(self):
        for args in (("fetch", "--from", "08.10.2026"), ("fetch", "--from", "2026-10-12", "--to", "2026-10-01"),
                     ("fetch", "--from", "2026-10-01", "--receipts")):
            with self.subTest(args=args), self.assertRaises(CommandError):
                run(*args)

    def test_status(self):
        food = Category.objects.create(name="Демо-еда")
        for day in ("2026-10-09", "2026-09-01"):
            manual.create(local_user(), {"total": "10", "currency": "USD", "category": food.pk, "purchased_on": day})
        with mock.patch("rates.services.nbrk.fetch", return_value=ITEMS):
            run("fetch", "--from", "2026-10-08", "--to", "2026-10-09")
        result, _ = run("status")
        self.assertEqual(result, {"first_day": "2026-10-08", "last_day": "2026-10-09", "stored_days": 2,
                                  "receipt_days_without_rate": 1, "examples": ["USD 2026-09-01"]})
