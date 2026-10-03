from decimal import Decimal

from django.db import models


class Unit(models.TextChoices):
    PCS = "pcs", "шт"
    G = "g", "г"
    KG = "kg", "кг"
    ML = "ml", "мл"
    L = "l", "л"
    M = "m", "м"


class BaseUnit(models.TextChoices):
    """Units a generic product is compared in: price per kg, per litre, per piece."""

    KG = Unit.KG.value, Unit.KG.label
    L = Unit.L.value, Unit.L.label
    PCS = Unit.PCS.value, Unit.PCS.label


_THOUSANDTH = Decimal("0.001")
_ONE = Decimal(1)
_TO_BASE = {
    Unit.PCS: (Unit.PCS, _ONE),
    Unit.G: (Unit.KG, _THOUSANDTH),
    Unit.KG: (Unit.KG, _ONE),
    Unit.ML: (Unit.L, _THOUSANDTH),
    Unit.L: (Unit.L, _ONE),
    # Metres have no comparison unit among BaseUnit and stay as they are.
    Unit.M: (Unit.M, _ONE),
}


def to_base(quantity, unit):
    """Convert a quantity to its base unit: g -> kg, ml -> l, the rest unchanged.

    Returns ``(Decimal, Unit)``. Floats are rejected: their binary error would
    leak into normalized prices.
    """
    if isinstance(quantity, (float, bool)):
        raise TypeError("quantity: expected Decimal, int or a decimal string.")
    try:
        base_unit, factor = _TO_BASE[Unit(unit)]
    except ValueError:
        raise ValueError(f"unit: unknown unit {unit!r}.") from None
    return Decimal(quantity) * factor, base_unit
