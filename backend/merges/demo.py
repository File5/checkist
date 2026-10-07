"""Fictional catalog for the duplicate-merge demo and tests. Test/QA databases only.

The 19 spellings of seven groups, the false pair and «Pizza Hot Dog» repeat the
printed names studied on receipts; the merchant, the stores, the receipts and
the negative examples are invented. Nothing is copied from a real database.
Products are created the way the importer leaves them: the service generic,
one alias per spelling and merchant.
"""
import re
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.conf import settings
from django.db import IntegrityError, transaction

from merges.detection import SERVICE_GENERIC_NAME

MILK_GENERIC = "Молоко"
OTHER_MILK_GENERIC = "H-Milch (демо)"
MAIN, OTHER = "main", "other"


class DemoError(ValueError):
    pass


def ean13(body):
    """Fictional EAN-13 from 12 digits (prefix 2xx is reserved for in-store use)."""
    checksum = sum(int(digit) * (3 if index % 2 else 1) for index, digit in enumerate(body))
    return f"{body}{(10 - checksum % 10) % 10}"


def _product(name, **facts):
    return {"name": name, "merchant": facts.pop("merchant", MAIN), **facts}


# Creation order fixes the ids, hence the default surviving record of each group.
PRODUCTS = (
    _product("GQ EgSB H-Milch 1,5%", generic=MILK_GENERIC),
    _product("Steinhof.PizzaSpezial"),
    _product("Pizza Hot Dog"),
    _product("Zimbo Mettw.fettred.", brand="Zimbo"),
    _product("Geflügelfilet roulade"),
    _product("GG EgSB H-Milch 1,5%"),
    _product("Eier 10er Freilandh.", package=("10", "pcs")),
    _product("Weizen Sandwi. Toast"),
    _product("Steinhof PizzaSpezial"),
    _product("Geflügelfrikadell."),
    _product("BürgerSchwä.Maultas."),
    _product("Geflügel Mortadella"),
    _product("GO EgSB H-Milch 1,5%", generic=OTHER_MILK_GENERIC),
    _product("Eier 10er Freiland", package=("10", "pcs")),
    _product("Steinof.PizzaSpezial"),
    _product("Geflügelfiletroulade"),
    _product("Zimbo Mettw.fettre d.", brand="Zimbo"),
    _product("GO FoSB H-Milch 1,5%"),
    _product("Weizen Sandw. Toast"),
    _product("BurgerSchwa.Maultas."),
    _product("GQ EGS H-Milch 1,5%"),
    _product("Bürger Schw.Maultas."),
    # Negative examples: similar spellings that must stay apart.
    _product("Demo Joghurt 1,5%"),
    _product("Demo Joghurt 3,5%"),
    _product("Demo Wasser 0.5l"),
    _product("Demo Wasser 5l"),
    _product("Eier 6er Freiland", package=("6", "pcs")),
    _product("Reis Langkorn Beutel", package=("500", "g")),
    _product("Reis Langkorn Beutel.", package=("1", "kg")),
    _product("Kaffee Crema Bohnen", brand="Demo Rösterei Nord"),
    _product("Kaffee Crema Bohne", brand="Demo Rösterei Süd"),
    _product("Schoko Riegel Nuss", gtin=ean13("200000000001")),
    _product("Schoko Riegel Nuss.", gtin=ean13("200000000002")),
    _product("Landbrot geschnitten"),
    _product("Landbrot geschnitten.", merchant=OTHER),
)

# Expected groups: the default surviving record first.
GROUPS = (
    ("GQ EgSB H-Milch 1,5%", "GG EgSB H-Milch 1,5%", "GO EgSB H-Milch 1,5%", "GO FoSB H-Milch 1,5%",
     "GQ EGS H-Milch 1,5%"),
    ("Steinhof.PizzaSpezial", "Steinhof PizzaSpezial", "Steinof.PizzaSpezial"),
    ("Zimbo Mettw.fettred.", "Zimbo Mettw.fettre d."),
    ("Geflügelfilet roulade", "Geflügelfiletroulade"),
    ("Eier 10er Freilandh.", "Eier 10er Freiland"),
    ("Weizen Sandwi. Toast", "Weizen Sandw. Toast"),
    ("BürgerSchwä.Maultas.", "BurgerSchwa.Maultas.", "Bürger Schw.Maultas."),
)
FALSE_PAIR = ("Geflügelfrikadell.", "Geflügel Mortadella")

# (receipt number, merchant, local date, ((printed name, price), ...))
RECEIPTS = (
    ("DEMO-MERGE-01", MAIN, date(2026, 5, 4), (
        ("GQ EgSB H-Milch 1,5%", "1.09"), ("Demo Joghurt 1,5%", "0.59"), ("Demo Joghurt 3,5%", "0.59"),
    )),
    ("DEMO-MERGE-02", MAIN, date(2026, 5, 18), (
        ("GQ EgSB H-Milch 1,5%", "1.05"), ("Demo Wasser 0.5l", "0.29"), ("Demo Wasser 5l", "1.49"),
    )),
    ("DEMO-MERGE-03", MAIN, date(2026, 6, 9), (
        ("GQ EgSB H-Milch 1,5%", "1.05"), ("Steinof.PizzaSpezial", "3.49"), ("Zimbo Mettw.fettred.", "1.99"),
        ("Geflügelfiletroulade", "2.19"), ("Bürger Schw.Maultas.", "2.29"), ("Weizen Sandwi. Toast", "1.19"),
    )),
    ("DEMO-MERGE-04", MAIN, date(2026, 6, 29), (
        ("Pizza Hot Dog", "3.99"), ("Steinhof.PizzaSpezial", "3.49"), ("Zimbo Mettw.fettred.", "1.99"),
        ("Geflügelfilet roulade", "2.19"), ("GG EgSB H-Milch 1,5%", "1.05"), ("Eier 10er Freilandh.", "2.99"),
        ("Weizen Sandwi. Toast", "1.19"), ("Geflügelfrikadell.", "2.49"),
    )),
    ("DEMO-MERGE-05", MAIN, date(2026, 7, 6), (
        ("Zimbo Mettw.fettre d.", "1.99"), ("Steinof.PizzaSpezial", "3.49"), ("Geflügelfiletroulade", "2.19"),
        ("GO FoSB H-Milch 1,5%", "1.05"), ("Eier 10er Freilandh.", "2.99"), ("Weizen Sandw. Toast", "1.19"),
    )),
    ("DEMO-MERGE-06", MAIN, date(2026, 7, 20), (
        ("BurgerSchwa.Maultas.", "2.29"), ("GQ EGS H-Milch 1,5%", "1.05"), ("Eier 6er Freiland", "1.89"),
    )),
    ("DEMO-MERGE-07", MAIN, date(2026, 8, 3), (
        ("Reis Langkorn Beutel", "0.99"), ("Reis Langkorn Beutel.", "1.79"), ("Kaffee Crema Bohnen", "4.99"),
        ("Kaffee Crema Bohne", "5.49"), ("Schoko Riegel Nuss", "0.79"), ("Schoko Riegel Nuss.", "0.89"),
        ("Landbrot geschnitten", "1.69"),
    )),
    ("DEMO-MERGE-08", MAIN, date(2026, 10, 1), (
        ("BürgerSchwä.Maultas.", "2.29"), ("Steinhof PizzaSpezial", "3.49"), ("GO EgSB H-Milch 1,5%", "1.05"),
        ("Eier 10er Freiland", "2.99"), ("Geflügel Mortadella", "1.79"),
    )),
    ("DEMO-MERGE-09", OTHER, date(2026, 8, 10), (("Landbrot geschnitten.", "1.59"),)),
)

MERCHANTS = {
    MAIN: {
        "legal_name": "Demomarkt Testhandel GmbH (вымышленный)", "brand_name": "Demomarkt",
        "tax_id": "DEMOMERGE0001", "address_raw": "Beispielallee 1, 00000 Musterstadt",
    },
    OTHER: {
        "legal_name": "Probekauf Beispiel GmbH (вымышленный)", "brand_name": "Probekauf",
        "tax_id": "DEMOMERGE0002", "address_raw": "Musterweg 2, 00000 Musterstadt",
    },
}


def allowed_database(name):
    return bool(re.fullmatch(r"(?:test_[A-Za-z0-9_]+|checkist_qa(?:_[A-Za-z0-9_]+)?)", str(name)))


def seed_demo():
    """Create the demo once; a repeated call changes nothing. Returns the counts and ``created``."""
    from catalog.models import Brand, Category, GenericProduct, Product
    from receipts.dedup import name_key
    from receipts.models import ProductAlias, Receipt, ReceiptLine
    from receipts.ownership import local_user
    from stores.models import Country, Currency, Merchant, Store

    if not allowed_database(settings.DATABASES["default"]["NAME"]):
        raise DemoError("Merge demo data require a test_* or checkist_qa* database; dev/production is forbidden.")
    try:
        with transaction.atomic():
            country, _ = Country.objects.get_or_create(code="DE", defaults={"name": "Германия"})
            currency, _ = Currency.objects.get_or_create(code="EUR", defaults={"name": "Евро"})
            existing = Merchant.objects.filter(
                country=country, tax_id__in=[fields["tax_id"] for fields in MERCHANTS.values()],
            )
            if existing.exists():
                return {"created": False}
            # Owner of every demo receipt; a refusal and a repeated call never get here.
            owner = local_user()
            stores = {}
            for key, fields in MERCHANTS.items():
                merchant = Merchant.objects.create(
                    country=country, legal_name=fields["legal_name"], brand_name=fields["brand_name"],
                    tax_id=fields["tax_id"], tax_id_type=Merchant.TaxIdType.OTHER,
                )
                stores[key] = Store.objects.create(
                    merchant=merchant, country=country, name=fields["brand_name"],
                    address_raw=fields["address_raw"], city="Musterstadt", timezone="Europe/Berlin",
                )
            category, _ = Category.objects.get_or_create(parent=None, name=SERVICE_GENERIC_NAME)
            generics = {}
            for name, base_unit in ((SERVICE_GENERIC_NAME, "pcs"), (MILK_GENERIC, "l"), (OTHER_MILK_GENERIC, "l")):
                generics[name], _ = GenericProduct.objects.get_or_create(
                    name__iexact=name, defaults={"name": name, "category": category, "base_unit": base_unit},
                )
            products = {}
            for spec in PRODUCTS:
                brand = None
                if spec.get("brand"):
                    brand, _ = Brand.objects.get_or_create(name__iexact=spec["brand"], defaults={"name": spec["brand"]})
                quantity, unit = spec.get("package") or (None, "")
                product = Product.objects.create(
                    generic=generics[spec.get("generic", SERVICE_GENERIC_NAME)], brand=brand, name=spec["name"],
                    gtin=spec.get("gtin", ""), package_quantity=Decimal(quantity) if quantity else None,
                    package_unit=unit,
                )
                products[spec["name"]] = product
                ProductAlias.objects.create(
                    merchant=stores[spec["merchant"]].merchant, product=product,
                    name_key=name_key(spec["name"]), raw_name=spec["name"],
                )
            lines = 0
            for number, key, on, rows in RECEIPTS:
                store = stores[key]
                receipt = Receipt.objects.create(
                    owner=owner, store=store, currency=currency, operation=Receipt.Operation.SALE, purchased_on=on,
                    purchased_at=datetime.combine(on, time(12, 0), tzinfo=ZoneInfo(store.timezone)),
                    receipt_number=number, total=sum(Decimal(price) for _, price in rows),
                )
                ReceiptLine.objects.bulk_create(
                    ReceiptLine(
                        receipt=receipt, position=position, kind=ReceiptLine.Kind.PRODUCT, raw_name=name,
                        quantity=Decimal("1.000"), unit="pcs", unit_price=Decimal(price), amount=Decimal(price),
                        product=products[name],
                    )
                    for position, (name, price) in enumerate(rows, 1)
                )
                lines += len(rows)
    except IntegrityError:
        raise DemoError("Demo names collide with existing catalog records; use a clean QA database.") from None
    return {
        "created": True, "merchants": len(MERCHANTS), "products": len(PRODUCTS),
        "receipts": len(RECEIPTS), "lines": lines,
    }
