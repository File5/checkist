import json

from django.core.management.base import BaseCommand, CommandError

from merges.demo import DemoError, seed_demo


class Command(BaseCommand):
    help = (
        "Create a fictional merchant, receipts and products with duplicate spellings "
        "(test/QA database only). Then run `product_merges detect`."
    )

    def handle(self, *args, **options):
        try:
            result = seed_demo()
        except DemoError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(json.dumps(result, ensure_ascii=False))
