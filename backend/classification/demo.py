"""Fictional catalog for the classification demo and tests. Test/QA databases only.

The merchant, the receipts and the product names are invented; nothing is copied
from a real database. Products are created the way the importer leaves them:
the service generic product and one alias per spelling. ``MIXED`` is at the same
time the answer table of the fake scenario ``mixed`` (by product name).
"""
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction

from classification.taxonomy import SERVICE_NAME
from merges.demo import DemoError, allowed_database

FOOD, DAIRY = "Продукты питания", "Молочные продукты"
MILK = "Молоко"
MERCHANT = {
    "legal_name": "Kategoriemarkt Testhandel GmbH (вымышленный)", "brand_name": "Kategoriemarkt",
    "tax_id": "DEMOCLASS0001", "address_raw": "Beispielallee 3, 00000 Musterstadt",
}

# Creation order fixes the ids. (name, facts)
PRODUCTS = (
    ("Demo H-Milch 3,5% 1L", {"generic": MILK, "package": ("1", "l")}),
    ("Demo Frischmilch 1,5%", {}),
    ("Demo Kefir mild 500g", {"package": ("500", "g")}),
    ("Demo Kefir 1,5% 1L", {"package": ("1", "l")}),
    ("Demo Butterkäse Sch.", {}),
    ("Demo Mettwurst fein", {"brand": "Demowurst", "package": ("200", "g"), "spellings": ("Demo Mettw. fein",)}),
    ("Demo Salami Sticks", {}),
    ("Demo Toast Weizen", {}),
    ("Demo Apfelsaft klar 1L", {"package": ("1", "l")}),
    ("Demo Spülmittel Zitr.", {}),
    ("Demo Art. 4711", {}),
    ("Demo Pfand Leergut", {}),
)
DEPOSIT = "Demo Pfand Leergut"  # linked to a deposit line only: not a candidate

# Answers of the fake scenario ``mixed``: name -> None ("unknown"), an existing
# generic product name, or (new generic product, category path, base unit).
MIXED = {
    "Demo Frischmilch 1,5%": MILK,
    "Demo Kefir mild 500g": ("Кефир", (FOOD, DAIRY), "l"),
    "Demo Kefir 1,5% 1L": ("Кефир", (FOOD, DAIRY), "l"),
    "Demo Butterkäse Sch.": ("Сыр", (FOOD, DAIRY), "kg"),
    "Demo Mettwurst fein": ("Колбаса", (FOOD, "Мясные продукты"), "kg"),
    "Demo Salami Sticks": ("Колбаса", (FOOD, "Мясные продукты"), "kg"),
    "Demo Toast Weizen": ("Хлеб", (FOOD, "Хлеб и выпечка"), "kg"),
    "Demo Apfelsaft klar 1L": ("Сок", ("Напитки",), "l"),
    "Demo Spülmittel Zitr.": ("Средство для мытья посуды", ("Бытовая химия",), "pcs"),
    "Demo Art. 4711": None,
}

# What `product_classifications suggest --fake-scenario mixed` leaves on a clean database.
EXPECTED = {
    "candidates": 10, "pending": 9, "groups": 7, "unknown": 1, "created_generics": 6, "created_categories": 4,
}

# (receipt number, local date, ((printed name, kind, quantity, unit, unit price, amount), ...))
RECEIPTS = (
    ("DEMO-CLASS-01", date(2026, 9, 1), (
        ("Demo H-Milch 3,5% 1L", "product", "1.000", "pcs", "1.1900", "1.19"),
        ("Demo Frischmilch 1,5%", "product", "1.000", "pcs", "1.0900", "1.09"),
        ("Demo Kefir mild 500g", "product", "1.000", "pcs", "0.9900", "0.99"),
        ("Demo Kefir 1,5% 1L", "product", "1.000", "pcs", "1.2900", "1.29"),
        ("Demo Butterkäse Sch.", "product", "0.250", "kg", "9.9600", "2.49"),
    )),
    ("DEMO-CLASS-02", date(2026, 9, 8), (
        ("Demo Mettwurst fein", "product", "1.000", "pcs", "1.9900", "1.99"),
        ("Demo Mettw. fein", "product", "1.000", "pcs", "1.9900", "1.99"),
        ("Demo Salami Sticks", "product", "1.000", "pcs", "1.7900", "1.79"),
        ("Demo Toast Weizen", "product", "1.000", "pcs", "1.1900", "1.19"),
        ("Demo Apfelsaft klar 1L", "product", "1.000", "pcs", "1.4900", "1.49"),
        ("Demo Pfand Leergut", "deposit", "1.000", "pcs", "0.2500", "0.25"),
    )),
    ("DEMO-CLASS-03", date(2026, 9, 15), (
        ("Demo Spülmittel Zitr.", "product", "1.000", "pcs", "0.9500", "0.95"),
        ("Demo Art. 4711", "product", "1.000", "pcs", "2.0000", "2.00"),
        ("Demo Frischmilch 1,5%", "product", "1.000", "pcs", "1.0900", "1.09"),
    )),
)


def seed_demo():
    """Create the demo once; a repeated call changes nothing. Returns the counts and ``created``."""
    from catalog.models import Brand, Category, GenericProduct, Product
    from receipts.dedup import name_key
    from receipts.models import ProductAlias, Receipt, ReceiptLine
    from stores.models import Country, Currency, Merchant, Store

    if not allowed_database(settings.DATABASES["default"]["NAME"]):
        raise DemoError(
            "Classification demo data require a test_* or checkist_qa* database; dev/production is forbidden."
        )
    try:
        with transaction.atomic():
            country, _ = Country.objects.get_or_create(code="DE", defaults={"name": "Германия"})
            currency, _ = Currency.objects.get_or_create(code="EUR", defaults={"name": "Евро"})
            if Merchant.objects.filter(country=country, tax_id=MERCHANT["tax_id"]).exists():
                return {"created": False}
            merchant = Merchant.objects.create(
                country=country, legal_name=MERCHANT["legal_name"], brand_name=MERCHANT["brand_name"],
                tax_id=MERCHANT["tax_id"], tax_id_type=Merchant.TaxIdType.OTHER,
            )
            store = Store.objects.create(
                merchant=merchant, country=country, name=MERCHANT["brand_name"],
                address_raw=MERCHANT["address_raw"], city="Musterstadt", timezone="Europe/Berlin",
            )
            service_category, _ = Category.objects.get_or_create(parent=None, name=SERVICE_NAME)
            food, _ = Category.objects.get_or_create(parent=None, name=FOOD)
            dairy, _ = Category.objects.get_or_create(parent=food, name=DAIRY)
            generics = {}
            for name, category, base_unit in ((SERVICE_NAME, service_category, "pcs"), (MILK, dairy, "l")):
                generics[name], _ = GenericProduct.objects.get_or_create(
                    name__iexact=name, defaults={"name": name, "category": category, "base_unit": base_unit},
                )
            products = {}
            for name, facts in PRODUCTS:
                brand = None
                if facts.get("brand"):
                    brand, _ = Brand.objects.get_or_create(
                        name__iexact=facts["brand"], defaults={"name": facts["brand"]},
                    )
                quantity, unit = facts.get("package") or (None, "")
                product = Product.objects.create(
                    generic=generics[facts.get("generic", SERVICE_NAME)], brand=brand, name=name,
                    package_quantity=Decimal(quantity) if quantity else None, package_unit=unit,
                )
                for spelling in (name, *facts.get("spellings", ())):
                    products[spelling] = product
                    ProductAlias.objects.create(
                        merchant=merchant, product=product, name_key=name_key(spelling), raw_name=spelling,
                    )
            lines = 0
            for number, on, rows in RECEIPTS:
                receipt = Receipt.objects.create(
                    store=store, currency=currency, operation=Receipt.Operation.SALE, purchased_on=on,
                    purchased_at=datetime.combine(on, time(12, 0), tzinfo=ZoneInfo(store.timezone)),
                    receipt_number=number, total=sum(Decimal(row[5]) for row in rows),
                )
                previous = None
                for position, (name, kind, quantity, unit, unit_price, amount) in enumerate(rows, 1):
                    previous = ReceiptLine.objects.create(
                        receipt=receipt, position=position, kind=kind, raw_name=name, quantity=Decimal(quantity),
                        unit=unit, unit_price=Decimal(unit_price), amount=Decimal(amount), product=products[name],
                        # The deposit belongs to the line printed right above it.
                        parent=previous if kind == ReceiptLine.Kind.DEPOSIT else None,
                    )
                lines += len(rows)
    except IntegrityError:
        raise DemoError("Demo names collide with existing catalog records; use a clean QA database.") from None
    return {
        "created": True, "merchants": 1, "products": len(PRODUCTS), "receipts": len(RECEIPTS), "lines": lines,
    }
