from dataclasses import replace
from decimal import Decimal

from django.test import SimpleTestCase, TestCase, override_settings, tag
from django.db import connection
from django.test.utils import CaptureQueriesContext

from catalog.models import Brand, Category, GenericProduct, Product
from receipts.models import ProductAlias
from recognition.resolution import (
    ResolutionError, canonical_gtin, purchased_at, resolve_country,
    resolve_product, resolve_store, resolve_tax_rate,
)
from stores.models import Country, Merchant, Store, TaxRate
from .import_fixtures import lidl_format_payload, observation


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

    def assert_tax_id_completeness_reuses_store(self, first_id, second_id):
        def observed(tax_id):
            return replace(self.obs, merchant=replace(
                self.obs.merchant, tax_id=tax_id, tax_id_type="vat_id" if tax_id else None,
            ))

        first = resolve_store(observed(first_id), self.country)
        second = resolve_store(observed(second_id), self.country)
        self.assertEqual(second.pk, first.pk)
        self.assertEqual(second.merchant_id, first.merchant_id)
        first.merchant.refresh_from_db()
        self.assertEqual(first.merchant.tax_id, "DE999999994")
        self.assertEqual(first.merchant.tax_id_type, "vat_id")
        self.assertEqual(Merchant.objects.filter(legal_name=self.obs.merchant.legal_name).count(), 1)
        self.assertEqual(Store.objects.count(), 1)

    def test_tax_id_then_absent_reuses_store(self):
        self.assert_tax_id_completeness_reuses_store("DE999999994", None)

    def test_absent_then_tax_id_reuses_store(self):
        self.assert_tax_id_completeness_reuses_store(None, "DE999999994")

    def test_different_nonempty_tax_ids_keep_separate_merchants_and_stores(self):
        first = resolve_store(replace(self.obs, merchant=replace(
            self.obs.merchant, tax_id="DE999999994", tax_id_type="vat_id",
        )), self.country)
        notices = []
        second = resolve_store(replace(self.obs, merchant=replace(
            self.obs.merchant, tax_id="DE999999995", tax_id_type="vat_id",
        )), self.country, notices=notices)
        self.assertNotEqual(first.pk, second.pk)
        self.assertNotEqual(first.merchant_id, second.merchant_id)
        first.merchant.refresh_from_db()
        self.assertEqual(first.merchant.tax_id, "DE999999994")
        self.assertEqual(notices, [{"code": "merchant_conflict", "field": "/merchant/tax_id",
                                    "message": "Результат требует проверки."}])

    def make_same_named_location(self, tax_id="", **store_fields):
        merchant = Merchant.objects.create(
            country=self.country, legal_name=self.obs.merchant.legal_name,
            tax_id=tax_id, tax_id_type="vat_id" if tax_id else "",
        )
        values = dict(country=self.country, name=self.obs.store.name,
                      address_raw=self.obs.store.address_raw, timezone="Europe/Berlin")
        values.update(store_fields)
        return Store.objects.create(merchant=merchant, **values)

    def test_absent_tax_id_with_two_known_sellers_is_ambiguous(self):
        self.make_same_named_location("DE999999994")
        self.make_same_named_location("DE999999995")
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(self.obs, self.country)
        self.assertEqual(caught.exception.issues[0]["code"], "store_ambiguous")
        self.assertEqual(Store.objects.count(), 2)

    def test_new_tax_id_with_two_blank_candidates_does_not_enrich_either(self):
        first = self.make_same_named_location()
        second = self.make_same_named_location()
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(replace(self.obs, merchant=replace(
                self.obs.merchant, tax_id="DE999999994", tax_id_type="vat_id",
            )), self.country)
        self.assertEqual(caught.exception.issues[0]["code"], "store_ambiguous")
        self.assertEqual(Merchant.objects.filter(pk__in=[first.merchant_id, second.merchant_id], tax_id="").count(), 2)

    def test_new_tax_id_already_owned_elsewhere_requires_review(self):
        store = self.make_same_named_location()
        Merchant.objects.create(country=self.country, legal_name="Different seller", tax_id="DE999999994")
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(replace(self.obs, merchant=replace(self.obs.merchant, tax_id="DE999999994")), self.country)
        self.assertEqual(caught.exception.issues[0]["code"], "store_ambiguous")
        store.merchant.refresh_from_db()
        self.assertEqual(store.merchant.tax_id, "")

    def test_branch_completion_then_branch_only_reuses_store_without_tax_id(self):
        first = resolve_store(self.obs, self.country)
        improved = replace(self.obs, merchant=replace(self.obs.merchant, tax_id="DE999999994"),
                           store=replace(self.obs.store, branch_code="12", postal_code=None,
                                         address_raw="TESTSTRASSE 12  10115 Berlin"))
        self.assertEqual(resolve_store(improved, self.country).pk, first.pk)
        branch_only = replace(self.obs, store=replace(self.obs.store, branch_code="12", address_raw=None))
        self.assertEqual(resolve_store(branch_only, self.country).pk, first.pk)
        first.refresh_from_db()
        self.assertEqual(first.branch_code, "12")
        self.assertEqual(first.address_raw, self.obs.store.address_raw)
        self.assertEqual(first.postal_code, self.obs.store.postal_code)

    def test_different_nonempty_branch_code_cannot_rewrite_known_store(self):
        first = resolve_store(replace(self.obs, store=replace(self.obs.store, branch_code="12")), self.country)
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(replace(self.obs, store=replace(self.obs.store, branch_code="13")), self.country)
        self.assertEqual(caught.exception.issues[0], {"code": "store_conflict", "field": "/store/branch_code",
                                                    "message": "Результат требует проверки."})
        first.refresh_from_db()
        self.assertEqual(first.branch_code, "12")

    def test_missing_tax_id_does_not_match_different_store_name(self):
        first = resolve_store(self.obs, self.country)
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(replace(self.obs, store=replace(self.obs.store, name="Different shop")), self.country)
        self.assertEqual(caught.exception.issues[0]["code"], "store_conflict")
        self.assertEqual(Store.objects.count(), 1)
        self.assertEqual(first.name, self.obs.store.name)

    def test_name_fallback_can_disambiguate_store_names(self):
        wrong = self.make_same_named_location("DE999999995", name="Different shop")
        right = self.make_same_named_location("DE999999994")
        self.assertEqual(resolve_store(self.obs, self.country).pk, right.pk)
        self.assertNotEqual(right.merchant_id, wrong.merchant_id)

    def test_fallback_requires_same_merchant_and_store_countries(self):
        first = resolve_store(self.obs, self.country)
        ru = Country.objects.get(pk="RU")
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(replace(self.obs, store=replace(self.obs.store, country_code="RU")), ru)
        self.assertEqual(caught.exception.issues[0]["code"], "store_conflict")
        different_registration = replace(self.obs, merchant=replace(self.obs.merchant, country_code="RU"))
        second = resolve_store(different_registration, self.country)
        self.assertNotEqual(first.merchant_id, second.merchant_id)

    def test_completion_preserves_nonempty_tax_id_type_and_other_merchant_fields(self):
        first = resolve_store(self.obs, self.country)
        Merchant.objects.filter(pk=first.merchant_id).update(tax_id_type="other", extra={"test": "preserved"})
        result = resolve_store(replace(self.obs, merchant=replace(
            self.obs.merchant, tax_id="DE999999994", tax_id_type="vat_id",
        )), self.country)
        self.assertEqual(result.pk, first.pk)
        self.assertEqual(result.merchant.tax_id_type, "other")
        self.assertEqual(result.merchant.extra, {"test": "preserved"})

    def test_store_name_does_not_hide_conflicting_address_and_branch(self):
        first = resolve_store(self.obs, self.country)
        Store.objects.create(merchant=first.merchant, country=self.country, name="Different shop",
                             branch_code="12", address_raw="Other street 2", timezone="Europe/Berlin")
        with self.assertRaises(ResolutionError) as caught:
            resolve_store(replace(self.obs, store=replace(self.obs.store, branch_code="12")), self.country)
        self.assertEqual(caught.exception.issues[0]["code"], "store_ambiguous")
        first.refresh_from_db()
        self.assertEqual(first.branch_code, "")

    def test_location_candidates_do_not_add_per_candidate_queries(self):
        store = self.make_same_named_location("DE999999994")
        with CaptureQueriesContext(connection) as first:
            self.assertEqual(resolve_store(self.obs, self.country).pk, store.pk)
        for index in range(12):
            merchant = Merchant.objects.create(country=self.country, legal_name=f"Other seller {index}")
            Store.objects.create(merchant=merchant, country=self.country,
                                 address_raw=self.obs.store.address_raw, timezone="Europe/Berlin")
        with CaptureQueriesContext(connection) as many:
            self.assertEqual(resolve_store(self.obs, self.country).pk, store.pk)
        self.assertEqual(len(first), len(many))

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

    def test_normalized_fiscal_z_is_utc_and_header_local_time_does_not_conflict(self):
        for offset in ("Z", "z", "+00:00"):
            payload = lidl_format_payload()
            payload["utc_offset_printed"] = payload["timestamps"]["fiscal"]["utc_offset"] = offset
            obs = observation(payload)
            store = resolve_store(obs, resolve_country(obs))
            with self.subTest(offset=offset):
                self.assertEqual(purchased_at(obs, store).isoformat(), "2026-10-01T17:01:56+00:00")
                self.assertEqual(store.timezone, "Europe/Berlin")

    def test_multiline_address_resolves_existing_single_line_store_with_same_key(self):
        payload = lidl_format_payload()
        payload["store"]["address_raw"] = "Testweg 17 88131 Lindau"
        single = observation(payload)
        store = resolve_store(single, resolve_country(single))
        for separator in ("\n", "\r\n", "\r", "\t"):
            payload["store"]["address_raw"] = "Testweg 17" + separator + "88131 Lindau"
            incoming = observation(payload)
            with self.subTest(separator=separator):
                self.assertEqual(resolve_store(incoming, resolve_country(incoming)).pk, store.pk)
                self.assertEqual(Store.objects.count(), 1)
        store.refresh_from_db()
        self.assertEqual(store.address_raw, "Testweg 17 88131 Lindau")
