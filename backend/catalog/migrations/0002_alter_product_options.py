from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0001_initial"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="product",
            options={"permissions": [("moderate_catalog", "Can moderate the shared catalog")]},
        ),
    ]
