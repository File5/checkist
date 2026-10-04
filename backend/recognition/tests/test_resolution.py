from dataclasses import replace
from decimal import Decimal

from django.test import SimpleTestCase, TestCase, override_settings, tag

from catalog.models import Brand, Category, GenericProduct, Product
from receipts.models import ProductAlias
from recognition.resolution import (
    ResolutionError, canonical_gtin, purchased_at, resolve_country,
    resolve_product, resolve_store, resolve_tax_rate,
)
from stores.models import Country, Merchant, Store, TaxRate
from .import_fixtures import observation


class GTINTests(SimpleTestCase):
    def test_valid_lengths_and_leading_zeros(self):
        for value in ("96385074", "036000291452", "4006381333931", "04006381333931"):
            with self.subTest(value=value):
                self.assertEqual(canonical_gtin(value), value.zfill(14))

    def test_invalid_checksum_format_and_internal_code(self):
        for value in (None, "", "123", "4006381333932", "400638133393X", "４００６３８１３３３９３１"):
            self.assertIsNone(canonical_gtin(value))


@tag("integration")
class ResolutionTests(TestCase):
    def setUp(self):
        self.obs = observation()
        self.country = resolve_country(self.obs)
        self.merchant = Merchant.objects.create(country=self.country, legal_name="Fictional seller")
        category = Category.objects.create(name="Тестовая категория")
        self.generic = GenericProduct.objects.create(name="Тестовый продукт", category=category, base_unit="pcs")
        self.line = self.obs.lines[0]

    def product(self, **fields):
        values = {"name": "MILCH 1 L", "generic": self.generic}
        values.update(fields)
        return Product.objects.create(**values)

    def test_gtin_precedes_name_and_equivalent_lengths(self):
        product = self.product(name="Other printed name", gtin="4006381333931")
        line = replace(self.line, product_hint=replace(self.line.product_hint, gtin="04006381333931"))
        result = resolve_product(line, self.merchant)
        self.assertEqual(result.product, product)
        self.assertEqual(result.issues, [])
        self.assertEqual(ProductAlias.objects.get().product, product)

    def test_equivalent_gtins_on_multiple_products_are_ambiguous(self):
        self.product(gtin="4006381333931")
        self.product(name="Other name", gtin="04006381333931")
        line = replace(self.line, barcode="4006381333931")
        result = resolve_product(line, self.merchant)
        self.assertIsNone(result.product)
        self.assertEqual(result.issues[0]["code"], "product_ambiguous")
        self.assertEqual(Product.objects.count(), 2)

    def test_alias_code_and_merchant_scope(self):
        first = self.product(name="Milk A")
        second = self.product(name="Milk B")
        ProductAlias.objects.create(merchant=self.merchant, product=first, raw_name="MILCH 1 L", name_key="milch 1 l", store_item_code="A")
        ProductAlias.objects.create(merchant=self.merchant, product=second, raw_name="MILCH 1 L", name_key="milch 1 l", store_item_code="B")
        self.assertEqual(resolve_product(replace(self.line, store_item_code="B"), self.merchant).product, second)
        result = resolve_product(self.line, self.merchant)
        self.assertIsNone(result.product)
        self.assertEqual(result.issues[0]["code"], "product_ambiguous")
        other = Merchant.objects.create(country=self.country, legal_name="Another seller")
        result = resolve_product(replace(self.line, store_item_code="B"), other)
        self.assertNotIn(result.product, (first, second))

    def test_gtin_conflicting_with_alias_does_not_rebind(self):
        gtin_product = self.product(name="GTIN milk", gtin="4006381333931")
        old = self.product(name="Aliased milk")
        alias = ProductAlias.objects.create(merchant=self.merchant, product=old, raw_name=self.line.raw_name, name_key="milch 1 l")
        result = resolve_product(replace(self.line, barcode=gtin_product.gtin), self.merchant)
        self.assertEqual(result.issues[0]["code"], "product_conflict")
        alias.refresh_from_db()
        self.assertEqual(alias.product, old)

    def test_exact_normalized_name_and_package(self):
        first = self.product(name="Milch   1 L", package_quantity="1.000", package_unit="l")
        self.product(name="MILCH 1 L", package_quantity="2.000", package_unit="l")
        hint = replace(self.line.product_hint, package_quantity=Decimal("1.000"), package_unit="l")
        self.assertEqual(resolve_product(replace(self.line, product_hint=hint), self.merchant).product, first)

    def test_missing_package_with_multiple_variants_is_ambiguous(self):
        self.product(package_quantity="1.000", package_unit="l")
        self.product(package_quantity="2.000", package_unit="l")
        result = resolve_product(self.line, self.merchant)
        self.assertIsNone(result.product)
        self.assertEqual(result.issues[0]["code"], "product_ambiguous")
        self.assertFalse(ProductAlias.objects.exists())

    def test_autocreate_is_idempotent_and_uses_service_generic(self):
        first = resolve_product(self.line, self.merchant)
        second = resolve_product(self.line, self.merchant)
        self.assertEqual(first.product.pk, second.product.pk)
        self.assertEqual(Product.objects.count(), 1)
        self.assertEqual(ProductAlias.objects.count(), 1)
        self.assertEqual(first.product.generic.name, "Не разобрано")
        self.assertEqual(Category.objects.filter(name="Не разобрано").count(), 1)
        self.assertEqual(first.product.generic.base_unit, "pcs")

    def test_explicit_new_brand_creates_a_distinct_product(self):
        brand = Brand.objects.create(name="Brand A")
        self.product(brand=brand)
        hint = replace(self.line.product_hint, brand="Brand B")
        result = resolve_product(replace(self.line, product_hint=hint), self.merchant)
        self.assertEqual(result.issues, [])
        self.assertEqual(result.product.brand.name, "Brand B")
        self.assertEqual(Product.objects.count(), 2)

    def test_tax_id_format_rejected_before_merchant_creation(self):
        obs = replace(self.obs, merchant=replace(self.obs.merchant, tax_id_type="vat_id", tax_id="DEINVALID"))
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(obs, self.country)
        self.assertEqual(caught.exception.issues[0]["code"], "merchant_tax_id_invalid")
        self.assertEqual(Merchant.objects.count(), 1)
        self.assertEqual(Store.objects.count(), 0)

    def test_service_deposit_return_do_not_create_catalog_goods(self):
        for kind in ("service", "deposit", "deposit_return"):
            self.assertIsNone(resolve_product(replace(self.line, kind=kind), self.merchant).product)
        self.assertFalse(Product.objects.exists())

    def test_country_fallback_and_unknown(self):
        obs = replace(self.obs, store=replace(self.obs.store, country_code=None), merchant=replace(self.obs.merchant, country_code=None))
        self.assertEqual(resolve_country(obs).pk, "DE")
        with override_settings(RECEIPT_OCR_DEFAULT_COUNTRY="RU"):
            self.assertEqual(resolve_country(replace(obs, currency_code="XTS")).pk, "RU")
        with self.assertRaises(ResolutionError):
            resolve_country(replace(obs, currency_code="XTS"))

    def test_tax_id_address_and_branch_do_not_create_duplicate_store(self):
        incoming = replace(self.obs.merchant, tax_id="DE 999 999 999", tax_id_type="vat_id")
        obs = replace(self.obs, merchant=incoming, store=replace(self.obs.store, branch_code="12"))
        store = resolve_store(obs, self.country)
        self.assertEqual(store.timezone, "Europe/Berlin")
        same_address = replace(obs, store=replace(obs.store, address_raw="TESTSTRASSE 12  10115 Berlin", branch_code=None))
        self.assertEqual(resolve_store(same_address, self.country), store)
        same_branch = replace(obs, store=replace(obs.store, address_raw="Better address writing"))
        self.assertEqual(resolve_store(same_branch, self.country), store)
        self.assertEqual(Merchant.objects.get(tax_id="DE999999999").pk, store.merchant_id)
        store.refresh_from_db()
        self.assertEqual(store.address_raw, self.obs.store.address_raw)

    def test_conflicting_address_and_branch_is_ambiguous(self):
        obs = replace(self.obs, store=replace(self.obs.store, branch_code="A"))
        first = resolve_store(obs, self.country)
        Store.objects.create(merchant=first.merchant, country=self.country, branch_code="B", address_raw="Other street 2", timezone="Europe/Berlin")
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(replace(obs, store=replace(obs.store, branch_code="B")), self.country)
        self.assertEqual(caught.exception.issues[0]["code"], "store_ambiguous")

    def test_tax_rate_matches_country_kind_rate_not_letter(self):
        rate = self.line.tax_rate
        first = resolve_tax_rate(rate, self.country, "/taxes")
        self.assertEqual(resolve_tax_rate(rate, self.country, "/taxes"), first)
        ru = Country.objects.get(pk="RU")
        self.assertNotEqual(resolve_tax_rate(rate, ru, "/taxes"), first)
        exempt = resolve_tax_rate(replace(rate, kind="exempt", rate=None), self.country, "/taxes")
        zero = resolve_tax_rate(replace(rate, rate=Decimal("0.00")), self.country, "/taxes")
        self.assertNotEqual(exempt.pk, zero.pk)
        self.assertEqual(TaxRate.objects.filter(country=self.country, kind="vat", rate="7.00").count(), 1)

    def test_timezone_dst_gap_fold_and_printed_offset(self):
        store = resolve_store(self.obs, self.country)
        for day, clock in (("2026-03-29", "02:30:00"), ("2026-10-25", "02:30:00")):
            obs = replace(self.obs, purchased_on=day, local_time=clock)
            with self.assertRaises(ResolutionError):
                purchased_at(obs, store)
        obs = replace(self.obs, purchased_on="2026-10-25", local_time="02:30:00", utc_offset_printed="+02:00")
        self.assertEqual(purchased_at(obs, store).isoformat(), "2026-10-25T00:30:00+00:00")
