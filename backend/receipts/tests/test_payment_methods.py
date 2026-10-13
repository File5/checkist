"""``manage.py payment_methods backfill``: способ оплаты старых трат из выписок. Данные вымышленные."""
import json
from io import StringIO

from django.core.management import call_command
from django.test import TestCase, tag

from catalog.models import Category
from receipts import manual
from receipts.models import Receipt
from receipts.ownership import local_user


def run(*args):
    out = StringIO()
    call_command("payment_methods", "backfill", *args, stdout=out)
    return json.loads(out.getvalue())


@tag("integration")
class BackfillTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        category = Category.objects.create(name="Демо-прочее")

        def spend(note, **body):
            return manual.create(local_user(), {"total": "100", "category": category.pk, "note": note, **body})

        cls.kaspi = spend("Комиссия за перевод · Выписка Kaspi Gold")
        cls.kaspi_bare = spend("· Выписка Kaspi Gold")
        cls.forte = spend("Интернет дома · Выписка ForteBank")
        cls.chosen = spend("· Выписка ForteBank", payment_method="cash")  # уже указан — не трогаем
        cls.plain = spend("Выписка Kaspi Gold потом")  # не в конце после «·»
        cls.typed = spend("кофе")

    def methods(self):
        return {receipt.pk: receipt.payment_method for receipt in Receipt.objects.all()}

    def test_dry_run_counts_and_changes_nothing(self):
        self.assertEqual(run("--dry-run"), {"kaspi_gold": 2, "forte": 1, "dry_run": True})
        self.assertEqual(set(self.methods().values()), {"", "cash"})

    def test_backfill_sets_the_bank_only_where_empty_and_a_repeat_changes_nothing(self):
        self.assertEqual(run(), {"kaspi_gold": 2, "forte": 1, "dry_run": False})
        self.assertEqual(self.methods(), {
            self.kaspi.pk: "kaspi_gold", self.kaspi_bare.pk: "kaspi_gold", self.forte.pk: "forte",
            self.chosen.pk: "cash", self.plain.pk: "", self.typed.pk: "",
        })
        self.assertEqual(run(), {"kaspi_gold": 0, "forte": 0, "dry_run": False})
