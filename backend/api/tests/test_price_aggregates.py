from datetime import date, time
from decimal import Decimal

from django.test import TestCase, tag

from api.tests import factories
from api.tests.factories import observe
from catalog.models import Product
from catalog.units import Unit
from receipts.models import Receipt
from receipts.prices import (
    PriceGroup, comparable_q, last_prices, observation_q, price_groups, price_history, price_summary,
)
from receipts.tests import samples
from receipts.tests.test_models import make_line

D = Decimal
SEP_28, OCT_1 = date(2026, 9, 28), date(2026, 10, 1)


def keys(groups):
    return [(group.product_id, group.country, group.currency) for group in groups]


@tag("integration")
class NormalizedUnitTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = factories.save_samples()

    def test_unit_by_line_unit_and_package(self):
        receipt = factories.make_receipt(self.data.lidl_store, "EUR", date(2026, 7, 20))
        cases = [
            # (единица строки, количество, цена, сумма, фасовка товара, цена за базовую единицу, её единица)
            (Unit.G, "150", "0.0199", "2.99", None, "19.9333", "kg"),
            (Unit.KG, "0.294", "2.99", "0.88", None, "2.9932", "kg"),
            (Unit.ML, "500", "0.0030", "1.50", None, "3.0000", "l"),
            (Unit.L, "2", "1.20", "2.40", None, "1.2000", "l"),
            (Unit.PCS, "2", "1.49", "2.98", ("500", Unit.G), "2.9800", "kg"),
            (Unit.PCS, "1", "1.49", "1.49", ("0.5", Unit.KG), "2.9800", "kg"),
            (Unit.PCS, "1", "0.85", "0.85", ("850", Unit.ML), "1.0000", "l"),
            (Unit.PCS, "1", "2.79", "2.79", ("1.5", Unit.L), "1.8600", "l"),
            (Unit.PCS, "1", "3.29", "3.29", ("10", Unit.PCS), "0.3290", "pcs"),
            (Unit.PCS, "1", "4.50", "4.50", ("3", Unit.M), "1.5000", "m"),
            (Unit.PCS, "1", "4.50", "4.50", None, None, None),  # штучная без фасовки
            (Unit.M, "2", "1.10", "2.20", None, None, None),  # метры не приводятся
            # Весовая строка: фасовка товара не применяется, единица — от строки.
            (Unit.KG, "0.5", "4.00", "2.00", ("1", Unit.L), "4.0000", "kg"),
        ]
        for position, (unit, quantity, unit_price, amount, package, *_) in enumerate(cases, start=1):
            product = package and factories.make_product(self.data.milk, f"Фасовка {position}", package=package)
            make_line(
                receipt, position=position, raw_name=f"case {position}", unit=unit, quantity=D(quantity),
                unit_price=D(unit_price), amount=D(amount), product=product or None,
            )
        found = {
            position: (price, unit) for position, price, unit in
            price_history().filter(receipt=receipt).values_list("position", "normalized_price", "normalized_unit")
        }
        for position, case in enumerate(cases, start=1):
            with self.subTest(case=case):
                self.assertEqual(found[position], (case[-2] and D(case[-2]), case[-1]))

    def test_unit_is_null_exactly_where_price_is_null(self):
        factories.unit_mismatch(self.data)
        factories.piece_without_package(self.data)
        rows = list(price_history().values_list("normalized_price", "normalized_unit"))
        self.assertTrue(any(price is None for price, _ in rows) and any(price is not None for price, _ in rows))
        for price, unit in rows:
            self.assertEqual(price is None, unit is None)

    def test_samples(self):
        shop_milk = price_history(product=self.data.shop_milk).get()
        self.assertEqual((shop_milk.normalized_price, shop_milk.normalized_unit), (D("130.5882"), "l"))
        self.assertEqual(set(price_history(product=self.data.lidl_milk).values_list("normalized_unit", flat=True)), {None})
        onion = price_history().get(raw_name=samples.ONION)
        self.assertEqual((onion.normalized_unit, onion.product_id), ("kg", None))

    def test_history_with_unit_is_still_one_query(self):
        with self.assertNumQueries(1):
            list(price_history(product=self.data.shop_milk))

    def test_comparable_q(self):
        mismatch = factories.unit_mismatch(self.data)
        comparable = set(price_history().filter(comparable_q()).values_list("pk", flat=True))
        self.assertEqual(comparable, {price_history(product=self.data.shop_milk).get().pk})
        # Цена за кг есть, но у «Молока» base_unit — литр; несопоставленный лук несравним: товара нет.
        self.assertNotIn(mismatch.pk, comparable)
        self.assertEqual(price_history().get(pk=mismatch.pk).normalized_price, D("3.0000"))

    def test_observation_q_from_product(self):
        unsold = factories.make_product(self.data.milk, "Молоко без покупок")
        refund = factories.make_receipt(self.data.lidl_store, "EUR", OCT_1, operation=Receipt.Operation.REFUND)
        make_line(refund, product=unsold)
        observed = Product.objects.filter(observation_q("receipt_lines__")).distinct()
        self.assertEqual(set(observed), {self.data.shop_milk, self.data.lidl_milk, self.data.ssd})


@tag("integration")
class PriceAggregateTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = factories.save_samples()
        cls.shop_milk, cls.lidl_milk, cls.ssd = cls.data.shop_milk, cls.data.lidl_milk, cls.data.ssd
        cls.products = [cls.shop_milk, cls.lidl_milk, cls.ssd]

    # --- группы ---

    def test_groups_of_samples(self):
        with self.assertNumQueries(1):
            groups = price_groups(self.products)
        self.assertEqual(groups, [
            PriceGroup(self.shop_milk.pk, "RU", "RUB", 1, 1, D("130.5882"), D("130.5882"), D("130.5882")),
            # Фасовка не задана: наблюдения есть, сравнимых нет.
            PriceGroup(self.lidl_milk.pk, "DE", "EUR", 6, 0, None, None, None),
            PriceGroup(self.ssd.pk, "KZ", "KZT", 1, 0, None, None, None),
        ])

    def test_min_max_avg_over_comparable_observations(self):
        observe(self.shop_milk, self.data.shop_store, "RUB", date(2026, 7, 10), "100.00")  # 117,6471 за литр
        observe(self.shop_milk, self.data.shop_store, "RUB", date(2026, 10, 5), "120.00")  # 141,1765
        (group,) = price_groups([self.shop_milk])
        self.assertEqual((group.observations, group.comparable_observations), (3, 3))
        self.assertEqual((group.normalized_min, group.normalized_max), (D("117.6471"), D("141.1765")))
        # (117,6471 + 130,5882 + 141,1765) / 3 = 129,80393…
        self.assertEqual(group.normalized_avg, D("129.8039"))
        self.assertEqual(group.normalized_avg.as_tuple().exponent, -4)

    def test_avg_rounds_half_up(self):
        product = factories.make_product(self.data.milk, "Молоко 1 л", package=("1", Unit.L))
        observe(product, self.data.lidl_store, "EUR", date(2026, 7, 1), "1.0000")
        observe(product, self.data.lidl_store, "EUR", date(2026, 7, 2), "1.0001", quantity="10000")
        (group,) = price_groups([product])
        self.assertEqual((group.normalized_min, group.normalized_max), (D("1.0000"), D("1.0001")))
        self.assertEqual(group.normalized_avg, D("1.0001"))  # 1,00005 -> вверх, а не к чётному

    def test_mixed_currencies_are_separate_groups(self):
        factories.second_currency(self.data)  # тот же товар, тот же магазин RU, чек в EUR
        groups = price_groups([self.shop_milk])
        self.assertEqual(groups, [
            PriceGroup(self.shop_milk.pk, "RU", "EUR", 1, 1, D("1.4118"), D("1.4118"), D("1.4118")),
            PriceGroup(self.shop_milk.pk, "RU", "RUB", 1, 1, D("130.5882"), D("130.5882"), D("130.5882")),
        ])
        # Ни в одной группе нет числа, смешивающего 1,41 EUR и 130,59 RUB.
        self.assertEqual(sum(group.observations for group in groups), 2)

    def test_same_currency_in_two_countries_are_separate_groups(self):
        observe(self.lidl_milk, self.data.shop_store, "EUR", date(2026, 7, 1), "1.50")
        self.assertEqual(keys(price_groups([self.lidl_milk])), [
            (self.lidl_milk.pk, "DE", "EUR"), (self.lidl_milk.pk, "RU", "EUR"),
        ])

    def test_unit_mismatch_and_piece_without_package_are_not_comparable(self):
        mismatch, piece = factories.unit_mismatch(self.data), factories.piece_without_package(self.data)
        groups = {group.product_id: group for group in price_groups([mismatch.product, piece.product])}
        for line in (mismatch, piece):
            group = groups[line.product_id]
            self.assertEqual((group.observations, group.comparable_observations), (1, 0))
            self.assertEqual((group.normalized_min, group.normalized_max, group.normalized_avg), (None, None, None))

    def test_only_price_observations_are_counted(self):
        store = self.data.shop_store
        sale = factories.make_receipt(store, "RUB", OCT_1)
        make_line(sale, position=1, kind="service", raw_name="Доставка", product=self.shop_milk)
        make_line(sale, position=2, kind="deposit", raw_name="Залог", product=self.shop_milk)
        make_line(sale, position=3, product=self.shop_milk, quantity=D("-1"), amount=D("-10.00"))
        refund = factories.make_receipt(store, "RUB", OCT_1, operation=Receipt.Operation.REFUND)
        make_line(refund, product=self.shop_milk)
        (group,) = price_groups([self.shop_milk])
        self.assertEqual((group.observations, group.normalized_max), (1, D("130.5882")))
        self.assertEqual(len(last_prices([self.shop_milk])), 1)

    def test_line_discount_is_in_price(self):
        observe(self.shop_milk, self.data.shop_store, "RUB", date(2026, 10, 5), "111.00", discount="26.00")
        (group,) = price_groups([self.shop_milk])
        self.assertEqual(group.normalized_min, D("100.0000"))  # (111 - 26) / 0,85

    def test_filters(self):
        factories.second_currency(self.data, on=date(2026, 7, 1))
        cases = [
            ({}, [(self.shop_milk.pk, "RU", "EUR"), (self.shop_milk.pk, "RU", "RUB"),
                  (self.lidl_milk.pk, "DE", "EUR"), (self.ssd.pk, "KZ", "KZT")]),
            ({"countries": ["RU"]}, [(self.shop_milk.pk, "RU", "EUR"), (self.shop_milk.pk, "RU", "RUB")]),
            ({"countries": ["DE", "KZ"]}, [(self.lidl_milk.pk, "DE", "EUR"), (self.ssd.pk, "KZ", "KZT")]),
            ({"countries": []}, []),
            ({"currency": "EUR"}, [(self.shop_milk.pk, "RU", "EUR"), (self.lidl_milk.pk, "DE", "EUR")]),
            ({"currency": "EUR", "countries": ["RU"]}, [(self.shop_milk.pk, "RU", "EUR")]),
            ({"store": self.data.lidl_store}, [(self.lidl_milk.pk, "DE", "EUR")]),
            ({"store": self.data.shop_store.pk, "currency": "RUB"}, [(self.shop_milk.pk, "RU", "RUB")]),
            ({"date_from": SEP_28, "date_to": SEP_28}, [(self.shop_milk.pk, "RU", "RUB")]),
            ({"date_to": date(2026, 6, 30)}, [(self.lidl_milk.pk, "DE", "EUR")]),
            ({"date_from": date(2027, 1, 1)}, []),
        ]
        for filters, expected in cases:
            with self.subTest(filters=filters):
                self.assertEqual(sorted(keys(price_groups(self.products, **filters))), sorted(expected))
                self.assertEqual(sorted(keys(price_groups(self.products, **filters))), keys(price_groups(self.products, **filters)))
                last = last_prices(self.products, **filters)
                self.assertEqual(
                    sorted((line.product_id, line.receipt.store.country_id, line.currency_code) for line in last),
                    sorted(expected),
                )

    def test_date_window_narrows_statistics(self):
        (june,) = price_groups([self.lidl_milk], date_to=date(2026, 6, 30))
        (october,) = price_groups([self.lidl_milk], date_from=OCT_1)
        self.assertEqual((june.observations, october.observations), (4, 1))
        (last,) = last_prices([self.lidl_milk], date_to=date(2026, 6, 30))
        self.assertEqual((last.receipt.purchased_on, last.paid_unit_price), (date(2026, 6, 29), D("1.0500")))

    def test_products_as_keys_and_empty_set(self):
        self.assertEqual(keys(price_groups([self.ssd.pk])), [(self.ssd.pk, "KZ", "KZT")])
        with self.assertNumQueries(0):
            self.assertEqual(price_groups([]), [])
            self.assertEqual(last_prices([]), [])
            self.assertEqual(price_summary([]), {})

    # --- последняя цена ---

    def test_last_prices_of_samples(self):
        with self.assertNumQueries(1):
            last = last_prices(self.products)
            described = [
                (line.product_id, line.receipt.store.country_id, line.currency_code, line.receipt.purchased_on,
                 line.paid_unit_price, line.normalized_price, line.normalized_unit, line.receipt.store.merchant.pk)
                for line in last
            ]
        stores = self.data
        self.assertEqual(described, [
            (self.shop_milk.pk, "RU", "RUB", SEP_28, D("111.0000"), D("130.5882"), "l", stores.shop_store.merchant_id),
            (self.lidl_milk.pk, "DE", "EUR", OCT_1, D("1.0900"), None, None, stores.lidl_store.merchant_id),
            (self.ssd.pk, "KZ", "KZT", self.data.dns.purchased_on, D("189490.0000"), None, None,
             stores.dns_store.merchant_id),
        ])

    def test_last_is_by_moment_then_receipt_then_position(self):
        store = self.data.shop_store
        # Тот же момент, что у следующего чека: решает receipt_id.
        first = observe(self.shop_milk, store, "RUB", OCT_1, "101.00", at=time(10, 0))
        second = observe(self.shop_milk, store, "RUB", OCT_1, "102.00", at=time(10, 0))
        self.assertLess(first.receipt_id, second.receipt_id)
        self.assertEqual(last_prices([self.shop_milk])[0].pk, second.pk)
        # Две строки одного чека: решает position.
        make_line(second.receipt, position=5, product=self.shop_milk, unit_price=D("103.00"), amount=D("103.00"))
        make_line(second.receipt, position=3, product=self.shop_milk, unit_price=D("104.00"), amount=D("104.00"))
        self.assertEqual(last_prices([self.shop_milk])[0].paid_unit_price, D("103.0000"))
        # Более поздний момент побеждает больший receipt_id и position.
        observe(self.shop_milk, store, "RUB", date(2026, 9, 1), "90.00")
        later = observe(self.shop_milk, store, "RUB", OCT_1, "105.00", at=time(10, 1), position=1)
        self.assertEqual(last_prices([self.shop_milk])[0].pk, later.pk)

    def test_last_matches_tail_of_price_history(self):
        observe(self.lidl_milk, self.data.shop_store, "EUR", date(2026, 7, 1), "1.50")
        factories.second_currency(self.data)
        for line in last_prices(self.products):
            with self.subTest(product=line.product_id, currency=line.currency_code):
                history = price_history(product=line.product_id, country=line.receipt.store.country_id).filter(
                    receipt__currency=line.currency_code,
                )
                self.assertEqual(line.pk, history.last().pk)

    def test_last_comparable_only(self):
        # Последняя покупка — весовая в кг, несравнимая с литром; сравнимая — более ранняя.
        observe(self.shop_milk, self.data.shop_store, "RUB", date(2026, 10, 5), "200.00", unit=Unit.KG)
        (last,) = last_prices([self.shop_milk])
        (comparable,) = last_prices([self.shop_milk], comparable_only=True)
        self.assertEqual((last.normalized_unit, last.receipt.purchased_on), ("kg", date(2026, 10, 5)))
        self.assertEqual((comparable.normalized_price, comparable.receipt.purchased_on), (D("130.5882"), SEP_28))
        self.assertEqual(last_prices([self.lidl_milk], comparable_only=True), [])

    # --- сводка ---

    def test_summary_of_samples(self):
        unsold = factories.make_product(self.data.milk, "Молоко без покупок")
        with self.assertNumQueries(2):
            summary = price_summary([*self.products, unsold])
            for groups in summary.values():
                for group in groups:
                    group.last.receipt.store.merchant.brand_name  # загружено, без запросов
        self.assertEqual(set(summary), {product.pk for product in self.products})
        (milk,) = summary[self.shop_milk.pk]
        self.assertEqual((milk.country, milk.currency, milk.observations), ("RU", "RUB", 1))
        self.assertEqual((milk.last.paid_unit_price, milk.last.normalized_unit), (D("111.0000"), "l"))
        self.assertEqual(milk.last.receipt.store, self.data.shop_store)
        (lidl,) = summary[self.lidl_milk.pk]
        self.assertEqual((lidl.observations, lidl.normalized_avg, lidl.last.paid_unit_price), (6, None, D("1.0900")))

    def test_summary_groups_mixed_currencies_separately(self):
        euro = factories.second_currency(self.data, on=date(2026, 10, 5))
        groups = price_summary([self.shop_milk])[self.shop_milk.pk]
        self.assertEqual([(group.country, group.currency) for group in groups], [("RU", "EUR"), ("RU", "RUB")])
        self.assertEqual([group.last.pk for group in groups], [euro.pk, price_history(product=self.shop_milk).first().pk])
        self.assertEqual([group.last.currency_code for group in groups], ["EUR", "RUB"])
        self.assertEqual([group.normalized_avg for group in groups], [D("1.4118"), D("130.5882")])

    def test_summary_query_count_does_not_grow_with_products(self):
        products = list(self.products)
        for number in range(12):
            product = factories.make_product(self.data.milk, f"Молоко {number}", package=("1", Unit.L))
            store, currency = ((self.data.lidl_store, "EUR"), (self.data.shop_store, "RUB"))[number % 2]
            observe(product, store, currency, date(2026, 8, 1 + number), "1.00")
            observe(product, store, currency, date(2026, 8, 2 + number), "2.00")
            products.append(product)
        with self.assertNumQueries(2):
            summary = price_summary(products, date_from=date(2026, 6, 1))
        self.assertEqual(len(summary), 15)
        self.assertEqual({len(groups) for groups in summary.values()}, {1})

    def test_summary_filters(self):
        factories.second_currency(self.data)
        summary = price_summary(self.products, countries=["RU"], currency="EUR")
        self.assertEqual(list(summary), [self.shop_milk.pk])
        self.assertEqual(price_summary(self.products, date_from=date(2027, 1, 1)), {})
