from django.db import models
from django.db.models import Q

from stores.normalize import ADDRESS_KEY_MAX_LENGTH, address_key


class Country(models.Model):
    code = models.CharField(max_length=2, primary_key=True)  # ISO 3166-1 alpha-2
    name = models.CharField(max_length=100)

    def __str__(self):
        return self.code


class Currency(models.Model):
    code = models.CharField(max_length=3, primary_key=True)  # ISO 4217
    name = models.CharField(max_length=100)

    def __str__(self):
        return self.code


class TaxRate(models.Model):
    class Kind(models.TextChoices):
        VAT = "vat", "НДС"
        EXEMPT = "exempt", "Без НДС"

    country = models.ForeignKey(Country, on_delete=models.PROTECT, related_name="tax_rates")
    kind = models.CharField(max_length=16, choices=Kind.choices)
    # NULL только при exempt; 0.00 — настоящая нулевая ставка.
    rate = models.DecimalField(max_digits=5, decimal_places=2, null=True, blank=True)
    name = models.CharField(max_length=64)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["country", "kind", "rate"],
                name="stores_taxrate_country_kind_rate_uniq",
                nulls_distinct=False,
            ),
            models.CheckConstraint(
                condition=(
                    Q(kind="exempt", rate__isnull=True)
                    | Q(kind="vat", rate__isnull=False, rate__gte=0)
                ),
                name="stores_taxrate_kind_rate_check",
            ),
        ]

    def __str__(self):
        return f"{self.country_id} {self.name}"


class Merchant(models.Model):
    class TaxIdType(models.TextChoices):
        INN = "inn", "ИНН"
        BIN = "bin", "БИН"
        VAT_ID = "vat_id", "VAT ID"
        OTHER = "other", "Другое"

    # Страна регистрации, пространство имён налогового ID.
    country = models.ForeignKey(Country, on_delete=models.PROTECT, related_name="merchants")
    legal_name = models.CharField(max_length=255)
    brand_name = models.CharField(max_length=100, blank=True, default="")
    tax_id_type = models.CharField(max_length=16, choices=TaxIdType.choices, blank=True, default="")
    tax_id = models.CharField(max_length=32, blank=True, default="")  # без пробелов
    extra = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["country", "tax_id"],
                condition=~Q(tax_id=""),
                name="stores_merchant_country_tax_id_uniq",
            ),
        ]

    def __str__(self):
        return self.brand_name or self.legal_name


class Store(models.Model):
    merchant = models.ForeignKey(Merchant, on_delete=models.PROTECT, related_name="stores")
    # Страна точки, для сравнения цен по странам.
    country = models.ForeignKey(Country, on_delete=models.PROTECT, related_name="stores")
    name = models.CharField(max_length=255, blank=True, default="")
    branch_code = models.CharField(max_length=32, blank=True, default="")
    address_raw = models.TextField()  # как на чеке, на основном языке
    address_i18n = models.JSONField(default=dict, blank=True)  # {"kk": "...", "ru": "..."}
    address_key = models.CharField(max_length=ADDRESS_KEY_MAX_LENGTH)
    postal_code = models.CharField(max_length=16, blank=True, default="")
    region = models.CharField(max_length=100, blank=True, default="")
    city = models.CharField(max_length=100, blank=True, default="")
    street = models.CharField(max_length=255, blank=True, default="")
    house = models.CharField(max_length=32, blank=True, default="")
    timezone = models.CharField(max_length=64)  # IANA

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["merchant", "address_key"],
                name="stores_store_merchant_address_key_uniq",
            ),
            models.UniqueConstraint(
                fields=["merchant", "branch_code"],
                condition=~Q(branch_code=""),
                name="stores_store_merchant_branch_code_uniq",
            ),
        ]

    def __str__(self):
        return self.name or self.address_raw

    def save(self, *args, **kwargs):
        # Ключ — идентичность магазина: считается один раз и при правке адреса не меняется.
        # bulk_create/update save() не вызывают — там ключ передаёт вызывающий код.
        if not self.address_key:
            self.address_key = address_key(self.address_raw, self.address_i18n)
        super().save(*args, **kwargs)
