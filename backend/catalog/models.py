from django.db import models
from django.db.models import Q
from django.db.models.functions import Lower

from catalog.units import BaseUnit, Unit


class Category(models.Model):
    """Category tree as an adjacency list."""

    name = models.CharField(max_length=100)
    parent = models.ForeignKey(
        "self", null=True, blank=True, on_delete=models.PROTECT, related_name="children",
    )

    class Meta:
        verbose_name_plural = "categories"
        constraints = [
            models.UniqueConstraint(
                fields=["parent", "name"], nulls_distinct=False,
                name="catalog_category_parent_name_uniq",
            ),
        ]

    def __str__(self):
        return self.name


class GenericProduct(models.Model):
    """Generic product used for comparison, e.g. "milk"."""

    name = models.CharField(max_length=100)
    category = models.ForeignKey(
        Category, on_delete=models.PROTECT, related_name="generic_products",
    )
    base_unit = models.CharField(max_length=8, choices=BaseUnit.choices)

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("name"), name="catalog_genericproduct_name_uniq"),
        ]

    def __str__(self):
        return self.name


class Brand(models.Model):
    name = models.CharField(max_length=100)
    manufacturer = models.CharField(max_length=255, blank=True, default="")

    class Meta:
        constraints = [
            models.UniqueConstraint(Lower("name"), name="catalog_brand_name_uniq"),
        ]

    def __str__(self):
        return self.name


class Product(models.Model):
    """Concrete product of a manufacturer; its category comes only from ``generic``."""

    generic = models.ForeignKey(
        GenericProduct, on_delete=models.PROTECT, related_name="products",
    )
    brand = models.ForeignKey(
        Brand, null=True, blank=True, on_delete=models.PROTECT, related_name="products",
    )
    name = models.CharField(max_length=255)
    model = models.CharField(max_length=64, blank=True, default="")
    gtin = models.CharField(max_length=14, blank=True, default="")
    package_quantity = models.DecimalField(
        max_digits=12, decimal_places=3, null=True, blank=True,
    )
    package_unit = models.CharField(
        max_length=8, choices=Unit.choices, blank=True, default="",
    )
    attributes = models.JSONField(default=dict, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=["gtin"], condition=~Q(gtin=""), name="catalog_product_gtin_uniq",
            ),
            models.UniqueConstraint(
                fields=["brand", "name", "package_quantity", "package_unit"],
                nulls_distinct=False, name="catalog_product_brand_name_package_uniq",
            ),
            models.CheckConstraint(
                condition=(
                    Q(package_quantity__isnull=True, package_unit="")
                    | (Q(package_quantity__isnull=False) & ~Q(package_unit=""))
                ),
                name="catalog_product_package_both_or_none",
            ),
            models.CheckConstraint(
                condition=Q(package_quantity__isnull=True) | Q(package_quantity__gt=0),
                name="catalog_product_package_quantity_positive",
            ),
        ]

    def __str__(self):
        return self.name
