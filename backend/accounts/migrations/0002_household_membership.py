import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ("accounts", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="Household",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=100)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
            options={
                "verbose_name": "household",
                "verbose_name_plural": "households",
                "ordering": ("name", "id"),
            },
        ),
        migrations.CreateModel(
            name="Membership",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("household", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE,
                                                related_name="memberships", to="accounts.household")),
                ("user", models.OneToOneField(on_delete=django.db.models.deletion.CASCADE,
                                              related_name="membership", to=settings.AUTH_USER_MODEL)),
            ],
            options={
                "verbose_name": "membership",
                "verbose_name_plural": "memberships",
            },
        ),
    ]
