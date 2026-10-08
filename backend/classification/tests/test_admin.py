from django.contrib import admin
from django.contrib.auth import get_user_model
from django.test import TestCase, tag

from catalog.models import Category, GenericProduct, Product
from classification import demo, services
from classification.models import (
    ClassificationAttempt, ClassificationRejection, ClassificationRun, CreatedCategory, CreatedGenericProduct,
    ProductClassification,
)
from classification.tests.factories import CHEESE, JUICE, MILK, generic, product, record, snapshot, suggest

REGISTERED = (ProductClassification, ClassificationRun, CreatedGenericProduct, CreatedCategory)


def admin_url(model, *parts):
    return "/".join((f"/admin/{model._meta.app_label}", model._meta.model_name, *map(str, parts), ""))


@tag("integration")
class ClassificationAdminTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.superuser = get_user_model().objects.create_superuser("root-user", password="test-only-password")
        demo.seed_demo()
        suggest()

    def setUp(self):
        self.client.force_login(self.superuser)

    def test_registered_models(self):
        for model in REGISTERED:
            self.assertIn(model, admin.site._registry)
        # The rejection memory cascades from a product: a read-only registration would block its deletion.
        # Attempts keep private model output.
        for model in (ClassificationRejection, ClassificationAttempt):
            self.assertNotIn(model, admin.site._registry)

    def test_lists_and_records_open_read_only(self):
        counts = {ProductClassification: 9, ClassificationRun: 1, CreatedGenericProduct: 6, CreatedCategory: 4}
        for model in REGISTERED:
            with self.subTest(model=model.__name__):
                response = self.client.get(admin_url(model))
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.context["cl"].result_count, counts[model])
                response = self.client.get(admin_url(model, model.objects.first().pk, "change"))
                self.assertEqual(response.status_code, 200)
                self.assertNotContains(response, 'name="_save"')
        self.assertEqual(self.client.get(admin_url(ProductClassification), {"status__exact": "pending"}).status_code, 200)
        self.assertEqual(self.client.get(admin_url(ProductClassification), {"q": "Kefir"}).context["cl"].result_count, 2)
        self.assertNotContains(
            self.client.get(admin_url(ClassificationRun, ClassificationRun.objects.get().pk, "change")), "run_token",
        )

    def test_records_and_runs_show_who_decided_read_only(self):
        decider = get_user_model().objects.create_user("synthetic-decider")
        entry = services.reject(record(MILK).pk, version=1, actor=decider)
        run, created = services.request_run(trigger="manual", actor=decider)
        self.assertTrue(created)
        self.assertIn("resolved_by", admin.site._registry[ProductClassification].list_display)
        self.assertIn("requested_by", admin.site._registry[ClassificationRun].list_display)
        before = snapshot()
        for model, pk, field in (
            (ProductClassification, entry.pk, "resolved_by"), (ClassificationRun, run.pk, "requested_by"),
        ):
            with self.subTest(model=model.__name__):
                self.assertContains(self.client.get(admin_url(model)), "synthetic-decider")
                response = self.client.get(admin_url(model, pk, "change"))
                self.assertContains(response, "synthetic-decider")
                self.assertNotContains(response, f'name="{field}"')
                response = self.client.post(admin_url(model, pk, "change"), {field: self.superuser.pk})
                self.assertEqual(response.status_code, 403)
        self.assertEqual(snapshot(), before)

    def test_nothing_can_be_added_changed_or_deleted(self):
        before = snapshot()
        for model in REGISTERED:
            with self.subTest(model=model.__name__):
                pk = model.objects.first().pk
                self.assertEqual(self.client.get(admin_url(model, "add")).status_code, 403)
                self.assertEqual(self.client.post(admin_url(model, "add"), {}).status_code, 403)
                self.assertEqual(self.client.post(admin_url(model, pk, "change"), {"status": "confirmed"}).status_code, 403)
                self.assertEqual(self.client.get(admin_url(model, pk, "delete")).status_code, 403)
                self.assertEqual(self.client.post(admin_url(model, pk, "delete"), {"post": "yes"}).status_code, 403)
                response = self.client.post(admin_url(model), {"action": "delete_selected", "_selected_action": [pk]})
                self.assertNotEqual(response.status_code, 302)
        self.assertEqual(snapshot(), before)

    def test_product_with_a_pending_record_and_a_rejection_can_be_deleted(self):
        services.reject(record(CHEESE).pk, version=1)
        for name in (JUICE, CHEESE):
            with self.subTest(name=name):
                target = product(name)
                page = self.client.get(admin_url(Product, target.pk, "delete"))
                self.assertEqual(page.status_code, 200)
                self.assertEqual(page.context["perms_lacking"], set())
                self.assertEqual(page.context["protected"], [])
                response = self.client.post(admin_url(Product, target.pk, "delete"), {"post": "yes"})
                self.assertEqual(response.status_code, 302)
                self.assertFalse(Product.objects.filter(pk=target.pk).exists())
        pending = record(JUICE)
        self.assertEqual((pending.status, pending.active_product_id), ("pending", None))
        self.assertFalse(ClassificationRejection.objects.exists())
        # The next reconciliation closes the orphan.
        self.assertEqual(services.reconcile(), 1)
        self.assertEqual(record(JUICE).resolution, "product_removed")

    def test_catalog_admin_still_edits_suggested_records(self):
        juice = generic("Сок")
        response = self.client.post(admin_url(GenericProduct, juice.pk, "change"), {
            "name": "Соки", "category": juice.category_id, "base_unit": "l",
        })
        self.assertEqual(response.status_code, 302)
        target = product(MILK)
        response = self.client.post(admin_url(Product, target.pk, "change"), {
            "generic": juice.pk, "name": target.name, "model": "", "gtin": "", "package_unit": "",
            "attributes": "{}",
        })
        self.assertEqual(response.status_code, 302)
        self.assertEqual(product(MILK).generic.name, "Соки")
        # A created generic product that is used cannot be deleted in the admin, as any other one.
        page = self.client.get(admin_url(GenericProduct, juice.pk, "delete"))
        self.assertTrue(page.context["protected"])
        # The service follows the human: one snapshot is updated, the record of the moved product steps aside.
        self.assertEqual(services.reconcile(), 2)
        self.assertEqual((record(JUICE).status, record(JUICE).suggested_generic_name), ("pending", "Соки"))
        self.assertEqual((record(MILK).status, record(MILK).resolution, record(MILK).final_generic_name), (
            "superseded", "changed", "Соки"))
        self.assertEqual(product(MILK).generic.name, "Соки")
        self.assertTrue(Category.objects.filter(name="Напитки").exists())
