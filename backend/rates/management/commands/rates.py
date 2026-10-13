import json
from datetime import date, timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db.models import Min
from django.utils import timezone

from rates import nbrk, services
from rates.convert import KZT, STALE_DAYS
from rates.models import Rate
from receipts.models import Receipt


def _day(value):
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise CommandError(f"Expected a date YYYY-MM-DD, got {value!r}.") from None


class Command(BaseCommand):
    help = (
        "Official exchange rates of the National Bank of Kazakhstan (KZT per unit). "
        "'fetch' loads the days that are not stored yet: by default the last "
        f"{services.REFRESH_DAYS} days up to today (the daily refresh for cron); --from/--to — a range; "
        "--receipts — from the first receipt to today (backfill for old spends); --force — reload stored days too. "
        "'status' prints stored days and receipt days (not in KZT) without a usable rate. Prints JSON."
    )

    def add_arguments(self, parser):
        sub = parser.add_subparsers(dest="action", required=True)
        fetch = sub.add_parser("fetch", help="Load rates from nationalbank.kz.")
        fetch.add_argument("--from", dest="start", help="First day, YYYY-MM-DD.")
        fetch.add_argument("--to", dest="end", help="Last day, YYYY-MM-DD; default today.")
        fetch.add_argument("--receipts", action="store_true", help="From the first receipt date.")
        fetch.add_argument("--force", action="store_true", help="Reload days that are already stored.")
        fetch.add_argument("--pause", type=float, default=0.2, help="Seconds between requests (default 0.2).")
        sub.add_parser("status", help="What is stored and which receipt days have no rate.")

    def handle(self, *args, **options):
        if options["action"] == "status":
            self.stdout.write(json.dumps(self.status(), ensure_ascii=False))
            return
        today = timezone.localdate()
        end = _day(options["end"]) if options["end"] else today
        if options["receipts"]:
            if options["start"]:
                raise CommandError("Use either --from or --receipts.")
            first = Receipt.objects.aggregate(first=Min("purchased_on"))["first"]
            start = first or end
        else:
            start = _day(options["start"]) if options["start"] else today - timedelta(days=services.REFRESH_DAYS - 1)
        end = min(end, today)
        if start > end:
            raise CommandError(f"Nothing to load: {start} is after {end}.")

        def report(day, result):
            if isinstance(result, nbrk.FetchError):
                self.stderr.write(f"{day}: {result}")
            elif options["verbosity"] > 1:
                self.stdout.write(f"{day}: {result} currencies")

        loaded, empty, failed = services.fetch_range(
            start, end, force=options["force"], pause=max(options["pause"], 0), report=report)
        self.stdout.write(json.dumps({
            "from": start.isoformat(), "to": end.isoformat(), "loaded_days": loaded, "empty_days": empty,
            "failed_days": failed,
        }))
        if failed:
            raise CommandError(f"{failed} day(s) failed; run the same command again later.")

    def status(self):
        stored = Rate.objects.aggregate(first=Min("day"))["first"]
        days = Rate.objects.values("day").distinct().count()
        last = Rate.objects.order_by("-day").values_list("day", flat=True).first()
        used = set(Receipt.objects.exclude(currency_id=KZT).values_list("currency_id", "purchased_on").distinct())
        known = {}
        for code, day in Rate.objects.filter(currency__in={code for code, _ in used}).values_list("currency", "day"):
            known.setdefault(code, set()).add(day)
        missing = sorted(
            (code, day) for code, day in used
            if not any(day - timedelta(days=back) in known.get(code, ()) for back in range(STALE_DAYS + 1)))
        return {
            "first_day": stored and stored.isoformat(), "last_day": last and last.isoformat(), "stored_days": days,
            "receipt_days_without_rate": len(missing),
            "examples": [f"{code} {day.isoformat()}" for code, day in missing[:10]],
        }
