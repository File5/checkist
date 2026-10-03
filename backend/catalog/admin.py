from django import forms
from django.contrib import admin

from catalog.models import Brand, Category, GenericProduct, Product


class CategoryAdminForm(forms.ModelForm):
    class Meta:
        model = Category
        fields = "__all__"

    def clean_parent(self):
        """Reject a parent that is the category itself or one of its descendants.

        The database does not forbid cycles in the tree.
        """
        parent = self.cleaned_data["parent"]
        if parent is None or self.instance.pk is None:
            return parent
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
                Category.objects.filter(pk=ancestor_id).values_list("parent_id", flat=True).first()
            )
        return parent


@admin.register(Category)
class CategoryAdmin(admin.ModelAdmin):
    form = CategoryAdminForm
    list_display = ("name", "parent")
    search_fields = ("name",)
    ordering = ("name",)
    list_select_related = ("parent",)
    autocomplete_fields = ("parent",)


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


@admin.register(Product)
class ProductAdmin(admin.ModelAdmin):
    list_display = ("name", "brand", "generic", "package_quantity", "package_unit", "gtin")
    list_filter = ("package_unit",)
    search_fields = ("name", "gtin", "model", "brand__name")
    ordering = ("name",)
    list_select_related = ("brand", "generic")
    autocomplete_fields = ("generic", "brand")
