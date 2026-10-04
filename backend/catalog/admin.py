from django import forms
from django.contrib import admin
from django.db import connections, router

from catalog.models import Brand, Category, GenericProduct, Product

# Two-int advisory lock namespace: ASCII "CKST", resource 1 = category tree.
CATEGORY_TREE_LOCK = (0x434B5354, 1)


class CategoryAdminForm(forms.ModelForm):
    class Meta:
        model = Category
        fields = "__all__"

    def clean_parent(self):
        """Reject a parent that is the category itself or one of its descendants.

        The database does not forbid cycles in the tree.
        """
        return self.validate_parent(self.cleaned_data["parent"])

    def validate_parent(self, parent):
        if parent is None or self.instance.pk is None:
            return parent
        using = router.db_for_write(Category)
        seen = set()
        ancestor_id = parent.pk
        # ``seen`` stops the walk if the stored tree already contains a cycle.
        while ancestor_id is not None and ancestor_id not in seen:
            if ancestor_id == self.instance.pk:
                raise forms.ValidationError(
                    "Родителем не может быть сама категория или её потомок.",
                    code="category_cycle",
                )
            seen.add(ancestor_id)
            ancestor_id = (
                Category.objects.using(using).filter(pk=ancestor_id)
                .values_list("parent_id", flat=True).first()
            )
        return parent

    def clean(self):
        cleaned = super().clean()
        if "parent" not in cleaned:
            return cleaned
        # Django's add/change POST transaction spans validation, save and logging.
        # Lock the whole tree, including root/add forms, until that transaction ends.
        # A try-lock avoids waiting past the project's 2000 ms statement_timeout.
        using = router.db_for_write(Category)
        with connections[using].cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_xact_lock(%s, %s)", CATEGORY_TREE_LOCK)
            acquired = cursor.fetchone()[0]
        if not acquired:
            self.add_error("parent", forms.ValidationError(
                "Категории сейчас изменяются другим запросом. Повторите сохранение.",
                code="category_tree_busy",
            ))
            return cleaned
        # The field's earlier check may have preceded another request's commit.
        # Read current links again under the lock, without using cached FK objects.
        try:
            self.validate_parent(cleaned["parent"])
        except forms.ValidationError as error:
            self.add_error("parent", error)
        return cleaned


@admin.register(Category)
class CategoryAdmin(admin.ModelAdmin):
    form = CategoryAdminForm
    list_display = ("name", "parent")
    search_fields = ("name",)
    ordering = ("name",)
    list_select_related = ("parent",)
    autocomplete_fields = ("parent",)
    # Parent writes use the transactional add/change forms only; there are no
    # list_editable fields or custom actions writing parent. delete_selected
    # cannot introduce an edge or a cycle (referenced parents are PROTECT-ed).


@admin.register(GenericProduct)
class GenericProductAdmin(admin.ModelAdmin):
    list_display = ("name", "category", "base_unit")
    list_filter = ("base_unit",)
    search_fields = ("name",)
    ordering = ("name",)
    list_select_related = ("category",)
    autocomplete_fields = ("category",)


@admin.register(Brand)
class BrandAdmin(admin.ModelAdmin):
    list_display = ("name", "manufacturer")
    search_fields = ("name", "manufacturer")
    ordering = ("name",)
    # No foreign keys to follow in the list.
    list_select_related = False


class ProductAdminForm(forms.ModelForm):
    class Meta:
        model = Product
        fields = "__all__"

    def clean_attributes(self):
        value = self.cleaned_data["attributes"]
        if value is None:
            # Empty/null JSON must not become SQL NULL. For an omitted field,
            # Django keeps a model's default-bearing value on change, so clear
            # the instance too instead of retaining the old attributes.
            self.instance.attributes = {}
            return {}
        return value


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    form = ProductAdminForm
    list_display = ("name", "brand", "generic", "package_quantity", "package_unit", "gtin")
    list_filter = ("package_unit",)
    search_fields = ("name", "gtin", "model", "brand__name")
    ordering = ("name",)
    list_select_related = ("brand", "generic")
    autocomplete_fields = ("generic", "brand")
