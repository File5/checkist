import json

from django.core.management.base import BaseCommand, CommandError

from receipts.demo import DemoError, seed_demo


class Command(BaseCommand):
    help = (
        "Create fictional stores, a categorized catalog and 2019-2026 receipts for the "
        "spending statistics, price chart and average receipt screens (test/QA database only)."
    )

    def handle(self, *args, **options):
        try:
            result = seed_demo()
        except DemoError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(json.dumps(result, ensure_ascii=False))
