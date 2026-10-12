"""More currencies people of a Kazakh family actually pay in (subscriptions in dollars, trips).

Without USD a spend «225 usd» was read as tenge: the model may only answer with a known code.
Reverse removes only the codes nothing refers to.
"""
from django.db import migrations
from django.db.models.deletion import ProtectedError

CURRENCIES = {
    "USD": "Доллар США",
    "GBP": "Фунт стерлингов",
    "CNY": "Китайский юань",
    "TRY": "Турецкая лира",
    "UZS": "Узбекский сум",
    "KGS": "Киргизский сом",
    "AED": "Дирхам ОАЭ",
}


def add(apps, schema_editor):
    Currency = apps.get_model("stores", "Currency")
    alias = schema_editor.connection.alias
    for code, name in CURRENCIES.items():
        Currency.objects.using(alias).get_or_create(code=code, defaults={"name": name})


def remove(apps, schema_editor):
    Currency = apps.get_model("stores", "Currency")
    alias = schema_editor.connection.alias
    for currency in Currency.objects.using(alias).filter(code__in=CURRENCIES):
        try:
            currency.delete()
        except ProtectedError:
            pass  # used by a receipt or a limit: keep it


class Migration(migrations.Migration):
    dependencies = [("stores", "0003_alter_country_options_alter_currency_options")]
    operations = [migrations.RunPython(add, remove)]
