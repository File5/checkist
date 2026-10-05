from django.core.management.base import BaseCommand, CommandError

from recognition.demo import DemoError, seed_demo


class Command(BaseCommand):
    help = "Create fictional single/double receipt photos in MEDIA/demo (test/QA database only; no jobs)."

    def add_arguments(self, parser):
        parser.add_argument("--rotated", action="store_true", help="Create single_rotated/double_rotated with text at -12 degrees.")

    def handle(self, *args, **options):
        try:
            paths = seed_demo(rotated=options["rotated"])
        except DemoError as error:
            raise CommandError(str(error)) from None
        except OSError:
            raise CommandError("Demo image storage is unavailable.") from None
        for path in paths:
            self.stdout.write(str(path))
        if options["rotated"]:
            self.stdout.write("Use --fake-scenario rotated_receipt for single_rotated.png; rotated_two_receipts for double_rotated.png.")
        else:
            self.stdout.write("Use --fake-scenario one_receipt for single.png; success2 for double.png.")
