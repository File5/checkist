"""Suggestions and duplicate merges: the step after a merge confirmation (``after_merge_confirmed``).

``HumanValueTests`` — no path of the mechanism undoes a value the product had
before the suggestion or got from a human. ``SurvivorRecordTests`` — the same
for the pending record of the survivor itself, by the kind of absorbed duplicate.
"""
from unittest.mock import patch

from django.test import TestCase, tag

from catalog.models import GenericProduct, Product
from classification import demo, services
from classification.models import (
    ClassificationRejection, CreatedGenericProduct, ProductClassification,
)
from classification.tests.factories import (
    CLASSIFICATION_MODELS, KEFIR_A, MILK, add_product, apply, existing, generic, generic_of, new, product, record,
    service, snapshot, states, suggest,
)
from merges import services as merges
from merges.models import ProductMerge
from merges.visibility import is_absorbed

DAIRY = ("Продукты питания", "Молочные продукты")
TWIN = KEFIR_A + "."
THIRD = TWIN + "."
NOTHING_CANCELLED = {
    "cancelled": [], "superseded": [], "runs_cancelled": [], "removed_generics": 0, "removed_categories": 0,
}


def generics():
    """``{product id: generic product id}`` of the whole catalog."""
    return dict(Product.objects.values_list("pk", "generic_id"))


@tag("integration")
class MergeStepTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def setUp(self):
        self.original = product(KEFIR_A)

    def group(self):
        merges.detect()
        return ProductMerge.objects.get(status="pending")

    def confirm(self, target, **options):
        group = self.group()
        return merges.confirm(group.pk, version=group.version, target_product_id=target.pk, **options)

    def test_record_moves_to_the_surviving_product(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        entry = record(KEFIR_A)
        twin = add_product(TWIN)
        self.assertEqual(self.confirm(twin).status, "confirmed")
        self.assertFalse(Product.objects.filter(pk=self.original.pk).exists())
        # The empty fact of the survivor was completed with the unconfirmed suggestion...
        self.assertEqual(generic_of(TWIN), "Кефир")
        # ...so the mark "needs confirmation" follows it.
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.resolution, entry.version), ("pending", "", 2))
        self.assertEqual((entry.product_ref, entry.active_product_id, entry.origin_product_ref), (
            twin.pk, twin.pk, self.original.pk))
        self.assertEqual(entry.product_name, TWIN)
        self.assertEqual(entry.product_facts, {"brand": None, "package": {"quantity": "500.000", "unit": "g"}})
        self.assertEqual((entry.suggested_generic_name, entry.final_generic_ref), ("Кефир", None))
        self.assertEqual(
            (entry.previous_generic_ref, entry.previous_generic_name, entry.previous_generic_base_unit),
            (service().pk, "Не разобрано", "pcs"),
        )
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "provisional"})
        # It is found by both products and acts on the survivor.
        for ref in (twin.pk, self.original.pk):
            self.assertEqual(list(services.records(product=ref)), [entry])
        info = services.describe([entry])[0]
        self.assertEqual((info.product, info.can_act, info.pending_count), (twin, True, 1))
        with self.assertRaises(services.ClassificationChanged):
            services.confirm(entry.pk, version=1, generic_id=entry.suggested_generic_ref)
        rejected = services.reject(entry.pk, version=2)
        self.assertEqual((rejected.status, generic_of(TWIN)), ("rejected", "Не разобрано"))
        self.assertFalse(GenericProduct.objects.filter(name="Кефир").exists())

    def test_record_moves_again_with_the_next_merge_and_keeps_its_origin(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        entry = record(KEFIR_A)
        twin = add_product(TWIN)
        self.confirm(twin)
        third = add_product(TWIN + ".")
        self.confirm(third)
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.version, entry.product_ref, entry.origin_product_ref), (
            "pending", 3, third.pk, self.original.pk))
        self.assertEqual(entry.active_product_id, third.pk)

    def test_survivor_with_its_own_pending_record_closes_the_other_as_merged(self):
        twin = add_product(TWIN)
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"), new(twin, "кефир"))
        own, other = record(KEFIR_A), record(TWIN)
        self.confirm(self.original)
        own.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual((own.status, own.version, own.active_product_id), ("pending", 1, self.original.pk))
        self.assertEqual((other.status, other.resolution, other.version), ("superseded", "merged", 2))
        self.assertEqual((other.final_generic_ref, other.final_generic_name, other.final_base_unit), (
            generic("Кефир").pk, "Кефир", "l"))
        self.assertEqual((other.active_product_id, other.product_ref, other.origin_product_ref), (None, twin.pk, None))
        # The generic product is still awaited by the survivor's record.
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "provisional"})
        self.assertEqual(services.describe([own])[0].pending_count, 1)
        # The survivor got «Кефир» from its own suggestion: undoing it returns its own previous value.
        self.assertEqual(services.cancel_pending()["cancelled"], [own.pk])
        self.assertEqual(generic_of(KEFIR_A), "Не разобрано")
        self.assertFalse(GenericProduct.objects.filter(name="Кефир").exists())

    def test_generic_conflict_is_the_ordinary_merge_conflict(self):
        twin = add_product(TWIN)
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"), new(twin, "Йогурт", DAIRY, "kg"))
        group = self.group()
        before = snapshot()
        with self.assertRaises(merges.MergeConflict) as caught:
            merges.confirm(group.pk, version=group.version, target_product_id=self.original.pk)
        self.assertEqual(caught.exception.fields, {"generic": sorted([self.original.pk, twin.pk])})
        self.assertEqual(snapshot(), before)
        self.assertEqual(ProductMerge.objects.get().status, "pending")
        # The human keeps the survivor's value: the other suggestion is closed and its generic product removed.
        merges.confirm(
            group.pk, version=group.version, target_product_id=self.original.pk,
            resolutions={"generic": self.original.pk},
        )
        own, other = record(KEFIR_A), record(TWIN)
        self.assertEqual((own.status, own.version, generic_of(KEFIR_A)), ("pending", 1, "Кефир"))
        self.assertEqual((other.status, other.resolution, other.final_generic_name), ("superseded", "merged", "Кефир"))
        self.assertFalse(GenericProduct.objects.filter(name="Йогурт").exists())
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "provisional", "Йогурт": "removed"})

    def test_human_choice_of_the_absorbed_value_supersedes_both_records(self):
        twin = add_product(TWIN)
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"), new(twin, "Йогурт", DAIRY, "kg"))
        self.confirm(self.original, resolutions={"generic": twin.pk})
        self.assertEqual(generic_of(KEFIR_A), "Йогурт")
        own, other = record(KEFIR_A), record(TWIN)
        # The absorbed record: the survivor has its value, but also a pending record of its own.
        self.assertEqual((other.status, other.resolution, other.final_generic_name), ("superseded", "merged", "Йогурт"))
        # The survivor's record: its value was changed by the human's decision.
        self.assertEqual((own.status, own.resolution, own.final_generic_name), ("superseded", "changed", "Йогурт"))
        self.assertIsNone(own.active_product_id)
        # The chosen value is a decision of a human now; the refused one is removed.
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "removed", "Йогурт": "kept"})
        self.assertFalse(ProductClassification.objects.filter(status="pending").exists())

    def test_survivor_with_its_own_meaningful_value_closes_the_record(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        twin = add_product(TWIN, generic=generic("Молоко"))
        self.confirm(twin, resolutions={"generic": twin.pk})
        entry = record(KEFIR_A)
        self.assertEqual((entry.status, entry.resolution, entry.version), ("superseded", "merged", 2))
        self.assertEqual((entry.final_generic_name, entry.product_ref, entry.active_product_id), (
            "Молоко", self.original.pk, None))
        self.assertEqual(generic_of(TWIN), "Молоко")
        self.assertFalse(GenericProduct.objects.filter(name="Кефир").exists())

    def test_pending_merge_cancel_and_exclude_change_nothing(self):
        suggest()
        twin = add_product(TWIN)
        third = add_product(TWIN + ".")
        before = snapshot(*CLASSIFICATION_MODELS)
        generics = dict(Product.objects.values_list("pk", "generic_id"))
        group = self.group()
        self.assertEqual(group.members.count(), 3)
        self.assertTrue(is_absorbed(twin.pk) and is_absorbed(third.pk))
        # Absorbed products wait for the merge: no new suggestions for them.
        self.assertEqual(services.candidates(product_ids=[twin.pk, third.pk]).count(), 0)
        self.assertEqual(snapshot(*CLASSIFICATION_MODELS), before)
        merges.exclude(group.pk, version=group.version, product_id=third.pk)
        self.assertEqual(snapshot(*CLASSIFICATION_MODELS), before)
        merges.cancel(group.pk)
        self.assertEqual(snapshot(*CLASSIFICATION_MODELS), before)
        self.assertEqual(dict(Product.objects.values_list("pk", "generic_id")), generics)
        self.assertEqual(services.candidates(product_ids=[twin.pk, third.pk]).count(), 2)

    def test_record_of_a_product_absorbed_by_a_pending_merge_can_be_decided(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        # More filled facts make the duplicate the default survivor.
        twin = add_product(TWIN, generic=generic("Молоко"), gtin="20000004", model="M1")
        group = self.group()
        self.assertEqual((group.target_ref, is_absorbed(self.original.pk)), (twin.pk, True))
        entry = record(KEFIR_A)
        self.assertEqual(services.describe([entry])[0].merge_group_id, group.pk)
        services.confirm(entry.pk, version=1, generic_id=generic("Молоко").pk)
        # The merge reads the facts again: the conflict is gone.
        self.assertEqual(merges.describe_group(ProductMerge.objects.get()).conflicts, [])
        self.assertEqual(self.confirm(twin).status, "confirmed")
        self.assertEqual(record(KEFIR_A).resolution, "other")

    def test_merge_without_suggestions_leaves_the_tables_alone(self):
        twin = add_product(TWIN)
        before = snapshot(*CLASSIFICATION_MODELS)
        with self.assertNoLogs("merges.services", level="ERROR"):
            self.confirm(self.original)
        self.assertEqual(snapshot(*CLASSIFICATION_MODELS), before)
        self.assertFalse(Product.objects.filter(pk=twin.pk).exists())

    def test_rejection_memory_of_the_absorbed_product_goes_with_it(self):
        twin = add_product(TWIN)
        apply(new(KEFIR_A, "Сыр", DAIRY, "kg"), existing(twin, generic("Молоко")))
        services.reject(record(KEFIR_A).pk, version=1)
        services.reject(record(TWIN).pk, version=1)
        self.assertEqual(ClassificationRejection.objects.count(), 2)
        self.confirm(self.original)
        self.assertEqual(
            list(ClassificationRejection.objects.values_list("product__name", "generic_name")), [(KEFIR_A, "Сыр")],
        )

    def test_failed_step_does_not_cancel_the_merge(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        entry = record(KEFIR_A)
        twin = add_product(TWIN)

        def broken(**arguments):
            # A partial write of the step must not survive either.
            ProductClassification.objects.filter(pk=entry.pk).update(product_name="half written")
            raise RuntimeError("secret detail")

        with patch.object(services, "after_merge_confirmed", side_effect=broken) as step, \
                self.assertLogs("merges.services", level="ERROR") as logs:
            confirmed = self.confirm(twin)
        step.assert_called_once_with(
            target_id=twin.pk, absorbed_ids=[self.original.pk], target_generic_before=service().pk,
        )
        # Only the error class is logged.
        self.assertEqual(logs.output, [
            "ERROR:merges.services:Classification step after merge confirmation failed: RuntimeError",
        ])
        self.assertEqual((confirmed.status, generic_of(TWIN)), ("confirmed", "Кефир"))
        self.assertFalse(Product.objects.filter(pk=self.original.pk).exists())
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.active_product_id, entry.product_name, entry.version), (
            "pending", None, KEFIR_A, 1))
        # The safety net never moves the record: without the step nobody knows what the survivor had
        # before the merge. The record is closed, the survivor keeps the value without the mark.
        info = services.describe([entry])[0]
        self.assertEqual((info.product, info.can_act), (None, False))
        before = generics()
        self.assertEqual(services.reconcile(), 1)
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.resolution, entry.version), ("superseded", "merged", 2))
        self.assertEqual((entry.product_ref, entry.active_product_id, entry.origin_product_ref), (
            self.original.pk, None, None))
        self.assertEqual((entry.final_generic_ref, entry.final_generic_name), (generic("Кефир").pk, "Кефир"))
        # The created generic product is used by a product without a pending record: it stays.
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "kept"})
        self.assertEqual(services.cancel_pending(), NOTHING_CANCELLED)
        self.assertEqual((generics(), generic_of(TWIN)), (before, "Кефир"))

    def test_reconciliation_closes_a_record_whose_survivor_got_another_value(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"), existing(MILK, generic("Молоко")))
        entry = record(KEFIR_A)
        twin = add_product(TWIN, generic=generic("Молоко"))
        with patch.object(services, "after_merge_confirmed"):
            self.confirm(twin, resolutions={"generic": twin.pk})
        error = None
        try:
            services.confirm(entry.pk, version=1, generic_id=entry.suggested_generic_ref)
        except services.ClassificationResolved as caught:
            error = caught
        self.assertIsNotNone(error)
        self.assertEqual((error.record.status, error.record.resolution, error.record.final_generic_name), (
            "superseded", "merged", "Молоко"))
        self.assertFalse(GenericProduct.objects.filter(name="Кефир").exists())
        self.assertEqual(record(MILK).status, "pending")

    def test_step_called_directly_is_idempotent(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        twin = add_product(TWIN)
        self.confirm(twin)
        before = snapshot()
        services.after_merge_confirmed(
            target_id=twin.pk, absorbed_ids=[self.original.pk], target_generic_before=service().pk,
        )
        services.after_merge_confirmed(target_id=10**9, absorbed_ids=[], target_generic_before=service().pk)
        self.assertEqual(snapshot(), before)


class HumanValueCase(TestCase):
    """Helpers of the tests about the values of a human."""

    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def setUp(self):
        self.original = product(KEFIR_A)
        self.milk = generic("Молоко")

    def confirm(self, target, **options):
        merges.detect()
        group = ProductMerge.objects.get(status="pending")
        return merges.confirm(group.pk, version=group.version, target_product_id=target.pk, **options)

    def assertClosed(self, entry, final, resolution="merged"):
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.resolution, entry.final_generic_name), ("superseded", resolution, final))
        self.assertIsNone(entry.active_product_id)

    def assertNothingToUndo(self, entry, name, value):
        """Neither the command nor a decision on the closed record changes a product."""
        before = generics()
        self.assertEqual(services.cancel_pending(), NOTHING_CANCELLED)
        with self.assertRaises(services.ClassificationResolved):
            services.reject(entry.pk, version=entry.version)
        with self.assertRaises(services.ClassificationResolved):
            services.confirm(entry.pk, version=entry.version, generic_id=self.milk.pk)
        with self.assertRaises(services.ClassificationResolved):
            services.confirm_many([(entry.pk, entry.version)])
        self.assertEqual(services.reconcile(), 0)
        self.assertEqual((generics(), generic_of(name)), (before, value))
        self.assertFalse(ProductClassification.objects.filter(status="pending").exists())
        self.assertFalse(ClassificationRejection.objects.exists())


@tag("integration")
class HumanValueTests(HumanValueCase):
    """A value the product had before the suggestion, or got from a human, survives every undo."""

    # --- The review scenario: the survivor had the suggested value before the merge ---------------

    def review_scenario(self):
        apply(existing(KEFIR_A, self.milk))
        return record(KEFIR_A), add_product(TWIN, generic=self.milk)

    def test_survivor_that_already_had_the_suggested_value_is_not_marked(self):
        entry, twin = self.review_scenario()
        self.confirm(twin)
        self.assertClosed(entry, "Молоко")
        self.assertEqual((entry.product_ref, entry.origin_product_ref, entry.version), (self.original.pk, None, 2))
        self.assertEqual((entry.previous_generic_name, entry.final_generic_ref), ("Не разобрано", self.milk.pk))
        info = services.describe([entry])[0]
        self.assertEqual((info.product, info.can_act), (None, False))
        self.assertEqual(list(services.records(product=twin.pk)), [])
        self.assertNothingToUndo(entry, TWIN, "Молоко")

    def test_cancel_pending_after_the_merge_keeps_the_value_of_the_survivor(self):
        entry, twin = self.review_scenario()
        self.confirm(twin)
        self.assertEqual(services.cancel_pending(), NOTHING_CANCELLED)
        self.assertEqual(generic_of(TWIN), "Молоко")
        self.assertClosed(entry, "Молоко")

    def test_reject_after_the_merge_keeps_the_value_of_the_survivor(self):
        entry, twin = self.review_scenario()
        self.confirm(twin)
        for version in (1, 2):
            with self.subTest(version=version), self.assertRaises(services.ClassificationResolved):
                services.reject(entry.pk, version=version)
        self.assertEqual(generic_of(TWIN), "Молоко")

    def test_reconciliation_without_the_step_closes_the_record(self):
        entry, twin = self.review_scenario()
        with patch.object(services, "after_merge_confirmed"):
            self.confirm(twin)
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.active_product_id, entry.version), ("pending", None, 1))
        self.assertEqual(services.reconcile(), 1)
        self.assertClosed(entry, "Молоко")
        self.assertEqual((entry.product_ref, entry.origin_product_ref, entry.version), (self.original.pk, None, 2))
        self.assertNothingToUndo(entry, TWIN, "Молоко")

    def test_cancel_pending_without_the_step_keeps_the_value_of_the_survivor(self):
        entry, twin = self.review_scenario()
        with patch.object(services, "after_merge_confirmed") as step:
            self.confirm(twin)
        # The merge tells the step what the survivor had before its facts were completed.
        step.assert_called_once_with(
            target_id=twin.pk, absorbed_ids=[self.original.pk], target_generic_before=self.milk.pk,
        )
        self.assertEqual(services.cancel_pending(), {**NOTHING_CANCELLED, "superseded": [entry.pk]})
        self.assertEqual(generic_of(TWIN), "Молоко")
        self.assertClosed(entry, "Молоко")

    def test_reject_without_the_step_keeps_the_value_of_the_survivor(self):
        entry, twin = self.review_scenario()
        with patch.object(services, "after_merge_confirmed"):
            self.confirm(twin)
        with self.assertRaises(services.ClassificationResolved) as caught:
            services.reject(entry.pk, version=1)
        self.assertEqual((caught.exception.record.status, caught.exception.record.resolution), ("superseded", "merged"))
        self.assertEqual(generic_of(TWIN), "Молоко")
        self.assertFalse(ClassificationRejection.objects.exists())

    def test_choosing_another_without_the_step_keeps_the_value_of_the_survivor(self):
        entry, twin = self.review_scenario()
        other = GenericProduct.objects.create(name="Сливки", category=self.milk.category, base_unit="l")
        with patch.object(services, "after_merge_confirmed"):
            self.confirm(twin)
        for call in (
            lambda: services.confirm(entry.pk, version=1, generic_id=other.pk),
            lambda: services.confirm_many([(entry.pk, 1)]),
        ):
            with self.assertRaises(services.ClassificationResolved):
                call()
        self.assertEqual(generic_of(TWIN), "Молоко")

    # --- The survivor had a value of its own, the human resolved the conflict ---------------------

    def test_survivor_given_the_suggested_value_by_the_human_keeps_it(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        entry = record(KEFIR_A)
        twin = add_product(TWIN, generic=self.milk)
        self.confirm(twin, resolutions={"generic": self.original.pk})
        self.assertEqual(generic_of(TWIN), "Кефир")
        # The survivor was «Молоко» before the merge: «Не разобрано» is not its previous value.
        self.assertClosed(entry, "Кефир")
        # The created generic product is used by a product without a pending record: it is not removed.
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "kept"})
        self.assertNothingToUndo(entry, TWIN, "Кефир")
        self.assertTrue(GenericProduct.objects.filter(name="Кефир").exists())

    def test_survivor_that_keeps_its_own_value_in_a_conflict(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        entry = record(KEFIR_A)
        twin = add_product(TWIN, generic=self.milk)
        self.confirm(twin, resolutions={"generic": twin.pk})
        self.assertClosed(entry, "Молоко")
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "removed"})
        self.assertNothingToUndo(entry, TWIN, "Молоко")

    def test_empty_survivor_given_the_value_of_a_human_in_a_conflict(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        entry = record(KEFIR_A)
        twin = add_product(TWIN)
        third = add_product(THIRD, generic=self.milk)
        self.confirm(twin, resolutions={"generic": third.pk})
        self.assertClosed(entry, "Молоко")
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "removed"})
        self.assertNothingToUndo(entry, TWIN, "Молоко")

    def test_empty_survivor_given_the_suggestion_in_a_conflict_returns_to_its_own_previous_value(self):
        """К1 §5.1: the human chose the unconfirmed suggestion; the mark stays, a rejection empties the fact again."""
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        entry = record(KEFIR_A)
        twin = add_product(TWIN)
        third = add_product(THIRD, generic=self.milk)
        self.confirm(twin, resolutions={"generic": self.original.pk})
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.product_ref, entry.origin_product_ref), (
            "pending", twin.pk, self.original.pk))
        self.assertEqual((generic_of(TWIN), entry.previous_generic_ref), ("Кефир", service().pk))
        self.assertFalse(Product.objects.filter(pk=third.pk).exists())
        self.assertEqual(services.cancel_pending()["cancelled"], [entry.pk])
        self.assertEqual(generic_of(TWIN), "Не разобрано")

    # --- Another absorbed duplicate had the same value from a human -------------------------------

    def test_value_shared_with_an_absorbed_duplicate_of_a_human_is_not_a_suggestion(self):
        apply(existing(KEFIR_A, self.milk))
        entry = record(KEFIR_A)
        twin = add_product(TWIN)
        add_product(THIRD, generic=self.milk)
        self.confirm(twin)
        # Without the suggestion the merge would have given the survivor «Молоко» all the same.
        self.assertEqual(generic_of(TWIN), "Молоко")
        self.assertClosed(entry, "Молоко")
        self.assertNothingToUndo(entry, TWIN, "Молоко")

    def test_value_shared_with_an_absorbed_duplicate_confirmed_by_a_human_is_not_a_suggestion(self):
        third = add_product(THIRD)
        apply(existing(KEFIR_A, self.milk), existing(third, self.milk))
        entry, confirmed = record(KEFIR_A), record(THIRD)
        services.confirm(confirmed.pk, version=1, generic_id=self.milk.pk)
        twin = add_product(TWIN)
        self.confirm(twin)
        self.assertClosed(entry, "Молоко")
        self.assertNothingToUndo(entry, TWIN, "Молоко")

    def test_value_shared_by_two_pending_suggestions_is_a_suggestion(self):
        third = add_product(THIRD)
        apply(existing(KEFIR_A, self.milk), existing(third, self.milk))
        first, second = record(KEFIR_A), record(THIRD)
        twin = add_product(TWIN)
        self.confirm(twin)
        first.refresh_from_db()
        self.assertEqual((first.status, first.product_ref, first.origin_product_ref), (
            "pending", twin.pk, self.original.pk))
        self.assertClosed(second, "Молоко")
        # Both values were unconfirmed suggestions: the survivor returns to its own «Не разобрано».
        self.assertEqual(services.cancel_pending()["cancelled"], [first.pk])
        self.assertEqual(generic_of(TWIN), "Не разобрано")

    def test_absorbed_product_changed_by_a_human_before_the_merge(self):
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        entry = record(KEFIR_A)
        Product.objects.filter(pk=self.original.pk).update(generic=self.milk)
        twin = add_product(TWIN)
        self.confirm(twin)
        self.assertEqual(generic_of(TWIN), "Молоко")
        self.assertClosed(entry, "Молоко")
        self.assertNothingToUndo(entry, TWIN, "Молоко")

    # --- A chain of two merges --------------------------------------------------------------------

    def moved(self):
        """The record moved to an empty survivor, as К1 §5.1 says."""
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"))
        twin = add_product(TWIN)
        self.confirm(twin)
        entry = record(TWIN)
        self.assertEqual((entry.status, entry.product_ref, entry.origin_product_ref), (
            "pending", twin.pk, self.original.pk))
        return entry, twin

    def test_second_merge_into_a_product_with_its_own_value(self):
        entry, twin = self.moved()
        third = add_product(THIRD, generic=generic("Кефир"))
        self.confirm(third)
        self.assertClosed(entry, "Кефир")
        self.assertEqual((entry.product_ref, entry.origin_product_ref), (twin.pk, self.original.pk))
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "kept"})
        self.assertNothingToUndo(entry, THIRD, "Кефир")

    def test_second_merge_into_an_empty_product_then_cancel_pending(self):
        entry, twin = self.moved()
        third = add_product(THIRD)
        self.confirm(third)
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.product_ref, entry.origin_product_ref), (
            "pending", third.pk, self.original.pk))
        self.assertEqual(services.cancel_pending(), {
            **NOTHING_CANCELLED, "cancelled": [entry.pk], "removed_generics": 1,
        })
        self.assertEqual(generic_of(THIRD), "Не разобрано")
        self.assertFalse(GenericProduct.objects.filter(name="Кефир").exists())

    def test_second_merge_without_the_step_into_a_product_with_its_own_value(self):
        entry, twin = self.moved()
        third = add_product(THIRD, generic=generic("Кефир"))
        with patch.object(services, "after_merge_confirmed"):
            self.confirm(third)
        self.assertEqual(services.cancel_pending(), {**NOTHING_CANCELLED, "superseded": [entry.pk]})
        self.assertClosed(entry, "Кефир")
        self.assertEqual(generic_of(THIRD), "Кефир")
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "kept"})

    # --- The record moved to an empty survivor ----------------------------------------------------

    def test_moved_record_cancelled_returns_the_survivor_to_its_own_previous_value(self):
        entry, twin = self.moved()
        self.assertEqual(services.cancel_pending(), {
            **NOTHING_CANCELLED, "cancelled": [entry.pk], "removed_generics": 1,
        })
        self.assertEqual(generic_of(TWIN), "Не разобрано")
        self.assertFalse(ClassificationRejection.objects.exists())

    def test_moved_record_and_another_generic_product_chosen_by_the_human(self):
        entry, twin = self.moved()
        chosen = services.confirm(entry.pk, version=entry.version, generic_id=self.milk.pk)
        self.assertEqual((chosen.status, chosen.resolution, generic_of(TWIN)), ("confirmed", "other", "Молоко"))
        self.assertFalse(GenericProduct.objects.filter(name="Кефир").exists())
        self.assertEqual(services.cancel_pending(), NOTHING_CANCELLED)
        self.assertEqual(generic_of(TWIN), "Молоко")

    def test_moved_record_confirmed_then_nothing_is_undone(self):
        entry, twin = self.moved()
        services.confirm(entry.pk, version=entry.version, generic_id=entry.suggested_generic_ref)
        self.assertEqual(services.cancel_pending(), NOTHING_CANCELLED)
        with self.assertRaises(services.ClassificationResolved):
            services.reject(entry.pk, version=entry.version + 1)
        self.assertEqual(generic_of(TWIN), "Кефир")

    def changed_by_human(self):
        """The survivor got the suggestion from the merge, then a human changed it in the admin."""
        entry, twin = self.moved()
        Product.objects.filter(pk=twin.pk).update(generic=self.milk)
        return entry

    def assertHumanValueKept(self, entry):
        self.assertClosed(entry, "Молоко", "changed")
        self.assertEqual(generic_of(TWIN), "Молоко")
        self.assertFalse(GenericProduct.objects.filter(name="Кефир").exists())

    def test_survivor_changed_in_the_admin_after_the_merge_and_cancel_pending(self):
        entry = self.changed_by_human()
        self.assertEqual(services.cancel_pending(), {
            **NOTHING_CANCELLED, "superseded": [entry.pk], "removed_generics": 1,
        })
        self.assertHumanValueKept(entry)

    def test_survivor_changed_in_the_admin_after_the_merge_and_reject(self):
        entry = self.changed_by_human()
        with self.assertRaises(services.ClassificationResolved):
            services.reject(entry.pk, version=entry.version)
        self.assertHumanValueKept(entry)
        self.assertFalse(ClassificationRejection.objects.exists())

    def test_survivor_changed_in_the_admin_after_the_merge_and_reconcile(self):
        entry = self.changed_by_human()
        self.assertEqual(services.reconcile(), 1)
        self.assertHumanValueKept(entry)

    # --- The merge was cancelled, not confirmed ---------------------------------------------------

    def test_cancelled_merge_leaves_both_values(self):
        entry, twin = self.review_scenario()
        merges.detect()
        group = ProductMerge.objects.get(status="pending")
        before = generics()
        merges.cancel(group.pk)
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.active_product_id, entry.version), ("pending", self.original.pk, 1))
        self.assertEqual(generics(), before)
        # The suggestion is undone for its own product only.
        self.assertEqual(services.cancel_pending()["cancelled"], [entry.pk])
        self.assertEqual((generic_of(KEFIR_A), generic_of(TWIN)), ("Не разобрано", "Молоко"))

    def test_record_decided_while_the_merge_is_pending_touches_its_own_product_only(self):
        entry, twin = self.review_scenario()
        merges.detect()
        services.reject(entry.pk, version=1)
        self.assertEqual((generic_of(KEFIR_A), generic_of(TWIN)), ("Не разобрано", "Молоко"))
        group = ProductMerge.objects.get(status="pending")
        merges.confirm(group.pk, version=group.version, target_product_id=twin.pk)
        self.assertEqual(services.cancel_pending(), NOTHING_CANCELLED)
        self.assertEqual(generic_of(TWIN), "Молоко")

    # --- The step itself --------------------------------------------------------------------------

    def step(self, before):
        """Same catalog after the merge, different history: only the value before the merge tells them apart."""
        entry, twin = self.review_scenario()
        Product.objects.filter(pk=self.original.pk).delete()
        services.after_merge_confirmed(
            target_id=twin.pk, absorbed_ids=[self.original.pk], target_generic_before=before.pk,
        )
        entry.refresh_from_db()
        self.assertEqual(generic_of(TWIN), "Молоко")
        return entry, twin

    def test_step_moves_the_record_to_a_survivor_that_was_empty(self):
        entry, twin = self.step(service())
        self.assertEqual((entry.status, entry.active_product_id, entry.origin_product_ref), (
            "pending", twin.pk, self.original.pk))

    def test_step_closes_the_record_of_a_survivor_that_had_the_value(self):
        entry, twin = self.step(self.milk)
        self.assertEqual((entry.status, entry.active_product_id, entry.origin_product_ref), ("superseded", None, None))

    def test_step_with_an_unknown_previous_value_closes_the_record(self):
        entry, twin = self.review_scenario()
        Product.objects.filter(pk=self.original.pk).delete()
        services.after_merge_confirmed(target_id=twin.pk, absorbed_ids=[self.original.pk], target_generic_before=None)
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.resolution), ("superseded", "product_removed"))
        self.assertEqual(generic_of(TWIN), "Молоко")


@tag("integration")
class SurvivorRecordTests(HumanValueCase):
    """The survivor has a pending record of its own; the absorbed duplicates differ.

    A duplicate that had the suggested value from a human settles the record:
    without the suggestion the merge would have given the survivor that value.
    """

    def suggested(self, *others):
        """«Кефир», created by the mechanism, is suggested to the survivor and to ``others``."""
        apply(new(KEFIR_A, "Кефир", DAIRY, "l"), *(new(other, "кефир") for other in others))
        return record(KEFIR_A)

    def human(self, name):
        """A duplicate a human put into the suggested generic product."""
        return add_product(name, generic=generic("Кефир"))

    def assertPending(self, entry, target=None):
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.active_product_id), ("pending", (target or self.original).pk))

    def assertSuggestionUndone(self, entry, name=KEFIR_A):
        """Nobody but the mechanism gave the product the value: undoing returns its own «Не разобрано»."""
        self.assertEqual(services.cancel_pending(), {
            **NOTHING_CANCELLED, "cancelled": [entry.pk], "removed_generics": 1,
        })
        self.assertEqual(generic_of(name), "Не разобрано")
        self.assertFalse(GenericProduct.objects.filter(name="Кефир").exists())

    # --- One absorbed duplicate -------------------------------------------------------------------

    def test_duplicate_with_the_same_value_of_a_human_settles_the_record(self):
        entry = self.suggested()
        twin = self.human(TWIN)
        self.confirm(self.original)
        self.assertFalse(Product.objects.filter(pk=twin.pk).exists())
        self.assertClosed(entry, "Кефир")
        self.assertEqual((entry.version, entry.product_ref, entry.origin_product_ref), (2, self.original.pk, None))
        self.assertEqual((entry.final_generic_ref, entry.final_base_unit), (generic("Кефир").pk, "l"))
        self.assertEqual(entry.previous_generic_name, "Не разобрано")
        # The value is a human's now: the created generic product becomes an ordinary one.
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "kept"})
        # The product is still there, but nothing is left to decide.
        info = services.describe([entry])[0]
        self.assertEqual((info.product, info.can_act), (self.original, False))
        self.assertNothingToUndo(entry, KEFIR_A, "Кефир")
        self.assertTrue(GenericProduct.objects.filter(name="Кефир").exists())

    def test_reject_after_a_duplicate_of_a_human_keeps_the_value(self):
        entry = self.suggested()
        self.human(TWIN)
        self.confirm(self.original)
        for version in (1, 2):
            with self.subTest(version=version), self.assertRaises(services.ClassificationResolved):
                services.reject(entry.pk, version=version)
        self.assertEqual(generic_of(KEFIR_A), "Кефир")
        self.assertFalse(ClassificationRejection.objects.exists())

    def test_duplicate_with_an_existing_value_of_a_human_settles_the_record(self):
        apply(existing(KEFIR_A, self.milk))
        entry = record(KEFIR_A)
        add_product(TWIN, generic=self.milk)
        self.confirm(self.original)
        self.assertClosed(entry, "Молоко")
        self.assertNothingToUndo(entry, KEFIR_A, "Молоко")

    def test_duplicate_without_a_value_leaves_the_record_pending(self):
        entry = self.suggested()
        add_product(TWIN)
        self.confirm(self.original)
        self.assertPending(entry)
        self.assertEqual((entry.version, generic_of(KEFIR_A)), (1, "Кефир"))
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "provisional"})
        self.assertSuggestionUndone(entry)

    def test_duplicate_without_a_value_and_reject(self):
        entry = self.suggested()
        add_product(TWIN)
        self.confirm(self.original)
        rejected = services.reject(entry.pk, version=1)
        self.assertEqual((rejected.status, rejected.resolution, generic_of(KEFIR_A)), (
            "rejected", "rejected", "Не разобрано"))

    def test_duplicate_with_the_same_pending_suggestion_leaves_the_record_pending(self):
        twin = add_product(TWIN)
        entry = self.suggested(twin)
        other = record(TWIN)
        self.confirm(self.original)
        self.assertClosed(other, "Кефир")
        self.assertPending(entry)
        # Both values were unconfirmed suggestions.
        self.assertSuggestionUndone(entry)

    def test_duplicate_with_a_confirmed_record_on_the_same_value_settles_the_record(self):
        twin = add_product(TWIN)
        entry = self.suggested(twin)
        confirmed = record(TWIN)
        services.confirm(confirmed.pk, version=1, generic_id=confirmed.suggested_generic_ref)
        self.confirm(self.original)
        self.assertClosed(entry, "Кефир")
        confirmed.refresh_from_db()
        self.assertEqual((confirmed.status, confirmed.resolution), ("confirmed", "confirmed"))
        self.assertNothingToUndo(entry, KEFIR_A, "Кефир")

    def test_duplicate_given_the_same_value_by_choosing_another_settles_the_record(self):
        twin = add_product(TWIN)
        apply(existing(KEFIR_A, self.milk), new(twin, "Сыр", DAIRY, "kg"))
        entry, chosen = record(KEFIR_A), record(TWIN)
        services.confirm(chosen.pk, version=1, generic_id=self.milk.pk)
        self.confirm(self.original)
        self.assertClosed(entry, "Молоко")
        self.assertEqual(services.cancel_pending(), NOTHING_CANCELLED)
        self.assertEqual(generic_of(KEFIR_A), "Молоко")

    def test_duplicate_whose_suggestion_a_human_replaced_with_the_same_value_settles_the_record(self):
        """The duplicate has a pending record on another value; in the admin it got the survivor's one."""
        twin = add_product(TWIN)
        apply(existing(KEFIR_A, self.milk), new(twin, "Сыр", DAIRY, "kg"))
        entry, stale = record(KEFIR_A), record(TWIN)
        Product.objects.filter(pk=twin.pk).update(generic=self.milk)
        self.confirm(self.original)
        self.assertClosed(stale, "Молоко")
        self.assertClosed(entry, "Молоко")
        self.assertFalse(GenericProduct.objects.filter(name="Сыр").exists())
        self.assertNothingToUndo(entry, KEFIR_A, "Молоко")

    # --- A conflict resolved by the human ---------------------------------------------------------

    def test_conflict_with_a_value_of_a_human_resolved_for_the_suggestion(self):
        """К1 §5.1: the human chose the unconfirmed suggestion and gave up the other value; the mark stays."""
        entry = self.suggested()
        twin = add_product(TWIN, generic=self.milk)
        with self.assertRaises(merges.MergeConflict):
            self.confirm(self.original)
        self.confirm(self.original, resolutions={"generic": self.original.pk})
        self.assertPending(entry)
        self.assertEqual((entry.version, generic_of(KEFIR_A)), (1, "Кефир"))
        self.assertFalse(Product.objects.filter(pk=twin.pk).exists())
        self.assertSuggestionUndone(entry)

    def test_conflict_with_a_value_of_a_human_resolved_for_that_value(self):
        entry = self.suggested()
        twin = add_product(TWIN, generic=self.milk)
        self.confirm(self.original, resolutions={"generic": twin.pk})
        self.assertClosed(entry, "Молоко", "changed")
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "removed"})
        self.assertNothingToUndo(entry, KEFIR_A, "Молоко")

    # --- Several absorbed duplicates --------------------------------------------------------------

    def test_empty_duplicate_and_a_duplicate_of_a_human(self):
        entry = self.suggested()
        add_product(TWIN)
        self.human(THIRD)
        self.confirm(self.original)
        self.assertClosed(entry, "Кефир")
        self.assertNothingToUndo(entry, KEFIR_A, "Кефир")

    def test_pending_duplicate_and_a_duplicate_of_a_human(self):
        twin = add_product(TWIN)
        entry = self.suggested(twin)
        other = record(TWIN)
        self.human(THIRD)
        self.confirm(self.original)
        self.assertClosed(other, "Кефир")
        self.assertClosed(entry, "Кефир")
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "kept"})
        self.assertNothingToUndo(entry, KEFIR_A, "Кефир")

    def test_pending_duplicate_and_an_empty_duplicate(self):
        twin = add_product(TWIN)
        entry = self.suggested(twin)
        add_product(THIRD)
        self.confirm(self.original)
        self.assertClosed(record(TWIN), "Кефир")
        self.assertPending(entry)
        self.assertSuggestionUndone(entry)

    def test_two_duplicates_of_a_human_with_different_values(self):
        entry = self.suggested()
        self.human(TWIN)
        third = add_product(THIRD, generic=self.milk)
        self.confirm(self.original, resolutions={"generic": self.original.pk})
        # One of the duplicates had «Кефир» from a human: the survivor's value is not only a suggestion.
        self.assertClosed(entry, "Кефир")
        self.assertFalse(Product.objects.filter(pk=third.pk).exists())
        self.assertNothingToUndo(entry, KEFIR_A, "Кефир")

    # --- A chain of two merges --------------------------------------------------------------------

    def test_second_merge_absorbs_a_duplicate_of_a_human(self):
        entry = self.suggested()
        add_product(TWIN)
        self.confirm(self.original)
        self.assertPending(entry)
        self.human(THIRD)
        self.confirm(self.original)
        self.assertClosed(entry, "Кефир")
        self.assertNothingToUndo(entry, KEFIR_A, "Кефир")

    def test_second_merge_absorbs_an_empty_duplicate(self):
        entry = self.suggested()
        add_product(TWIN)
        self.confirm(self.original)
        add_product(THIRD)
        self.confirm(self.original)
        self.assertPending(entry)
        self.assertSuggestionUndone(entry)

    def test_moved_record_and_a_second_merge_that_absorbs_a_duplicate_of_a_human(self):
        entry = self.suggested()
        twin = add_product(TWIN)
        self.confirm(twin)
        self.assertPending(entry, twin)
        self.assertEqual(entry.origin_product_ref, self.original.pk)
        self.human(THIRD)
        self.confirm(twin)
        self.assertClosed(entry, "Кефир")
        self.assertEqual((entry.product_ref, entry.origin_product_ref), (twin.pk, self.original.pk))
        self.assertNothingToUndo(entry, TWIN, "Кефир")

    def test_moved_record_stays_pending_through_reconciliations(self):
        entry = self.suggested()
        twin = add_product(TWIN)
        self.confirm(twin)
        third = add_product(THIRD)
        self.confirm(third)
        # The duplicates the record came through had the value only from this suggestion.
        self.assertEqual(services.reconcile(), 0)
        self.assertPending(entry, third)
        self.assertSuggestionUndone(entry, THIRD)

    def test_settled_survivor_absorbed_by_a_product_with_its_own_pending_record(self):
        """A record closed by a duplicate of a human is not a pending suggestion of its product."""
        settled = self.suggested()
        self.human(TWIN)
        self.confirm(self.original)
        self.assertClosed(settled, "Кефир")
        third = add_product(THIRD)
        apply(existing(third, generic("Кефир")))
        entry = record(THIRD)
        self.confirm(third)
        self.assertFalse(Product.objects.filter(pk=self.original.pk).exists())
        self.assertClosed(entry, "Кефир")
        self.assertNothingToUndo(entry, THIRD, "Кефир")

    def test_moved_record_absorbed_by_a_product_with_its_own_pending_record(self):
        moved = self.suggested()
        twin = add_product(TWIN)
        self.confirm(twin)
        third = add_product(THIRD)
        apply(existing(third, generic("Кефир")))
        entry = record(THIRD)
        self.confirm(third)
        # The absorbed product had «Кефир» only from the record that moved to it.
        self.assertClosed(moved, "Кефир")
        self.assertPending(entry, third)
        self.assertSuggestionUndone(entry, THIRD)

    # --- The step did not run: the reconciliation decides the same --------------------------------

    def without_step(self):
        entry = self.suggested()
        self.human(TWIN)
        with patch.object(services, "after_merge_confirmed"):
            self.confirm(self.original)
        self.assertPending(entry)
        self.assertEqual(entry.version, 1)
        return entry

    def test_reconciliation_without_the_step_settles_the_record(self):
        entry = self.without_step()
        self.assertEqual(services.reconcile(), 1)
        self.assertClosed(entry, "Кефир")
        self.assertEqual((entry.version, states(CreatedGenericProduct)), (2, {"Кефир": "kept"}))
        self.assertNothingToUndo(entry, KEFIR_A, "Кефир")

    def test_cancel_pending_without_the_step_keeps_the_value(self):
        entry = self.without_step()
        self.assertEqual(services.cancel_pending(), {**NOTHING_CANCELLED, "superseded": [entry.pk]})
        self.assertClosed(entry, "Кефир")
        self.assertEqual(generic_of(KEFIR_A), "Кефир")

    def test_decisions_without_the_step_keep_the_value(self):
        decisions = {
            "reject": lambda entry: services.reject(entry.pk, version=1),
            "choose another": lambda entry: services.confirm(entry.pk, version=1, generic_id=self.milk.pk),
            "confirm many": lambda entry: services.confirm_many([(entry.pk, 1)]),
        }
        entry = self.without_step()
        for name, decide in decisions.items():
            with self.subTest(decision=name), self.assertRaises(services.ClassificationResolved):
                decide(entry)
        self.assertClosed(entry, "Кефир")
        self.assertEqual(generic_of(KEFIR_A), "Кефир")
        self.assertFalse(ClassificationRejection.objects.exists())

    def test_reconciliation_without_the_step_tells_a_suggestion_from_a_value_of_a_human(self):
        twin = add_product(TWIN)
        entry = self.suggested(twin)
        other = record(TWIN)
        with patch.object(services, "after_merge_confirmed"):
            self.confirm(self.original)
        self.assertEqual(services.reconcile(), 1)
        self.assertClosed(other, "Кефир")
        self.assertPending(entry)
        self.assertSuggestionUndone(entry)

    def test_second_merge_right_after_a_merge_without_the_step(self):
        """The record a duplicate of a human settled is still pending when its product is absorbed."""
        entry = self.without_step()
        third = add_product(THIRD)
        self.confirm(third)
        # It does not move to the empty survivor: the value came from a human through the first duplicate.
        self.assertClosed(entry, "Кефир")
        self.assertEqual((entry.product_ref, entry.origin_product_ref), (self.original.pk, None))
        self.assertEqual(list(services.records(product=third.pk)), [])
        self.assertNothingToUndo(entry, THIRD, "Кефир")

    # --- What does not settle the record ----------------------------------------------------------

    def test_merge_older_than_the_record_says_nothing_about_its_value(self):
        add_product(TWIN, generic=self.milk)
        self.confirm(self.original)
        self.assertEqual(generic_of(KEFIR_A), "Молоко")
        # A human emptied the fact again; the suggestion made afterwards is only a suggestion.
        Product.objects.filter(pk=self.original.pk).update(generic=service())
        apply(existing(KEFIR_A, self.milk))
        entry = record(KEFIR_A)
        self.assertEqual(services.reconcile(), 0)
        self.assertPending(entry)
        self.assertEqual(services.cancel_pending()["cancelled"], [entry.pk])
        self.assertEqual(generic_of(KEFIR_A), "Не разобрано")

    def test_duplicate_of_a_human_with_another_value_does_not_settle_later(self):
        entry = self.suggested()
        add_product(TWIN, generic=self.milk)
        self.confirm(self.original, resolutions={"generic": self.original.pk})
        add_product(THIRD)
        self.confirm(self.original)
        self.assertEqual(services.reconcile(), 0)
        self.assertPending(entry)

    def test_cancelled_merge_with_a_duplicate_of_a_human_changes_nothing(self):
        entry = self.suggested()
        twin = self.human(TWIN)
        merges.detect()
        merges.cancel(ProductMerge.objects.get(status="pending").pk)
        self.assertEqual(services.reconcile(), 0)
        self.assertPending(entry)
        # The suggestion is undone for its own product only; the duplicate keeps the value of the human.
        self.assertEqual(services.cancel_pending()["cancelled"], [entry.pk])
        self.assertEqual((generic_of(KEFIR_A), generic_of(TWIN)), ("Не разобрано", "Кефир"))
        self.assertEqual(states(CreatedGenericProduct), {"Кефир": "kept"})
        self.assertTrue(Product.objects.filter(pk=twin.pk).exists())
