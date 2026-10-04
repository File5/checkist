from django import forms
from django.contrib import admin
from django.db import OperationalError, transaction
from django.forms.models import BaseInlineFormSet
from django.utils.html import format_html, format_html_join

from receipts.dedup import build_fiscal_key, name_key
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.validation import validate_receipt


def lock_inline_objects(queryset, *, nowait=False):
    # Savepoint нужен, чтобы timeout/deadlock не оставил весь admin POST
    # в сломанной транзакции. Успешные блокировки живут до внешнего commit.
    try:
        with transaction.atomic(using=queryset.db):
            return list(queryset.select_for_update(nowait=nowait).order_by("pk"))
    except OperationalError as error:
        if getattr(error.__cause__, "sqlstate", None) not in {"55P03", "57014", "40P01"}:
            raise
        raise forms.ValidationError(
            "Строки чека сейчас изменяются другим запросом. Откройте чек заново и повторите сохранение.",
            code="receipt_inline_busy",
        ) from error


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
        locked = {line.pk: line for line in lock_inline_objects(ReceiptLine.objects.filter(pk__in=ids))}
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
            locked = lock_inline_objects(ReceiptLine.objects.filter(pk=line.pk))
            line = locked[0] if locked else None
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


class ReceiptInlineFormSet(BaseInlineFormSet):
    """Принадлежность проверяется и для DELETE: ошибки отдельных форм Django игнорирует."""

    def clean(self):
        ids = []
        for form in self.initial_forms:
            submitted = form.cleaned_data.get(self.model._meta.pk.name)
            pk = form.instance.pk or getattr(submitted, "pk", None)
            if pk is None:
                raise forms.ValidationError(
                    "Запись чека уже удалена или изменена. Откройте чек заново.", code="receipt_inline_conflict",
                )
            ids.append(pk)
        # Не фильтруем по receipt: иначе перенесённая запись исчезнет из проверки.
        # Формы строк уже взяли ожидающие блокировки F1; для остальных inline
        # конфликт отклоняется немедленно, не расходуя statement_timeout.
        current = lock_inline_objects(self.model._default_manager.filter(pk__in=ids), nowait=True)
        self.current_objects = {obj.pk: obj for obj in current}
        if any(
            pk not in self.current_objects or self.current_objects[pk].receipt_id != self.instance.pk
            for pk in ids
        ):
            raise forms.ValidationError(
                "Запись уже перенесена в другой чек или удалена. Откройте чек заново.",
                code="receipt_inline_conflict",
            )
        super().clean()


class ReceiptLineInlineFormSet(ReceiptInlineFormSet):
    def deleted_line_ids(self):
        # Включаем каскадные удаления, но учитываем отвязку/смену parent
        # в этом же POST. Ссылки блокируются формами до завершения транзакции.
        deleted = {
            form.instance.pk for form in self.forms
            if self.can_delete and self._should_delete_form(form) and form.instance.pk is not None
        }
        if not deleted:
            return deleted
        parents = dict(ReceiptLine.objects.filter(receipt=self.instance).values_list("pk", "parent_id"))
        for form in self.forms:
            if self.can_delete and self._should_delete_form(form):
                continue
            if form.instance.pk is not None and "parent" in form.cleaned_data:
                parents[form.instance.pk] = getattr(form.cleaned_data["parent"], "pk", None)
        pending = list(deleted)
        children = {}
        for pk, parent in parents.items():
            children.setdefault(parent, []).append(pk)
        while pending:
            for pk in children.get(pending.pop(), ()):
                if pk not in deleted:
                    deleted.add(pk)
                    pending.append(pk)
        return deleted

    def has_content_changes(self, form):
        original = self.current_objects.get(form.instance.pk)
        # JSONField считает '{}' изменением относительно пустого {}, даже если
        # clean нормализовал его обратно в {}. Это не правка зависимой строки.
        return any(
            name not in form.json_fields or original is None
            or form.cleaned_data.get(name) != getattr(original, name)
            for name in form.changed_data
        )

    def clean(self):
        super().clean()
        deleted = self.deleted_line_ids()
        for form in self.forms:
            if self.can_delete and self._should_delete_form(form):
                continue
            parent = form.cleaned_data.get("parent")
            if parent is not None and parent.pk in deleted and self.has_content_changes(form):
                form.add_error("parent", forms.ValidationError(
                    "Родительская строка удаляется в этом сохранении. Отвяжите залог или удалите его вместе с ней.",
                    code="parent_deleted",
                ))

    def save_existing_objects(self, commit=True):
        # Сохраняем отвязанные/перепривязанные залоги до CASCADE, чтобы вместе
        # с ними не исчезли их собственные неизменённые зависимости.
        self.changed_objects, self.deleted_objects = [], []
        saved = []
        deleting = self.deleted_forms
        for form in self.initial_forms:
            obj = form.instance
            if not obj._is_pk_set():
                continue
            if form in deleting:
                self.deleted_objects.append(obj)
            elif form.has_changed():
                self.changed_objects.append((obj, form.changed_data))
                saved.append(self.save_existing(form, obj, commit=commit))
                if not commit:
                    self.saved_forms.append(form)
        for obj in self.deleted_objects:
            self.delete_existing(obj, commit=commit)
        return saved


class ReceiptDiscountInlineFormSet(ReceiptInlineFormSet):
    line_formset = None

    def clean(self):
        super().clean()
        if self.line_formset is None or not self.line_formset.is_valid():
            return
        deleted = self.line_formset.deleted_line_ids()
        for form in self.forms:
            if not form.has_changed() or (self.can_delete and self._should_delete_form(form)):
                continue
            line = form.cleaned_data.get("line")
            if line is not None and line.pk in deleted:
                form.add_error("line", forms.ValidationError(
                    "Строка скидки удаляется в этом сохранении. Отвяжите скидку или удалите её вместе со строкой.",
                    code="line_deleted",
                ))


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
    formset = ReceiptLineInlineFormSet
    extra = 0
    ordering = ("position",)
    autocomplete_fields = ("product", "tax_rate")
    line_fields = ("parent",)


class ReceiptDiscountInline(ReceiptLinesChoiceMixin, admin.TabularInline):
    model = ReceiptDiscount
    form = ReceiptDiscountAdminForm
    formset = ReceiptDiscountInlineFormSet
    extra = 0
    ordering = ("position",)
    line_fields = ("line",)


class ReceiptTaxInline(admin.TabularInline):
    model = ReceiptTax
    formset = ReceiptInlineFormSet
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

    def _create_formsets(self, request, obj, change):
        formsets, inlines = super()._create_formsets(request, obj, change)
        lines = next((formset for formset in formsets if formset.model is ReceiptLine), None)
        for formset in formsets:
            if formset.model is ReceiptDiscount:
                formset.line_formset = lines
        return formsets, inlines

    def save_related(self, request, form, formsets, change):
        # Скидки с очищенным/заменённым line должны сохраниться до удаления
        # строк. Порядок inline в интерфейсе при этом остаётся прежним.
        ordered = sorted(formsets, key=lambda formset: formset.model is ReceiptLine)
        super().save_related(request, form, ordered, change)

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
