from datetime import date
from decimal import Decimal

from django.test import SimpleTestCase

from receipts import basket
from receipts.basket import BASE, CURRENT, Collected, Purchase, Visits
from receipts.decimal_math import round_decimal

D = Decimal


def visits(count, total, lines, median=None):
    return Visits(count, D(total), None if median is None else D(median), lines)


def bought(product, unit, paid, quantity, lines=1):
    return Purchase(product, unit, D(paid), D(quantity), lines)


# Два похода по 10.00 с двумя позициями против двух по 18.00 с тремя: n 2 → 3, p 5 → 6.
SMALL, LARGE = visits(2, "20.00", 4), visits(2, "36.00", 6)
# Товар 1 подорожал с 2.00 до 2.50 за штуку, товар 2 стоит 4.00 за кг в обоих периодах.
OLD = [bought(1, "pcs", "4.00", "2"), bought(2, "kg", "6.00", "1.5"), bought(3, "pcs", "6.00", "1")]
NEW = [bought(1, "pcs", "7.50", "3"), bought(2, "kg", "4.00", "1"), bought(None, "pcs", "11.50", "2")]


def index(base=OLD, current=NEW):
    return basket.price_index(basket.match(base, current), basket._paid(base), basket._paid(current))


class VisitsTests(SimpleTestCase):
    def test_derived_values_keep_the_identity(self):
        found = visits(3, "24.00", 7)
        self.assertEqual(round_decimal(found.avg_receipt, 2), D("8.00"))
        self.assertEqual(round_decimal(found.lines_per_receipt, 2), D("2.33"))
        self.assertEqual(round_decimal(found.paid_per_line, 4), D("3.4286"))
        # a = n × p
        self.assertEqual(round_decimal(found.lines_per_receipt * found.paid_per_line, 20), D(8))

    def test_nothing_to_divide(self):
        empty = Visits()
        self.assertEqual((empty.receipts_count, empty.total, empty.median, empty.lines_count), (0, D("0.00"), None, 0))
        self.assertIsNone(empty.avg_receipt)
        self.assertIsNone(empty.lines_per_receipt)
        self.assertIsNone(empty.paid_per_line)
        without_lines = visits(2, "9.00", 0)
        self.assertEqual(without_lines.avg_receipt, D("4.5"))
        self.assertEqual(without_lines.lines_per_receipt, D(0))
        self.assertIsNone(without_lines.paid_per_line)

    def test_months(self):
        self.assertEqual(round_decimal(basket.months(date(2020, 1, 1), date(2020, 12, 31)), 2), D("12.02"))
        self.assertEqual(round_decimal(basket.months(date(2021, 1, 1), date(2021, 12, 31)), 2), D("11.99"))
        self.assertEqual(round_decimal(basket.months(date(2026, 1, 1), date(2026, 10, 6)), 2), D("9.17"))
        self.assertEqual(round_decimal(basket.months(date(2026, 3, 1), date(2026, 3, 1)), 2), D("0.03"))
        self.assertEqual(basket.DAYS_PER_MONTH, D("30.4375"))
        self.assertEqual(round_decimal(basket.per_month(96, date(2020, 1, 1), date(2020, 12, 31)), 2), D("7.98"))
        self.assertEqual(basket.per_month(0, date(2020, 1, 1), date(2020, 1, 31)), D(0))


class MatchTests(SimpleTestCase):
    def test_same_product_and_unit_in_both_periods(self):
        found = basket.match(OLD, NEW)
        self.assertEqual([(pair.product_id, pair.unit) for pair in found], [(1, "pcs"), (2, "kg")])
        self.assertEqual((found[0].base, found[0].current), (OLD[0], NEW[0]))
        self.assertEqual((found[0].base.price, found[0].current.price), (D(2), D("2.5")))
        self.assertEqual(found[0].price_change_percent, D("25.00"))
        self.assertEqual(found[1].price_change_percent, D("0.00"))

    def test_unit_is_part_of_the_key(self):
        base = [bought(1, "pcs", "2.00", "2"), bought(1, "l", "1.60", "1")]
        current = [bought(1, "l", "2.00", "1"), bought(1, "kg", "9.00", "1")]
        self.assertEqual([(pair.product_id, pair.unit) for pair in basket.match(base, current)], [(1, "l")])

    def test_unmatched_lines_and_undefined_prices_do_not_match(self):
        self.assertEqual(basket.match([bought(None, "pcs", "5.00", "1")], [bought(None, "pcs", "6.00", "1")]), [])
        good = bought(1, "pcs", "2.00", "1")
        for bad in (bought(1, "pcs", "0.00", "1"), bought(1, "pcs", "-1.00", "1"), bought(1, "pcs", "2.00", "0")):
            with self.subTest(bad=bad):
                self.assertEqual(basket.match([good], [bad]), [])
                self.assertEqual(basket.match([bad], [good]), [])
        self.assertEqual(basket.match([], NEW), [])

    def test_price_rounding_of_an_awkward_quantity(self):
        (pair,) = basket.match([bought(1, "kg", "1.00", "0.333")], [bought(1, "kg", "2.00", "0.333")])
        self.assertEqual(round_decimal(pair.base.price, 4), D("3.0030"))
        self.assertEqual(pair.price_change_percent, D("100.00"))


class PriceIndexTests(SimpleTestCase):
    def test_laspeyres_paasche_fisher(self):
        found = index()
        # Лас = (2.5×2 + 4×1.5) / (4 + 6); Пааше = (7.5 + 4) / (2×3 + 4×1).
        self.assertEqual(found.laspeyres, D("1.1"))
        self.assertEqual(found.paasche, D("1.15"))
        self.assertEqual(round_decimal(found.fisher, 10), D("1.1247221879"))
        self.assertEqual(round_decimal(found.fisher * found.fisher, 30), D("1.265"))
        self.assertEqual(found.matched_products, 2)
        # Совпавшие 10.00 из 16.00 и 11.50 из 23.00.
        self.assertEqual((found.coverage_base_percent, found.coverage_current_percent), (D("62.5"), D(50)))

    def test_reversed_periods_give_the_inverse_index(self):
        forward, back = index(), index(NEW, OLD)
        self.assertEqual(round_decimal(forward.fisher * back.fisher, 30), D(1))
        self.assertEqual(round_decimal(back.laspeyres * forward.paasche, 30), D(1))
        self.assertLess(back.fisher, 1)

    def test_one_product(self):
        found = index([bought(1, "pcs", "75.84", "96")], [bought(1, "pcs", "95.92", "88")])
        self.assertEqual(found.laspeyres, found.paasche)
        self.assertEqual(round_decimal(found.fisher, 4), D("1.3797"))  # 1.09 / 0.79
        self.assertEqual(round_decimal(found.fisher, 4), round_decimal(found.laspeyres, 4))
        self.assertEqual((found.matched_products, found.coverage_base_percent, found.coverage_current_percent),
                         (1, D(100), D(100)))

    def test_no_matched_products(self):
        self.assertIsNone(index([bought(1, "pcs", "2.00", "1")], [bought(2, "pcs", "2.00", "1")]))
        self.assertIsNone(index([], []))
        self.assertIsNone(basket.price_index([], D("10.00"), D("10.00")))

    def test_unchanged_prices(self):
        found = index(OLD, [bought(1, "pcs", "20.00", "10"), bought(2, "kg", "2.00", "0.5")])
        self.assertEqual((found.laspeyres, found.paasche, found.fisher), (D(1), D(1), D(1)))

    def test_coverage_needs_a_positive_denominator(self):
        matches = basket.match(OLD, NEW)
        found = basket.price_index(matches, D("0.00"), D("-3.00"))
        self.assertEqual((found.coverage_base_percent, found.coverage_current_percent), (None, None))
        self.assertEqual(found.laspeyres, D("1.1"))


class ChangeTests(SimpleTestCase):
    def test_difference_of_rounded_averages(self):
        self.assertEqual(basket.change(SMALL, LARGE), (D("8.00"), D("80.00")))
        self.assertEqual(basket.change(LARGE, SMALL), (D("-8.00"), D("-44.44")))
        self.assertEqual(basket.change(SMALL, SMALL), (D("0.00"), D("0.00")))
        # 10.004 и 10.006 округляются до 10.00 и 10.01.
        self.assertEqual(basket.change(visits(500, "5002.00", 1), visits(500, "5003.00", 1)), (D("0.01"), D("0.10")))

    def test_no_receipts_or_no_positive_base(self):
        self.assertEqual(basket.change(Visits(), LARGE), (None, None))
        self.assertEqual(basket.change(SMALL, Visits()), (None, None))
        self.assertEqual(basket.change(visits(1, "0.00", 1), LARGE), (D("18.00"), None))
        self.assertEqual(basket.change(visits(1, "-2.00", 1), LARGE), (D("20.00"), None))


class DecomposeTests(SimpleTestCase):
    def assert_identity(self, effects, delta):
        self.assertEqual(effects.quantity + effects.price + effects.mix, delta)
        self.assertEqual(effects.price + effects.mix, effects.price_per_line)

    def test_growth(self):
        effects = basket.decompose(SMALL, LARGE, index().fisher)
        # количество (3 − 2) × (5 + 6) / 2; цены 2.5 × 5 × 0.12472…; состав — остаток.
        self.assertEqual((effects.quantity, effects.price, effects.mix, effects.price_per_line),
                         (D("5.50"), D("1.56"), D("0.94"), D("2.50")))
        self.assertEqual((effects.quantity_percent, effects.price_percent, effects.mix_percent),
                         (D("68.75"), D("19.50"), D("11.75")))
        self.assert_identity(effects, D("8.00"))

    def test_negative_change(self):
        effects = basket.decompose(LARGE, SMALL, index(NEW, OLD).fisher)
        self.assertEqual((effects.quantity, effects.price, effects.mix, effects.price_per_line),
                         (D("-5.50"), D("-1.66"), D("-0.84"), D("-2.50")))
        # Доли положительны: все слагаемые того же знака, что изменение.
        self.assertEqual((effects.quantity_percent, effects.price_percent, effects.mix_percent),
                         (D("68.75"), D("20.75"), D("10.50")))
        self.assert_identity(effects, D("-8.00"))

    def test_zero_change_has_no_percents(self):
        effects = basket.decompose(SMALL, SMALL, D(1))
        self.assertEqual((effects.quantity, effects.price, effects.mix, effects.price_per_line),
                         (D("0.00"), D("0.00"), D("0.00"), D("0.00")))
        self.assertEqual((effects.quantity_percent, effects.price_percent, effects.mix_percent), (None, None, None))
        # Слагаемые ненулевые, а в сумме ноль: больше позиций, но дешевле.
        effects = basket.decompose(visits(1, "12.00", 2), visits(1, "12.00", 3), D("1.1"))
        self.assertEqual((effects.quantity, effects.price, effects.mix), (D("5.00"), D("1.50"), D("-6.50")))
        self.assertEqual((effects.quantity_percent, effects.price_percent, effects.mix_percent), (None, None, None))
        self.assert_identity(effects, D("0.00"))

    def test_no_matched_products_leaves_price_and_mix_undivided(self):
        effects = basket.decompose(SMALL, LARGE)
        self.assertEqual((effects.quantity, effects.price, effects.mix, effects.price_per_line),
                         (D("5.50"), None, None, D("2.50")))
        self.assertEqual((effects.quantity_percent, effects.price_percent, effects.mix_percent),
                         (D("68.75"), None, None))

    def test_no_receipts_or_no_product_lines(self):
        for base, current in (
            (Visits(), LARGE), (SMALL, Visits()), (Visits(), Visits()),
            (visits(2, "20.00", 0), LARGE), (SMALL, visits(2, "36.00", 0)),
        ):
            with self.subTest(base=base, current=current):
                self.assertIsNone(basket.decompose(base, current, D("1.2")))
                self.assertIsNone(basket.decompose(base, current))

    def test_rounding_remainder_goes_to_mix(self):
        # Точные слагаемые 0.0050 + 0.0050 + 0: округлённые 0.01 + 0.01 дали бы 0.02 при изменении 0.01.
        base, current = visits(100, "200.00", 100), visits(100, "201.00", 100)
        self.assertEqual(basket.change(base, current)[0], D("0.01"))
        effects = basket.decompose(base, current, D("1.0025"))
        self.assertEqual((effects.quantity, effects.price, effects.mix), (D("0.00"), D("0.01"), D("0.00")))
        base, current = visits(3, "10.00", 7), visits(7, "33.00", 11)
        effects = basket.decompose(base, current, D("1.3333"))
        self.assertEqual(basket.change(base, current)[0], D("1.38"))  # 4.71 − 3.33
        self.assert_identity(effects, D("1.38"))

    def test_identity_holds_on_a_grid(self):
        fishers = (D("0.5"), D("0.9731"), D(1), D("1.2370"), D("3.3333"))
        sides = [
            visits(count, total, lines)
            for count in (1, 3, 7, 96) for total in ("0.01", "27.40", "1999.99", "-3.33") for lines in (1, 5, 1104)
        ]
        checked = 0
        for base in sides[::5]:
            for current in sides[::7]:
                delta, _ = basket.change(base, current)
                for fisher in fishers:
                    effects = basket.decompose(base, current, fisher)
                    self.assert_identity(effects, delta)
                    self.assertEqual(basket.decompose(base, current).price_per_line, effects.price_per_line)
                    checked += 1
        self.assertGreater(checked, 300)

    def test_contract_example_magnitudes(self):
        # 2020: 96 чеков, 2630.40, 1104 позиции; 2026: 71 чек, 3230.50, 1044 позиции; индекс 1.2370.
        base, current = visits(96, "2630.40", 1104), visits(71, "3230.50", 1044)
        self.assertEqual(basket.change(base, current), (D("18.10"), D("66.06")))
        effects = basket.decompose(base, current, D("1.2370"))
        self.assertEqual((effects.quantity, effects.price, effects.mix), (D("8.77"), D("7.40"), D("1.93")))
        self.assert_identity(effects, D("18.10"))


class CompareTests(SimpleTestCase):
    def data(self, **changes):
        fields = {
            "visits": {
                ("EUR", BASE): Visits(2, D("20.00"), D("10.00")), ("EUR", CURRENT): Visits(2, D("36.00"), D("18.00")),
                ("KZT", CURRENT): Visits(1, D("900.00"), D("900.00")),
            },
            "refunds": {("EUR", CURRENT): 1, ("USD", BASE): 4},
            "purchases": {
                ("EUR", BASE): [bought(1, "pcs", "4.00", "2", 2), bought(2, "kg", "6.00", "1.5"),
                                bought(3, "pcs", "6.00", "1")],
                ("EUR", CURRENT): [bought(1, "pcs", "7.50", "3", 3), bought(2, "kg", "4.00", "1"),
                                   bought(None, "pcs", "11.50", "2", 2)],
                ("KZT", CURRENT): [bought(1, "pcs", "900.00", "1")],
            },
            "names": {1: "Молоко", 2: "Яблоки"},
        }
        return Collected(**{**fields, **changes})

    def test_blocks(self):
        eur, kzt = basket.compare(self.data())
        self.assertEqual((eur.currency, kzt.currency), ("EUR", "KZT"))
        self.assertEqual((eur.base.visits, eur.current.visits), (
            Visits(2, D("20.00"), D("10.00"), 4), Visits(2, D("36.00"), D("18.00"), 6),
        ))
        self.assertEqual((eur.base.refunds_excluded, eur.current.refunds_excluded), (0, 1))
        self.assertEqual((eur.change, eur.change_percent), (D("8.00"), D("80.00")))
        self.assertEqual((eur.effects.quantity, eur.effects.price, eur.effects.mix), (D("5.50"), D("1.56"), D("0.94")))
        self.assertEqual((eur.price_index.laspeyres, eur.price_index.matched_products), (D("1.1"), 2))
        self.assertEqual((eur.price_index.coverage_base_percent, eur.price_index.coverage_current_percent),
                         (D("62.5"), D(50)))
        self.assertEqual([(pair.product_id, pair.unit) for pair in eur.products], [(1, "pcs"), (2, "kg")])
        self.assertEqual(eur.products_total, 2)

    def test_currency_with_receipts_in_one_period_only(self):
        kzt = basket.compare(self.data())[1]
        self.assertEqual((kzt.base.visits, kzt.current.visits.lines_count), (Visits(), 1))
        self.assertEqual((kzt.change, kzt.change_percent, kzt.effects, kzt.price_index), (None, None, None, None))
        self.assertEqual((kzt.products, kzt.products_total), ([], 0))

    def test_refunds_alone_do_not_make_a_block(self):
        self.assertNotIn("USD", [block.currency for block in basket.compare(self.data())])
        self.assertEqual(basket.compare(Collected({}, {("EUR", BASE): 2}, {}, {})), [])

    def test_no_product_lines(self):
        (eur,) = basket.compare(self.data(
            visits={("EUR", BASE): Visits(2, D("20.00"), D("10.00")), ("EUR", CURRENT): Visits(2, D("36.00"), D("18.00"))},
            purchases={("EUR", BASE): [bought(1, "pcs", "4.00", "2")]},
        ))
        self.assertEqual((eur.change, eur.effects, eur.price_index), (D("8.00"), None, None))
        self.assertEqual((eur.base.visits.lines_count, eur.current.visits.lines_count), (1, 0))

    def test_no_matched_products(self):
        data = self.data()
        data.purchases["EUR", CURRENT] = [bought(7, "pcs", "30.00", "6", 6)]
        eur = basket.compare(data)[0]
        self.assertIsNone(eur.price_index)
        self.assertEqual((eur.effects.quantity, eur.effects.price, eur.effects.mix, eur.effects.price_per_line),
                         (D("5.50"), None, None, D("2.50")))
        self.assertEqual((eur.products, eur.products_total), ([], 0))

    def test_products_order_and_limit(self):
        data = self.data(names={1: "Яблоки", 2: "Молоко", 3: "Молоко", 4: "Айва"})
        data.purchases["EUR", BASE] = [
            bought(1, "pcs", "4.00", "2"), bought(2, "kg", "6.00", "1"), bought(3, "pcs", "6.00", "1"),
            bought(3, "kg", "6.00", "1"), bought(4, "pcs", "1.00", "1"),
        ]
        data.purchases["EUR", CURRENT] = [
            bought(1, "pcs", "9.00", "2"), bought(2, "kg", "4.00", "1"), bought(3, "pcs", "8.00", "1"),
            bought(3, "kg", "4.00", "1"), bought(4, "pcs", "3.00", "1"),
        ]
        eur = basket.compare(data, limit=50)[0]
        # |Δ суммы| по убыванию: 5.00, затем пять раз 2.00 — по названию, id, единице.
        self.assertEqual([(pair.product_id, pair.unit) for pair in eur.products],
                         [(1, "pcs"), (4, "pcs"), (2, "kg"), (3, "kg"), (3, "pcs")])
        limited = basket.compare(data, limit=2)[0]
        self.assertEqual([(pair.product_id, pair.unit) for pair in limited.products], [(1, "pcs"), (4, "pcs")])
        self.assertEqual((limited.products_total, limited.price_index.matched_products), (5, 5))
        self.assertEqual(limited.effects, eur.effects)
