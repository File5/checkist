from decimal import Decimal

from django.test import SimpleTestCase

from catalog.units import BaseUnit, Unit, to_base


class UnitTests(SimpleTestCase):
    def test_unit_values(self):
        self.assertEqual(Unit.values, ["pcs", "g", "kg", "ml", "l", "m"])
        self.assertEqual(BaseUnit.values, ["kg", "l", "pcs"])
        self.assertLessEqual(set(BaseUnit.values), set(Unit.values))


class ToBaseTests(SimpleTestCase):
    def test_grams_to_kilograms(self):
        self.assertEqual(to_base(Decimal("850"), Unit.G), (Decimal("0.850"), Unit.KG))
        self.assertEqual(to_base(Decimal("0.5"), "g"), (Decimal("0.0005"), "kg"))

    def test_millilitres_to_litres(self):
        self.assertEqual(to_base(Decimal("350"), Unit.ML), (Decimal("0.350"), Unit.L))
        self.assertEqual(to_base(1500, "ml"), (Decimal("1.5"), "l"))

    def test_pieces_stay_pieces(self):
        self.assertEqual(to_base(Decimal("3"), Unit.PCS), (Decimal("3"), Unit.PCS))
        self.assertEqual(to_base(-4, "pcs"), (Decimal("-4"), "pcs"))

    def test_base_units_and_metres_are_unchanged(self):
        for unit in (Unit.KG, Unit.L, Unit.M):
            with self.subTest(unit=unit):
                self.assertEqual(to_base(Decimal("0.294"), unit), (Decimal("0.294"), unit))

    def test_result_is_exact_decimal(self):
        quantity, unit = to_base("449", "g")
        self.assertIsInstance(quantity, Decimal)
        self.assertIsInstance(unit, Unit)
        self.assertEqual(str(quantity), "0.449")

    def test_every_unit_is_convertible(self):
        for unit in Unit:
            with self.subTest(unit=unit):
                self.assertEqual(to_base(Decimal(0), unit)[0], Decimal(0))

    def test_unknown_unit_is_rejected(self):
        for unit in ("", "oz", None):
            with self.subTest(unit=unit), self.assertRaises(ValueError):
                to_base(Decimal("1"), unit)

    def test_float_quantity_is_rejected(self):
        with self.assertRaises(TypeError):
            to_base(0.1, Unit.KG)
