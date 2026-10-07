from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("stores", "0002_seed_reference"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="country",
            options={"verbose_name_plural": "countries"},
        ),
        migrations.AlterModelOptions(
            name="currency",
            options={"verbose_name_plural": "currencies"},
        ),
    ]
