from django.core.management.base import BaseCommand, CommandError

from recognition.demo import DemoError, seed_demo


class Command(BaseCommand):
    help = "Create fictional single/double receipt photos in MEDIA/demo (test/QA database only; no jobs)."

    def handle(self, *args, **options):
        try:
            paths = seed_demo()
        except DemoError as error:
            raise CommandError(str(error)) from None
        except OSError:
            raise CommandError("Demo image storage is unavailable.") from None
        for path in paths:
            self.stdout.write(str(path))
        self.stdout.write("Use --fake-scenario one_receipt for single.png; success2 for double.png.")
