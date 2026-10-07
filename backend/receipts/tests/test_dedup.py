from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from django.test import SimpleTestCase, tag

from receipts.dedup import FISCAL_KEY_MAX_LENGTH, NAME_KEY_MAX_LENGTH, build_fiscal_key, find_alias, find_duplicates, name_key
from receipts.models import ProductAlias, Receipt
from receipts.ownership import local_user
from receipts.tests.test_models import PURCHASED_AT, PURCHASED_ON, ReceiptTestCase
from stores.models import Country, Merchant, Store

# Все фискальные номера вымышленные.


class BuildFiscalKeyTests(SimpleTestCase):
    def test_ru_key_is_fn_and_fd(self):
        fiscal = {"fn": "7382440900170413", "fd": "72473", "fp": "1234567890", "rn_kkt": "0000000001012345"}
        self.assertEqual(build_fiscal_key("RU", fiscal), "ru:7382440900170413:72473")

    def test_kz_key_is_rnm_and_fp(self):
        fiscal = {"fp": "1443445223777", "rnm": "601004679109", "znm": "SWK00012345"}
        self.assertEqual(build_fiscal_key("KZ", fiscal), "kz:601004679109:1443445223777")

    def test_de_key_is_register_serial_and_tse_transaction(self):
        fiscal = {"tse_transaction": "427161", "register_serial": "LDL-000-5597-85", "signature_counter": "901234"}
        self.assertEqual(build_fiscal_key("DE", fiscal), "de:LDL-000-5597-85:427161")

    def test_country_code_case_and_spaces_do_not_matter(self):
        fiscal = {"fn": "7382440900170413", "fd": "72473"}
        self.assertEqual(build_fiscal_key(" ru ", fiscal), "ru:7382440900170413:72473")

    def test_numbers_and_printed_spaces_give_the_same_key(self):
        self.assertEqual(
            build_fiscal_key("RU", {"fn": " 7382 4409 0017 0413 ", "fd": 72473}),
            "ru:7382440900170413:72473",
        )

    def test_missing_requisite_gives_empty_key(self):
        for fiscal in ({"fn": "7382440900170413"}, {"fn": "7382440900170413", "fd": " "},
                       {"fn": None, "fd": "72473"}, {}, None):
            with self.subTest(fiscal=fiscal):
                self.assertEqual(build_fiscal_key("RU", fiscal), "")

    def test_requisites_of_other_country_do_not_build_a_key(self):
        self.assertEqual(build_fiscal_key("KZ", {"fn": "7382440900170413", "fd": "72473"}), "")

    def test_unknown_country_gives_empty_key(self):
        for code in ("FR", "", None):
            with self.subTest(code=code):
                self.assertEqual(build_fiscal_key(code, {"fn": "1", "fd": "2"}), "")

    def test_key_that_does_not_fit_the_field_is_an_error(self):
        with self.assertRaises(ValueError):
            build_fiscal_key("RU", {"fn": "1" * FISCAL_KEY_MAX_LENGTH, "fd": "2"})


class NameKeyTests(SimpleTestCase):
    def test_lowercases_and_collapses_whitespace(self):
        self.assertEqual(name_key("  МОЛОКО  Пастер.\t2,5%\n 0.9л "), "молоко пастер. 2,5% 0.9л")

    def test_keeps_punctuation(self):
        self.assertNotEqual(name_key("Кефир 2,5%"), name_key("Кефир 25%"))
        self.assertEqual(name_key("Barilla Spaghetti n.5"), "barilla spaghetti n.5")

    def test_equal_for_composed_and_decomposed_input(self):
        self.assertEqual(name_key("Müller Milch"), name_key("Müller MILCH"))

    def test_empty_input(self):
        self.assertEqual(name_key(""), "")
        self.assertEqual(name_key(None), "")
        self.assertEqual(name_key(" \t\n"), "")

    def test_key_fits_model_field(self):
        key = name_key("товар " * 100)
        self.assertLessEqual(len(key), NAME_KEY_MAX_LENGTH)
        self.assertEqual(key, key.strip())


@tag("integration")
class FiscalKeyUniquenessTests(ReceiptTestCase):
    KEY = "ru:0000000000000001:101"

    def test_repeated_fiscal_key_is_rejected(self):
        self.make_receipt(fiscal_key=self.KEY)
        # Остальные поля другие: магазин, время, номер, сумма.
        self.assertRejected(
            "receipts_receipt_owner_fiscal_key_uniq",
            lambda: self.make_receipt(
                store=self.other_store, fiscal_key=self.KEY, receipt_number="77",
                purchased_at=PURCHASED_AT + timedelta(days=1), purchased_on=PURCHASED_ON + timedelta(days=1),
                total=Decimal("99.00"),
            ),
        )
        self.assertEqual(Receipt.objects.filter(fiscal_key=self.KEY).count(), 1)

    def test_different_fiscal_keys_are_allowed(self):
        self.make_receipt(fiscal_key=self.KEY)
        self.make_receipt(fiscal_key="ru:0000000000000001:102")
        self.assertEqual(Receipt.objects.count(), 2)

    def test_empty_fiscal_key_is_allowed_for_several_receipts(self):
        self.make_receipt(receipt_number="1")
        self.make_receipt(receipt_number="2")
        self.assertEqual(Receipt.objects.filter(fiscal_key="").count(), 2)


@tag("integration")
class StoreNumberUniquenessTests(ReceiptTestCase):
    def numbered(self, **fields):
        fields.setdefault("receipt_number", "5")
        fields.setdefault("shift_number", "139")
        fields.setdefault("register_code", "1")
        return self.make_receipt(**fields)

    def test_repeated_store_date_shift_register_number_is_rejected(self):
        self.numbered()
        # Время, сумма и фискальный ключ другие — номер всё равно занят.
        self.assertRejected(
            "receipts_receipt_owner_store_number_uniq",
            lambda: self.numbered(
                purchased_at=PURCHASED_AT + timedelta(hours=2), total=Decimal("99.00"),
                fiscal_key="kz:000000000001:1",
            ),
        )

    def test_repeated_number_without_shift_and_register_is_rejected(self):
        self.make_receipt(receipt_number="2968")
        self.assertRejected(
            "receipts_receipt_owner_store_number_uniq",
            lambda: self.make_receipt(receipt_number="2968", total=Decimal("99.00")),
        )

    def test_same_number_in_other_shift_is_allowed(self):
        self.numbered()
        self.numbered(shift_number="140")
        self.assertEqual(Receipt.objects.filter(receipt_number="5").count(), 2)

    def test_same_number_on_other_day_is_allowed(self):
        self.numbered()
        self.numbered(purchased_on=PURCHASED_ON + timedelta(days=1), purchased_at=PURCHASED_AT + timedelta(days=1))
        # У ИП без смены номер уникален в паре с датой.
        self.make_receipt(receipt_number="2968")
        self.make_receipt(receipt_number="2968", purchased_on=PURCHASED_ON + timedelta(days=1))
        self.assertEqual(Receipt.objects.count(), 4)

    def test_same_number_on_other_register_or_in_other_store_is_allowed(self):
        self.numbered()
        self.numbered(register_code="2")
        self.numbered(store=self.other_store)
        self.assertEqual(Receipt.objects.filter(receipt_number="5").count(), 3)


@tag("integration")
class StoreTimeTotalUniquenessTests(ReceiptTestCase):
    def test_repeated_store_time_total_without_number_and_key_is_rejected(self):
        self.make_receipt()
        self.assertRejected(
            "receipts_receipt_owner_store_time_total_uniq",
            lambda: self.make_receipt(purchased_on=PURCHASED_ON + timedelta(days=1), shift_number="7"),
        )

    def test_other_total_time_or_store_is_allowed(self):
        self.make_receipt()
        self.make_receipt(total=Decimal("10.01"))
        self.make_receipt(purchased_at=PURCHASED_AT + timedelta(minutes=1))
        self.make_receipt(store=self.other_store)
        self.assertEqual(Receipt.objects.count(), 4)

    def test_level_does_not_apply_to_receipts_with_number_or_key(self):
        self.make_receipt()
        self.make_receipt(receipt_number="5")
        self.make_receipt(fiscal_key="ru:0000000000000001:101")
        self.make_receipt(fiscal_key="ru:0000000000000001:102")
        self.assertEqual(Receipt.objects.count(), 4)


@tag("integration")
class FindDuplicatesTests(ReceiptTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.country_ru = Country.objects.get_or_create(code="RU", defaults={"name": "Россия"})[0]
        cls.store_ru = Store.objects.create(
            merchant=Merchant.objects.create(country=cls.country_ru, legal_name="ООО «Тестовый продавец»"),
            country=cls.country_ru, address_raw="г. Тестовск, ул. Примерная, 3", timezone="Asia/Novokuznetsk",
        )
        cls.fiscal = {"fn": "0000000000000001", "fd": "101"}
        cls.owner = local_user()
        cls.saved = Receipt.objects.create(
            owner=cls.owner, store=cls.store_ru, currency=cls.currency, operation="sale",
            purchased_at=PURCHASED_AT, purchased_on=PURCHASED_ON, total=Decimal("130.59"),
            receipt_number="5", shift_number="139", register_code="1",
            fiscal=cls.fiscal, fiscal_key=build_fiscal_key("RU", cls.fiscal),
        )
        # Соседние чеки, которые дубликатами не являются.
        cls.neighbour = Receipt.objects.create(
            owner=cls.owner, store=cls.store_ru, currency=cls.currency, operation="sale",
            purchased_at=PURCHASED_AT + timedelta(minutes=5), purchased_on=PURCHASED_ON, total=Decimal("45.00"),
            receipt_number="6", shift_number="139", register_code="1", fiscal_key="ru:0000000000000001:102",
        )

    def test_finds_by_fiscal_key(self):
        self.assertEqual(find_duplicates({"fiscal_key": "ru:0000000000000001:101"}), [self.saved])

    def test_builds_fiscal_key_from_requisites(self):
        for store in (self.store_ru, self.store_ru.pk):
            with self.subTest(store=store):
                self.assertEqual(find_duplicates({"store": store, "fiscal": {"fn": "0000 0000 0000 0001", "fd": 101}}), [self.saved])

    def test_finds_keyed_receipt_by_number_without_key(self):
        data = {"store": self.store_ru, "purchased_on": PURCHASED_ON, "receipt_number": "5", "shift_number": "139", "register_code": "1"}
        self.assertEqual(find_duplicates(data), [self.saved])

    def test_finds_keyed_receipt_by_number_when_shift_and_register_are_unknown(self):
        data = {"store_id": self.store_ru.pk, "purchased_on": PURCHASED_ON, "receipt_number": "5"}
        self.assertEqual(find_duplicates(data), [self.saved])

    def test_finds_keyed_receipt_by_time_and_total_without_key_and_number(self):
        # БД такой повтор не ловит: у сохранённого чека есть ключ и номер, у ввода — нет.
        data = {"store": self.store_ru, "purchased_at": PURCHASED_AT, "purchased_on": PURCHASED_ON, "total": Decimal("130.59")}
        self.assertEqual(find_duplicates(data), [self.saved])
        Receipt.objects.create(owner=self.owner, currency=self.currency, operation="sale", **data)
        self.assertEqual(Receipt.objects.filter(store=self.store_ru, purchased_at=PURCHASED_AT).count(), 2)

    def test_finds_receipt_saved_without_shift_by_input_with_shift(self):
        saved = self.make_receipt(receipt_number="2968")
        data = {"store": self.store, "purchased_on": PURCHASED_ON, "receipt_number": "2968", "shift_number": "12"}
        self.assertEqual(find_duplicates(data), [saved])

    def test_other_shift_day_store_or_total_is_not_a_duplicate(self):
        base = {"store": self.store_ru, "purchased_on": PURCHASED_ON, "receipt_number": "5", "shift_number": "139"}
        for change in (
            {"shift_number": "140"},
            {"register_code": "2"},
            {"purchased_on": PURCHASED_ON + timedelta(days=1)},
            {"store": self.store},
            {"receipt_number": "7"},
        ):
            with self.subTest(change=change):
                self.assertEqual(find_duplicates({**base, **change}), [])
        timed = {"store": self.store_ru, "purchased_at": PURCHASED_AT, "total": Decimal("130.59")}
        for change in ({"total": Decimal("130.60")}, {"purchased_at": PURCHASED_AT + timedelta(minutes=1)}, {"store": self.store}):
            with self.subTest(change=change):
                self.assertEqual(find_duplicates({**timed, **change}), [])

    def test_empty_input_finds_nothing(self):
        self.assertEqual(find_duplicates({}), [])
        self.assertEqual(find_duplicates({"store": self.store_ru}), [])

    def test_results_go_from_stronger_level_to_weaker_without_repeats(self):
        by_time = Receipt.objects.create(
            owner=self.owner, store=self.store_ru, currency=self.currency, operation="sale",
            purchased_at=PURCHASED_AT, purchased_on=PURCHASED_ON, total=Decimal("45.00"),
        )
        data = {
            "store": self.store_ru, "fiscal_key": self.saved.fiscal_key,
            "purchased_on": PURCHASED_ON, "receipt_number": "6", "shift_number": "139", "register_code": "1",
            "purchased_at": PURCHASED_AT, "total": Decimal("45.00"),
        }
        self.assertEqual(find_duplicates(data), [self.saved, self.neighbour, by_time])
        data["receipt_number"] = "5"
        self.assertEqual(find_duplicates(data), [self.saved, by_time])

    def test_accepts_receipt_instance_and_excludes_itself(self):
        self.assertEqual(find_duplicates(self.saved), [])
        unsaved = Receipt(
            owner=self.owner, store=self.store_ru, currency=self.currency, operation="sale",
            purchased_at=datetime(2026, 3, 14, 18, 0, tzinfo=timezone.utc), purchased_on=date(2026, 3, 14),
            total=Decimal("1.00"), receipt_number="5", shift_number="139", register_code="1",
        )
        self.assertEqual(find_duplicates(unsaved), [self.saved])


@tag("integration")
class FindAliasTests(ReceiptTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.other_merchant = Merchant.objects.create(country=cls.country, legal_name="ТОО «Другой продавец»")

    def make_alias(self, raw_name, store_item_code="", merchant=None):
        return ProductAlias.objects.create(
            merchant=merchant or self.merchant, product=self.product,
            name_key=name_key(raw_name), raw_name=raw_name, store_item_code=store_item_code,
        )

    def test_finds_by_store_item_code_when_code_is_given(self):
        alias = self.make_alias("Молоко 2,5% 0.9л", "3079")
        self.make_alias("Кефир 1%", "3080")
        found = find_alias(self.merchant, "МОЛОКО ПАСТ. 2,5%", "3079")
        self.assertEqual(found, alias)
        self.assertEqual(found.product, self.product)

    def test_code_takes_priority_over_name(self):
        self.make_alias("Молоко 2,5% 0.9л")
        self.assertIsNone(find_alias(self.merchant, "Молоко 2,5% 0.9л", "9999"))

    def test_prefers_exact_name_among_aliases_with_the_same_code(self):
        self.make_alias("Молоко 2,5% 0.9л", "3079")
        exact = self.make_alias("Молоко паст. 2,5%", "3079")
        self.assertEqual(find_alias(self.merchant, "МОЛОКО  ПАСТ. 2,5%", "3079"), exact)

    def test_finds_by_name_key_without_code(self):
        with_code = self.make_alias("Молоко 2,5% 0.9л", "3079")
        self.assertEqual(find_alias(self.merchant, " молоко  2,5% 0.9Л "), with_code)
        without_code = self.make_alias("Молоко 2,5% 0.9л")
        self.assertEqual(find_alias(self.merchant, "Молоко 2,5% 0.9л"), without_code)

    def test_scope_is_the_merchant(self):
        self.make_alias("Молоко 2,5% 0.9л", "3079", merchant=self.other_merchant)
        self.assertIsNone(find_alias(self.merchant, "Молоко 2,5% 0.9л", "3079"))
        self.assertIsNone(find_alias(self.merchant, "Молоко 2,5% 0.9л"))
