from django import forms
from django.contrib import admin
from django.utils.html import format_html, format_html_join

from receipts.dedup import build_fiscal_key, name_key
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.validation import validate_receipt


class EmptyJSONFormMixin:
    """Очищенное JSON-поле даёт None, а столбцы NOT NULL: пустой ввод сохраняется как {}."""

    json_fields = ()

    def clean(self):
        cleaned = super().clean()
        for name in self.json_fields:
            if name in cleaned and cleaned[name] is None:
                cleaned[name] = {}
        return cleaned


class ReceiptAdminForm(EmptyJSONFormMixin, forms.ModelForm):
    json_fields = ("fiscal", "extra")

    class Meta:
        model = Receipt
        fields = "__all__"
        help_texts = {
            "purchased_at": "Момент покупки в UTC, а не по местному времени магазина.",
            "purchased_on": "Локальная дата магазина, как напечатана на чеке.",
            "fiscal_key": "Если пусто, собирается из fiscal по стране магазина.",
        }

    def clean(self):
        cleaned = super().clean()
        store = cleaned.get("store")
        fiscal = cleaned.get("fiscal")
        if store is None or not fiscal or cleaned.get("fiscal_key", True):
            return cleaned
        # Значение попадает в cleaned_data до проверки ограничений модели,
        # поэтому дубликат по собранному ключу — ошибка формы.
        try:
            cleaned["fiscal_key"] = build_fiscal_key(store.country_id, fiscal)
        except ValueError:
            self.add_error("fiscal", forms.ValidationError(
                "Фискальный ключ из этих реквизитов длиннее 160 символов.", code="fiscal_key_too_long",
            ))
        return cleaned


class ReceiptLineAdminForm(EmptyJSONFormMixin, forms.ModelForm):
    json_fields = ("name_i18n", "extra")

    class Meta:
        model = ReceiptLine
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        parent = cleaned.get("parent")
        # В inline чек приходит из формы чека, в отдельной админке — из поля receipt.
        receipt = cleaned.get("receipt") or self.instance.receipt_id
        receipt_id = getattr(receipt, "pk", receipt)
        # POST changeform_view у ModelAdmin уже обёрнут в atomic: блокировка
        # живёт от проверки до сохранения всех inline и commit. Создание связей
        # блокирует ту же строку, поэтому после ожидания читаем её заново.
        ids = [pk for pk in (self.instance.pk, getattr(parent, "pk", None)) if pk is not None]
        locked = {line.pk: line for line in ReceiptLine.objects.select_for_update().filter(pk__in=ids).order_by("pk")}
        original = locked.get(self.instance.pk)
        if self.instance.pk is not None and original is None:
            self.add_error(None, "Строка уже удалена. Откройте чек заново.")
        elif original is not None and original.receipt_id != receipt_id:
            if original.children.exists() or original.discounts.exists():
                self.add_error("receipt", forms.ValidationError(
                    "Нельзя перенести строку в другой чек: к ней привязаны залоги или скидки. "
                    "Сначала удалите или отвяжите эти связи в исходном чеке.",
                    code="receipt_has_dependents",
                ))
        if parent is None:
            return cleaned
        parent = locked.get(parent.pk)
        if parent is None:
            self.add_error("parent", "Родительская строка уже удалена. Откройте чек заново.")
            return cleaned
        if parent.pk == self.instance.pk:
            self.add_error("parent", forms.ValidationError(
                "Строка не может быть залогом к самой себе.", code="parent_is_self",
            ))
        elif parent.receipt_id != receipt_id:
            self.add_error("parent", forms.ValidationError(
                "Родительская строка должна быть строкой этого же чека.", code="parent_other_receipt",
            ))
        return cleaned


class ReceiptDiscountAdminForm(forms.ModelForm):
    class Meta:
        model = ReceiptDiscount
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        line = cleaned.get("line")
        if line is not None:
            # Список choices мог быть прочитан до конкурентного переноса.
            line = ReceiptLine.objects.select_for_update().filter(pk=line.pk).first()
            if line is None or line.receipt_id != self.instance.receipt_id:
                self.add_error("line", forms.ValidationError(
                    "Строка скидки должна быть строкой этого же чека. Откройте чек заново.",
                    code="line_other_receipt",
                ))
        return cleaned


class ProductAliasAdminForm(forms.ModelForm):
    class Meta:
        model = ProductAlias
        fields = "__all__"

    def clean(self):
        cleaned = super().clean()
        merchant = cleaned.get("merchant")
        if merchant is None or "raw_name" not in cleaned or "store_item_code" not in cleaned:
            return cleaned
        key = name_key(cleaned["raw_name"])
        # name_key нет в форме, поэтому Django исключает unique (merchant, name_key, store_item_code) из проверки.
        duplicates = ProductAlias.objects.filter(
            merchant=merchant, name_key=key, store_item_code=cleaned["store_item_code"],
        )
        if self.instance.pk is not None:
            duplicates = duplicates.exclude(pk=self.instance.pk)
        if duplicates.exists():
            self.add_error("raw_name", forms.ValidationError(
                "У этого продавца уже есть сопоставление с таким названием и кодом товара.",
                code="duplicate_alias",
            ))
            return cleaned
        self.instance.name_key = key
        return cleaned


class ReceiptLinesChoiceMixin:
    """FK на строку чека в inline предлагает только строки этого же чека."""

    line_fields = ()

    def get_formset(self, request, obj=None, **kwargs):
        # formfield_for_foreignkey вызывается при сборке формы и сам чек не получает.
        request._receipt_admin_obj = obj
        return super().get_formset(request, obj, **kwargs)

    def formfield_for_foreignkey(self, db_field, request, **kwargs):
        if db_field.name not in self.line_fields:
            return super().formfield_for_foreignkey(db_field, request, **kwargs)
        receipt = getattr(request, "_receipt_admin_obj", None)
        if receipt is None or receipt.pk is None:
            # У нового чека строк ещё нет: залог и скидку на строку привязывают после сохранения.
            kwargs["queryset"] = ReceiptLine.objects.none()
        else:
            kwargs["queryset"] = ReceiptLine.objects.filter(receipt=receipt).order_by("position")
        field = super().formfield_for_foreignkey(db_field, request, **kwargs)
        field.label_from_instance = lambda line: f"{line.position}. {line.raw_name}"
        return field


class ReceiptLineInline(ReceiptLinesChoiceMixin, admin.StackedInline):
    model = ReceiptLine
    form = ReceiptLineAdminForm
    extra = 0
    ordering = ("position",)
    autocomplete_fields = ("product", "tax_rate")
    line_fields = ("parent",)


class ReceiptDiscountInline(ReceiptLinesChoiceMixin, admin.TabularInline):
    model = ReceiptDiscount
    form = ReceiptDiscountAdminForm
    extra = 0
    ordering = ("position",)
    line_fields = ("line",)


class ReceiptTaxInline(admin.TabularInline):
    model = ReceiptTax
    extra = 0
    ordering = ("pk",)
    autocomplete_fields = ("tax_rate",)


@admin.register(Receipt)
class ReceiptAdmin(admin.ModelAdmin):
    form = ReceiptAdminForm
    list_display = ("id", "purchased_on", "store", "operation", "total", "currency", "receipt_number")
    list_filter = ("operation", "currency", "store__country")
    # raw_text в поиск не входит: ILIKE по тексту чеков упрётся в statement_timeout.
    search_fields = ("receipt_number", "fiscal_key", "store__name", "store__address_raw")
    ordering = ("-purchased_at", "-id")
    date_hierarchy = "purchased_on"
    list_select_related = ("store", "currency")
    autocomplete_fields = ("store",)
    readonly_fields = ("created_at", "updated_at", "validation_warnings")
    inlines = (ReceiptLineInline, ReceiptDiscountInline, ReceiptTaxInline)

    @admin.display(description="Предупреждения проверки")
    def validation_warnings(self, obj):
        if obj is None or obj.pk is None:
            return "Появятся после сохранения чека."
        problems = validate_receipt(obj)
        if not problems:
            return "Нарушений не найдено."
        # Предупреждения, а не отказ: сохранению они не мешают.
        return format_html("<ul>{}</ul>", format_html_join("", "<li>{}</li>", ((problem,) for problem in problems)))


@admin.register(ReceiptLine)
class ReceiptLineAdmin(admin.ModelAdmin):
    form = ReceiptLineAdminForm
    list_display = ("raw_name", "receipt", "position", "kind", "quantity", "unit", "amount", "product")
    list_filter = ("kind", "unit", "is_excise", "is_marked", ("product", admin.EmptyFieldListFilter))
    search_fields = ("raw_name", "store_item_code", "barcode")
    ordering = ("-receipt", "position")
    list_select_related = ("receipt", "product")
    autocomplete_fields = ("receipt", "product", "tax_rate")
    raw_id_fields = ("parent",)

    def has_add_permission(self, request):
        # Строка создаётся только внутри чека.
        return False


@admin.register(ProductAlias)
class ProductAliasAdmin(admin.ModelAdmin):
    form = ProductAliasAdminForm
    list_display = ("raw_name", "merchant", "product", "store_item_code")
    search_fields = ("raw_name", "name_key", "store_item_code", "product__name")
    ordering = ("merchant", "name_key")
    list_select_related = ("merchant", "product")
    autocomplete_fields = ("merchant", "product")
    readonly_fields = ("name_key",)
