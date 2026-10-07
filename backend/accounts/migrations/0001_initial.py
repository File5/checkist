from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = []

    operations = [
        migrations.CreateModel(
            name="LoginFailure",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("key", models.CharField(max_length=128, unique=True)),
                ("failures", models.PositiveIntegerField()),
                ("window_started_at", models.DateTimeField(db_index=True)),
            ],
            options={
                "verbose_name": "login failure",
                "verbose_name_plural": "login failures",
            },
        ),
    ]
