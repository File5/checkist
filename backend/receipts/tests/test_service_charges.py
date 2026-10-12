"""Обслуживание и чаевые: миграция категории, правило, команда backfill и статистика."""
import importlib
import json
from decimal import Decimal
from io import StringIO

from django.apps import apps
from django.core.management import CommandError, call_command
from django.db import connection
from django.test import SimpleTestCase, TestCase, override_settings, tag
from rest_framework.test import APIClient

from catalog.models import Category
from receipts import service_charges
from receipts.models import ReceiptLine
from receipts.tests.test_models import ReceiptTestCase, make_line

D = Decimal
migration = importlib.import_module("catalog.migrations.0003_service_charge_category")


def service_category():
    """Категория миграции; создаётся тем же кодом, если тест-раннер её очистил."""
    with connection.schema_editor() as editor:
        migration.seed(apps, editor)
    return Category.objects.get(name=service_charges.CATEGORY_NAME, parent__name=service_charges.PARENT_NAME)


class RuleTests(SimpleTestCase):
    def test_names_of_service_charges_and_tips(self):
        for name in ("Обслуживание 10%", "ОБСЛУЖ. 10 %", "Сервисный сбор", "Чаевые официанту", "Service charge",
                     "SERVICE 12,5%", "Tips", "Servis ücreti", "Trinkgeld", "Bedienung", "Gratuity",
                     "Қызмет  көрсету 10%", "қызмет ақысы"):
            with self.subTest(name=name):
                self.assertTrue(service_charges.is_service_charge(name))
                self.assertTrue(service_charges.applies("service", name))

    def test_other_services_and_kinds_are_not_touched(self):
        for name in ("Доставка", "Пакет", "Аренда коньков", "", None):
            with self.subTest(name=name):
                self.assertFalse(service_charges.is_service_charge(name))
        for kind in ("product", "deposit", "deposit_return"):
            self.assertFalse(service_charges.applies(kind, "Обслуживание 10%"))


@tag("integration")
class MigrationTests(TestCase):
    def test_seed_matches_rows_by_name_and_is_idempotent(self):
        first = service_category()
        self.assertIsNone(first.parent.parent_id)
        count = Category.objects.count()
        second = service_category()
        self.assertEqual((second.pk, second.parent_id), (first.pk, first.parent_id))
        self.assertEqual(Category.objects.count(), count)
        self.assertEqual(service_charges.category_id(), first.pk)

    def test_test_databases_start_without_them_and_demos_ignore_them(self):
        # config.test_runner drops the rows of the migration: the catalog of a test starts empty.
        self.assertFalse(Category.objects.exists())
        self.assertEqual(service_charges.seeded_category_ids(), [])
        child = service_category()
        self.assertEqual(sorted(service_charges.seeded_category_ids()), sorted([child.pk, child.parent_id]))

    def test_existing_rows_are_reused_as_on_the_server(self):
        Category.objects.filter(name__in=(service_charges.CATEGORY_NAME, service_charges.PARENT_NAME)).delete()
        parent = Category.objects.create(name=service_charges.PARENT_NAME)
        child = Category.objects.create(name=service_charges.CATEGORY_NAME, parent=parent)
        self.assertEqual(service_category().pk, child.pk)
        self.assertEqual(Category.objects.filter(name=service_charges.PARENT_NAME).count(), 1)

    def test_a_namesake_elsewhere_in_the_tree_is_not_taken(self):
        Category.objects.filter(name__in=(service_charges.CATEGORY_NAME, service_charges.PARENT_NAME)).delete()
        other = Category.objects.create(name="Досуг")
        Category.objects.create(name=service_charges.CATEGORY_NAME, parent=other)
        self.assertIsNone(service_charges.category_id())
        self.assertNotEqual(service_category().parent.name, "Досуг")


@tag("integration")
class BackfillTests(ReceiptTestCase):
    def setUp(self):
        self.category = service_category()
        receipt = self.make_receipt()
        self.charge = make_line(receipt, position=1, kind="service", raw_name="Обслуживание 10%")
        self.tip = make_line(receipt, position=2, kind="service", raw_name="TIPS")
        self.delivery = make_line(receipt, position=3, kind="service", raw_name="Доставка")
        self.food = make_line(receipt, position=4, kind="product", raw_name="Сервис-сет суши")
        self.chosen = Category.objects.create(name="Подарки")
        self.manual = make_line(receipt, position=5, kind="service", raw_name="Чаевые", category=self.chosen)

    def run_command(self, *args):
        out = StringIO()
        call_command("service_charges", "backfill", *args, stdout=out)
        return json.loads(out.getvalue())

    def categories(self):
        return {line.pk: line.category_id for line in ReceiptLine.objects.all()}

    def test_dry_run_counts_and_changes_nothing(self):
        before = self.categories()
        result = self.run_command("--dry-run")
        self.assertEqual(result, {"category_id": self.category.pk, "matched": 3, "updated": 2, "kept": 1,
                                  "dry_run": True})
        self.assertEqual(self.categories(), before)

    def test_backfill_sets_the_category_once(self):
        result = self.run_command()
        self.assertEqual(result, {"category_id": self.category.pk, "matched": 3, "updated": 2, "kept": 1,
                                  "dry_run": False})
        after = self.categories()
        self.assertEqual((after[self.charge.pk], after[self.tip.pk]), (self.category.pk, self.category.pk))
        self.assertEqual((after[self.delivery.pk], after[self.food.pk], after[self.manual.pk]),
                         (None, None, self.chosen.pk))
        self.assertEqual(self.run_command()["updated"], 0)

    def test_without_the_category_nothing_changes(self):
        ReceiptLine.objects.filter(category=self.category).update(category=None)
        Category.objects.filter(pk=self.category.pk).delete()
        before = self.categories()
        with self.assertRaises(CommandError):
            self.run_command()
        self.assertEqual(self.categories(), before)


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class StatisticsTests(ReceiptTestCase):
    """«Кафе и рестораны › Обслуживание и чаевые» в статистике без особого кода."""

    def setUp(self):
        self.category = service_category()
        receipt = self.make_receipt(total=D("5500.00"))
        make_line(receipt, position=1, kind="service", raw_name="Обслуживание 10%", amount=D("500.00"),
                  unit_price=D("500.0000"), category=self.category)
        make_line(receipt, position=2, kind="service", raw_name="Доставка", amount=D("5000.00"),
                  unit_price=D("5000.0000"))
        self.client = APIClient()

    def items(self, query=""):
        response = self.client.get(f"/api/stats/spending/?{query}")
        self.assertEqual(response.status_code, 200, response.content)
        [block] = response.json()["currencies"]
        return {(item["kind"], item["name"]): item["amount"] for item in block["items"]}

    def test_root_level_shows_cafes_and_restaurants(self):
        self.assertEqual(self.items(), {("category", service_charges.PARENT_NAME): "500.00",
                                        ("service", None): "5000.00"})

    def test_drill_down_shows_service_and_tips(self):
        parent = self.category.parent_id
        self.assertEqual(self.items(f"category={parent}"),
                         {("category", service_charges.CATEGORY_NAME): "500.00"})

    def test_by_generic_product_it_is_a_line_without_product(self):
        self.assertEqual(self.items("group_by=generic"), {("no_product", None): "500.00",
                                                          ("service", None): "5000.00"})
