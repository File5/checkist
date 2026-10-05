import io
import json
from decimal import Decimal
from unittest.mock import patch

from django.conf import settings
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.db.models import Count, ProtectedError
from django.test import TestCase, tag
from django.test.utils import CaptureQueriesContext

from catalog.models import Brand, GenericProduct, Product
from merges import demo, services
from merges.models import (
    ProductMerge, ProductMergeAlias, ProductMergeLine, ProductMergeMember, ProductMergeRejection,
)
from merges.tests.factories import (
    DOMAIN_MODELS, EGGS, MAULTASCHEN, MERGE_MODELS, MILK, PIZZA, ROULADE, TOAST, ZIMBO, add_line, add_product,
    ids, links, main_store, pending_group, product, snapshot,
)
from merges.visibility import absorbed_product_ids, is_absorbed, visible, visible_q
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from stores.models import Store, TaxRate

WRITES = ("INSERT", "UPDATE", "DELETE")


def writes(queries):
    return [query["sql"] for query in queries if query["sql"].lstrip().upper().startswith(WRITES)]


class MergeTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def detect(self):
        return services.detect()


@tag("integration")
class DetectTests(MergeTestCase):
    def test_seven_pending_groups_with_expected_survivors(self):
        result = self.detect()
        self.assertEqual((result.created, result.extended, len(result.group_ids)), (7, 0, 7))
        found = {}
        for group in ProductMerge.objects.prefetch_related("members"):
            self.assertEqual((group.status, group.version, group.detector_version), ("pending", 1, 1))
            self.assertIsNone(group.resolved_at)
            members = list(group.members.all())
            self.assertEqual([m.product_ref for m in members if m.role == "target"], [group.target_ref])
            self.assertTrue(all(m.state == "active" and m.active_product_id == m.product_ref for m in members))
            found[tuple(sorted(m.product_ref for m in members))] = group.target_ref
        expected = {tuple(sorted(ids(names))): product(names[0]).pk for names in demo.GROUPS}
        self.assertEqual(found, expected)

    def test_false_pair_and_negative_examples_are_in_no_group(self):
        self.detect()
        grouped = set(ProductMergeMember.objects.values_list("product_ref", flat=True))
        self.assertEqual(len(grouped), 19)
        for name in (*demo.FALSE_PAIR, "Pizza Hot Dog", "Demo Joghurt 1,5%", "Demo Joghurt 3,5%", "Demo Wasser 0.5l",
                     "Demo Wasser 5l", "Eier 6er Freiland", "Reis Langkorn Beutel", "Reis Langkorn Beutel.",
                     "Kaffee Crema Bohnen", "Kaffee Crema Bohne", "Schoko Riegel Nuss", "Schoko Riegel Nuss.",
                     "Landbrot geschnitten", "Landbrot geschnitten."):
            self.assertNotIn(product(name).pk, grouped, name)

    def test_only_product_id_of_lines_and_aliases_changes(self):
        # A richer receipt: tax, discount, deposit with a parent, non-unit quantity.
        line = ReceiptLine.objects.filter(raw_name="Steinof.PizzaSpezial").order_by("pk").first()
        store = line.receipt.store
        rate, _ = TaxRate.objects.get_or_create(
            country=store.country, kind="vat", rate=Decimal("7.00"), defaults={"name": "MwSt 7%"},
        )
        ReceiptLine.objects.filter(pk=line.pk).update(
            quantity=Decimal("2.000"), amount=Decimal("6.98"), discount_amount=Decimal("0.50"), tax_rate=rate,
            tax_code="A", tax_amount=Decimal("0.42"), store_item_code="4711", barcode="20000004",
            extra={"note": "demo"}, name_i18n={"de": "Pizza"},
        )
        ReceiptLine.objects.create(
            receipt=line.receipt, position=50, kind="deposit", parent=line, raw_name="Pfand", quantity=Decimal("1.000"),
            unit_price=Decimal("0.2500"), amount=Decimal("0.25"), product=product("Steinof.PizzaSpezial"),
        )
        ReceiptDiscount.objects.create(receipt=line.receipt, line=line, position=1, name="Rabatt", amount=Decimal("0.50"))
        ReceiptTax.objects.create(
            receipt=line.receipt, tax_rate=rate, tax_code="A", net=Decimal("6.00"), tax=Decimal("0.42"), gross=Decimal("6.42"),
        )
        before = snapshot(*DOMAIN_MODELS)
        lines_before, aliases_before = links()

        self.detect()

        after = snapshot(*DOMAIN_MODELS)
        for name in before:
            if name in ("ReceiptLine", "ProductAlias"):
                strip = [{key: value for key, value in row.items() if key != "product_id"} for row in after[name]]
                self.assertEqual(strip, [{k: v for k, v in row.items() if k != "product_id"} for row in before[name]])
            else:
                self.assertEqual(after[name], before[name], name)
        lines_after, aliases_after = links()
        self.assertEqual(lines_after.keys(), lines_before.keys())
        target_of = {}
        for names in demo.GROUPS:
            target_of.update(dict.fromkeys(ids(names), product(names[0]).pk))
        self.assertEqual(lines_after, {pk: target_of.get(owner, owner) for pk, owner in lines_before.items()})
        self.assertEqual(aliases_after, {pk: target_of.get(owner, owner) for pk, owner in aliases_before.items()})
        self.assertFalse(ReceiptLine.objects.filter(product__isnull=True).exists())
        # The journal remembers the original owner of every line and alias of the groups.
        journal = dict(ProductMergeLine.objects.values_list("line_id", "member__product_ref"))
        self.assertEqual(journal, {pk: owner for pk, owner in lines_before.items() if owner in target_of})
        journal = dict(ProductMergeAlias.objects.values_list("alias_id", "member__product_ref"))
        self.assertEqual(journal, {pk: owner for pk, owner in aliases_before.items() if owner in target_of})

    def test_pizza_card_after_merge(self):
        self.detect()
        target = product(PIZZA[0])
        lines = ReceiptLine.objects.filter(product=target).order_by("receipt__purchased_on")
        self.assertEqual([line.raw_name for line in lines], [
            "Steinof.PizzaSpezial", "Steinhof.PizzaSpezial", "Steinof.PizzaSpezial", "Steinhof PizzaSpezial",
        ])
        last = lines.last()
        self.assertEqual((str(last.receipt.purchased_on), last.unit_price), ("2026-10-01", Decimal("3.4900")))
        self.assertEqual(target.name, "Steinhof.PizzaSpezial")
        self.assertEqual(ProductAlias.objects.filter(product=target).count(), 3)

    def test_repeated_detect_writes_nothing(self):
        self.detect()
        before = snapshot()
        with CaptureQueriesContext(connection) as queries:
            result = self.detect()
        self.assertEqual((result.created, result.extended, result.group_ids, result.proposals), (0, 0, [], []))
        self.assertEqual(writes(queries.captured_queries), [])
        self.assertEqual(snapshot(), before)

    def test_dry_run_reports_and_writes_nothing(self):
        before = snapshot()
        with CaptureQueriesContext(connection) as queries:
            result = services.detect(dry_run=True)
        self.assertTrue(result.dry_run)
        self.assertEqual((result.created, result.extended, result.group_ids), (7, 0, []))
        self.assertEqual(writes(queries.captured_queries), [])
        self.assertEqual(snapshot(), before)
        pizza = next(item for item in result.proposals if product(PIZZA[0]).pk in item["product_ids"])
        self.assertEqual(pizza["target_product_id"], product(PIZZA[0]).pk)
        self.assertEqual(sorted(pizza["names"].values()), sorted(PIZZA))
        self.assertIsNone(pizza["group_id"])

    def test_new_spelling_extends_the_pending_group(self):
        self.detect()
        group = pending_group(PIZZA[0])
        newcomer = add_product("Steinhof,PizzaSpezial")
        line = add_line(newcomer, "Steinhof,PizzaSpezial")
        others = snapshot(ProductMergeRejection)
        result = self.detect()
        self.assertEqual((result.created, result.extended, result.group_ids), (0, 1, [group.pk]))
        group.refresh_from_db()
        self.assertEqual((group.status, group.version, group.target_ref), ("pending", 2, product(PIZZA[0]).pk))
        member = group.members.get(product_ref=newcomer.pk)
        self.assertEqual((member.role, member.state, member.active_product_id), ("source", "active", newcomer.pk))
        line.refresh_from_db()
        self.assertEqual(line.product_id, group.target_ref)
        self.assertEqual(list(member.lines.values_list("line_id", flat=True)), [line.pk])
        self.assertEqual(ProductMerge.objects.count(), 7)
        self.assertEqual(snapshot(ProductMergeRejection), others)
        self.assertEqual(self.detect().extended, 0)

    def test_scope_limits_detection_to_given_products(self):
        result = services.detect(product_ids=[product("Steinof.PizzaSpezial").pk, product("Pizza Hot Dog").pk])
        self.assertEqual(result.created, 1)
        self.assertEqual(
            sorted(ProductMergeMember.objects.values_list("product_ref", flat=True)), sorted(ids(PIZZA)),
        )
        self.assertEqual(services.detect(product_ids=[]).created, 0)
        self.assertEqual(self.detect().created, 6)

    def test_product_is_in_one_pending_group_only(self):
        self.detect()
        counts = ProductMergeMember.objects.filter(active_product__isnull=False).values("active_product").annotate(
            total=Count("id"),
        )
        self.assertTrue(all(row["total"] == 1 for row in counts))
        self.assertEqual(counts.count(), 19)

    def test_stray_links_of_an_absorbed_product_are_picked_up(self):
        self.detect()
        group = pending_group(PIZZA[0])
        source = product("Steinof.PizzaSpezial")
        # Found by GTIN or product name, the importer may still return the absorbed product.
        line = add_line(source, "STEINOF PIZZA SPEZIAL XL")
        alias = ProductAlias.objects.create(
            merchant=main_store().merchant, product=source, name_key="steinof pizza spezial xl",
            raw_name="STEINOF PIZZA SPEZIAL XL",
        )
        result = self.detect()
        self.assertEqual((result.created, result.extended), (0, 0))
        line.refresh_from_db()
        alias.refresh_from_db()
        self.assertEqual((line.product_id, alias.product_id), (group.target_ref, group.target_ref))
        member = group.members.get(product_ref=source.pk)
        self.assertIn(line.pk, member.lines.values_list("line_id", flat=True))
        self.assertIn(alias.pk, member.aliases.values_list("alias_id", flat=True))
        group.refresh_from_db()
        self.assertEqual(group.version, 1)


@tag("integration")
class VisibilityTests(MergeTestCase):
    def test_absorbed_products_are_hidden_while_the_group_is_pending(self):
        self.assertEqual(visible(Product.objects.all()).count(), len(demo.PRODUCTS))
        self.detect()
        hidden = {pk for names in demo.GROUPS for pk in ids(names[1:])}
        self.assertEqual(len(hidden), 12)
        self.assertEqual(set(absorbed_product_ids().values_list("active_product_id", flat=True)), hidden)
        shown = set(visible(Product.objects.all()).values_list("pk", flat=True))
        self.assertEqual(shown, set(Product.objects.values_list("pk", flat=True)) - hidden)
        self.assertTrue(is_absorbed(product(PIZZA[1]).pk))
        self.assertFalse(is_absorbed(product(PIZZA[0]).pk))
        self.assertEqual(visible(Product.objects.filter(name__icontains="pizza")).count(), 2)

    def test_visible_q_counts_through_a_relation(self):
        self.detect()
        service = GenericProduct.objects.annotate(
            total=Count("products"), shown=Count("products", filter=visible_q("products__")),
        ).get(name=demo.SERVICE_GENERIC_NAME)
        hidden_here = Product.objects.filter(
            generic=service, pk__in=absorbed_product_ids(),
        ).count()
        self.assertEqual(service.shown, service.total - hidden_here)
        self.assertEqual(service.shown, visible(Product.objects.filter(generic=service)).count())
        zimbo = Brand.objects.annotate(shown=Count("products", filter=visible_q("products__"))).get(name="Zimbo")
        self.assertEqual(zimbo.shown, 1)

    def test_visibility_adds_no_query(self):
        self.detect()
        with self.assertNumQueries(1):
            list(visible(Product.objects.all()))

    def test_products_reappear_after_cancel_and_exclusion(self):
        self.detect()
        services.cancel(pending_group(PIZZA[0]).pk)
        self.assertFalse(is_absorbed(product(PIZZA[1]).pk))
        group = pending_group(MAULTASCHEN[0])
        services.exclude(group.pk, version=1, product_id=product(MAULTASCHEN[2]).pk)
        self.assertFalse(is_absorbed(product(MAULTASCHEN[2]).pk))
        self.assertTrue(is_absorbed(product(MAULTASCHEN[1]).pk))


@tag("integration")
class CancelTests(MergeTestCase):
    def test_cancel_restores_every_line_and_alias(self):
        before = snapshot(*DOMAIN_MODELS)
        self.detect()
        group = pending_group(MILK[0])
        untouched = snapshot(ProductMerge, ProductMergeMember, ProductMergeLine, ProductMergeAlias)
        result = services.cancel(group.pk)
        self.assertEqual((result.pk, result.status, result.version), (group.pk, "cancelled", 1))
        self.assertIsNotNone(result.resolved_at)
        for names in demo.GROUPS[1:]:
            services.cancel(pending_group(names[0]).pk)
        self.assertEqual(snapshot(*DOMAIN_MODELS), before)
        self.assertFalse(ProductMergeLine.objects.exists())
        self.assertFalse(ProductMergeAlias.objects.exists())
        self.assertFalse(ProductMergeMember.objects.filter(active_product__isnull=False).exists())
        self.assertEqual(ProductMergeMember.objects.count(), len(untouched["ProductMergeMember"]))
        self.assertEqual(ProductMerge.objects.filter(status="cancelled").count(), 7)

    def test_cancel_touches_only_its_group(self):
        self.detect()
        group = pending_group(PIZZA[0])
        other = snapshot(ProductMergeLine, ProductMergeAlias)
        services.cancel(group.pk)
        left = snapshot(ProductMergeLine, ProductMergeAlias)
        self.assertEqual(len(left["ProductMergeLine"]), len(other["ProductMergeLine"]) - 4)
        self.assertEqual(len(left["ProductMergeAlias"]), len(other["ProductMergeAlias"]) - 3)
        self.assertEqual(ProductMerge.objects.filter(status="pending").count(), 6)

    def test_cancelled_pairs_are_rejected_and_not_proposed_again(self):
        self.detect()
        group = pending_group(MILK[0])
        services.cancel(group.pk)
        pairs = set(ProductMergeRejection.objects.values_list("product_low_id", "product_high_id"))
        members = sorted(ids(MILK))
        self.assertEqual(pairs, {(a, b) for a in members for b in members if a < b})
        self.assertEqual(len(pairs), 10)
        self.assertTrue(all(row.group_id == group.pk for row in ProductMergeRejection.objects.all()))
        before = snapshot()
        result = self.detect()
        self.assertEqual((result.created, result.extended), (0, 0))
        self.assertEqual(snapshot(), before)
        self.assertEqual(services.detect(dry_run=True).created, 0)

    def test_rejection_blocks_a_join_through_a_third_record(self):
        self.detect()
        services.cancel(pending_group(PIZZA[0]).pk)
        add_product("Steinhof:PizzaSpezial")
        result = self.detect()
        # The newcomer may pair with one of the three, never bring two of them together.
        self.assertEqual(result.created, 1)
        group = ProductMerge.objects.get(pk=result.group_ids[0])
        self.assertEqual(group.members.count(), 2)
        self.assertEqual(len(set(ids(PIZZA)) & set(group.members.values_list("product_ref", flat=True))), 1)

    def test_repeated_cancel_returns_the_group_unchanged(self):
        self.detect()
        group = pending_group(PIZZA[0])
        services.cancel(group.pk)
        before = snapshot()
        with CaptureQueriesContext(connection) as queries:
            again = services.cancel(group.pk)
        self.assertEqual((again.pk, again.status), (group.pk, "cancelled"))
        self.assertEqual(writes(queries.captured_queries), [])
        self.assertEqual(snapshot(), before)

    def test_line_imported_while_pending_goes_to_the_owner_of_its_alias(self):
        self.detect()
        group = pending_group(PIZZA[0])
        target = product(PIZZA[0])
        # The alias already points at the survivor, so the importer binds new lines to it.
        by_source_alias = add_line(target, "Steinof.PizzaSpezial")
        other_case = add_line(target, "  steinhof   PIZZASPEZIAL ")
        by_target_alias = add_line(target, "Steinhof.PizzaSpezial")
        unknown = add_line(target, "Steinhof Pizza Spezial Neu")
        info = services.describe_group(group)
        self.assertEqual((info.lines_count, info.new_lines_count), (8, 4))
        services.cancel(group.pk)
        owners = dict(ReceiptLine.objects.filter(
            pk__in=[by_source_alias.pk, other_case.pk, by_target_alias.pk, unknown.pk],
        ).values_list("pk", "product_id"))
        self.assertEqual(owners, {
            by_source_alias.pk: product("Steinof.PizzaSpezial").pk,
            other_case.pk: product("Steinhof PizzaSpezial").pk,
            by_target_alias.pk: target.pk,
            unknown.pk: target.pk,
        })

    def test_new_line_follows_the_item_code_when_it_has_one(self):
        self.detect()
        group = pending_group(ZIMBO[0])
        target, source = product(ZIMBO[0]), product(ZIMBO[1])
        coded = ProductAlias.objects.get(product=target, raw_name=ZIMBO[1])
        self.assertEqual(coded.store_item_code, "")
        with_other_code = add_line(target, ZIMBO[1], store_item_code="999")
        without_code = add_line(target, ZIMBO[1])
        services.cancel(group.pk)
        with_other_code.refresh_from_db()
        without_code.refresh_from_db()
        # No journaled alias has code 999: the owner is unknown, the line stays.
        self.assertEqual((with_other_code.product_id, without_code.product_id), (target.pk, source.pk))

    def test_line_of_another_merchant_is_not_handed_over_by_name(self):
        self.detect()
        group = pending_group(PIZZA[0])
        target = product(PIZZA[0])
        other_store = Store.objects.exclude(pk=main_store().pk).get(merchant__tax_id=demo.MERCHANTS[demo.OTHER]["tax_id"])
        line = add_line(target, "Steinof.PizzaSpezial", store=other_store)
        services.cancel(group.pk)
        line.refresh_from_db()
        self.assertEqual(line.product_id, target.pk)

    def test_link_changed_by_a_human_is_not_overwritten(self):
        self.detect()
        group = pending_group(PIZZA[0])
        elsewhere = product("Pizza Hot Dog")
        source = product("Steinof.PizzaSpezial")
        moved_line = ReceiptLine.objects.filter(raw_name="Steinof.PizzaSpezial").order_by("pk").first()
        ReceiptLine.objects.filter(pk=moved_line.pk).update(product=elsewhere)
        alias = ProductAlias.objects.get(raw_name="Steinof.PizzaSpezial")
        ProductAlias.objects.filter(pk=alias.pk).update(product=elsewhere)
        services.cancel(group.pk)
        moved_line.refresh_from_db()
        alias.refresh_from_db()
        self.assertEqual((moved_line.product_id, alias.product_id), (elsewhere.pk, elsewhere.pk))
        self.assertEqual(ReceiptLine.objects.filter(product=source).count(), 1)

    def test_cancel_of_a_confirmed_group_is_refused(self):
        self.detect()
        group = pending_group(PIZZA[0])
        services.confirm(group.pk, version=1, target_product_id=group.target_ref)
        before = snapshot()
        with self.assertRaises(services.MergeResolved) as caught:
            services.cancel(group.pk)
        self.assertEqual((caught.exception.code, caught.exception.group.status), ("merge_resolved", "confirmed"))
        self.assertEqual(snapshot(), before)

    def test_unknown_group(self):
        for call in (
            lambda: services.cancel(999_999),
            lambda: services.exclude(999_999, version=1, product_id=1),
            lambda: services.confirm(999_999, version=1, target_product_id=1),
            lambda: services.get_group(999_999),
        ):
            with self.assertRaises(services.MergeNotFound) as caught:
                call()
            self.assertEqual(caught.exception.code, "not_found")


@tag("integration")
class ConfirmTests(MergeTestCase):
    def confirm(self, names, **options):
        group = pending_group(names[0])
        options.setdefault("version", group.version)
        options.setdefault("target_product_id", group.target_ref)
        return services.confirm(group.pk, **options)

    def test_absorbed_products_are_deleted_without_losing_links(self):
        self.detect()
        group = pending_group(PIZZA[0])
        target, absorbed = product(PIZZA[0]), ids(PIZZA[1:])
        before = snapshot(*DOMAIN_MODELS)
        journal = snapshot(ProductMergeLine, ProductMergeAlias)
        result = self.confirm(PIZZA)
        self.assertEqual((result.pk, result.status, result.version, result.target_ref), (group.pk, "confirmed", 1, target.pk))
        self.assertIsNotNone(result.resolved_at)
        self.assertFalse(Product.objects.filter(pk__in=absorbed).exists())
        after = snapshot(*DOMAIN_MODELS)
        self.assertEqual([row for row in before["Product"] if row["id"] not in absorbed], after["Product"])
        for name in ("ReceiptLine", "ProductAlias", "Receipt", "ReceiptDiscount", "ReceiptTax"):
            self.assertEqual(after[name], before[name], name)
        self.assertFalse(ReceiptLine.objects.filter(product__isnull=True).exists())
        self.assertEqual(
            sorted(ProductAlias.objects.filter(product=target).values_list("raw_name", flat=True)), sorted(PIZZA),
        )
        self.assertEqual(ReceiptLine.objects.filter(product=target).count(), 4)
        # The journal and the members stay as the record of the original ownership.
        self.assertEqual(snapshot(ProductMergeLine, ProductMergeAlias), journal)
        members = list(group.members.order_by("product_ref"))
        self.assertEqual([m.product_ref for m in members], sorted(ids([PIZZA[0]]) + absorbed))
        self.assertTrue(all(m.active_product_id is None and m.state == "active" for m in members))
        self.assertEqual(sorted(m.name for m in members), sorted(PIZZA))
        target.refresh_from_db()
        self.assertEqual(target.name, PIZZA[0])
        self.assertEqual(ProductMerge.objects.filter(status="pending").count(), 6)

    def test_name_changes_only_on_explicit_request(self):
        self.detect()
        target, source = product(PIZZA[0]), product("Steinhof PizzaSpezial")
        self.confirm(PIZZA, name_product_id=source.pk)
        target.refresh_from_db()
        self.assertEqual(target.name, "Steinhof PizzaSpezial")
        self.assertEqual(list(Product.objects.filter(name__in=PIZZA).values_list("pk", flat=True)), [target.pk])
        # The printed names on the receipts are untouched.
        self.assertEqual(ReceiptLine.objects.filter(product=target, raw_name=PIZZA[0]).count(), 1)

    def test_another_record_may_survive(self):
        self.detect()
        group = pending_group(PIZZA[0])
        chosen = product("Steinof.PizzaSpezial")
        new_line = add_line(product(PIZZA[0]), "Steinhof.PizzaSpezial")
        lines = set(ReceiptLine.objects.filter(product_id=group.target_ref).values_list("pk", flat=True))
        result = self.confirm(PIZZA, target_product_id=chosen.pk)
        self.assertEqual((result.status, result.target_ref), ("confirmed", chosen.pk))
        self.assertEqual(list(Product.objects.filter(name__in=PIZZA).values_list("pk", flat=True)), [chosen.pk])
        self.assertEqual(set(ReceiptLine.objects.filter(product=chosen).values_list("pk", flat=True)), lines)
        self.assertIn(new_line.pk, lines)
        self.assertEqual(ProductAlias.objects.filter(product=chosen).count(), 3)
        roles = dict(group.members.values_list("product_ref", "role"))
        self.assertEqual([ref for ref, role in roles.items() if role == "target"], [chosen.pk])
        chosen.refresh_from_db()
        self.assertEqual(chosen.name, "Steinof.PizzaSpezial")

    def test_empty_facts_are_filled_and_filled_ones_are_kept(self):
        target = add_product("Demo Honig Glas Wald")
        brand = Brand.objects.create(name="Demo Imkerei")
        generic = GenericProduct.objects.create(
            name="Мёд (демо)", category=target.generic.category, base_unit="kg",
        )
        source = add_product(
            "Demo Honig Glas Wald.", brand=brand, gtin=demo.ean13("200000000010"), model="HW-1",
            package_quantity=Decimal("0.500"), package_unit="kg", attributes={"sort": "wald"}, generic=generic,
        )
        self.detect()
        group = pending_group("Demo Honig Glas Wald")
        # The record with facts is the default survivor; a human keeps the bare one instead.
        self.assertEqual(group.target_ref, source.pk)
        self.assertEqual(services.describe_group(group).conflicts, [])
        # A survivor with the higher id must not claim the lines of the others in the journal.
        self.assertEqual(
            dict(ProductMergeAlias.objects.filter(member__group=group).values_list("alias__raw_name", "member__product_ref")),
            {"Demo Honig Glas Wald": target.pk, "Demo Honig Glas Wald.": source.pk},
        )
        services.confirm(group.pk, version=1, target_product_id=target.pk)
        target.refresh_from_db()
        self.assertEqual(
            (target.brand_id, target.gtin, target.model, target.package_quantity, target.package_unit,
             target.attributes, target.generic_id, target.name),
            (brand.pk, demo.ean13("200000000010"), "HW-1", Decimal("0.500"), "kg", {"sort": "wald"}, generic.pk,
             "Demo Honig Glas Wald"),
        )
        self.assertFalse(Product.objects.filter(pk=source.pk).exists())

    def test_filled_facts_of_the_survivor_are_not_overwritten(self):
        self.detect()
        target = product(EGGS[0])
        Product.objects.filter(pk=target.pk).update(model="FREI-10", attributes={"size": "M"})
        before = Product.objects.filter(pk=target.pk).values().get()
        self.confirm(EGGS)
        self.assertEqual(Product.objects.filter(pk=target.pk).values().get(), before)
        zimbo_before = Product.objects.filter(name=ZIMBO[0]).values().get()
        self.confirm(ZIMBO)
        self.assertEqual(Product.objects.filter(name=ZIMBO[0]).values().get(), zimbo_before)

    def test_conflict_without_a_decision_saves_nothing(self):
        self.detect()
        group = pending_group(MILK[0])
        holders = sorted(ids(["GQ EgSB H-Milch 1,5%", "GO EgSB H-Milch 1,5%"]))
        self.assertEqual(services.describe_group(group).conflicts, [("generic", holders)])
        before = snapshot()
        with self.assertRaises(services.MergeConflict) as caught:
            self.confirm(MILK)
        self.assertEqual((caught.exception.code, caught.exception.fields), ("merge_conflict", {"generic": holders}))
        self.assertEqual(snapshot(), before)

    def test_conflict_is_resolved_by_the_chosen_record(self):
        self.detect()
        target = product(MILK[0])
        other = product("GO EgSB H-Milch 1,5%")
        other_generic = other.generic_id
        self.confirm(MILK, resolutions={"generic": other.pk})
        target.refresh_from_db()
        self.assertEqual(target.generic_id, other_generic)
        self.assertEqual(list(Product.objects.filter(name__in=MILK).values_list("pk", flat=True)), [target.pk])
        self.assertEqual(ReceiptLine.objects.filter(product=target).count(), 7)

    def test_conflict_resolved_in_favour_of_the_survivor(self):
        self.detect()
        target = product(MILK[0])
        generic = target.generic_id
        self.confirm(MILK, resolutions={"generic": target.pk})
        target.refresh_from_db()
        self.assertEqual((target.generic_id, target.generic.name), (generic, demo.MILK_GENERIC))

    def test_several_conflicts_need_every_decision(self):
        first = add_product("Demo Senf Tube Scharf", model="S-1", attributes={"heat": 3})
        second = add_product("Demo Senf Tube Scharf.", model="S-2", attributes={"heat": 5})
        self.assertEqual(self.detect().created, 7)  # different models never form a group
        Product.objects.filter(pk=second.pk).update(model="")
        self.detect()
        group = pending_group("Demo Senf Tube Scharf")
        Product.objects.filter(pk=second.pk).update(model="S-2")  # edited in admin while pending
        with self.assertRaises(services.MergeConflict) as caught:
            services.confirm(group.pk, version=1, target_product_id=first.pk, resolutions={"model": second.pk})
        self.assertEqual(caught.exception.fields, {"attributes": [first.pk, second.pk]})
        services.confirm(
            group.pk, version=1, target_product_id=first.pk, resolutions={"model": second.pk, "attributes": first.pk},
        )
        first.refresh_from_db()
        self.assertEqual((first.model, first.attributes), ("S-2", {"heat": 3}))

    def test_wrong_resolutions_are_invalid_parameters(self):
        self.detect()
        group = pending_group(MILK[0])
        target = product(MILK[0])
        before = snapshot()
        cases = (
            ({"brand": target.pk}, {"resolutions.brand": "not_conflict"}),
            ({"generic": target.pk, "colour": target.pk}, {"resolutions.colour": "not_conflict"}),
            ({"generic": product("GG EgSB H-Milch 1,5%").pk}, {"resolutions.generic": "not_candidate"}),
            ({"generic": product("Pizza Hot Dog").pk}, {"resolutions.generic": "not_candidate"}),
            ({"generic": "2"}, {"resolutions.generic": "not_candidate"}),
            ([1], {"resolutions": "invalid_type"}),
        )
        for resolutions, fields in cases:
            with self.subTest(resolutions=resolutions), self.assertRaises(services.MergeInvalidParameter) as caught:
                services.confirm(group.pk, version=1, target_product_id=target.pk, resolutions=resolutions)
            self.assertEqual((caught.exception.code, caught.exception.fields), ("invalid_parameter", fields))
        self.assertEqual(snapshot(), before)

    def test_products_outside_the_group_are_invalid_parameters(self):
        self.detect()
        group = pending_group(PIZZA[0])
        outsider = product("Pizza Hot Dog").pk
        before = snapshot()
        cases = (
            ({"target_product_id": outsider}, {"target_product_id": "not_member"}),
            ({"target_product_id": True}, {"target_product_id": "not_member"}),
            ({"target_product_id": group.target_ref, "name_product_id": outsider}, {"name_product_id": "not_member"}),
            ({"target_product_id": outsider, "name_product_id": "x"},
             {"target_product_id": "not_member", "name_product_id": "not_member"}),
        )
        for options, fields in cases:
            with self.subTest(options=options), self.assertRaises(services.MergeInvalidParameter) as caught:
                services.confirm(group.pk, version=1, **options)
            self.assertEqual(caught.exception.fields, fields)
        self.assertEqual(snapshot(), before)

    def test_excluded_record_cannot_survive_or_give_its_name(self):
        self.detect()
        group = pending_group(MAULTASCHEN[0])
        excluded = product(MAULTASCHEN[2]).pk
        services.exclude(group.pk, version=1, product_id=excluded)
        with self.assertRaises(services.MergeInvalidParameter):
            services.confirm(group.pk, version=2, target_product_id=excluded)
        with self.assertRaises(services.MergeInvalidParameter):
            services.confirm(group.pk, version=2, target_product_id=group.target_ref, name_product_id=excluded)
        services.confirm(group.pk, version=2, target_product_id=group.target_ref)
        self.assertTrue(Product.objects.filter(pk=excluded).exists())
        self.assertFalse(Product.objects.filter(name=MAULTASCHEN[1]).exists())

    def test_stale_version_changes_nothing(self):
        self.detect()
        group = pending_group(PIZZA[0])
        add_product("Steinhof,PizzaSpezial")
        self.detect()
        before = snapshot()
        with self.assertRaises(services.MergeChanged) as caught:
            services.confirm(group.pk, version=1, target_product_id=group.target_ref)
        self.assertEqual((caught.exception.code, caught.exception.group.version), ("merge_changed", 2))
        self.assertEqual(snapshot(), before)
        self.assertEqual(services.confirm(group.pk, version=2, target_product_id=group.target_ref).status, "confirmed")

    def test_repeated_confirm_with_the_same_survivor_is_a_no_op(self):
        self.detect()
        group = pending_group(PIZZA[0])
        self.confirm(PIZZA)
        before = snapshot()
        with CaptureQueriesContext(connection) as queries:
            again = services.confirm(group.pk, version=1, target_product_id=group.target_ref)
        self.assertEqual((again.pk, again.status), (group.pk, "confirmed"))
        self.assertEqual(writes(queries.captured_queries), [])
        # The repeat carries the version the client read before; it is not checked again.
        self.assertEqual(services.confirm(group.pk, version=99, target_product_id=group.target_ref).status, "confirmed")
        self.assertEqual(snapshot(), before)

    def test_confirm_of_a_resolved_group_with_another_survivor_is_refused(self):
        self.detect()
        group = pending_group(PIZZA[0])
        other = product(PIZZA[1]).pk
        self.confirm(PIZZA)
        cancelled = pending_group(ZIMBO[0])
        services.cancel(cancelled.pk)
        before = snapshot()
        with self.assertRaises(services.MergeResolved) as caught:
            services.confirm(group.pk, version=1, target_product_id=other)
        self.assertEqual(caught.exception.group.status, "confirmed")
        with self.assertRaises(services.MergeResolved) as caught:
            services.confirm(cancelled.pk, version=1, target_product_id=cancelled.target_ref)
        self.assertEqual(caught.exception.group.status, "cancelled")
        self.assertEqual(snapshot(), before)

    def test_result_colliding_with_an_outside_product_is_a_conflict(self):
        brand = Brand.objects.create(name="Demo Marke Zed")
        target = add_product("Demo Essig Hell Flasche")
        add_product("Demo Essig Hell Flasche.", brand=brand)
        other_store = Store.objects.get(merchant__tax_id=demo.MERCHANTS[demo.OTHER]["tax_id"])
        # Same name and brand as the merge result, sold by another merchant only.
        add_product("Demo Essig Hell Flasche", brand=brand, store=other_store)
        self.detect()
        group = pending_group("Demo Essig Hell Flasche.")
        self.assertEqual(group.members.count(), 2)
        before = snapshot()
        with self.assertRaises(services.MergeConflict) as caught:
            services.confirm(group.pk, version=1, target_product_id=target.pk)
        self.assertEqual(caught.exception.fields, {"name": []})
        self.assertEqual(snapshot(), before)

    def test_stray_links_are_moved_before_products_are_deleted(self):
        self.detect()
        group = pending_group(PIZZA[0])
        source = product("Steinof.PizzaSpezial")
        line = add_line(source, "Steinof Pizza XL")
        alias = ProductAlias.objects.create(
            merchant=main_store().merchant, product=source, name_key="steinof pizza xl", raw_name="Steinof Pizza XL",
        )
        self.confirm(PIZZA)
        line.refresh_from_db()
        alias.refresh_from_db()
        self.assertEqual((line.product_id, alias.product_id), (group.target_ref, group.target_ref))
        self.assertEqual(ReceiptLine.objects.count(), sum(len(rows) for *_, rows in demo.RECEIPTS) + 1)

    def test_survivor_can_join_a_new_group_later(self):
        self.detect()
        self.confirm(PIZZA)
        add_product("Steinhof,PizzaSpezial")
        result = self.detect()
        self.assertEqual(result.created, 1)
        self.assertEqual(ProductMerge.objects.get(pk=result.group_ids[0]).target_ref, product(PIZZA[0]).pk)


@tag("integration")
class ExcludeTests(MergeTestCase):
    def test_excluded_source_is_restored_and_the_rest_stays_merged(self):
        self.detect()
        group = pending_group(MAULTASCHEN[0])
        target = product(MAULTASCHEN[0])
        kept, excluded = product(MAULTASCHEN[1]), product(MAULTASCHEN[2])
        lines_before, aliases_before = links()
        services.cancel(pending_group(PIZZA[0]).pk)  # unrelated rejections must survive
        result = services.exclude(group.pk, version=1, product_id=excluded.pk)
        self.assertEqual((result.status, result.version, result.target_ref), ("pending", 2, target.pk))
        states = {m.product_ref: (m.role, m.state, m.active_product_id) for m in result.members.all()}
        self.assertEqual(states, {
            target.pk: ("target", "active", target.pk), kept.pk: ("source", "active", kept.pk),
            excluded.pk: ("source", "excluded", None),
        })
        self.assertEqual(list(ReceiptLine.objects.filter(product=excluded).values_list("raw_name", flat=True)),
                         [MAULTASCHEN[2]])
        self.assertEqual(list(ProductAlias.objects.filter(product=excluded).values_list("raw_name", flat=True)),
                         [MAULTASCHEN[2]])
        self.assertEqual(ReceiptLine.objects.filter(product=target).count(), 2)
        self.assertFalse(ReceiptLine.objects.filter(product=kept).exists())
        pairs = set(ProductMergeRejection.objects.filter(group=group).values_list("product_low_id", "product_high_id"))
        self.assertEqual(pairs, {tuple(sorted((excluded.pk, target.pk))), tuple(sorted((excluded.pk, kept.pk)))})
        self.assertEqual(ProductMergeRejection.objects.exclude(group=group).count(), 3)
        self.assertFalse(ProductMergeLine.objects.filter(member__product_ref=excluded.pk, member__group=group).exists())
        # Everything outside the two groups is where it was.
        lines_after, _ = links()
        touched = set(ids(MAULTASCHEN)) | set(ids(PIZZA))
        self.assertEqual({pk: owner for pk, owner in lines_after.items() if lines_before[pk] not in touched},
                         {pk: owner for pk, owner in lines_before.items() if owner not in touched})
        result = self.detect()
        self.assertEqual((result.created, result.extended), (0, 0))

    def test_repeated_exclude_returns_the_current_group(self):
        self.detect()
        group = pending_group(MAULTASCHEN[0])
        excluded = product(MAULTASCHEN[2]).pk
        services.exclude(group.pk, version=1, product_id=excluded)
        before = snapshot()
        with CaptureQueriesContext(connection) as queries:
            again = services.exclude(group.pk, version=1, product_id=excluded)
        self.assertEqual((again.status, again.version), ("pending", 2))
        self.assertEqual(writes(queries.captured_queries), [])
        self.assertEqual(snapshot(), before)

    def test_excluding_the_survivor_merges_the_rest_onto_a_new_default(self):
        self.detect()
        group = pending_group(MILK[0])
        old_target = product(MILK[0])
        own_lines = set(ReceiptLine.objects.filter(raw_name=MILK[0]).values_list("pk", flat=True))
        result = services.exclude(group.pk, version=1, product_id=old_target.pk)
        # «GO EgSB» is the only classified record left, so it becomes the default survivor.
        new_target = product("GO EgSB H-Milch 1,5%")
        self.assertEqual((result.status, result.version, result.target_ref), ("pending", 2, new_target.pk))
        roles = {m.product_ref: (m.role, m.state) for m in result.members.all()}
        self.assertEqual(roles[old_target.pk], ("target", "excluded"))
        self.assertEqual(roles[new_target.pk], ("target", "active"))
        self.assertEqual(sum(role == ("source", "active") for role in roles.values()), 3)
        self.assertEqual(set(ReceiptLine.objects.filter(product=old_target).values_list("pk", flat=True)), own_lines)
        self.assertEqual(ProductAlias.objects.filter(product=old_target).count(), 1)
        self.assertEqual(ReceiptLine.objects.filter(product=new_target).count(), 4)
        self.assertEqual(ProductAlias.objects.filter(product=new_target).count(), 4)
        self.assertEqual(ProductMergeLine.objects.filter(member__group=group).count(), 4)
        self.assertEqual(ProductMergeRejection.objects.filter(group=group).count(), 4)
        self.assertEqual(services.describe_group(result).conflicts, [])
        services.cancel(group.pk)
        for name in MILK[1:]:
            self.assertEqual(list(ReceiptLine.objects.filter(product=product(name)).values_list("raw_name", flat=True)), [name])

    def test_fewer_than_two_records_cancel_the_group(self):
        self.detect()
        before = links()
        for excluded in (ZIMBO[1], ROULADE[0]):
            names = ZIMBO if excluded in ZIMBO else ROULADE
            group = pending_group(names[0])
            result = services.exclude(group.pk, version=1, product_id=product(excluded).pk)
            self.assertEqual((result.status, result.version), ("cancelled", 2))
            self.assertIsNotNone(result.resolved_at)
            self.assertFalse(result.members.filter(active_product__isnull=False).exists())
            self.assertFalse(ProductMergeLine.objects.filter(member__group=group).exists())
            self.assertEqual(ProductMergeRejection.objects.filter(group=group).count(), 1)
        after = links()
        original = {}
        for names in (ZIMBO, ROULADE):
            original.update({name: product(name).pk for name in names})
        for name, pk in original.items():
            self.assertEqual(set(ReceiptLine.objects.filter(product_id=pk).values_list("raw_name", flat=True)), {name})
            self.assertEqual(list(ProductAlias.objects.filter(product_id=pk).values_list("raw_name", flat=True)), [name])
        self.assertEqual(len(after[0]), len(before[0]))
        # Repeating the exclusion that cancelled the group is still a calm no-op.
        group = ProductMerge.objects.get(members__product_ref=product(ZIMBO[1]).pk)
        self.assertEqual(services.exclude(group.pk, version=1, product_id=product(ZIMBO[1]).pk).status, "cancelled")
        self.assertEqual(self.detect().created, 0)

    def test_stale_version_and_foreign_product(self):
        self.detect()
        group = pending_group(MAULTASCHEN[0])
        member = product(MAULTASCHEN[1]).pk
        before = snapshot()
        with self.assertRaises(services.MergeChanged):
            services.exclude(group.pk, version=5, product_id=member)
        for foreign in (product("Pizza Hot Dog").pk, "x", None, True):
            with self.assertRaises(services.MergeInvalidParameter) as caught:
                services.exclude(group.pk, version=1, product_id=foreign)
            self.assertEqual(caught.exception.fields, {"product_id": "not_member"})
        self.assertEqual(snapshot(), before)

    def test_exclude_of_a_resolved_group_is_refused(self):
        self.detect()
        confirmed, cancelled = pending_group(MAULTASCHEN[0]), pending_group(PIZZA[0])
        member = product(MAULTASCHEN[1]).pk
        services.confirm(confirmed.pk, version=1, target_product_id=confirmed.target_ref)
        services.cancel(cancelled.pk)
        before = snapshot()
        with self.assertRaises(services.MergeResolved):
            services.exclude(confirmed.pk, version=1, product_id=member)
        with self.assertRaises(services.MergeResolved):
            services.exclude(cancelled.pk, version=1, product_id=product(PIZZA[1]).pk)
        self.assertEqual(snapshot(), before)

    def test_line_imported_while_pending_follows_the_excluded_record(self):
        self.detect()
        group = pending_group(MAULTASCHEN[0])
        target, excluded = product(MAULTASCHEN[0]), product(MAULTASCHEN[2])
        line = add_line(target, MAULTASCHEN[2])
        kept_line = add_line(target, MAULTASCHEN[1])
        services.exclude(group.pk, version=1, product_id=excluded.pk)
        line.refresh_from_db()
        kept_line.refresh_from_db()
        self.assertEqual((line.product_id, kept_line.product_id), (excluded.pk, target.pk))
        info = services.describe_group(services.get_group(group.pk))
        self.assertEqual((info.lines_count, info.new_lines_count), (3, 0))


@tag("integration")
class ProtectTests(MergeTestCase):
    def test_product_of_a_pending_group_cannot_be_deleted(self):
        self.detect()
        group = pending_group(PIZZA[0])
        for name in PIZZA:
            with self.assertRaises(ProtectedError):
                product(name).delete()
        with self.assertRaises(ProtectedError):
            Product.objects.filter(name__in=PIZZA).delete()
        services.cancel(group.pk)
        product(PIZZA[1]).delete()
        self.assertFalse(Product.objects.filter(name=PIZZA[1]).exists())

    def test_excluded_record_and_confirmed_survivor_are_free(self):
        self.detect()
        group = pending_group(MAULTASCHEN[0])
        excluded = product(MAULTASCHEN[2])
        services.exclude(group.pk, version=1, product_id=excluded.pk)
        excluded.delete()
        services.confirm(group.pk, version=2, target_product_id=group.target_ref)
        refs = sorted(group.members.values_list("product_ref", flat=True))
        product(MAULTASCHEN[0]).delete()
        # The members keep the ids without a foreign key.
        self.assertEqual(sorted(group.members.values_list("product_ref", flat=True)), refs)
        self.assertEqual(len(refs), 3)
        self.assertFalse(Product.objects.filter(pk__in=refs).exists())


@tag("integration")
class ReadTests(MergeTestCase):
    def test_group_description(self):
        self.detect()
        group = pending_group(PIZZA[0])
        info = services.describe_group(group)
        self.assertEqual((info.lines_count, info.new_lines_count, info.conflicts), (4, 0, []))
        self.assertTrue(info.can_confirm and info.can_cancel and info.can_exclude)
        self.assertEqual([member.member.product_ref for member in info.members], sorted(ids(PIZZA)))
        by_name = {member.name: member for member in info.members}
        first = by_name["Steinof.PizzaSpezial"]
        self.assertEqual((first.lines_count, str(first.first_purchased_on), str(first.last_purchased_on)),
                         (2, "2026-06-09", "2026-07-06"))
        self.assertEqual([(alias.raw_name, alias.merchant.brand_name, alias.store_item_code) for alias in first.aliases],
                         [("Steinof.PizzaSpezial", "Demomarkt", "")])
        self.assertTrue(first.exists)
        self.assertFalse(first.classified)
        self.assertEqual(first.facts, {
            "generic": {"id": first.product.generic_id, "name": demo.SERVICE_GENERIC_NAME, "base_unit": "pcs"},
            "brand": None, "model": "", "gtin": "", "package": None, "attributes": {},
        })
        eggs = services.describe_group(pending_group(EGGS[0])).members[0]
        self.assertEqual(eggs.facts["package"], {"quantity": "10.000", "unit": "pcs"})
        zimbo = services.describe_group(pending_group(ZIMBO[0])).members[0]
        self.assertEqual(zimbo.facts["brand"]["name"], "Zimbo")
        milk = services.describe_group(pending_group(MILK[0]))
        self.assertEqual([member.classified for member in milk.members], [True, False, True, False, False])
        self.assertEqual(milk.lines_count, 7)

    def test_description_after_confirm_uses_the_snapshot(self):
        self.detect()
        group = pending_group(EGGS[0])
        services.confirm(group.pk, version=1, target_product_id=group.target_ref)
        info = services.describe_group(services.get_group(group.pk))
        self.assertFalse(info.can_confirm or info.can_cancel or info.can_exclude)
        self.assertEqual((info.lines_count, info.new_lines_count, info.conflicts), (3, 0, []))
        gone = next(member for member in info.members if not member.exists)
        self.assertEqual((gone.name, gone.lines_count, gone.facts["package"]),
                         (EGGS[1], 1, {"quantity": "10.000", "unit": "pcs"}))
        self.assertEqual([alias.raw_name for alias in gone.aliases], [EGGS[1]])

    def test_description_of_a_cancelled_group(self):
        self.detect()
        group = pending_group(PIZZA[0])
        services.cancel(group.pk)
        info = services.describe_group(services.get_group(group.pk))
        self.assertEqual((info.lines_count, info.new_lines_count, info.conflicts), (0, 0, []))
        self.assertTrue(all(member.exists and not member.aliases for member in info.members))
        self.assertFalse(services.group_lines(info.group).exists())

    def test_group_lines_name_the_original_owner(self):
        self.detect()
        group = pending_group(PIZZA[0])
        new_line = add_line(product(PIZZA[0]), "Steinhof.PizzaSpezial")
        rows = [(str(line.receipt.purchased_on), line.raw_name, line.origin_product_id)
                for line in services.group_lines(group)]
        self.assertEqual(rows, [
            ("2026-06-09", "Steinof.PizzaSpezial", product("Steinof.PizzaSpezial").pk),
            ("2026-06-29", "Steinhof.PizzaSpezial", product("Steinhof.PizzaSpezial").pk),
            ("2026-07-06", "Steinof.PizzaSpezial", product("Steinof.PizzaSpezial").pk),
            ("2026-10-01", "Steinhof PizzaSpezial", product("Steinhof PizzaSpezial").pk),
            ("2026-11-02", "Steinhof.PizzaSpezial", None),
        ])
        with self.assertNumQueries(1):
            for line in services.group_lines(group):
                (line.receipt.store.merchant.brand_name, line.receipt.store.country_id, line.receipt.currency_id)
        services.confirm(group.pk, version=1, target_product_id=group.target_ref)
        confirmed = services.get_group(group.pk)
        self.assertEqual(services.group_lines(confirmed).count(), 4)
        self.assertNotIn(new_line.pk, services.group_lines(confirmed).values_list("pk", flat=True))

    def test_group_list_filters(self):
        self.detect()
        pizza, zimbo = pending_group(PIZZA[0]), pending_group(ZIMBO[0])
        services.cancel(pizza.pk)
        services.confirm(zimbo.pk, version=1, target_product_id=zimbo.target_ref)
        everything = list(services.groups())
        self.assertEqual([group.pk for group in everything], sorted((g.pk for g in everything), reverse=True))
        self.assertEqual(len(everything), 7)
        self.assertEqual(services.groups(status="pending").count(), 5)
        self.assertEqual(list(services.groups(status="cancelled")), [pizza])
        removed = zimbo.members.get(role="source").product_ref
        self.assertEqual(list(services.groups(product=removed)), [zimbo])
        self.assertEqual(list(services.groups(product=product(PIZZA[1]).pk, status="cancelled")), [pizza])
        self.assertEqual(list(services.groups(product=product("Pizza Hot Dog").pk)), [])

    def test_description_of_many_groups_uses_a_fixed_number_of_queries(self):
        self.detect()
        everything = list(services.groups())
        with self.assertNumQueries(6):
            infos = services.describe(everything[:2])
        self.assertEqual(len(infos), 2)
        with self.assertNumQueries(6):
            infos = services.describe(everything)
        self.assertEqual(len(infos), 7)
        with self.assertNumQueries(5):
            services.describe(everything, with_aliases=False)
        self.assertEqual(sum(bool(info.conflicts) for info in infos), 1)


@tag("integration")
class CommandTests(TestCase):
    def run_command(self, *args):
        out = io.StringIO()
        call_command(*args, stdout=out)
        return json.loads(out.getvalue())

    def test_seed_detect_and_cancel_pending(self):
        self.assertEqual(self.run_command("seed_product_merge_demo"), {
            "created": True, "merchants": 2, "products": len(demo.PRODUCTS), "receipts": len(demo.RECEIPTS),
            "lines": sum(len(rows) for *_, rows in demo.RECEIPTS),
        })
        seeded = snapshot(*DOMAIN_MODELS)
        self.assertEqual(self.run_command("seed_product_merge_demo"), {"created": False})
        self.assertEqual(snapshot(*DOMAIN_MODELS), seeded)

        dry = self.run_command("product_merges", "detect", "--dry-run")
        self.assertEqual((dry["dry_run"], dry["created"], dry["extended"], dry["group_ids"]), (True, 7, 0, []))
        self.assertEqual(len(dry["groups"]), 7)
        self.assertFalse(ProductMerge.objects.exists())
        self.assertEqual(snapshot(*DOMAIN_MODELS), seeded)

        done = self.run_command("product_merges", "detect")
        self.assertEqual((done["dry_run"], done["created"], done["extended"]), (False, 7, 0))
        self.assertEqual(sorted(done["group_ids"]), sorted(ProductMerge.objects.values_list("pk", flat=True)))
        again = self.run_command("product_merges", "detect")
        self.assertEqual((again["created"], again["extended"], again["group_ids"]), (0, 0, []))
        # Seeding after the merge must not recreate what was merged.
        self.assertEqual(self.run_command("seed_product_merge_demo"), {"created": False})

        cancelled = self.run_command("product_merges", "cancel-pending")
        self.assertEqual(sorted(cancelled["cancelled"]), sorted(done["group_ids"]))
        self.assertEqual(snapshot(*DOMAIN_MODELS), seeded)
        self.assertEqual(self.run_command("product_merges", "cancel-pending"), {"cancelled": []})
        self.assertEqual(self.run_command("product_merges", "detect")["created"], 0)

    def test_dry_run_belongs_to_detect(self):
        with self.assertRaises(CommandError):
            call_command("product_merges", "cancel-pending", "--dry-run", stdout=io.StringIO())

    def test_seed_refuses_a_non_test_database(self):
        before = snapshot(*DOMAIN_MODELS)
        for name in ("checkist_dev", "checkist"):
            with patch.dict(settings.DATABASES["default"], {"NAME": name}), self.assertRaises(CommandError):
                call_command("seed_product_merge_demo", stdout=io.StringIO())
        self.assertEqual(snapshot(*DOMAIN_MODELS), before)

    def test_demo_receipts_are_consistent(self):
        from receipts.validation import validate_receipt

        demo.seed_demo()
        receipts = Receipt.objects.filter(receipt_number__startswith="DEMO-MERGE-")
        self.assertEqual(receipts.count(), len(demo.RECEIPTS))
        for receipt in receipts:
            self.assertEqual(validate_receipt(receipt), [])
        self.assertEqual(ReceiptLine.objects.filter(product__isnull=True).count(), 0)
        self.assertEqual(MERGE_MODELS[0].objects.count(), 0)

    def test_busy_catalog_is_reported_by_the_command(self):
        with patch("merges.services.detect", side_effect=services.MergeBusy("merge_busy")):
            with self.assertRaises(CommandError):
                call_command("product_merges", "detect", stdout=io.StringIO())
