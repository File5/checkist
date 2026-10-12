"""Категория «Кафе и рестораны» › «Обслуживание и чаевые» для строк обслуживания и чаевых.

Ищется по имени и родителю (``get_or_create``): на сервере обе уже есть (id 9 и 27), там
миграция ничего не создаёт; повторный запуск тоже. Откат ничего не удаляет: на категорию
могут ссылаться строки чеков, лимиты и товары.
"""
from django.db import migrations

# Совпадают с receipts.service_charges.PARENT_NAME / CATEGORY_NAME (миграция код приложения не импортирует).
PARENT_NAME = "Кафе и рестораны"
CATEGORY_NAME = "Обслуживание и чаевые"


def seed(apps, schema_editor):
    Category = apps.get_model("catalog", "Category")
    alias = schema_editor.connection.alias
    parent, _ = Category.objects.using(alias).get_or_create(name=PARENT_NAME, parent=None)
    Category.objects.using(alias).get_or_create(name=CATEGORY_NAME, parent=parent)


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0002_alter_product_options"),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
