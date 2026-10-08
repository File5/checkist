import django.core.validators
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Владелец фото, шаг 3 из 3: NOT NULL и уникальность файла в пределах владельца.

    Новое ограничение создаётся до снятия прежней глобальной уникальности ``sha256``.
    Обратный ход сначала возвращает её и падает целиком, если один файл есть у двух владельцев.
    """

    dependencies = [
        ("recognition", "0003_assign_local_owner"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # statement_timeout из DATABASES.OPTIONS действует и на migrate, а построение индекса по большой
        # таблице в него не укладывается. SET LOCAL живёт до конца транзакции миграции.
        migrations.RunSQL("SET LOCAL statement_timeout = 0", migrations.RunSQL.noop),
        migrations.AlterField(
            model_name="sourcephoto",
            name="owner",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, related_name="source_photos",
                to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddConstraint(
            model_name="sourcephoto",
            constraint=models.UniqueConstraint(fields=("owner", "sha256"), name="rec_photo_owner_sha256_uniq"),
        ),
        migrations.AlterField(
            model_name="sourcephoto",
            name="sha256",
            field=models.CharField(
                max_length=64,
                validators=[
                    django.core.validators.RegexValidator(
                        "\\A[0-9a-f]{64}\\Z", "Expected a lowercase SHA-256 digest.",
                    ),
                ],
            ),
        ),
        # Обратный ход идёт с конца списка: там таймаут снимается этой операцией.
        migrations.RunSQL(migrations.RunSQL.noop, "SET LOCAL statement_timeout = 0"),
    ]
