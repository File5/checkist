from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.test import TestCase, tag

from stores.models import Country, Currency, Merchant, Store, TaxRate

# Все названия и налоговые номера вымышленные.


def make_country(code="XA", name="Тестовая страна"):
    return Country.objects.create(code=code, name=name)


def make_merchant(country, **fields):
    fields.setdefault("legal_name", "ТОО «Тестовый продавец»")
    return Merchant.objects.create(country=country, **fields)


def make_store(merchant, **fields):
    fields.setdefault("country", merchant.country)
    fields.setdefault("address_raw", "г. Тестоград, ул. Примерная, 1")
    fields.setdefault("timezone", "Asia/Almaty")
    return Store.objects.create(merchant=merchant, **fields)


class ConstraintTestCase(TestCase):
    def assertRejected(self, constraint, operation):
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            operation()
        self.assertIn(constraint, str(caught.exception))


@tag("integration")
class TaxRateConstraintTests(ConstraintTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.country = make_country()

    def test_exempt_without_rate_twice_is_rejected(self):
        TaxRate.objects.create(country=self.country, kind="exempt", rate=None, name="Без НДС")
        self.assertRejected(
            "stores_taxrate_country_kind_rate_uniq",
            lambda: TaxRate.objects.create(
                country=self.country, kind="exempt", rate=None, name="Без НДС (повтор)",
            ),
        )
        self.assertEqual(TaxRate.objects.filter(country=self.country, kind="exempt").count(), 1)

    def test_exempt_is_allowed_once_per_country(self):
        other = make_country("XB", "Другая тестовая страна")
        TaxRate.objects.create(country=self.country, kind="exempt", rate=None, name="Без НДС")
        TaxRate.objects.create(country=other, kind="exempt", rate=None, name="Без НДС")
        self.assertEqual(TaxRate.objects.filter(kind="exempt", country__in=[self.country, other]).count(), 2)

    def test_same_vat_rate_twice_is_rejected(self):
        TaxRate.objects.create(country=self.country, kind="vat", rate=Decimal("12.00"), name="НДС 12%")
        self.assertRejected(
            "stores_taxrate_country_kind_rate_uniq",
            lambda: TaxRate.objects.create(
                country=self.country, kind="vat", rate=Decimal("12.00"), name="НДС 12% (повтор)",
            ),
        )

    def test_exempt_with_rate_is_rejected(self):
        for rate in (Decimal("0.00"), Decimal("12.00")):
            with self.subTest(rate=rate):
                self.assertRejected(
                    "stores_taxrate_kind_rate_check",
                    lambda: TaxRate.objects.create(
                        country=self.country, kind="exempt", rate=rate, name="Без НДС",
                    ),
                )

    def test_vat_without_rate_is_rejected(self):
        self.assertRejected(
            "stores_taxrate_kind_rate_check",
            lambda: TaxRate.objects.create(country=self.country, kind="vat", rate=None, name="НДС"),
        )

    def test_negative_vat_rate_is_rejected(self):
        self.assertRejected(
            "stores_taxrate_kind_rate_check",
            lambda: TaxRate.objects.create(
                country=self.country, kind="vat", rate=Decimal("-1.00"), name="НДС -1%",
            ),
        )

    def test_unknown_kind_is_rejected(self):
        self.assertRejected(
            "stores_taxrate_kind_rate_check",
            lambda: TaxRate.objects.create(
                country=self.country, kind="sales", rate=Decimal("5.00"), name="Налог 5%",
            ),
        )

    def test_zero_vat_rate_is_allowed_and_differs_from_exempt(self):
        zero = TaxRate.objects.create(country=self.country, kind="vat", rate=Decimal("0.00"), name="НДС 0%")
        exempt = TaxRate.objects.create(country=self.country, kind="exempt", rate=None, name="Без НДС")
        self.assertNotEqual(zero.pk, exempt.pk)
        zero.refresh_from_db()
        exempt.refresh_from_db()
        self.assertEqual(zero.rate, Decimal("0.00"))
        self.assertIsNone(exempt.rate)
        self.assertEqual(TaxRate.objects.get(country=self.country, rate=0).pk, zero.pk)
        self.assertEqual(TaxRate.objects.get(country=self.country, rate__isnull=True).pk, exempt.pk)


@tag("integration")
class MerchantConstraintTests(ConstraintTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.country = make_country()

    def test_same_country_and_tax_id_is_rejected(self):
        make_merchant(self.country, tax_id_type="bin", tax_id="000000000001")
        self.assertRejected(
            "stores_merchant_country_tax_id_uniq",
            lambda: make_merchant(
                self.country, legal_name="ТОО «Другой продавец»", tax_id_type="bin", tax_id="000000000001",
            ),
        )

    def test_same_tax_id_in_other_country_is_allowed(self):
        other = make_country("XB", "Другая тестовая страна")
        make_merchant(self.country, tax_id_type="bin", tax_id="000000000001")
        make_merchant(other, tax_id_type="inn", tax_id="000000000001")
        self.assertEqual(Merchant.objects.filter(tax_id="000000000001").count(), 2)

    def test_empty_tax_id_is_allowed_for_several_merchants(self):
        first = make_merchant(self.country, legal_name="Продавец без номера 1")
        second = make_merchant(self.country, legal_name="Продавец без номера 2")
        self.assertEqual(first.tax_id, "")
        self.assertEqual(second.tax_id, "")
        self.assertEqual(Merchant.objects.filter(country=self.country, tax_id="").count(), 2)

    def test_optional_fields_default_to_empty_values(self):
        merchant = make_merchant(self.country)
        merchant.refresh_from_db()
        self.assertEqual(
            (merchant.brand_name, merchant.tax_id_type, merchant.tax_id, merchant.extra),
            ("", "", "", {}),
        )


@tag("integration")
class StoreConstraintTests(ConstraintTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.country = make_country()
        cls.merchant = make_merchant(cls.country, tax_id_type="bin", tax_id="000000000001")
        cls.other_merchant = make_merchant(
            cls.country, legal_name="ТОО «Другой продавец»", tax_id_type="bin", tax_id="000000000002",
        )

    def test_same_merchant_and_address_key_is_rejected(self):
        make_store(self.merchant, address_raw="г. Тестоград, ул. Примерная, 1")
        self.assertRejected(
            "stores_store_merchant_address_key_uniq",
            lambda: make_store(self.merchant, address_raw="Г.ТЕСТОГРАД,  УЛ.ПРИМЕРНАЯ,1"),
        )

    def test_same_address_for_other_merchant_is_allowed(self):
        first = make_store(self.merchant)
        second = make_store(self.other_merchant)
        self.assertEqual(first.address_key, second.address_key)

    def test_same_merchant_and_branch_code_is_rejected(self):
        make_store(self.merchant, branch_code="5597", address_raw="ул. Первая, 1")
        self.assertRejected(
            "stores_store_merchant_branch_code_uniq",
            lambda: make_store(self.merchant, branch_code="5597", address_raw="ул. Вторая, 2"),
        )

    def test_same_branch_code_for_other_merchant_is_allowed(self):
        make_store(self.merchant, branch_code="5597")
        make_store(self.other_merchant, branch_code="5597")
        self.assertEqual(Store.objects.filter(branch_code="5597").count(), 2)

    def test_empty_branch_code_is_allowed_for_several_stores(self):
        make_store(self.merchant, address_raw="ул. Первая, 1")
        make_store(self.merchant, address_raw="ул. Вторая, 2")
        self.assertEqual(Store.objects.filter(merchant=self.merchant, branch_code="").count(), 2)

    def test_save_builds_address_key_from_raw_address(self):
        store = make_store(self.merchant, address_raw="г. Тестоград, ул. Примерная, 1")
        store.refresh_from_db()
        self.assertEqual(store.address_key, "г тестоград ул примерная 1")
        self.assertEqual(store.address_i18n, {})

    def test_bilingual_store_is_not_duplicated_by_input_order(self):
        kk, ru = "Тестоград қ., Үлгі к-сі, 1", "г. Тестоград, ул. Примерная, 1"
        store = make_store(self.merchant, address_raw=kk, address_i18n={"kk": kk, "ru": ru})
        self.assertEqual(store.address_key, "тестоград қ үлгі к сі 1")
        self.assertRejected(
            "stores_store_merchant_address_key_uniq",
            lambda: make_store(self.merchant, address_raw=ru, address_i18n={"ru": ru, "kk": kk}),
        )

    def test_explicit_address_key_is_kept(self):
        store = make_store(self.merchant, address_key="свой ключ")
        store.address_raw = "ул. Новая, 5"
        store.save()
        store.refresh_from_db()
        self.assertEqual(store.address_key, "свой ключ")


@tag("integration")
class ProtectTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.country = make_country()
        cls.store_country = make_country("XB", "Страна точки")
        cls.merchant = make_merchant(cls.country)

    def test_country_with_tax_rate_is_protected(self):
        TaxRate.objects.create(country=self.store_country, kind="exempt", rate=None, name="Без НДС")
        with self.assertRaises(ProtectedError):
            self.store_country.delete()
        self.assertTrue(Country.objects.filter(pk="XB").exists())

    def test_country_with_merchant_is_protected(self):
        with self.assertRaises(ProtectedError):
            self.country.delete()
        self.assertTrue(Country.objects.filter(pk="XA").exists())

    def test_country_with_store_is_protected(self):
        make_store(self.merchant, country=self.store_country)
        with self.assertRaises(ProtectedError):
            self.store_country.delete()
        self.assertTrue(Country.objects.filter(pk="XB").exists())

    def test_merchant_with_store_is_protected(self):
        make_store(self.merchant)
        with self.assertRaises(ProtectedError):
            self.merchant.delete()
        self.assertTrue(Merchant.objects.filter(pk=self.merchant.pk).exists())

    def test_database_rejects_deleting_referenced_rows(self):
        # PROTECT — правило ORM; обход через сырой SQL останавливает внешний ключ БД.
        make_store(self.merchant)
        for table, column, value in (
            ("stores_merchant", "id", self.merchant.pk),
            ("stores_country", "code", self.country.pk),
        ):
            with self.subTest(table=table):
                with self.assertRaises(IntegrityError), transaction.atomic():
                    with transaction.get_connection().cursor() as cursor:
                        cursor.execute(f"DELETE FROM {table} WHERE {column} = %s", [value])
                        cursor.execute("SET CONSTRAINTS ALL IMMEDIATE")

    def test_unreferenced_rows_can_be_deleted(self):
        store = make_store(self.merchant)
        store.delete()
        self.merchant.delete()
        self.country.delete()
        self.store_country.delete()
        currency = Currency.objects.create(code="XTS", name="Тестовая валюта")
        currency.delete()
        self.assertFalse(Country.objects.filter(pk__in=["XA", "XB"]).exists())
        self.assertFalse(Currency.objects.filter(pk="XTS").exists())
