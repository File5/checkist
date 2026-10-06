"""Suggestions and duplicate merges: the step after a merge confirmation (``after_merge_confirmed``)."""
from unittest.mock import patch

from django.test import TestCase, tag

from catalog.models import GenericProduct, Product
from classification import demo, services
from classification.models import (
    ClassificationRejection, CreatedGenericProduct, ProductClassification,
)
from classification.tests.factories import (
    CLASSIFICATION_MODELS, KEFIR_A, MILK, add_product, apply, existing, generic, generic_of, new, product, record,
    snapshot, states, suggest,
)
from merges import services as merges
from merges.models import ProductMerge
from merges.visibility import is_absorbed

DAIRY = ("Продукты питания", "Молочные продукты")
TWIN = KEFIR_A + "."


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
        step.assert_called_once_with(target_id=twin.pk, absorbed_ids=[self.original.pk])
        # Only the error class is logged.
        self.assertEqual(logs.output, [
            "ERROR:merges.services:Classification step after merge confirmation failed: RuntimeError",
        ])
        self.assertEqual((confirmed.status, generic_of(TWIN)), ("confirmed", "Кефир"))
        self.assertFalse(Product.objects.filter(pk=self.original.pk).exists())
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.active_product_id, entry.product_name, entry.version), (
            "pending", None, KEFIR_A, 1))
        # The safety net: the first reconciliation applies the same rules.
        info = services.describe([entry])[0]
        self.assertEqual((info.product, info.can_act), (None, False))
        self.assertEqual(services.reconcile(), 1)
        entry.refresh_from_db()
        self.assertEqual((entry.status, entry.product_ref, entry.origin_product_ref, entry.version), (
            "pending", twin.pk, self.original.pk, 2))

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
        services.after_merge_confirmed(target_id=twin.pk, absorbed_ids=[self.original.pk])
        services.after_merge_confirmed(target_id=10**9, absorbed_ids=[])
        self.assertEqual(snapshot(), before)
