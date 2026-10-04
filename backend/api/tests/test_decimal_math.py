from decimal import Decimal, localcontext

from django.test import SimpleTestCase

from api.common import price
from receipts.decimal_math import change_percent, decimal_average, decimal_mean

D = Decimal


class PriceArithmeticTests(SimpleTestCase):
    def test_large_mean_preserves_half_up_boundary(self):
        with localcontext() as context:
            context.prec = 6
            self.assertEqual(
                price(decimal_mean([D("999999999999990000000.0000"), D("0.0001")])),
                "499999999999995000000.0001",
            )

    def test_average_of_large_sql_sum(self):
        # Около верхней границы числа строк BigAutoField; SQL numeric-сумма точная.
        self.assertEqual(
            price(decimal_average(D("8999999999999910000000000000000000000000.0000"), 9000000000000000000)),
            "999999999999990000000.0000",
        )

    def test_percent_keeps_small_difference_at_large_ratio(self):
        with localcontext() as context:
            context.prec = 6
            self.assertEqual(
                change_percent(D("0.0000000000000001"), D("999999999999989999999999000000000.0000100000000000")),
                D("999999999999989999999999000000000000009999999999900.00"),
            )
