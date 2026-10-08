import json

from django.core.management.base import BaseCommand, CommandError

from receipts.demo import DemoError
from receipts.tail_demo import seed_tail_demo


class Command(BaseCommand):
    help = (
        "Create fictional long-tail spending data for the collapsed 'other' row of the statistics: "
        "14 root categories, 13 subcategories, 13 stores, 52 generic products and 520 products in EUR, "
        "a refunded product with a negative amount and a small KZT block (empty test/QA database only). "
        "Prints the period, the /stats addresses to check and the expected counters as JSON."
    )

    def handle(self, *args, **options):
        try:
            result = seed_tail_demo()
        except DemoError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(json.dumps(result, ensure_ascii=False, indent=2))
