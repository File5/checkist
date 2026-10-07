from datetime import date, datetime, timezone
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.test import SimpleTestCase, TestCase, tag

from catalog.models import Category, GenericProduct, Product
from catalog.units import BaseUnit, Unit
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from stores.models import Country, Currency, Merchant, Store, TaxRate

# Все названия, адреса и номера вымышленные.

PURCHASED_AT = datetime(2026, 3, 14, 11, 30, tzinfo=timezone.utc)  # 12:30 в Europe/Berlin
PURCHASED_ON = date(2026, 3, 14)


def make_receipt(store, currency, **fields):
    fields.setdefault("operation", Receipt.Operation.SALE)
    fields.setdefault("purchased_at", PURCHASED_AT)
    fields.setdefault("purchased_on", PURCHASED_ON)
    fields.setdefault("total", Decimal("10.00"))
    return Receipt.objects.create(store=store, currency=currency, **fields)


def make_line(receipt, **fields):
    fields.setdefault("position", 1)
    fields.setdefault("kind", ReceiptLine.Kind.PRODUCT)
    fields.setdefault("raw_name", "Тестовый товар")
    fields.setdefault("quantity", Decimal("1.000"))
    fields.setdefault("unit_price", Decimal("10.0000"))
    fields.setdefault("amount", Decimal("10.00"))
    return ReceiptLine.objects.create(receipt=receipt, **fields)


class ReceiptTestCase(TestCase):
    """Общие справочники: своя страна и валюта, чтобы не зависеть от сидов."""

    @classmethod
    def setUpTestData(cls):
        cls.country = Country.objects.create(code="XA", name="Тестовая страна")
        cls.currency = Currency.objects.create(code="XTS", name="Тестовая валюта")
        cls.merchant = Merchant.objects.create(country=cls.country, legal_name="ТОО «Тестовый продавец»")
        cls.store = Store.objects.create(
            merchant=cls.merchant, country=cls.country,
            address_raw="г. Тестоград, ул. Примерная, 1", timezone="Europe/Berlin",
        )
        cls.other_store = Store.objects.create(
            merchant=cls.merchant, country=cls.country,
            address_raw="г. Тестоград, ул. Другая, 2", timezone="Europe/Berlin",
        )
        cls.tax_rate = TaxRate.objects.create(
            country=cls.country, kind="vat", rate=Decimal("7.00"), name="НДС 7%",
        )
        category = Category.objects.create(name="Тестовая категория")
        generic = GenericProduct.objects.create(name="Тестовый продукт", category=category, base_unit=BaseUnit.PCS)
        cls.product = Product.objects.create(generic=generic, name="Тестовый товар")

    def make_receipt(self, **fields):
        return make_receipt(fields.pop("store", self.store), self.currency, **fields)

    def assertRejected(self, constraint, operation):
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            operation()
        self.assertIn(constraint, str(caught.exception))


@tag("integration")
class DefaultsTests(ReceiptTestCase):
    def test_optional_fields_default_to_empty_values(self):
        receipt = self.make_receipt()
        line = make_line(receipt)
        receipt.refresh_from_db()
        line.refresh_from_db()
        self.assertEqual(
            (receipt.receipt_number, receipt.shift_number, receipt.register_code, receipt.fiscal_key,
             receipt.fiscal, receipt.raw_text, receipt.extra, receipt.discount_total, receipt.prices_include_tax),
            ("", "", "", "", {}, "", {}, Decimal("0.00"), True),
        )
        self.assertIsNotNone(receipt.created_at)
        self.assertIsNotNone(receipt.updated_at)
        self.assertEqual(
            (line.unit, line.discount_amount, line.name_i18n, line.store_item_code, line.barcode,
             line.tax_code, line.extra, line.is_excise, line.is_marked),
            (Unit.PCS, Decimal("0.00"), {}, "", "", "", {}, False, False),
        )
        self.assertIsNone(line.parent)
        self.assertIsNone(line.tax_rate)
        self.assertIsNone(line.tax_amount)
        self.assertIsNone(line.product)

    def test_decimal_precision_is_kept(self):
        receipt = self.make_receipt(total=Decimal("0.88"))
        line = make_line(
            receipt, quantity=Decimal("0.294"), unit=Unit.KG,
            unit_price=Decimal("2.9900"), amount=Decimal("0.88"),
        )
        line.refresh_from_db()
        self.assertEqual((line.quantity, line.unit_price, line.amount), (Decimal("0.294"), Decimal("2.9900"), Decimal("0.88")))
        fuel = make_line(
            receipt, position=2, quantity=Decimal("31.570"), unit=Unit.L,
            unit_price=Decimal("1.7390"), amount=Decimal("54.90"),
        )
        fuel.refresh_from_db()
        self.assertEqual(fuel.unit_price, Decimal("1.7390"))


@tag("integration")
class LineConstraintTests(ReceiptTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.receipt = make_receipt(cls.store, cls.currency)

    def test_position_is_unique_within_receipt(self):
        make_line(self.receipt, position=1)
        self.assertRejected(
            "receipts_receiptline_receipt_position_uniq",
            lambda: make_line(self.receipt, position=1, raw_name="Другой товар"),
        )

    def test_same_position_in_other_receipt_is_allowed(self):
        other = self.make_receipt(receipt_number="2")
        make_line(self.receipt, position=1)
        make_line(other, position=1)
        self.assertEqual(ReceiptLine.objects.filter(position=1).count(), 2)

    def test_deposit_return_with_positive_amount_is_rejected(self):
        self.assertRejected(
            "receipts_receiptline_deposit_return_not_positive",
            lambda: make_line(
                self.receipt, kind="deposit_return", quantity=Decimal("4"),
                unit_price=Decimal("0.25"), amount=Decimal("1.00"),
            ),
        )

    def test_parent_on_product_line_is_rejected(self):
        parent = make_line(self.receipt, position=1)
        for kind in ("product", "service", "deposit_return"):
            with self.subTest(kind=kind):
                self.assertRejected(
                    "receipts_receiptline_parent_only_for_deposit",
                    lambda: make_line(
                        self.receipt, position=2, kind=kind, parent=parent,
                        quantity=Decimal("-1"), unit_price=Decimal("0.25"), amount=Decimal("-0.25"),
                    ),
                )

    def test_parent_on_deposit_line_is_allowed(self):
        parent = make_line(self.receipt, position=1)
        deposit = make_line(
            self.receipt, position=2, kind="deposit", parent=parent, raw_name="Pfand",
            unit_price=Decimal("0.25"), amount=Decimal("0.25"),
        )
        self.assertEqual(list(parent.children.all()), [deposit])

    def test_negative_unit_price_is_rejected(self):
        self.assertRejected(
            "receipts_receiptline_unit_price_nonnegative",
            lambda: make_line(self.receipt, unit_price=Decimal("-10.0000")),
        )

    def test_negative_discount_amount_is_rejected(self):
        self.assertRejected(
            "receipts_receiptline_discount_amount_nonnegative",
            lambda: make_line(self.receipt, discount_amount=Decimal("-0.01")),
        )

    def test_zero_quantity_is_rejected(self):
        for amount in (Decimal("0.00"), Decimal("10.00")):
            with self.subTest(amount=amount):
                self.assertRejected(
                    "receipts_receiptline_quantity_nonzero",
                    lambda: make_line(self.receipt, quantity=Decimal("0"), amount=amount),
                )

    def test_quantity_and_amount_of_different_signs_are_rejected(self):
        for quantity, amount in ((Decimal("1"), Decimal("-10.00")), (Decimal("-1"), Decimal("10.00"))):
            with self.subTest(quantity=quantity, amount=amount):
                self.assertRejected(
                    "receipts_receiptline_quantity_amount_same_sign",
                    lambda: make_line(self.receipt, quantity=quantity, amount=amount),
                )

    def test_zero_amount_is_allowed_for_any_quantity_sign(self):
        make_line(self.receipt, position=1, unit_price=Decimal("0"), amount=Decimal("0.00"))
        make_line(self.receipt, position=2, quantity=Decimal("-1"), unit_price=Decimal("0"), amount=Decimal("0.00"))
        self.assertEqual(self.receipt.lines.count(), 2)


@tag("integration")
class NegativeLineTests(ReceiptTestCase):
    def test_deposit_return_line_is_saved(self):
        receipt = self.make_receipt(total=Decimal("-1.00"))
        line = make_line(
            receipt, kind="deposit_return", raw_name="Pfandrückgabe",
            quantity=Decimal("-4"), unit_price=Decimal("0.25"), amount=Decimal("-1.00"),
        )
        line.refresh_from_db()
        self.assertEqual(
            (line.quantity, line.unit_price, line.amount),
            (Decimal("-4.000"), Decimal("0.2500"), Decimal("-1.00")),
        )

    def test_receipt_with_negative_total_is_saved(self):
        receipt = self.make_receipt(total=Decimal("-0.75"))
        receipt.refresh_from_db()
        self.assertEqual(receipt.total, Decimal("-0.75"))


@tag("integration")
class DiscountAndTaxConstraintTests(ReceiptTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.receipt = make_receipt(cls.store, cls.currency)
        cls.line = make_line(cls.receipt)

    def test_discount_position_is_unique_within_receipt(self):
        ReceiptDiscount.objects.create(receipt=self.receipt, line=self.line, position=1, name="Rabatt", amount=Decimal("0.30"))
        self.assertRejected(
            "receipts_receiptdiscount_receipt_position_uniq",
            lambda: ReceiptDiscount.objects.create(
                receipt=self.receipt, position=1, name="Preisvorteil", amount=Decimal("0.10"),
            ),
        )

    def test_line_can_have_several_discounts(self):
        for position, name in enumerate(("Rabatt", "Preisvorteil"), start=1):
            ReceiptDiscount.objects.create(
                receipt=self.receipt, line=self.line, position=position, name=name, amount=Decimal("0.10"),
            )
        whole = ReceiptDiscount.objects.create(receipt=self.receipt, position=3, name="Купон", amount=Decimal("1.00"))
        self.assertEqual(self.line.discounts.count(), 2)
        self.assertIsNone(whole.line)

    def test_non_positive_discount_amount_is_rejected(self):
        for amount in (Decimal("0.00"), Decimal("-0.30")):
            with self.subTest(amount=amount):
                self.assertRejected(
                    "receipts_receiptdiscount_amount_positive",
                    lambda: ReceiptDiscount.objects.create(
                        receipt=self.receipt, position=1, name="Rabatt", amount=amount,
                    ),
                )

    def test_tax_total_that_does_not_add_up_is_rejected(self):
        self.assertRejected(
            "receipts_receipttax_net_plus_tax_eq_gross",
            lambda: ReceiptTax.objects.create(
                receipt=self.receipt, tax_rate=self.tax_rate,
                net=Decimal("9.35"), tax=Decimal("0.65"), gross=Decimal("10.01"),
            ),
        )

    def test_tax_total_that_adds_up_is_saved(self):
        ReceiptTax.objects.create(
            receipt=self.receipt, tax_rate=self.tax_rate, tax_code="A",
            net=Decimal("9.35"), tax=Decimal("0.65"), gross=Decimal("10.00"),
        )
        exempt = TaxRate.objects.create(country=self.country, kind="exempt", rate=None, name="Без НДС")
        other = self.make_receipt(receipt_number="2", total=Decimal("-1.00"))
        ReceiptTax.objects.create(
            receipt=other, tax_rate=exempt, net=Decimal("-1.00"), tax=Decimal("0.00"), gross=Decimal("-1.00"),
        )
        self.assertEqual(ReceiptTax.objects.count(), 2)

    def test_tax_rate_is_unique_within_receipt(self):
        values = {"net": Decimal("9.35"), "tax": Decimal("0.65"), "gross": Decimal("10.00")}
        ReceiptTax.objects.create(receipt=self.receipt, tax_rate=self.tax_rate, **values)
        self.assertRejected(
            "receipts_receipttax_receipt_tax_rate_uniq",
            lambda: ReceiptTax.objects.create(receipt=self.receipt, tax_rate=self.tax_rate, tax_code="B", **values),
        )


@tag("integration")
class ProductAliasConstraintTests(ReceiptTestCase):
    def make_alias(self, **fields):
        fields.setdefault("merchant", self.merchant)
        fields.setdefault("name_key", "тестовый товар")
        fields.setdefault("raw_name", "Тестовый товар")
        return ProductAlias.objects.create(product=self.product, **fields)

    def test_same_merchant_name_and_code_is_rejected(self):
        for code in ("", "3079"):
            with self.subTest(code=code):
                self.make_alias(store_item_code=code)
                self.assertRejected(
                    "receipts_productalias_merchant_name_code_uniq",
                    lambda: self.make_alias(store_item_code=code),
                )

    def test_same_name_with_other_code_or_merchant_is_allowed(self):
        other_merchant = Merchant.objects.create(country=self.country, legal_name="ТОО «Другой продавец»")
        self.make_alias()
        self.make_alias(store_item_code="3079")
        self.make_alias(merchant=other_merchant)
        self.assertEqual(ProductAlias.objects.count(), 3)


@tag("integration")
class CascadeTests(ReceiptTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.receipt = make_receipt(cls.store, cls.currency)
        cls.line = make_line(cls.receipt, product=cls.product, tax_rate=cls.tax_rate)
        cls.deposit = make_line(
            cls.receipt, position=2, kind="deposit", parent=cls.line, raw_name="Pfand",
            unit_price=Decimal("0.25"), amount=Decimal("0.25"),
        )
        ReceiptDiscount.objects.create(receipt=cls.receipt, line=cls.line, position=1, name="Rabatt", amount=Decimal("0.30"))
        ReceiptDiscount.objects.create(receipt=cls.receipt, position=2, name="Купон", amount=Decimal("0.10"))
        ReceiptTax.objects.create(
            receipt=cls.receipt, tax_rate=cls.tax_rate, net=Decimal("9.35"), tax=Decimal("0.65"), gross=Decimal("10.00"),
        )

    def test_deleting_receipt_deletes_lines_discounts_and_taxes(self):
        self.receipt.delete()
        self.assertEqual(
            (ReceiptLine.objects.count(), ReceiptDiscount.objects.count(), ReceiptTax.objects.count()),
            (0, 0, 0),
        )
        # Справочники и каталог остаются.
        self.assertTrue(Store.objects.filter(pk=self.store.pk).exists())
        self.assertTrue(Product.objects.filter(pk=self.product.pk).exists())
        self.assertTrue(TaxRate.objects.filter(pk=self.tax_rate.pk).exists())

    def test_deleting_line_deletes_its_deposit_and_discounts(self):
        self.line.delete()
        self.assertFalse(ReceiptLine.objects.filter(receipt=self.receipt).exists())
        self.assertEqual(list(self.receipt.discounts.values_list("name", flat=True)), ["Купон"])
        self.assertTrue(Receipt.objects.filter(pk=self.receipt.pk).exists())

    def test_deleting_product_unsets_line_product(self):
        ProductAlias.objects.create(
            merchant=self.merchant, product=self.product, name_key="тестовый товар", raw_name="Тестовый товар",
        )
        self.product.delete()
        self.line.refresh_from_db()
        self.assertIsNone(self.line.product)
        self.assertEqual(self.receipt.lines.count(), 2)
        self.assertFalse(ProductAlias.objects.exists())

    def test_deleting_store_with_receipts_is_protected(self):
        with self.assertRaises(ProtectedError):
            self.store.delete()
        self.assertTrue(Store.objects.filter(pk=self.store.pk).exists())
        self.assertTrue(Receipt.objects.filter(pk=self.receipt.pk).exists())

    def test_deleting_referenced_currency_and_tax_rate_is_protected(self):
        for referenced in (self.currency, self.tax_rate):
            with self.subTest(referenced=referenced):
                with self.assertRaises(ProtectedError):
                    referenced.delete()

    def test_database_rejects_deleting_store_with_receipts(self):
        # PROTECT — правило ORM; обход через сырой SQL останавливает внешний ключ БД.
        with self.assertRaises(IntegrityError), transaction.atomic():
            with transaction.get_connection().cursor() as cursor:
                cursor.execute("DELETE FROM stores_store WHERE id = %s", [self.store.pk])
                cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")


class VerboseNamePluralTests(SimpleTestCase):
    def test_receipt_tax(self):
        self.assertEqual(ReceiptTax._meta.verbose_name_plural, "receipt taxes")
