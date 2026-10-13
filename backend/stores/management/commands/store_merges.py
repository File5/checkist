import json

from django.core.management.base import BaseCommand, CommandError

from recognition.providers.base import ProviderError
from stores import grouping, merging
from stores.models import StoreMerge


class Command(BaseCommand):
    help = (
        "Store merges (one payee under several names): `suggest [--dry-run] [--limit N]` asks the model to group "
        "the stores and keeps new groups as suggestions for the «Магазины» screen (with codex_cli it is a real "
        "model call); `list` prints the journal; `revert ID` moves the receipts and spellings of a merge back."
    )

    def add_arguments(self, parser):
        parser.add_argument("action", choices=("suggest", "list", "revert"))
        parser.add_argument("entry", nargs="?", type=int, help="revert only: the id of the journal entry.")
        parser.add_argument("--dry-run", action="store_true", help="suggest only: print the groups, write nothing.")
        parser.add_argument("--limit", type=int, metavar="N", help=f"suggest only: at most N stores ({grouping.STORES_MAX}).")

    def handle(self, *args, **options):
        action = options["action"]
        if (options["dry_run"] or options["limit"] is not None) and action != "suggest":
            raise CommandError("--dry-run and --limit apply to suggest only.")
        if (options["entry"] is None) == (action == "revert"):
            raise CommandError("An entry id is required by revert and only by it.")
        if action == "suggest":
            payload = self.suggest(options)
        elif action == "list":
            payload = [{"id": entry.pk, "store": entry.store_id, "merged": entry.merged_id,
                        "receipts": len(entry.receipt_ids), "aliases": len(entry.alias_ids),
                        "created_at": entry.created_at.isoformat(),
                        "reverted_at": entry.reverted_at and entry.reverted_at.isoformat()}
                       for entry in StoreMerge.objects.order_by("pk")]
        else:
            payload = self.revert(options["entry"])
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))

    def suggest(self, options):
        limit = options["limit"] or grouping.STORES_MAX
        if limit < 2:
            raise CommandError("--limit: at least 2.")
        try:
            groups, saved = grouping.suggest(grouping.get_grouper(), dry_run=options["dry_run"], limit=limit)
        except ProviderError as error:
            raise CommandError(f"The model call failed: {error.code}. Nothing was saved.") from None
        except grouping.GroupingOutputError:
            raise CommandError("The model answer did not pass the schema. Nothing was saved.") from None
        return {"dry_run": options["dry_run"], "groups": groups, "saved": saved}

    def revert(self, entry_id):
        try:
            entry = merging.revert(entry_id)
        except StoreMerge.DoesNotExist:
            raise CommandError(f"No merge {entry_id}.") from None
        except merging.MergeInvalid:
            raise CommandError(f"Merge {entry_id} is already reverted.") from None
        except merging.MergeConflict:
            raise CommandError("Reverting would leave two equal photo receipts of one person in one store.") from None
        return {"id": entry.pk, "store": entry.store_id, "merged": entry.merged_id, "reverted_at": entry.reverted_at.isoformat()}
