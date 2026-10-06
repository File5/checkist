import json

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError

from catalog.models import Product
from classification import runner, services
from classification.classifier import FAKE_SCENARIOS, get_classifier
from classification.validation import drop_reason
from recognition.providers.base import ProviderError


class Command(BaseCommand):
    help = (
        "Suggested generic products: `suggest [--dry-run] [--product ID ...] [--limit N]` asks the model and "
        "applies the answers in this process (with codex_cli it is a real model call: QA only); "
        "`cancel-pending` undoes every pending suggestion (required before `migrate classification zero`); "
        "`reconcile` closes or updates the records whose products were changed outside the screen."
    )

    def add_arguments(self, parser):
        parser.add_argument("action", choices=("suggest", "cancel-pending", "reconcile"))
        parser.add_argument(
            "--dry-run", action="store_true",
            help="suggest only: call the classifier and print the checked suggestions, write nothing.",
        )
        parser.add_argument("--product", type=int, nargs="+", metavar="ID", help="suggest only: these products.")
        parser.add_argument("--limit", type=int, metavar="N", help="suggest only: at most N products.")
        parser.add_argument(
            "--fake-scenario", choices=FAKE_SCENARIOS, metavar="NAME",
            help="suggest only, RECEIPT_OCR_PROVIDER=fake: " + ", ".join(FAKE_SCENARIOS) + ".",
        )

    def handle(self, *args, **options):
        suggest = options["action"] == "suggest"
        for name in ("dry_run", "product", "limit", "fake_scenario"):
            if options[name] and not suggest:
                raise CommandError(f"--{name.replace('_', '-')} applies to suggest only.")
        if options["limit"] is not None and options["limit"] < 1:
            raise CommandError("--limit: expected a positive integer.")
        try:
            if suggest:
                payload, error_code = self.suggest(options)
            elif options["action"] == "reconcile":
                payload, error_code = {"changed": services.reconcile()}, ""
            else:
                payload, error_code = services.cancel_pending(), ""
        except services.ClassificationBusy:
            raise CommandError(
                "The catalog is being changed by an import, a merge, the worker or the category admin. Retry later."
            ) from None
        self.stdout.write(json.dumps(payload, ensure_ascii=False, indent=2))
        if error_code:
            raise CommandError(f"The run failed: {error_code}.")

    def classifier(self, scenario):
        if scenario and settings.RECEIPT_OCR_PROVIDER != "fake":
            raise CommandError("--fake-scenario requires RECEIPT_OCR_PROVIDER=fake; a failure never selects the fake.")
        try:
            return get_classifier(scenario=scenario)
        except ProviderError:
            raise CommandError(
                f"No classifier for RECEIPT_OCR_PROVIDER={settings.RECEIPT_OCR_PROVIDER}: "
                "only the explicit fake is installed (the codex_cli classifier comes with the worker step)."
            ) from None

    def suggest(self, options):
        classifier = self.classifier(options["fake_scenario"])
        if options["dry_run"]:
            return self.dry_run(classifier, options)
        run = services.start_run(
            product_ids=options["product"], limit=options["limit"], source=services.default_source(classifier),
        )
        if run is None:
            return {"dry_run": False, "run_id": None, "requested": 0, "applied": 0, "unknown": 0, "skipped": {}}, ""
        run, record_ids = runner.execute(run, classifier=classifier)
        skipped = {reason: count for reason, count in sorted(run.stats.items()) if reason != "unknown"}
        return {
            "dry_run": False, "run_id": run.pk, "status": run.status, "requested": run.requested_count,
            "processed": run.cursor, "applied": run.applied_count, "unknown": run.unknown_count,
            "skipped": skipped, "remaining": run.remaining_count, "error": run.error_code or None,
            "record_ids": record_ids,
        }, run.error_code

    def dry_run(self, classifier, options):
        run_limit = settings.PRODUCT_CLASSIFICATION_RUN_LIMIT
        limit = min(options["limit"] or run_limit, run_limit)
        ids = list(services.candidates(product_ids=options["product"]).values_list("pk", flat=True)[:limit])
        names = dict(Product.objects.filter(pk__in=ids).values_list("pk", "name"))
        suggestions, error_code, position = [], "", 0
        while position < len(ids) and not error_code:
            result = runner.run_batch(
                ids[position:position + settings.PRODUCT_CLASSIFICATION_BATCH_SIZE], classifier=classifier,
                dry_run=True,
            )
            error_code = result.error_code or ("" if result.consumed else "internal_error")
            position += result.consumed
            for item in result.response.items if result.response else ():
                # ``skipped`` is the reason known without the catalog; applying may add others.
                suggestions.append({
                    "name": names.get(item.product_id, ""), **item.to_dict(), "skipped": drop_reason(item),
                })
        return {
            "dry_run": True, "run_id": None, "requested": len(ids), "error": error_code or None,
            "suggestions": suggestions,
        }, error_code
