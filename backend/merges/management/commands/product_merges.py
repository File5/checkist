import json

from django.core.management.base import BaseCommand, CommandError

from merges import services


class Command(BaseCommand):
    help = (
        "Duplicate products: `detect [--dry-run]` finds and provisionally merges them; "
        "`cancel-pending` undoes every pending group (required before `migrate merges zero`)."
    )

    def add_arguments(self, parser):
        parser.add_argument("action", choices=("detect", "cancel-pending"))
        parser.add_argument(
            "--dry-run", action="store_true", help="detect only: print the found groups, write nothing.",
        )

    def handle(self, *args, **options):
        if options["dry_run"] and options["action"] != "detect":
            raise CommandError("--dry-run applies to detect only.")
        try:
            if options["action"] == "detect":
                result = services.detect(dry_run=options["dry_run"])
                payload = {
                    "dry_run": result.dry_run, "created": result.created, "extended": result.extended,
                    "group_ids": result.group_ids, "groups": result.proposals,
                }
            else:
                payload = {"cancelled": services.cancel_pending()}
        except services.MergeBusy:
            raise CommandError("The catalog is being changed by an import or another merge. Retry later.") from None
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
