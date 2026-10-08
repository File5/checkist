import json

from django.core.management.base import BaseCommand, CommandError

from accounts.demo import DemoError, seed_demo


class Command(BaseCommand):
    help = (
        "Create two fictional accounts (a catalog moderator and an ordinary user) with a receipt, "
        "a photo with files in MEDIA and a pending merge group of both (empty test/QA database only). "
        "Prints the ids as JSON; the passwords are never printed."
    )

    def add_arguments(self, parser):
        parser.add_argument("--moderator-password", required=True, help="Password of demo_moderator.")
        parser.add_argument("--user-password", required=True, help="Password of demo_user.")

    def handle(self, *args, **options):
        try:
            result = seed_demo(
                moderator_password=options["moderator_password"], user_password=options["user_password"],
            )
        except DemoError as error:
            raise CommandError(str(error)) from None
        except OSError:
            raise CommandError("Demo file storage is unavailable.") from None
        self.stdout.write(json.dumps(result, ensure_ascii=False))
