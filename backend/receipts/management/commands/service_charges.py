import json

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from receipts import service_charges


class Command(BaseCommand):
    help = (
        "Service charges and tips of saved receipts. 'backfill' puts saved service lines without a product "
        "and without a category whose name looks like a service charge or tip into "
        f"'{service_charges.PARENT_NAME} > {service_charges.CATEGORY_NAME}'; lines with a category are kept. "
        "--dry-run only counts. Prints JSON: category_id, matched, updated (would be updated), kept."
    )

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="action", required=True)
        backfill = sub.add_parser("backfill", help="Apply the rule to saved lines.")
        backfill.add_argument("--dry-run", action="store_true", help="Count only, change nothing.")

    def handle(self, *args, **options):
        with transaction.atomic():
            result = service_charges.backfill(dry_run=options["dry_run"])
        result["dry_run"] = options["dry_run"]
        self.stdout.write(json.dumps(result, ensure_ascii=False))
        if result["category_id"] is None:
            raise CommandError(
                f"Category '{service_charges.PARENT_NAME} > {service_charges.CATEGORY_NAME}' not found; "
                "run 'manage.py migrate catalog'. Nothing changed."
            )
