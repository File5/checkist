import io
import json
import uuid
from datetime import timedelta
from decimal import Decimal
from unittest.mock import patch

from django.core.management import call_command
from django.test import TestCase, override_settings, tag
from django.utils import timezone

from catalog.models import Category, GenericProduct, Product
from classification import demo, services
from classification.models import (
    ClassificationRejection, ClassificationRun, CreatedCategory, CreatedGenericProduct, ProductClassification,
)
from classification.tests.factories import (
    CATALOG_MODELS, CHEESE, DEPOSIT, EXAMPLE, JUICE, KEFIR_A, KEFIR_B, MILK, SAUSAGE_A, SAUSAGE_B, SOAP, TOAST,
    UNKNOWN, add_product, apply, generic, generic_of, new, product, record, service, snapshot, states, suggest,
)
from merges import services as merges
from merges.models import ProductMerge
from merges.visibility import is_absorbed
from receipts.models import ProductAlias


class SuggestedTestCase(TestCase):
    """The demo after ``suggest --fake-scenario mixed``: 9 pending records in 7 groups."""

    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()
        cls.original = snapshot(*CATALOG_MODELS)
        suggest()

    def assertUnchanged(self, before):
        self.assertEqual(snapshot(), before)

    def assertRefused(self, error, call, *, saved=False):
        """The call raises ``error``; unless ``saved`` it leaves every table as it was."""
        before = snapshot()
        with self.assertRaises(error) as caught:
            call()
        if not saved:
            self.assertUnchanged(before)
        return caught.exception


@tag("integration")
class ConfirmTests(SuggestedTestCase):
    def test_confirm_keeps_the_product_and_accepts_the_created_records(self):
        entry = record(SAUSAGE_A)
        products = snapshot(Product)
        confirmed = services.confirm(entry.pk, version=1, generic_id=entry.suggested_generic_ref)
        self.assertEqual((confirmed.pk, confirmed.status, confirmed.resolution, confirmed.version), (
            entry.pk, "confirmed", "confirmed", 2))
        self.assertEqual(
            (confirmed.final_generic_ref, confirmed.final_generic_name, confirmed.final_base_unit),
            (entry.suggested_generic_ref, "Колбаса", "kg"),
        )
        self.assertIsNone(confirmed.active_product_id)
        self.assertIsNotNone(confirmed.resolved_at)
        self.assertEqual(snapshot(Product), products)
        # The created generic product and its created category become ordinary records.
        self.assertEqual(states(CreatedGenericProduct)["Колбаса"], "kept")
        self.assertEqual(states(CreatedCategory)["Мясные продукты"], "kept")
        self.assertEqual(states(CreatedCategory)["Напитки"], "provisional")
        self.assertFalse(ClassificationRejection.objects.exists())
        # The second record of the group is still waiting.
        self.assertEqual(record(SAUSAGE_B).status, "pending")

    def test_confirm_of_an_existing_generic_product(self):
        entry = record(MILK)
        before = snapshot(*CATALOG_MODELS, CreatedGenericProduct, CreatedCategory)
        self.assertEqual(services.confirm(entry.pk, version=1, generic_id=generic("Молоко").pk).resolution, "confirmed")
        self.assertEqual(snapshot(*CATALOG_MODELS, CreatedGenericProduct, CreatedCategory), before)

    def test_choose_another_existing_generic_product(self):
        entry = record(CHEESE)
        chosen = services.confirm(entry.pk, version=1, generic_id=generic("Молоко").pk)
        self.assertEqual((chosen.status, chosen.resolution, chosen.version), ("confirmed", "other", 2))
        self.assertEqual(
            (chosen.final_generic_ref, chosen.final_generic_name, chosen.final_base_unit),
            (generic("Молоко").pk, "Молоко", "l"),
        )
        self.assertEqual(generic_of(CHEESE), "Молоко")
        # What was suggested is remembered as refused and the emptied created record goes away.
        memory = ClassificationRejection.objects.get()
        self.assertEqual(
            (memory.product.name, memory.generic_key, memory.generic_name, memory.classification_id),
            (CHEESE, "сыр", "Сыр", entry.pk),
        )
        self.assertFalse(GenericProduct.objects.filter(name="Сыр").exists())
        self.assertEqual(states(CreatedGenericProduct)["Сыр"], "removed")
        # The category existed before the mechanism: it stays.
        self.assertTrue(Category.objects.filter(name="Молочные продукты").exists())
        self.assertEqual(chosen.suggested_generic_name, "Сыр")

    def test_choose_another_generic_product_that_is_new_itself(self):
        entry = record(JUICE)
        chosen = services.confirm(entry.pk, version=1, generic_id=generic("Колбаса").pk)
        self.assertEqual((chosen.resolution, chosen.final_generic_name), ("other", "Колбаса"))
        self.assertEqual(generic_of(JUICE), "Колбаса")
        # The chosen new generic product is accepted with its category; the refused one is removed with its own.
        self.assertEqual(states(CreatedGenericProduct)["Колбаса"], "kept")
        self.assertEqual(states(CreatedCategory)["Мясные продукты"], "kept")
        self.assertEqual((states(CreatedGenericProduct)["Сок"], states(CreatedCategory)["Напитки"]), ("removed", "removed"))
        self.assertFalse(GenericProduct.objects.filter(name="Сок").exists())
        self.assertFalse(Category.objects.filter(name="Напитки").exists())

    def test_another_generic_product_must_exist_and_must_not_be_the_service_one(self):
        entry = record(CHEESE)
        for value in (10**9, 0, -5, "7", None, True, 1.5, 2**63):
            with self.subTest(generic_id=value):
                error = self.assertRefused(
                    services.ClassificationInvalidParameter,
                    lambda: services.confirm(entry.pk, version=1, generic_id=value),
                )
                self.assertEqual((error.code, error.fields), ("invalid_parameter", {"generic_id": "unknown"}))
        error = self.assertRefused(
            services.ClassificationInvalidParameter,
            lambda: services.confirm(entry.pk, version=1, generic_id=service().pk),
        )
        self.assertEqual(error.fields, {"generic_id": "service_generic"})

    def test_missing_record(self):
        for record_id in (10**9, 0, -1, "1", None, True, 2**63, 1.0):
            with self.subTest(record_id=record_id):
                for call in (
                    lambda: services.confirm(record_id, version=1, generic_id=1),
                    lambda: services.reject(record_id, version=1),
                ):
                    error = self.assertRefused(services.ClassificationNotFound, call)
                    self.assertEqual(error.code, "not_found")

    def test_stale_version_saves_nothing(self):
        entry = record(CHEESE)
        for version in (2, 0, None, "1"):
            with self.subTest(version=version):
                for call in (
                    lambda: services.confirm(entry.pk, version=version, generic_id=entry.suggested_generic_ref),
                    lambda: services.confirm(entry.pk, version=version, generic_id=generic("Молоко").pk),
                    lambda: services.reject(entry.pk, version=version),
                ):
                    error = self.assertRefused(services.ClassificationChanged, call)
                    self.assertEqual((error.code, error.record.pk, error.record.version), (
                        "classification_changed", entry.pk, 1))
                    self.assertEqual(error.record.status, "pending")

    def test_version_is_checked_before_the_parameter_and_the_status_before_the_version(self):
        entry = record(CHEESE)
        self.assertRefused(
            services.ClassificationChanged, lambda: services.confirm(entry.pk, version=9, generic_id=10**9),
        )
        services.reject(entry.pk, version=1)
        error = self.assertRefused(
            services.ClassificationResolved, lambda: services.confirm(entry.pk, version=9, generic_id=10**9),
        )
        self.assertEqual((error.code, error.record.status), ("classification_resolved", "rejected"))


@tag("integration")
class RejectTests(SuggestedTestCase):
    def test_reject_returns_the_product_and_remembers_the_refusal(self):
        entry = record(MILK)
        rejected = services.reject(entry.pk, version=1)
        self.assertEqual((rejected.status, rejected.resolution, rejected.version), ("rejected", "rejected", 2))
        self.assertEqual(
            (rejected.final_generic_ref, rejected.final_generic_name, rejected.final_base_unit),
            (service().pk, "Не разобрано", "pcs"),
        )
        self.assertIsNone(rejected.active_product_id)
        self.assertEqual(generic_of(MILK), "Не разобрано")
        self.assertEqual(
            list(ClassificationRejection.objects.values_list("product__name", "generic_key")), [(MILK, "молоко")],
        )
        # «Молоко» was not created by the mechanism and is never removed.
        self.assertEqual(generic("Молоко").products.count(), 1)

    def test_created_generic_product_stays_while_another_pending_record_points_at_it(self):
        services.reject(record(SAUSAGE_A).pk, version=1)
        self.assertEqual(generic("Колбаса").products.count(), 1)
        self.assertEqual(states(CreatedGenericProduct)["Колбаса"], "provisional")
        self.assertEqual(states(CreatedCategory)["Мясные продукты"], "provisional")
        # The last one leaves: the generic product and its created category are removed.
        services.reject(record(SAUSAGE_B).pk, version=1)
        self.assertFalse(GenericProduct.objects.filter(name="Колбаса").exists())
        self.assertFalse(Category.objects.filter(name="Мясные продукты").exists())
        self.assertEqual((states(CreatedGenericProduct)["Колбаса"], states(CreatedCategory)["Мясные продукты"]), (
            "removed", "removed"))
        journal = CreatedGenericProduct.objects.get(name="Колбаса")
        self.assertEqual((journal.generic_id, journal.generic_ref > 0), (None, True))
        self.assertIsNotNone(journal.resolved_at)
        # «Продукты питания» was there before and still holds other categories.
        self.assertTrue(Category.objects.filter(name="Продукты питания").exists())

    def test_rejecting_everything_returns_the_original_catalog(self):
        for entry in ProductClassification.objects.order_by("pk"):
            services.reject(entry.pk, version=1)
        self.assertEqual(snapshot(*CATALOG_MODELS), self.original)
        self.assertEqual(ClassificationRejection.objects.count(), 9)
        self.assertEqual(set(states(CreatedGenericProduct).values()) | set(states(CreatedCategory).values()), {"removed"})

    def test_missing_previous_generic_product_is_replaced_by_the_service_one(self):
        ProductClassification.objects.filter(pk=record(MILK).pk).update(previous_generic_ref=10**9)
        rejected = services.reject(record(MILK).pk, version=1)
        self.assertEqual((rejected.final_generic_ref, generic_of(MILK)), (service().pk, "Не разобрано"))

    def test_service_generic_product_is_created_again_when_it_is_gone(self):
        Product.objects.filter(generic=service()).update(generic=generic("Молоко"))
        old = service()
        category_id = old.category_id
        old.delete()
        Category.objects.filter(pk=category_id).delete()
        rejected = services.reject(record(JUICE).pk, version=1)
        created = service()
        self.assertNotEqual(created.pk, old.pk)
        self.assertEqual((created.name, created.base_unit, created.category.name, created.category.parent), (
            "Не разобрано", "pcs", "Не разобрано", None))
        self.assertEqual((rejected.final_generic_ref, product(JUICE).generic_id), (created.pk, created.pk))
        # The service records are never journaled as created by the mechanism.
        self.assertNotIn("Не разобрано", states(CreatedGenericProduct))
        self.assertNotIn("Не разобрано", states(CreatedCategory))


@tag("integration")
class RepeatTests(SuggestedTestCase):
    """Safe repeat without Idempotency-Key: by the content of the request and the state of the record."""

    def test_confirm_with_the_same_generic_is_a_repeat_at_any_version(self):
        entry = record(MILK)
        milk = generic("Молоко").pk
        first = services.confirm(entry.pk, version=1, generic_id=milk)
        before = snapshot()
        for version in (1, 2, 99, None):
            with self.subTest(version=version):
                again = services.confirm(entry.pk, version=version, generic_id=milk)
                self.assertEqual((again.pk, again.status, again.version, again.resolved_at), (
                    first.pk, "confirmed", 2, first.resolved_at))
                self.assertUnchanged(before)

    def test_choose_another_is_a_repeat_with_the_same_choice_only(self):
        entry = record(CHEESE)
        milk = generic("Молоко").pk
        services.confirm(entry.pk, version=1, generic_id=milk)
        before = snapshot()
        self.assertEqual(services.confirm(entry.pk, version=1, generic_id=milk).resolution, "other")
        self.assertUnchanged(before)
        for other in (entry.suggested_generic_ref, generic("Колбаса").pk, 10**9):
            with self.subTest(generic_id=other):
                error = self.assertRefused(
                    services.ClassificationResolved, lambda: services.confirm(entry.pk, version=2, generic_id=other),
                )
                self.assertEqual((error.record.pk, error.record.status), (entry.pk, "confirmed"))

    def test_confirm_of_a_rejected_or_superseded_record_is_resolved(self):
        rejected, superseded = record(MILK), record(JUICE)
        services.reject(rejected.pk, version=1)
        Product.objects.filter(name=JUICE).update(generic=generic("Молоко"))
        self.assertEqual(services.reconcile(), 1)
        for entry in (rejected, superseded):
            with self.subTest(entry=entry.product_name):
                self.assertRefused(services.ClassificationResolved, lambda: services.confirm(
                    entry.pk, version=2, generic_id=entry.suggested_generic_ref))

    def test_reject_is_a_repeat_on_any_rejected_record(self):
        entry = record(MILK)
        first = services.reject(entry.pk, version=1)
        before = snapshot()
        for version in (1, 2, 99):
            again = services.reject(entry.pk, version=version)
            self.assertEqual((again.status, again.resolution, again.version), ("rejected", "rejected", first.version))
            self.assertUnchanged(before)
        # Cancelled by the command is "rejected" as well.
        services.cancel_pending()
        cancelled = record(JUICE)
        self.assertEqual((cancelled.status, cancelled.resolution), ("rejected", "cancelled"))
        before = snapshot()
        self.assertEqual(services.reject(cancelled.pk, version=1).resolution, "cancelled")
        self.assertUnchanged(before)

    def test_reject_of_a_confirmed_or_superseded_record_is_resolved(self):
        confirmed, superseded = record(MILK), record(JUICE)
        services.confirm(confirmed.pk, version=1, generic_id=confirmed.suggested_generic_ref)
        Product.objects.filter(name=JUICE).update(generic=generic("Молоко"))
        services.reconcile()
        for entry in (confirmed, superseded):
            with self.subTest(entry=entry.product_name):
                error = self.assertRefused(services.ClassificationResolved, lambda: services.reject(entry.pk, version=2))
                self.assertEqual(error.record.pk, entry.pk)
        self.assertEqual(generic_of(MILK), "Молоко")


@tag("integration")
class ConfirmManyTests(SuggestedTestCase):
    def pairs(self, *names):
        return [(record(name).pk, record(name).version) for name in names]

    def test_group_is_confirmed_in_id_order(self):
        result = services.confirm_many(self.pairs(KEFIR_B, KEFIR_A))
        self.assertEqual([entry.product_name for entry in result], [KEFIR_A, KEFIR_B])
        self.assertEqual({(entry.status, entry.resolution, entry.version) for entry in result}, {
            ("confirmed", "confirmed", 2)})
        self.assertEqual({entry.final_generic_name for entry in result}, {"Кефир"})
        self.assertEqual(states(CreatedGenericProduct)["Кефир"], "kept")
        self.assertEqual(ProductClassification.objects.filter(status="pending").count(), 7)

    def test_records_of_different_groups_and_already_confirmed_ones(self):
        services.confirm(record(MILK).pk, version=1, generic_id=generic("Молоко").pk)
        result = services.confirm_many([(record(MILK).pk, 1), *self.pairs(JUICE, SAUSAGE_A)])
        self.assertEqual({entry.status for entry in result}, {"confirmed"})
        self.assertEqual(len(result), 3)
        self.assertEqual(states(CreatedCategory)["Напитки"], "kept")

    def test_repeat_of_a_done_request_writes_nothing(self):
        items = self.pairs(KEFIR_A, KEFIR_B)
        services.confirm_many(items)
        before = snapshot()
        for versions in (items, [(pk, 99) for pk, _version in items]):
            self.assertEqual([entry.status for entry in services.confirm_many(versions)], ["confirmed"] * 2)
            self.assertUnchanged(before)

    def test_item_list_is_checked_first(self):
        cases = (
            ([], {"items": "empty"}),
            ([(index, 1) for index in range(1, 102)], {"items": "too_many"}),
            ([(5, 1), (6, 1), (5, 2), (6, 1)], {"items.2.id": "duplicate", "items.3.id": "duplicate"}),
        )
        for items, fields in cases:
            with self.subTest(fields=fields):
                error = self.assertRefused(services.ClassificationInvalidParameter, lambda: services.confirm_many(items))
                self.assertEqual(error.fields, fields)
        self.assertEqual(len(services.confirm_many(self.pairs(KEFIR_A))), 1)

    def test_hundred_records_is_the_limit_not_an_error(self):
        items = [(record(KEFIR_A).pk, 1)] + [(10**9 + index, 1) for index in range(99)]
        self.assertRefused(services.ClassificationNotFound, lambda: services.confirm_many(items))

    def test_a_missing_record_refuses_everything(self):
        for missing in (10**9, "x", None):
            with self.subTest(missing=missing):
                self.assertRefused(
                    services.ClassificationNotFound,
                    lambda: services.confirm_many([*self.pairs(KEFIR_A), (missing, 1), *self.pairs(KEFIR_B)]),
                )

    def test_a_record_resolved_otherwise_refuses_everything(self):
        services.reject(record(KEFIR_B).pk, version=1)
        services.confirm(record(CHEESE).pk, version=1, generic_id=generic("Молоко").pk)
        error = self.assertRefused(
            services.ClassificationResolved,
            lambda: services.confirm_many([*self.pairs(KEFIR_A), (record(KEFIR_B).pk, 1), (record(CHEESE).pk, 2)]),
        )
        self.assertEqual((error.record, error.fields), (None, {"items.1": "resolved", "items.2": "resolved"}))
        self.assertEqual(record(KEFIR_A).status, "pending")

    def test_a_stale_version_refuses_everything(self):
        error = self.assertRefused(
            services.ClassificationChanged,
            lambda: services.confirm_many([(record(KEFIR_A).pk, 5), *self.pairs(KEFIR_B, JUICE)]),
        )
        self.assertEqual(error.fields, {"items.0": "changed"})
        self.assertEqual(ProductClassification.objects.filter(status="pending").count(), 9)

    def test_reconciliation_outcomes_are_saved_and_nothing_is_confirmed(self):
        Product.objects.filter(name=KEFIR_A).update(generic=generic("Молоко"))  # a human in the admin
        GenericProduct.objects.filter(name="Сок").update(name="Соки")
        items = self.pairs(KEFIR_A, JUICE, KEFIR_B, MILK)
        error = self.assertRefused(services.ClassificationResolved, lambda: services.confirm_many(items), saved=True)
        self.assertEqual(error.fields, {"items.0": "resolved", "items.1": "changed"})
        closed, updated = record(KEFIR_A), record(JUICE)
        self.assertEqual((closed.status, closed.resolution, closed.final_generic_name), ("superseded", "changed", "Молоко"))
        self.assertEqual((updated.status, updated.version, updated.suggested_generic_name), ("pending", 2, "Соки"))
        self.assertEqual({record(KEFIR_B).status, record(MILK).status}, {"pending"})
        self.assertEqual(generic_of(KEFIR_A), "Молоко")
        # Only "changed" left: the repeat with fresh versions goes through.
        error = self.assertRefused(services.ClassificationResolved, lambda: services.confirm_many(items))
        self.assertEqual(error.fields, {"items.0": "resolved", "items.1": "changed"})
        self.assertEqual(len(services.confirm_many(self.pairs(JUICE, KEFIR_B, MILK))), 3)


@tag("integration")
class ReconcileTests(SuggestedTestCase):
    def test_deleted_product_closes_the_record(self):
        entry = record(JUICE)
        product(JUICE).delete()
        self.assertEqual(ProductClassification.objects.get(pk=entry.pk).status, "pending")
        error = self.assertRefused(
            services.ClassificationResolved,
            lambda: services.confirm(entry.pk, version=1, generic_id=entry.suggested_generic_ref), saved=True,
        )
        closed = error.record
        self.assertEqual((closed.status, closed.resolution, closed.version), ("superseded", "product_removed", 2))
        self.assertEqual((closed.final_generic_ref, closed.final_generic_name, closed.final_base_unit), (None, "", ""))
        # The created generic product and category nobody uses are removed.
        self.assertFalse(GenericProduct.objects.filter(name="Сок").exists())
        self.assertFalse(Category.objects.filter(name="Напитки").exists())
        # From now on it is an ordinary resolved record: nothing more is saved.
        self.assertRefused(services.ClassificationResolved, lambda: services.reject(entry.pk, version=2))

    def test_value_changed_by_a_human_stays_and_the_record_steps_aside(self):
        entry = record(JUICE)
        Product.objects.filter(name=JUICE).update(generic=generic("Молоко"))
        for call in (lambda: services.reject(entry.pk, version=1),
                     lambda: services.confirm(entry.pk, version=1, generic_id=entry.suggested_generic_ref)):
            error = self.assertRefused(services.ClassificationResolved, call, saved=True)
            closed = error.record
            self.assertEqual((closed.status, closed.resolution, closed.version), ("superseded", "changed", 2))
            self.assertEqual((closed.final_generic_ref, closed.final_generic_name, closed.final_base_unit), (
                generic("Молоко").pk, "Молоко", "l"))
            self.assertIsNone(closed.active_product_id)
        self.assertEqual(generic_of(JUICE), "Молоко")
        self.assertFalse(GenericProduct.objects.filter(name="Сок").exists())
        self.assertEqual((states(CreatedGenericProduct)["Сок"], states(CreatedCategory)["Напитки"]), ("removed", "removed"))
        self.assertFalse(ClassificationRejection.objects.exists())

    def test_value_changed_back_to_the_service_generic_is_respected_too(self):
        entry = record(MILK)
        Product.objects.filter(name=MILK).update(generic=service())
        self.assertRefused(services.ClassificationResolved, lambda: services.reject(entry.pk, version=1), saved=True)
        self.assertEqual((record(MILK).resolution, record(MILK).final_generic_name), ("changed", "Не разобрано"))
        # No refusal was recorded: the next manual run may suggest «Молоко» again.
        self.assertEqual(suggest().applied_count, 1)
        self.assertEqual(generic_of(MILK), "Молоко")

    def test_stale_snapshot_is_updated_and_reported(self):
        entry = record(JUICE)
        changes = (
            (lambda: GenericProduct.objects.filter(name="Сок").update(name="Соки"),
             lambda fresh: self.assertEqual(fresh.suggested_generic_name, "Соки")),
            (lambda: GenericProduct.objects.filter(name="Соки").update(base_unit="kg"),
             lambda fresh: self.assertEqual(fresh.suggested_base_unit, "kg")),
            (lambda: Category.objects.filter(name="Напитки").update(name="Питьё"),
             lambda fresh: self.assertEqual([step["name"] for step in fresh.suggested_category_path], ["Питьё"])),
            (lambda: Category.objects.filter(name="Питьё").update(parent=Category.objects.get(name="Продукты питания")),
             lambda fresh: self.assertEqual(
                 [step["name"] for step in fresh.suggested_category_path], ["Продукты питания", "Питьё"])),
            (lambda: GenericProduct.objects.filter(name="Соки").update(category=Category.objects.get(name="Молочные продукты")),
             lambda fresh: self.assertEqual(fresh.suggested_category_path[-1]["name"], "Молочные продукты")),
        )
        for version, (change, check) in enumerate(changes, 1):
            with self.subTest(version=version):
                change()
                error = self.assertRefused(
                    services.ClassificationChanged,
                    lambda: services.confirm(entry.pk, version=version, generic_id=entry.suggested_generic_ref),
                    saved=True,
                )
                fresh = error.record
                self.assertEqual((fresh.status, fresh.version, fresh.active_product_id), (
                    "pending", version + 1, entry.active_product_id))
                check(fresh)
        self.assertEqual(generic_of(JUICE), "Соки")
        confirmed = services.confirm(entry.pk, version=6, generic_id=entry.suggested_generic_ref)
        self.assertEqual((confirmed.status, confirmed.final_generic_name, confirmed.final_base_unit), (
            "confirmed", "Соки", "kg"))

    def test_reconcile_all_and_the_command(self):
        self.assertEqual(services.reconcile(), 0)
        product(JUICE).delete()
        Product.objects.filter(name=CHEESE).update(generic=generic("Молоко"))
        GenericProduct.objects.filter(name="Колбаса").update(name="Колбасы")
        # Reading writes nothing: the records look pending until somebody reconciles.
        before = snapshot()
        infos = {info.record.product_name: info for info in services.describe(services.records(status="pending"))}
        self.assertEqual(len(infos), 9)
        self.assertEqual((infos[JUICE].can_act, infos[CHEESE].can_act, infos[SAUSAGE_A].can_act), (False, False, True))
        self.assertUnchanged(before)
        output = io.StringIO()
        call_command("product_classifications", "reconcile", stdout=output)
        self.assertEqual(json.loads(output.getvalue()), {"changed": 4})
        self.assertEqual(
            {name: record(name).resolution for name in (JUICE, CHEESE)}, {JUICE: "product_removed", CHEESE: "changed"},
        )
        self.assertEqual({record(name).version for name in (SAUSAGE_A, SAUSAGE_B)}, {2})
        self.assertEqual(record(SAUSAGE_A).suggested_generic_name, "Колбасы")
        self.assertEqual(services.reconcile(), 0)

    def test_request_run_and_apply_reconcile_first(self):
        Product.objects.filter(name=CHEESE).update(generic=service())
        # The stale pending record would hide the product from the candidates.
        self.assertNotIn(CHEESE, services.candidates().values_list("name", flat=True))
        run, created = services.request_run(trigger="manual")
        self.assertTrue(created)
        self.assertEqual(run.product_ids, [product(CHEESE).pk, product(UNKNOWN).pk])
        self.assertEqual(record(CHEESE).resolution, "changed")
        Product.objects.filter(name=TOAST).update(generic=service())
        result = apply(new(TOAST, "Батон", ("Продукты питания", "Хлеб и выпечка"), "kg"))
        self.assertEqual(result.applied, 1)
        self.assertEqual(ProductClassification.objects.filter(product_name=TOAST).count(), 2)
        # «Хлеб» lost its only product and went away with its category; the answer created the category anew.
        self.assertFalse(GenericProduct.objects.filter(name="Хлеб").exists())
        self.assertEqual(generic("Батон").category.name, "Хлеб и выпечка")
        self.assertEqual(
            sorted(CreatedCategory.objects.filter(name="Хлеб и выпечка").values_list("state", flat=True)),
            ["provisional", "removed"],
        )


@tag("integration")
class CleanupTests(SuggestedTestCase):
    def test_created_generic_product_used_by_another_product_is_kept(self):
        Product.objects.filter(name=EXAMPLE).update(generic=generic("Сок"))  # a human liked the new record
        services.reject(record(JUICE).pk, version=1)
        self.assertEqual(generic("Сок").products.count(), 1)
        self.assertEqual((states(CreatedGenericProduct)["Сок"], states(CreatedCategory)["Напитки"]), ("kept", "kept"))
        self.assertEqual(generic_of(JUICE), "Не разобрано")

    def test_created_generic_product_used_by_a_merge_hidden_product_is_kept(self):
        twin = add_product(JUICE + ".", generic=generic("Сок"))
        merges.detect()
        self.assertTrue(is_absorbed(twin.pk))
        services.reject(record(JUICE).pk, version=1)
        self.assertTrue(GenericProduct.objects.filter(name="Сок").exists())
        self.assertEqual(states(CreatedGenericProduct)["Сок"], "kept")

    def test_accepted_generic_product_survives_later_rejections(self):
        services.confirm(record(KEFIR_A).pk, version=1, generic_id=generic("Кефир").pk)
        services.reject(record(KEFIR_B).pk, version=1)
        self.assertEqual(generic("Кефир").products.count(), 1)
        self.assertEqual(states(CreatedGenericProduct)["Кефир"], "kept")
        services.confirm(record(SAUSAGE_A).pk, version=1, generic_id=generic("Молоко").pk)
        services.reject(record(SAUSAGE_B).pk, version=1)
        self.assertFalse(GenericProduct.objects.filter(name="Колбаса").exists())

    def test_chain_of_created_categories_is_removed_up_to_the_first_used_one(self):
        apply(new(UNKNOWN, "Пельмени", ("Заморозка", "Полуфабрикаты", "Тесто"), "kg"))
        add = GenericProduct.objects.create(
            name="Мороженое", category=Category.objects.get(name="Заморозка"), base_unit="kg",
        )
        services.reject(record(UNKNOWN).pk, version=1)
        self.assertEqual(
            {name: states(CreatedCategory)[name] for name in ("Заморозка", "Полуфабрикаты", "Тесто")},
            # The root holds a generic product of a human: it is accepted, not removed.
            {"Заморозка": "kept", "Полуфабрикаты": "removed", "Тесто": "removed"},
        )
        self.assertEqual(list(Category.objects.filter(name__in=("Полуфабрикаты", "Тесто"))), [])
        self.assertEqual(add.category.name, "Заморозка")
        self.assertEqual(states(CreatedGenericProduct)["Пельмени"], "removed")

    def test_created_category_with_other_pending_content_is_left_provisional(self):
        apply(new(UNKNOWN, "Лимонад", ("Напитки",), "l"))
        services.reject(record(JUICE).pk, version=1)
        self.assertFalse(GenericProduct.objects.filter(name="Сок").exists())
        self.assertTrue(Category.objects.filter(name="Напитки").exists())
        self.assertEqual(states(CreatedCategory)["Напитки"], "provisional")
        services.reject(record(UNKNOWN).pk, version=1)
        self.assertFalse(Category.objects.filter(name="Напитки").exists())

    def test_refused_deletion_means_the_object_is_in_use(self):
        with patch.object(services, "_delete", return_value=False):
            services.reject(record(JUICE).pk, version=1)
        self.assertTrue(GenericProduct.objects.filter(name="Сок").exists())
        self.assertEqual((states(CreatedGenericProduct)["Сок"], states(CreatedCategory)["Напитки"]), ("kept", "kept"))
        self.assertEqual(generic_of(JUICE), "Не разобрано")

    def test_delete_in_a_savepoint_reports_a_protected_object(self):
        # The real refusal: PROTECT of Product.generic.
        self.assertFalse(services._delete(GenericProduct.objects.filter(name="Сок")))
        self.assertTrue(GenericProduct.objects.filter(name="Сок").exists())
        self.assertFalse(services._delete(Category.objects.filter(name="Напитки")))
        self.assertEqual(generic_of(JUICE), "Сок")


@tag("integration")
class RunTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def ids(self, *names):
        return [product(name).pk for name in names]

    def start(self, **fields):
        now = timezone.now()
        return ClassificationRun.objects.create(**{
            "trigger": "manual", "scope": "all", "status": "running", "run_token": uuid.uuid4(), "started_at": now,
            "heartbeat_at": now, "lease_expires_at": now + timedelta(seconds=60), **fields,
        })

    def test_manual_run_queues_every_candidate(self):
        run, created = services.request_run(trigger="manual")
        self.assertTrue(created)
        self.assertEqual((run.status, run.trigger, run.scope, run.version, run.cursor), ("queued", "manual", "all", 1, 0))
        self.assertEqual(run.product_ids, list(services.candidates().values_list("pk", flat=True)))
        self.assertEqual((run.requested_count, run.remaining_count), (10, 0))
        self.assertEqual((run.applied_count, run.unknown_count, run.skipped_count, run.stats), (0, 0, 0, {}))
        self.assertEqual((run.run_token, run.lease_expires_at, run.started_at, run.finished_at), (None,) * 4)
        self.assertEqual((run.prompt_version, run.schema_version, run.classifier_version), ("1", "1", 1))
        # The model is not called and the catalog is not touched.
        self.assertFalse(ProductClassification.objects.exists())
        before = snapshot()
        self.assertEqual(services.request_run(trigger="manual"), (run, False))
        self.assertEqual(snapshot(), before)

    @override_settings(RECEIPT_OCR_PROVIDER="fake")
    def test_source_of_a_queued_run_follows_the_provider(self):
        run, _created = services.request_run(trigger="manual")
        self.assertEqual((run.provider, run.model), ("fake", ""))
        run.delete()
        with override_settings(RECEIPT_OCR_PROVIDER="codex_cli", RECEIPT_OCR_MODEL="demo-model"):
            run, _created = services.request_run(trigger="manual")
        self.assertEqual((run.provider, run.model), ("codex_cli", "demo-model"))

    def test_nothing_to_suggest(self):
        Product.objects.filter(generic=service()).update(generic=generic("Молоко"))
        for trigger in ("manual", "command", "import"):
            with self.subTest(trigger=trigger):
                self.assertEqual(services.request_run(trigger=trigger), (None, False))
        self.assertIsNone(services.start_run())
        self.assertFalse(ClassificationRun.objects.exists())

    @override_settings(PRODUCT_CLASSIFICATION_RUN_LIMIT=4)
    def test_run_limit_leaves_the_rest_for_the_next_run(self):
        run, _created = services.request_run(trigger="manual")
        self.assertEqual(run.product_ids, self.ids(MILK, KEFIR_A, KEFIR_B, CHEESE))
        self.assertEqual((run.requested_count, run.remaining_count), (4, 6))
        run.delete()
        run, _created = services.request_run(trigger="import", product_ids=self.ids(SOAP, JUICE, TOAST, MILK, UNKNOWN))
        self.assertEqual((run.product_ids, run.remaining_count), (self.ids(MILK, TOAST, JUICE, SOAP), 1))
        run.delete()
        running = services.start_run(limit=99)
        self.assertEqual((running.requested_count, running.remaining_count), (4, 6))

    def test_import_run_takes_only_products_without_any_record(self):
        apply(new(MILK, "Напиток"))
        services.reject(record(MILK).pk, version=1)
        run, created = services.request_run(
            trigger="import", product_ids=self.ids(JUICE, MILK, EXAMPLE, DEPOSIT, TOAST) + [10**9],
        )
        self.assertTrue(created)
        self.assertEqual((run.status, run.trigger, run.scope), ("queued", "import", "products"))
        self.assertEqual((run.product_ids, run.requested_count), (self.ids(TOAST, JUICE), 2))
        # Only rejected, absent and non-candidate products: nothing to queue.
        self.assertEqual(services.request_run(trigger="import", product_ids=self.ids(MILK, EXAMPLE)), (None, False))

    def test_import_adds_products_to_the_queued_run(self):
        first, _created = services.request_run(trigger="import", product_ids=self.ids(TOAST, JUICE))
        run, created = services.request_run(trigger="import", product_ids=self.ids(MILK, JUICE))
        self.assertEqual((run.pk, created), (first.pk, False))
        self.assertEqual((run.product_ids, run.requested_count, run.version), (self.ids(MILK, TOAST, JUICE), 3, 2))
        # Nothing new: the run is returned untouched.
        run, created = services.request_run(trigger="import", product_ids=self.ids(MILK))
        self.assertEqual((run.version, created), (2, False))
        self.assertEqual(ClassificationRun.objects.count(), 1)

    def test_import_does_not_change_a_queued_run_of_all_candidates(self):
        queued, _created = services.request_run(trigger="manual")
        add_product("Demo Neu")
        run, created = services.request_run(trigger="import", product_ids=self.ids("Demo Neu"))
        self.assertEqual((run.pk, created, run.version, run.scope), (queued.pk, False, 1, "all"))
        self.assertNotIn(product("Demo Neu").pk, run.product_ids)

    def test_import_queues_next_to_a_running_run(self):
        running = self.start()
        run, created = services.request_run(trigger="import", product_ids=self.ids(MILK))
        self.assertTrue(created)
        self.assertEqual((run.status, running.pk != run.pk), ("queued", True))

    def test_manual_request_widens_a_queued_import_run(self):
        queued, _created = services.request_run(trigger="import", product_ids=self.ids(TOAST))
        run, created = services.request_run(trigger="manual")
        self.assertEqual((run.pk, created), (queued.pk, False))
        self.assertEqual((run.scope, run.requested_count, run.version, run.trigger), ("all", 10, 2, "import"))
        self.assertEqual(run.product_ids, list(services.candidates().values_list("pk", flat=True)))
        self.assertEqual(services.request_run(trigger="manual")[0].version, 2)

    def test_manual_request_returns_the_active_run(self):
        running = self.start(scope="products", product_ids=self.ids(MILK), trigger="import")
        before = snapshot(ClassificationRun)
        self.assertEqual(services.request_run(trigger="manual"), (running, False))
        self.assertEqual(snapshot(ClassificationRun), before)
        queued, _created = services.request_run(trigger="import", product_ids=self.ids(TOAST))
        run, created = services.request_run(trigger="manual")
        # The queued one is the answer to "suggest for everything"; it is widened.
        self.assertEqual((run.pk, created, run.scope), (queued.pk, False, "all"))

    def test_command_request_may_be_limited_to_products(self):
        run, created = services.request_run(trigger="command", product_ids=self.ids(JUICE, EXAMPLE, MILK))
        self.assertEqual((created, run.trigger, run.scope, run.product_ids), (
            True, "command", "products", self.ids(MILK, JUICE)))

    def test_start_run_of_the_command(self):
        run = services.start_run(product_ids=self.ids(JUICE, MILK), limit=1)
        self.assertEqual((run.status, run.trigger, run.scope), ("running", "command", "products"))
        self.assertEqual((run.product_ids, run.requested_count, run.remaining_count), (self.ids(MILK), 1, 1))
        self.assertIsNotNone(run.run_token)
        self.assertGreater(run.lease_expires_at - run.heartbeat_at, timedelta(seconds=200))
        self.assertEqual(run.started_at, run.heartbeat_at)
        # The worker (or another command) executes a batch: busy, nothing changes.
        before = snapshot()
        with self.assertRaises(services.ClassificationBusy) as caught:
            services.start_run()
        self.assertEqual(caught.exception.code, "classification_busy")
        self.assertEqual(snapshot(), before)
        # A lost one is closed and replaced.
        ClassificationRun.objects.filter(pk=run.pk).update(lease_expires_at=timezone.now() - timedelta(seconds=1))
        second = services.start_run()
        run.refresh_from_db()
        self.assertEqual((run.status, run.error_code, run.run_token), ("failed", "worker_lost", None))
        self.assertIsNotNone(run.finished_at)
        self.assertEqual((second.status, second.requested_count), ("running", 10))

    def test_advance_and_finish(self):
        run = services.start_run()
        lease = run.lease_expires_at
        run = services.advance_run(run, 4)
        self.assertEqual((run.cursor, run.version, run.status), (4, 2, "running"))
        self.assertGreaterEqual(run.lease_expires_at, lease)
        run = services.advance_run(run, 99)
        self.assertEqual(run.cursor, 10)
        done = services.finish_run(run)
        self.assertEqual((done.status, done.error_code, done.run_token, done.lease_expires_at, done.version), (
            "succeeded", "", None, None, 4))
        self.assertIsNotNone(done.finished_at)
        with self.assertRaises(ClassificationRun.DoesNotExist):
            services.finish_run(run)
        failed = services.finish_run(services.start_run(), error_code="auth_required")
        self.assertEqual((failed.status, failed.error_code), ("failed", "auth_required"))

    def test_summary(self):
        empty = services.summary()
        self.assertEqual((empty.pending_count, empty.unclassified_count, empty.run), (0, 10, None))
        finished = suggest()
        state = services.summary()
        self.assertEqual((state.pending_count, state.unclassified_count, state.run), (9, 1, finished))
        queued, _created = services.request_run(trigger="manual")
        self.assertEqual(services.summary().run, queued)
        running = self.start()
        self.assertEqual(services.summary().run, running)
        with self.assertNumQueries(3):
            services.summary()
        ClassificationRun.objects.filter(pk=running.pk).delete()
        ClassificationRun.objects.filter(pk=queued.pk).delete()
        self.assertEqual(services.summary().run, finished)

    def test_runs_and_get_run(self):
        first = suggest()
        second, _created = services.request_run(trigger="manual")
        self.assertEqual(list(services.runs()), [second, first])
        self.assertEqual(list(services.runs(status="succeeded")), [first])
        self.assertEqual(list(services.runs(status="failed")), [])
        self.assertEqual(services.get_run(first.pk), first)
        for missing in (10**9, 0, "x", None):
            with self.subTest(missing=missing), self.assertRaises(services.ClassificationNotFound):
                services.get_run(missing)


@tag("integration")
class CancelPendingTests(SuggestedTestCase):
    def test_everything_goes_back_and_the_repeat_is_empty(self):
        ids = list(ProductClassification.objects.order_by("pk").values_list("pk", flat=True))
        result = services.cancel_pending()
        self.assertEqual(result, {
            "cancelled": ids, "superseded": [], "runs_cancelled": [], "removed_generics": 6, "removed_categories": 4,
        })
        self.assertEqual(snapshot(*CATALOG_MODELS), self.original)
        self.assertEqual(
            set(ProductClassification.objects.values_list("status", "resolution", "final_generic_name", "version")),
            {("rejected", "cancelled", "Не разобрано", 2)},
        )
        # No refusal is remembered: the products are candidates for the next run, automatic ones aside.
        self.assertFalse(ClassificationRejection.objects.exists())
        self.assertEqual(services.candidates().count(), 10)
        self.assertEqual(services.candidates(auto=True).count(), 1)
        before = snapshot()
        self.assertEqual(services.cancel_pending(), {
            "cancelled": [], "superseded": [], "runs_cancelled": [], "removed_generics": 0, "removed_categories": 0,
        })
        self.assertUnchanged(before)
        self.assertEqual(suggest().applied_count, 9)

    def test_decisions_and_changes_of_a_human_stay(self):
        services.confirm(record(MILK).pk, version=1, generic_id=generic("Молоко").pk)
        services.confirm(record(KEFIR_A).pk, version=1, generic_id=generic("Кефир").pk)
        services.confirm(record(CHEESE).pk, version=1, generic_id=generic("Колбаса").pk)
        Product.objects.filter(name=JUICE).update(generic=generic("Молоко"))
        product(SOAP).delete()
        result = services.cancel_pending()
        self.assertEqual(result["superseded"], [record(JUICE).pk, record(SOAP).pk])
        self.assertEqual(len(result["cancelled"]), 4)
        # «Сок», «Хлеб», «Средство…» go; accepted «Кефир» and «Колбаса» stay with «Мясные продукты».
        self.assertEqual((result["removed_generics"], result["removed_categories"]), (3, 3))
        self.assertEqual(
            {name: generic_of(name) for name in (MILK, KEFIR_A, KEFIR_B, CHEESE, JUICE, SAUSAGE_A, TOAST)},
            {MILK: "Молоко", KEFIR_A: "Кефир", KEFIR_B: "Не разобрано", CHEESE: "Колбаса", JUICE: "Молоко",
             SAUSAGE_A: "Не разобрано", TOAST: "Не разобрано"},
        )
        self.assertEqual(
            set(GenericProduct.objects.values_list("name", flat=True)), {"Не разобрано", "Молоко", "Кефир", "Колбаса"},
        )
        self.assertTrue(Category.objects.filter(name="Мясные продукты").exists())
        self.assertEqual({record(JUICE).resolution, record(SOAP).resolution}, {"changed", "product_removed"})

    def test_queued_run_is_cancelled(self):
        queued, _created = services.request_run(trigger="manual")
        result = services.cancel_pending()
        self.assertEqual(result["runs_cancelled"], [queued.pk])
        queued.refresh_from_db()
        self.assertEqual((queued.status, queued.error_code, queued.version), ("cancelled", "", 2))
        self.assertIsNotNone(queued.finished_at)

    def test_running_run_with_a_live_lease_refuses_and_a_lost_one_is_closed(self):
        now = timezone.now()
        running = ClassificationRun.objects.create(
            trigger="manual", scope="all", status="running", run_token=uuid.uuid4(), started_at=now,
            heartbeat_at=now, lease_expires_at=now + timedelta(seconds=60),
        )
        services.request_run(trigger="import", product_ids=[product(UNKNOWN).pk])
        error = self.assertRefused(services.ClassificationBusy, services.cancel_pending)
        self.assertEqual(error.code, "classification_busy")
        ClassificationRun.objects.filter(pk=running.pk).update(lease_expires_at=now - timedelta(seconds=1))
        result = services.cancel_pending()
        running.refresh_from_db()
        self.assertEqual((running.status, running.error_code), ("failed", "worker_lost"))
        self.assertEqual((len(result["cancelled"]), len(result["runs_cancelled"])), (9, 1))

    def test_command_prints_the_result(self):
        output = io.StringIO()
        call_command("product_classifications", "cancel-pending", stdout=output)
        result = json.loads(output.getvalue())
        self.assertEqual((len(result["cancelled"]), result["removed_generics"], result["removed_categories"]), (9, 6, 4))
        self.assertEqual(snapshot(*CATALOG_MODELS), self.original)


@tag("integration")
class ReadTests(SuggestedTestCase):
    def test_get_record(self):
        entry = record(MILK)
        with self.assertNumQueries(1):
            found = services.get_record(entry.pk)
            self.assertEqual((found, found.run.trigger), (entry, "command"))
        for missing in (10**9, 0, "x", None):
            with self.subTest(missing=missing), self.assertRaises(services.ClassificationNotFound):
                services.get_record(missing)

    def test_default_order_keeps_groups_together(self):
        rows = list(services.records().values_list("suggested_generic_name", "pk"))
        self.assertEqual(len(rows), 9)
        # Seven groups, each in one piece (six changes of the name), record ids ascending inside a group.
        names = [name for name, _pk in rows]
        self.assertEqual(len([index for index in range(1, 9) if names[index] != names[index - 1]]), 6)
        for index in range(1, 9):
            if names[index] == names[index - 1]:
                self.assertLess(rows[index - 1][1], rows[index][1])
        newest = list(services.records(ordering="-id").values_list("pk", flat=True))
        self.assertEqual(newest, sorted(newest, reverse=True))

    def test_filters(self):
        services.reject(record(MILK).pk, version=1)
        services.confirm(record(JUICE).pk, version=1, generic_id=generic("Сок").pk)
        ClassificationRejection.objects.all().delete()  # otherwise «Молоко» is not offered to the product again
        second = suggest()
        counts = {status: services.records(status=status).count() for status in (
            "pending", "confirmed", "rejected", "superseded")}
        self.assertEqual(counts, {"pending": 8, "confirmed": 1, "rejected": 1, "superseded": 0})
        self.assertEqual(services.records().count(), 10)
        self.assertEqual(
            [entry.status for entry in services.records(product=product(MILK).pk, ordering="-id")],
            ["pending", "rejected"],
        )
        self.assertEqual(services.records(product=10**9).count(), 0)
        self.assertEqual(
            {entry.product_name for entry in services.records(generic=generic("Кефир").pk)}, {KEFIR_A, KEFIR_B},
        )
        self.assertEqual([entry.product_name for entry in services.records(run=second.pk)], [MILK])
        self.assertEqual(services.records(run=second.pk, status="rejected").count(), 0)
        # A record that moved to a merge survivor is found by both products.
        ProductClassification.objects.filter(pk=record(CHEESE).pk).update(origin_product_ref=777)
        self.assertEqual([entry.product_name for entry in services.records(product=777)], [CHEESE])

    def test_describe_pending_records(self):
        infos = {info.record.product_name: info for info in services.describe(services.records())}
        sausage = infos[SAUSAGE_A]
        self.assertEqual((sausage.product, sausage.product_generic), (product(SAUSAGE_A), generic("Колбаса")))
        self.assertEqual([alias.raw_name for alias in sausage.aliases], ["Demo Mettw. fein", "Demo Mettwurst fein"])
        self.assertEqual({alias.merchant.brand_name for alias in sausage.aliases}, {"Kategoriemarkt"})
        self.assertEqual((sausage.suggested_generic, sausage.generic_is_new), (generic("Колбаса"), True))
        self.assertEqual([(name, is_new) for _pk, name, is_new in sausage.category_path], [
            ("Продукты питания", False), ("Мясные продукты", True)])
        self.assertEqual(
            [pk for pk, _name, _new in sausage.category_path],
            [Category.objects.get(name=name).pk for name in ("Продукты питания", "Мясные продукты")],
        )
        self.assertEqual((sausage.pending_count, sausage.can_act, sausage.merge_group_id), (2, True, None))
        milk = infos[MILK]
        self.assertEqual((milk.generic_is_new, milk.pending_count), (False, 1))
        self.assertEqual([is_new for _pk, _name, is_new in milk.category_path], [False, False])
        self.assertEqual({info.pending_count for name, info in infos.items() if name in (KEFIR_A, KEFIR_B)}, {2})

    def test_describe_follows_decisions(self):
        services.confirm(record(SAUSAGE_A).pk, version=1, generic_id=generic("Колбаса").pk)
        services.reject(record(JUICE).pk, version=1)
        infos = {info.record.product_name: info for info in services.describe(services.records())}
        confirmed, waiting, rejected = infos[SAUSAGE_A], infos[SAUSAGE_B], infos[JUICE]
        # Accepted: no longer "new" for anybody; the count is of pending records only.
        self.assertEqual((confirmed.generic_is_new, confirmed.pending_count, confirmed.can_act), (False, 1, False))
        self.assertEqual((waiting.generic_is_new, waiting.pending_count, waiting.can_act), (False, 1, True))
        self.assertEqual([is_new for _pk, _name, is_new in waiting.category_path], [False, False])
        # The rejected suggestion was removed: the snapshot is shown, nothing is "new".
        self.assertEqual((rejected.suggested_generic, rejected.generic_is_new, rejected.pending_count), (None, False, 0))
        self.assertEqual([(name, is_new) for _pk, name, is_new in rejected.category_path], [("Напитки", False)])
        self.assertEqual((rejected.product, rejected.product_generic, rejected.can_act), (
            product(JUICE), service(), False))

    def test_describe_deleted_product_changed_value_and_pending_merge(self):
        Product.objects.filter(name=CHEESE).update(generic=generic("Молоко"))
        product(SOAP).delete()
        # A duplicate with more facts survives; the product of the record is absorbed, still pending.
        twin = add_product(TOAST + ".", generic=generic("Молоко"), package_quantity=Decimal("500"), package_unit="g")
        merges.detect()
        group = ProductMerge.objects.get()
        self.assertEqual((group.target_ref, is_absorbed(product(TOAST).pk)), (twin.pk, True))
        infos = {info.record.product_name: info for info in services.describe(services.records())}
        self.assertEqual((infos[SOAP].product, infos[SOAP].product_generic, infos[SOAP].aliases), (None, None, []))
        self.assertEqual((infos[SOAP].can_act, infos[SOAP].record.status), (False, "pending"))
        self.assertEqual((infos[CHEESE].product_generic, infos[CHEESE].can_act), (generic("Молоко"), False))
        self.assertEqual((infos[TOAST].merge_group_id, infos[TOAST].can_act), (group.pk, True))
        self.assertIsNone(infos[MILK].merge_group_id)

    def test_aliases_are_limited_to_ten_in_name_order(self):
        target = product(MILK)
        merchant = ProductAlias.objects.filter(product=target).first().merchant
        for index in range(12):
            name = f"Demo Alias {index:02d}"
            ProductAlias.objects.create(merchant=merchant, product=target, name_key=name.casefold(), raw_name=name)
        info = services.describe([record(MILK)])[0]
        self.assertEqual([alias.raw_name for alias in info.aliases], [f"Demo Alias {index:02d}" for index in range(10)])

    def test_describe_takes_a_fixed_number_of_queries(self):
        services.reject(record(JUICE).pk, version=1)
        product(SOAP).delete()
        for size in (1, 3, 9):
            page = list(services.records()[:size])
            with self.subTest(size=size), self.assertNumQueries(7):
                infos = services.describe(page)
                # Everything a serializer needs is loaded: no query per record.
                for info in infos:
                    _ = (info.record.run and info.record.run.trigger, info.product and info.product.brand,
                         info.product_generic, [alias.merchant.brand_name for alias in info.aliases],
                         info.suggested_generic, info.category_path, info.merge_group_id)
            self.assertEqual(len(infos), size)
        with self.assertNumQueries(1):  # empty lookups are not sent; only the category tree is read
            self.assertEqual(services.describe([]), [])
