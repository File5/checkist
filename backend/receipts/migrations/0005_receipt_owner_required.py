import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """Владелец чека, шаг 3 из 3: NOT NULL и три уровня дедупликации в пределах владельца.

    Новые ограничения создаются до удаления прежних: уникальность не пропадает ни на миг.
    Обратный ход сначала возвращает глобальные ограничения и падает целиком, если одинаковый
    чек есть у двух владельцев.
    """

    dependencies = [
        ("receipts", "0004_assign_local_owner"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        # statement_timeout из DATABASES.OPTIONS действует и на migrate, а построение индекса по большой
        # таблице в него не укладывается. SET LOCAL живёт до конца транзакции миграции.
        migrations.RunSQL("SET LOCAL statement_timeout = 0", migrations.RunSQL.noop),
        migrations.AlterField(
            model_name="receipt",
            name="owner",
            field=models.ForeignKey(
                on_delete=django.db.models.deletion.PROTECT, related_name="receipts", to=settings.AUTH_USER_MODEL,
            ),
        ),
        migrations.AddConstraint(
            model_name="receipt",
            constraint=models.UniqueConstraint(
                condition=models.Q(("fiscal_key", ""), _negated=True),
                fields=("owner", "fiscal_key"),
                name="receipts_receipt_owner_fiscal_key_uniq",
            ),
        ),
        migrations.AddConstraint(
            model_name="receipt",
            constraint=models.UniqueConstraint(
                condition=models.Q(("receipt_number", ""), _negated=True),
                fields=("owner", "store", "purchased_on", "shift_number", "register_code", "receipt_number"),
                name="receipts_receipt_owner_store_number_uniq",
            ),
        ),
        migrations.AddConstraint(
            model_name="receipt",
            constraint=models.UniqueConstraint(
                condition=models.Q(("fiscal_key", ""), ("receipt_number", "")),
                fields=("owner", "store", "purchased_at", "total"),
                name="receipts_receipt_owner_store_time_total_uniq",
            ),
        ),
        migrations.RemoveConstraint(model_name="receipt", name="receipts_receipt_fiscal_key_uniq"),
        migrations.RemoveConstraint(model_name="receipt", name="receipts_receipt_store_number_uniq"),
        migrations.RemoveConstraint(model_name="receipt", name="receipts_receipt_store_time_total_uniq"),
        # Обратный ход идёт с конца списка: там таймаут снимается этой операцией.
        migrations.RunSQL(migrations.RunSQL.noop, "SET LOCAL statement_timeout = 0"),
    ]
