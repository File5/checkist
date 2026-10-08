from django.contrib import admin
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase, tag
from django.test.utils import CaptureQueriesContext

from catalog.models import Product
from merges import demo, services
from merges.models import (
    ProductMerge, ProductMergeAlias, ProductMergeLine, ProductMergeMember, ProductMergeRejection,
)
from merges.tests.factories import PIZZA, add_product, pending_group, product, snapshot
from receipts.models import ProductAlias, ReceiptLine


def admin_url(model, *parts):
    return "/".join((f"/admin/{model._meta.app_label}", model._meta.model_name, *map(str, parts), ""))


class MergesAdminTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.superuser = get_user_model().objects.create_superuser("root-user", password="test-only-password")
        demo.seed_demo()
        services.detect()

    def setUp(self):
        self.client.force_login(self.superuser)


@tag("integration")
class ReadOnlyTests(MergesAdminTestCase):
    def test_only_groups_and_members_are_registered(self):
        self.assertIn(ProductMerge, admin.site._registry)
        self.assertIn(ProductMergeMember, admin.site._registry)
        for model in (ProductMergeLine, ProductMergeAlias, ProductMergeRejection):
            self.assertNotIn(model, admin.site._registry)

    def test_lists_and_records_open(self):
        group = pending_group(PIZZA[0])
        member = group.members.get(role="target")
        response = self.client.get(admin_url(ProductMerge))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.context["cl"].result_count, 7)
        self.assertEqual(self.client.get(admin_url(ProductMerge), {"status__exact": "pending"}).status_code, 200)
        response = self.client.get(admin_url(ProductMerge, group.pk, "change"))
        self.assertEqual(response.status_code, 200)
        for name in PIZZA:
            self.assertContains(response, name)
        self.assertNotContains(response, 'name="_save"')
        response = self.client.get(admin_url(ProductMergeMember))
        self.assertEqual(response.context["cl"].result_count, 19)
        self.assertEqual(self.client.get(admin_url(ProductMergeMember), {"q": "Pizza"}).context["cl"].result_count, 3)
        response = self.client.get(admin_url(ProductMergeMember, member.pk, "change"))
        self.assertEqual(response.status_code, 200)
        self.assertNotContains(response, 'name="_save"')

    def test_group_shows_who_decided_read_only(self):
        group = pending_group(PIZZA[0])
        decider = get_user_model().objects.create_user("synthetic-decider")
        services.cancel(group.pk, actor=decider)
        self.assertIn("resolved_by", admin.site._registry[ProductMerge].list_display)
        self.assertContains(self.client.get(admin_url(ProductMerge)), "synthetic-decider")
        response = self.client.get(admin_url(ProductMerge, group.pk, "change"))
        self.assertContains(response, "synthetic-decider")
        self.assertNotContains(response, 'name="resolved_by"')
        before = snapshot()
        response = self.client.post(admin_url(ProductMerge, group.pk, "change"), {"resolved_by": self.superuser.pk})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(snapshot(), before)

    def test_changelist_with_deciders_does_not_query_per_row(self):
        def count():
            with CaptureQueriesContext(connection) as queries:
                self.assertEqual(self.client.get(admin_url(ProductMerge)).status_code, 200)
            return len(queries)

        first, second = (get_user_model().objects.create_user(f"synthetic-decider-{n}") for n in (1, 2))
        services.cancel(pending_group(PIZZA[0]).pk, actor=first)
        before = count()
        for group_id in ProductMerge.objects.filter(status="pending").values_list("pk", flat=True):
            services.cancel(group_id, actor=second)
        self.assertEqual(count(), before)

    def test_changelists_do_not_query_per_row(self):
        def count(model):
            with CaptureQueriesContext(connection) as queries:
                self.assertEqual(self.client.get(admin_url(model)).status_code, 200)
            return len(queries)

        before = {model: count(model) for model in (ProductMerge, ProductMergeMember)}
        add_product("Demo Senf Tube Mild")
        add_product("Demo Senf Tube Mild.")
        self.assertEqual(services.detect().created, 1)
        for model, queries in before.items():
            self.assertEqual(count(model), queries, model.__name__)

    def test_nothing_can_be_added_changed_or_deleted(self):
        group = pending_group(PIZZA[0])
        member = group.members.get(product_ref=product(PIZZA[1]).pk)
        before = snapshot()
        requests = (
            ("get", admin_url(ProductMerge, "add"), {}),
            ("post", admin_url(ProductMerge, "add"),
             {"status": "pending", "version": 1, "target_ref": 1, "detector_version": 1}),
            ("post", admin_url(ProductMerge, group.pk, "change"), {"status": "confirmed", "version": 9}),
            ("get", admin_url(ProductMerge, group.pk, "delete"), {}),
            ("post", admin_url(ProductMerge, group.pk, "delete"), {"post": "yes"}),
            ("get", admin_url(ProductMergeMember, "add"), {}),
            ("post", admin_url(ProductMergeMember, member.pk, "change"), {"role": "target", "state": "excluded"}),
            ("post", admin_url(ProductMergeMember, member.pk, "delete"), {"post": "yes"}),
        )
        for method, url, data in requests:
            with self.subTest(method=method, url=url):
                self.assertEqual(getattr(self.client, method)(url, data).status_code, 403)
        for model in (ProductMerge, ProductMergeMember):
            # Without the delete permission the bulk action is not offered at all.
            self.client.post(admin_url(model), {
                "action": "delete_selected", "post": "yes",
                "_selected_action": [str(pk) for pk in model.objects.values_list("pk", flat=True)],
            })
        self.assertEqual(snapshot(), before)

    def test_access_needs_staff_and_model_permissions(self):
        staff = get_user_model().objects.create_user("staff-user", password="test-only-password", is_staff=True)
        self.client.force_login(staff)
        self.assertEqual(self.client.get(admin_url(ProductMerge)).status_code, 403)
        self.client.logout()
        response = self.client.get(admin_url(ProductMerge))
        self.assertEqual(response.status_code, 302)
        self.assertIn("/admin/login/", response["Location"])


@tag("integration")
class ProductDeletionTests(MergesAdminTestCase):
    def test_product_of_a_pending_group_cannot_be_deleted(self):
        before = snapshot()
        for name in PIZZA:
            item = product(name)
            with self.subTest(name=name):
                response = self.client.get(admin_url(Product, item.pk, "delete"))
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.context["protected"])
                self.assertIn("productmergemember", "".join(map(str, response.context["protected"])))
                # Django's standard refusal: the confirmation page again, nothing deleted.
                response = self.client.post(admin_url(Product, item.pk, "delete"), {"post": "yes"})
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.context["protected"])
                self.assertTrue(Product.objects.filter(pk=item.pk).exists())
        self.assertEqual(snapshot(), before)

    def test_bulk_deletion_is_refused_too(self):
        before = snapshot()
        response = self.client.post(admin_url(Product), {
            "action": "delete_selected", "post": "yes",
            "_selected_action": [str(product(name).pk) for name in PIZZA],
        })
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.context["protected"])
        self.assertEqual(snapshot(), before)

    def test_deletion_works_again_after_cancel(self):
        services.cancel(pending_group(PIZZA[0]).pk)
        item = product(PIZZA[1])
        response = self.client.post(admin_url(Product, item.pk, "delete"), {"post": "yes"})
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Product.objects.filter(pk=item.pk).exists())
        self.assertTrue(ProductMergeMember.objects.filter(product_ref=item.pk).exists())

    def test_absorbed_product_stays_editable_and_links_show_the_survivor(self):
        group = pending_group(PIZZA[0])
        absorbed = product(PIZZA[1])
        self.assertEqual(self.client.get(admin_url(Product, absorbed.pk, "change")).status_code, 200)
        line = ReceiptLine.objects.get(raw_name=PIZZA[1])
        alias = ProductAlias.objects.get(raw_name=PIZZA[1])
        self.assertEqual((line.product_id, alias.product_id), (group.target_ref, group.target_ref))
        services.confirm(group.pk, version=1, target_product_id=group.target_ref)
        # A deleted product: Django's standard "does not exist" redirect to the admin index.
        self.assertEqual(self.client.get(admin_url(Product, absorbed.pk, "change")).status_code, 302)
        self.assertEqual(self.client.get(admin_url(Product, group.target_ref, "change")).status_code, 200)
