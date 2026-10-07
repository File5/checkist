import json
from datetime import date, datetime, timezone
from decimal import ROUND_HALF_UP, Decimal

from django.db import IntegrityError, transaction
from django.test import SimpleTestCase, TestCase, tag

from catalog.units import Unit
from receipts.dedup import find_duplicates
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.tests import samples
from receipts.validation import validate_receipt
from stores.models import Merchant, Store

CENT = Decimal("0.01")
ALL_SAMPLES = [samples.DNS_KZ, samples.SHOP_RU, *samples.LIDL_DE]
# Признаки платёжных данных в именах полей.
PAYMENT_FIELD_MARKERS = ("card", "pay", "terminal", "rrn", "auth", "bank", "acquir")
# Реквизиты слипа терминала из трёх образцов: в сохранённых данных их быть не должно.
CARD_SLIP_MARKERS = (
    "mastercard", "contactless", "rrn", "одобрено", "терминал", "банковская карта", "kreditkarte",
    "bezahlung", "t-id", "ta-nr", "beleg-nr", "vu-nummer", "autorisierung", "emv",
)


class SampleDataTests(SimpleTestCase):
    """Сами данные образцов, без БД."""

    def test_line_amounts_minus_discounts_equal_total(self):
        for sample in ALL_SAMPLES:
            with self.subTest(number=sample["receipt"]["receipt_number"]):
                discounts = [
                    Decimal(amount) for line in sample["lines"] for _, amount in line.get("discounts", ())
                ]
                lines_total = sum(line["amount"] for line in sample["lines"]) - sum(discounts)
                self.assertEqual(lines_total, sample["receipt"]["total"])
                self.assertEqual(sum(discounts), sample["receipt"].get("discount_total", Decimal(0)))

    def test_tax_table_is_recomputed_from_lines(self):
        for sample in ALL_SAMPLES:
            gross_by_code = {}
            for line in sample["lines"]:
                discounts = sum(Decimal(amount) for _, amount in line.get("discounts", ()))
                code = line["tax_code"]
                gross_by_code[code] = gross_by_code.get(code, Decimal(0)) + line["amount"] - discounts
            self.assertEqual(sorted(gross_by_code), sorted(row["tax_code"] for row in sample["taxes"]))
            for row in sample["taxes"]:
                with self.subTest(number=sample["receipt"]["receipt_number"], code=row["tax_code"]):
                    rate = sample["tax_rates"][row["tax_code"]] or Decimal(0)  # «без НДС» — налога нет
                    gross = gross_by_code[row["tax_code"]]
                    expected_tax = (gross * rate / (100 + rate)).quantize(CENT, ROUND_HALF_UP)
                    self.assertEqual((row["gross"], row["tax"], row["net"]), (gross, expected_tax, gross - expected_tax))

    def test_lidl_receipts_are_six_distinct_days_of_one_store(self):
        self.assertEqual(
            [sample["receipt"]["purchased_on"] for sample in samples.LIDL_DE],
            [date(2026, 6, 2), date(2026, 6, 9), date(2026, 6, 17), date(2026, 6, 29), date(2026, 7, 6),
             date(2026, 10, 1)],
        )

    def test_models_have_no_separate_payment_fields(self):
        for model in (Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax, Merchant, Store):
            for field in model._meta.get_fields():
                with self.subTest(model=model.__name__, field=field.name):
                    self.assertFalse([marker for marker in PAYMENT_FIELD_MARKERS if marker in field.name])


@tag("integration")
class SavedSamplesTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.dns = samples.save_dns_kz()
        cls.shop = samples.save_shop_ru()
        cls.lidl = samples.save_lidl_de()
        cls.catalog = samples.save_catalog()
        cls.saved = [(samples.DNS_KZ, cls.dns), (samples.SHOP_RU, cls.shop), *zip(samples.LIDL_DE, cls.lidl)]

    def lines(self, receipt):
        return list(receipt.lines.order_by("position"))

    def test_everything_is_saved(self):
        self.assertEqual(Receipt.objects.count(), 8)
        for sample, receipt in self.saved:
            with self.subTest(receipt=str(receipt)):
                self.assertEqual(receipt.lines.count(), len(sample["lines"]))
                self.assertEqual(receipt.taxes.count(), len(sample["taxes"]))
        self.assertEqual(ReceiptDiscount.objects.count(), 3)

    def test_validate_receipt_returns_no_problems(self):
        for _, receipt in self.saved:
            with self.subTest(receipt=str(receipt)):
                self.assertEqual(validate_receipt(Receipt.objects.get(pk=receipt.pk)), [])

    # --- дедупликация ---

    def assertRejected(self, constraint, store, sample):
        counts = (Receipt.objects.count(), ReceiptLine.objects.count())
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            samples.save_receipt(store, sample)
        self.assertIn(constraint, str(caught.exception))
        self.assertEqual((Receipt.objects.count(), ReceiptLine.objects.count()), counts)

    def test_saving_a_sample_again_is_rejected_by_fiscal_key(self):
        for sample, receipt in self.saved:
            with self.subTest(receipt=str(receipt)):
                self.assertRejected("receipts_receipt_owner_fiscal_key_uniq", receipt.store, sample)

    def test_saving_a_sample_again_without_fiscal_data_is_rejected_by_store_number(self):
        for sample, receipt in self.saved:
            with self.subTest(receipt=str(receipt)):
                copy = {**sample, "receipt": {**sample["receipt"], "fiscal": {}}}
                self.assertRejected("receipts_receipt_owner_store_number_uniq", receipt.store, copy)

    def test_builders_reject_a_second_save(self):
        for builder in (samples.save_dns_kz, samples.save_shop_ru, samples.save_lidl_de):
            with self.subTest(builder=builder.__name__):
                with self.assertRaises(IntegrityError), transaction.atomic():
                    builder()
        self.assertEqual(Receipt.objects.count(), 8)
        self.assertEqual((Merchant.objects.count(), Store.objects.count(), ProductAlias.objects.count()), (3, 3, 3))

    def test_find_duplicates_finds_each_sample_before_saving(self):
        for sample, receipt in self.saved:
            with self.subTest(receipt=str(receipt)):
                data = {"store": receipt.store, **sample["receipt"]}
                self.assertEqual(find_duplicates(data), [receipt])
                # Тот же чек, введённый без фискальных реквизитов и без смены и кассы.
                by_number = {
                    "store": receipt.store_id,
                    "purchased_on": receipt.purchased_on,
                    "receipt_number": receipt.receipt_number,
                }
                self.assertEqual(find_duplicates(by_number), [receipt])

    # --- оплата картой ---

    def test_card_payment_data_is_not_stored(self):
        rows = [
            row
            for model in (Merchant, Store, Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax)
            for row in model.objects.values()
        ]
        text = json.dumps(rows, default=str, ensure_ascii=False).lower()
        for marker in CARD_SLIP_MARKERS:
            with self.subTest(marker=marker):
                self.assertNotIn(marker, text)

    def test_payment_method_lives_only_in_extra(self):
        self.shop.refresh_from_db()
        self.assertEqual(self.shop.extra["payment"], "безналичными")
        row = Receipt.objects.filter(pk=self.shop.pk).values().get()
        row.pop("extra")
        self.assertNotIn("безналичными", json.dumps(row, default=str, ensure_ascii=False))

    # --- раскладка по полям ---

    def test_dns_receipt(self):
        receipt = Receipt.objects.select_related("store__merchant").get(pk=self.dns.pk)
        merchant, store = receipt.store.merchant, receipt.store
        self.assertEqual(
            (merchant.country_id, merchant.legal_name, merchant.brand_name, merchant.tax_id_type, merchant.tax_id),
            ("KZ", "ТОО «ДНС КАЗАХСТАН»", "DNS", "bin", "210140004940"),
        )
        self.assertEqual(merchant.extra["vat_certificate"], {"series": "62001", "number": "1025833"})
        self.assertEqual((store.timezone, sorted(store.address_i18n)), ("Asia/Almaty", ["kk", "ru"]))
        self.assertEqual(store.address_raw, store.address_i18n["ru"])
        self.assertEqual(
            (receipt.operation, receipt.receipt_number, receipt.shift_number, receipt.purchased_on,
             receipt.total, receipt.currency_id, receipt.fiscal_key),
            ("sale", "5", "139", date(2026, 9, 11), Decimal("189490.00"), "KZT", "kz:601004679109:1443445223777"),
        )
        self.assertEqual(receipt.purchased_at, datetime(2026, 9, 11, 11, 15, 44, tzinfo=timezone.utc))
        self.assertEqual(sorted(receipt.fiscal), ["document", "fp", "ofd", "rnm", "znm"])
        self.assertEqual(receipt.fiscal["document"], "К-00132661")

        (line,) = self.lines(receipt)
        self.assertEqual(
            (line.kind, line.store_item_code, line.barcode, line.quantity, line.unit, line.unit_price,
             line.amount, line.tax_amount, line.tax_rate.rate, sorted(line.name_i18n)),
            ("product", "5412016", "0200200605191", Decimal("1"), Unit.PCS, Decimal("189490"),
             Decimal("189490.00"), Decimal("26136.55"), Decimal("16.00"), ["kk", "ru"]),
        )
        self.assertEqual(line.raw_name, line.name_i18n["ru"])
        self.assertEqual(line.product, self.catalog["ssd"])
        tax = receipt.taxes.get()
        self.assertEqual(
            (tax.gross, tax.tax, tax.net), (Decimal("189490.00"), Decimal("26136.55"), Decimal("163353.45")),
        )

    def test_shop_receipt(self):
        receipt = Receipt.objects.select_related("store__merchant").get(pk=self.shop.pk)
        merchant, store = receipt.store.merchant, receipt.store
        self.assertEqual((merchant.country_id, merchant.tax_id_type), ("RU", "inn"))
        self.assertRegex(merchant.tax_id, r"^\d{12}$")
        self.assertEqual(merchant.extra["tax_system"], "Патент")
        self.assertEqual(
            (store.name, store.postal_code, store.city, store.timezone),
            ("Магазин «Елена»", "650003", "Кемерово", "Asia/Novokuznetsk"),
        )
        self.assertEqual(
            (receipt.receipt_number, receipt.register_code, receipt.shift_number, receipt.fiscal_key, receipt.total),
            ("2968", "1", "", "ru:7382440900170413:72473", Decimal("670.00")),
        )
        # 13:58 из фискального блока, Asia/Novokuznetsk = UTC+7.
        self.assertEqual(receipt.purchased_at, datetime(2026, 9, 28, 6, 58, tzinfo=timezone.utc))

        lines = self.lines(receipt)
        self.assertEqual([line.kind for line in lines], ["product"] * 4)
        self.assertEqual([line.store_item_code for line in lines], ["3079", "1346", "2489", "326"])
        self.assertEqual([line.is_marked for line in lines], [True, False, True, True])
        self.assertEqual([line.is_excise for line in lines], [False, False, False, True])
        for line in lines:
            self.assertEqual((line.tax_rate.kind, line.tax_rate.rate, line.tax_amount), ("exempt", None, None))
        tax = receipt.taxes.select_related("tax_rate").get()
        self.assertEqual(
            (tax.tax_rate.kind, tax.gross, tax.tax, tax.net),
            ("exempt", Decimal("670.00"), Decimal("0.00"), Decimal("670.00")),
        )

        milk = lines[0].product
        self.assertEqual(milk, self.catalog["shop_milk"])
        self.assertEqual(
            (milk.generic.name, milk.package_quantity, milk.package_unit, milk.attributes),
            ("Молоко", Decimal("850"), Unit.ML, {"fat_percent": 2.5, "packaging": "пэт"}),
        )
        self.assertEqual([line.product for line in lines[1:]], [None, None, None])

    def test_lidl_store_and_identifiers(self):
        store = Store.objects.select_related("merchant").get(pk=self.lidl[0].store_id)
        self.assertEqual({receipt.store_id for receipt in self.lidl}, {store.pk})
        self.assertEqual(
            (store.merchant.country_id, store.merchant.legal_name, store.merchant.brand_name,
             store.merchant.tax_id_type, store.merchant.tax_id),
            ("DE", "Lidl", "Lidl", "vat_id", "DE813389027"),
        )
        self.assertEqual(
            (store.branch_code, store.postal_code, store.city, store.timezone),
            ("5597", "88131", "Lindau", "Europe/Berlin"),
        )
        receipt = Receipt.objects.get(pk=self.lidl[3].pk)
        self.assertEqual(
            (receipt.receipt_number, receipt.fiscal_key, receipt.currency_id, receipt.discount_total),
            ("475298/12", "de:LDL-000-5597-85:427161", "EUR", Decimal("2.40")),
        )
        self.assertEqual(receipt.purchased_at, datetime(2026, 6, 29, 14, 2, tzinfo=timezone.utc))  # 16:02 CEST
        self.assertLessEqual({"signature_counter", "signature", "transaction_start"}, set(receipt.fiscal))
        self.assertEqual(len({receipt.fiscal_key for receipt in self.lidl}), 6)

    def test_lidl_quantity_weight_and_deposits(self):
        pizza, kefir, deposit, milk, onion = self.lines(self.lidl[1])
        self.assertEqual(
            (pizza.quantity, pizza.unit_price, pizza.amount, pizza.tax_code, pizza.tax_rate.rate),
            (Decimal("1"), Decimal("3.49"), Decimal("3.49"), "A", Decimal("7.00")),
        )
        self.assertEqual((kefir.quantity, kefir.unit_price, kefir.amount), (2, Decimal("1.29"), Decimal("2.58")))
        self.assertEqual(
            (deposit.kind, deposit.parent, deposit.quantity, deposit.amount, deposit.tax_code),
            ("deposit", kefir, 2, Decimal("0.50"), "A"),
        )
        self.assertEqual(
            (onion.quantity, onion.unit, onion.unit_price, onion.amount, onion.product),
            (Decimal("0.294"), Unit.KG, Decimal("2.99"), Decimal("0.88"), None),
        )
        self.assertEqual(milk.product, self.catalog["lidl_milk"])
        self.assertTrue(ProductAlias.objects.filter(
            merchant=self.lidl[0].store.merchant, name_key="gq egsb h-milch 1,5%", product=milk.product,
        ).exists())

        fanta, drink_deposit = self.lines(self.lidl[0])[2:4]
        self.assertEqual(
            (drink_deposit.kind, drink_deposit.parent, drink_deposit.quantity, drink_deposit.unit_price,
             drink_deposit.amount, drink_deposit.tax_code, drink_deposit.tax_rate.rate),
            ("deposit", fanta, 1, Decimal("0.25"), Decimal("0.25"), "B", Decimal("19.00")),
        )
        # Залог — отдельная строка: цена напитка не искажена.
        self.assertEqual((fanta.amount, fanta.tax_code), (Decimal("0.99"), "B"))

    def test_lidl_deposit_returns_are_negative_lines(self):
        returned = self.lines(self.lidl[2])[-1]
        self.assertEqual(
            (returned.kind, returned.quantity, returned.unit_price, returned.amount, returned.parent,
             returned.tax_code),
            ("deposit_return", -4, Decimal("0.25"), Decimal("-1.00"), None, "B"),
        )
        self.assertEqual(
            [(line.quantity, line.amount, line.tax_code) for line in self.lines(self.lidl[4])[-2:]],
            [(-12, Decimal("-3.00"), "B"), (-5, Decimal("-1.25"), "A")],
        )
        self.assertEqual(self.lidl[4].taxes.get(tax_code="B").gross, Decimal("-3.00"))

    def test_lidl_line_discounts(self):
        receipt = self.lidl[3]
        lines = {line.raw_name: line for line in self.lines(receipt)}
        self.assertEqual(
            [(d.line.raw_name, d.name, d.amount) for d in receipt.discounts.order_by("position")],
            [
                (samples.LEERDAMMER, "Preisvorteil", Decimal("0.20")),
                (samples.BARILLA, "Preisvorteil", Decimal("2.00")),
                (samples.FRIKADELLEN, "Rabatt Snack", Decimal("0.20")),
            ],
        )
        leerdammer, barilla = lines[samples.LEERDAMMER], lines[samples.BARILLA]
        self.assertEqual((leerdammer.amount, leerdammer.discount_amount), (Decimal("2.89"), Decimal("0.20")))
        self.assertEqual(
            (barilla.quantity, barilla.unit_price, barilla.amount, barilla.discount_amount),
            (2, Decimal("1.99"), Decimal("3.98"), Decimal("2.00")),
        )
        self.assertEqual(
            {tax.tax_code: (tax.net, tax.tax, tax.gross) for tax in receipt.taxes.all()},
            {
                "A": (Decimal("13.12"), Decimal("0.92"), Decimal("14.04")),
                "B": (Decimal("1.04"), Decimal("0.20"), Decimal("1.24")),
            },
        )
