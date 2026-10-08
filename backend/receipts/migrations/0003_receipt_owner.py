import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Владелец чека, шаг 1 из 3: пустая колонка и индекс. Данные — 0004, NOT NULL и ограничения — 0005."""

    dependencies = [
        ("receipts", "0002_alter_receipttax_options"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # statement_timeout из DATABASES.OPTIONS действует и на migrate, а построение индекса по большой
        # таблице в него не укладывается. SET LOCAL живёт до конца транзакции миграции.
        migrations.RunSQL("SET LOCAL statement_timeout = 0", migrations.RunSQL.noop),
        migrations.AddField(
            model_name="receipt",
            name="owner",
            field=models.ForeignKey(
                null=True, on_delete=django.db.models.deletion.PROTECT, related_name="receipts",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddIndex(
            model_name="receipt",
            index=models.Index(fields=["owner", "purchased_on"], name="receipts_rcpt_owner_on_idx"),
        ),
        # Обратный ход идёт с конца списка: там таймаут снимается этой операцией.
        migrations.RunSQL(migrations.RunSQL.noop, "SET LOCAL statement_timeout = 0"),
    ]
