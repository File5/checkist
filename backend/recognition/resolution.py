"""Exact OCR resolution. Call mutating helpers inside the import mutex/transaction.

Only empty store identity fields are completed; filled values are preserved.
Existing reference/catalog records are never rewritten. No fuzzy matching.
The currency fallback is deliberately limited to the project's RU/KZ/DE scope.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import re

from django.conf import settings
from django.db import transaction
from django.db.models import Q

from catalog.models import Brand, Category, GenericProduct, Product
from catalog.units import BaseUnit
from receipts.dedup import name_key
from receipts.models import ProductAlias
from stores.models import Country, Currency, Merchant, Store, TaxRate
from stores.normalize import address_key

COUNTRY_BY_CURRENCY = {"RUB": "RU", "KZT": "KZ", "EUR": "DE"}
CURRENCY_BY_COUNTRY = {country: currency for currency, country in COUNTRY_BY_CURRENCY.items()}
TIMEZONE_BY_COUNTRY = {"RU": "Europe/Moscow", "KZ": "Asia/Almaty", "DE": "Europe/Berlin"}


def issue(code, field="/", message="Результат требует проверки."):
    return {"code": code, "field": field, "message": message}


class ResolutionError(ValueError):
    def __init__(self, *issues):
        self.issues = list(issues)
        super().__init__(issues[0]["code"])


def clean_save(obj):
    # Constraints are enforced by PostgreSQL, so a concurrent unique violation
    # reaches the importer's explicit race handler rather than full_clean.
    obj.full_clean(validate_unique=False, validate_constraints=False)
    obj.save()
    return obj


def resolve_country(observation):
    code = (observation.store.country_code or observation.merchant.country_code
            or COUNTRY_BY_CURRENCY.get(observation.currency_code)
            or getattr(settings, "RECEIPT_OCR_DEFAULT_COUNTRY", None))
    country = Country.objects.filter(pk=code).first()
    if country is None:
        raise ResolutionError(issue("country_unknown", "/store/country_code"))
    return country


def resolve_currency(observation, *, store=None):
    code = observation.currency_code
    if code is None and store is not None:
        code = CURRENCY_BY_COUNTRY.get(store.country_id)
    currency = Currency.objects.filter(pk=code).first()
    if currency is None:
        raise ResolutionError(issue("currency_unknown", "/currency_code"))
    return currency


def _complete_store_identity(store, tax_id, tax_type, branch_code):
    # Called in resolve_store's transaction and the OCR import mutex. Lock and
    # re-read empty fields before completing them: an external writer may have
    # supplied a different value since candidate selection.
    if branch_code and store.branch_code and branch_code != store.branch_code:
        raise ResolutionError(issue("store_conflict", "/store/branch_code"))
    if tax_id and not store.merchant.tax_id:
        merchant = Merchant.objects.select_for_update().get(pk=store.merchant_id)
        if merchant.tax_id and merchant.tax_id != tax_id:
            raise ResolutionError(issue("merchant_conflict", "/merchant/tax_id"))
        if not merchant.tax_id:
            merchant.tax_id = tax_id
            if not merchant.tax_id_type:
                merchant.tax_id_type = tax_type
            clean_save(merchant)
        store.merchant = merchant
    if branch_code and not store.branch_code:
        merchant = store.merchant
        store = Store.objects.select_for_update().get(pk=store.pk)
        if store.branch_code and store.branch_code != branch_code:
            raise ResolutionError(issue("store_conflict", "/store/branch_code"))
        if not store.branch_code:
            store.branch_code = branch_code
            clean_save(store)
        store.merchant = merchant
    return store


@transaction.atomic
def resolve_store(observation, country, *, allow_create=True, notices=None):
    """Resolve exact, compatible identity despite missing tax ID/branch code.

    A fallback requires a known location and matching merchant/store names in
    the same countries. Conflicting nonempty IDs remain separate sellers;
    several compatible locations require review, never a choice by PK.
    """
    incoming = observation.merchant
    registration = Country.objects.filter(pk=incoming.country_code or country.pk).first()
    if registration is None:
        raise ResolutionError(issue("country_unknown", "/merchant/country_code"))
    tax_id = "".join((incoming.tax_id or "").split()).upper()
    tax_type = incoming.tax_id_type or ""
    if tax_id:
        tax_type = tax_type or {"RU": "inn", "KZ": "bin", "DE": "vat_id"}.get(registration.pk, "other")
        pattern = {"inn": r"(?:[0-9]{10}|[0-9]{12})", "bin": r"[0-9]{12}"}.get(tax_type)
        if tax_type == "vat_id" and registration.pk == "DE":
            pattern = r"DE[0-9]{9}"
        if pattern and not re.fullmatch(pattern, tax_id):
            raise ResolutionError(issue("merchant_tax_id_invalid", "/merchant/tax_id"))
    legal_name = incoming.legal_name or incoming.brand_name or observation.store.name
    if not legal_name:
        raise ResolutionError(issue("missing_required", "/merchant/legal_name"))
    merchants = Merchant.objects.filter(country=registration)
    key = address_key(observation.store.address_raw)
    branches = Q(address_key=key) if key else Q(pk__in=[])
    branch_code = observation.store.branch_code
    if branch_code:
        branches |= Q(branch_code=branch_code)
    # Limit locations in SQL and join each merchant once, then normalize names
    # in Python: these models have no persisted name keys.
    locations = Store.objects.filter(
        branches, country=country, merchant__country=registration,
    ).select_related("merchant")
    named_locations = [s for s in locations.iterator()
                       if name_key(s.merchant.legal_name) == name_key(legal_name)
                       and (not observation.store.name or not s.name
                            or name_key(s.name) == name_key(observation.store.name))]
    compatible = [s for s in named_locations
                  if not tax_id or s.merchant.tax_id in ("", tax_id)]
    if len(compatible) > 1:
        raise ResolutionError(issue("store_ambiguous", "/store"))
    if tax_id and any(s.merchant.tax_id not in ("", tax_id) for s in named_locations):
        if notices is not None:
            notices.append(issue("merchant_conflict", "/merchant/tax_id"))
    if tax_id:
        candidates = list(merchants.filter(tax_id=tax_id))
    else:
        candidates = []
    if compatible:
        store = compatible[0]
        if key and branch_code and Store.objects.filter(
            branches, merchant_id=store.merchant_id,
        ).exclude(pk=store.pk).exists():
            # A different store name must not mask contradictory address/branch
            # matches within the resolved seller (or cause a branch unique error).
            raise ResolutionError(issue("store_ambiguous", "/store"))
        # Do not assign an ID already owned by another Merchant, even if that
        # seller's known branches do not match this photo. No automatic merge.
        if tax_id and candidates and candidates[0].pk != store.merchant_id:
            raise ResolutionError(issue("store_ambiguous", "/store"))
        return _complete_store_identity(store, tax_id, tax_type, branch_code)
    if not tax_id:
        candidates = [m for m in merchants.filter(tax_id="").iterator()
                      if name_key(m.legal_name) == name_key(legal_name)]
    if len(candidates) > 1:
        raise ResolutionError(issue("store_ambiguous", "/store"))
    if candidates:
        merchant = candidates[0]
    else:
        if not allow_create:
            return None
        merchant = clean_save(Merchant(
            country=registration, legal_name=legal_name, brand_name=incoming.brand_name or "",
            tax_id=tax_id, tax_id_type=tax_type,
        ))
    stores = list(Store.objects.filter(branches, merchant=merchant))
    if len(stores) > 1:
        raise ResolutionError(issue("store_ambiguous", "/store"))
    if stores:
        store = stores[0]
        if store.country_id != country.pk:
            raise ResolutionError(issue("store_conflict", "/store/country_code"))
        if (not tax_id and observation.store.name and store.name
                and name_key(store.name) != name_key(observation.store.name)):
            raise ResolutionError(issue("store_conflict", "/store/name"))
        return _complete_store_identity(store, tax_id, tax_type, branch_code)
    if not allow_create:
        return None
    if not key:
        raise ResolutionError(issue("missing_required", "/store/address_raw"))
    zone = TIMEZONE_BY_COUNTRY.get(country.pk, "UTC")
    fields = {k: getattr(observation.store, k) or "" for k in (
        "name", "branch_code", "address_raw", "postal_code", "region", "city", "street", "house",
    )}
    return clean_save(Store(merchant=merchant, country=country, address_key=key, timezone=zone, **fields))


def purchased_at(observation, store):
    naive = datetime.fromisoformat(f"{observation.purchased_on}T{observation.local_time}")
    try:
        zone = ZoneInfo(store.timezone)
    except (ZoneInfoNotFoundError, ValueError):
        raise ResolutionError(issue("timezone_unknown", "/store")) from None
    if observation.utc_offset_printed:
        instant = datetime.fromisoformat(naive.isoformat() + observation.utc_offset_printed)
        if instant.astimezone(zone).date() != naive.date():
            raise ResolutionError(issue("timestamp_conflict", "/utc_offset_printed"))
        return instant.astimezone(timezone.utc)
    instants = set()
    for fold in (0, 1):
        aware = naive.replace(tzinfo=zone, fold=fold)
        utc = aware.astimezone(timezone.utc)
        if utc.astimezone(zone).replace(tzinfo=None) == naive:
            instants.add(utc)
    if len(instants) != 1:
        raise ResolutionError(issue("timestamp_ambiguous", "/local_time"))
    return instants.pop()


def resolve_tax_rate(rate, country, field, *, confirmed=True):
    if rate.kind is None and rate.rate is None:
        return None
    if rate.kind not in TaxRate.Kind.values or (rate.kind == "vat" and (rate.rate is None or rate.rate < 0)) or (rate.kind == "exempt" and rate.rate is not None):
        raise ResolutionError(issue("tax_rate_invalid", field))
    found = TaxRate.objects.filter(country=country, kind=rate.kind, rate=rate.rate).first()
    if found:
        return found
    if not confirmed:
        raise ResolutionError(issue("tax_rate_unconfirmed", field))
    label = "Без НДС" if rate.kind == "exempt" else f"VAT {rate.rate}%"
    return clean_save(TaxRate(country=country, kind=rate.kind, rate=rate.rate, name=label))


def canonical_gtin(value):
    """GTIN8/12/13/14 checksum; preserve zeros, compare padded GTIN14."""
    if not value or len(value) not in (8, 12, 13, 14) or not value.isascii() or not value.isdecimal():
        return None
    checksum = sum(int(v) * (3 if i % 2 == 0 else 1) for i, v in enumerate(reversed(value[:-1])))
    return value.zfill(14) if (checksum + int(value[-1])) % 10 == 0 else None


@dataclass(frozen=True)
class ProductResolution:
    product: Product | None
    issues: list


def product_matches_hint(product, hint, gtin):
    if gtin and product.gtin and canonical_gtin(product.gtin) != gtin:
        return False
    if hint.package_quantity is not None and product.package_quantity != hint.package_quantity:
        return False
    if hint.package_unit and product.package_unit != hint.package_unit:
        return False
    if hint.brand and (product.brand is None or name_key(product.brand.name) != name_key(hint.brand)):
        return False
    return True


def _remember_alias(merchant, line, product):
    alias, _ = ProductAlias.objects.get_or_create(
        merchant=merchant, name_key=name_key(line.raw_name), store_item_code=line.store_item_code or "",
        defaults={"product": product, "raw_name": line.raw_name},
    )
    if alias.product_id != product.pk:
        return False
    alias.full_clean(validate_unique=False, validate_constraints=False)
    return True


def resolve_product(line, merchant, *, field="/lines"):
    """Resolve one product, or retain a null assignment with safe review reasons.

    Does not classify services/deposits as products. Product.generic cannot be
    reliably inferred from the DTO; new goods use the idempotent service generic.
    """
    if line.kind != "product":
        return ProductResolution(None, [])
    hint = line.product_hint
    observed_gtins = {v for v in (canonical_gtin(hint.gtin), canonical_gtin(line.barcode)) if v}
    if len(observed_gtins) > 1:
        return ProductResolution(None, [issue("product_conflict", field)])
    gtin = next(iter(observed_gtins), None)
    gtin_matches = []
    if gtin:
        variants = [gtin[-length:] for length in (8, 12, 13, 14) if gtin[:-length].strip("0") == ""]
        gtin_matches = list(Product.objects.filter(gtin__in=variants).select_related("brand"))
    aliases = ProductAlias.objects.filter(merchant=merchant, name_key=name_key(line.raw_name))
    if line.store_item_code:
        aliases = aliases.filter(store_item_code=line.store_item_code)
    alias_matches = list({a.product_id: a.product for a in aliases.select_related("product__brand")}.values())
    matches = gtin_matches or alias_matches
    if gtin_matches and alias_matches and {p.pk for p in gtin_matches} != {p.pk for p in alias_matches}:
        return ProductResolution(None, [issue("product_conflict", field)])
    if len(matches) > 1:
        return ProductResolution(None, [issue("product_ambiguous", field)])
    if matches:
        product = matches[0]
        if not product_matches_hint(product, hint, gtin):
            return ProductResolution(None, [issue("product_conflict", field)])
    else:
        if (hint.package_quantity is None) != (hint.package_unit is None):
            return ProductResolution(None, [issue("product_package_invalid", field)])
        canonical_name = hint.name or line.raw_name
        # The schema has no stored name_key for Product. Limit the scan by the
        # exact packaging pair; normalization itself follows receipts.dedup.
        candidates = Product.objects.select_related("brand").all()
        if hint.package_quantity is not None:
            candidates = candidates.filter(package_quantity=hint.package_quantity, package_unit=hint.package_unit)
        if hint.brand:
            candidates = candidates.filter(brand__name__iexact=hint.brand)
        candidates = [p for p in candidates.iterator() if name_key(p.name) == name_key(canonical_name)]
        matches = [p for p in candidates if product_matches_hint(p, hint, gtin)]
        if len(matches) > 1 or (candidates and not matches):
            return ProductResolution(None, [issue("product_ambiguous", field)])
        if matches:
            product = matches[0]
        else:
            category, _ = Category.objects.get_or_create(parent=None, name="Не разобрано")
            generic, _ = GenericProduct.objects.get_or_create(
                name__iexact="Не разобрано",
                defaults={"name": "Не разобрано", "category": category, "base_unit": BaseUnit.PCS},
            )
            brand = None
            if hint.brand:
                brand, _ = Brand.objects.get_or_create(name__iexact=hint.brand, defaults={"name": hint.brand})
            product = clean_save(Product(
                generic=generic, brand=brand, name=canonical_name, gtin=gtin or "",
                package_quantity=hint.package_quantity, package_unit=hint.package_unit or "",
            ))
    if not _remember_alias(merchant, line, product):
        return ProductResolution(None, [issue("product_conflict", field)])
    return ProductResolution(product, [])
