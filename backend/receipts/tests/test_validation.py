from datetime import date, datetime, timezone
from decimal import Decimal

from django.test import tag

from catalog.units import Unit
from receipts.models import Receipt, ReceiptDiscount, ReceiptTax
from receipts.tests.test_models import ReceiptTestCase, make_line, make_receipt
from receipts.validation import validate_receipt
from stores.models import Country, TaxRate


@tag("integration")
class ValidateReceiptTests(ReceiptTestCase):
    """Согласованный чек собран в setUpTestData; каждый тест портит в нём одно место."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.tax_rate_b = TaxRate.objects.create(country=cls.country, kind="vat", rate=Decimal("19.00"), name="НДС 19%")
        cls.foreign_country = Country.objects.create(code="XB", name="Другая тестовая страна")
        cls.foreign_rate = TaxRate.objects.create(
            country=cls.foreign_country, kind="vat", rate=Decimal("7.00"), name="Чужой НДС 7%",
        )

        # 2,58 + 0,88 + 0,25 - 1,00 - 0,30 - 0,10 = 2,31
        cls.receipt = make_receipt(cls.store, cls.currency, total=Decimal("2.31"), discount_total=Decimal("0.40"))
        cls.pasta = make_line(
            cls.receipt, position=1, raw_name="Barilla Spaghetti", quantity=Decimal("2"),
            unit_price=Decimal("1.29"), amount=Decimal("2.58"), discount_amount=Decimal("0.30"),
            tax_rate=cls.tax_rate, tax_code="A",
        )
        # 0,294 x 2,99 = 0,87906 — округление в пределах допуска.
        cls.onion = make_line(
            cls.receipt, position=2, raw_name="Zwiebeln lose", quantity=Decimal("0.294"), unit=Unit.KG,
            unit_price=Decimal("2.99"), amount=Decimal("0.88"), tax_rate=cls.tax_rate, tax_code="A",
        )
        cls.deposit = make_line(
            cls.receipt, position=3, kind="deposit", parent=cls.pasta, raw_name="Pfand",
            unit_price=Decimal("0.25"), amount=Decimal("0.25"), tax_rate=cls.tax_rate_b, tax_code="B",
        )
        cls.deposit_return = make_line(
            cls.receipt, position=4, kind="deposit_return", raw_name="Pfandrückgabe", quantity=Decimal("-4"),
            unit_price=Decimal("0.25"), amount=Decimal("-1.00"), tax_rate=cls.tax_rate_b, tax_code="B",
        )
        cls.line_discount_a = ReceiptDiscount.objects.create(
            receipt=cls.receipt, line=cls.pasta, position=1, name="Preisvorteil", amount=Decimal("0.20"),
        )
        ReceiptDiscount.objects.create(
            receipt=cls.receipt, line=cls.pasta, position=2, name="Rabatt Snack", amount=Decimal("0.10"),
        )
        ReceiptDiscount.objects.create(receipt=cls.receipt, position=3, name="Купон", amount=Decimal("0.10"))
        cls.tax_a = ReceiptTax.objects.create(
            receipt=cls.receipt, tax_rate=cls.tax_rate, tax_code="A",
            net=Decimal("2.86"), tax=Decimal("0.20"), gross=Decimal("3.06"),
        )
        ReceiptTax.objects.create(
            receipt=cls.receipt, tax_rate=cls.tax_rate_b, tax_code="B",
            net=Decimal("-0.63"), tax=Decimal("-0.12"), gross=Decimal("-0.75"),
        )

    def problems(self, receipt=None):
        return validate_receipt(Receipt.objects.get(pk=(receipt or self.receipt).pk))

    def assertProblems(self, *prefixes, receipt=None):
        """В списке ровно такие нарушения; сравнение по полю, с которого начинается сообщение."""
        problems = self.problems(receipt)
        self.assertEqual(sorted(problem.split(":")[0] for problem in problems), sorted(prefixes), problems)
        return problems

    def other_receipt(self, **fields):
        fields.setdefault("receipt_number", "2")
        fields.setdefault("total", Decimal("10.00"))
        receipt = self.make_receipt(**fields)
        return receipt, make_line(receipt)

    def test_consistent_receipt_has_no_problems(self):
        self.assertEqual(self.problems(), [])

    def test_receipt_without_lines_and_with_zero_total_has_no_problems(self):
        self.assertEqual(self.problems(self.make_receipt(receipt_number="2", total=Decimal("0.00"))), [])

    def test_query_count_does_not_depend_on_number_of_lines(self):
        receipt = Receipt.objects.get(pk=self.receipt.pk)
        with self.assertNumQueries(4):  # магазин, строки, скидки, итоги по ставкам
            validate_receipt(receipt)

    def test_total_that_differs_from_lines_and_taxes(self):
        Receipt.objects.filter(pk=self.receipt.pk).update(total=Decimal("2.41"))
        problems = self.assertProblems("total", "taxes.gross")
        self.assertIn("2.31", problems[0])
        self.assertIn("2.41", problems[0])

    def test_tax_totals_that_differ_from_total(self):
        ReceiptTax.objects.filter(pk=self.tax_a.pk).update(net=Decimal("2.87"), gross=Decimal("3.07"))
        problems = self.assertProblems("taxes.gross")
        self.assertIn("2.32", problems[0])

    def test_receipt_without_tax_totals_is_not_compared_with_them(self):
        self.receipt.taxes.all().delete()
        self.assertEqual(self.problems(), [])

    def test_line_discount_amount_that_differs_from_discounts(self):
        ReceiptDiscount.objects.filter(pk=self.line_discount_a.pk).update(line=None)
        problems = self.assertProblems("line.discount_amount")
        self.assertIn("строка 1", problems[0])
        self.assertIn("0.30", problems[0])
        self.assertIn("0.10", problems[0])

    def test_line_amount_that_differs_from_quantity_times_unit_price(self):
        type(self.onion).objects.filter(pk=self.onion.pk).update(amount=Decimal("0.90"))
        Receipt.objects.filter(pk=self.receipt.pk).update(total=Decimal("2.33"))
        self.receipt.taxes.all().delete()
        problems = self.assertProblems("line.amount")
        self.assertIn("строка 2", problems[0])
        self.assertIn("0.87906", problems[0])

    def test_line_amount_within_rounding_tolerance_is_accepted(self):
        # 0,87906 -> 0,87 и 0,88 — оба в пределах 0,01; 0,89 — уже нет.
        for amount, expected in ((Decimal("0.87"), []), (Decimal("0.89"), ["line.amount"])):
            with self.subTest(amount=amount):
                type(self.onion).objects.filter(pk=self.onion.pk).update(amount=amount)
                problems = self.problems()
                self.assertEqual([p.split(":")[0] for p in problems if p.startswith("line.")], expected)

    def test_parent_from_other_receipt(self):
        _, foreign_line = self.other_receipt()
        type(self.deposit).objects.filter(pk=self.deposit.pk).update(parent=foreign_line)
        problems = self.assertProblems("line.parent")
        self.assertIn("строка 3", problems[0])

    def test_discount_line_from_other_receipt(self):
        other, foreign_line = self.other_receipt(total=Decimal("9.50"))
        type(foreign_line).objects.filter(pk=foreign_line.pk).update(discount_amount=Decimal("0.50"))
        ReceiptDiscount.objects.create(
            receipt=self.receipt, line=foreign_line, position=4, name="Чужая скидка", amount=Decimal("0.50"),
        )
        # Скидка числится за этим чеком, поэтому расходится и его итог.
        problems = self.assertProblems("discount.line", "total")
        self.assertIn("Чужая скидка", problems[0])
        # У чужого чека скидки на строку нет, хотя discount_amount заполнен.
        self.assertProblems("line.discount_amount", "total", receipt=other)

    def test_line_tax_rate_of_other_country(self):
        type(self.onion).objects.filter(pk=self.onion.pk).update(tax_rate=self.foreign_rate)
        problems = self.assertProblems("line.tax_rate")
        self.assertIn("строка 2", problems[0])
        self.assertIn("XB", problems[0])
        self.assertIn("XA", problems[0])

    def test_tax_total_rate_of_other_country(self):
        ReceiptTax.objects.filter(pk=self.tax_a.pk).update(tax_rate=self.foreign_rate)
        problems = self.assertProblems("tax.tax_rate")
        self.assertIn("Чужой НДС 7%", problems[0])

    def test_purchased_on_that_differs_from_local_date_of_purchased_at(self):
        # 23:30 UTC 14 марта — уже 00:30 15 марта в Europe/Berlin.
        Receipt.objects.filter(pk=self.receipt.pk).update(
            purchased_at=datetime(2026, 3, 14, 23, 30, tzinfo=timezone.utc), purchased_on=date(2026, 3, 14),
        )
        problems = self.assertProblems("purchased_on")
        self.assertIn("2026-03-14", problems[0])
        self.assertIn("2026-03-15", problems[0])
        self.assertIn("Europe/Berlin", problems[0])

    def test_purchased_on_is_compared_in_store_timezone_not_in_utc(self):
        Receipt.objects.filter(pk=self.receipt.pk).update(
            purchased_at=datetime(2026, 3, 14, 23, 30, tzinfo=timezone.utc), purchased_on=date(2026, 3, 15),
        )
        self.assertEqual(self.problems(), [])

    def test_unknown_store_timezone(self):
        type(self.store).objects.filter(pk=self.store.pk).update(timezone="Mars/Olympus")
        problems = self.assertProblems("store.timezone")
        self.assertIn("Mars/Olympus", problems[0])

    def test_prices_without_tax_add_tax_on_top(self):
        receipt = self.make_receipt(receipt_number="2", total=Decimal("11.90"), prices_include_tax=False)
        make_line(receipt, tax_rate=self.tax_rate_b)
        ReceiptTax.objects.create(
            receipt=receipt, tax_rate=self.tax_rate_b, net=Decimal("10.00"), tax=Decimal("1.90"), gross=Decimal("11.90"),
        )
        self.assertEqual(self.problems(receipt), [])
        Receipt.objects.filter(pk=receipt.pk).update(prices_include_tax=True)
        self.assertProblems("total", receipt=receipt)

    def test_all_problems_are_reported_together_and_nothing_is_changed(self):
        Receipt.objects.filter(pk=self.receipt.pk).update(total=Decimal("5.00"), purchased_on=date(2026, 3, 13))
        type(self.onion).objects.filter(pk=self.onion.pk).update(tax_rate=self.foreign_rate)
        self.assertProblems("purchased_on", "line.tax_rate", "total", "taxes.gross")
        self.receipt.refresh_from_db()
        self.assertEqual(self.receipt.total, Decimal("5.00"))
