import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal
from unittest.mock import patch

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.db import IntegrityError, connection, connections, transaction
from django.test import Client, TransactionTestCase, tag
from django.test.utils import CaptureQueriesContext
from django.urls import reverse

from catalog.models import Product
from receipts.admin import ReceiptDiscountAdminForm, ReceiptInlineFormSet, ReceiptLineAdminForm
from receipts.dedup import build_fiscal_key, name_key
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.ownership import local_user
from receipts.tests.test_models import PURCHASED_AT, ReceiptTestCase, make_line, make_receipt
from stores.models import Country, Currency, Merchant, Store, TaxRate

# Все названия, адреса и номера вымышленные.

MODELS = (Receipt, ReceiptLine, ProductAlias)
INLINE_PREFIXES = ("lines", "discounts", "taxes")
DE_FISCAL = {"register_serial": "TEST-000-0000-01", "tse_transaction": "427161"}
AUTOCOMPLETE_FIELDS = (
    ("receipt", "store"),
    ("receiptline", "receipt"),
    ("receiptline", "product"),
    ("receiptline", "tax_rate"),
    ("receipttax", "tax_rate"),
    ("productalias", "merchant"),
    ("productalias", "product"),
)


def admin_url(model, name, *args):
    return reverse(f"admin:receipts_{model._meta.model_name}_{name}", args=args)


def formset_data(prefix, rows, initial=0):
    data = {
        f"{prefix}-TOTAL_FORMS": len(rows), f"{prefix}-INITIAL_FORMS": initial,
        f"{prefix}-MIN_NUM_FORMS": 0, f"{prefix}-MAX_NUM_FORMS": 1000,
    }
    for index, row in enumerate(rows):
        for name, value in row.items():
            data[f"{prefix}-{index}-{name}"] = value
    return data


def line_row(**fields):
    return {
        "id": "", "receipt": "", "position": 1, "kind": "product", "parent": "",
        "raw_name": "Тестовый товар", "name_i18n": "{}", "store_item_code": "", "barcode": "",
        "quantity": "1.000", "unit": "pcs", "unit_price": "10.0000", "amount": "10.00",
        "discount_amount": "0.00", "tax_rate": "", "tax_code": "", "tax_amount": "",
        "product": "", "extra": "{}", **fields,
    }


def discount_row(**fields):
    return {"id": "", "receipt": "", "line": "", "position": 1, "name": "Тестовая скидка", "amount": "1.00", **fields}


def tax_row(**fields):
    return {"id": "", "receipt": "", "tax_code": "A", "net": "8.41", "tax": "0.59", "gross": "9.00", **fields}


class ReceiptsAdminTestCase(ReceiptTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        users = get_user_model().objects
        cls.superuser = users.create_superuser("root-user", password="test-only-password")
        cls.plain_user = users.create_user("plain-user", password="test-only-password")
        cls.staff_user = users.create_user("staff-user", password="test-only-password", is_staff=True)
        Store.objects.filter(pk=cls.store.pk).update(name="Тестмарт на Примерной")
        cls.store.refresh_from_db()
        # У страны XA схемы фискального ключа нет: для него нужен магазин в стране со схемой.
        germany, _ = Country.objects.get_or_create(code="DE", defaults={"name": "Германия"})
        cls.de_store = Store.objects.create(
            merchant=cls.merchant, country=germany,
            address_raw="Teststadt, Beispielstr. 3", timezone="Europe/Berlin",
        )
        # Чек без нарушений: дата совпадает с поясом магазина, итог равен сумме строк.
        cls.receipt = make_receipt(cls.store, cls.currency, receipt_number="100", fiscal_key="test:fiscal:1")
        cls.line = make_line(
            cls.receipt, product=cls.product, store_item_code="SKU-1", barcode="4000000000013",
        )
        cls.alias = ProductAlias.objects.create(
            merchant=cls.merchant, product=cls.product, raw_name="Тестовый товар",
            name_key=name_key("Тестовый товар"), store_item_code="SKU-1",
        )
        cls.objects = {Receipt: cls.receipt, ReceiptLine: cls.line, ProductAlias: cls.alias}

    def setUp(self):
        self.client = Client()
        self.client.force_login(self.superuser)

    def receipt_data(self, lines=(), discounts=(), taxes=(), initial=(0, 0, 0), **fields):
        data = {
            # Владелец тот же, что у чеков из make_receipt: на изменении поле отключено и из POST не читается.
            "owner": local_user().pk,
            "store": self.store.pk, "currency": "XTS", "operation": "sale",
            "purchased_at_0": "2026-03-14", "purchased_at_1": "11:30:00", "purchased_on": "2026-03-14",
            "receipt_number": "", "shift_number": "", "register_code": "", "fiscal_key": "",
            "fiscal": "{}", "total": "10.00", "discount_total": "0.00", "prices_include_tax": "on",
            "raw_text": "", "extra": "{}", **fields,
        }
        for prefix, rows, count in zip(INLINE_PREFIXES, (lines, discounts, taxes), initial):
            data.update(formset_data(prefix, rows, count))
        return data

    def alias_data(self, **fields):
        return {
            "merchant": self.merchant.pk, "product": self.product.pk, "store_item_code": "",
            "raw_name": "Новое название", **fields,
        }

    def formset(self, response, prefix):
        formsets = {item.formset.prefix: item.formset for item in response.context["inline_admin_formsets"]}
        return formsets[prefix]

    def all_errors(self, response):
        """Ошибки формы и всех inline страницы — для сообщения об отказе."""
        found = {"form": response.context["adminform"].form.errors}
        for item in response.context.get("inline_admin_formsets", ()):
            found[item.formset.prefix] = (item.formset.non_form_errors(), item.formset.errors)
        return found

    def assertSaved(self, response, model):
        if response.status_code == 200:
            self.fail(f"Форма не сохранена: {self.all_errors(response)}")
        self.assertRedirects(response, admin_url(model, "changelist"), fetch_redirect_response=False)

    def assertFormError(self, response, field, fragment=None):
        self.assertEqual(response.status_code, 200)
        errors = response.context["adminform"].form.errors
        self.assertIn(field, errors, errors)
        if fragment is not None:
            self.assertIn(fragment, " ".join(errors[field]))


@tag("integration")
class RegistrationTests(ReceiptsAdminTestCase):
    def test_models_are_registered(self):
        for model in MODELS:
            with self.subTest(model=model.__name__):
                self.assertTrue(admin.site.is_registered(model))

    def test_discount_and_tax_are_inline_only(self):
        for model in (ReceiptDiscount, ReceiptTax):
            with self.subTest(model=model.__name__):
                self.assertFalse(admin.site.is_registered(model))
        inlines = admin.site.get_model_admin(Receipt).inlines
        self.assertEqual([inline.model for inline in inlines], [ReceiptLine, ReceiptDiscount, ReceiptTax])
        self.assertTrue(all(inline.extra == 0 for inline in inlines))
        self.assertTrue(issubclass(inlines[0], admin.StackedInline))
        self.assertTrue(issubclass(inlines[1], admin.TabularInline))
        self.assertTrue(issubclass(inlines[2], admin.TabularInline))

    def test_inlines_are_on_receipt_pages(self):
        for url in (admin_url(Receipt, "add"), admin_url(Receipt, "change", self.receipt.pk)):
            with self.subTest(url=url):
                response = self.client.get(url)
                models = [item.formset.model for item in response.context["inline_admin_formsets"]]
                self.assertEqual(models, [ReceiptLine, ReceiptDiscount, ReceiptTax])

    def test_list_options_are_explicit(self):
        expected = {
            Receipt: (("-purchased_at", "-id"), ("store", "currency", "owner")),
            ReceiptLine: (("-receipt", "position"), ("receipt", "product")),
            ProductAlias: (("merchant", "name_key"), ("merchant", "product")),
        }
        for model, (ordering, select_related) in expected.items():
            with self.subTest(model=model.__name__):
                model_admin = admin.site.get_model_admin(model)
                self.assertEqual(model_admin.ordering, ordering)
                self.assertEqual(model_admin.list_select_related, select_related)
                self.assertTrue(model_admin.search_fields)

    def test_raw_text_is_not_searched(self):
        self.assertNotIn("raw_text", admin.site.get_model_admin(Receipt).search_fields)
        Receipt.objects.filter(pk=self.receipt.pk).update(raw_text="особая-строка-текста")
        response = self.client.get(admin_url(Receipt, "changelist"), {"q": "особая-строка-текста"})
        self.assertEqual(list(response.context["cl"].result_list), [])


@tag("integration")
class AccessTests(ReceiptsAdminTestCase):
    def pages(self):
        for model in MODELS:
            yield admin_url(model, "changelist")
            yield admin_url(model, "add")
            yield admin_url(model, "change", self.objects[model].pk)

    def assert_redirected_to_login(self):
        for url in self.pages():
            with self.subTest(url=url):
                self.assertRedirects(
                    self.client.get(url), f"/admin/login/?next={url}", fetch_redirect_response=False,
                )

    def test_anonymous_is_redirected_to_login(self):
        self.client.logout()
        self.assert_redirected_to_login()

    def test_user_without_is_staff_is_redirected_to_login(self):
        self.client.force_login(self.plain_user)
        self.assert_redirected_to_login()

    def test_staff_without_model_permissions_is_forbidden(self):
        self.client.force_login(self.staff_user)
        for url in self.pages():
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 403)

    def test_anonymous_post_does_not_create_object(self):
        self.client.logout()
        response = self.client.post(admin_url(ProductAlias, "add"), self.alias_data())
        self.assertEqual(response.status_code, 302)
        self.assertFalse(ProductAlias.objects.filter(raw_name="Новое название").exists())

    def test_superuser_gets_changelist_add_and_change(self):
        line_add = admin_url(ReceiptLine, "add")
        for url in self.pages():
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 403 if url == line_add else 200)

    def test_receipt_line_cannot_be_added_separately(self):
        response = self.client.post(
            admin_url(ReceiptLine, "add"), {**line_row(position=2), "receipt": self.receipt.pk},
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(ReceiptLine.objects.count(), 1)


@tag("integration")
class ChangelistTests(ReceiptsAdminTestCase):
    def results(self, model, query):
        response = self.client.get(admin_url(model, "changelist"), query)
        # Неизвестный параметр админка отбрасывает редиректом на ?e=1, а не применяет.
        self.assertEqual(response.status_code, 200)
        return list(response.context["cl"].result_list)

    def test_search(self):
        cases = (
            (Receipt, "100"), (Receipt, "test:fiscal"), (Receipt, "Тестмарт"), (Receipt, "Примерная"),
            (ReceiptLine, "Тестовый"), (ReceiptLine, "SKU-1"), (ReceiptLine, "4000000000013"),
            (ProductAlias, "Тестовый"), (ProductAlias, "тестовый товар"), (ProductAlias, "SKU-1"),
        )
        for model, term in cases:
            with self.subTest(model=model.__name__, term=term):
                self.assertEqual(self.results(model, {"q": term}), [self.objects[model]])
        for model in MODELS:
            with self.subTest(model=model.__name__, term="нет"):
                self.assertEqual(self.results(model, {"q": "нет-такой-строки"}), [])

    def test_alias_search_by_product_name(self):
        other = Product.objects.create(generic=self.product.generic, name="Кефир особый")
        alias = ProductAlias.objects.create(
            merchant=self.merchant, product=other, raw_name="KEF 1L", name_key=name_key("KEF 1L"),
        )
        self.assertEqual(self.results(ProductAlias, {"q": "Кефир"}), [alias])

    def test_receipt_filters(self):
        germany = Country.objects.get(code="DE")
        other_currency = Currency.objects.create(code="XTT", name="Вторая тестовая валюта")
        refund = make_receipt(
            self.de_store, other_currency, operation="refund", receipt_number="200",
        )
        cases = (
            ({"operation__exact": "sale"}, [self.receipt]),
            ({"operation__exact": "refund"}, [refund]),
            ({"currency__code__exact": "XTS"}, [self.receipt]),
            ({"currency__code__exact": "XTT"}, [refund]),
            ({"store__country__code__exact": "XA"}, [self.receipt]),
            ({"store__country__code__exact": germany.pk}, [refund]),
        )
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.results(Receipt, query), expected)

    def test_receipt_date_hierarchy(self):
        self.assertEqual(admin.site.get_model_admin(Receipt).date_hierarchy, "purchased_on")
        cases = (
            ({"purchased_on__year": 2026}, [self.receipt]),
            ({"purchased_on__year": 2026, "purchased_on__month": 3}, [self.receipt]),
            ({"purchased_on__year": 2026, "purchased_on__month": 3, "purchased_on__day": 14}, [self.receipt]),
            ({"purchased_on__year": 2026, "purchased_on__month": 3, "purchased_on__day": 15}, []),
            ({"purchased_on__year": 2025}, []),
        )
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.results(Receipt, query), expected)

    def test_receipt_default_ordering(self):
        later = self.make_receipt(
            receipt_number="101", purchased_at=PURCHASED_AT.replace(hour=12),
        )
        same_time = self.make_receipt(receipt_number="102")
        self.assertEqual(self.results(Receipt, {}), [later, same_time, self.receipt])

    def test_receipt_line_filters(self):
        unmatched = make_line(
            self.receipt, position=2, kind="service", raw_name="Доставка", unit="kg",
            is_excise=True, is_marked=True,
        )
        cases = (
            ({"kind__exact": "product"}, [self.line]),
            ({"kind__exact": "service"}, [unmatched]),
            ({"unit__exact": "pcs"}, [self.line]),
            ({"unit__exact": "kg"}, [unmatched]),
            ({"is_excise__exact": "1"}, [unmatched]),
            ({"is_excise__exact": "0"}, [self.line]),
            ({"is_marked__exact": "1"}, [unmatched]),
            ({"is_marked__exact": "0"}, [self.line]),
            ({"product__isempty": "1"}, [unmatched]),
            ({"product__isempty": "0"}, [self.line]),
        )
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.results(ReceiptLine, query), expected)


@tag("integration")
class ChangelistQueryCountTests(ReceiptsAdminTestCase):
    """Число запросов списка не должно зависеть от числа строк."""

    def count_queries(self, model, expected_rows):
        url = admin_url(model, "changelist")
        # Первый запрос загружает и то, что потом кешируется.
        self.client.get(url)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get(url)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.context["cl"].result_list), expected_rows)
        return len(queries)

    def add_related(self, number):
        merchant = Merchant.objects.create(country=self.country, legal_name=f"ТОО «Продавец {number}»")
        store = Store.objects.create(
            merchant=merchant, country=self.country,
            address_raw=f"г. Тестоград, ул. Примерная, {number + 10}", timezone="Europe/Berlin",
        )
        currency = Currency.objects.create(code=f"XY{number}", name=f"Валюта {number}")
        product = Product.objects.create(generic=self.product.generic, name=f"Товар {number}")
        return merchant, store, currency, product

    def test_receipt(self):
        single = self.count_queries(Receipt, 1)
        for number in range(5):
            _, store, currency, _ = self.add_related(number)
            make_receipt(
                store, currency, receipt_number=str(number),
                purchased_on=PURCHASED_AT.date().replace(day=number + 1),
            )
        self.assertEqual(self.count_queries(Receipt, 6), single)

    def test_receipt_line(self):
        single = self.count_queries(ReceiptLine, 1)
        for number in range(6):
            _, store, currency, product = self.add_related(number)
            receipt = make_receipt(store, currency, receipt_number=str(number))
            # Половина строк не сопоставлена с товаром.
            make_line(receipt, raw_name=f"Строка {number}", product=product if number % 2 else None)
        self.assertEqual(ReceiptLine.objects.filter(product__isnull=True).count(), 3)
        self.assertEqual(self.count_queries(ReceiptLine, 7), single)

    def test_receipt_line_without_product(self):
        ReceiptLine.objects.filter(pk=self.line.pk).update(product=None)
        single = self.count_queries(ReceiptLine, 1)
        for number in range(5):
            _, store, currency, product = self.add_related(number)
            make_line(make_receipt(store, currency, receipt_number=str(number)), product=product)
        self.assertEqual(self.count_queries(ReceiptLine, 6), single)

    def test_product_alias(self):
        single = self.count_queries(ProductAlias, 1)
        for number in range(5):
            merchant, _, _, product = self.add_related(number)
            ProductAlias.objects.create(
                merchant=merchant, product=product, raw_name=f"Название {number}",
                name_key=name_key(f"Название {number}"),
            )
        self.assertEqual(self.count_queries(ProductAlias, 6), single)


@tag("integration")
class ReceiptSaveTests(ReceiptsAdminTestCase):
    def test_add_saves_receipt_with_line_discount_and_tax(self):
        response = self.client.post(admin_url(Receipt, "add"), self.receipt_data(
            receipt_number="555", total="9.00", discount_total="1.00",
            lines=[line_row(product=self.product.pk, tax_rate=self.tax_rate.pk, tax_code="A")],
            discounts=[discount_row()],
            taxes=[tax_row(tax_rate=self.tax_rate.pk)],
        ))
        self.assertSaved(response, Receipt)
        receipt = Receipt.objects.get(receipt_number="555")
        self.assertEqual((receipt.store, receipt.currency_id, receipt.operation), (self.store, "XTS", "sale"))
        self.assertEqual(receipt.purchased_at, PURCHASED_AT)
        self.assertEqual((receipt.total, receipt.discount_total), (Decimal("9.00"), Decimal("1.00")))
        line = receipt.lines.get()
        self.assertEqual(
            (line.position, line.raw_name, line.quantity, line.unit_price, line.amount, line.product, line.tax_rate),
            (1, "Тестовый товар", Decimal("1.000"), Decimal("10.0000"), Decimal("10.00"), self.product, self.tax_rate),
        )
        discount = receipt.discounts.get()
        self.assertEqual((discount.name, discount.amount, discount.line), ("Тестовая скидка", Decimal("1.00"), None))
        tax = receipt.taxes.get()
        self.assertEqual(
            (tax.tax_rate, tax.net, tax.tax, tax.gross),
            (self.tax_rate, Decimal("8.41"), Decimal("0.59"), Decimal("9.00")),
        )

    def test_change_saves_receipt_and_inlines(self):
        pk = self.receipt.pk
        response = self.client.post(admin_url(Receipt, "change", pk), self.receipt_data(
            receipt_number="100", fiscal_key="test:fiscal:1", total="9.25", discount_total="1.00",
            initial=(1, 0, 0),
            lines=[
                line_row(id=self.line.pk, receipt=pk, raw_name="Товар после правки", product=self.product.pk,
                         discount_amount="1.00"),
                line_row(receipt=pk, position=2, kind="deposit", parent=self.line.pk, raw_name="Залог",
                         unit_price="0.2500", amount="0.25"),
            ],
            discounts=[discount_row(receipt=pk, line=self.line.pk)],
            taxes=[tax_row(receipt=pk, tax_rate=self.tax_rate.pk, net="8.64", tax="0.61", gross="9.25")],
        ))
        self.assertSaved(response, Receipt)
        self.receipt.refresh_from_db()
        self.assertEqual(self.receipt.total, Decimal("9.25"))
        self.line.refresh_from_db()
        self.assertEqual((self.line.raw_name, self.line.discount_amount), ("Товар после правки", Decimal("1.00")))
        deposit = self.receipt.lines.get(position=2)
        self.assertEqual((deposit.kind, deposit.parent, deposit.amount), ("deposit", self.line, Decimal("0.25")))
        self.assertEqual(self.receipt.discounts.get().line, self.line)
        self.assertEqual(self.receipt.taxes.get().gross, Decimal("9.25"))

    def test_change_deletes_inline_line(self):
        pk = self.receipt.pk
        response = self.client.post(admin_url(Receipt, "change", pk), self.receipt_data(
            receipt_number="100", fiscal_key="test:fiscal:1", initial=(1, 0, 0),
            lines=[line_row(id=self.line.pk, receipt=pk, DELETE="on")],
        ))
        self.assertSaved(response, Receipt)
        self.assertFalse(self.receipt.lines.exists())

    def test_cleared_json_fields_are_saved_as_empty_objects(self):
        response = self.client.post(admin_url(Receipt, "add"), self.receipt_data(
            receipt_number="556", fiscal="", extra="", lines=[line_row(name_i18n="", extra="")],
        ))
        self.assertSaved(response, Receipt)
        receipt = Receipt.objects.get(receipt_number="556")
        self.assertEqual((receipt.fiscal, receipt.extra), ({}, {}))
        line = receipt.lines.get()
        self.assertEqual((line.name_i18n, line.extra), ({}, {}))

    def test_invalid_json_is_form_error(self):
        response = self.client.post(
            admin_url(Receipt, "add"), self.receipt_data(receipt_number="557", fiscal="{не json"),
        )
        self.assertFormError(response, "fiscal")
        self.assertFalse(Receipt.objects.filter(receipt_number="557").exists())

    def test_missing_required_fields_are_form_errors(self):
        response = self.client.post(admin_url(Receipt, "add"), self.receipt_data(
            store="", currency="", total="", purchased_on="", purchased_at_0="", purchased_at_1="",
        ))
        for field in ("store", "currency", "total", "purchased_on", "purchased_at"):
            self.assertFormError(response, field)
        self.assertEqual(Receipt.objects.count(), 1)

    def test_purchased_at_help_text_mentions_utc(self):
        form = self.client.get(admin_url(Receipt, "add")).context["adminform"].form
        self.assertIn("UTC", form.fields["purchased_at"].help_text)
        self.assertIn("Локальная дата магазина", form.fields["purchased_on"].help_text)

    def test_timestamps_are_readonly(self):
        form = self.client.get(admin_url(Receipt, "change", self.receipt.pk)).context["adminform"].form
        for name in ("created_at", "updated_at", "validation_warnings"):
            self.assertNotIn(name, form.fields)
        self.assertEqual(
            admin.site.get_model_admin(Receipt).readonly_fields,
            ("created_at", "updated_at", "validation_warnings"),
        )


@tag("integration")
class FiscalKeyTests(ReceiptsAdminTestCase):
    def de_data(self, **fields):
        fields.setdefault("fiscal", json.dumps(DE_FISCAL))
        fields.setdefault("store", self.de_store.pk)
        return self.receipt_data(**fields)

    def test_fiscal_key_is_built_from_fiscal(self):
        response = self.client.post(admin_url(Receipt, "add"), self.de_data())
        self.assertSaved(response, Receipt)
        receipt = Receipt.objects.get(store=self.de_store)
        self.assertEqual(receipt.fiscal_key, "de:TEST-000-0000-01:427161")
        self.assertEqual(receipt.fiscal_key, build_fiscal_key("DE", DE_FISCAL))
        self.assertEqual(receipt.fiscal, DE_FISCAL)

    def test_fiscal_key_is_built_on_change(self):
        receipt = make_receipt(self.de_store, self.currency, receipt_number="7")
        response = self.client.post(
            admin_url(Receipt, "change", receipt.pk), self.de_data(receipt_number="7"),
        )
        self.assertSaved(response, Receipt)
        receipt.refresh_from_db()
        self.assertEqual(receipt.fiscal_key, "de:TEST-000-0000-01:427161")

    def test_entered_fiscal_key_is_kept(self):
        response = self.client.post(admin_url(Receipt, "add"), self.de_data(fiscal_key="de:manual:1"))
        self.assertSaved(response, Receipt)
        self.assertEqual(Receipt.objects.get(store=self.de_store).fiscal_key, "de:manual:1")

    def test_fiscal_key_stays_empty_without_scheme_or_requisites(self):
        cases = (
            {"store": self.store.pk, "receipt_number": "601"},  # у страны XA схемы нет
            {"receipt_number": "602", "fiscal": '{"register_serial": "TEST-000-0000-01"}'},
            {"receipt_number": "603", "fiscal": "{}"},
        )
        for case in cases:
            with self.subTest(**case):
                response = self.client.post(admin_url(Receipt, "add"), self.de_data(**case))
                self.assertSaved(response, Receipt)
                self.assertEqual(Receipt.objects.get(receipt_number=case["receipt_number"]).fiscal_key, "")

    def test_too_long_fiscal_key_is_form_error(self):
        fiscal = '{"register_serial": "%s", "tse_transaction": "1"}' % ("9" * 200)
        response = self.client.post(admin_url(Receipt, "add"), self.de_data(fiscal=fiscal))
        self.assertFormError(response, "fiscal", "длиннее 160")
        self.assertFalse(Receipt.objects.filter(store=self.de_store).exists())

    def test_duplicate_by_built_fiscal_key_is_form_error(self):
        make_receipt(self.de_store, self.currency, fiscal_key=build_fiscal_key("DE", DE_FISCAL), receipt_number="1")
        # Другой номер, время и сумма: совпадает только фискальный ключ, собранный формой.
        response = self.client.post(admin_url(Receipt, "add"), self.de_data(
            receipt_number="2", purchased_at_1="15:00:00", total="77.00",
        ))
        self.assertFormError(response, "__all__", "receipts_receipt_owner_fiscal_key_uniq")
        self.assertEqual(Receipt.objects.filter(store=self.de_store).count(), 1)

    def test_duplicate_by_entered_fiscal_key_is_form_error(self):
        response = self.client.post(
            admin_url(Receipt, "add"), self.receipt_data(store=self.other_store.pk, fiscal_key="test:fiscal:1"),
        )
        self.assertFormError(response, "__all__", "receipts_receipt_owner_fiscal_key_uniq")
        self.assertEqual(Receipt.objects.count(), 1)

    def test_duplicate_by_store_number_is_form_error(self):
        response = self.client.post(
            admin_url(Receipt, "add"), self.receipt_data(receipt_number="100", total="55.00"),
        )
        self.assertFormError(response, "__all__", "receipts_receipt_owner_store_number_uniq")
        self.assertEqual(Receipt.objects.count(), 1)

    def test_duplicate_by_store_time_total_is_form_error(self):
        self.make_receipt(store=self.other_store)
        response = self.client.post(admin_url(Receipt, "add"), self.receipt_data(store=self.other_store.pk))
        self.assertFormError(response, "__all__", "receipts_receipt_owner_store_time_total_uniq")
        self.assertEqual(Receipt.objects.filter(store=self.other_store).count(), 1)

    def test_saving_receipt_again_is_not_its_own_duplicate(self):
        response = self.client.post(admin_url(Receipt, "change", self.receipt.pk), self.receipt_data(
            receipt_number="100", fiscal_key="test:fiscal:1", initial=(1, 0, 0),
            lines=[line_row(id=self.line.pk, receipt=self.receipt.pk, product=self.product.pk)],
        ))
        self.assertSaved(response, Receipt)


@tag("integration")
class ReceiptOwnerAdminTests(ReceiptsAdminTestCase):
    """Владелец чека: обязателен, по умолчанию текущий пользователь, после сохранения не меняется."""

    def form(self, url):
        return self.client.get(url).context["adminform"].form

    def changelist(self, query=None):
        response = self.client.get(admin_url(Receipt, "changelist"), query or {})
        self.assertEqual(response.status_code, 200)
        return response.context["cl"]

    def test_owner_is_required_on_add(self):
        response = self.client.post(admin_url(Receipt, "add"), self.receipt_data(receipt_number="800", owner=""))
        self.assertFormError(response, "owner")
        self.assertFalse(Receipt.objects.filter(receipt_number="800").exists())

    def test_add_form_starts_with_current_user(self):
        form = self.form(admin_url(Receipt, "add"))
        self.assertFalse(form.fields["owner"].disabled)
        self.assertEqual(form["owner"].value(), self.superuser.pk)
        self.staff_user.user_permissions.add(*Permission.objects.filter(
            content_type__app_label="receipts", codename__in=("add_receipt", "view_receipt"),
        ))
        self.client.force_login(self.staff_user)
        self.assertEqual(self.form(admin_url(Receipt, "add"))["owner"].value(), self.staff_user.pk)

    def test_add_saves_chosen_owner(self):
        response = self.client.post(
            admin_url(Receipt, "add"), self.receipt_data(receipt_number="801", owner=self.plain_user.pk),
        )
        self.assertSaved(response, Receipt)
        self.assertEqual(Receipt.objects.get(receipt_number="801").owner, self.plain_user)

    def test_owner_is_disabled_on_change(self):
        form = self.form(admin_url(Receipt, "change", self.receipt.pk))
        self.assertTrue(form.fields["owner"].disabled)
        self.assertEqual(form["owner"].value(), self.receipt.owner_id)
        # Поле остаётся в форме: иначе ограничения с owner выпали бы из проверки.
        self.assertNotIn("owner", admin.site.get_model_admin(Receipt).readonly_fields)

    def test_change_ignores_posted_owner(self):
        owner = self.receipt.owner
        response = self.client.post(admin_url(Receipt, "change", self.receipt.pk), self.receipt_data(
            owner=self.plain_user.pk, receipt_number="100", fiscal_key="test:fiscal:1", total="12.00",
            initial=(1, 0, 0),
            lines=[line_row(id=self.line.pk, receipt=self.receipt.pk, product=self.product.pk)],
        ))
        self.assertSaved(response, Receipt)
        self.receipt.refresh_from_db()
        self.assertEqual((self.receipt.owner, self.receipt.total), (owner, Decimal("12.00")))

    def test_same_receipt_of_other_owner_is_saved(self):
        cases = (
            {"receipt_number": "100", "fiscal_key": "test:fiscal:1"},  # ключ и номер заняты у первого владельца
            {"receipt_number": "100"},
            {"fiscal_key": "test:fiscal:1", "store": self.other_store.pk},
        )
        for number, case in enumerate(cases):
            with self.subTest(**case):
                owner = get_user_model().objects.create_user(f"owner-{number}")
                response = self.client.post(
                    admin_url(Receipt, "add"), self.receipt_data(owner=owner.pk, **case),
                )
                self.assertSaved(response, Receipt)
                self.assertEqual(Receipt.objects.filter(owner=owner).count(), 1)
        self.assertEqual(Receipt.objects.filter(owner=self.receipt.owner).count(), 1)

    def test_same_time_and_total_of_other_owner_is_saved(self):
        # Третий уровень: без номера и ключа совпадают магазин, время и сумма.
        self.make_receipt(store=self.other_store)
        response = self.client.post(
            admin_url(Receipt, "add"), self.receipt_data(store=self.other_store.pk, owner=self.plain_user.pk),
        )
        self.assertSaved(response, Receipt)
        self.assertEqual(Receipt.objects.filter(store=self.other_store).count(), 2)

    def test_same_owner_duplicate_is_still_form_error(self):
        make_receipt(self.store, self.currency, owner=self.plain_user, receipt_number="100")
        response = self.client.post(
            admin_url(Receipt, "add"), self.receipt_data(owner=self.plain_user.pk, receipt_number="100"),
        )
        self.assertFormError(response, "__all__", "receipts_receipt_owner_store_number_uniq")
        self.assertEqual(Receipt.objects.filter(owner=self.plain_user).count(), 1)

    def test_change_into_own_duplicate_is_form_error(self):
        # Отключённое поле владельца участвует в проверке: отказ формой, а не IntegrityError.
        second = make_receipt(self.store, self.currency, owner=self.receipt.owner, receipt_number="101")
        response = self.client.post(
            admin_url(Receipt, "change", second.pk), self.receipt_data(receipt_number="100"),
        )
        self.assertFormError(response, "__all__", "receipts_receipt_owner_store_number_uniq")
        second.refresh_from_db()
        self.assertEqual(second.receipt_number, "101")

    def test_change_into_duplicate_of_other_owner_is_saved(self):
        second = make_receipt(self.store, self.currency, owner=self.plain_user, receipt_number="101")
        response = self.client.post(
            # В POST — владелец первого чека: решает сохранённый, а не присланный.
            admin_url(Receipt, "change", second.pk), self.receipt_data(receipt_number="100"),
        )
        self.assertSaved(response, Receipt)
        second.refresh_from_db()
        self.assertEqual((second.receipt_number, second.owner), ("100", self.plain_user))

    def test_owner_column_and_filter(self):
        other = make_receipt(self.store, self.currency, owner=self.plain_user, receipt_number="200")
        model_admin = admin.site.get_model_admin(Receipt)
        self.assertIn("owner", model_admin.list_display)
        self.assertIn(("owner", admin.RelatedOnlyFieldListFilter), model_admin.list_filter)
        self.assertEqual(list(self.changelist({"owner__id__exact": self.plain_user.pk}).result_list), [other])
        self.assertEqual(
            list(self.changelist({"owner__id__exact": self.receipt.owner_id}).result_list), [self.receipt],
        )
        self.assertEqual(len(self.changelist().result_list), 2)

    def test_owner_filter_offers_only_users_with_receipts(self):
        make_receipt(self.store, self.currency, owner=self.plain_user, receipt_number="200")
        spec = next(
            spec for spec in self.changelist().filter_specs
            if isinstance(spec, admin.RelatedOnlyFieldListFilter)
        )
        self.assertEqual(
            sorted(pk for pk, _ in spec.lookup_choices), sorted([self.receipt.owner_id, self.plain_user.pk]),
        )

    def test_changelist_queries_do_not_grow_with_owners(self):
        url = admin_url(Receipt, "changelist")

        def count(expected_rows):
            self.client.get(url)
            with CaptureQueriesContext(connection) as queries:
                response = self.client.get(url)
            self.assertEqual(len(response.context["cl"].result_list), expected_rows)
            return len(queries)

        single = count(1)
        for number in range(5):
            owner = get_user_model().objects.create_user(f"owner-{number}")
            make_receipt(self.store, self.currency, owner=owner, receipt_number=str(number))
        self.assertEqual(count(6), single)


@tag("integration")
class InlineErrorTests(ReceiptsAdminTestCase):
    def post_add(self, **inlines):
        return self.client.post(admin_url(Receipt, "add"), self.receipt_data(receipt_number="700", **inlines))

    def assert_not_saved(self, response, prefix):
        self.assertEqual(response.status_code, 200)
        self.assertGreater(self.formset(response, prefix).total_error_count(), 0, self.all_errors(response))
        self.assertFalse(Receipt.objects.filter(receipt_number="700").exists())

    def form_errors(self, response, prefix, index=0):
        return " ".join(self.formset(response, prefix).errors[index].get("__all__", []))

    def test_gross_not_equal_net_plus_tax_is_form_error(self):
        response = self.post_add(
            lines=[line_row()], taxes=[tax_row(tax_rate=self.tax_rate.pk, gross="9.99")],
        )
        self.assert_not_saved(response, "taxes")
        self.assertIn("receipts_receipttax_net_plus_tax_eq_gross", self.form_errors(response, "taxes"))
        self.assertFalse(ReceiptTax.objects.exists())

    def test_line_check_violations_are_form_errors(self):
        cases = (
            ({"quantity": "0"}, "receipts_receiptline_quantity_nonzero"),
            ({"unit_price": "-1.0000"}, "receipts_receiptline_unit_price_nonnegative"),
            ({"discount_amount": "-1.00"}, "receipts_receiptline_discount_amount_nonnegative"),
            ({"quantity": "-1.000"}, "receipts_receiptline_quantity_amount_same_sign"),
            ({"kind": "deposit_return"}, "receipts_receiptline_deposit_return_not_positive"),
        )
        for fields, constraint in cases:
            with self.subTest(**fields):
                response = self.post_add(lines=[line_row(**fields)])
                self.assert_not_saved(response, "lines")
                self.assertIn(constraint, self.form_errors(response, "lines"))
        self.assertEqual(ReceiptLine.objects.count(), 1)

    def test_discount_amount_not_positive_is_form_error(self):
        response = self.post_add(lines=[line_row()], discounts=[discount_row(amount="0.00")])
        self.assert_not_saved(response, "discounts")
        self.assertIn("receipts_receiptdiscount_amount_positive", self.form_errors(response, "discounts"))

    def test_unknown_kind_is_form_error(self):
        response = self.post_add(lines=[line_row(kind="gift")])
        self.assert_not_saved(response, "lines")
        self.assertIn("kind", self.formset(response, "lines").errors[0])

    def test_duplicate_position_in_new_lines_is_form_error(self):
        response = self.post_add(lines=[line_row(), line_row(raw_name="Второй товар")])
        self.assert_not_saved(response, "lines")
        self.assertEqual(ReceiptLine.objects.count(), 1)

    def test_duplicate_position_with_saved_line_is_form_error(self):
        pk = self.receipt.pk
        response = self.client.post(admin_url(Receipt, "change", pk), self.receipt_data(
            receipt_number="100", fiscal_key="test:fiscal:1", initial=(1, 0, 0),
            lines=[
                line_row(id=self.line.pk, receipt=pk, product=self.product.pk),
                line_row(receipt=pk, raw_name="Второй товар"),
            ],
        ))
        self.assertEqual(response.status_code, 200)
        self.assertGreater(self.formset(response, "lines").total_error_count(), 0)
        self.assertEqual(self.receipt.lines.count(), 1)

    def test_duplicate_tax_rate_is_form_error(self):
        response = self.post_add(lines=[line_row()], taxes=[
            tax_row(tax_rate=self.tax_rate.pk), tax_row(tax_rate=self.tax_rate.pk),
        ])
        self.assert_not_saved(response, "taxes")

    def test_parent_on_product_line_is_form_error(self):
        pk = self.receipt.pk
        response = self.client.post(admin_url(Receipt, "change", pk), self.receipt_data(
            receipt_number="100", fiscal_key="test:fiscal:1", initial=(1, 0, 0),
            lines=[
                line_row(id=self.line.pk, receipt=pk, product=self.product.pk),
                line_row(receipt=pk, position=2, parent=self.line.pk, raw_name="Не залог"),
            ],
        ))
        self.assertEqual(response.status_code, 200)
        self.assertIn("receipts_receiptline_parent_only_for_deposit", self.form_errors(response, "lines", 1))
        self.assertEqual(self.receipt.lines.count(), 1)


@tag("integration")
class LineChoicesTests(ReceiptsAdminTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.second_line = make_line(cls.receipt, position=2, raw_name="Второй товар")
        cls.other_receipt = make_receipt(cls.other_store, cls.currency, receipt_number="300")
        cls.other_line = make_line(cls.other_receipt, raw_name="Чужая строка")

    def choices(self, response, prefix, field):
        formset = self.formset(response, prefix)
        forms = [*formset.forms, formset.empty_form]
        return [list(form.fields[field].queryset) for form in forms]

    def test_change_page_offers_only_lines_of_this_receipt(self):
        response = self.client.get(admin_url(Receipt, "change", self.receipt.pk))
        own = [self.line, self.second_line]
        self.assertEqual(self.choices(response, "lines", "parent"), [own, own, own])
        self.assertEqual(self.choices(response, "discounts", "line"), [own])
        response = self.client.get(admin_url(Receipt, "change", self.other_receipt.pk))
        self.assertEqual(self.choices(response, "lines", "parent"), [[self.other_line], [self.other_line]])
        self.assertEqual(self.choices(response, "discounts", "line"), [[self.other_line]])

    def test_add_page_offers_no_lines(self):
        response = self.client.get(admin_url(Receipt, "add"))
        self.assertEqual(self.choices(response, "lines", "parent"), [[]])
        self.assertEqual(self.choices(response, "discounts", "line"), [[]])

    def test_choice_label_shows_position(self):
        response = self.client.get(admin_url(Receipt, "change", self.receipt.pk))
        field = self.formset(response, "discounts").empty_form.fields["line"]
        self.assertEqual(
            [label for _, label in field.choices][1:], ["1. Тестовый товар", "2. Второй товар"],
        )

    def change_data(self, **inlines):
        pk = self.receipt.pk
        lines = [
            line_row(id=self.line.pk, receipt=pk, product=self.product.pk),
            line_row(id=self.second_line.pk, receipt=pk, position=2, raw_name="Второй товар"),
            *inlines.pop("new_lines", ()),
        ]
        return self.receipt_data(
            receipt_number="100", fiscal_key="test:fiscal:1", initial=(2, 0, 0), lines=lines, **inlines,
        )

    def test_parent_from_other_receipt_is_rejected(self):
        pk = self.receipt.pk
        response = self.client.post(admin_url(Receipt, "change", pk), self.change_data(new_lines=[
            line_row(receipt=pk, position=3, kind="deposit", parent=self.other_line.pk, raw_name="Залог"),
        ]))
        self.assertEqual(response.status_code, 200)
        self.assertIn("parent", self.formset(response, "lines").errors[2])
        self.assertEqual(self.receipt.lines.count(), 2)

    def test_discount_line_from_other_receipt_is_rejected(self):
        pk = self.receipt.pk
        response = self.client.post(admin_url(Receipt, "change", pk), self.change_data(
            discounts=[discount_row(receipt=pk, line=self.other_line.pk)],
        ))
        self.assertEqual(response.status_code, 200)
        self.assertIn("line", self.formset(response, "discounts").errors[0])
        self.assertFalse(ReceiptDiscount.objects.exists())

    def test_line_on_add_page_is_rejected(self):
        response = self.client.post(admin_url(Receipt, "add"), self.receipt_data(
            receipt_number="701", lines=[line_row()], discounts=[discount_row(line=self.line.pk)],
        ))
        self.assertEqual(response.status_code, 200)
        self.assertIn("line", self.formset(response, "discounts").errors[0])
        self.assertFalse(Receipt.objects.filter(receipt_number="701").exists())

    def test_line_cannot_be_its_own_parent(self):
        pk = self.receipt.pk
        data = self.change_data()
        data.update({"lines-1-kind": "deposit", "lines-1-parent": self.second_line.pk})
        response = self.client.post(admin_url(Receipt, "change", pk), data)
        self.assertEqual(response.status_code, 200)
        self.assertIn("самой себе", " ".join(self.formset(response, "lines").errors[1]["parent"]))
        self.second_line.refresh_from_db()
        self.assertIsNone(self.second_line.parent)


@tag("integration")
class ReceiptLineAdminTests(ReceiptsAdminTestCase):
    def line_data(self, **fields):
        return line_row(receipt=self.receipt.pk, **fields)

    def test_change_matches_line_with_product(self):
        line = make_line(self.receipt, position=2, raw_name="Не сопоставлено")
        response = self.client.post(
            admin_url(ReceiptLine, "change", line.pk),
            self.line_data(position=2, raw_name="Не сопоставлено", product=self.product.pk),
        )
        self.assertSaved(response, ReceiptLine)
        line.refresh_from_db()
        self.assertEqual(line.product, self.product)

    def test_parent_is_raw_id_field(self):
        form = self.client.get(admin_url(ReceiptLine, "change", self.line.pk)).context["adminform"].form
        self.assertEqual(type(form.fields["parent"].widget).__name__, "ForeignKeyRawIdWidget")

    def test_duplicate_position_is_form_error(self):
        line = make_line(self.receipt, position=2)
        response = self.client.post(admin_url(ReceiptLine, "change", line.pk), self.line_data(position=1))
        self.assertFormError(response, "__all__")
        line.refresh_from_db()
        self.assertEqual(line.position, 2)

    def test_zero_quantity_is_form_error(self):
        response = self.client.post(
            admin_url(ReceiptLine, "change", self.line.pk), self.line_data(quantity="0"),
        )
        self.assertFormError(response, "__all__", "receipts_receiptline_quantity_nonzero")

    def test_parent_must_belong_to_same_receipt(self):
        other_line = make_line(self.make_receipt(store=self.other_store), raw_name="Чужая строка")
        deposit = make_line(self.receipt, position=2, kind="deposit", raw_name="Залог")
        url = admin_url(ReceiptLine, "change", deposit.pk)
        data = {"position": 2, "kind": "deposit", "raw_name": "Залог"}
        self.assertFormError(
            self.client.post(url, self.line_data(parent=other_line.pk, **data)), "parent", "этого же чека",
        )
        self.assertFormError(
            self.client.post(url, self.line_data(parent=deposit.pk, **data)), "parent", "самой себе",
        )
        self.assertSaved(self.client.post(url, self.line_data(parent=self.line.pk, **data)), ReceiptLine)
        deposit.refresh_from_db()
        self.assertEqual(deposit.parent, self.line)


@tag("integration")
class ReceiptLineMoveTests(ReceiptsAdminTestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.target = make_receipt(cls.store, cls.currency, receipt_number="200")

    def move(self, line=None, **fields):
        line = line or self.line
        return self.client.post(admin_url(ReceiptLine, "change", line.pk), line_row(**{
            "receipt": self.target.pk, "position": line.position, "kind": line.kind,
            "parent": line.parent_id or "", "raw_name": line.raw_name, "product": line.product_id or "", **fields,
        }))

    def assertUnchanged(self, *objects):
        for obj in objects:
            with self.subTest(model=type(obj).__name__, pk=obj.pk):
                saved = type(obj).objects.get(pk=obj.pk)
                for field in obj._meta.concrete_fields:
                    self.assertEqual(getattr(saved, field.attname), field.to_python(getattr(obj, field.attname)))

    def test_move_with_child_is_rejected_and_data_unchanged(self):
        child = make_line(self.receipt, position=2, kind="deposit", parent=self.line, raw_name="Залог")
        self.assertFormError(self.move(), "receipt", "привязаны залоги или скидки")
        self.assertUnchanged(self.line, child)

    def test_move_with_discount_is_rejected_and_data_unchanged(self):
        discount = ReceiptDiscount.objects.create(
            receipt=self.receipt, line=self.line, position=1, name="Скидка", amount="1.00",
        )
        self.assertFormError(self.move(), "receipt", "привязаны залоги или скидки")
        self.assertUnchanged(self.line, discount)

    def test_move_without_dependencies_still_works(self):
        self.assertSaved(self.move(), ReceiptLine)
        self.line.refresh_from_db()
        self.assertEqual(self.line.receipt_id, self.target.pk)
        self.assertFalse(self.receipt.lines.exists())

    def test_move_with_parent_in_source_is_rejected(self):
        child = make_line(self.receipt, position=2, kind="deposit", parent=self.line, raw_name="Залог")
        self.assertFormError(self.move(child), "parent", "этого же чека")
        self.assertUnchanged(self.line, child)

    def test_move_with_parent_in_target_is_allowed(self):
        parent = make_line(self.target)
        child = make_line(self.receipt, position=2, kind="deposit", parent=self.line, raw_name="Залог")
        self.assertSaved(self.move(child, parent=parent.pk), ReceiptLine)
        child.refresh_from_db()
        self.assertEqual((child.receipt_id, child.parent_id), (self.target.pk, parent.pk))

    def test_move_after_detaching_parent_is_allowed(self):
        child = make_line(self.receipt, position=2, kind="deposit", parent=self.line, raw_name="Залог")
        self.assertSaved(self.move(child, parent=""), ReceiptLine)
        child.refresh_from_db()
        self.assertEqual(child.receipt_id, self.target.pk)
        self.assertIsNone(child.parent_id)

    def test_delete_target_after_rejected_moves_preserves_source_dependencies(self):
        child = make_line(self.receipt, position=2, kind="deposit", parent=self.line, raw_name="Залог")
        discount = ReceiptDiscount.objects.create(
            receipt=self.receipt, line=self.line, position=1, name="Скидка", amount="1.00",
        )
        # Повторный POST также не меняет данные.
        for _ in range(2):
            self.assertFormError(self.move(), "receipt")
        response = self.client.post(admin_url(Receipt, "delete", self.target.pk), {"post": "yes"})
        self.assertSaved(response, Receipt)
        self.assertFalse(Receipt.objects.filter(pk=self.target.pk).exists())
        self.assertTrue(Receipt.objects.filter(pk=self.receipt.pk).exists())
        self.assertUnchanged(self.line, child, discount)

    def test_inline_edit_preserves_receipt_and_dependencies(self):
        child = make_line(self.receipt, position=2, kind="deposit", parent=self.line, raw_name="Залог")
        discount = ReceiptDiscount.objects.create(
            receipt=self.receipt, line=self.line, position=1, name="Скидка", amount="1.00",
        )
        data = self.receipt_data(
            receipt_number="100", fiscal_key="test:fiscal:1", initial=(2, 1, 0),
            lines=[
                line_row(id=self.line.pk, receipt=self.receipt.pk, raw_name="После правки"),
                line_row(id=child.pk, receipt=self.receipt.pk, position=2, kind="deposit",
                         parent=self.line.pk, raw_name="Залог"),
            ],
            discounts=[discount_row(id=discount.pk, receipt=self.receipt.pk, line=self.line.pk, name="Скидка")],
        )
        self.assertSaved(self.client.post(admin_url(Receipt, "change", self.receipt.pk), data), Receipt)
        self.line.refresh_from_db()
        child.refresh_from_db()
        discount.refresh_from_db()
        self.assertEqual(self.line.raw_name, "После правки")
        self.assertEqual((self.line.receipt_id, child.receipt_id, discount.receipt_id), (self.receipt.pk,) * 3)
        self.assertEqual((child.parent_id, discount.line_id), (self.line.pk,) * 2)

    def test_inline_receipt_tampering_is_rejected(self):
        data = self.receipt_data(
            receipt_number="100", fiscal_key="test:fiscal:1", initial=(1, 0, 0),
            lines=[line_row(id=self.line.pk, receipt=self.target.pk)],
        )
        response = self.client.post(admin_url(Receipt, "change", self.receipt.pk), data)
        self.assertEqual(response.status_code, 200)
        self.assertIn("receipt", self.formset(response, "lines").errors[0])
        self.assertUnchanged(self.line)

    def test_staff_without_change_permission_cannot_move(self):
        self.client.force_login(self.staff_user)
        self.assertEqual(self.move().status_code, 403)
        self.assertUnchanged(self.line)


@tag("integration")
class ReceiptLineConcurrencyTests(TransactionTestCase):
    """Два настоящих admin POST на разных PostgreSQL-соединениях, без внешнего atomic теста."""

    receipt_data = ReceiptsAdminTestCase.receipt_data

    def setUp(self):
        country = Country.objects.create(code="XA", name="Тестовая страна")
        self.currency = Currency.objects.create(code="XTS", name="Тестовая валюта")
        merchant = Merchant.objects.create(country=country, legal_name="Тестовый продавец")
        self.store = Store.objects.create(
            merchant=merchant, country=country, address_raw="Тестоград, Примерная, 1", timezone="UTC",
        )
        self.user = get_user_model().objects.create_superuser("race-user", password="test-only-password")
        self.source = make_receipt(self.store, self.currency, receipt_number="100")
        self.target = make_receipt(self.store, self.currency, receipt_number="200")
        self.line = make_line(self.source)

    def concurrent_requests(self, kind, first):
        validated = threading.Event()
        release = threading.Event()
        waiting = threading.Event()
        pids = {}
        state = threading.local()
        form_class = ReceiptLineAdminForm if first == "move" or kind == "child" else ReceiptDiscountAdminForm
        original_clean = form_class.clean

        def pause_after_validation(form):
            cleaned = original_clean(form)
            is_first_form = (
                form.instance.pk == self.line.pk if first == "move"
                else form.instance.pk is None
            )
            if state.action == first and is_first_form:
                validated.set()
                if not release.wait(10):
                    raise AssertionError("Первый запрос не получил разрешение завершиться")
            return cleaned

        def post(action):
            state.action = action
            try:
                client = Client()
                client.force_login(self.user)
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_backend_pid()")
                    pids[action] = cursor.fetchone()[0]
                if action != first:
                    waiting.set()
                if action == "move":
                    return client.post(admin_url(ReceiptLine, "change", self.line.pk), line_row(receipt=self.target.pk))
                data = self.receipt_data(
                    receipt_number="100",
                    lines=[line_row(position=2, kind="deposit", parent=self.line.pk, raw_name="Залог")]
                    if kind == "child" else [],
                    discounts=[discount_row(line=self.line.pk)] if kind == "discount" else [],
                )
                return client.post(admin_url(Receipt, "change", self.source.pk), data)
            finally:
                connections.close_all()

        second = "create" if first == "move" else "move"
        with patch.object(form_class, "clean", pause_after_validation), ThreadPoolExecutor(max_workers=2) as pool:
            first_result = pool.submit(post, first)
            try:
                self.assertTrue(validated.wait(5), "Первый POST не дошёл до проверки")
                second_result = pool.submit(post, second)
                self.assertTrue(waiting.wait(5), "Второй POST не запущен")
                deadline = time.monotonic() + 1
                blocked = False
                while time.monotonic() < deadline:
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT %s = ANY(pg_blocking_pids(%s))", [pids[first], pids[second]])
                        blocked = cursor.fetchone()[0]
                    if blocked:
                        break
                    time.sleep(0.01)
                self.assertTrue(blocked, "Второй POST не ожидал блокировку первого")
            finally:
                release.set()
            responses = {first: first_result.result(timeout=10), second: second_result.result(timeout=10)}
        self.assertNotEqual(pids[first], pids[second])
        self.assertEqual(responses[first].status_code, 302)
        self.assertEqual(responses[second].status_code, 200)
        self.line.refresh_from_db()
        if first == "move":
            self.assertEqual(self.line.receipt_id, self.target.pk)
            self.assertFalse(self.line.children.exists())
            self.assertFalse(self.line.discounts.exists())
            formsets = {item.formset.prefix: item.formset for item in responses["create"].context["inline_admin_formsets"]}
            prefix, field = ("lines", "parent") if kind == "child" else ("discounts", "line")
            self.assertIn(field, formsets[prefix].errors[0])
        else:
            self.assertEqual(self.line.receipt_id, self.source.pk)
            errors = responses["move"].context["adminform"].form.errors
            self.assertIn("receipt", errors)
            related = self.line.children.get() if kind == "child" else self.line.discounts.get()
            self.assertEqual(related.receipt_id, self.source.pk)

    def test_child_creation_waits_for_move_and_is_rejected(self):
        self.concurrent_requests("child", "move")

    def test_discount_creation_waits_for_move_and_is_rejected(self):
        self.concurrent_requests("discount", "move")

    def test_move_waits_for_child_creation_and_is_rejected(self):
        self.concurrent_requests("child", "create")

    def test_move_waits_for_discount_creation_and_is_rejected(self):
        self.concurrent_requests("discount", "create")


@tag("integration")
class ReceiptInlineTransactionTests(TransactionTestCase):
    """DELETE проверяется с настоящим commit, а гонки — на отдельных соединениях."""

    receipt_data = ReceiptsAdminTestCase.receipt_data
    formset = ReceiptsAdminTestCase.formset

    def setUp(self):
        country = Country.objects.create(code="XA", name="Тестовая страна")
        self.currency = Currency.objects.create(code="XTS", name="Тестовая валюта")
        merchant = Merchant.objects.create(country=country, legal_name="Тестовый продавец")
        self.store = Store.objects.create(
            merchant=merchant, country=country, address_raw="Тестоград, Примерная, 1", timezone="UTC",
        )
        self.tax_rate = TaxRate.objects.create(country=country, kind="vat", rate="7.00", name="Тестовый НДС")
        self.user = get_user_model().objects.create_superuser("inline-user", password="test-only-password")
        self.client.force_login(self.user)
        self.receipt = make_receipt(self.store, self.currency, receipt_number="100")
        self.target = make_receipt(self.store, self.currency, receipt_number="200")
        self.line = make_line(self.receipt)

    def post(self, **fields):
        return self.client.post(
            admin_url(Receipt, "change", self.receipt.pk), self.receipt_data(**{"receipt_number": "100", **fields}),
        )

    def child(self, **fields):
        return make_line(self.receipt, position=2, kind="deposit", parent=self.line, raw_name="Залог", **fields)

    def discount(self, **fields):
        return ReceiptDiscount.objects.create(
            receipt=self.receipt, position=1, name="Скидка", amount="1.00", **fields,
        )

    def child_row(self, child, **fields):
        return line_row(**{
            "id": child.pk, "receipt": self.receipt.pk, "position": child.position,
            "kind": "deposit", "raw_name": child.raw_name, "parent": child.parent_id or "", **fields,
        })

    def assertRejected(self, response, prefix, field=None, index=0):
        self.assertEqual(response.status_code, 200)
        formset = self.formset(response, prefix)
        if field:
            self.assertIn(field, formset.forms[index].errors)
            self.assertEqual(formset.forms[index].errors.as_data()[field][0].code, f"{field}_deleted")
        else:
            self.assertTrue(formset.non_form_errors())
            self.assertEqual(formset.non_form_errors().as_data()[0].code, "receipt_inline_conflict")
        self.receipt.refresh_from_db()
        self.assertEqual(self.receipt.receipt_number, "100")

    def test_delete_parent_and_edit_child_is_rejected_at_commit(self):
        child = self.child()
        response = self.post(
            receipt_number="changed", initial=(2, 0, 0), lines=[
                line_row(id=self.line.pk, DELETE="on"),
                self.child_row(child, raw_name="Изменённый залог"),
            ],
        )
        self.assertRejected(response, "lines", "parent", 1)
        child.refresh_from_db()
        self.assertEqual((child.raw_name, child.parent_id), ("Залог", self.line.pk))
        self.assertTrue(ReceiptLine.objects.filter(pk=self.line.pk).exists())

    def test_delete_line_and_edit_discount_is_rejected_at_commit(self):
        discount = self.discount(line=self.line)
        response = self.post(
            receipt_number="changed", initial=(1, 1, 0),
            lines=[line_row(id=self.line.pk, DELETE="on")],
            discounts=[discount_row(id=discount.pk, line=self.line.pk, name="Изменённая скидка")],
        )
        self.assertRejected(response, "discounts", "line")
        discount.refresh_from_db()
        self.assertEqual((discount.name, discount.line_id), ("Скидка", self.line.pk))
        self.assertTrue(ReceiptLine.objects.filter(pk=self.line.pk).exists())

    def test_delete_line_and_create_child_is_rejected(self):
        response = self.post(
            receipt_number="changed", initial=(1, 0, 0), lines=[
                line_row(id=self.line.pk, DELETE="on"),
                line_row(position=2, kind="deposit", parent=self.line.pk, raw_name="Новый залог"),
            ],
        )
        self.assertRejected(response, "lines", "parent", 1)
        self.assertEqual(self.receipt.lines.count(), 1)

    def test_delete_line_and_create_discount_is_rejected(self):
        response = self.post(
            receipt_number="changed", initial=(1, 0, 0),
            lines=[line_row(id=self.line.pk, DELETE="on")],
            discounts=[discount_row(line=self.line.pk)],
        )
        self.assertRejected(response, "discounts", "line")
        self.assertTrue(ReceiptLine.objects.filter(pk=self.line.pk).exists())
        self.assertFalse(self.receipt.discounts.exists())

    def test_delete_parent_and_edit_cascaded_grandchild_is_rejected(self):
        child = self.child()
        grandchild = make_line(self.receipt, position=3, kind="deposit", parent=child, raw_name="Второй залог")
        response = self.post(initial=(3, 0, 0), lines=[
            line_row(id=self.line.pk, DELETE="on"), self.child_row(child),
            self.child_row(grandchild, raw_name="Изменённый залог"),
        ])
        self.assertRejected(response, "lines", "parent", 2)
        self.assertEqual(self.receipt.lines.count(), 3)
        grandchild.refresh_from_db()
        self.assertEqual(grandchild.raw_name, "Второй залог")

    def test_delete_parent_and_edit_discount_of_cascaded_child_is_rejected(self):
        child = self.child()
        discount = self.discount(line=child)
        response = self.post(
            initial=(2, 1, 0), lines=[line_row(id=self.line.pk, DELETE="on"), self.child_row(child)],
            discounts=[discount_row(id=discount.pk, line=child.pk, name="Изменённая скидка")],
        )
        self.assertRejected(response, "discounts", "line")
        self.assertEqual(self.receipt.lines.count(), 2)
        discount.refresh_from_db()
        self.assertEqual(discount.name, "Скидка")

    def test_detach_child_and_discounts_before_deleting_parent(self):
        child = self.child()
        child_discount = self.discount(line=child)
        parent_discount = ReceiptDiscount.objects.create(
            receipt=self.receipt, line=self.line, position=2, name="Скидка товара", amount="1.00",
        )
        response = self.post(
            initial=(2, 2, 0), lines=[
                line_row(id=self.line.pk, DELETE="on"), self.child_row(child, parent=""),
            ], discounts=[
                discount_row(id=child_discount.pk, line=child.pk, name="Скидка"),
                discount_row(id=parent_discount.pk, position=2, line="", name="Скидка товара"),
            ],
        )
        self.assertEqual(response.status_code, 302)
        self.assertFalse(ReceiptLine.objects.filter(pk=self.line.pk).exists())
        child.refresh_from_db()
        parent_discount.refresh_from_db()
        child_discount.refresh_from_db()
        self.assertIsNone(child.parent_id)
        self.assertIsNone(parent_discount.line_id)
        self.assertEqual(child_discount.line_id, child.pk)

    def test_delete_line_child_and_discount_together(self):
        child = self.child()
        discount = self.discount(line=self.line)
        response = self.post(
            initial=(2, 1, 0), lines=[
                line_row(id=self.line.pk, DELETE="on"), self.child_row(child, DELETE="on"),
            ], discounts=[discount_row(id=discount.pk, line=self.line.pk, DELETE="on")],
        )
        self.assertEqual(response.status_code, 302)
        self.assertFalse(self.receipt.lines.exists())
        self.assertFalse(self.receipt.discounts.exists())

    def test_delete_line_cascades_unchanged_dependents(self):
        child = self.child()
        discount = self.discount(line=self.line)
        response = self.post(
            initial=(2, 1, 0), lines=[line_row(id=self.line.pk, DELETE="on"), self.child_row(child)],
            discounts=[discount_row(id=discount.pk, line=self.line.pk, name="Скидка")],
        )
        self.assertEqual(response.status_code, 302)
        self.assertFalse(self.receipt.lines.exists())
        self.assertFalse(self.receipt.discounts.exists())

    def test_delete_discount_and_tax_without_changing_lines(self):
        discount = self.discount()
        tax = ReceiptTax.objects.create(
            receipt=self.receipt, tax_rate=self.tax_rate, tax_code="A", net="8.41", tax="0.59", gross="9.00",
        )
        response = self.post(
            initial=(1, 1, 1), lines=[line_row(id=self.line.pk)],
            discounts=[discount_row(id=discount.pk, DELETE="on")],
            taxes=[tax_row(id=tax.pk, tax_rate=self.tax_rate.pk, DELETE="on")],
        )
        self.assertEqual(response.status_code, 302)
        self.assertTrue(ReceiptLine.objects.filter(pk=self.line.pk).exists())
        self.assertFalse(self.receipt.discounts.exists())
        self.assertFalse(self.receipt.taxes.exists())

    def stale_delete(self, model, form_class, prefix, obj, row, concurrent_change):
        reached, release = threading.Event(), threading.Event()
        state = threading.local()
        original_clean = form_class.clean
        pids = []

        def paused_clean(form):
            if getattr(state, "deleting", False) and isinstance(form.instance, model) and form.instance.pk == obj.pk:
                reached.set()
                if not release.wait(10):
                    raise AssertionError("Устаревший DELETE не получил разрешение продолжиться")
            return original_clean(form)

        def delete_source():
            state.deleting = True
            try:
                client = Client()
                client.force_login(self.user)
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_backend_pid()")
                    pids.append(cursor.fetchone()[0])
                counts = tuple(int(name == prefix) for name in INLINE_PREFIXES)
                data = self.receipt_data(receipt_number="changed", initial=counts, **{prefix: [row]})
                return client.post(admin_url(Receipt, "change", self.receipt.pk), data)
            finally:
                connections.close_all()

        with patch.object(form_class, "clean", paused_clean), ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(delete_source)
            try:
                self.assertTrue(reached.wait(5), "DELETE не прочитал initial inline")
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_backend_pid()")
                    self.assertNotEqual(pids[0], cursor.fetchone()[0])
                    cursor.execute("SHOW statement_timeout")
                    self.assertEqual(cursor.fetchone()[0], "2s")
                concurrent_change()
            finally:
                release.set()
            response = pending.result(timeout=10)
        self.assertRejected(response, prefix)
        # Повтор того же устаревшего POST уже после commit также не должен
        # удалять запись по скрытому id, даже если её нет в queryset чека A.
        counts = tuple(int(name == prefix) for name in INLINE_PREFIXES)
        self.assertRejected(self.post(receipt_number="changed", initial=counts, **{prefix: [row]}), prefix)

    def moved_line_delete(self, with_dependents):
        saved_ids = {}

        def move_and_create():
            response = self.client.post(
                admin_url(ReceiptLine, "change", self.line.pk), line_row(receipt=self.target.pk),
            )
            self.assertEqual(response.status_code, 302)
            if with_dependents:
                data = self.receipt_data(
                    receipt_number="200", initial=(1, 0, 0), lines=[
                        line_row(id=self.line.pk, receipt=self.target.pk),
                        line_row(position=2, kind="deposit", parent=self.line.pk, raw_name="Залог B"),
                    ], discounts=[discount_row(line=self.line.pk)],
                )
                response = self.client.post(admin_url(Receipt, "change", self.target.pk), data)
                self.assertEqual(response.status_code, 302)
                saved_ids["child"] = self.target.lines.get(position=2).pk
                saved_ids["discount"] = self.target.discounts.get().pk

        self.stale_delete(
            ReceiptLine, ReceiptLineAdminForm, "lines", self.line,
            line_row(id=self.line.pk, DELETE="on"), move_and_create,
        )
        self.line.refresh_from_db()
        self.assertEqual(self.line.receipt_id, self.target.pk)
        if with_dependents:
            child = ReceiptLine.objects.get(pk=saved_ids["child"])
            discount = ReceiptDiscount.objects.get(pk=saved_ids["discount"])
            self.assertEqual((child.receipt_id, discount.receipt_id), (self.target.pk,) * 2)
            self.assertEqual((child.parent_id, discount.line_id), (self.line.pk,) * 2)

    def test_stale_delete_moved_line_with_new_target_dependents(self):
        self.moved_line_delete(with_dependents=True)

    def test_stale_delete_moved_line_without_dependents(self):
        self.moved_line_delete(with_dependents=False)

    def test_stale_delete_moved_discount(self):
        discount = self.discount()
        self.stale_delete(
            ReceiptDiscount, ReceiptDiscountAdminForm, "discounts", discount,
            discount_row(id=discount.pk, DELETE="on"),
            lambda: ReceiptDiscount.objects.filter(pk=discount.pk).update(receipt=self.target),
        )
        discount.refresh_from_db()
        self.assertEqual(discount.receipt_id, self.target.pk)

    def test_stale_delete_moved_tax(self):
        from django.forms import ModelForm

        tax = ReceiptTax.objects.create(
            receipt=self.receipt, tax_rate=self.tax_rate, tax_code="A", net="8.41", tax="0.59", gross="9.00",
        )
        self.stale_delete(
            ReceiptTax, ModelForm, "taxes", tax,
            tax_row(id=tax.pk, tax_rate=self.tax_rate.pk, DELETE="on"),
            lambda: ReceiptTax.objects.filter(pk=tax.pk).update(receipt=self.target),
        )
        tax.refresh_from_db()
        self.assertEqual(tax.receipt_id, self.target.pk)

    def test_stale_delete_already_deleted_line(self):
        self.stale_delete(
            ReceiptLine, ReceiptLineAdminForm, "lines", self.line,
            line_row(id=self.line.pk, DELETE="on"),
            lambda: ReceiptLine.objects.filter(pk=self.line.pk).delete(),
        )
        self.assertFalse(ReceiptLine.objects.filter(pk=self.line.pk).exists())

    def busy_object(self, obj, fields, prefix):
        locked, release = threading.Event(), threading.Event()

        def hold_lock():
            try:
                with transaction.atomic():
                    type(obj).objects.select_for_update().get(pk=obj.pk)
                    with connection.cursor() as cursor:
                        cursor.execute("SHOW statement_timeout")
                        self.assertEqual(cursor.fetchone()[0], "2s")
                    locked.set()
                    if not release.wait(10):
                        raise AssertionError("Блокировка строки не освобождена")
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=1) as pool:
            pending = pool.submit(hold_lock)
            try:
                self.assertTrue(locked.wait(5))
                response = self.post(receipt_number="changed", **fields)
            finally:
                release.set()
            pending.result(timeout=10)
        self.assertEqual(response.status_code, 200)
        formset = self.formset(response, prefix)
        self.assertTrue(formset.non_form_errors() or any(formset.errors))
        codes = [error.code for error in formset.non_form_errors().as_data()]
        for form in formset.forms:
            codes.extend(error.code for errors in form.errors.as_data().values() for error in errors)
        self.assertIn("receipt_inline_busy", codes)
        self.receipt.refresh_from_db()
        self.assertEqual(self.receipt.receipt_number, "100")
        self.assertTrue(ReceiptLine.objects.filter(pk=self.line.pk).exists())

    def test_delete_busy_line_returns_conflict_instead_of_timeout_500(self):
        self.busy_object(self.line, {"initial": (1, 0, 0), "lines": [line_row(id=self.line.pk, DELETE="on")]}, "lines")

    def test_create_discount_on_busy_line_returns_error_instead_of_timeout_500(self):
        self.busy_object(self.line, {"discounts": [discount_row(line=self.line.pk)]}, "discounts")
        self.assertFalse(self.receipt.discounts.exists())

    def test_create_child_of_busy_line_returns_error_instead_of_timeout_500(self):
        self.busy_object(self.line, {
            "lines": [line_row(position=2, kind="deposit", parent=self.line.pk, raw_name="Залог")],
        }, "lines")
        self.assertEqual(self.receipt.lines.count(), 1)

    def test_delete_busy_discount_is_rejected_without_waiting_for_timeout(self):
        discount = self.discount()
        self.busy_object(discount, {
            "initial": (0, 1, 0), "discounts": [discount_row(id=discount.pk, DELETE="on")],
        }, "discounts")
        self.assertTrue(ReceiptDiscount.objects.filter(pk=discount.pk, receipt=self.receipt).exists())

    def test_delete_busy_tax_is_rejected_without_waiting_for_timeout(self):
        tax = ReceiptTax.objects.create(
            receipt=self.receipt, tax_rate=self.tax_rate, tax_code="A", net="8.41", tax="0.59", gross="9.00",
        )
        self.busy_object(tax, {
            "initial": (0, 0, 1), "taxes": [tax_row(id=tax.pk, tax_rate=self.tax_rate.pk, DELETE="on")],
        }, "taxes")
        self.assertTrue(ReceiptTax.objects.filter(pk=tax.pk, receipt=self.receipt).exists())


@tag("integration")
class ReceiptInlineUniqueTests(TransactionTestCase):
    """F6: временные дубли и гонки unique, без внешнего atomic TestCase."""

    setUp = ReceiptInlineTransactionTests.setUp
    receipt_data = ReceiptsAdminTestCase.receipt_data
    formset = ReceiptsAdminTestCase.formset
    post = ReceiptInlineTransactionTests.post
    child = ReceiptInlineTransactionTests.child
    child_row = ReceiptInlineTransactionTests.child_row
    discount = ReceiptInlineTransactionTests.discount

    def snapshot(self):
        from django.contrib.admin.models import LogEntry

        return tuple(list(model.objects.order_by("pk").values()) for model in (
            Receipt, ReceiptLine, ReceiptDiscount, ReceiptTax, LogEntry,
        ))

    def assertUniqueRejected(self, response, prefix, before):
        self.assertEqual(response.status_code, 200)
        formset = self.formset(response, prefix)
        codes = [error.code for error in formset.non_form_errors().as_data()]
        for form in formset.forms:
            codes.extend(error.code for errors in form.errors.as_data().values() for error in errors)
        self.assertIn("receipt_inline_unique", codes)
        self.assertEqual(self.snapshot(), before, "Весь POST, включая журнал, должен остаться без записей")

    def reject(self, prefix, **fields):
        before = self.snapshot()
        for _ in range(2):
            self.assertUniqueRejected(self.post(receipt_number="changed", **fields), prefix, before)

    def test_delete_and_update_line_to_deleted_position(self):
        other = make_line(self.receipt, position=2)
        self.reject("lines", initial=(2, 0, 0), lines=[
            line_row(id=self.line.pk, DELETE="on"), line_row(id=other.pk, position=1),
        ], discounts=[discount_row()], taxes=[tax_row(tax_rate=self.tax_rate.pk)])

    def test_detach_child_and_reuse_deleted_parent_position(self):
        child = self.child()
        self.discount(line=child)
        self.reject("lines", initial=(2, 0, 0), lines=[
            line_row(id=self.line.pk, DELETE="on"), self.child_row(child, parent="", position=1),
        ])

    def test_swap_line_positions(self):
        other = make_line(self.receipt, position=2)
        self.reject("lines", initial=(2, 0, 0), lines=[
            line_row(id=self.line.pk, position=2), line_row(id=other.pk, position=1),
        ])

    def test_update_line_to_position_of_omitted_initial_row(self):
        make_line(self.receipt, position=2)
        self.reject("lines", initial=(1, 0, 0), lines=[line_row(id=self.line.pk, position=2)])

    def test_new_line_cannot_reuse_deleted_or_cascaded_position(self):
        child = self.child()
        for position in (self.line.position, child.position):
            with self.subTest(position=position):
                self.reject("lines", initial=(2, 0, 0), lines=[
                    line_row(id=self.line.pk, DELETE="on"), self.child_row(child),
                    line_row(position=position),
                ])

    def test_duplicate_new_lines_are_formset_errors(self):
        before = self.snapshot()
        response = self.post(lines=[line_row(position=3), line_row(position=3)])
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.formset(response, "lines").non_form_errors())
        self.assertEqual(self.snapshot(), before)

    def test_duplicate_final_updates_are_formset_errors(self):
        other = make_line(self.receipt, position=2)
        before = self.snapshot()
        response = self.post(initial=(2, 0, 0), lines=[
            line_row(id=self.line.pk, position=3), line_row(id=other.pk, position=3),
        ])
        self.assertEqual(response.status_code, 200)
        self.assertTrue(self.formset(response, "lines").non_form_errors())
        self.assertEqual(self.snapshot(), before)

    def test_discount_delete_update_swap_and_new_replacement(self):
        first = self.discount()
        second = ReceiptDiscount.objects.create(receipt=self.receipt, position=2, name="Другая", amount="1.00")
        for rows in (
            [discount_row(id=first.pk, DELETE="on"), discount_row(id=second.pk, position=1)],
            [discount_row(id=first.pk, position=2), discount_row(id=second.pk, position=1)],
            [discount_row(id=first.pk, DELETE="on"), discount_row(id=second.pk, position=2), discount_row()],
        ):
            with self.subTest(rows=rows):
                self.reject("discounts", initial=(0, 2, 0), discounts=rows)

    def test_tax_delete_update_swap_and_new_replacement(self):
        rate = TaxRate.objects.create(country_id="XA", kind="vat", rate="19.00", name="Другая ставка")
        first = ReceiptTax.objects.create(receipt=self.receipt, tax_rate=self.tax_rate, net=1, tax=0, gross=1)
        second = ReceiptTax.objects.create(receipt=self.receipt, tax_rate=rate, net=1, tax=0, gross=1)
        for rows in (
            [tax_row(id=first.pk, tax_rate=self.tax_rate.pk, DELETE="on"),
             tax_row(id=second.pk, tax_rate=self.tax_rate.pk)],
            [tax_row(id=first.pk, tax_rate=rate.pk), tax_row(id=second.pk, tax_rate=self.tax_rate.pk)],
            [tax_row(id=first.pk, tax_rate=self.tax_rate.pk, DELETE="on"),
             tax_row(id=second.pk, tax_rate=rate.pk), tax_row(tax_rate=self.tax_rate.pk)],
        ):
            with self.subTest(rows=rows):
                self.reject("taxes", initial=(0, 0, 2), taxes=rows)

    def test_duplicate_new_discounts_and_taxes_are_formset_errors(self):
        for prefix, rows in (
            ("discounts", [discount_row(), discount_row()]),
            ("taxes", [tax_row(tax_rate=self.tax_rate.pk), tax_row(tax_rate=self.tax_rate.pk)]),
        ):
            with self.subTest(prefix=prefix):
                before = self.snapshot()
                response = self.post(**{prefix: rows})
                self.assertEqual(response.status_code, 200)
                self.assertTrue(self.formset(response, prefix).non_form_errors())
                self.assertEqual(self.snapshot(), before)

    def test_swap_through_free_position_in_separate_posts(self):
        other = make_line(self.receipt, position=2)
        for first, second in ((3, 2), (3, 1), (2, 1)):
            response = self.post(initial=(2, 0, 0), lines=[
                line_row(id=self.line.pk, position=first), line_row(id=other.pk, position=second),
            ])
            self.assertEqual(response.status_code, 302)
        self.line.refresh_from_db()
        other.refresh_from_db()
        self.assertEqual((self.line.position, other.position), (2, 1))

    def test_delete_then_reuse_position_in_separate_posts(self):
        other = make_line(self.receipt, position=2)
        self.assertEqual(self.post(initial=(2, 0, 0), lines=[
            line_row(id=self.line.pk, DELETE="on"), line_row(id=other.pk, position=2),
        ]).status_code, 302)
        self.assertEqual(self.post(initial=(1, 0, 0), lines=[line_row(id=other.pk, position=1)]).status_code, 302)
        other.refresh_from_db()
        self.assertEqual(other.position, 1)

    def test_multiple_updates_to_free_positions_still_save(self):
        other = make_line(self.receipt, position=2)
        self.assertEqual(self.post(initial=(2, 0, 0), lines=[
            line_row(id=self.line.pk, position=4), line_row(id=other.pk, position=3),
        ]).status_code, 302)
        self.assertEqual(list(self.receipt.lines.order_by("position").values_list("position", flat=True)), [3, 4])

    def test_unrelated_integrity_error_is_not_hidden_as_unique_conflict(self):
        before = self.snapshot()
        original_save = ReceiptInlineFormSet.save_existing

        def invalid_save(formset, form, obj, commit=True):
            if formset.model is ReceiptLine:
                obj.quantity = 0  # Настоящий check violation после успешного clean.
                obj.save()
            return original_save(formset, form, obj, commit=commit)

        with patch.object(ReceiptInlineFormSet, "save_existing", invalid_save):
            with self.assertRaises(IntegrityError) as caught:
                self.post(receipt_number="changed", initial=(1, 0, 0), lines=[line_row(id=self.line.pk)])
        self.assertEqual(caught.exception.__cause__.sqlstate, "23514")
        self.assertEqual(self.snapshot(), before)

    def concurrent_unique(self, model, *, update=False, hold=False):
        prefix = {ReceiptLine: "lines", ReceiptDiscount: "discounts", ReceiptTax: "taxes"}[model]
        reached, release, inserted, finish = (threading.Event() for _ in range(4))
        original_save = ReceiptInlineFormSet.save
        pids = []
        created = []
        values = {"receipt": self.receipt}
        fields = {"receipt_number": "changed"}
        if model is ReceiptLine:
            values.update(position=3, raw_name="Конкурентная строка")
            fields.update(discounts=[discount_row()], taxes=[tax_row(tax_rate=self.tax_rate.pk)])
            fields["lines"] = [line_row(id=self.line.pk if update else "", position=3)]
        elif model is ReceiptDiscount:
            values.update(position=3, name="Конкурентная скидка", amount="1.00")
            obj = self.discount() if update else None
            fields["discounts"] = [discount_row(id=obj.pk if obj else "", position=3)]
        else:
            values.update(tax_rate=self.tax_rate, net=1, tax=0, gross=1)
            fields["discounts"] = [discount_row()]
            obj = None
            if update:
                rate = TaxRate.objects.create(country_id="XA", kind="vat", rate="19.00", name="Другая ставка")
                obj = ReceiptTax.objects.create(receipt=self.receipt, tax_rate=rate, net=1, tax=0, gross=1)
            fields["taxes"] = [tax_row(id=obj.pk if obj else "", tax_rate=self.tax_rate.pk)]
        fields["initial"] = tuple(int(update and name == prefix) for name in INLINE_PREFIXES)

        def paused_save(formset, commit=True):
            if formset.model is model:
                reached.set()
                if not release.wait(10):
                    raise AssertionError("Save не освобождён")
            return original_save(formset, commit=commit)

        def post():
            try:
                client = Client()
                client.force_login(self.user)
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_backend_pid()")
                    pids.append(cursor.fetchone()[0])
                    cursor.execute("SHOW statement_timeout")
                    self.assertEqual(cursor.fetchone()[0], "2s")
                return client.post(admin_url(Receipt, "change", self.receipt.pk), self.receipt_data(**fields))
            finally:
                connections.close_all()

        def insert():
            try:
                with transaction.atomic():
                    if model is ReceiptLine:
                        obj = make_line(**values)
                    else:
                        obj = model.objects.create(**values)
                    created.append(obj.pk)
                    inserted.set()
                    if hold and not finish.wait(10):
                        raise AssertionError("Конкурентная транзакция не освобождена")
            finally:
                connections.close_all()

        with patch.object(ReceiptInlineFormSet, "save", paused_save), ThreadPoolExecutor(max_workers=2) as pool:
            pending = pool.submit(post)
            try:
                self.assertTrue(reached.wait(5))
                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_backend_pid()")
                    self.assertNotEqual(pids[0], cursor.fetchone()[0])
                competing = pool.submit(insert)
                self.assertTrue(inserted.wait(5))
                if not hold:
                    competing.result(timeout=5)  # Настоящий commit между clean и save.
                before = self.snapshot()
                release.set()
                response = pending.result(timeout=8)
                if hold:
                    self.assertEqual(response.status_code, 200)
                    errors = self.formset(response, prefix).non_form_errors().as_data()
                    self.assertEqual(errors[0].code, "receipt_inline_busy")
                    self.assertEqual(self.snapshot(), before)
                else:
                    self.assertUniqueRejected(response, prefix, before)
            finally:
                release.set()
                finish.set()
            competing.result(timeout=5)
        self.assertTrue(model.objects.filter(pk=created[0], receipt=self.receipt).exists())

    def test_concurrent_insert_line_after_clean(self):
        self.concurrent_unique(ReceiptLine)

    def test_concurrent_update_line_after_clean(self):
        self.concurrent_unique(ReceiptLine, update=True)

    def test_concurrent_insert_discount_after_clean(self):
        self.concurrent_unique(ReceiptDiscount)

    def test_concurrent_update_discount_after_clean(self):
        self.concurrent_unique(ReceiptDiscount, update=True)

    def test_concurrent_insert_tax_after_clean(self):
        self.concurrent_unique(ReceiptTax)

    def test_concurrent_update_tax_after_clean(self):
        self.concurrent_unique(ReceiptTax, update=True)

    def test_uncommitted_unique_conflict_times_out_as_form_error(self):
        for model in (ReceiptLine, ReceiptDiscount, ReceiptTax):
            with self.subTest(model=model.__name__):
                self.concurrent_unique(model, hold=True)
                model.objects.filter(receipt=self.receipt).delete()
                # Следующий subtest снова начинает с одной строкой.
                if model is ReceiptLine:
                    self.line = make_line(self.receipt)


@tag("integration")
class ProductAliasAdminTests(ReceiptsAdminTestCase):
    def test_add_fills_name_key(self):
        raw_name = "  Молоко   2,5%  ЖИРН  1Л"
        response = self.client.post(admin_url(ProductAlias, "add"), self.alias_data(raw_name=raw_name))
        self.assertSaved(response, ProductAlias)
        alias = ProductAlias.objects.get(name_key="молоко 2,5% жирн 1л")
        self.assertEqual(alias.name_key, name_key(alias.raw_name))
        self.assertEqual(alias.name_key, name_key(raw_name))

    def test_name_key_is_readonly_and_ignored_in_post(self):
        for name, args in (("add", ()), ("change", (self.alias.pk,))):
            with self.subTest(page=name):
                page = self.client.get(admin_url(ProductAlias, name, *args))
                self.assertNotIn("name_key", page.context["adminform"].form.fields)
        response = self.client.post(
            admin_url(ProductAlias, "add"), self.alias_data(name_key="подставной ключ"),
        )
        self.assertSaved(response, ProductAlias)
        self.assertEqual(ProductAlias.objects.get(raw_name="Новое название").name_key, "новое название")

    def test_change_of_raw_name_updates_name_key(self):
        response = self.client.post(
            admin_url(ProductAlias, "change", self.alias.pk),
            self.alias_data(raw_name="Товар ПЕРЕИМЕНОВАННЫЙ", store_item_code="SKU-1"),
        )
        self.assertSaved(response, ProductAlias)
        self.alias.refresh_from_db()
        self.assertEqual(self.alias.name_key, "товар переименованный")
        self.assertEqual(self.alias.name_key, name_key(self.alias.raw_name))

    def test_change_without_renaming_is_not_its_own_duplicate(self):
        response = self.client.post(
            admin_url(ProductAlias, "change", self.alias.pk),
            self.alias_data(raw_name="Тестовый товар", store_item_code="SKU-1"),
        )
        self.assertSaved(response, ProductAlias)
        self.alias.refresh_from_db()
        self.assertEqual(self.alias.name_key, "тестовый товар")

    def test_duplicate_is_form_error(self):
        # Регистр и пробелы дают тот же ключ.
        for raw_name in ("Тестовый товар", "  ТЕСТОВЫЙ   товар "):
            with self.subTest(raw_name=raw_name):
                response = self.client.post(
                    admin_url(ProductAlias, "add"), self.alias_data(raw_name=raw_name, store_item_code="SKU-1"),
                )
                self.assertFormError(response, "raw_name", "уже есть сопоставление")
                self.assertEqual(ProductAlias.objects.count(), 1)

    def test_change_to_existing_name_is_form_error(self):
        other = ProductAlias.objects.create(
            merchant=self.merchant, product=self.product, raw_name="Другое название",
            name_key=name_key("Другое название"), store_item_code="SKU-1",
        )
        response = self.client.post(
            admin_url(ProductAlias, "change", other.pk),
            self.alias_data(raw_name="тестовый ТОВАР", store_item_code="SKU-1"),
        )
        self.assertFormError(response, "raw_name", "уже есть сопоставление")
        other.refresh_from_db()
        self.assertEqual((other.raw_name, other.name_key), ("Другое название", "другое название"))

    def test_same_name_with_other_code_or_merchant_is_allowed(self):
        other_merchant = Merchant.objects.create(country=self.country, legal_name="ООО «Другой продавец»")
        cases = (
            {"store_item_code": "SKU-2"}, {"store_item_code": ""},
            {"merchant": other_merchant.pk, "store_item_code": "SKU-1"},
        )
        for case in cases:
            with self.subTest(**case):
                response = self.client.post(
                    admin_url(ProductAlias, "add"), self.alias_data(raw_name="Тестовый товар", **case),
                )
                self.assertSaved(response, ProductAlias)
        self.assertEqual(ProductAlias.objects.filter(name_key="тестовый товар").count(), 4)

    def test_missing_required_fields_are_form_errors(self):
        response = self.client.post(
            admin_url(ProductAlias, "add"), self.alias_data(merchant="", product="", raw_name="   "),
        )
        for field in ("merchant", "product", "raw_name"):
            self.assertFormError(response, field)
        self.assertEqual(ProductAlias.objects.count(), 1)


@tag("integration")
class ValidationWarningsTests(ReceiptsAdminTestCase):
    def warnings(self, response):
        return admin.site.get_model_admin(Receipt).validation_warnings(response.context["original"])

    def test_block_is_on_change_page(self):
        response = self.client.get(admin_url(Receipt, "change", self.receipt.pk))
        self.assertContains(response, "Предупреждения проверки")
        self.assertContains(response, "Нарушений не найдено.")

    def test_block_lists_validate_receipt_problems(self):
        Receipt.objects.filter(pk=self.receipt.pk).update(total=Decimal("12.00"))
        response = self.client.get(admin_url(Receipt, "change", self.receipt.pk))
        self.assertNotContains(response, "Нарушений не найдено.")
        self.assertContains(response, "<li>total: сумма строк за вычетом скидок 10.00 не равна итогу чека 12.00.</li>")

    def test_block_escapes_stored_text(self):
        Store.objects.filter(pk=self.store.pk).update(timezone="<b>Нет/Такого</b>")
        response = self.client.get(admin_url(Receipt, "change", self.receipt.pk))
        self.assertContains(response, "неизвестный часовой пояс «&lt;b&gt;Нет/Такого&lt;/b&gt;»")
        self.assertNotContains(response, "<b>Нет/Такого</b>")

    def test_add_page_has_placeholder(self):
        response = self.client.get(admin_url(Receipt, "add"))
        self.assertContains(response, "Появятся после сохранения чека.")

    def test_warnings_do_not_block_saving(self):
        # Локальная дата и итог не сходятся со строками — это предупреждения.
        response = self.client.post(admin_url(Receipt, "add"), self.receipt_data(
            receipt_number="800", purchased_on="2026-03-20", total="99.00", lines=[line_row()],
        ))
        self.assertSaved(response, Receipt)
        receipt = Receipt.objects.get(receipt_number="800")
        page = self.client.get(admin_url(Receipt, "change", receipt.pk))
        self.assertContains(page, "purchased_on: 2026-03-20 не совпадает с датой purchased_at")
        self.assertContains(page, "не равна итогу чека 99.00")


@tag("integration")
class AutocompleteTests(ReceiptsAdminTestCase):
    def url(self, model_name, field_name, term=""):
        return f"/admin/autocomplete/?app_label=receipts&model_name={model_name}&field_name={field_name}&term={term}"

    def test_autocomplete_fields_are_declared(self):
        self.assertEqual(admin.site.get_model_admin(Receipt).autocomplete_fields, ("store",))
        self.assertEqual(
            admin.site.get_model_admin(ReceiptLine).autocomplete_fields, ("receipt", "product", "tax_rate"),
        )
        self.assertEqual(admin.site.get_model_admin(ReceiptLine).raw_id_fields, ("parent",))
        self.assertEqual(admin.site.get_model_admin(ProductAlias).autocomplete_fields, ("merchant", "product"))
        inlines = {inline.model: inline for inline in admin.site.get_model_admin(Receipt).inlines}
        self.assertEqual(inlines[ReceiptLine].autocomplete_fields, ("product", "tax_rate"))
        self.assertEqual(inlines[ReceiptTax].autocomplete_fields, ("tax_rate",))

    def test_each_field_responds(self):
        for model_name, field_name in AUTOCOMPLETE_FIELDS:
            with self.subTest(model=model_name, field=field_name):
                response = self.client.get(self.url(model_name, field_name))
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.json()["results"])

    def test_search_term_finds_object(self):
        cases = (
            ("receipt", "store", "Тестмарт", self.store),
            ("receiptline", "receipt", "test:fiscal", self.receipt),
            ("receiptline", "product", "Тестовый", self.product),
            ("receiptline", "tax_rate", "НДС 7", self.tax_rate),
            ("receipttax", "tax_rate", "НДС 7", self.tax_rate),
            ("productalias", "merchant", "Тестовый", self.merchant),
            ("productalias", "product", "Тестовый", self.product),
        )
        for model_name, field_name, term, expected in cases:
            with self.subTest(model=model_name, field=field_name):
                results = self.client.get(self.url(model_name, field_name, term)).json()["results"]
                self.assertEqual(results, [{"id": str(expected.pk), "text": str(expected)}])
                self.assertEqual(
                    self.client.get(self.url(model_name, field_name, "нет-такого")).json()["results"], [],
                )

    def test_autocomplete_requires_staff(self):
        url = self.url("receipt", "store")
        self.client.logout()
        self.assertEqual(self.client.get(url).status_code, 302)
        self.client.force_login(self.staff_user)
        self.assertEqual(self.client.get(url).status_code, 403)


@tag("integration")
class TaxRateCountryTests(ReceiptsAdminTestCase):
    def test_tax_rate_of_other_country_is_a_warning_not_an_error(self):
        foreign = TaxRate.objects.create(
            country=Country.objects.get(code="DE"), kind="vat", rate=Decimal("3.00"), name="Тестовая ставка 3%",
        )
        response = self.client.post(admin_url(Receipt, "add"), self.receipt_data(
            receipt_number="900", lines=[line_row(tax_rate=foreign.pk)],
        ))
        self.assertSaved(response, Receipt)
        receipt = Receipt.objects.get(receipt_number="900")
        page = self.client.get(admin_url(Receipt, "change", receipt.pk))
        self.assertContains(page, "line.tax_rate: строка 1: ставка страны DE, магазин в XA.")
