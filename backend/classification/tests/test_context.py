import hashlib
import json
from decimal import Decimal
from unittest.mock import patch

from django.db import connection
from django.test import TestCase, tag
from django.test.utils import CaptureQueriesContext

from catalog.models import Brand, Category, GenericProduct, Product
from classification import context, demo, services
from classification.models import ClassificationRejection
from classification.tests.factories import (
    CHEESE, EXAMPLE, JUICE, KEFIR_A, KEFIR_B, MILK, SAUSAGE_A, UNKNOWN, add_product, apply, generic, new, product,
    record, service, snapshot, suggest,
)
from merges import services as merges
from receipts.dedup import name_key
from receipts.models import ProductAlias, Receipt
from stores.models import Merchant, Store


@tag("integration")
class BuildRequestTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def ids(self, *names):
        return [product(name).pk for name in names]

    def test_document_of_the_demo(self):
        request = context.build_request(self.ids(SAUSAGE_A, CHEESE, MILK))
        document = request.document
        self.assertEqual(list(document), ["input_version", "categories", "generic_products", "examples", "products"])
        self.assertEqual(document["input_version"], "1")
        food, dairy = (Category.objects.get(name=name).pk for name in ("Продукты питания", "Молочные продукты"))
        # The service category and the service generic product are never offered.
        self.assertEqual(document["categories"], [
            {"id": food, "path": ["Продукты питания"]},
            {"id": dairy, "path": ["Продукты питания", "Молочные продукты"]},
        ])
        self.assertEqual(document["generic_products"], [
            {"id": generic("Молоко").pk, "name": "Молоко", "base_unit": "l", "category_id": dairy},
        ])
        self.assertEqual(document["examples"], [{"name": EXAMPLE, "brand": None, "generic_id": generic("Молоко").pk}])
        milk, cheese, sausage = document["products"]
        self.assertEqual(request.product_ids, tuple(self.ids(MILK, CHEESE, SAUSAGE_A)))
        self.assertEqual(milk, {
            "id": product(MILK).pk, "name": MILK, "spellings": [MILK], "brand": None, "package": None,
            "merchants": ["Kategoriemarkt"], "units": ["pcs"], "rejected": [],
        })
        self.assertEqual(cheese["units"], ["kg"])
        self.assertEqual(sausage, {
            "id": product(SAUSAGE_A).pk, "name": SAUSAGE_A, "spellings": ["Demo Mettw. fein", "Demo Mettwurst fein"],
            "brand": "Demowurst", "package": {"quantity": "200.000", "unit": "g"}, "merchants": ["Kategoriemarkt"],
            "units": ["pcs"], "rejected": [],
        })

    def test_serialisation_and_digest_are_stable(self):
        ids = self.ids(MILK, JUICE)
        request = context.build_request(ids)
        text = request.to_json()
        self.assertEqual(json.loads(text), request.document)
        self.assertEqual(text, json.dumps(request.document, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
        self.assertIn("Молоко", text)  # not escaped
        self.assertEqual(request.sha256, hashlib.sha256(text.encode("utf-8")).hexdigest())
        again = context.build_request(reversed(ids))
        self.assertEqual((again.sha256, again.product_ids), (request.sha256, request.product_ids))
        self.assertNotEqual(context.build_request(ids[:1]).sha256, request.sha256)

    def test_missing_products_are_left_out(self):
        request = context.build_request(self.ids(JUICE) + [10**9])
        self.assertEqual(request.product_ids, tuple(self.ids(JUICE)))
        self.assertEqual(context.build_request([]).product_ids, ())

    def test_private_data_never_leave(self):
        Receipt.objects.update(raw_text="SECRET RECEIPT TEXT", fiscal={"fn": "FISCAL-SECRET"}, register_code="KASSE-SECRET")
        Merchant.objects.update(extra={"owner": "Иванов Иван"})
        text = context.build_request(Product.objects.values_list("pk", flat=True)).to_json()
        for secret in ("Testhandel", "вымышленный", "DEMOCLASS0001", "Beispielallee", "DEMO-CLASS", "SECRET",
                       "Иванов", "1.99", "9.96", "2026-09", "Musterstadt"):
            with self.subTest(secret=secret):
                self.assertNotIn(secret, text)
        self.assertIn("Kategoriemarkt", text)

    def test_reading_writes_nothing_and_takes_a_fixed_number_of_queries(self):
        before = snapshot()
        single, every = self.ids(MILK), list(Product.objects.values_list("pk", flat=True))
        with CaptureQueriesContext(connection) as one:
            context.build_request(single)
        # Categories, generic products (2), examples (2), products, aliases, units, rejections.
        self.assertEqual(len(one.captured_queries), 9)
        with self.assertNumQueries(9):
            context.build_request(every)
        self.assertEqual(snapshot(), before)
        self.assertFalse(any("FOR UPDATE" in query["sql"] or not query["sql"].lstrip().upper().startswith("SELECT")
                             for query in one.captured_queries))

    def test_rejected_names_and_pending_products(self):
        suggest()
        services.reject(record(CHEESE).pk, version=1)
        services.confirm(record(KEFIR_A).pk, version=1, generic_id=generic("Кефир").pk)
        document = context.build_request(self.ids(CHEESE, UNKNOWN)).document
        self.assertEqual([entry["rejected"] for entry in document["products"]], [["Сыр"], []])
        names = {entry["name"] for entry in document["generic_products"]}
        # New generic products are offered at once; the removed «Сыр» is gone.
        self.assertEqual(names, {"Молоко", "Кефир", "Колбаса", "Хлеб", "Сок", "Средство для мытья посуды"})
        self.assertEqual(len(document["categories"]), 6)
        # A confirmed product is an example (first), a pending one is not.
        self.assertEqual([entry["name"] for entry in document["examples"]], [KEFIR_A, EXAMPLE])
        self.assertNotIn(KEFIR_B, [entry["name"] for entry in document["examples"]])

    def test_limits_of_one_product(self):
        target = product(MILK)
        merchants = []
        for index in range(5):
            merchant = Merchant.objects.create(
                country_id="DE", legal_name=f"Geheim {index} GmbH", brand_name="" if index == 0 else f"Markt {index}",
            )
            merchants.append(merchant)
            for number in range(2):
                name = f"Demo Alias {index}{number} " + "x" * 200
                ProductAlias.objects.create(merchant=merchant, product=target, name_key=name_key(name), raw_name=name)
        # A merchant without a sign is shown by its first store, never by its legal name.
        for name, address in (("Erster Laden", "Erste Strasse 1, 00000 Musterstadt"),
                              ("Zweiter Laden", "Zweite Strasse 2, 00000 Musterstadt")):
            Store.objects.create(
                merchant=merchants[0], country_id="DE", name=name, address_raw=address, timezone="Europe/Berlin",
            )
        for index in range(12):
            ClassificationRejection.objects.create(product=target, generic_key=f"k{index}", generic_name=f"Имя {index:02d}")
        entry = context.build_request([target.pk]).document["products"][0]
        self.assertEqual(len(entry["spellings"]), context.SPELLINGS_LIMIT)
        self.assertTrue(all(len(spelling) == context.SPELLING_LENGTH for spelling in entry["spellings"]))
        self.assertEqual(len(entry["merchants"]), context.MERCHANTS_LIMIT)
        self.assertEqual(entry["merchants"], ["Erster Laden", "Markt 1", "Markt 2"])
        self.assertNotIn("Geheim", json.dumps(entry, ensure_ascii=False))
        self.assertEqual(entry["rejected"], [f"Имя {index:02d}" for index in range(10)])

    def test_spellings_repeat_once_per_key(self):
        target = product(MILK)
        other = Merchant.objects.create(country_id="DE", legal_name="Zweite GmbH", brand_name="Zweitmarkt")
        for name in ("DEMO  FRISCHMILCH 1,5%", "demo frischmilch 1,5%"):
            ProductAlias.objects.create(merchant=other, product=target, name_key=name_key(name) + name[:1], raw_name=name)
        entry = context.build_request([target.pk]).document["products"][0]
        self.assertEqual(len(entry["spellings"]), 1)
        self.assertEqual(sorted(entry["merchants"]), ["Kategoriemarkt", "Zweitmarkt"])

    def test_examples_are_limited_per_generic_product_and_in_total(self):
        category = Category.objects.get(name="Молочные продукты")
        brand = Brand.objects.create(name="Demomolkerei")
        for index in range(45):
            created = GenericProduct.objects.create(name=f"Пример {index:02d}", category=category, base_unit="pcs")
            for number in range(3):
                add_product(f"Demo Beispiel {index:02d}-{number}", generic=created, brand=brand, alias=False)
        examples = context.build_request(self.ids(MILK)).document["examples"]
        self.assertEqual(len(examples), context.EXAMPLES_LIMIT)
        per_generic = {}
        for example in examples:
            per_generic[example["generic_id"]] = per_generic.get(example["generic_id"], 0) + 1
        self.assertEqual(max(per_generic.values()), context.EXAMPLES_PER_GENERIC)
        self.assertEqual(examples[0], {"name": EXAMPLE, "brand": None, "generic_id": generic("Молоко").pk})
        self.assertEqual(examples[1]["brand"], "Demomolkerei")

    def test_products_absorbed_by_a_pending_merge_are_not_examples(self):
        add_product(EXAMPLE + ".", generic=generic("Молоко"))
        merges.detect()
        examples = context.build_request(self.ids(MILK)).document["examples"]
        self.assertEqual(len(examples), 1)

    def test_generic_products_keep_the_most_used_when_there_are_too_many(self):
        category = Category.objects.get(name="Молочные продукты")
        GenericProduct.objects.bulk_create(
            GenericProduct(name=f"Лишний {index:03d}", category=category, base_unit="pcs") for index in range(6)
        )
        with patch.object(context, "GENERICS_LIMIT", 3):
            generics = context.build_request(self.ids(MILK)).document["generic_products"]
        self.assertEqual(len(generics), 3)
        # «Молоко» has a product; the rest are taken by id. The result is in id order.
        self.assertIn("Молоко", [entry["name"] for entry in generics])
        self.assertEqual([entry["id"] for entry in generics], sorted(entry["id"] for entry in generics))
        with patch.object(context, "CATEGORIES_LIMIT", 1):
            self.assertEqual(len(context.build_request(self.ids(MILK)).document["categories"]), 1)

    def test_categories_under_the_service_root_and_broken_branches_are_left_out(self):
        hidden = Category.objects.create(parent=service().category, name="Скрытая")
        first = Category.objects.create(parent=None, name="Цикл А")
        second = Category.objects.create(parent=first, name="Цикл Б")
        Category.objects.filter(pk=first.pk).update(parent=second)
        paths = context.category_paths()
        self.assertNotIn(hidden.pk, paths)
        self.assertNotIn(service().category_id, paths)
        self.assertFalse({first.pk, second.pk} & set(paths))
        self.assertEqual(len(paths), 2)

    def test_too_large_input(self):
        ids = self.ids(MILK, KEFIR_A, CHEESE, SAUSAGE_A)
        full = len(context.build_request(ids).to_json().encode("utf-8"))
        single = len(context.build_request(ids[:1]).to_json().encode("utf-8"))
        with patch.object(context, "MAX_INPUT_BYTES", full):
            self.assertEqual(context.fit_request(ids).product_ids, tuple(ids))
        with patch.object(context, "MAX_INPUT_BYTES", full - 1):
            with self.assertRaises(context.InputTooLarge) as caught:
                context.build_request(ids)
            self.assertEqual(caught.exception.code, "input_too_large")
            self.assertEqual(context.fit_request(ids).product_ids, tuple(ids[:2]))
        with patch.object(context, "MAX_INPUT_BYTES", single):
            self.assertEqual(context.fit_request(ids).product_ids, tuple(ids[:1]))
        with patch.object(context, "MAX_INPUT_BYTES", single - 1), self.assertRaises(context.InputTooLarge):
            context.fit_request(ids)
        self.assertEqual(context.MAX_INPUT_BYTES, 120_000)

    def test_package_quantity_has_three_decimals(self):
        Product.objects.filter(name=JUICE).update(package_quantity=Decimal("0.5"), package_unit="l")
        entry = context.build_request(self.ids(JUICE)).document["products"][0]
        self.assertEqual(entry["package"], {"quantity": "0.500", "unit": "l"})

    def test_units_are_of_product_lines_only(self):
        apply(new(JUICE, "Сок"))
        entry = context.build_request(self.ids(JUICE)).document["products"][0]
        self.assertEqual(entry["units"], ["pcs"])
        deposit = context.build_request(self.ids("Demo Pfand Leergut")).document["products"][0]
        self.assertEqual(deposit["units"], [])
