"""Данные и клиент для тестов API предположений категорий. Все названия вымышленные.

``public_classification_data`` — маленький каталог с явными id: по нему построены
эталонные JSON для клиента (``classification/tests/fixtures/public``). Остальные
тесты берут демо-каталог ``classification.demo`` и ищут записи по названиям.
"""
import json
import uuid
from datetime import datetime, timedelta, timezone as dt_timezone
from decimal import Decimal
from pathlib import Path

from django.db import connection

from api.tests.merge_factories import PRIVATE, local_client  # noqa: F401 — общий клиент локального API
from catalog.models import Brand, Category, GenericProduct, Product
from classification.models import (
    ClassificationAttempt, ClassificationRun, CreatedCategory, CreatedGenericProduct, ProductClassification,
)
from classification.taxonomy import SERVICE_NAME
from receipts.dedup import name_key
from receipts.models import ProductAlias
from stores.models import Merchant, Store

CREATED = datetime(2026, 10, 6, 10, 0, tzinfo=dt_timezone.utc)  # записи
RESOLVED = datetime(2026, 10, 6, 10, 5, tzinfo=dt_timezone.utc)  # решения в тесте эталонов
QUEUED = datetime(2026, 10, 6, 10, 20, tzinfo=dt_timezone.utc)  # запуск 2
PUBLIC = Path(__file__).resolve().parents[2] / "classification/tests/fixtures/public"

SERVICE_ID, MILK_ID, KEFIR_ID, SAUSAGE_ID, CURD_ID = 91, 92, 93, 94, 95
FOOD, DAIRY, MEAT = 2, 3, 4
# id, название, родитель
_CATEGORIES = ((1, SERVICE_NAME, None), (FOOD, "Продукты питания", None), (DAIRY, "Молочные продукты", FOOD),
               (MEAT, "Мясные продукты", FOOD))
# id, название, единица, категория
_GENERICS = ((SERVICE_ID, SERVICE_NAME, "pcs", 1), (MILK_ID, "Молоко", "l", DAIRY), (KEFIR_ID, "Кефир", "l", DAIRY),
             (SAUSAGE_ID, "Колбаса", "kg", MEAT), (CURD_ID, "Творог", "kg", DAIRY))
# id товара, название, текущий обобщённый продукт, фасовка, бренд
_PRODUCTS = (
    (11, "Demo Kefir mild 500g", KEFIR_ID, ("500", "g"), None),
    (12, "Demo Kefir 1,5% 1L", KEFIR_ID, ("1", "l"), None),
    (13, "Demo Mettwurst fein", SAUSAGE_ID, ("200", "g"), 7),
    (14, "Demo Frischmilch 1,5%", MILK_ID, None, None),
    (15, "Demo Butterkäse Sch.", SERVICE_ID, None, None),  # запись 5 отклонена: товар снова без категории
    (16, "Demo Speisequark 20%", KEFIR_ID, None, None),
    (17, "Demo H-Milch 3,5% 1L", MILK_ID, None, None),
    (18, "Demo Joghurt Natur", MILK_ID, None, None),  # предложен «Кефир», в админке выбрано «Молоко»
    (19, "Demo Art. 4711", SERVICE_ID, None, None),  # модель ответила «не знаю»
)
# id записи, id товара, предложенный обобщённый продукт, (статус, решение, итоговый обобщённый продукт)
_RECORDS = (
    (1, 11, KEFIR_ID, None), (2, 12, KEFIR_ID, None), (3, 13, SAUSAGE_ID, None), (4, 14, MILK_ID, None),
    (5, 15, CURD_ID, ("rejected", "rejected", SERVICE_ID)), (6, 16, KEFIR_ID, None),
    (7, 17, MILK_ID, ("confirmed", "confirmed", MILK_ID)), (8, 18, KEFIR_ID, None),
)


def expected(name):
    return json.loads((PUBLIC / name).read_text(encoding="utf-8"))


def restart_ids(records=1, runs=1):
    """Следующие id записи и запуска: эталонные JSON сравниваются целиком."""
    with connection.cursor() as cursor:
        for table, value in (
            ("classification_productclassification", records), ("classification_classificationrun", runs),
        ):
            cursor.execute("SELECT setval(pg_get_serial_sequence(%s, 'id'), %s, false)", [table, value])


def _path(category_id, categories):
    path = []
    while category_id is not None:
        name, parent = categories[category_id]
        path.insert(0, {"id": category_id, "name": name})
        category_id = parent
    return path


def public_classification_data():
    """Завершённый запуск 1 по товарам 11–19: записи 1–4, 6, 8 ожидают, 5 отклонена, 7 подтверждена.

    «Кефир», «Колбаса» и категория «Мясные продукты» созданы механизмом и ещё «новые».
    Закрытые данные (попытка, счётчики причин, юридическое название продавца) помечены
    ``PRIVATE``: в ответах их быть не должно.
    """
    merchant = Merchant.objects.create(
        id=51, country_id="DE", legal_name=f"{PRIVATE} LEGAL", brand_name="Demomarkt", tax_id=f"{PRIVATE} TAX",
    )
    Store.objects.create(
        id=51, merchant=merchant, country_id="DE", name="Demomarkt", city="Musterstadt",
        address_raw="Beispielallee 1", timezone="Europe/Berlin",
    )
    categories = {pk: (name, parent) for pk, name, parent in _CATEGORIES}
    for pk, name, parent in _CATEGORIES:
        Category.objects.create(id=pk, name=name, parent_id=parent)
    generics = {}
    for pk, name, base_unit, category in _GENERICS:
        generics[pk] = GenericProduct.objects.create(id=pk, name=name, base_unit=base_unit, category_id=category)
    Brand.objects.create(id=7, name="Demowurst")
    products = {}
    for pk, name, generic, package, brand in _PRODUCTS:
        quantity, unit = package or (None, "")
        products[pk] = Product.objects.create(
            id=pk, generic_id=generic, name=name, brand_id=brand,
            package_quantity=Decimal(quantity) if quantity else None, package_unit=unit,
        )
        ProductAlias.objects.create(merchant=merchant, product_id=pk, name_key=name_key(name), raw_name=name)
    run = ClassificationRun.objects.create(
        id=1, status="succeeded", trigger="manual", scope="all", product_ids=sorted(products), cursor=9,
        requested_count=9, applied_count=8, unknown_count=1, remaining_count=0, version=3, provider="fake",
        prompt_version="1", schema_version="1", stats={"unknown": 1, PRIVATE: 1},
        started_at=CREATED - timedelta(minutes=1), finished_at=CREATED,
    )
    ClassificationRun.objects.filter(pk=1).update(created_at=CREATED - timedelta(minutes=2))
    ClassificationAttempt.objects.create(
        run=run, batch=1, ordinal=1, status="succeeded", input_sha256=PRIVATE.ljust(64, "0"),
        product_ids=sorted(products), raw_payload={"note": f"{PRIVATE} PAYLOAD"},
        invalid_output_text=f"{PRIVATE} OUTPUT", finished_at=CREATED,
    )
    CreatedCategory.objects.create(
        category_id=MEAT, category_ref=MEAT, name=categories[MEAT][0], parent_ref=FOOD, run=run,
    )
    for pk in (KEFIR_ID, SAUSAGE_ID):
        CreatedGenericProduct.objects.create(
            generic_id=pk, generic_ref=pk, name=generics[pk].name, base_unit=generics[pk].base_unit,
            category_ref=generics[pk].category_id, run=run,
        )
    service = generics[SERVICE_ID]
    for pk, product_id, suggested_id, resolved in _RECORDS:
        product, suggested = products[product_id], generics[suggested_id]
        status, resolution, final_id = resolved or ("pending", "", None)
        final = generics.get(final_id)
        ProductClassification.objects.create(
            id=pk, status=status, resolution=resolution, version=2 if resolved else 1, product_ref=product_id,
            active_product=None if resolved else product, product_name=product.name,
            product_facts={
                "brand": {"id": product.brand_id, "name": product.brand.name} if product.brand_id else None,
                "package": (
                    {"quantity": str(product.package_quantity), "unit": product.package_unit}
                    if product.package_quantity is not None else None
                ),
            },
            previous_generic_ref=service.pk, previous_generic_name=service.name,
            previous_generic_base_unit=service.base_unit, suggested_generic=suggested,
            suggested_generic_ref=suggested.pk, suggested_generic_name=suggested.name,
            suggested_base_unit=suggested.base_unit,
            suggested_category_path=_path(suggested.category_id, categories),
            final_generic_ref=final.pk if final else None, final_generic_name=final.name if final else "",
            final_base_unit=final.base_unit if final else "", run=run, classifier_version=1, provider="fake",
            prompt_version="1", schema_version="1", confidence=Decimal("0.42"),
            resolved_at=CREATED + timedelta(minutes=1) if resolved else None,
        )
    ProductClassification.objects.update(created_at=CREATED)
    restart_ids(records=len(_RECORDS) + 1, runs=2)
    return products


def start_run(run_id, *, started_at):
    """Воркер взял запуск из очереди: действующая lease по времени базы."""
    now = datetime.now(dt_timezone.utc)
    ClassificationRun.objects.filter(pk=run_id).update(
        status="running", run_token=uuid.uuid4(), heartbeat_at=now, lease_expires_at=now + timedelta(hours=1),
        started_at=started_at, version=2,
    )


def failed_run():
    """Запуск 3 после импорта, сохранённый с ошибкой неверного ответа модели."""
    created = datetime(2026, 10, 6, 10, 30, tzinfo=dt_timezone.utc)
    ClassificationRun.objects.create(
        id=3, status="failed", trigger="import", scope="products", product_ids=[15, 19, 20], requested_count=3,
        remaining_count=0, version=3, provider="fake", prompt_version="1", schema_version="1",
        error_code="invalid_output", started_at=created + timedelta(seconds=2),
        finished_at=created + timedelta(seconds=9),
    )
    ClassificationRun.objects.filter(pk=3).update(created_at=created)
