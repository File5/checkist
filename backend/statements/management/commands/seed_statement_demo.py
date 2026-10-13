"""Вымышленная выписка Kaspi Gold для QA и снимков: PDF и черновик из него тем же путём, что загрузка.

``manage.py seed_statement_demo [--username local] [--end 2026-10-12] [--pdf путь] [--no-import]``

Две последние траты пользователя попадают в выписку ещё раз — в черновике они станут
дублями. Настоящих выписок здесь нет: получатели и суммы придуманы.
"""
from datetime import date, timedelta
from pathlib import Path

from django.contrib.auth import get_user_model
from django.core.management.base import BaseCommand, CommandError

from api.common import store_name
from receipts.models import Receipt
from statements import demo, drafts
from statements.extract import StatementError
from statements.rules import scope_of


class Command(BaseCommand):
    help = "Build a fictional Kaspi Gold statement PDF and import it as a draft of the user (QA and screenshots)."

    def add_arguments(self, parser):
        parser.add_argument("--username", default="local")
        parser.add_argument("--end", type=date.fromisoformat, default=None, help="Last day of the statement, YYYY-MM-DD.")
        parser.add_argument("--pdf", type=Path, default=None, help="Also write the PDF here.")
        parser.add_argument("--no-import", action="store_true", help="Only write the PDF.")

    def handle(self, *args, **options):
        user = get_user_model().objects.filter(username=options["username"]).first()
        if user is None:
            raise CommandError("No such user.")
        end = options["end"] or date.today()
        recent = (Receipt.objects.filter(owner=user, purchased_on__range=(end - timedelta(days=25), end), store__isnull=False)
                  .select_related("store__merchant").order_by("-purchased_on", "-pk")[:2])
        duplicates = [(receipt.purchased_on, receipt.total, store_name(receipt.store)) for receipt in recent]
        data = demo.pdf_bytes(demo.demo_kaspi_lines(end, duplicates))
        if options["pdf"]:
            options["pdf"].write_bytes(data)
            self.stdout.write(f"PDF: {options['pdf']}")
        if options["no_import"]:
            return
        try:
            statement, created = drafts.accept(user, data, rule_scope=scope_of(user))
        except StatementError as error:
            raise CommandError(f"Statement refused: {error.code}") from None
        self.stdout.write(f"Statement {statement.pk}: {'created' if created else 'already imported'}")
