from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ("receipts", "0001_initial"),
    ]

    operations = [
        migrations.AlterModelOptions(
            name="receipttax",
            options={"verbose_name_plural": "receipt taxes"},
        ),
    ]
