"""Значок категории (2026-10-13): поле ``icon`` и значки категорий верхнего уровня по словам названия.

Пустой ``icon`` — значок ближайшего предка; у всей ветви без значка клиент рисует ярлык. Значок ставится
только пустому корню, по первому подходящему правилу, без учёта регистра. Откат данных ничего не делает:
поле удаляет откат ``AddField``.
"""
from django.db import migrations, models

# Порядок важен: первое совпавшее правило. Миграция код приложения не импортирует.
RULES = (
    ("cart", ("еда", "продукт", "супермаркет")),
    ("bus", ("транспорт", "такси", "проезд")),
    ("car", ("авто", "машин", "бензин", "топлив")),
    ("dining", ("кафе", "ресторан")),
    ("paw", ("питом", "животн", "зоо")),
    ("home", ("жиль", "дом", "коммунал", "аренд", "квартир")),
    ("phone", ("связ", "подписк", "интернет", "телефон")),
    ("heart", ("здоров", "аптек", "медиц", "лекарств")),
    ("baby", ("дет", "ребён", "ребен")),
    ("shirt", ("одежд", "обув")),
    ("ticket", ("развлеч", "досуг", "кино")),
    ("gift", ("подар",)),
    ("box", ("онлайн", "маркетплейс", "доставк")),
    ("bank", ("банк", "комисс")),
    ("beauty", ("красот", "уход", "космет", "парикмах")),
    ("plane", ("путешеств", "отпуск", "отдых")),
    ("book", ("образован", "учёб", "учеб", "книг")),
)


def icon_for(name):
    text = name.casefold()
    return next((icon for icon, words in RULES if any(word in text for word in words)), "")


def seed(apps, schema_editor):
    Category = apps.get_model("catalog", "Category")
    for category in Category.objects.using(schema_editor.connection.alias).filter(parent=None, icon=""):
        icon = icon_for(category.name)
        if icon:
            category.icon = icon
            category.save(update_fields=["icon"])


class Migration(migrations.Migration):

    dependencies = [
        ("catalog", "0004_product_scope"),
    ]

    operations = [
        migrations.AddField(
            model_name="category",
            name="icon",
            field=models.CharField(
                blank=True, default="", max_length=16,
                choices=[
                    ("cart", "Тележка"), ("bus", "Автобус"), ("car", "Машина"), ("dining", "Вилка и нож"),
                    ("home", "Дом"), ("phone", "Телефон"), ("heart", "Сердце"), ("shirt", "Футболка"),
                    ("ticket", "Билет"), ("gift", "Подарок"), ("baby", "Мишка"), ("box", "Коробка"),
                    ("bank", "Банк"), ("beauty", "Ножницы"), ("plane", "Самолёт"), ("book", "Книга"),
                    ("paw", "Лапа"), ("tag", "Ярлык"),
                ],
            ),
        ),
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
