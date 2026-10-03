from decimal import Decimal

from django.db import migrations

COUNTRIES = {"KZ": "Казахстан", "RU": "Россия", "DE": "Германия"}
CURRENCIES = {"KZT": "Казахстанский тенге", "RUB": "Российский рубль", "EUR": "Евро"}
# (страна, вид, ставка, название)
TAX_RATES = [
    ("DE", "vat", Decimal("7.00"), "MwSt 7%"),
    ("DE", "vat", Decimal("19.00"), "MwSt 19%"),
    ("KZ", "vat", Decimal("16.00"), "НДС 16%"),
    ("RU", "exempt", None, "Без НДС"),
]


def seed(apps, schema_editor):
    alias = schema_editor.connection.alias
    Country = apps.get_model("stores", "Country")
    Currency = apps.get_model("stores", "Currency")
    TaxRate = apps.get_model("stores", "TaxRate")
    for code, name in COUNTRIES.items():
        Country.objects.using(alias).update_or_create(code=code, defaults={"name": name})
    for code, name in CURRENCIES.items():
        Currency.objects.using(alias).update_or_create(code=code, defaults={"name": name})
    for country, kind, rate, name in TAX_RATES:
        TaxRate.objects.using(alias).update_or_create(
            country_id=country, kind=kind, rate=rate, defaults={"name": name},
        )


def unseed(apps, schema_editor):
    """Удаляет только строки этой миграции; ссылки на них остановят откат через PROTECT."""
    alias = schema_editor.connection.alias
    Country = apps.get_model("stores", "Country")
    Currency = apps.get_model("stores", "Currency")
    TaxRate = apps.get_model("stores", "TaxRate")
    for country, kind, rate, _name in TAX_RATES:
        TaxRate.objects.using(alias).filter(country_id=country, kind=kind, rate=rate).delete()
    Currency.objects.using(alias).filter(code__in=CURRENCIES).delete()
    Country.objects.using(alias).filter(code__in=COUNTRIES).delete()


class Migration(migrations.Migration):
    dependencies = [("stores", "0001_initial")]
    operations = [migrations.RunPython(seed, unseed)]
