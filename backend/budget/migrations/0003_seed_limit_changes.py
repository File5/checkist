"""Журнал лимитов для лимитов, заведённых до него: одна запись «создан» на лимит.

Сумма — текущая (прежние суммы не хранились), месяц — месяц ``created_at`` по местному
времени, автор неизвестен (``changed_by`` пуст). Откат удаляет все записи журнала.
"""
from datetime import date

from django.db import migrations
from django.utils import timezone


def seed(apps, schema_editor):
    BudgetLimit = apps.get_model("budget", "BudgetLimit")
    BudgetLimitChange = apps.get_model("budget", "BudgetLimitChange")
    seeded = set(BudgetLimitChange.objects.values_list("household_id", "user_id", "category_id", "currency_id"))
    rows = []
    for limit in BudgetLimit.objects.order_by("pk").iterator():
        key = (limit.household_id, limit.user_id, limit.category_id, limit.currency_id)
        if key in seeded:
            continue
        local = timezone.localtime(limit.created_at)
        rows.append(BudgetLimitChange(
            household_id=limit.household_id, user_id=limit.user_id, category_id=limit.category_id,
            currency_id=limit.currency_id, old_amount=None, new_amount=limit.amount, changed_by=None,
            changed_at=limit.created_at, effective_month=date(local.year, local.month, 1),
        ))
    BudgetLimitChange.objects.bulk_create(rows, batch_size=500)


def unseed(apps, schema_editor):
    apps.get_model("budget", "BudgetLimitChange").objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ("budget", "0002_budgetlimitchange"),
    ]

    operations = [
        migrations.RunPython(seed, unseed),
    ]
