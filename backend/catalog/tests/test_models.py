from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import ProtectedError
from django.test import TestCase, tag

from catalog.models import Brand, Category, GenericProduct, Product
from catalog.units import BaseUnit, Unit


class CatalogTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.food = Category.objects.create(name="Продукты питания")
        cls.dairy = Category.objects.create(name="Молочные", parent=cls.food)
        cls.milk = GenericProduct.objects.create(
            name="Молоко", category=cls.dairy, base_unit=BaseUnit.L,
        )
        cls.brand = Brand.objects.create(name="Müller")

    def assert_rejected(self, constraint, create):
        with self.assertRaises(IntegrityError) as raised, transaction.atomic():
            create()
        self.assertIn(constraint, str(raised.exception))


@tag("integration")
class UniquenessTests(CatalogTestCase):
    def test_category_name_is_unique_within_parent(self):
        self.assert_rejected(
            "catalog_category_parent_name_uniq",
            lambda: Category.objects.create(name="Молочные", parent=self.food),
        )

    def test_root_category_name_is_unique(self):
        self.assert_rejected(
            "catalog_category_parent_name_uniq",
            lambda: Category.objects.create(name="Продукты питания"),
        )

    def test_same_category_name_under_another_parent_is_allowed(self):
        electronics = Category.objects.create(name="Электроника")
        Category.objects.create(name="Молочные", parent=electronics)
        Category.objects.create(name="Молочные")
        self.assertEqual(Category.objects.filter(name="Молочные").count(), 3)

    def test_generic_product_name_is_unique_ignoring_case(self):
        self.assert_rejected(
            "catalog_genericproduct_name_uniq",
            lambda: GenericProduct.objects.create(
                name="МОЛОКО", category=self.food, base_unit=BaseUnit.KG,
            ),
        )

    def test_brand_name_is_unique_ignoring_case(self):
        for name in ("Müller", "müller", "MÜLLER"):
            with self.subTest(name=name):
                self.assert_rejected(
                    "catalog_brand_name_uniq", lambda: Brand.objects.create(name=name),
                )
        Brand.objects.create(name="Muller")

    def test_gtin_is_unique(self):
        Product.objects.create(generic=self.milk, name="Молоко 2,5%", gtin="4000000000013")
        self.assert_rejected(
            "catalog_product_gtin_uniq",
            lambda: Product.objects.create(
                generic=self.milk, name="Молоко 3,2%", gtin="4000000000013",
            ),
        )

    def test_empty_gtin_is_allowed_for_several_products(self):
        Product.objects.create(generic=self.milk, name="Молоко 2,5%")
        Product.objects.create(generic=self.milk, name="Молоко 3,2%")
        self.assertEqual(Product.objects.filter(gtin="").count(), 2)

    def test_product_identity_is_unique(self):
        fields = {
            "generic": self.milk, "brand": self.brand, "name": "Молоко 2,5%",
            "package_quantity": Decimal("0.850"), "package_unit": Unit.L,
        }
        Product.objects.create(**fields)
        self.assert_rejected(
            "catalog_product_brand_name_package_uniq",
            lambda: Product.objects.create(**fields),
        )
        Product.objects.create(**{**fields, "package_quantity": Decimal("1.000")})
        Product.objects.create(**{**fields, "package_unit": Unit.KG})
        Product.objects.create(**{**fields, "name": "Молоко 3,2%"})
        Product.objects.create(**{**fields, "brand": None})

    def test_product_identity_is_unique_with_nulls(self):
        cases = {
            "без бренда": {
                "brand": None, "package_quantity": Decimal("350"), "package_unit": Unit.ML,
            },
            "без фасовки": {"brand": self.brand},
            "без бренда и фасовки": {"brand": None},
        }
        for name, fields in cases.items():
            with self.subTest(name=name):
                Product.objects.create(generic=self.milk, name=name, **fields)
                self.assert_rejected(
                    "catalog_product_brand_name_package_uniq",
                    lambda: Product.objects.create(generic=self.milk, name=name, **fields),
                )


@tag("integration")
class CheckConstraintTests(CatalogTestCase):
    def test_package_quantity_without_unit_is_rejected(self):
        self.assert_rejected(
            "catalog_product_package_both_or_none",
            lambda: Product.objects.create(
                generic=self.milk, name="Молоко", package_quantity=Decimal("1"),
            ),
        )

    def test_package_unit_without_quantity_is_rejected(self):
        self.assert_rejected(
            "catalog_product_package_both_or_none",
            lambda: Product.objects.create(
                generic=self.milk, name="Молоко", package_unit=Unit.L,
            ),
        )

    def test_non_positive_package_quantity_is_rejected(self):
        for quantity in (Decimal("0"), Decimal("-0.001"), Decimal("-1")):
            with self.subTest(quantity=quantity):
                self.assert_rejected(
                    "catalog_product_package_quantity_positive",
                    lambda: Product.objects.create(
                        generic=self.milk, name="Молоко",
                        package_quantity=quantity, package_unit=Unit.L,
                    ),
                )

    def test_complete_and_empty_package_are_saved(self):
        packed = Product.objects.create(
            generic=self.milk, brand=self.brand, name="Молоко 2,5%",
            package_quantity=Decimal("0.449"), package_unit=Unit.L,
            attributes={"fat_percent": 2.5, "packaging": "пэт"},
        )
        loose = Product.objects.create(generic=self.milk, name="Молоко разливное")
        packed.refresh_from_db()
        loose.refresh_from_db()
        self.assertEqual(packed.package_quantity, Decimal("0.449"))
        self.assertEqual(packed.attributes, {"fat_percent": 2.5, "packaging": "пэт"})
        self.assertIsNone(loose.package_quantity)
        self.assertEqual(
            (loose.package_unit, loose.gtin, loose.model, loose.attributes), ("", "", "", {}),
        )


@tag("integration")
class ProtectTests(CatalogTestCase):
    def test_category_with_child_cannot_be_deleted(self):
        with self.assertRaises(ProtectedError):
            self.food.delete()

    def test_category_with_generic_product_cannot_be_deleted(self):
        with self.assertRaises(ProtectedError):
            self.dairy.delete()

    def test_generic_product_with_product_cannot_be_deleted(self):
        Product.objects.create(generic=self.milk, name="Молоко 2,5%")
        with self.assertRaises(ProtectedError):
            self.milk.delete()

    def test_brand_with_product_cannot_be_deleted(self):
        Product.objects.create(generic=self.milk, brand=self.brand, name="Молоко 2,5%")
        with self.assertRaises(ProtectedError):
            self.brand.delete()

    def test_database_rejects_delete_bypassing_orm(self):
        # ProtectedError is raised by the ORM collector; the FK itself must hold too.
        Product.objects.create(generic=self.milk, brand=self.brand, name="Молоко 2,5%")
        for queryset in (
            Brand.objects.filter(pk=self.brand.pk),
            GenericProduct.objects.filter(pk=self.milk.pk),
            Category.objects.filter(pk=self.dairy.pk),
            Category.objects.filter(pk=self.food.pk),
        ):
            with self.subTest(model=queryset.model.__name__):
                with self.assertRaises(IntegrityError), transaction.atomic():
                    queryset._raw_delete(queryset.db)
                    # FK constraints are deferred: force the check inside the block.
                    transaction.get_connection().check_constraints()

    def test_unreferenced_objects_are_deleted(self):
        product = Product.objects.create(
            generic=self.milk, brand=self.brand, name="Молоко 2,5%",
        )
        product.delete()
        self.brand.delete()
        self.milk.delete()
        self.dairy.delete()
        self.food.delete()
        self.assertFalse(Category.objects.exists())
