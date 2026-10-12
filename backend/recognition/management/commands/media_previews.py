import json
from pathlib import Path

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from recognition.models import ReceiptImage, SourcePhoto
from recognition.previews import VARIANTS, ensure_variant, variant_name


class Command(BaseCommand):
    help = (
        "Display previews of stored photos and crops (recognition.previews). `backfill` writes the missing "
        "preview-1600-v1.webp and thumb-400-v1.webp beside every original image and every crop; existing ones "
        "are kept, so a repeated run only reports them. The same files are otherwise written on their first "
        "request, so the command is optional: it only spares the first viewer the wait. `--dry-run` counts "
        "without writing. Output is JSON: {\"dry_run\", \"written\", \"present\", \"missing_source\", \"failed\"} — counts only. "
        "Exit code 0, or 1 when some preview could not be written from an existing source."
    )

    def add_arguments(self, parser):
        parser.add_argument("action", choices=("backfill",))
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **options):
        root = Path(settings.MEDIA_ROOT).resolve()
        names = [*SourcePhoto.objects.order_by("pk").values_list("original_file", flat=True).iterator(),
                 *ReceiptImage.objects.order_by("pk").values_list("file", flat=True).iterator()]
        counts = {"written": 0, "present": 0, "missing_source": 0, "failed": 0}
        for name in names:
            source = (root / name).resolve() if name else None
            if source is None or not source.is_relative_to(root) or not source.is_file():
                counts["missing_source"] += 1
                continue
            for kind in VARIANTS:
                target = (root / variant_name(name, kind)).resolve()
                if target.is_file():
                    counts["present"] += 1
                elif options["dry_run"]:
                    counts["written"] += 1
                elif ensure_variant(target):
                    counts["written"] += 1
                else:
                    counts["failed"] += 1
        self.stdout.write(json.dumps({"dry_run": options["dry_run"], **counts}, indent=2))
        if counts["failed"]:
            raise CommandError(f"{counts['failed']} preview(s) could not be written.", returncode=1)
