"""Service charges and tips on import and on a person's confirmation: no product, their own category."""
from tempfile import TemporaryDirectory

from django.test import TestCase, override_settings, tag

from catalog.models import Category, Product
from receipts import service_charges
from receipts.tests.test_service_charges import service_category
from recognition import review
from recognition.importer import import_receipt
from recognition.providers.fake import receipt_payload

from .import_fixtures import live_image, observation
from .test_review import fixed_body, review_image, wrong_total


def with_service(first="BROT", second="SERVICE 10%"):
    """The fake second receipt (6.00 EUR) whose second line is a service of the same amount."""
    data = receipt_payload(2)
    data["lines"][0]["raw_name"] = first
    data["lines"][0]["product_hint"]["name"] = first
    data["lines"][1].update(kind="service", raw_name=second)
    data["lines"][1]["product_hint"]["name"] = None
    return data


@tag("integration")
class ImportTests(TestCase):
    def setUp(self):
        media = TemporaryDirectory()
        self.addCleanup(media.cleanup)
        settings = override_settings(MEDIA_ROOT=media.name)
        settings.enable()
        self.addCleanup(settings.disable)
        self.category = service_category()

    def run_import(self, data):
        image, job = live_image()
        return import_receipt(image, observation(data), run_token=job.run_token, version=job.version)

    def lines(self, receipt):
        return {line.raw_name: (line.kind, line.product_id, line.category_id) for line in receipt.lines.all()}

    def test_service_charge_gets_its_category_and_no_product(self):
        result = self.run_import(with_service())
        self.assertEqual(result.outcome, "created")
        lines = self.lines(result.receipt)
        self.assertEqual(lines["SERVICE 10%"], ("service", None, self.category.pk))
        kind, product, category = lines["BROT"]
        self.assertEqual((kind, category), ("product", None))
        self.assertIsNotNone(product)
        self.assertFalse(Product.objects.filter(name__icontains="service").exists())

    def test_other_services_stay_as_they_were(self):
        result = self.run_import(with_service(second="LIEFERUNG"))
        self.assertEqual(self.lines(result.receipt)["LIEFERUNG"], ("service", None, None))

    def test_a_product_named_like_a_service_is_a_product(self):
        result = self.run_import(with_service(first="Сервиз чайный"))
        self.assertEqual(self.lines(result.receipt)["Сервиз чайный"][2], None)

    def test_missing_category_leaves_the_line_without_one(self):
        Category.objects.filter(pk=self.category.pk).delete()
        result = self.run_import(with_service())
        self.assertEqual(result.outcome, "created")
        self.assertEqual(self.lines(result.receipt)["SERVICE 10%"], ("service", None, None))

    def test_a_linked_duplicate_is_not_rewritten(self):
        Category.objects.filter(pk=self.category.pk).delete()
        first = self.run_import(with_service())
        self.category = service_category()
        # The same receipt photographed again: its saved line is changed only by «service_charges backfill».
        again = self.run_import(with_service())
        self.assertIn(again.outcome, ("linked", "updated"))
        self.assertEqual(again.receipt.pk, first.receipt.pk)
        self.assertEqual(self.lines(again.receipt)["SERVICE 10%"], ("service", None, None))


@tag("integration")
class ConfirmTests(TestCase):
    def setUp(self):
        self.category = service_category()

    def test_confirmed_service_charge_gets_its_category(self):
        image = review_image(wrong_total(2))
        body = fixed_body(2)
        body["lines"][1].update(kind="service", name="Обслуживание 10%")
        review.confirm(image.pk, body)
        image.refresh_from_db()
        line = image.receipt.lines.get(position=2)
        self.assertEqual((line.kind, line.product_id, line.category_id), ("service", None, self.category.pk))
        self.assertIsNone(image.receipt.lines.get(position=1).category_id)

    def test_confirmed_other_service_has_no_category(self):
        image = review_image(wrong_total(2))
        body = fixed_body(2)
        body["lines"][1].update(kind="service", name="Доставка")
        review.confirm(image.pk, body)
        image.refresh_from_db()
        self.assertIsNone(image.receipt.lines.get(position=2).category_id)
        self.assertEqual(service_charges.category_id(), self.category.pk)
