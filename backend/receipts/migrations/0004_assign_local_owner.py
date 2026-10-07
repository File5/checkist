from django.conf import settings
from django.contrib.auth.hashers import make_password
from django.db import migrations

# Имя зафиксировано в миграции: позднее изменение receipts.ownership.LOCAL_USERNAME её не меняет.
LOCAL_USERNAME = "local"


def assign_local_owner(apps, schema_editor):
    """Отдаёт все записи без владельца пользователю ``local``; существующую запись ``local`` не меняет."""
    alias = schema_editor.connection.alias
    User = apps.get_model(settings.AUTH_USER_MODEL)
    Receipt = apps.get_model("receipts", "Receipt")
    with schema_editor.connection.cursor() as cursor:
        # statement_timeout из DATABASES.OPTIONS действует и на migrate, а UPDATE всей таблицы в него
        # не укладывается. SET LOCAL живёт до конца транзакции миграции.
        cursor.execute("SET LOCAL statement_timeout = 0")
    user, _created = User.objects.using(alias).get_or_create(
        username=LOCAL_USERNAME,
        # У исторической модели нет set_unusable_password: непригодный пароль — make_password(None).
        defaults={"is_active": True, "is_staff": False, "is_superuser": False, "password": make_password(None)},
    )
    Receipt.objects.using(alias).filter(owner__isnull=True).update(owner=user)


class Migration(migrations.Migration):
    """Владелец чека, шаг 2 из 3: все прежние чеки получает пользователь ``local``.

    Обратный ход ничего не делает: пользователь ``local`` остаётся, владельца стирает удаление колонки.
    """

    dependencies = [
        ("receipts", "0003_receipt_owner"),
        # swappable_dependency даёт только первую миграцию auth, а нужна окончательная форма пользователя.
        ("auth", "0012_alter_user_first_name_max_length"),
    ]

    operations = [
        migrations.RunPython(assign_local_owner, migrations.RunPython.noop),
    ]
