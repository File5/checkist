from decimal import Decimal
from unittest.mock import patch

from django.test import TestCase, tag

from catalog.models import Category, GenericProduct, Product
from classification import demo, services
from classification.models import (
    ClassificationAttempt, ClassificationRejection, ClassificationRun, CreatedCategory, CreatedGenericProduct,
    ProductClassification,
)
from classification.tests.factories import (
    CATALOG_MODELS, CHEESE, DEPOSIT, EXAMPLE, JUICE, KEFIR_A, KEFIR_B, MILK, SAUSAGE_A, SAUSAGE_B, SOAP, TOAST,
    UNKNOWN, add_product, apply, existing, generic, generic_of, item, new, product, record, response, service,
    snapshot, states, suggest,
)
from merges import services as merges
from receipts.models import ReceiptLine

FOOD = ("Продукты питания",)
DAIRY = ("Продукты питания", "Молочные продукты")


class DemoTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()


@tag("integration")
class CandidateTests(DemoTestCase):
    def names(self, **options):
        return list(services.candidates(**options).values_list("name", flat=True))

    def test_demo_has_ten_candidates_in_id_order(self):
        self.assertEqual(self.names(), [
            MILK, KEFIR_A, KEFIR_B, CHEESE, SAUSAGE_A, SAUSAGE_B, TOAST, JUICE, SOAP, UNKNOWN,
        ])
        self.assertEqual(len(self.names()), demo.EXPECTED["candidates"])
        ids = list(services.candidates().values_list("pk", flat=True))
        self.assertEqual(ids, sorted(ids))

    def test_product_ids_narrow_the_selection(self):
        chosen = [product(JUICE).pk, product(EXAMPLE).pk, product(DEPOSIT).pk, product(MILK).pk, 10**9]
        self.assertEqual(self.names(product_ids=chosen), [MILK, JUICE])
        self.assertEqual(self.names(product_ids=[]), [])

    def test_a_meaningful_generic_product_is_never_a_candidate(self):
        self.assertNotIn(EXAMPLE, self.names())
        Product.objects.filter(name=JUICE).update(generic=generic("Молоко"))
        self.assertNotIn(JUICE, self.names())
        # The service name is matched without regard to case.
        GenericProduct.objects.filter(pk=service().pk).update(name="НЕ РАЗОБРАНО")
        self.assertEqual(len(self.names()), 9)

    def test_services_and_deposits_are_not_products(self):
        self.assertNotIn(DEPOSIT, self.names())
        for kind in ("service", "deposit_return"):
            ReceiptLine.objects.filter(product=product(DEPOSIT)).update(kind=kind, parent=None, amount=0)
            self.assertNotIn(DEPOSIT, self.names())
        # One line of kind "product" is enough; a product without lines is a candidate too.
        line = ReceiptLine.objects.get(product=product(DEPOSIT))
        ReceiptLine.objects.create(
            receipt=line.receipt, position=99, kind="product", raw_name=DEPOSIT, quantity=1, unit="pcs",
            unit_price=1, amount=1, product=line.product,
        )
        self.assertIn(DEPOSIT, self.names())
        add_product("Demo Ohne Zeilen")
        self.assertIn("Demo Ohne Zeilen", self.names())

    def test_a_pending_record_blocks_and_any_record_blocks_the_automatic_run(self):
        apply(new(MILK, "Напиток"), new(JUICE, "Сок"))
        self.assertNotIn(MILK, self.names())
        self.assertNotIn(JUICE, self.names())
        services.reject(record(MILK).pk, version=1)
        # Rejected: a manual run may try again, the run after an import never does.
        self.assertIn(MILK, self.names())
        self.assertNotIn(MILK, self.names(auto=True))
        self.assertEqual(len(self.names(auto=True)), 8)
        services.confirm(record(JUICE).pk, version=1, generic_id=generic("Сок").pk)
        self.assertNotIn(JUICE, self.names())

    def test_a_product_absorbed_by_a_pending_merge_waits(self):
        twin = add_product(KEFIR_A + ".")
        merges.detect()
        absorbed = {name for name in (KEFIR_A, twin.name) if name not in self.names()}
        self.assertEqual(len(absorbed), 1)
        merges.cancel_pending()
        self.assertLessEqual({KEFIR_A, twin.name}, set(self.names()))


@tag("integration")
class ApplyTests(DemoTestCase):
    def test_existing_generic_product(self):
        milk = generic("Молоко")
        before = snapshot(Category, GenericProduct)
        result = apply(existing(MILK, milk))
        entry = ProductClassification.objects.get()
        self.assertEqual(result, services.ApplyResult(record_ids=[entry.pk], applied=1, unknown=0, skipped={}))
        self.assertEqual(generic_of(MILK), "Молоко")
        # Nothing is created and the existing records do not change.
        self.assertEqual(snapshot(Category, GenericProduct), before)
        self.assertFalse(CreatedGenericProduct.objects.exists() or CreatedCategory.objects.exists())
        target = product(MILK)
        self.assertEqual((entry.status, entry.resolution, entry.version, entry.resolved_at), ("pending", "", 1, None))
        self.assertEqual((entry.product_ref, entry.active_product_id, entry.origin_product_ref), (target.pk, target.pk, None))
        self.assertEqual((entry.product_name, entry.product_facts), (MILK, {"brand": None, "package": None}))
        self.assertEqual(
            (entry.previous_generic_ref, entry.previous_generic_name, entry.previous_generic_base_unit),
            (service().pk, "Не разобрано", "pcs"),
        )
        self.assertEqual(
            (entry.suggested_generic_id, entry.suggested_generic_ref, entry.suggested_generic_name, entry.suggested_base_unit),
            (milk.pk, milk.pk, "Молоко", "l"),
        )
        self.assertEqual([step["name"] for step in entry.suggested_category_path], list(DAIRY))
        self.assertEqual(
            [step["id"] for step in entry.suggested_category_path],
            [Category.objects.get(name=name).pk for name in DAIRY],
        )
        self.assertEqual((entry.final_generic_ref, entry.final_generic_name, entry.final_base_unit), (None, "", ""))
        self.assertEqual(
            (entry.run_id, entry.provider, entry.model, entry.prompt_version, entry.schema_version, entry.classifier_version),
            (None, "fake", "", "1", "1", 1),
        )

    def test_new_generic_product_in_an_existing_category(self):
        result = apply(new(KEFIR_A, "кефир", DAIRY, "l") | {"confidence": 0.8})
        created = generic("Кефир")
        self.assertEqual((created.base_unit, created.category.name, result.applied), ("l", "Молочные продукты", 1))
        journal = CreatedGenericProduct.objects.get()
        self.assertEqual(
            (journal.generic_id, journal.generic_ref, journal.name, journal.base_unit, journal.category_ref, journal.state),
            (created.pk, created.pk, "Кефир", "l", created.category_id, "provisional"),
        )
        self.assertFalse(CreatedCategory.objects.exists())
        self.assertEqual(Category.objects.count(), 3)
        entry = record(KEFIR_A)
        self.assertEqual((entry.suggested_generic_name, entry.confidence), ("Кефир", Decimal("0.80")))
        self.assertEqual(entry.product_facts, {"brand": None, "package": {"quantity": "500.000", "unit": "g"}})

    def test_new_generic_product_in_new_categories(self):
        apply(new(SAUSAGE_A, "Колбаса", ("Продукты питания", "мясные  продукты", "Колбасные изделия"), "kg"))
        created = generic("Колбаса")
        leaf = created.category
        self.assertEqual((leaf.name, leaf.parent.name, leaf.parent.parent.name, leaf.parent.parent.parent), (
            "Колбасные изделия", "Мясные продукты", "Продукты питания", None,
        ))
        self.assertEqual(states(CreatedCategory), {"Мясные продукты": "provisional", "Колбасные изделия": "provisional"})
        middle = CreatedCategory.objects.get(name="Мясные продукты")
        self.assertEqual(middle.parent_ref, Category.objects.get(name="Продукты питания").pk)
        self.assertEqual(CreatedCategory.objects.get(name="Колбасные изделия").parent_ref, middle.category_ref)
        entry = record(SAUSAGE_A)
        self.assertEqual(
            [step["name"] for step in entry.suggested_category_path],
            ["Продукты питания", "Мясные продукты", "Колбасные изделия"],
        )
        self.assertEqual(entry.product_facts["brand"]["name"], "Demowurst")
        # A new root is possible too.
        apply(new(JUICE, "Сок", ("Напитки",), "l"))
        root = CreatedCategory.objects.get(name="Напитки")
        self.assertEqual((root.parent_ref, generic("Сок").category.parent_id), (None, None))

    def test_unknown_leaves_the_product_alone(self):
        before = snapshot(*CATALOG_MODELS)
        result = apply(item(UNKNOWN), item(MILK))
        self.assertEqual(result, services.ApplyResult(record_ids=[], applied=0, unknown=2, skipped={}))
        self.assertEqual(snapshot(*CATALOG_MODELS), before)
        self.assertFalse(ProductClassification.objects.exists())

    def test_category_and_generic_names_match_by_key(self):
        GenericProduct.objects.create(name="Ёлочные игрушки", category=Category.objects.get(name="Молочные продукты"), base_unit="pcs")
        apply(
            new(MILK, "  ёЛОЧНЫЕ   игрушки ", ("ПРОДУКТЫ  питания", "молочные продукты", "Игрушки"), "kg"),
            new(JUICE, "елочные игрушки", ("Напитки",), "l"),
        )
        # The existing generic product wins: its name, category and unit stay, the sent path is ignored.
        toys = generic("Ёлочные игрушки")
        self.assertEqual((toys.base_unit, toys.category.name), ("pcs", "Молочные продукты"))
        self.assertEqual({generic_of(MILK), generic_of(JUICE)}, {"Ёлочные игрушки"})
        self.assertEqual(Category.objects.count(), 3)
        self.assertFalse(CreatedGenericProduct.objects.exists() or CreatedCategory.objects.exists())
        self.assertEqual(record(MILK).suggested_base_unit, "pcs")

    def test_two_items_with_one_new_name_share_the_first_one(self):
        result = apply(
            new(KEFIR_B, "КЕФИР", ("Напитки",), "kg"),
            new(KEFIR_A, "Кефир", DAIRY, "l"),
        )
        self.assertEqual(result.applied, 2)
        # The lower product id creates the record; the path and the unit of the other one are ignored.
        created = generic("Кефир")
        self.assertEqual((created.base_unit, created.category.name), ("l", "Молочные продукты"))
        self.assertEqual(GenericProduct.objects.filter(name__iexact="кефир").count(), 1)
        self.assertFalse(Category.objects.filter(name="Напитки").exists())
        self.assertEqual(CreatedGenericProduct.objects.count(), 1)
        self.assertEqual({generic_of(KEFIR_A), generic_of(KEFIR_B)}, {"Кефир"})
        self.assertEqual(result.record_ids, [record(KEFIR_A).pk, record(KEFIR_B).pk])

    def test_package_and_base_unit_are_not_compared(self):
        # Kefir sold as "500 g" under a litre-based generic product is an ordinary case.
        self.assertEqual(apply(new(KEFIR_A, "Кефир", DAIRY, "l")).applied, 1)

    def test_run_counters_and_private_statistics(self):
        run = ClassificationRun.objects.create(trigger="manual", scope="all")
        result = apply(
            existing(MILK, generic("Молоко")), new(KEFIR_A, "Кефир", DAIRY, "l"), item(UNKNOWN),
            new(JUICE, "Juice"), existing(SOAP, 10**9), existing(EXAMPLE, generic("Молоко")), run=run,
        )
        self.assertEqual((result.applied, result.unknown), (2, 1))
        self.assertEqual(result.skipped, {"name_invalid": 1, "unknown_generic": 1, "not_eligible": 1})
        run.refresh_from_db()
        self.assertEqual((run.applied_count, run.unknown_count, run.skipped_count, run.version), (2, 1, 3, 2))
        self.assertEqual(run.stats, {"unknown": 1, "name_invalid": 1, "unknown_generic": 1, "not_eligible": 1})
        # The cursor and the status belong to the executor.
        self.assertEqual((run.cursor, run.status), (0, "queued"))
        self.assertEqual(set(ProductClassification.objects.values_list("run_id", flat=True)), {run.pk})
        self.assertEqual(CreatedGenericProduct.objects.get().run_id, run.pk)
        apply(new(TOAST, "Хлеб"), item(SAUSAGE_A), new(CHEESE, "Cheese"), run=run)
        run.refresh_from_db()
        self.assertEqual((run.applied_count, run.unknown_count, run.skipped_count, run.version), (3, 2, 4, 3))
        self.assertEqual(run.stats["name_invalid"], 2)

    def test_source_is_stored_on_the_record(self):
        source = services.Source(
            provider="codex_cli", model="demo-model", prompt_version="7", schema_version="3", classifier_version=2,
        )
        services.apply(None, response(existing(MILK, generic("Молоко"))), source=source)
        entry = record(MILK)
        self.assertEqual(
            (entry.provider, entry.model, entry.prompt_version, entry.schema_version, entry.classifier_version),
            ("codex_cli", "demo-model", "7", "3", 2),
        )


@tag("integration")
class SkipReasonTests(DemoTestCase):
    def assertSkipped(self, reason, *items, count=1):
        before = snapshot(*CATALOG_MODELS)
        records = ProductClassification.objects.count()
        result = apply(*items)
        self.assertEqual((result.applied, result.unknown, result.skipped), (0, 0, {reason: count}))
        self.assertEqual(snapshot(*CATALOG_MODELS), before)
        self.assertEqual(ProductClassification.objects.count(), records)

    def test_unknown_generic(self):
        self.assertSkipped("unknown_generic", existing(MILK, 10**9))

    def test_service_target(self):
        self.assertSkipped(
            "service_target", existing(MILK, service()), new(JUICE, "не разобрано"),
            new(SOAP, "Мыло", ("Не разобрано", "Химия")), new(TOAST, "Хлеб", ("Продукты питания", "НЕ РАЗОБРАНО")),
            count=4,
        )

    def test_name_invalid(self):
        self.assertSkipped(
            "name_invalid", new(MILK, "   "), new(JUICE, "Apple juice"), new(SOAP, "Мыло\x00"), count=3,
        )

    def test_category_invalid(self):
        self.assertSkipped(
            "category_invalid", new(MILK, "Напиток", ("Drinks",)), new(JUICE, "Сок", ("Напитки", "напитки")),
            new(SOAP, "Мыло", ("Химия", "  ")), count=3,
        )

    def test_generic_ambiguous(self):
        category = Category.objects.get(name="Молочные продукты")
        GenericProduct.objects.create(name="Ёлка", category=category, base_unit="pcs")
        GenericProduct.objects.create(name="Елка", category=category, base_unit="pcs")
        self.assertSkipped("generic_ambiguous", new(MILK, "ёлка"))
        # An explicit id is not ambiguous.
        self.assertEqual(apply(existing(MILK, generic("Елка"))).applied, 1)

    def test_category_ambiguous(self):
        food = Category.objects.get(name="Продукты питания")
        Category.objects.create(parent=food, name="Ёлки")
        Category.objects.create(parent=food, name="Елки")
        self.assertSkipped("category_ambiguous", new(MILK, "Игрушка", ("Продукты питания", "елки", "Новогодние")))
        # The same names under different parents are not ambiguous.
        Category.objects.create(parent=None, name="Молочные продукты")
        self.assertEqual(apply(new(MILK, "Йогурт", DAIRY, "kg")).applied, 1)
        self.assertEqual(generic("Йогурт").category.parent, food)

    def test_rejected_before(self):
        apply(new(CHEESE, "Сыр", DAIRY, "kg"), existing(MILK, generic("Молоко")))
        services.reject(record(CHEESE).pk, version=1)
        services.reject(record(MILK).pk, version=1)
        self.assertFalse(GenericProduct.objects.filter(name="Сыр").exists())
        self.assertSkipped("rejected_before", new(CHEESE, " СЫР "), existing(MILK, generic("Молоко")), count=2)
        # The memory is per product and per name: another product may get «Сыр», this one another name.
        result = apply(new(KEFIR_A, "Сыр", DAIRY, "kg"), new(CHEESE, "Творог", DAIRY, "kg"))
        self.assertEqual((result.applied, result.skipped), (2, {}))

    def test_not_eligible(self):
        apply(new(SAUSAGE_A, "Колбаса"))
        twin = add_product(KEFIR_A + ".")
        merges.detect()
        hidden = next(
            candidate for candidate in (product(KEFIR_A), twin)
            if not services.candidates(product_ids=[candidate.pk]).exists()
        )
        self.assertSkipped(
            "not_eligible",
            new(SAUSAGE_A, "Сосиски"),              # has a pending record
            new(EXAMPLE, "Напиток"),                # a meaningful generic product
            new(DEPOSIT, "Тара"),                   # linked to a deposit line only
            new(hidden, "Кефир"),                   # absorbed by a pending merge
            new(10**9, "Призрак"),                  # does not exist
            item(10**9 + 1),                        # "unknown" about a product that is gone
            count=6,
        )

    def test_catalog_conflict_skips_one_item_and_keeps_the_batch(self):
        GenericProduct.objects.create(
            name="Сок", category=Category.objects.get(name="Молочные продукты"), base_unit="l",
        )
        real = services._Generics

        class Blind(real):
            """The index misses «Сок», as if the admin created it after the read."""

            def __init__(self):
                super().__init__()
                if not getattr(Blind, "used", False):
                    Blind.used = True
                    self.by_key.pop("сок", None)

        before = snapshot(Category)
        with patch.object(services, "_Generics", Blind):
            result = apply(
                new(MILK, "Напиток", ("Напитки",), "l"), new(JUICE, "Сок", ("Соки", "Фруктовые"), "l"),
                new(SOAP, "Мыло", ("Бытовая химия",), "pcs"),
            )
        self.assertEqual((result.applied, result.skipped), (2, {"catalog_conflict": 1}))
        self.assertEqual(generic_of(JUICE), "Не разобрано")
        self.assertEqual((generic_of(MILK), generic_of(SOAP)), ("Напиток", "Мыло"))
        # The categories of the failed item went away with its savepoint.
        self.assertEqual(
            set(Category.objects.values_list("name", flat=True)) - {row["name"] for row in before["Category"]},
            {"Напитки", "Бытовая химия"},
        )
        self.assertEqual(states(CreatedCategory), {"Напитки": "provisional", "Бытовая химия": "provisional"})
        self.assertEqual(GenericProduct.objects.filter(name="Сок").count(), 1)


@tag("integration")
class RepeatTests(DemoTestCase):
    def test_demo_numbers_of_the_mixed_scenario(self):
        run = suggest()
        expected = demo.EXPECTED
        self.assertEqual((run.status, run.trigger, run.scope, run.error_code), ("succeeded", "command", "all", ""))
        self.assertEqual((run.requested_count, run.cursor, run.remaining_count), (10, 10, 0))
        self.assertEqual((run.applied_count, run.unknown_count, run.skipped_count), (expected["pending"], 1, 0))
        self.assertEqual(run.stats, {"unknown": 1})
        self.assertEqual((run.run_token, run.lease_expires_at, run.heartbeat_at), (None, None, None))
        self.assertIsNotNone(run.finished_at)
        self.assertEqual((run.provider, run.model, run.prompt_version, run.schema_version), ("fake", "", "1", "1"))
        pending = ProductClassification.objects.filter(status="pending")
        self.assertEqual(pending.count(), expected["pending"])
        groups = {}
        for name, suggested in pending.values_list("product_name", "suggested_generic_name"):
            groups.setdefault(suggested, set()).add(name)
        self.assertEqual(groups, {
            "Молоко": {MILK}, "Кефир": {KEFIR_A, KEFIR_B}, "Сыр": {CHEESE}, "Колбаса": {SAUSAGE_A, SAUSAGE_B},
            "Хлеб": {TOAST}, "Сок": {JUICE}, "Средство для мытья посуды": {SOAP},
        })
        self.assertEqual(len(groups), expected["groups"])
        self.assertEqual(states(CreatedGenericProduct), dict.fromkeys(
            ("Кефир", "Сыр", "Колбаса", "Хлеб", "Сок", "Средство для мытья посуды"), "provisional"))
        self.assertEqual(states(CreatedCategory), dict.fromkeys(
            ("Мясные продукты", "Хлеб и выпечка", "Напитки", "Бытовая химия"), "provisional"))
        self.assertEqual(CreatedGenericProduct.objects.count(), expected["created_generics"])
        self.assertEqual(CreatedCategory.objects.count(), expected["created_categories"])
        self.assertEqual({generic_of(UNKNOWN), generic_of(DEPOSIT)}, {"Не разобрано"})
        self.assertEqual(generic_of(EXAMPLE), "Молоко")
        self.assertEqual((generic("Сыр").base_unit, generic("Сок").category.parent), ("kg", None))
        attempt = ClassificationAttempt.objects.get()
        self.assertEqual((attempt.run_id, attempt.batch, attempt.ordinal, attempt.status), (run.pk, 1, 1, "succeeded"))
        self.assertEqual(len(attempt.product_ids), 10)
        self.assertEqual(len(attempt.raw_payload["items"]), 10)
        self.assertRegex(attempt.input_sha256, r"\A[0-9a-f]{64}\Z")
        self.assertIsNotNone(attempt.finished_at)

    def test_second_run_asks_only_about_the_unknown_product(self):
        suggest()
        before = snapshot(*CATALOG_MODELS, ProductClassification, CreatedGenericProduct, CreatedCategory)
        run = suggest()
        self.assertEqual((run.requested_count, run.applied_count, run.unknown_count), (1, 0, 1))
        self.assertEqual(run.product_ids, [product(UNKNOWN).pk])
        self.assertEqual(snapshot(*CATALOG_MODELS, ProductClassification, CreatedGenericProduct, CreatedCategory), before)

    def test_applying_the_same_answer_again_does_nothing(self):
        answer = (existing(MILK, generic("Молоко")), new(KEFIR_A, "Кефир", DAIRY, "l"), new(JUICE, "Сок", ("Напитки",), "l"))
        self.assertEqual(apply(*answer).applied, 3)
        before = snapshot()
        result = apply(*answer)
        self.assertEqual((result.applied, result.record_ids, result.skipped), (0, [], {"not_eligible": 3}))
        self.assertEqual(snapshot(), before)

    def test_meaningful_and_confirmed_products_are_never_changed_again(self):
        suggest()
        services.confirm(record(MILK).pk, version=1, generic_id=generic("Молоко").pk)
        services.confirm(record(KEFIR_A).pk, version=1, generic_id=generic("Сыр").pk)
        Product.objects.filter(name=TOAST).update(generic=generic("Молоко"))  # a human in the admin
        services.reconcile()
        fixed = {name: generic_of(name) for name in (EXAMPLE, MILK, KEFIR_A, TOAST)}
        self.assertEqual(fixed, {EXAMPLE: "Молоко", MILK: "Молоко", KEFIR_A: "Сыр", TOAST: "Молоко"})
        ids = [product(name).pk for name in fixed]
        records = ProductClassification.objects.count()
        self.assertIsNone(services.start_run(product_ids=ids))
        for trigger in ("manual", "command", "import"):
            with self.subTest(trigger=trigger):
                self.assertEqual(services.request_run(trigger=trigger, product_ids=ids), (None, False))
        # Even a direct answer about them is refused under the lock.
        result = apply(*[new(name, "Тестовый продукт") for name in fixed])
        self.assertEqual(result.skipped, {"not_eligible": 4})
        suggest("new_category")
        self.assertEqual({name: generic_of(name) for name in fixed}, fixed)
        self.assertEqual(ProductClassification.objects.filter(product_name__in=fixed).count(), 3)
        self.assertGreater(ProductClassification.objects.count(), records)

    def test_rejected_suggestion_is_not_offered_again(self):
        suggest()
        services.reject(record(CHEESE).pk, version=1)
        self.assertEqual(
            list(ClassificationRejection.objects.values_list("product__name", "generic_key", "generic_name")),
            [(CHEESE, "сыр", "Сыр")],
        )
        run = suggest()  # the fake answers «Сыр» again
        self.assertEqual((run.requested_count, run.applied_count, run.unknown_count), (2, 0, 1))
        self.assertEqual(run.stats, {"unknown": 1, "rejected_before": 1})
        self.assertEqual(generic_of(CHEESE), "Не разобрано")
        self.assertFalse(GenericProduct.objects.filter(name="Сыр").exists())
        run = suggest("rejected_again")
        self.assertEqual(run.stats, {"unknown": 1, "rejected_before": 1})
        # Another name is welcome.
        self.assertEqual(apply(new(CHEESE, "Творог", DAIRY, "kg")).applied, 1)
