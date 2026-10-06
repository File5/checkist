"""Helpers over the fictional demo catalog (``classification.demo``)."""
from catalog.models import Brand, Category, GenericProduct, Product
from classification import runner, services
from classification.classifier import FakeClassifier
from classification.models import (
    ClassificationAttempt, ClassificationRejection, ClassificationRun, CreatedCategory, CreatedGenericProduct,
    ProductClassification,
)
from classification.taxonomy import SERVICE_NAME
from classification.validation import validate_response
from receipts.dedup import name_key
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from stores.models import Merchant, Store

CATALOG_MODELS = (Category, GenericProduct, Brand, Product)
DOMAIN_MODELS = CATALOG_MODELS + (
    Merchant, Store, Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax, ProductAlias,
)
CLASSIFICATION_MODELS = (
    ProductClassification, CreatedGenericProduct, CreatedCategory, ClassificationRejection, ClassificationRun,
    ClassificationAttempt,
)
SOURCE = services.Source(provider="fake")

MILK, KEFIR_A, KEFIR_B, CHEESE, SAUSAGE_A, SAUSAGE_B, TOAST, JUICE, SOAP, UNKNOWN, DEPOSIT, EXAMPLE = (
    "Demo Frischmilch 1,5%", "Demo Kefir mild 500g", "Demo Kefir 1,5% 1L", "Demo Butterkäse Sch.",
    "Demo Mettwurst fein", "Demo Salami Sticks", "Demo Toast Weizen", "Demo Apfelsaft klar 1L",
    "Demo Spülmittel Zitr.", "Demo Art. 4711", "Demo Pfand Leergut", "Demo H-Milch 3,5% 1L",
)


def snapshot(*models):
    return {
        model.__name__: list(model.objects.order_by("pk").values())
        for model in models or DOMAIN_MODELS + CLASSIFICATION_MODELS
    }


def product(name):
    return Product.objects.select_related("generic").get(name=name)


def generic(name):
    return GenericProduct.objects.get(name=name)


def service():
    return GenericProduct.objects.get(name=SERVICE_NAME)


def record(name):
    """The latest record of the product with this name."""
    return ProductClassification.objects.filter(product_name=name).latest("pk")


def generic_of(name):
    return Product.objects.values_list("generic__name", flat=True).get(name=name)


def suggest(scenario="mixed", **options):
    """A whole run of the fake in this process, as the ``suggest`` command does; the finished run."""
    classifier = FakeClassifier(scenario)
    run = services.start_run(source=services.default_source(classifier), **options)
    return runner.execute(run, classifier=classifier)[0]


def item(target, decision="unknown", **fields):
    """One answer item; ``target`` — a product, its name or its id."""
    if isinstance(target, str):
        target = product(target)
    return {
        "product_id": getattr(target, "pk", target), "decision": decision, "generic_id": None,
        "generic_name": None, "category_path": None, "base_unit": None, "confidence": None, "note": None, **fields,
    }


def existing(target, generic_id):
    return item(target, "existing", generic_id=getattr(generic_id, "pk", generic_id))


def new(target, name, path=("Продукты питания",), unit="pcs"):
    return item(target, "new", generic_name=name, category_path=list(path), base_unit=unit)


def response(*items):
    return validate_response(
        {"schema_version": "1", "items": list(items)}, product_ids=[entry["product_id"] for entry in items],
    )


def apply(*items, run=None):
    return services.apply(run, response(*items), source=SOURCE)


def add_product(name, *, alias=True, **fields):
    """A product as the importer leaves it: the service generic product and one alias of the demo merchant."""
    fields.setdefault("generic", service())
    created = Product.objects.create(name=name, **fields)
    if alias:
        ProductAlias.objects.create(
            merchant=Merchant.objects.get(tax_id="DEMOCLASS0001"), product=created, name_key=name_key(name),
            raw_name=name,
        )
    return created


def states(model):
    """``{name: state}`` of a journal of created records."""
    return dict(model.objects.values_list("name", "state"))
