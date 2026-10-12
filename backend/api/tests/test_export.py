"""Выгрузка ``GET /api/export/``: фильтры, разделы, видимость семьи, число запросов."""
import json
from datetime import date, datetime, time
from decimal import Decimal as D
from pathlib import Path
from zoneinfo import ZoneInfo

from django.db import connection
from django.test import TestCase, tag
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api import export
from api.tests.accounts_helpers import TwoUsers, accounts_mode, local_single_mode, make_user
from api.tests.factories import make_product, make_receipt
from budget.models import BudgetLimit
from catalog.models import Category, GenericProduct
from receipts.models import Receipt
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line
from recognition.models import ProcessingJob
from recognition.previews import variant_url
from recognition.tests.test_models import make_image, make_photo

FIXTURE = Path(__file__).resolve().parent / "fixtures/export/example.json"


def manual(owner, on, total, currency="EUR", note="", store=None):
    """Ручная трата; без магазина — «Без места»."""
    return Receipt.objects.create(
        owner=owner, store=store, source=Receipt.Source.MANUAL, currency_id=currency, operation=Receipt.Operation.SALE,
        purchased_at=datetime.combine(on, time(12, 0), tzinfo=ZoneInfo("UTC")), purchased_on=on, total=D(total), note=note,
    )


class ExportData:
    """Семья ``first`` + ``third``, посторонний ``second``; чеки с фото, ручные и выписки, две валюты."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.third = make_user("synthetic-user-three", first_name="Лиза")
        cls.family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=cls.family)
        cls.store = samples.lidl_store()
        cls.food = Category.objects.create(name="Демо-продукты")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)
        cls.cheese = Category.objects.create(name="Демо-сыры", parent=cls.dairy)
        cls.home = Category.objects.create(name="Демо-дом")
        milk = GenericProduct.objects.create(name="Демо-молоко", category=cls.dairy, base_unit="l")
        cls.milk = make_product(milk, "Демо-молоко 1 л")
        # Фото, EUR, сентябрь: молоко (товар) и сыр (своя категория строки); 0.10 + 0.20 — без ошибки float.
        cls.photo = make_receipt(cls.store, "EUR", date(2026, 9, 5), owner=cls.first, total=D("0.30"), note="")
        make_line(cls.photo, position=1, raw_name="MILCH", product=cls.milk, quantity=D("1.000"),
                  unit_price=D("0.1000"), amount=D("0.10"))
        make_line(cls.photo, position=2, raw_name="Käse", category=cls.cheese, quantity=D("0.250"),
                  unit_price=D("0.8000"), amount=D("0.20"), discount_amount=D("0.05"))
        # Выписка третьего, октябрь, без места.
        cls.statement = manual(cls.third, date(2026, 10, 2), "1234.56", note="Кофе · Выписка Kaspi 10.2026")
        make_line(cls.statement, raw_name="Кофе", category=cls.home, unit_price=D("1234.5600"), amount=D("1234.56"))
        # Ручная трата первого в тенге с «·» в середине, но не выписка.
        cls.lunch = manual(cls.first, date(2026, 10, 3), "2500.00", currency="KZT", note="Выписка · обед")
        make_line(cls.lunch, raw_name="Обед", category=cls.food, unit_price=D("2500.0000"), amount=D("2500.00"))
        # Чужой чек: не виден семье.
        cls.foreign = make_receipt(cls.store, "EUR", date(2026, 10, 1), owner=cls.second, total=D("99.99"),
                                   note="Секрет")
        make_line(cls.foreign, raw_name="Чужое", category=cls.food, unit_price=D("99.9900"), amount=D("99.99"))
        BudgetLimit.objects.create(household=cls.family, category=cls.food, currency_id="EUR", amount=D("100.00"))
        BudgetLimit.objects.create(household=cls.family, category=cls.home, currency_id="KZT", amount=D("5000.00"))
        BudgetLimit.objects.create(user=cls.second, category=cls.food, currency_id="EUR", amount=D("7.00"))
        job = ProcessingJob.objects.create(photo=make_photo(owner=cls.first))
        cls.image = make_image(job, status="imported", receipt_id=cls.photo.pk, import_effect="created")

    def get(self, query="", account=None, status=200):
        response = self.client_of(account or self.first).get(f"/api/export/{query}")
        self.assertEqual(response.status_code, status, response.content)
        return response

    def doc(self, query="", account=None):
        return self.get(query, account).json()

    def ids(self, query, account=None):
        return [item["id"] for item in self.doc(query, account)["receipts"]]

    def fields(self, query, status=400):
        body = self.get(query, status=status).json()
        self.assertEqual(body["error"]["code"], "invalid_parameter")
        return set(body["error"]["fields"])


@tag("integration")
@accounts_mode()
class ExportDocumentTests(ExportData, TwoUsers, TestCase):
    def test_document_shape_money_and_lines(self):
        response = self.get()
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertNotIn("Content-Disposition", response)
        self.assertEqual(response["Cache-Control"], "no-store")
        doc = response.json()
        self.assertEqual((doc["format"], doc["version"]), ("checkist-export", 1))
        self.assertTrue(doc["exported_at"].endswith("Z"))
        self.assertEqual(doc["people"], [{"username": "synthetic-user-one", "display_name": "synthetic-user-one"},
                                         {"username": "synthetic-user-three", "display_name": "Лиза"}])
        self.assertEqual(doc["filters"]["include"], ["receipts", "lines", "categories", "stores", "limits", "summary"])
        self.assertEqual([item["id"] for item in doc["receipts"]], [self.photo.pk, self.statement.pk, self.lunch.pk])
        photo = doc["receipts"][0]
        self.assertEqual({key: photo[key] for key in ("source", "purchased_on", "store_id", "currency", "total", "owner")},
                         {"source": "photo", "purchased_on": "2026-09-05", "store_id": self.store.pk, "currency": "EUR",
                          "total": "0.30", "owner": "synthetic-user-one"})
        self.assertEqual(photo["categories"], ["Демо-продукты / Демо-молочное", "Демо-продукты / Демо-молочное / Демо-сыры"])
        self.assertNotIn("media", photo)
        self.assertEqual(photo["lines"][0], {
            "position": 1, "kind": "product", "name": "MILCH", "quantity": "1.000", "unit": "pcs", "unit_price": "0.1000",
            "amount": "0.10", "discount_amount": "0.00", "paid_amount": "0.10", "category_id": self.dairy.pk,
            "category_path": "Демо-продукты / Демо-молочное", "product_id": self.milk.pk, "product_name": "Демо-молоко 1 л",
        })
        self.assertEqual((photo["lines"][1]["paid_amount"], photo["lines"][1]["product_id"]), ("0.15", None))
        statement = doc["receipts"][1]
        self.assertEqual((statement["source"], statement["store_id"], statement["store_name"], statement["owner_name"]),
                         ("statement", None, None, "Лиза"))
        self.assertEqual(doc["receipts"][2]["source"], "manual")
        self.assertEqual([store["id"] for store in doc["stores"]], [self.store.pk])
        self.assertEqual(set(doc["stores"][0]), {"id", "name", "address", "city", "country"})
        paths = {item["id"]: item for item in doc["categories"]}
        self.assertEqual(paths[self.cheese.pk], {"id": self.cheese.pk, "name": "Демо-сыры", "parent_id": self.dairy.pk,
                                                 "path": "Демо-продукты / Демо-молочное / Демо-сыры"})
        self.assertEqual(doc["limits"], [
            {"category_id": self.food.pk, "category_path": "Демо-продукты", "currency": "EUR", "amount": "100.00"},
            {"category_id": self.home.pk, "category_path": "Демо-дом", "currency": "KZT", "amount": "5000.00"},
        ])

    def test_summary_per_currency_never_adds_currencies(self):
        summary = self.doc()["summary"]
        self.assertEqual((summary["receipts_count"], summary["lines_count"], summary["max_receipts"]), (3, 4, 20000))
        eur, kzt = summary["currencies"]
        self.assertEqual((eur["currency"], eur["receipts_count"], eur["lines_count"], eur["total"]), ("EUR", 2, 3, "1234.86"))
        self.assertIsNone(eur["category_total"])
        self.assertEqual(eur["by_category"], [
            {"category_id": self.home.pk, "name": "Демо-дом", "amount": "1234.56", "lines_count": 1},
            {"category_id": self.food.pk, "name": "Демо-продукты", "amount": "0.25", "lines_count": 2},
        ])
        self.assertEqual(eur["by_month"], [{"month": "2026-09", "receipts_count": 1, "total": "0.30"},
                                           {"month": "2026-10", "receipts_count": 1, "total": "1234.56"}])
        self.assertEqual((kzt["currency"], kzt["total"], kzt["by_month"][0]["month"]), ("KZT", "2500.00", "2026-10"))

    def test_outsider_sees_nothing_of_the_family(self):
        doc = self.doc(account=self.second)
        self.assertEqual([item["id"] for item in doc["receipts"]], [self.foreign.pk])
        self.assertEqual(doc["people"], [{"username": "synthetic-user-two", "display_name": "synthetic-user-two"}])
        self.assertEqual([limit["amount"] for limit in doc["limits"]], ["7.00"])
        self.assertEqual(doc["summary"]["receipts_count"], 1)
        text = json.dumps(doc, ensure_ascii=False)
        for secret in ("Кофе", "Обед", "MILCH", "synthetic-user-one", "Лиза"):
            self.assertNotIn(secret, text)
        # The family does not see the outsider either, and cannot ask for them by name.
        self.assertNotIn("Секрет", json.dumps(self.doc(), ensure_ascii=False))
        self.assertEqual(self.fields("?owner=synthetic-user-two"), {"owner"})
        response = self.client_of(self.second).get("/api/export/?owner=synthetic-user-one")
        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["error"]["fields"], {"owner": ["Такого человека нет в семье."]})

    def test_anonymous_is_refused(self):
        response = APIClient().get("/api/export/")
        self.assertEqual(response.status_code, 401)
        self.assertEqual(response.json()["error"]["code"], "not_authenticated")

    def test_download_header(self):
        response = self.get("?download=1&from=2026-09-01&to=2026-10-31")
        self.assertEqual(response["Content-Disposition"],
                         'attachment; filename="checkist-export-2026-09-01-2026-10-31.json"')
        self.assertEqual(response["Content-Type"], "application/json")
        today = export.filename(export.Filters(), date(2026, 10, 12))
        self.assertEqual(today, "checkist-export-all-2026-10-12.json")
        self.assertNotIn("Content-Disposition", self.get("?download=0"))

    def test_post_is_not_allowed(self):
        response = self.client_of(self.first).post("/api/export/")
        self.assertIn(response.status_code, (403, 405))


@tag("integration")
@accounts_mode()
class ExportFilterTests(ExportData, TwoUsers, TestCase):
    def test_period_inclusive(self):
        self.assertEqual(self.ids("?from=2026-10-02&to=2026-10-02"), [self.statement.pk])
        self.assertEqual(self.ids("?from=2026-10-01"), [self.statement.pk, self.lunch.pk])
        self.assertEqual(self.ids("?to=2026-09-05"), [self.photo.pk])

    def test_category_with_descendants_and_category_total(self):
        self.assertEqual(self.ids(f"?category={self.food.pk}"), [self.photo.pk, self.lunch.pk])
        self.assertEqual(self.ids(f"?category={self.cheese.pk}"), [self.photo.pk])
        self.assertEqual(self.ids(f"?category={self.cheese.pk}&category={self.home.pk}"), [self.photo.pk, self.statement.pk])
        self.assertEqual(self.ids(f"?category={self.cheese.pk},{self.home.pk}"), [self.photo.pk, self.statement.pk])
        doc = self.doc(f"?category={self.dairy.pk}")
        eur = doc["summary"]["currencies"][0]
        self.assertEqual((eur["total"], eur["category_total"]), ("0.30", "0.25"))
        self.assertEqual(doc["filters"]["category"], [self.dairy.pk])
        self.assertEqual(doc["limits"], [])  # лимит у «Демо-продукты» — предок, не потомок
        self.assertEqual(len(self.doc(f"?category={self.food.pk}")["limits"]), 1)

    def test_sources_and_statement_heuristic(self):
        self.assertEqual(self.ids("?source=photo"), [self.photo.pk])
        self.assertEqual(self.ids("?source=statement"), [self.statement.pk])
        self.assertEqual(self.ids("?source=manual"), [self.lunch.pk])
        self.assertEqual(self.ids("?source=manual,statement"), [self.statement.pk, self.lunch.pk])
        # Only the last «·» part counts, and only for manual spends.
        Receipt.objects.filter(pk=self.photo.pk).update(note="· Выписка 1")
        self.assertEqual(self.ids("?source=statement"), [self.statement.pk])
        Receipt.objects.filter(pk=self.lunch.pk).update(note="Такси · Выписка Halyk · 12:30")
        self.assertEqual(self.ids("?source=statement"), [self.statement.pk])
        Receipt.objects.filter(pk=self.lunch.pk).update(note="Такси ·Выписка Halyk")
        self.assertEqual(self.ids("?source=statement"), [self.statement.pk, self.lunch.pk])

    def test_owner_store_currency_text_and_totals(self):
        self.assertEqual(self.ids("?owner=synthetic-user-three"), [self.statement.pk])
        self.assertEqual(self.ids("?owner=synthetic-user-three&owner=synthetic-user-one"),
                         [self.photo.pk, self.statement.pk, self.lunch.pk])
        self.assertEqual(self.ids(f"?store={self.store.pk}"), [self.photo.pk])
        self.assertEqual(self.ids("?currency=kzt"), [self.lunch.pk])
        self.assertEqual(self.ids("?q=кофе"), [self.statement.pk])
        self.assertEqual(self.ids("?q=milch"), [self.photo.pk])
        self.assertEqual(self.ids("?q=обед"), [self.lunch.pk])
        self.assertEqual(self.ids("?min_total=1234.56"), [self.statement.pk, self.lunch.pk])
        self.assertEqual(self.ids("?max_total=1234,56"), [self.photo.pk, self.statement.pk])
        self.assertEqual(self.ids("?min_total=1&max_total=2000"), [self.statement.pk])

    def test_combined_filters_and_normalized_echo(self):
        query = (f"?from=2026-09-01&to=2026-10-31&category={self.food.pk}&source=photo,manual&owner=synthetic-user-one"
                 f"&currency=EUR&min_total=0.3&include=summary,receipts")
        doc = self.doc(query)
        self.assertEqual([item["id"] for item in doc["receipts"]], [self.photo.pk])
        self.assertEqual(doc["filters"], {
            "from": "2026-09-01", "to": "2026-10-31", "category": [self.food.pk], "source": ["photo", "manual"],
            "owner": ["synthetic-user-one"], "store": [], "currency": "EUR", "q": None, "min_total": "0.30",
            "max_total": None, "include": ["receipts", "summary"],
        })
        self.assertEqual(set(doc), {"format", "version", "exported_at", "filters", "people", "receipts", "summary"})
        self.assertNotIn("lines", doc["receipts"][0])

    def test_include_sections(self):
        doc = self.doc("?include=summary")
        self.assertEqual(set(doc), {"format", "version", "exported_at", "filters", "people", "summary"})
        self.assertEqual(self.doc("?include=stores")["stores"][0]["id"], self.store.pk)
        media = self.doc("?include=receipts,media")["receipts"]
        self.assertEqual(media[0]["media"]["display_url"], "http://testserver" + variant_url(self.image.file.name, "display"))
        self.assertTrue(media[0]["media"]["download_url"].startswith("http://testserver/media/originals/"))
        self.assertTrue(media[0]["media"]["download_url"].endswith("?download=1"))
        self.assertIsNone(media[1]["media"])

    def test_validation_errors(self):
        self.assertEqual(self.fields("?from=2026-13-01"), {"from"})
        self.assertEqual(self.fields("?from=2026-10-02&to=2026-10-01"), {"from"})
        self.assertEqual(self.fields("?category=999999999"), {"category"})
        self.assertEqual(self.fields("?category=abc"), {"category"})
        self.assertEqual(self.fields("?source=paper"), {"source"})
        self.assertEqual(self.fields("?store=999999999"), {"store"})
        self.assertEqual(self.fields("?currency=XXX"), {"currency"})
        self.assertEqual(self.fields("?q=a"), {"q"})
        self.assertEqual(self.fields("?min_total=1.234"), {"min_total"})
        self.assertEqual(self.fields("?min_total=5&max_total=1"), {"min_total"})
        self.assertEqual(self.fields("?include=everything"), {"include"})
        self.assertEqual(self.fields("?include=lines,summary"), {"include"})
        self.assertEqual(self.fields("?download=yes"), {"download"})
        self.assertEqual(self.fields("?owner=a%00b"), {"owner"})
        self.assertEqual(self.fields("?store=" + ",".join(str(n) for n in range(1, 60))), {"store"})
        self.assertEqual(self.fields("?source=paper&currency=XXX&q=a"), {"source", "currency", "q"})

    def test_too_many_receipts(self):
        original = export.MAX_RECEIPTS
        export.MAX_RECEIPTS = 2
        try:
            body = self.get(status=400).json()
            self.assertEqual(body["error"]["code"], "export_too_large")
            self.assertEqual(body["max_receipts"], 2)
            self.assertEqual(len(self.doc("?from=2026-10-01")["receipts"]), 2)
            self.assertEqual(self.doc("?include=summary")["summary"]["receipts_count"], 3)
        finally:
            export.MAX_RECEIPTS = original


@tag("integration")
@accounts_mode()
class ExportQueryCountTests(TwoUsers, TestCase):
    """Число запросов не зависит от числа чеков, строк и фото."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.store = samples.lidl_store()
        cls.food = Category.objects.create(name="Демо-продукты")
        cls.generic = GenericProduct.objects.create(name="Демо-хлеб", category=cls.food, base_unit="pcs")

    def add(self, count):
        for _ in range(count):
            receipt = make_receipt(self.store, "EUR", date(2026, 10, 1), owner=self.first, total=D("3.00"))
            for position in (1, 2, 3):
                make_line(receipt, position=position, product=make_product(self.generic, f"Хлеб {receipt.pk}-{position}"),
                          amount=D("1.00"), unit_price=D("1.0000"))
            job = ProcessingJob.objects.create(photo=make_photo(owner=self.first))
            make_image(job, status="imported", receipt_id=receipt.pk, import_effect="created")

    def count(self, query):
        client = self.client_of(self.first)
        client.get("/api/me/")  # сессия прочитана заранее
        with CaptureQueriesContext(connection) as captured:
            response = client.get(f"/api/export/{query}")
        self.assertEqual(response.status_code, 200, response.content)
        return len(captured), response.json()

    def test_constant_queries(self):
        query = f"?include=receipts,lines,categories,stores,limits,summary,media&category={self.food.pk}"
        self.add(2)
        small, doc = self.count(query)
        self.assertEqual(len(doc["receipts"]), 2)
        self.add(5)
        large, doc = self.count(query)
        self.assertEqual(len(doc["receipts"]), 7)
        self.assertEqual(sum(len(item["lines"]) for item in doc["receipts"]), 21)
        self.assertEqual(small, large)
        self.assertLessEqual(large, 20)


@tag("integration")
@local_single_mode()
class ExportLocalSingleTests(TestCase):
    def test_local_user_exports_own_data(self):
        receipt = make_receipt(samples.lidl_store(), "EUR", date(2026, 10, 1), total=D("1.00"))
        doc = self.client.get("/api/export/?owner=local").json()
        self.assertEqual([item["id"] for item in doc["receipts"]], [receipt.pk])
        self.assertEqual(doc["people"], [{"username": "local", "display_name": local_user().first_name or "local"}])


class ExportFixtureTests(TestCase):
    """Пример документа в ``fixtures/export/example.json`` — та же форма, что у ответа."""

    def test_example_is_a_valid_document(self):
        example = json.loads(FIXTURE.read_text(encoding="utf-8"))
        self.assertEqual((example["format"], example["version"]), (export.FORMAT, export.VERSION))
        self.assertEqual(set(example), {"format", "version", "exported_at", "filters", "people", "categories", "stores",
                                        "receipts", "limits", "summary"})
        self.assertEqual(set(example["filters"]), {"from", "to", "category", "source", "owner", "store", "currency", "q",
                                                   "min_total", "max_total", "include"})
        receipt = example["receipts"][0]
        self.assertEqual(set(receipt), {"id", "source", "operation", "purchased_on", "purchased_at", "store_id", "store_name",
                                        "currency", "total", "discount_total", "note", "owner", "owner_name", "created_at",
                                        "categories", "lines", "media"})
        self.assertEqual(set(receipt["lines"][0]), {"position", "kind", "name", "quantity", "unit", "unit_price", "amount",
                                                    "discount_amount", "paid_amount", "category_id", "category_path",
                                                    "product_id", "product_name"})
        self.assertEqual(set(example["summary"]["currencies"][0]), {"currency", "receipts_count", "lines_count", "total",
                                                                     "category_total", "by_category", "by_month"})
