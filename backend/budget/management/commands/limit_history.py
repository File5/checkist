import json
import re
from datetime import date

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from budget import history


class Command(BaseCommand):
    help = (
        "Journal of the budget limits. 'backfill --since YYYY-MM' gives the months from --since on the current "
        "limits: a pair whose journal starts later gets a 'created' entry with its current amount in that month. "
        "Only BudgetLimitChange is written; a repeated run changes nothing. --dry-run only lists. Prints JSON."
    )

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="action", required=True)
        backfill = sub.add_parser("backfill", help="Give past months the current limits.")
        backfill.add_argument("--since", required=True, help="First month, YYYY-MM, before the current month.")
        backfill.add_argument("--dry-run", action="store_true", help="List only, change nothing.")

    def handle(self, *args, **options):
        match = re.fullmatch(r"([0-9]{4})-([0-9]{2})", options["since"])
        if match is None or not (1901 <= int(match[1]) <= 9999 and 1 <= int(match[2]) <= 12):
            raise CommandError("--since: a month YYYY-MM.")
        since = date(int(match[1]), int(match[2]), 1)
        if since >= history.current_month():
            raise CommandError("--since must be before the current month.")
        with transaction.atomic():
            rows = history.backfill(since, dry_run=options["dry_run"])
        self.stdout.write(json.dumps({
            "since": f"{since:%Y-%m}", "dry_run": options["dry_run"], "added": len(rows),
            "entries": [{"household_id": row.household_id, "user_id": row.user_id, "category": row.category.name,
                         "currency": row.currency_id, "amount": str(row.new_amount)} for row in rows],
        }, ensure_ascii=False))
