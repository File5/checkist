import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Владелец фото, шаг 1 из 3: пустая колонка и индекс. Данные — 0003, NOT NULL и ограничение — 0004."""

    dependencies = [
        ("recognition", "0001_initial"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # statement_timeout из DATABASES.OPTIONS действует и на migrate, а построение индекса по большой
        # таблице в него не укладывается. SET LOCAL живёт до конца транзакции миграции.
        migrations.RunSQL("SET LOCAL statement_timeout = 0", migrations.RunSQL.noop),
        migrations.AddField(
            model_name="sourcephoto",
            name="owner",
            field=models.ForeignKey(
                null=True, on_delete=django.db.models.deletion.PROTECT, related_name="source_photos",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddIndex(
            model_name="sourcephoto",
            index=models.Index(fields=["owner", "created_at", "id"], name="rec_photo_owner_created_idx"),
        ),
        # Обратный ход идёт с конца списка: там таймаут снимается этой операцией.
        migrations.RunSQL(migrations.RunSQL.noop, "SET LOCAL statement_timeout = 0"),
    ]
