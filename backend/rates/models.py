from django.db import models
from django.db.models import Q


class Rate(models.Model):
    """Официальный курс Национального банка Казахстана на один день: ``value`` тенге за ``quant`` единиц.

    Нацбанк публикует курс на каждый календарный день, включая выходные и праздники (курс
    последнего рабочего дня); завтрашнего дня до публикации нет. ``currency`` — код ISO 4217
    как его пишет Нацбанк, без связи со справочником валют: хранятся все опубликованные коды.
    Пишет только ``rates.services``; курс единицы — ``value / quant`` (у UZS ``quant`` 100).
    """

    currency = models.CharField(max_length=3)
    day = models.DateField()
    value = models.DecimalField(max_digits=18, decimal_places=6)
    quant = models.PositiveIntegerField(default=1)
    fetched_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "exchange rate"
        verbose_name_plural = "exchange rates"
        constraints = [
            models.UniqueConstraint(fields=["currency", "day"], name="rates_rate_currency_day_uniq"),
            models.CheckConstraint(condition=Q(value__gt=0), name="rates_rate_value_positive"),
            models.CheckConstraint(condition=Q(quant__gt=0), name="rates_rate_quant_positive"),
        ]

    def __str__(self):
        return f"{self.day} {self.quant} {self.currency} = {self.value} KZT"
