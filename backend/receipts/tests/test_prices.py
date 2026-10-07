from datetime import date
from decimal import Decimal

from django.test import TestCase, tag

from catalog.models import Product
from catalog.units import Unit
from receipts.models import Receipt, ReceiptDiscount, ReceiptLine
from receipts.ownership import local_user
from receipts.prices import price_history
from receipts.tests import samples
from receipts.tests.test_models import make_line

D = Decimal
JUN_2, JUN_9, JUN_17, JUN_29, JUL_6, OCT_1 = (
    date(2026, 6, 2), date(2026, 6, 9), date(2026, 6, 17), date(2026, 6, 29), date(2026, 7, 6), date(2026, 10, 1),
)


@tag("integration")
class PriceHistoryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.dns = samples.save_dns_kz()
        cls.shop = samples.save_shop_ru()
        cls.lidl = samples.save_lidl_de()
        cls.catalog = samples.save_catalog()
        cls.lidl_store = cls.lidl[0].store
        cls.lidl_milk = cls.catalog["lidl_milk"]
        cls.shop_milk = cls.catalog["shop_milk"]

    def series(self, lines):
        """Ряд цен: (локальная дата чека, цена до скидки, цена после скидки)."""
        return list(lines.values_list("receipt__purchased_on", "list_unit_price", "paid_unit_price"))

    def by_name(self, raw_name, **filters):
        """История несопоставленного товара: продавец и название с чека."""
        return price_history(**filters).filter(receipt__store__merchant=self.lidl_store.merchant, raw_name=raw_name)

    def extra_receipt(self, **fields):
        """Чек Lidl вне образцов — для строк, которых в образцах нет."""
        fields.setdefault("purchased_at", samples.local("Europe/Berlin", 2026, 7, 20, 12, 0))
        fields.setdefault("purchased_on", fields["purchased_at"].date())
        fields.setdefault("operation", Receipt.Operation.SALE)
        fields.setdefault("total", D("0.00"))
        return Receipt.objects.create(owner=local_user(), store=self.lidl_store, currency_id="EUR", **fields)

    # --- ряд цен ---

    def test_price_series_of_one_product_over_six_lidl_receipts(self):
        self.assertEqual(
            self.series(price_history(product=self.lidl_milk)),
            [
                (JUN_2, D("1.05"), D("1.05")),
                (JUN_9, D("1.05"), D("1.05")),
                (JUN_17, D("1.05"), D("1.05")),
                (JUN_29, D("1.05"), D("1.05")),
                (JUL_6, D("1.05"), D("1.05")),  # 1,05 x 2 = 2,10
                (OCT_1, D("1.09"), D("1.09")),
            ],
        )

    def test_annotations_come_from_receipt(self):
        lines = list(price_history(product=self.lidl_milk))
        self.assertEqual([line.observed_at for line in lines], [receipt.purchased_at for receipt in self.lidl])
        self.assertEqual({line.currency_code for line in lines}, {"EUR"})
        self.assertEqual(
            {line.currency_code for line in price_history(store=self.shop.store)}, {"RUB"},
        )
        self.assertEqual(price_history(store=self.dns.store).get().currency_code, "KZT")

    def test_history_is_one_query(self):
        with self.assertNumQueries(1):
            self.series(price_history(product=self.lidl_milk))

    def test_paid_unit_price_of_discounted_barilla(self):
        self.assertEqual(
            self.series(self.by_name(samples.BARILLA)),
            [
                (JUN_17, D("1.99"), D("1.99")),
                (JUN_29, D("1.99"), D("0.99")),  # (3,98 - 2,00) / 2
                (OCT_1, D("1.99"), D("1.99")),
            ],
        )

    def test_paid_unit_price_of_single_discounted_line(self):
        line = self.by_name(samples.LEERDAMMER).get()
        self.assertEqual((line.list_unit_price, line.paid_unit_price), (D("2.89"), D("2.69")))

    def test_receipt_wide_discount_is_not_spread_over_lines(self):
        ReceiptDiscount.objects.create(receipt=self.lidl[0], position=1, name="Coupon", amount=D("1.00"))
        self.assertEqual(self.series(price_history(product=self.lidl_milk))[0], (JUN_2, D("1.05"), D("1.05")))

    def test_history_of_unmatched_product_by_raw_name(self):
        lines = self.by_name(samples.KEFIR)
        self.assertEqual(
            self.series(lines),
            [(JUN_9, D("1.29"), D("1.29")), (JUN_29, D("1.29"), D("1.29")), (OCT_1, D("1.29"), D("1.29"))],
        )
        self.assertEqual({line.product_id for line in lines}, {None})

    def test_history_of_unmatched_product_by_store_item_code(self):
        line = price_history().filter(receipt__store__merchant=self.shop.store.merchant, store_item_code="1346").get()
        self.assertEqual((line.raw_name, line.paid_unit_price, line.product), ("Пряники Яшкино Мятные 350гр", 98, None))

    # --- нормализованная цена ---

    def test_normalized_price_of_weighed_onion(self):
        onion = self.by_name(samples.ONION).get()
        # (0,88 - 0) / 0,294 = 2,9932: цена за кг после округления суммы строки до цента.
        self.assertEqual((onion.list_unit_price, onion.paid_unit_price), (D("2.99"), D("2.9932")))
        self.assertEqual(onion.normalized_price, onion.paid_unit_price)
        self.assertEqual(onion.normalized_price.quantize(D("0.01")), D("2.99"))

    def test_normalized_price_of_milk_by_package(self):
        milk = price_history(product=self.shop_milk).get()
        self.assertEqual((milk.list_unit_price, milk.paid_unit_price), (D("111.00"), D("111.00")))
        self.assertEqual(milk.normalized_price, D("130.5882"))  # 111,00 / 0,85 л
        self.assertEqual(milk.normalized_price.quantize(D("0.01")), D("130.59"))

    def test_normalized_price_is_null_without_package_or_weight(self):
        # Товар Lidl сопоставлен, но фасовка не задана; SSD — штучный без фасовки; Barilla не сопоставлена.
        self.assertEqual({line.normalized_price for line in price_history(product=self.lidl_milk)}, {None})
        self.assertIsNone(price_history(store=self.dns.store).get().normalized_price)
        self.assertEqual({line.normalized_price for line in self.by_name(samples.BARILLA)}, {None})

    def test_normalized_price_by_unit_and_package(self):
        generic = self.shop_milk.generic
        receipt = self.extra_receipt()
        cases = [
            # (единица строки, количество, цена, сумма, фасовка товара, ожидаемая цена за базовую единицу)
            (Unit.G, "150", "0.0199", "2.99", None, "19.9333"),  # 2,99 / 150 г -> за кг
            (Unit.ML, "500", "0.0030", "1.50", None, "3.0000"),
            (Unit.L, "2", "1.20", "2.40", None, "1.2000"),
            (Unit.PCS, "2", "1.49", "2.98", ("500", Unit.G), "2.9800"),  # 1,49 за 0,5 кг
            (Unit.PCS, "1", "2.79", "2.79", ("1.5", Unit.L), "1.8600"),
            (Unit.PCS, "1", "3.29", "3.29", ("10", Unit.PCS), "0.3290"),  # десяток яиц -> за штуку
            (Unit.PCS, "1", "4.50", "4.50", ("3", Unit.M), "1.5000"),
            (Unit.M, "2", "1.10", "2.20", None, None),  # метры не приводятся к кг / л / шт
            # Весовая строка: фасовка товара не применяется.
            (Unit.KG, "0.5", "4.00", "2.00", ("250", Unit.G), "4.0000"),
        ]
        for position, (unit, quantity, unit_price, amount, package, expected) in enumerate(cases, start=1):
            product = None
            if package:
                product = Product.objects.create(
                    generic=generic, name=f"Фасовка {position}", package_quantity=D(package[0]), package_unit=package[1],
                )
            make_line(
                receipt, position=position, raw_name=f"case {position}", unit=unit, quantity=D(quantity),
                unit_price=D(unit_price), amount=D(amount), product=product,
            )
        found = dict(price_history().filter(receipt=receipt).values_list("position", "normalized_price"))
        for position, case in enumerate(cases, start=1):
            with self.subTest(case=case):
                self.assertEqual(found[position], case[-1] and D(case[-1]))

    # --- что не входит в выборку ---

    def test_deposits_and_deposit_returns_are_excluded(self):
        lidl_lines = ReceiptLine.objects.filter(receipt__in=self.lidl)
        self.assertEqual(lidl_lines.filter(kind="deposit").count(), 6)
        self.assertEqual(lidl_lines.filter(kind="deposit_return").count(), 3)
        history = price_history(store=self.lidl_store)
        self.assertEqual(set(history.values_list("kind", flat=True)), {"product"})
        self.assertEqual(history.count(), lidl_lines.count() - 9)
        self.assertFalse(history.filter(raw_name__startswith="Pfand").exists())
        # Цена напитка — без залога.
        self.assertEqual(
            self.series(self.by_name("Fanta Orange")),
            [(JUN_2, D("0.99"), D("0.99")), (JUN_29, D("0.99"), D("0.99"))],
        )

    def test_services_refunds_and_negative_quantities_are_excluded(self):
        before = price_history().count()
        sale = self.extra_receipt()
        make_line(sale, position=1, kind="service", raw_name="Lieferung", unit_price=D("4.99"), amount=D("4.99"))
        make_line(
            sale, position=2, raw_name=samples.MILK, product=self.lidl_milk, quantity=D("-1"),
            unit_price=D("1.05"), amount=D("-1.05"),
        )
        refund = self.extra_receipt(operation=Receipt.Operation.REFUND, receipt_number="refund")
        make_line(refund, raw_name=samples.MILK, product=self.lidl_milk, unit_price=D("0.50"), amount=D("0.50"))

        self.assertEqual(price_history().count(), before)
        self.assertEqual(price_history(product=self.lidl_milk).count(), 6)
        self.assertFalse(price_history().filter(receipt__in=[sale, refund]).exists())

    # --- фильтры ---

    def test_without_filters_all_product_lines_are_returned_in_time_order(self):
        history = list(price_history())
        self.assertEqual(len(history), ReceiptLine.objects.filter(kind="product", quantity__gt=0).count())
        self.assertEqual(
            [(line.observed_at, line.receipt_id, line.position) for line in history],
            sorted((line.observed_at, line.receipt_id, line.position) for line in history),
        )
        self.assertEqual({line.currency_code for line in history}, {"EUR", "KZT", "RUB"})

    def test_filter_by_product(self):
        self.assertEqual({line.product for line in price_history(product=self.lidl_milk)}, {self.lidl_milk})
        self.assertEqual(price_history(product=self.shop_milk.pk).count(), 1)
        self.assertEqual(price_history(product=self.catalog["ssd"]).get().paid_unit_price, D("189490"))

    def test_filter_by_generic(self):
        generic = self.lidl_milk.generic
        history = price_history(generic=generic)
        self.assertEqual(history.count(), 7)
        self.assertEqual({line.product for line in history}, {self.lidl_milk, self.shop_milk})
        self.assertEqual(price_history(generic=generic, country="RU").get().product, self.shop_milk)
        self.assertEqual(price_history(generic=generic, country="DE").count(), 6)
        self.assertEqual(price_history(generic=self.catalog["ssd"].generic).count(), 1)

    def test_filter_by_store(self):
        self.assertEqual(price_history(store=self.shop.store).count(), 4)
        self.assertEqual(price_history(store=self.dns.store.pk).count(), 1)
        self.assertEqual(
            set(price_history(store=self.lidl_store).values_list("receipt__store", flat=True)), {self.lidl_store.pk},
        )
        self.assertFalse(price_history(store=self.shop.store, product=self.lidl_milk).exists())

    def test_filter_by_country(self):
        self.assertEqual(price_history(country="RU").count(), 4)
        self.assertEqual(price_history(country=self.dns.store.country).count(), 1)
        self.assertEqual(price_history(country="DE").count(), price_history(store=self.lidl_store).count())
        self.assertFalse(price_history(country="DE", product=self.shop_milk).exists())

    def test_filter_by_dates_is_inclusive(self):
        def dates(**filters):
            return [row[0] for row in self.series(price_history(product=self.lidl_milk, **filters))]

        self.assertEqual(dates(date_from=JUN_17), [JUN_17, JUN_29, JUL_6, OCT_1])
        self.assertEqual(dates(date_to=JUN_17), [JUN_2, JUN_9, JUN_17])
        self.assertEqual(dates(date_from=JUN_9, date_to=JUL_6), [JUN_9, JUN_17, JUN_29, JUL_6])
        self.assertEqual(dates(date_from=JUN_29, date_to=JUN_29), [JUN_29])
        self.assertEqual(dates(date_from=date(2026, 7, 7), date_to=date(2026, 9, 30)), [])
        self.assertEqual(price_history(date_from=date(2026, 9, 1)).count(), 1 + 4 + 4)  # ДНС, магазин, Lidl 01.10
