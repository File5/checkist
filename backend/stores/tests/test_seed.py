from decimal import Decimal
from importlib import import_module
from types import SimpleNamespace

from django.apps import apps
from django.db import connection
from django.db.models import ProtectedError
from django.test import TestCase, tag

from stores.models import Country, Currency, Merchant, TaxRate

seed_migration = import_module("stores.migrations.0002_seed_reference")
# RunPython-функциям достаточно реестра моделей и алиаса соединения.
schema_editor = SimpleNamespace(connection=connection)

SEED_COUNTRIES = {"KZ", "RU", "DE"}
SEED_CURRENCIES = {"KZT", "RUB", "EUR"}
SEED_TAX_RATES = {
    ("DE", "vat", Decimal("7.00")),
    ("DE", "vat", Decimal("19.00")),
    ("KZ", "vat", Decimal("16.00")),
    ("RU", "exempt", None),
}


def tax_rates():
    return set(TaxRate.objects.values_list("country_id", "kind", "rate"))


@tag("integration")
class SeedReferenceTests(TestCase):
    """Тестовая БД создаётся командой migrate, поэтому сиды в ней уже есть."""

    def test_migrate_creates_reference_rows(self):
        self.assertEqual(set(Country.objects.values_list("code", flat=True)), SEED_COUNTRIES)
        self.assertEqual(set(Currency.objects.values_list("code", flat=True)), SEED_CURRENCIES)
        self.assertEqual(TaxRate.objects.count(), 4)
        self.assertEqual(tax_rates(), SEED_TAX_RATES)
        self.assertEqual(
            dict(TaxRate.objects.values_list("rate", "name").filter(country_id="DE")),
            {Decimal("7.00"): "MwSt 7%", Decimal("19.00"): "MwSt 19%"},
        )
        self.assertEqual(TaxRate.objects.get(country_id="KZ").name, "НДС 16%")
        self.assertEqual(TaxRate.objects.get(country_id="RU").name, "Без НДС")
        self.assertTrue(all(Country.objects.values_list("name", flat=True)))
        self.assertTrue(all(Currency.objects.values_list("name", flat=True)))

    def test_repeated_seed_does_not_duplicate(self):
        ids = set(TaxRate.objects.values_list("pk", flat=True))
        TaxRate.objects.filter(country_id="KZ").update(name="изменено")
        seed_migration.seed(apps, schema_editor)
        seed_migration.seed(apps, schema_editor)
        self.assertEqual(Country.objects.count(), 3)
        self.assertEqual(Currency.objects.count(), 3)
        self.assertEqual(set(TaxRate.objects.values_list("pk", flat=True)), ids)
        self.assertEqual(tax_rates(), SEED_TAX_RATES)
        self.assertEqual(TaxRate.objects.get(country_id="KZ").name, "НДС 16%")

    def test_reverse_deletes_only_seed_rows(self):
        Country.objects.create(code="XA", name="Тестовая страна")
        Currency.objects.create(code="XTS", name="Тестовая валюта")
        TaxRate.objects.create(country_id="XA", kind="vat", rate=Decimal("16.00"), name="Налог 16%")
        TaxRate.objects.create(country_id="XA", kind="exempt", rate=None, name="Без налога")
        seed_migration.unseed(apps, schema_editor)
        self.assertEqual(set(Country.objects.values_list("code", flat=True)), {"XA"})
        self.assertEqual(set(Currency.objects.values_list("code", flat=True)), {"XTS"})
        self.assertEqual(tax_rates(), {("XA", "vat", Decimal("16.00")), ("XA", "exempt", None)})

    def test_seed_after_reverse_restores_rows(self):
        seed_migration.unseed(apps, schema_editor)
        self.assertFalse(Country.objects.exists())
        self.assertFalse(TaxRate.objects.exists())
        seed_migration.seed(apps, schema_editor)
        self.assertEqual(set(Country.objects.values_list("code", flat=True)), SEED_COUNTRIES)
        self.assertEqual(set(Currency.objects.values_list("code", flat=True)), SEED_CURRENCIES)
        self.assertEqual(tax_rates(), SEED_TAX_RATES)

    def test_reverse_is_stopped_by_references(self):
        cases = {
            "чужая ставка страны": lambda: TaxRate.objects.create(
                country_id="KZ", kind="vat", rate=Decimal("12.00"), name="НДС 12%",
            ),
            "продавец страны": lambda: Merchant.objects.create(
                country_id="DE", legal_name="Test Handel GmbH",
            ),
        }
        for label, create_reference in cases.items():
            with self.subTest(label):
                reference = create_reference()
                with self.assertRaises(ProtectedError):
                    seed_migration.unseed(apps, schema_editor)
                reference.delete()
                seed_migration.seed(apps, schema_editor)
