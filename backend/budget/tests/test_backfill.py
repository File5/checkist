"""``manage.py limit_history backfill``: прошлые месяцы получают нынешние лимиты, повтор ничего не меняет."""
import json
from datetime import date, datetime
from decimal import Decimal
from io import StringIO
from unittest import mock
from zoneinfo import ZoneInfo

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, tag

from api.tests.accounts_helpers import local_single_mode
from budget import history
from budget.models import BudgetLimit, BudgetLimitChange
from catalog.models import Category
from receipts.ownership import local_user

D = Decimal
OCTOBER_12 = datetime(2026, 10, 12, 15, tzinfo=ZoneInfo("Asia/Almaty"))


@tag("integration")
@local_single_mode()
class BackfillTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        owner = local_user()
        cls.food, cls.cafe, cls.old, cls.gone = (Category.objects.create(name=f"Демо-{name}")
                                                 for name in ("еда", "кафе", "старое", "удалённое"))
        with mock.patch("budget.history.timezone.now", return_value=OCTOBER_12):
            cls.food_limit = history.save_limit(BudgetLimit(user=owner, category=cls.food, currency_id="KZT", amount=D("100000")))
            history.save_limit(BudgetLimit(user=owner, category=cls.cafe, currency_id="KZT", amount=D("30000")))
            cls.food_limit.amount = D("120000")
            history.save_limit(cls.food_limit)
            gone = history.save_limit(BudgetLimit(user=owner, category=cls.gone, currency_id="KZT", amount=D("5000")))
            history.delete_limit(gone)
        # Лимит, журнал которого начался давно, и лимит без журнала (заведён мимо сервиса).
        old = BudgetLimit.objects.create(user=owner, category=cls.old, currency_id="KZT", amount=D("7000"))
        BudgetLimitChange.objects.create(user=owner, category=cls.old, currency_id="KZT", new_amount=D("7000"),
                                         changed_at=OCTOBER_12, effective_month=date(2026, 3, 1))
        BudgetLimit.objects.create(user=owner, category=Category.objects.create(name="Демо-без журнала"),
                                   currency_id="KZT", amount=D("1000"))

    def run_command(self, *args):
        out = StringIO()
        with mock.patch("budget.history.timezone.localdate", return_value=date(2026, 10, 13)):
            call_command("limit_history", "backfill", *args, stdout=out)
        return json.loads(out.getvalue())

    def amounts(self, month):
        limits = list(BudgetLimit.objects.all())
        return {row.category.name: row.amount for row in history.limits_at(limits, list(BudgetLimitChange.objects.all()), month)}

    def test_past_months_get_the_current_limits_once(self):
        self.assertNotIn("Демо-еда", self.amounts(date(2026, 9, 1)))
        before = BudgetLimitChange.objects.count()
        result = self.run_command("--since", "2026-05")
        self.assertEqual((result["added"], result["dry_run"]), (2, False))
        self.assertEqual({(entry["category"], entry["amount"]) for entry in result["entries"]},
                         {("Демо-еда", "120000.00"), ("Демо-кафе", "30000.00")})
        self.assertEqual(BudgetLimitChange.objects.count(), before + 2)
        for month in (date(2026, 5, 1), date(2026, 9, 1)):
            self.assertEqual(self.amounts(month), {"Демо-еда": D("120000.00"), "Демо-кафе": D("30000.00"),
                                                   "Демо-старое": D("7000.00"), "Демо-без журнала": D("1000.00")})
        self.assertNotIn("Демо-еда", self.amounts(date(2026, 4, 1)))
        self.assertEqual(self.amounts(date(2026, 10, 1))["Демо-еда"], D("120000.00"))
        added = BudgetLimitChange.objects.get(category=self.cafe, effective_month=date(2026, 5, 1))
        self.assertEqual((added.old_amount, added.changed_by_id, added.user_id), (None, None, local_user().pk))
        # Повтор с тем же и с более поздним месяцем — ничего.
        self.assertEqual(self.run_command("--since", "2026-05")["added"], 0)
        self.assertEqual(self.run_command("--since", "2026-07")["added"], 0)
        self.assertEqual(BudgetLimitChange.objects.count(), before + 2)

    def test_dry_run_writes_nothing(self):
        before = BudgetLimitChange.objects.count()
        self.assertEqual(self.run_command("--since", "2026-05", "--dry-run")["added"], 2)
        self.assertEqual(BudgetLimitChange.objects.count(), before)

    def test_since_must_be_a_past_month(self):
        for value in ("2026-10", "2026-11", "2026-13", "26-05", "май"):
            with self.assertRaises(CommandError, msg=value):
                self.run_command("--since", value)
