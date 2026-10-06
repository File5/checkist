import json

from django.core.management.base import BaseCommand, CommandError

from classification.demo import DemoError, seed_demo


class Command(BaseCommand):
    help = (
        "Create a fictional merchant, receipts and products without a category "
        "(test/QA database only). Then run `product_classifications suggest --fake-scenario mixed`."
    )

    def handle(self, *args, **options):
        try:
            result = seed_demo()
        except DemoError as error:
            raise CommandError(str(error)) from None
        self.stdout.write(json.dumps(result, ensure_ascii=False))
