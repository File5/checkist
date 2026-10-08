import json

from django.core.management.base import BaseCommand, CommandError

from recognition import ownership


class Command(BaseCommand):
    help = (
        "Ownership of receipts and photos: `check-rollback` reads the database and prints the groups of rows "
        "that the former global constraints would reject, so `migrate receipts 0002_alter_receipttax_options` "
        "and `migrate recognition 0001_initial` would fail. Rules: photo_sha256 (one sha256 on several photos), "
        "receipt_fiscal_key (one non-empty fiscal_key), receipt_store_number (one store, purchased_on, "
        "shift_number, register_code and non-empty receipt_number), receipt_store_time_total (one store, "
        "purchased_at and total with empty receipt_number and fiscal_key). Output is JSON: "
        '{"conflicts": N, "groups": [{"rule", "model", "constraint", "rows": [{"id", "owner_id"}]}]} — '
        "ids only, no receipt or file content. Writes nothing. Exit code 0 when there are no groups, 1 otherwise."
    )

    def add_arguments(self, parser):
        parser.add_argument("action", choices=("check-rollback",))

    def handle(self, *args, **options):
        summary = ownership.rollback_summary()
        self.stdout.write(json.dumps(summary, ensure_ascii=False, indent=2))
        if summary["conflicts"]:
            raise CommandError(
                f"{summary['conflicts']} group(s) of rows belong to several owners and block the rollback.",
                returncode=1,
            )
