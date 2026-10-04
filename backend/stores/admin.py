from zoneinfo import available_timezones

from django import forms
from django.contrib import admin

from stores.models import Country, Currency, Merchant, Store, TaxRate
from stores.normalize import address_key


class CodeReferenceAdmin(admin.ModelAdmin):
    list_display = ("code", "name")
    search_fields = ("code", "name")
    ordering = ("code",)

    def get_readonly_fields(self, request, obj=None):
        # code — первичный ключ: правка создала бы новую строку вместо переименования.
        return ("code",) if obj else ()


admin.site.register(Country, CodeReferenceAdmin)
admin.site.register(Currency, CodeReferenceAdmin)


@admin.register(TaxRate)
class TaxRateAdmin(admin.ModelAdmin):
    list_display = ("name", "country", "kind", "rate")
    list_filter = ("country", "kind")
    search_fields = ("name", "country__code")
    ordering = ("country", "kind", "rate")
    list_select_related = ("country",)


class MerchantAdminForm(forms.ModelForm):
    class Meta:
        model = Merchant
        fields = "__all__"

    def clean_extra(self):
        # Очищенное поле даёт None, а столбец NOT NULL.
        value = self.cleaned_data["extra"]
        return {} if value is None else value


@admin.register(Merchant)
class MerchantAdmin(admin.ModelAdmin):
    form = MerchantAdminForm
    list_display = ("__str__", "legal_name", "country", "tax_id_type", "tax_id")
    list_filter = ("country", "tax_id_type")
    search_fields = ("legal_name", "brand_name", "tax_id")
    ordering = ("legal_name",)
    list_select_related = ("country",)


class StoreAdminForm(forms.ModelForm):
    class Meta:
        model = Store
        fields = "__all__"

    def clean_address_i18n(self):
        value = self.cleaned_data["address_i18n"]
        return {} if value is None else value

    def clean_timezone(self):
        value = self.cleaned_data["timezone"]
        if value not in available_timezones():
            raise forms.ValidationError("Неизвестный часовой пояс IANA.", code="invalid_timezone")
        return value

    def clean(self):
        cleaned = super().clean()
        merchant = cleaned.get("merchant")
        if merchant is None or "address_raw" not in cleaned or "address_i18n" not in cleaned:
            return cleaned
        # Как в Store.save(): ключ считается один раз и при правке адреса не меняется.
        key = self.instance.address_key or address_key(cleaned["address_raw"], cleaned["address_i18n"])
        if not key:
            self.add_error("address_raw", forms.ValidationError(
                "В адресе нет букв и цифр: ключ адреса получается пустым.", code="empty_address_key",
            ))
            return cleaned
        # address_key нет в форме, поэтому Django исключает unique (merchant, address_key) из проверки.
        duplicates = Store.objects.filter(merchant=merchant, address_key=key)
        if self.instance.pk is not None:
            duplicates = duplicates.exclude(pk=self.instance.pk)
        if duplicates.exists():
            self.add_error("address_raw", forms.ValidationError(
                "У этого продавца уже есть магазин с таким адресом.", code="duplicate_address",
            ))
            return cleaned
        self.instance.address_key = key
        return cleaned


@admin.register(Store)
class StoreAdmin(admin.ModelAdmin):
    form = StoreAdminForm
    list_display = ("__str__", "merchant", "country", "city", "branch_code", "timezone")
    list_filter = ("country",)
    search_fields = (
        "name", "address_raw", "city", "branch_code", "merchant__legal_name", "merchant__brand_name",
    )
    ordering = ("merchant", "name")
    list_select_related = ("merchant", "country")
    autocomplete_fields = ("merchant",)
    readonly_fields = ("address_key",)
