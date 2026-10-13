import json

from django.core.management.base import BaseCommand
from django.db import transaction

from receipts.models import Receipt

# Комментарий траты из выписки кончается « · Выписка …» (statements.drafts.note_for); коды банка и способа совпадают.
MARKS = {Receipt.PaymentMethod.KASPI_GOLD: "Выписка Kaspi Gold", Receipt.PaymentMethod.FORTE: "Выписка ForteBank"}


class Command(BaseCommand):
    help = (
        "Payment method of saved spends. 'backfill' gives the manual spends imported from a bank statement before "
        "2026-10-13 (the note ends with '· Выписка Kaspi Gold' / '· Выписка ForteBank') the method of their bank, "
        "only where the method is empty; a repeat changes nothing. --dry-run only counts. Prints JSON: per method "
        "the number of spends updated (would be updated)."
    )

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="action", required=True)
        backfill = sub.add_parser("backfill", help="Set the method of old statement spends.")
        backfill.add_argument("--dry-run", action="store_true", help="Count only, change nothing.")

    def handle(self, *args, **options):
        result = {}
        with transaction.atomic():
            for method, mark in MARKS.items():
                found = Receipt.objects.filter(source=Receipt.Source.MANUAL, payment_method="",
                                               note__regex=rf"·\s*{mark}\s*$")
                result[method.value] = found.count() if options["dry_run"] else found.update(payment_method=method)
        result["dry_run"] = options["dry_run"]
        self.stdout.write(json.dumps(result, ensure_ascii=False))
