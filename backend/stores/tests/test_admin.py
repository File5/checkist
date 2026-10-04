from decimal import Decimal

from django.contrib import admin
from django.contrib.auth import get_user_model
from django.db import connection
from django.test import Client, TestCase, tag
from django.test.utils import CaptureQueriesContext
from django.urls import reverse

from stores.models import Country, Currency, Merchant, Store, TaxRate
from stores.normalize import address_key

# Все названия, адреса и налоговые номера вымышленные.

MODELS = (Country, Currency, TaxRate, Merchant, Store)
ADDRESS = "г. Тестоград, ул. Примерная, 1"


def admin_url(model, name, *args):
    return reverse(f"admin:stores_{model._meta.model_name}_{name}", args=args)


@tag("integration")
class StoresAdminTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        users = get_user_model().objects
        cls.superuser = users.create_superuser("root-user", password="test-only-password")
        cls.plain_user = users.create_user("plain-user", password="test-only-password")
        cls.staff_user = users.create_user("staff-user", password="test-only-password", is_staff=True)
        cls.country = Country.objects.create(code="XA", name="Тестовая страна")
        cls.other_country = Country.objects.create(code="XB", name="Другая тестовая страна")
        cls.currency = Currency.objects.create(code="XTS", name="Тестовая валюта")
        cls.tax_rate = TaxRate.objects.create(
            country=cls.country, kind="vat", rate=Decimal("12.00"), name="НДС 12%",
        )
        cls.merchant = Merchant.objects.create(
            country=cls.country, legal_name="ТОО «Тестовый продавец»", brand_name="Тестмарт",
            tax_id_type="bin", tax_id="000000000001",
        )
        cls.other_merchant = Merchant.objects.create(
            country=cls.other_country, legal_name="ООО «Другой продавец»",
        )
        cls.store = Store.objects.create(
            merchant=cls.merchant, country=cls.country, name="Тестмарт на Примерной",
            branch_code="001", address_raw=ADDRESS, city="Тестоград", timezone="Asia/Almaty",
        )
        cls.objects = {
            Country: cls.country, Currency: cls.currency, TaxRate: cls.tax_rate,
            Merchant: cls.merchant, Store: cls.store,
        }

    def setUp(self):
        self.client = Client()
        self.client.force_login(self.superuser)

    def tax_rate_data(self, **fields):
        return {"country": "XA", "kind": "vat", "rate": "5.00", "name": "НДС 5%", **fields}

    def merchant_data(self, **fields):
        return {
            "country": "XA", "legal_name": "ТОО «Новый продавец»", "brand_name": "",
            "tax_id_type": "", "tax_id": "", "extra": "{}", **fields,
        }

    def store_data(self, **fields):
        return {
            "merchant": self.merchant.pk, "country": "XA", "name": "", "branch_code": "",
            "address_raw": "г. Тестоград, пр. Образцовый, 7", "address_i18n": "{}",
            "postal_code": "", "region": "", "city": "", "street": "", "house": "",
            "timezone": "Asia/Almaty", **fields,
        }

    def assertSaved(self, response, model):
        self.assertRedirects(response, admin_url(model, "changelist"), fetch_redirect_response=False)

    def assertFormError(self, response, field, fragment=None):
        self.assertEqual(response.status_code, 200)
        errors = response.context["adminform"].form.errors
        self.assertIn(field, errors)
        if fragment is not None:
            self.assertIn(fragment, " ".join(errors[field]))


class RegistrationAndAccessTests(StoresAdminTestCase):
    def pages(self):
        for model in MODELS:
            yield admin_url(model, "changelist")
            yield admin_url(model, "add")
            yield admin_url(model, "change", self.objects[model].pk)

    def test_models_are_registered(self):
        for model in MODELS:
            with self.subTest(model=model.__name__):
                self.assertTrue(admin.site.is_registered(model))

    def test_anonymous_is_redirected_to_login(self):
        self.client.logout()
        for url in self.pages():
            with self.subTest(url=url):
                self.assertRedirects(
                    self.client.get(url), f"/admin/login/?next={url}", fetch_redirect_response=False,
                )

    def test_user_without_is_staff_is_redirected_to_login(self):
        self.client.force_login(self.plain_user)
        for url in self.pages():
            with self.subTest(url=url):
                self.assertRedirects(
                    self.client.get(url), f"/admin/login/?next={url}", fetch_redirect_response=False,
                )

    def test_staff_without_model_permissions_is_forbidden(self):
        self.client.force_login(self.staff_user)
        for url in self.pages():
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 403)

    def test_anonymous_post_does_not_create_object(self):
        self.client.logout()
        response = self.client.post(admin_url(Country, "add"), {"code": "XC", "name": "Третья страна"})
        self.assertEqual(response.status_code, 302)
        self.assertFalse(Country.objects.filter(code="XC").exists())

    def test_superuser_gets_changelist_add_and_change(self):
        for url in self.pages():
            with self.subTest(url=url):
                self.assertEqual(self.client.get(url).status_code, 200)


class ChangelistTests(StoresAdminTestCase):
    def test_search_and_filters(self):
        queries = {
            Country: ["q=XA", "q=Тестовая"],
            Currency: ["q=XTS", "q=Тестовая"],
            TaxRate: ["q=НДС", "q=XA", "country__code__exact=XA", "kind__exact=vat"],
            Merchant: [
                "q=Тестовый", "q=Тестмарт", "q=000000000001",
                "country__code__exact=XA", "tax_id_type__exact=bin",
            ],
            Store: [
                "q=Примерной", "q=Примерная", "q=Тестоград", "q=001", "q=Тестовый", "q=Тестмарт",
                "country__code__exact=XA",
            ],
        }
        for model, items in queries.items():
            for query in items:
                with self.subTest(model=model.__name__, query=query):
                    response = self.client.get(f"{admin_url(model, 'changelist')}?{query}")
                    self.assertEqual(response.status_code, 200)
                    changelist = response.context["cl"]
                    self.assertEqual(changelist.get_filters_params(), self.expected_params(query))
                    self.assertIn(self.objects[model], changelist.result_list)

    @staticmethod
    def expected_params(query):
        # Неизвестный параметр админка отбрасывает редиректом на ?e=1, а не применяет.
        key, value = query.split("=")
        return {} if key == "q" else {key: [value]}

    def test_search_excludes_non_matching_rows(self):
        for model in MODELS:
            with self.subTest(model=model.__name__):
                response = self.client.get(f"{admin_url(model, 'changelist')}?q=нет-такой-строки")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(list(response.context["cl"].result_list), [])

    def test_filter_excludes_other_country(self):
        for model in (TaxRate, Merchant, Store):
            with self.subTest(model=model.__name__):
                response = self.client.get(f"{admin_url(model, 'changelist')}?country__code__exact=XB")
                self.assertEqual(response.status_code, 200)
                self.assertNotIn(self.objects[model], response.context["cl"].result_list)

    def add_rows(self, model):
        countries = [
            Country.objects.create(code=f"Y{letter}", name=f"Страна {letter}") for letter in "ABCDE"
        ]
        if model is Country:
            return
        if model is Currency:
            for letter in "ABCDE":
                Currency.objects.create(code=f"XY{letter}", name=f"Валюта {letter}")
            return
        for number, country in enumerate(countries):
            if model is TaxRate:
                TaxRate.objects.create(country=country, kind="vat", rate=Decimal(number), name=f"НДС {number}%")
                continue
            merchant = Merchant.objects.create(
                country=country, legal_name=f"ТОО «Продавец {number}»", tax_id=f"90000000000{number}",
            )
            if model is Store:
                Store.objects.create(
                    merchant=merchant, country=country, address_raw=f"г. Тестоград, ул. Примерная, {number + 10}",
                    timezone="Asia/Almaty",
                )

    def count_queries(self, model):
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get(admin_url(model, "changelist"))
        self.assertEqual(response.status_code, 200)
        return len(queries), response.context["cl"].result_count

    def assert_query_count_does_not_depend_on_rows(self, model):
        # Сид-строки и вторые объекты убираются в порядке, который допускает PROTECT.
        for cleared in (Store, Merchant, TaxRate, Country, Currency):
            cleared.objects.exclude(pk=self.objects[cleared].pk).delete()
        one_row_queries, one_row_count = self.count_queries(model)
        self.assertEqual(one_row_count, 1)
        self.add_rows(model)
        many_rows_queries, many_rows_count = self.count_queries(model)
        self.assertEqual(many_rows_count, 6)
        self.assertEqual(many_rows_queries, one_row_queries)

    def test_country_changelist_query_count(self):
        self.assert_query_count_does_not_depend_on_rows(Country)

    def test_currency_changelist_query_count(self):
        self.assert_query_count_does_not_depend_on_rows(Currency)

    def test_tax_rate_changelist_query_count(self):
        self.assert_query_count_does_not_depend_on_rows(TaxRate)

    def test_merchant_changelist_query_count(self):
        self.assert_query_count_does_not_depend_on_rows(Merchant)

    def test_store_changelist_query_count(self):
        self.assert_query_count_does_not_depend_on_rows(Store)

    def test_merchant_autocomplete_for_store(self):
        url = "/admin/autocomplete/?app_label=stores&model_name=store&field_name=merchant&term="
        response = self.client.get(url + "Тестмарт")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json()["results"], [{"id": str(self.merchant.pk), "text": "Тестмарт"}],
        )
        self.assertEqual(self.client.get(url + "нет-такого").json()["results"], [])

    def test_autocomplete_requires_staff(self):
        url = "/admin/autocomplete/?app_label=stores&model_name=store&field_name=merchant&term="
        self.client.logout()
        self.assertEqual(self.client.get(url).status_code, 302)
        self.client.force_login(self.staff_user)
        self.assertEqual(self.client.get(url).status_code, 403)


class CodeReferenceAdminTests(StoresAdminTestCase):
    def test_add_saves_object(self):
        for model, code in ((Country, "XC"), (Currency, "XXA")):
            with self.subTest(model=model.__name__):
                response = self.client.post(admin_url(model, "add"), {"code": code, "name": "Новая запись"})
                self.assertSaved(response, model)
                self.assertEqual(model.objects.get(pk=code).name, "Новая запись")

    def test_change_saves_name(self):
        for model in (Country, Currency):
            with self.subTest(model=model.__name__):
                pk = self.objects[model].pk
                response = self.client.post(admin_url(model, "change", pk), {"name": "Новое название"})
                self.assertSaved(response, model)
                self.assertEqual(model.objects.get(pk=pk).name, "Новое название")

    def test_code_cannot_be_changed(self):
        for model, code in ((Country, "XC"), (Currency, "XXA")):
            with self.subTest(model=model.__name__):
                pk = self.objects[model].pk
                count = model.objects.count()
                page = self.client.get(admin_url(model, "change", pk))
                self.assertNotIn("code", page.context["adminform"].form.fields)
                response = self.client.post(
                    admin_url(model, "change", pk), {"code": code, "name": "Новое название"},
                )
                self.assertSaved(response, model)
                self.assertEqual(model.objects.count(), count)
                self.assertFalse(model.objects.filter(pk=code).exists())
                self.assertEqual(model.objects.get(pk=pk).name, "Новое название")

    def test_code_is_editable_on_add(self):
        for model in (Country, Currency):
            with self.subTest(model=model.__name__):
                page = self.client.get(admin_url(model, "add"))
                self.assertIn("code", page.context["adminform"].form.fields)

    def test_duplicate_code_is_form_error(self):
        for model in (Country, Currency):
            with self.subTest(model=model.__name__):
                pk = self.objects[model].pk
                name = self.objects[model].name
                response = self.client.post(admin_url(model, "add"), {"code": pk, "name": "Повтор"})
                self.assertFormError(response, "code")
                self.assertEqual(model.objects.get(pk=pk).name, name)

    def test_too_long_code_is_form_error(self):
        response = self.client.post(admin_url(Country, "add"), {"code": "XCC", "name": "Длинный код"})
        self.assertFormError(response, "code")
        self.assertFalse(Country.objects.filter(name="Длинный код").exists())


class TaxRateAdminTests(StoresAdminTestCase):
    def test_add_saves_object(self):
        response = self.client.post(admin_url(TaxRate, "add"), self.tax_rate_data())
        self.assertSaved(response, TaxRate)
        self.assertEqual(TaxRate.objects.get(country="XA", rate=Decimal("5.00")).name, "НДС 5%")

    def test_add_exempt_without_rate(self):
        response = self.client.post(
            admin_url(TaxRate, "add"), self.tax_rate_data(kind="exempt", rate="", name="Без НДС"),
        )
        self.assertSaved(response, TaxRate)
        self.assertIsNone(TaxRate.objects.get(country="XA", kind="exempt").rate)

    def test_change_saves_object(self):
        response = self.client.post(
            admin_url(TaxRate, "change", self.tax_rate.pk),
            self.tax_rate_data(rate="12.00", name="НДС 12% (основная)"),
        )
        self.assertSaved(response, TaxRate)
        self.tax_rate.refresh_from_db()
        self.assertEqual(self.tax_rate.name, "НДС 12% (основная)")

    def test_duplicate_vat_rate_is_form_error(self):
        response = self.client.post(
            admin_url(TaxRate, "add"), self.tax_rate_data(rate="12.00", name="НДС 12% (повтор)"),
        )
        self.assertFormError(response, "__all__")
        self.assertEqual(TaxRate.objects.filter(country="XA").count(), 1)

    def test_duplicate_exempt_is_form_error(self):
        TaxRate.objects.create(country=self.country, kind="exempt", rate=None, name="Без НДС")
        response = self.client.post(
            admin_url(TaxRate, "add"), self.tax_rate_data(kind="exempt", rate="", name="Без НДС (повтор)"),
        )
        self.assertFormError(response, "__all__")
        self.assertEqual(TaxRate.objects.filter(country="XA", kind="exempt").count(), 1)

    def test_kind_rate_check_is_form_error(self):
        cases = (
            {"kind": "exempt", "rate": "0.00"},
            {"kind": "exempt", "rate": "12.00"},
            {"kind": "vat", "rate": ""},
            {"kind": "vat", "rate": "-1.00"},
        )
        for case in cases:
            with self.subTest(**case):
                response = self.client.post(
                    admin_url(TaxRate, "add"), self.tax_rate_data(name="Нарушение check", **case),
                )
                self.assertFormError(response, "__all__")
                self.assertFalse(TaxRate.objects.filter(name="Нарушение check").exists())

    def test_unknown_kind_is_form_error(self):
        response = self.client.post(admin_url(TaxRate, "add"), self.tax_rate_data(kind="sales"))
        self.assertFormError(response, "kind")


class MerchantAdminTests(StoresAdminTestCase):
    def test_add_saves_object(self):
        response = self.client.post(
            admin_url(Merchant, "add"),
            self.merchant_data(tax_id_type="bin", tax_id="000000000002", extra='{"note": "тест"}'),
        )
        self.assertSaved(response, Merchant)
        merchant = Merchant.objects.get(tax_id="000000000002")
        self.assertEqual(merchant.legal_name, "ТОО «Новый продавец»")
        self.assertEqual(merchant.extra, {"note": "тест"})

    def test_change_saves_object(self):
        response = self.client.post(
            admin_url(Merchant, "change", self.merchant.pk),
            self.merchant_data(legal_name="ТОО «Переименованный»", tax_id_type="bin", tax_id="000000000001"),
        )
        self.assertSaved(response, Merchant)
        self.merchant.refresh_from_db()
        self.assertEqual(self.merchant.legal_name, "ТОО «Переименованный»")

    def test_duplicate_tax_id_is_form_error(self):
        response = self.client.post(
            admin_url(Merchant, "add"), self.merchant_data(tax_id_type="bin", tax_id="000000000001"),
        )
        self.assertFormError(response, "__all__")
        self.assertEqual(Merchant.objects.filter(tax_id="000000000001").count(), 1)

    def test_empty_tax_id_may_repeat(self):
        for name in ("ТОО «Без номера 1»", "ТОО «Без номера 2»"):
            self.assertSaved(
                self.client.post(admin_url(Merchant, "add"), self.merchant_data(legal_name=name)), Merchant,
            )
        self.assertEqual(Merchant.objects.filter(country="XA", tax_id="").count(), 2)

    def test_cleared_extra_is_saved_as_empty_object(self):
        response = self.client.post(admin_url(Merchant, "add"), self.merchant_data(extra=""))
        self.assertSaved(response, Merchant)
        self.assertEqual(Merchant.objects.get(legal_name="ТОО «Новый продавец»").extra, {})

    def test_invalid_extra_is_form_error(self):
        response = self.client.post(admin_url(Merchant, "add"), self.merchant_data(extra="{не json"))
        self.assertFormError(response, "extra")


class StoreAdminTests(StoresAdminTestCase):
    def test_add_fills_address_key(self):
        response = self.client.post(admin_url(Store, "add"), self.store_data())
        self.assertSaved(response, Store)
        store = Store.objects.get(address_raw="г. Тестоград, пр. Образцовый, 7")
        self.assertEqual(store.address_key, "г тестоград пр образцовый 7")
        self.assertEqual(store.address_key, address_key(store.address_raw, store.address_i18n))

    def test_add_builds_address_key_from_i18n(self):
        response = self.client.post(admin_url(Store, "add"), self.store_data(
            address_i18n='{"ru": "г. Тестоград, пр. Образцовый, 7", "kk": "Тестоград қ., Үлгі д-лы, 7"}',
        ))
        self.assertSaved(response, Store)
        store = Store.objects.get(address_raw="г. Тестоград, пр. Образцовый, 7")
        self.assertEqual(store.address_key, "тестоград қ үлгі д лы 7")

    def test_address_key_is_readonly_and_ignored_in_post(self):
        for name, args in (("add", ()), ("change", (self.store.pk,))):
            with self.subTest(page=name):
                page = self.client.get(admin_url(Store, name, *args))
                self.assertNotIn("address_key", page.context["adminform"].form.fields)
        response = self.client.post(admin_url(Store, "add"), self.store_data(address_key="подставной ключ"))
        self.assertSaved(response, Store)
        store = Store.objects.get(address_raw="г. Тестоград, пр. Образцовый, 7")
        self.assertEqual(store.address_key, "г тестоград пр образцовый 7")

    def test_change_keeps_address_key(self):
        old_key = self.store.address_key
        response = self.client.post(admin_url(Store, "change", self.store.pk), self.store_data(
            name="Тестмарт после переезда", branch_code="001", address_raw="г. Тестоград, ул. Новая, 99",
            address_i18n='{"ru": "г. Тестоград, ул. Новая, 99"}', timezone="Europe/Berlin",
        ))
        self.assertSaved(response, Store)
        self.store.refresh_from_db()
        self.assertEqual(self.store.address_raw, "г. Тестоград, ул. Новая, 99")
        self.assertEqual(self.store.name, "Тестмарт после переезда")
        self.assertEqual(self.store.timezone, "Europe/Berlin")
        self.assertEqual(self.store.address_key, old_key)

    def test_duplicate_address_is_form_error(self):
        # Отличия в регистре и пунктуации дают тот же ключ.
        for address in (ADDRESS, "Г ТЕСТОГРАД / ул Примерная - 1"):
            with self.subTest(address=address):
                response = self.client.post(admin_url(Store, "add"), self.store_data(address_raw=address))
                self.assertFormError(response, "address_raw", "уже есть магазин")
                self.assertEqual(Store.objects.filter(merchant=self.merchant).count(), 1)

    def test_same_address_of_other_merchant_is_allowed(self):
        response = self.client.post(
            admin_url(Store, "add"), self.store_data(merchant=self.other_merchant.pk, address_raw=ADDRESS),
        )
        self.assertSaved(response, Store)
        self.assertEqual(Store.objects.filter(address_key=self.store.address_key).count(), 2)

    def test_change_to_merchant_with_same_address_is_form_error(self):
        other = Store.objects.create(
            merchant=self.other_merchant, country=self.country, address_raw=ADDRESS, timezone="Asia/Almaty",
        )
        response = self.client.post(
            admin_url(Store, "change", other.pk), self.store_data(address_raw=ADDRESS),
        )
        self.assertFormError(response, "address_raw", "уже есть магазин")
        other.refresh_from_db()
        self.assertEqual(other.merchant, self.other_merchant)

    def test_empty_address_key_is_form_error(self):
        response = self.client.post(admin_url(Store, "add"), self.store_data(address_raw="— / —"))
        self.assertFormError(response, "address_raw", "ключ адреса")
        self.assertEqual(Store.objects.count(), 1)

    def test_duplicate_branch_code_is_form_error(self):
        response = self.client.post(admin_url(Store, "add"), self.store_data(branch_code="001"))
        self.assertFormError(response, "__all__")
        self.assertEqual(Store.objects.count(), 1)

    def test_unknown_timezone_is_form_error(self):
        for timezone in ("Asia/Testograd", "UTC+5", "../etc/passwd", "Asia", "asia/almaty"):
            with self.subTest(timezone=timezone):
                response = self.client.post(admin_url(Store, "add"), self.store_data(timezone=timezone))
                self.assertFormError(response, "timezone", "часовой пояс")
                self.assertEqual(Store.objects.count(), 1)

    def test_unknown_timezone_is_form_error_on_change(self):
        response = self.client.post(
            admin_url(Store, "change", self.store.pk),
            self.store_data(address_raw=ADDRESS, branch_code="001", timezone="Asia/Testograd"),
        )
        self.assertFormError(response, "timezone", "часовой пояс")
        self.store.refresh_from_db()
        self.assertEqual(self.store.timezone, "Asia/Almaty")

    def test_cleared_address_i18n_is_saved_as_empty_object(self):
        response = self.client.post(admin_url(Store, "add"), self.store_data(address_i18n=""))
        self.assertSaved(response, Store)
        store = Store.objects.get(address_raw="г. Тестоград, пр. Образцовый, 7")
        self.assertEqual(store.address_i18n, {})
        self.assertEqual(store.address_key, "г тестоград пр образцовый 7")

    def test_missing_required_fields_are_form_errors(self):
        response = self.client.post(
            admin_url(Store, "add"), self.store_data(merchant="", address_raw="", timezone=""),
        )
        for field in ("merchant", "address_raw", "timezone"):
            self.assertFormError(response, field)
        self.assertEqual(Store.objects.count(), 1)
