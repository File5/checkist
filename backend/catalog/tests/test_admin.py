from decimal import Decimal

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import Client, TestCase, tag
from django.test.utils import CaptureQueriesContext

from catalog.models import Brand, Category, GenericProduct, Product
from catalog.units import BaseUnit, Unit

MODELS = (Category, GenericProduct, Brand, Product)
AUTOCOMPLETE_FIELDS = (
    (Category, "parent"),
    (GenericProduct, "category"),
    (Product, "generic"),
    (Product, "brand"),
)


def admin_url(model, *parts):
    return "/".join(("/admin/catalog", model._meta.model_name, *map(str, parts), ""))


class CatalogAdminTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        users = get_user_model().objects
        cls.superuser = users.create_superuser("root-user", password="test-only-password")
        cls.plain_user = users.create_user("plain-user", password="test-only-password")
        cls.staff_user = users.create_user(
            "staff-user", password="test-only-password", is_staff=True,
        )
        cls.food = Category.objects.create(name="Продукты питания")
        cls.dairy = Category.objects.create(name="Молочные", parent=cls.food)
        cls.yogurts = Category.objects.create(name="Йогурты", parent=cls.dairy)
        cls.milk = GenericProduct.objects.create(
            name="Молоко", category=cls.dairy, base_unit=BaseUnit.L,
        )
        cls.brand = Brand.objects.create(name="Müller", manufacturer="Молочный завод № 1")
        cls.product = Product.objects.create(
            generic=cls.milk, brand=cls.brand, name="Молоко 2,5%", model="M-25",
            gtin="4000000000013", package_quantity=Decimal("0.850"), package_unit=Unit.L,
        )
        cls.objects = {
            Category: cls.dairy, GenericProduct: cls.milk, Brand: cls.brand, Product: cls.product,
        }

    def setUp(self):
        self.client = Client()
        self.client.force_login(self.superuser)

    def product_data(self, **overrides):
        return {
            "generic": self.milk.pk, "brand": "", "name": "Молоко 3,2%", "model": "",
            "gtin": "", "package_quantity": "", "package_unit": "", "attributes": "{}",
            **overrides,
        }

    def assert_form_error(self, response, field, fragment):
        """The form was shown again with ``fragment`` among the errors of ``field``."""
        self.assertEqual(response.status_code, 200)
        errors = response.context["adminform"].form.errors
        self.assertIn(field, errors, errors)
        self.assertIn(fragment, " ".join(errors[field]))


@tag("integration")
class RegistrationTests(CatalogAdminTestCase):
    def test_models_are_registered(self):
        for model in MODELS:
            with self.subTest(model=model.__name__):
                self.assertTrue(admin.site.is_registered(model))

    def test_list_options_are_explicit(self):
        for model in MODELS:
            with self.subTest(model=model.__name__):
                model_admin = admin.site.get_model_admin(model)
                self.assertEqual(model_admin.ordering, ("name",))
                self.assertTrue(model_admin.search_fields)
        self.assertEqual(admin.site.get_model_admin(Category).list_select_related, ("parent",))
        self.assertEqual(
            admin.site.get_model_admin(GenericProduct).list_select_related, ("category",),
        )
        self.assertEqual(
            admin.site.get_model_admin(Product).list_select_related, ("brand", "generic"),
        )


@tag("integration")
class AccessTests(CatalogAdminTestCase):
    def urls(self, model):
        return (
            admin_url(model),
            admin_url(model, "add"),
            admin_url(model, self.objects[model].pk, "change"),
        )

    def assert_redirected_to_login(self):
        for model in MODELS:
            for url in self.urls(model):
                with self.subTest(url=url):
                    response = self.client.get(url)
                    self.assertRedirects(
                        response, f"/admin/login/?next={url}", fetch_redirect_response=False,
                    )

    def test_anonymous_is_redirected_to_login(self):
        self.client.logout()
        self.assert_redirected_to_login()

    def test_user_without_is_staff_is_redirected_to_login(self):
        self.client.force_login(self.plain_user)
        self.assert_redirected_to_login()

    def test_staff_without_model_permissions_is_forbidden(self):
        self.client.force_login(self.staff_user)
        for model in MODELS:
            for url in self.urls(model):
                with self.subTest(url=url):
                    self.assertEqual(self.client.get(url).status_code, 403)

    def test_superuser_gets_changelist_add_and_change(self):
        for model in MODELS:
            for url in self.urls(model):
                with self.subTest(url=url):
                    self.assertEqual(self.client.get(url).status_code, 200)

    def test_anonymous_post_does_not_create_object(self):
        self.client.logout()
        url = admin_url(Brand, "add")
        response = self.client.post(url, {"name": "Anonymous brand", "manufacturer": ""})
        self.assertRedirects(response, f"/admin/login/?next={url}", fetch_redirect_response=False)
        self.assertFalse(Brand.objects.filter(name="Anonymous brand").exists())


@tag("integration")
class ChangelistTests(CatalogAdminTestCase):
    def results(self, model, query):
        response = self.client.get(admin_url(model), query)
        self.assertEqual(response.status_code, 200)
        return list(response.context["cl"].result_list)

    def test_search(self):
        other_generic = GenericProduct.objects.create(
            name="Кефир", category=self.dairy, base_unit=BaseUnit.L,
        )
        other_brand = Brand.objects.create(name="Alpen", manufacturer="Горная ферма")
        other_product = Product.objects.create(
            generic=other_generic, brand=other_brand, name="Кефир 1%", model="K-10",
            gtin="4000000000020",
        )
        cases = (
            (Category, "Молоч", [self.dairy]),
            (GenericProduct, "Кеф", [other_generic]),
            (Brand, "Alp", [other_brand]),
            (Brand, "Горная", [other_brand]),
            (Product, "Кефир", [other_product]),
            (Product, "4000000000020", [other_product]),
            (Product, "K-10", [other_product]),
            (Product, "Alpen", [other_product]),
            (Product, "нет такого", []),
        )
        for model, term, expected in cases:
            with self.subTest(model=model.__name__, term=term):
                self.assertEqual(self.results(model, {"q": term}), expected)

    def test_generic_product_base_unit_filter(self):
        eggs = GenericProduct.objects.create(
            name="Яйца", category=self.food, base_unit=BaseUnit.PCS,
        )
        self.assertEqual(self.results(GenericProduct, {"base_unit__exact": "pcs"}), [eggs])
        self.assertEqual(self.results(GenericProduct, {"base_unit__exact": "l"}), [self.milk])
        self.assertEqual(self.results(GenericProduct, {"base_unit__exact": "kg"}), [])

    def test_product_package_unit_filter(self):
        loose = Product.objects.create(generic=self.milk, name="Молоко разливное")
        self.assertEqual(self.results(Product, {"package_unit__exact": "l"}), [self.product])
        self.assertEqual(self.results(Product, {"package_unit__exact": "g"}), [])
        self.assertEqual(self.results(Product, {"package_unit__exact": ""}), [loose])

    def test_default_ordering_is_by_name(self):
        Brand.objects.create(name="Alpen")
        Brand.objects.create(name="Zott")
        names = [brand.name for brand in self.results(Brand, {})]
        self.assertEqual(names, ["Alpen", "Müller", "Zott"])


@tag("integration")
class ChangelistQueryCountTests(CatalogAdminTestCase):
    """The number of changelist queries must not depend on the number of rows."""

    def count_queries(self, model, expected_rows):
        url = admin_url(model)
        # The first request also loads what is cached afterwards.
        self.client.get(url)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.context["cl"].result_list), expected_rows)
        return len(queries)

    def assert_constant(self, model, add_rows, rows_after):
        model.objects.exclude(pk=self.objects[model].pk).delete()
        single = self.count_queries(model, 1)
        add_rows()
        self.assertEqual(self.count_queries(model, rows_after), single)

    def test_category(self):
        Product.objects.all().delete()
        GenericProduct.objects.all().delete()
        self.yogurts.delete()
        self.dairy.delete()
        self.objects = {Category: self.food}

        def add_rows():
            for index in range(5):
                root = Category.objects.create(name=f"Раздел {index}")
                Category.objects.create(name=f"Подраздел {index}", parent=root)

        self.assert_constant(Category, add_rows, 11)

    def test_generic_product(self):
        Product.objects.all().delete()

        def add_rows():
            for index in range(8):
                category = Category.objects.create(name=f"Раздел {index}")
                GenericProduct.objects.create(
                    name=f"Продукт {index}", category=category, base_unit=BaseUnit.KG,
                )

        self.assert_constant(GenericProduct, add_rows, 9)

    def test_brand(self):
        def add_rows():
            for index in range(8):
                Brand.objects.create(name=f"Бренд {index}")

        self.assert_constant(Brand, add_rows, 9)

    def test_product(self):
        def add_rows():
            for index in range(5):
                generic = GenericProduct.objects.create(
                    name=f"Продукт {index}", category=self.dairy, base_unit=BaseUnit.KG,
                )
                brand = Brand.objects.create(name=f"Бренд {index}")
                Product.objects.create(generic=generic, brand=brand, name=f"Товар {index}")
                Product.objects.create(generic=generic, name=f"Товар без бренда {index}")

        self.assert_constant(Product, add_rows, 11)

    def test_product_without_brand_only(self):
        Product.objects.all().delete()
        self.objects = {
            Product: Product.objects.create(generic=self.milk, name="Молоко разливное"),
        }

        def add_rows():
            for index in range(5):
                Product.objects.create(generic=self.milk, name=f"Товар без бренда {index}")

        self.assert_constant(Product, add_rows, 6)


@tag("integration")
class SaveTests(CatalogAdminTestCase):
    def assert_saved(self, response, model):
        self.assertRedirects(response, admin_url(model), fetch_redirect_response=False)

    def test_add_category(self):
        response = self.client.post(
            admin_url(Category, "add"), {"name": "Сыры", "parent": self.dairy.pk},
        )
        self.assert_saved(response, Category)
        self.assertEqual(Category.objects.get(name="Сыры").parent, self.dairy)

    def test_add_root_category(self):
        response = self.client.post(admin_url(Category, "add"), {"name": "Бытовая химия", "parent": ""})
        self.assert_saved(response, Category)
        self.assertIsNone(Category.objects.get(name="Бытовая химия").parent)

    def test_change_category(self):
        drinks = Category.objects.create(name="Напитки")
        response = self.client.post(
            admin_url(Category, self.yogurts.pk, "change"),
            {"name": "Питьевые йогурты", "parent": drinks.pk},
        )
        self.assert_saved(response, Category)
        self.yogurts.refresh_from_db()
        self.assertEqual((self.yogurts.name, self.yogurts.parent), ("Питьевые йогурты", drinks))

    def test_change_category_keeping_its_parent(self):
        response = self.client.post(
            admin_url(Category, self.yogurts.pk, "change"),
            {"name": "Йогурты и десерты", "parent": self.dairy.pk},
        )
        self.assert_saved(response, Category)
        self.yogurts.refresh_from_db()
        self.assertEqual((self.yogurts.name, self.yogurts.parent), ("Йогурты и десерты", self.dairy))

    def test_add_generic_product(self):
        response = self.client.post(
            admin_url(GenericProduct, "add"),
            {"name": "Кефир", "category": self.dairy.pk, "base_unit": "l"},
        )
        self.assert_saved(response, GenericProduct)
        kefir = GenericProduct.objects.get(name="Кефир")
        self.assertEqual((kefir.category, kefir.base_unit), (self.dairy, BaseUnit.L))

    def test_change_generic_product(self):
        response = self.client.post(
            admin_url(GenericProduct, self.milk.pk, "change"),
            {"name": "Молоко питьевое", "category": self.food.pk, "base_unit": "kg"},
        )
        self.assert_saved(response, GenericProduct)
        self.milk.refresh_from_db()
        self.assertEqual(
            (self.milk.name, self.milk.category, self.milk.base_unit),
            ("Молоко питьевое", self.food, BaseUnit.KG),
        )

    def test_generic_product_rejects_unknown_base_unit(self):
        response = self.client.post(
            admin_url(GenericProduct, "add"),
            {"name": "Ткань", "category": self.food.pk, "base_unit": "m"},
        )
        self.assert_form_error(response, "base_unit", "m")
        self.assertFalse(GenericProduct.objects.filter(name="Ткань").exists())

    def test_add_brand(self):
        response = self.client.post(
            admin_url(Brand, "add"), {"name": "Alpen", "manufacturer": "Горная ферма"},
        )
        self.assert_saved(response, Brand)
        self.assertEqual(Brand.objects.get(name="Alpen").manufacturer, "Горная ферма")

    def test_change_brand(self):
        response = self.client.post(
            admin_url(Brand, self.brand.pk, "change"), {"name": "Mueller", "manufacturer": ""},
        )
        self.assert_saved(response, Brand)
        self.brand.refresh_from_db()
        self.assertEqual((self.brand.name, self.brand.manufacturer), ("Mueller", ""))

    def test_change_brand_keeping_its_name(self):
        response = self.client.post(
            admin_url(Brand, self.brand.pk, "change"),
            {"name": "MÜLLER", "manufacturer": "Молочный завод № 2"},
        )
        self.assert_saved(response, Brand)
        self.brand.refresh_from_db()
        self.assertEqual((self.brand.name, self.brand.manufacturer), ("MÜLLER", "Молочный завод № 2"))

    def test_add_product(self):
        response = self.client.post(admin_url(Product, "add"), self.product_data(
            brand=self.brand.pk, model="M-32", gtin="4000000000037",
            package_quantity="0.449", package_unit="l",
            attributes='{"fat_percent": 3.2}',
        ))
        self.assert_saved(response, Product)
        product = Product.objects.get(name="Молоко 3,2%")
        self.assertEqual(
            (product.generic, product.brand, product.model, product.gtin),
            (self.milk, self.brand, "M-32", "4000000000037"),
        )
        self.assertEqual((product.package_quantity, product.package_unit), (Decimal("0.449"), Unit.L))
        self.assertEqual(product.attributes, {"fat_percent": 3.2})

    def test_add_product_without_brand_and_package(self):
        response = self.client.post(admin_url(Product, "add"), self.product_data())
        self.assert_saved(response, Product)
        product = Product.objects.get(name="Молоко 3,2%")
        self.assertIsNone(product.brand)
        self.assertIsNone(product.package_quantity)
        self.assertEqual((product.package_unit, product.gtin, product.attributes), ("", "", {}))

    def test_several_products_without_gtin_are_saved(self):
        for name in ("Молоко 3,2%", "Молоко 6%"):
            response = self.client.post(admin_url(Product, "add"), self.product_data(name=name))
            self.assert_saved(response, Product)
        self.assertEqual(Product.objects.filter(gtin="").count(), 2)

    def test_change_product(self):
        response = self.client.post(
            admin_url(Product, self.product.pk, "change"),
            self.product_data(
                name="Молоко 2,5% пэт", gtin="4000000000013",
                package_quantity="900", package_unit="ml",
            ),
        )
        self.assert_saved(response, Product)
        self.product.refresh_from_db()
        self.assertEqual(self.product.name, "Молоко 2,5% пэт")
        self.assertIsNone(self.product.brand)
        self.assertEqual(
            (self.product.package_quantity, self.product.package_unit), (Decimal("900"), Unit.ML),
        )


@tag("integration")
class ConstraintErrorTests(CatalogAdminTestCase):
    """A violated unique or check constraint is a form error, not a server error."""

    def test_duplicate_category_within_parent(self):
        response = self.client.post(
            admin_url(Category, "add"), {"name": "Молочные", "parent": self.food.pk},
        )
        self.assert_form_error(response, "__all__", "Parent и Name уже существует")
        self.assertEqual(Category.objects.filter(name="Молочные").count(), 1)

    def test_duplicate_root_category(self):
        response = self.client.post(
            admin_url(Category, "add"), {"name": "Продукты питания", "parent": ""},
        )
        self.assert_form_error(response, "__all__", "Parent и Name уже существует")
        self.assertEqual(Category.objects.filter(name="Продукты питания").count(), 1)

    def test_category_renamed_to_duplicate(self):
        cheese = Category.objects.create(name="Сыры", parent=self.dairy)
        response = self.client.post(
            admin_url(Category, cheese.pk, "change"), {"name": "Йогурты", "parent": self.dairy.pk},
        )
        self.assert_form_error(response, "__all__", "Parent и Name уже существует")
        cheese.refresh_from_db()
        self.assertEqual(cheese.name, "Сыры")

    def test_duplicate_generic_product_ignoring_case(self):
        response = self.client.post(
            admin_url(GenericProduct, "add"),
            {"name": "МОЛОКО", "category": self.food.pk, "base_unit": "kg"},
        )
        self.assert_form_error(response, "__all__", "catalog_genericproduct_name_uniq")
        self.assertEqual(GenericProduct.objects.count(), 1)

    def test_generic_product_renamed_to_duplicate(self):
        kefir = GenericProduct.objects.create(
            name="Кефир", category=self.dairy, base_unit=BaseUnit.L,
        )
        response = self.client.post(
            admin_url(GenericProduct, kefir.pk, "change"),
            {"name": "молоко", "category": self.dairy.pk, "base_unit": "l"},
        )
        self.assert_form_error(response, "__all__", "catalog_genericproduct_name_uniq")
        kefir.refresh_from_db()
        self.assertEqual(kefir.name, "Кефир")

    def test_duplicate_brand_ignoring_case(self):
        for name in ("Müller", "müller", "MÜLLER"):
            with self.subTest(name=name):
                response = self.client.post(
                    admin_url(Brand, "add"), {"name": name, "manufacturer": ""},
                )
                self.assert_form_error(response, "__all__", "catalog_brand_name_uniq")
        self.assertEqual(Brand.objects.count(), 1)

    def test_duplicate_gtin(self):
        response = self.client.post(
            admin_url(Product, "add"), self.product_data(gtin="4000000000013"),
        )
        self.assert_form_error(response, "__all__", "catalog_product_gtin_uniq")
        self.assertEqual(Product.objects.count(), 1)

    def test_product_changed_to_duplicate_gtin(self):
        other = Product.objects.create(generic=self.milk, name="Молоко 3,2%")
        response = self.client.post(
            admin_url(Product, other.pk, "change"), self.product_data(gtin="4000000000013"),
        )
        self.assert_form_error(response, "__all__", "catalog_product_gtin_uniq")
        other.refresh_from_db()
        self.assertEqual(other.gtin, "")

    def test_duplicate_product_identity(self):
        response = self.client.post(admin_url(Product, "add"), self.product_data(
            brand=self.brand.pk, name="Молоко 2,5%", package_quantity="0.850", package_unit="l",
        ))
        self.assert_form_error(response, "__all__", "Package unit уже существует")
        self.assertEqual(Product.objects.count(), 1)

    def test_duplicate_product_identity_without_brand_and_package(self):
        Product.objects.create(generic=self.milk, name="Молоко разливное")
        response = self.client.post(
            admin_url(Product, "add"), self.product_data(name="Молоко разливное"),
        )
        self.assert_form_error(response, "__all__", "Package unit уже существует")
        self.assertEqual(Product.objects.filter(name="Молоко разливное").count(), 1)

    def test_package_quantity_without_unit(self):
        response = self.client.post(
            admin_url(Product, "add"), self.product_data(package_quantity="1"),
        )
        self.assert_form_error(response, "__all__", "catalog_product_package_both_or_none")
        self.assertEqual(Product.objects.count(), 1)

    def test_package_unit_without_quantity(self):
        response = self.client.post(
            admin_url(Product, "add"), self.product_data(package_unit="l"),
        )
        self.assert_form_error(response, "__all__", "catalog_product_package_both_or_none")
        self.assertEqual(Product.objects.count(), 1)

    def test_package_removed_by_half_on_change(self):
        response = self.client.post(
            admin_url(Product, self.product.pk, "change"),
            self.product_data(name="Молоко 2,5%", brand=self.brand.pk, package_quantity="0.850"),
        )
        self.assert_form_error(response, "__all__", "catalog_product_package_both_or_none")
        self.product.refresh_from_db()
        self.assertEqual(self.product.package_unit, Unit.L)

    def test_non_positive_package_quantity(self):
        for quantity in ("0", "-0.001", "-1"):
            with self.subTest(quantity=quantity):
                response = self.client.post(
                    admin_url(Product, "add"),
                    self.product_data(package_quantity=quantity, package_unit="l"),
                )
                self.assert_form_error(
                    response, "__all__", "catalog_product_package_quantity_positive",
                )
        self.assertEqual(Product.objects.count(), 1)


@tag("integration")
class CategoryCycleTests(CatalogAdminTestCase):
    def assert_cycle_rejected(self, category, parent):
        old_parent_id = category.parent_id
        response = self.client.post(
            admin_url(Category, category.pk, "change"),
            {"name": category.name, "parent": parent.pk},
        )
        self.assert_form_error(response, "parent", "потомок")
        category.refresh_from_db()
        self.assertEqual(category.parent_id, old_parent_id)

    def test_category_cannot_be_its_own_parent(self):
        self.assert_cycle_rejected(self.food, self.food)
        self.assert_cycle_rejected(self.yogurts, self.yogurts)

    def test_child_cannot_become_parent(self):
        self.assert_cycle_rejected(self.food, self.dairy)

    def test_deeper_descendant_cannot_become_parent(self):
        self.assert_cycle_rejected(self.food, self.yogurts)
        self.assert_cycle_rejected(self.dairy, self.yogurts)

    def test_moving_to_another_branch_is_allowed(self):
        drinks = Category.objects.create(name="Напитки")
        response = self.client.post(
            admin_url(Category, self.dairy.pk, "change"),
            {"name": "Молочные", "parent": drinks.pk},
        )
        self.assertRedirects(response, admin_url(Category), fetch_redirect_response=False)
        self.dairy.refresh_from_db()
        self.assertEqual(self.dairy.parent, drinks)

    def test_moving_up_to_ancestor_is_allowed(self):
        response = self.client.post(
            admin_url(Category, self.yogurts.pk, "change"),
            {"name": "Йогурты", "parent": self.food.pk},
        )
        self.assertRedirects(response, admin_url(Category), fetch_redirect_response=False)
        self.yogurts.refresh_from_db()
        self.assertEqual(self.yogurts.parent, self.food)

    def test_existing_cycle_does_not_hang_the_form(self):
        # The database allows a cycle made bypassing the admin; the check must terminate.
        first = Category.objects.create(name="Петля 1")
        second = Category.objects.create(name="Петля 2", parent=first)
        Category.objects.filter(pk=first.pk).update(parent=second)
        response = self.client.post(
            admin_url(Category, self.yogurts.pk, "change"),
            {"name": "Йогурты", "parent": first.pk},
        )
        self.assertRedirects(response, admin_url(Category), fetch_redirect_response=False)


@tag("integration")
class AutocompleteTests(CatalogAdminTestCase):
    def get(self, model, field, term):
        return self.client.get("/admin/autocomplete/", {
            "app_label": "catalog", "model_name": model._meta.model_name,
            "field_name": field, "term": term,
        })

    def test_every_autocomplete_field_is_covered(self):
        declared = {
            (model, field)
            for model in MODELS
            for field in admin.site.get_model_admin(model).autocomplete_fields
        }
        self.assertEqual(declared, set(AUTOCOMPLETE_FIELDS))

    def test_autocomplete_responds(self):
        for model, field in AUTOCOMPLETE_FIELDS:
            with self.subTest(model=model.__name__, field=field):
                self.assertEqual(self.get(model, field, "").status_code, 200)

    def test_autocomplete_finds_by_search_fields(self):
        cases = (
            (Category, "parent", "Молоч", self.dairy),
            (GenericProduct, "category", "Йогур", self.yogurts),
            (Product, "generic", "Молок", self.milk),
            (Product, "brand", "Mül", self.brand),
            (Product, "brand", "завод", self.brand),
        )
        for model, field, term, expected in cases:
            with self.subTest(model=model.__name__, field=field, term=term):
                response = self.get(model, field, term)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(
                    response.json()["results"], [{"id": str(expected.pk), "text": str(expected)}],
                )

    def test_autocomplete_is_closed_for_anonymous_and_non_staff(self):
        for user in (None, self.plain_user):
            self.client.logout()
            if user:
                self.client.force_login(user)
            for model, field in AUTOCOMPLETE_FIELDS:
                with self.subTest(user=user, model=model.__name__, field=field):
                    response = self.get(model, field, "")
                    self.assertEqual(response.status_code, 302)
                    self.assertTrue(response["Location"].startswith("/admin/login/?next="))
