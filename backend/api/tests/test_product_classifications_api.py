"""HTTP API предположений категорий: доступ, тело, чтение, операции, повторы и таблица ошибок."""
import json
from unittest.mock import patch

from django.db import OperationalError, connection
from django.test import TestCase, override_settings, tag
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from api.tests.classification_factories import local_client
from catalog.models import Category, GenericProduct, Product
from classification import demo, services
from classification.models import (
    ClassificationAttempt, ClassificationRejection, ClassificationRun, ProductClassification,
)
from classification.tests.factories import (
    CHEESE, DEPOSIT, EXAMPLE, JUICE, KEFIR_A, KEFIR_B, MILK, SAUSAGE_A, SAUSAGE_B, SOAP, TOAST, UNKNOWN, add_product,
    generic, generic_of, product, record, service, snapshot, suggest,
)
from classification.tests.test_concurrency import ConcurrencyTestCase, import_lock, tree_lock
from stores.models import Merchant, Store

BASE = "/api/product-classifications/"
RECORD_KEYS = {
    "id", "status", "resolution", "version", "created_at", "resolved_at", "product", "previous_generic", "suggested",
    "final_generic", "source", "actions",
}
PRODUCT_KEYS = {"id", "exists", "name", "brand", "package", "generic", "aliases", "merge_group_id"}
RUN_KEYS = {
    "id", "status", "trigger", "scope", "version", "created_at", "started_at", "finished_at", "progress",
    "remaining", "error",
}
# Имена полей моделей и входа модели, которых в ответах быть не должно.
CLOSED_KEYS = {
    "confidence", "note", "input_sha256", "run_token", "lease_expires_at", "heartbeat_at", "stats", "product_ids",
    "raw_payload", "invalid_output_text", "cursor", "recoveries", "classifier_version", "error_code", "legal_name",
    "tax_id", "product_facts", "origin_product_ref",
}
GROUPS = ["Кефир", "Колбаса", "Молоко", "Сок", "Средство для мытья посуды", "Сыр", "Хлеб"]


def keys(value):
    """Все имена ключей JSON на любой глубине."""
    if isinstance(value, dict):
        return set(value).union(*(keys(item) for item in value.values()))
    if isinstance(value, list):
        return set().union(*(keys(item) for item in value))
    return set()


class ClassificationApiMixin:
    def error(self, response, status, code, fields=None):
        self.assertEqual(response.status_code, status, response.content)
        body = response.json()
        self.assertEqual(set(body), {"error"})
        self.assertEqual(body["error"]["code"], code)
        self.assertEqual(set(body["error"]) - {"fields"}, {"code", "message"})
        if fields is None:
            self.assertNotIn("fields", body["error"])
        else:
            self.assertEqual(body["error"]["fields"], fields)
        self.assertEqual(response["Cache-Control"], "no-store")
        return body["error"]

    def ok(self, response, status=200):
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        return response.json()

    def post(self, path, body=None, **extra):
        return self.client.post(path, {} if body is None else body, format="json", **extra)

    def raw(self, path, data, content_type="application/json"):
        return self.client.post(path, data, content_type=content_type)

    def url(self, entry, action=""):
        return f"{BASE}{entry.pk}/{action}"

    def confirm(self, entry, **body):
        body.setdefault("version", entry.version)
        body.setdefault("generic_id", entry.suggested_generic_ref)
        return self.post(self.url(entry, "confirm/"), body)

    def reject(self, entry, **body):
        body.setdefault("version", entry.version)
        return self.post(self.url(entry, "reject/"), body)

    def confirm_many(self, *items):
        return self.post(BASE + "confirm/", {"items": [{"id": pk, "version": version} for pk, version in items]})


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class AccessAndBodyTests(ClassificationApiMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()
        cls.last_run = suggest()
        cls.entry = record(MILK)

    def setUp(self):
        self.client = local_client()

    def paths(self):
        return (
            ("get", BASE), ("get", self.url(self.entry)), ("post", self.url(self.entry, "confirm/")),
            ("post", self.url(self.entry, "reject/")), ("post", BASE + "confirm/"), ("get", BASE + "status/"),
            ("post", BASE + "runs/"), ("get", BASE + "runs/"), ("get", f"{BASE}runs/{self.last_run.pk}/"),
        )

    def posts(self):
        return [path for method, path in self.paths() if method == "post"]

    def test_access_requires_debug_flag_and_loopback(self):
        before = snapshot()
        cases = (
            ({"ALLOW_LOCAL_RECOGNITION_API": False}, {}),
            ({"DEBUG": False}, {}),
            ({}, {"REMOTE_ADDR": "192.0.2.10"}),
            ({}, {"REMOTE_ADDR": "not-an-address"}),
        )
        for overrides, extra in cases:
            for method, path in self.paths():
                with self.subTest(overrides=overrides, extra=extra, method=method, path=path), \
                        override_settings(**overrides), self.assertNumQueries(0):
                    response = getattr(self.client, method)(path, {} if method == "post" else None,
                                                            **({"format": "json"} if method == "post" else {}), **extra)
                    self.error(response, 403, "permission_denied")
        self.assertEqual(snapshot(), before)

    def test_post_requires_csrf_even_for_anonymous(self):
        before = snapshot()
        without_token = APIClient(enforce_csrf_checks=True)
        wrong_origin = local_client()
        wrong_origin.credentials(
            HTTP_X_CSRFTOKEN=wrong_origin.get("/api/recognition/csrf/").json()["csrf_token"],
            HTTP_ORIGIN="http://evil.example",
        )
        for name, client in (("no token", without_token), ("foreign origin", wrong_origin)):
            for path in self.posts():
                with self.subTest(client=name, path=path), self.assertNumQueries(0):
                    self.error(client.post(path, {}, format="json"), 403, "csrf_failed")
        # Без токена отказ приходит раньше 405: небезопасный метод сначала проходит доступ и CSRF.
        self.error(without_token.post(BASE, {}, format="json"), 403, "csrf_failed")
        # Чтение токена не требует.
        self.ok(without_token.get(BASE))
        self.ok(without_token.get(BASE + "status/"))
        self.assertEqual(snapshot(), before)

    def test_methods_and_unknown_paths(self):
        for method, path in self.paths():
            if path == BASE + "runs/":
                continue  # и GET, и POST
            other = "post" if method == "get" else "get"
            with self.subTest(path=path, method=other):
                response = getattr(self.client, other)(path, **({"format": "json"} if other == "post" else {}))
                self.error(response, 405, "method_not_allowed")
        for method in ("put", "patch", "delete"):
            with self.subTest(method=method):
                self.error(getattr(self.client, method)(BASE + "runs/", {}, format="json"), 405, "method_not_allowed")
        for path in (BASE + "0/", BASE + "9" * 20 + "/", BASE + "abc/", self.url(self.entry, "cancel/"),
                     BASE + "status/extra/", BASE + "0/reject/", BASE + "runs/0/", BASE + "runs/abc/",
                     f"{BASE}runs/{self.last_run.pk}/cancel/"):
            with self.subTest(path=path):
                self.error(self.client.get(path), 404, "not_found")
                self.error(self.post(path), 404, "not_found")
        # Число из 19 цифр больше BigAutoField: тот же 404, без запроса.
        with self.assertNumQueries(0):
            self.error(self.client.get(BASE + "9223372036854775808/"), 404, "not_found")
            self.error(self.client.get(BASE + "runs/9223372036854775808/"), 404, "not_found")
            self.error(self.post(BASE + "9223372036854775808/reject/", {"version": 1}), 404, "not_found")
        # Без завершающего «/» POST не перенаправляется.
        self.assertEqual(self.raw(self.url(self.entry, "reject"), b'{"version":1}').status_code, 400)

    def test_body_structure_is_invalid_request(self):
        before = snapshot()
        confirm, many, runs = self.url(self.entry, "confirm/"), BASE + "confirm/", BASE + "runs/"
        cases = (
            (confirm, b""), (confirm, b"[]"), (confirm, b'"text"'), (confirm, b"1"), (confirm, b"null"),
            (confirm, b"{"), (confirm, b'{"version":1,"generic_id":2}x'), (confirm, b"\xff"),
            (confirm, b'{"version":1,"generic_id":2,"extra":1}'),
            (confirm, b'{"version":1,"version":1,"generic_id":2}'),
            (confirm, b'{"version":NaN,"generic_id":2}'), (confirm, b'{"version":Infinity,"generic_id":2}'),
            (confirm, b'{"version":1,"generic_id":2}' + b" " * 4096),
            (self.url(self.entry, "reject/"), b'{"version":1,"generic_id":2}'),
            (many, b""), (many, b"[]"), (many, b'{"items":[{"id":1,"version":1}],"extra":1}'),
            (many, b'{"items":[{"id":1,"version":1,"extra":1}]}'),
            (many, b'{"items":[{"id":1,"id":1,"version":1}]}'),
            (many, b'{"items":[{"id":1,"version":1}]}' + b" " * 8192),
            (runs, b""), (runs, b"[]"), (runs, b'{"scope":"all"}'), (runs, b"{}" + b" " * 4096),
        )
        for path, data in cases:
            with self.subTest(path=path, data=data[:60]), self.assertNumQueries(0):
                self.error(self.raw(path, data), 400, "invalid_request")
        for path in self.posts():
            with self.subTest(path=path, content_type="text/plain"), self.assertNumQueries(0):
                self.error(self.raw(path, b"{}", "text/plain"), 415, "unsupported_media_type")
        self.assertEqual(snapshot(), before)

    def test_body_at_the_size_limit_is_accepted(self):
        body = json.dumps({"version": self.entry.version}).encode()
        self.ok(self.raw(self.url(self.entry, "reject/"), body + b" " * (4096 - len(body))))
        kefir = record(KEFIR_A)
        body = json.dumps({"items": [{"id": kefir.pk, "version": kefir.version}]}).encode()
        # У массового подтверждения предел 8192 байта, а не 4096.
        self.assertEqual(self.ok(self.raw(BASE + "confirm/", body + b" " * (8192 - len(body))))["confirmed"], 1)

    def test_value_types_are_invalid_parameter(self):
        before = snapshot()
        required, expected = ["Обязательное поле."], ["Ожидается целое положительное число."]
        confirm, reject, many = self.url(self.entry, "confirm/"), self.url(self.entry, "reject/"), BASE + "confirm/"
        cases = (
            (confirm, {}, {"version": required, "generic_id": required}),
            (confirm, {"version": 1}, {"generic_id": required}),
            (reject, {}, {"version": required}),
            (many, {}, {"items": required}),
            (many, {"items": {}}, {"items": ["Нужна хотя бы одна запись."]}),
            (many, {"items": "1"}, {"items": ["Нужна хотя бы одна запись."]}),
            (many, {"items": []}, {"items": ["Нужна хотя бы одна запись."]}),
            (many, {"items": [{"id": pk, "version": 1} for pk in range(1, 102)]},
             {"items": ["Не больше 100 записей."]}),
            (many, {"items": [1, {"id": 1}, {"id": "1", "version": 0}]}, {
                "items.0": ["Ожидается объект."], "items.1.version": required, "items.2.id": expected,
                "items.2.version": expected,
            }),
            (many, {"items": [{"id": self.entry.pk, "version": 1}, {"id": self.entry.pk, "version": 1}]},
             {"items.1.id": ["Значение повторяется."]}),
        )
        for path, body, fields in cases:
            with self.subTest(path=path, body=str(body)[:60]):
                self.error(self.post(path, body), 400, "invalid_parameter", fields)
        for value in ("1", True, 0, -1, 2**63, 1.5, None, [1], {}):
            with self.subTest(value=value):
                self.error(self.post(confirm, {"version": value, "generic_id": value}), 400, "invalid_parameter",
                           {"version": expected, "generic_id": expected})
                self.error(self.post(reject, {"version": value}), 400, "invalid_parameter", {"version": expected})
        # Тело проверяется раньше существования записи.
        self.error(self.post(BASE + "999999/reject/", {}), 400, "invalid_parameter", {"version": required})
        self.assertEqual(snapshot(), before)

    def test_query_parameters(self):
        fields = set(self.error(self.client.get(
            BASE + "?status=open&ordering=name&page=0&page_size=201&product=x&generic=0&run=1.5"
        ), 400, "invalid_parameter", self._any)["fields"])
        self.assertEqual(fields, {"status", "ordering", "page", "page_size", "product", "generic", "run"})
        fields = set(self.error(
            self.client.get(BASE + "runs/?status=done&page=x&page_size=0"), 400, "invalid_parameter", self._any,
        )["fields"])
        self.assertEqual(fields, {"status", "page", "page_size"})
        # Неизвестные параметры игнорируются; id, которого нет в базе, — пустой список, а не ошибка.
        self.assertEqual(self.ok(self.client.get(BASE + "?unknown=1&product=999999"))["count"], 0)
        self.assertEqual(self.ok(self.client.get(BASE + "?generic=999999"))["count"], 0)
        self.assertEqual(self.ok(self.client.get(BASE + "?run=999999"))["count"], 0)
        self.error(self.client.get(BASE + "?page=2"), 404, "page_out_of_range")
        self.error(self.client.get(BASE + "runs/?page=2"), 404, "page_out_of_range")

    class _Any:
        def __eq__(self, other):
            return isinstance(other, dict) and all(
                messages and all(isinstance(message, str) for message in messages) for messages in other.values()
            )

    _any = _Any()

    def test_only_json_is_served(self):
        self.error(self.client.get(BASE, HTTP_ACCEPT="text/html"), 406, "not_acceptable")
        self.error(self.client.get(BASE + "status/", HTTP_ACCEPT="text/html"), 406, "not_acceptable")

    def test_idempotency_key_is_ignored(self):
        first = self.ok(self.post(self.url(self.entry, "reject/"), {"version": 1}, HTTP_IDEMPOTENCY_KEY="one"))
        # Тот же ключ с другим действием не возвращает сохранённый ответ: ключ не читается вовсе.
        self.error(
            self.post(self.url(self.entry, "confirm/"), {"version": 1, "generic_id": generic("Молоко").pk},
                      HTTP_IDEMPOTENCY_KEY="one"),
            409, "classification_resolved",
        )
        self.assertEqual(self.ok(self.post(self.url(self.entry, "reject/"), {"version": 9},
                                           HTTP_IDEMPOTENCY_KEY="two")), first)

    def test_other_database_failure_is_503(self):
        before = snapshot()
        calls = (
            ("records", lambda: self.client.get(BASE)), ("get_record", lambda: self.client.get(self.url(self.entry))),
            ("confirm", lambda: self.confirm(self.entry)), ("reject", lambda: self.reject(self.entry)),
            ("confirm_many", lambda: self.confirm_many((self.entry.pk, 1))),
            ("summary", lambda: self.client.get(BASE + "status/")), ("request_run", lambda: self.post(BASE + "runs/")),
            ("runs", lambda: self.client.get(BASE + "runs/")),
            ("get_run", lambda: self.client.get(f"{BASE}runs/{self.last_run.pk}/")),
        )
        for name, call in calls:
            with self.subTest(service=name), patch.object(services, name, side_effect=OperationalError("secret dsn")):
                error = self.error(call(), 503, "database_unavailable")
                self.assertNotIn("secret", json.dumps(error))
        with patch.object(services, "confirm", side_effect=RuntimeError("secret")):
            self.client.raise_request_exception = False
            self.assertEqual(self.confirm(self.entry).status_code, 500)
        self.assertEqual(snapshot(), before)


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True, PRODUCT_CLASSIFICATION_AUTO_SUGGEST=False)
class ReadTests(ClassificationApiMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()
        cls.last_run = suggest()

    def setUp(self):
        self.client = local_client()

    def names(self, body):
        return [item["suggested"]["generic"]["name"] for item in body["results"]]

    def test_list_keeps_the_records_of_one_generic_product_together(self):
        body = self.ok(self.client.get(BASE))
        self.assertEqual((body["count"], body["page"], body["page_size"], body["pages"]), (9, 1, 50, 1))
        names = self.names(body)
        # Порядок групп — правило сравнения строк базы; для этих названий он алфавитный.
        self.assertEqual(list(dict.fromkeys(names)), GROUPS)
        self.assertEqual(names.count("Кефир"), 2)
        self.assertEqual(names.count("Колбаса"), 2)
        ids = [item["id"] for item in body["results"]]
        for name in ("Кефир", "Колбаса"):
            group = [item["id"] for item in body["results"] if item["suggested"]["generic"]["name"] == name]
            self.assertEqual(group, sorted(group))
            self.assertEqual({item["suggested"]["pending_count"] for item in body["results"]
                              if item["suggested"]["generic"]["name"] == name}, {2})
        self.assertEqual(self.ok(self.client.get(BASE + "?ordering=generic")), body)
        newest = self.ok(self.client.get(BASE + "?ordering=-id"))
        self.assertEqual([item["id"] for item in newest["results"]], sorted(ids, reverse=True))

    def test_record_shape_and_closed_fields(self):
        ClassificationAttempt.objects.update(invalid_output_text="CLOSED OUTPUT", raw_payload={"closed": "CLOSED RAW"})
        ProductClassification.objects.update(confidence="0.37")
        entry = record(SAUSAGE_A)
        body = self.ok(self.client.get(self.url(entry)))
        self.assertEqual(set(body), RECORD_KEYS)
        self.assertEqual(set(body["product"]), PRODUCT_KEYS)
        self.assertEqual(set(body["suggested"]), {"generic", "category", "pending_count"})
        self.assertEqual(set(body["suggested"]["generic"]), {"id", "name", "base_unit", "exists", "is_new"})
        self.assertEqual(set(body["source"]),
                         {"run_id", "trigger", "provider", "model", "prompt_version", "schema_version"})
        self.assertEqual(body["actions"], {"can_confirm": True, "can_choose": True, "can_reject": True})
        self.assertEqual(
            (body["status"], body["resolution"], body["version"], body["resolved_at"], body["final_generic"]),
            ("pending", None, 1, None, None),
        )
        sausage = generic("Колбаса")
        self.assertEqual(body["product"]["generic"], {"id": sausage.pk, "name": "Колбаса", "base_unit": "kg"})
        self.assertEqual(body["product"]["brand"]["name"], "Demowurst")
        self.assertEqual(body["product"]["package"], {"quantity": "200.000", "unit": "g"})
        # Написания в порядке raw_name, id; вывеска продавца, а не юридическое название.
        self.assertEqual(body["product"]["aliases"], [
            {"store_name": "Kategoriemarkt", "raw_name": "Demo Mettw. fein", "store_item_code": ""},
            {"store_name": "Kategoriemarkt", "raw_name": "Demo Mettwurst fein", "store_item_code": ""},
        ])
        self.assertEqual(body["previous_generic"], {"id": service().pk, "name": "Не разобрано", "base_unit": "pcs"})
        self.assertEqual(body["suggested"]["generic"], {
            "id": sausage.pk, "name": "Колбаса", "base_unit": "kg", "exists": True, "is_new": True,
        })
        path = body["suggested"]["category"]["path"]
        self.assertEqual([(step["name"], step["is_new"]) for step in path],
                         [("Продукты питания", False), ("Мясные продукты", True)])
        self.assertEqual({key: body["suggested"]["category"][key] for key in ("id", "name")},
                         {"id": sausage.category_id, "name": "Мясные продукты"})
        self.assertEqual(body["source"], {
            "run_id": self.last_run.pk, "trigger": "command", "provider": "fake", "model": "", "prompt_version": "1",
            "schema_version": "1",
        })
        pages = [self.client.get(path) for path in (
            BASE, self.url(entry), BASE + "status/", BASE + "runs/", f"{BASE}runs/{self.last_run.pk}/",
        )]
        for response in pages:
            with self.subTest(path=response.request["PATH_INFO"]):
                self.assertFalse(keys(self.ok(response)) & CLOSED_KEYS)
                text = response.content.decode("utf-8")
                for closed in ("CLOSED", "0.37", "DEMOCLASS0001", "Testhandel", str(self.last_run.run_token)):
                    self.assertNotIn(closed, text)

    def test_filters(self):
        kefir, milk = generic("Кефир"), record(MILK)
        self.assertEqual(self.ok(self.client.get(f"{BASE}?generic={kefir.pk}"))["count"], 2)
        self.assertEqual(self.ok(self.client.get(f"{BASE}?product={milk.product_ref}"))["results"][0]["id"], milk.pk)
        self.assertEqual(self.ok(self.client.get(f"{BASE}?run={self.last_run.pk}"))["count"], 9)
        self.ok(self.reject(milk))
        self.ok(self.confirm(record(JUICE)))
        counts = {
            status: self.ok(self.client.get(f"{BASE}?status={status}"))["count"]
            for status in ("pending", "confirmed", "rejected", "superseded")
        }
        self.assertEqual(counts, {"pending": 7, "confirmed": 1, "rejected": 1, "superseded": 0})
        self.assertEqual(self.ok(self.client.get(BASE))["count"], 9)
        # Удалённый товар находится по своему id; запись, перешедшая к другому товару, — и по исходному.
        toast = record(TOAST)
        Product.objects.filter(pk=toast.product_ref).delete()
        ProductClassification.objects.filter(pk=record(SOAP).pk).update(origin_product_ref=987654)
        self.assertEqual(self.ok(self.client.get(f"{BASE}?product={toast.product_ref}"))["count"], 1)
        self.assertEqual(self.ok(self.client.get(f"{BASE}?product=987654"))["results"][0]["id"], record(SOAP).pk)

    def test_pagination(self):
        first = self.ok(self.client.get(BASE + "?page_size=4"))
        self.assertEqual((first["count"], first["pages"], len(first["results"])), (9, 3, 4))
        last = self.ok(self.client.get(BASE + "?page_size=4&page=3"))
        self.assertEqual(len(last["results"]), 1)
        self.assertEqual(len(self.ok(self.client.get(BASE + "?page_size=200"))["results"]), 9)
        self.error(self.client.get(BASE + "?page_size=4&page=4"), 404, "page_out_of_range")
        self.assertEqual(self.ok(self.client.get(BASE + "?status=superseded")), {
            "count": 0, "page": 1, "page_size": 50, "pages": 0, "results": [],
        })

    def test_query_counts_do_not_depend_on_the_page_size(self):
        entry = record(KEFIR_A)
        for size in (1, 2, 9, 200):
            with self.subTest(page_size=size), self.assertNumQueries(9):
                self.ok(self.client.get(f"{BASE}?page_size={size}"))
        with self.assertNumQueries(9):
            self.ok(self.client.get(BASE + "?status=pending&ordering=-id"))
        with self.assertNumQueries(8):
            self.ok(self.client.get(self.url(entry)))
        with self.assertNumQueries(5):
            self.ok(self.client.get(BASE + "status/"))
        with self.assertNumQueries(1):
            self.ok(self.client.get(f"{BASE}runs/{self.last_run.pk}/"))
        for index in range(5):
            ClassificationRun.objects.create(
                status="cancelled", trigger="manual", scope="all", finished_at=self.last_run.finished_at,
            )
        for size in (1, 200):
            with self.subTest(runs_page_size=size), self.assertNumQueries(2):
                self.ok(self.client.get(f"{BASE}runs/?page_size={size}"))
        # Пустая страница: счётчик и страница, без запросов описания.
        with self.assertNumQueries(2):
            self.ok(self.client.get(BASE + "?status=superseded"))

    def test_merchant_without_a_sign_is_named_by_its_store(self):
        Merchant.objects.update(brand_name="")
        Store.objects.update(name="Laden am Markt")
        with self.assertNumQueries(10):  # один запрос магазинов на страницу
            body = self.ok(self.client.get(BASE + "?page_size=200"))
        self.assertEqual({alias["store_name"] for item in body["results"] for alias in item["product"]["aliases"]},
                         {"Laden am Markt"})

    def test_record_changed_outside_the_screen_is_shown_without_actions(self):
        entry = record(JUICE)
        Product.objects.filter(pk=entry.product_ref).update(generic=generic("Молоко"))
        before = snapshot()
        body = self.ok(self.client.get(self.url(entry)))
        self.assertEqual(body["status"], "pending")
        self.assertEqual(body["actions"], {"can_confirm": False, "can_choose": False, "can_reject": False})
        self.assertEqual(body["product"]["generic"]["name"], "Молоко")
        self.assertEqual(body["suggested"]["generic"]["name"], "Сок")
        self.assertEqual(snapshot(), before)  # чтение ничего не пишет

    def test_deleted_product_and_generic_are_shown_from_the_snapshot(self):
        entry = record(SAUSAGE_A)
        self.ok(self.reject(entry))
        self.ok(self.reject(record(SAUSAGE_B)))
        Product.objects.filter(pk=entry.product_ref).delete()
        body = self.ok(self.client.get(self.url(entry)))
        self.assertEqual(body["product"], {
            "id": entry.product_ref, "exists": False, "name": SAUSAGE_A,
            "brand": {"id": body["product"]["brand"]["id"], "name": "Demowurst"},
            "package": {"quantity": "200.000", "unit": "g"}, "generic": None, "aliases": [], "merge_group_id": None,
        })
        self.assertEqual(body["suggested"]["generic"], {
            "id": entry.suggested_generic_ref, "name": "Колбаса", "base_unit": "kg", "exists": False, "is_new": False,
        })
        self.assertEqual([(step["name"], step["is_new"]) for step in body["suggested"]["category"]["path"]],
                         [("Продукты питания", False), ("Мясные продукты", False)])
        self.assertEqual(body["final_generic"], {"id": service().pk, "name": "Не разобрано", "base_unit": "pcs"})
        self.assertEqual(body["actions"], {"can_confirm": False, "can_choose": False, "can_reject": False})

    def test_status(self):
        body = self.ok(self.client.get(BASE + "status/"))
        self.assertEqual(set(body), {"pending_count", "unclassified_count", "auto_suggest", "run", "executor"})
        self.assertEqual((body["pending_count"], body["unclassified_count"], body["auto_suggest"]), (9, 1, False))
        self.assertEqual(set(body["run"]), RUN_KEYS)
        self.assertEqual((body["run"]["id"], body["run"]["status"], body["run"]["trigger"]),
                         (self.last_run.pk, "succeeded", "command"))
        self.assertEqual(body["run"]["progress"],
                         {"requested": 10, "processed": 10, "applied": 9, "unknown": 1, "skipped": 0})
        self.assertEqual(body["executor"], {"available": False, "state": "absent", "last_seen_at": None})
        self.assertEqual(body["executor"], self.client.get("/api/recognition/csrf/").json()["executor"])
        with override_settings(PRODUCT_CLASSIFICATION_AUTO_SUGGEST=True):
            self.assertIs(self.ok(self.client.get(BASE + "status/"))["auto_suggest"], True)
        # Активный запуск важнее последнего: в очереди, затем выполняющийся.
        queued = self.ok(self.post(BASE + "runs/"), 202)["run"]
        self.assertEqual(self.ok(self.client.get(BASE + "status/"))["run"], queued)
        ClassificationRun.objects.create(
            status="cancelled", trigger="manual", scope="all", finished_at=self.last_run.finished_at,
        )
        self.assertEqual(self.ok(self.client.get(BASE + "status/"))["run"]["id"], queued["id"])

    def test_run_errors_have_fixed_messages(self):
        from api.product_classification_serialization import RUN_ERRORS

        self.assertEqual(set(RUN_ERRORS), {
            "auth_required", "network_unavailable", "rate_limited", "provider_unavailable", "configuration_error",
            "invalid_input", "invalid_output", "timeout", "worker_lost", "input_too_large", "internal_error",
        })
        url = f"{BASE}runs/{self.last_run.pk}/"
        self.assertIsNone(self.ok(self.client.get(url))["error"])
        ClassificationRun.objects.filter(pk=self.last_run.pk).update(status="failed")
        for code, message in RUN_ERRORS.items():
            with self.subTest(code=code):
                ClassificationRun.objects.filter(pk=self.last_run.pk).update(error_code=code)
                self.assertEqual(self.ok(self.client.get(url))["error"], {"code": code, "message": message})
        for code in ("", "provider_error", "Traceback: secret"):
            with self.subTest(code=code):
                ClassificationRun.objects.filter(pk=self.last_run.pk).update(error_code=code)
                self.assertEqual(self.ok(self.client.get(url))["error"],
                                 {"code": "internal_error", "message": "Запуск завершился ошибкой."})
        # Код ошибки не показывается у запуска, который не завершился ошибкой.
        ClassificationRun.objects.filter(pk=self.last_run.pk).update(status="succeeded", error_code="timeout")
        self.assertIsNone(self.ok(self.client.get(url))["error"])

    def test_runs_list_and_not_found(self):
        created = self.ok(self.post(BASE + "runs/"), 202)["run"]
        body = self.ok(self.client.get(BASE + "runs/"))
        self.assertEqual([item["id"] for item in body["results"]], [created["id"], self.last_run.pk])
        self.assertEqual(self.ok(self.client.get(BASE + "runs/?status=queued"))["results"], [created])
        self.assertEqual(self.ok(self.client.get(BASE + "runs/?status=failed"))["count"], 0)
        self.assertEqual(self.ok(self.client.get(f"{BASE}runs/{created['id']}/")), created)
        self.assertEqual(created["remaining"], 0)
        for path in (BASE + "999999/", BASE + "runs/999999/"):
            with self.subTest(path=path), self.assertNumQueries(1):
                self.error(self.client.get(path), 404, "not_found")


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class OperationTests(ClassificationApiMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()
        cls.last_run = suggest()

    def setUp(self):
        self.client = local_client()

    def test_confirm_keeps_the_product_and_repeats_without_writes(self):
        entry, before = record(JUICE), generic_of(JUICE)
        body = self.ok(self.confirm(entry))
        self.assertEqual((body["status"], body["resolution"], body["version"]), ("confirmed", "confirmed", 2))
        self.assertEqual(body["final_generic"]["name"], "Сок")
        self.assertEqual(body["suggested"]["generic"]["is_new"], False)  # принято вместе с категорией
        self.assertEqual([step["is_new"] for step in body["suggested"]["category"]["path"]], [False])
        self.assertEqual(body["suggested"]["pending_count"], 0)
        self.assertEqual(body["actions"], {"can_confirm": False, "can_choose": False, "can_reject": False})
        self.assertEqual(generic_of(JUICE), before)
        saved = snapshot()
        for version in (1, 2, 77):
            with self.subTest(version=version):
                self.assertEqual(self.ok(self.confirm(entry, version=version)), body)
        self.assertEqual(snapshot(), saved)
        # Тот же confirm с другим generic_id и отклонение подтверждённой — уже не повтор.
        self.error(self.confirm(entry, generic_id=generic("Молоко").pk), 409, "classification_resolved")
        self.error(self.reject(entry, version=2), 409, "classification_resolved")
        self.assertEqual(snapshot(), saved)

    def test_choose_another_moves_the_product_and_removes_the_created_one(self):
        entry, milk, cheese = record(CHEESE), generic("Молоко"), generic("Сыр")
        def listed():
            return {item["name"] for item in self.client.get("/api/generic-products/").json()["results"]}

        self.assertIn("Сыр", listed())
        body = self.ok(self.confirm(entry, generic_id=milk.pk))
        self.assertEqual((body["status"], body["resolution"]), ("confirmed", "other"))
        self.assertEqual(body["final_generic"], {"id": milk.pk, "name": "Молоко", "base_unit": "l"})
        self.assertEqual(body["product"]["generic"]["id"], milk.pk)
        self.assertEqual(body["suggested"]["generic"], {
            "id": cheese.pk, "name": "Сыр", "base_unit": "kg", "exists": False, "is_new": False,
        })
        self.assertEqual(generic_of(CHEESE), "Молоко")
        self.assertNotIn("Сыр", listed())
        self.assertTrue(
            ClassificationRejection.objects.filter(product_id=entry.product_ref, generic_name="Сыр").exists()
        )
        saved = snapshot()
        self.assertEqual(self.ok(self.confirm(entry, version=5, generic_id=milk.pk)), body)
        self.error(self.confirm(entry, version=2), 409, "classification_resolved")  # предложенный уже не итог
        self.assertEqual(snapshot(), saved)

    def test_reject_returns_the_product_and_removes_what_became_empty(self):
        first, second = record(SAUSAGE_A), record(SAUSAGE_B)
        category_id = generic("Колбаса").category_id
        body = self.ok(self.reject(first))
        self.assertEqual((body["status"], body["resolution"], body["version"]), ("rejected", "rejected", 2))
        self.assertEqual(body["product"]["generic"]["name"], "Не разобрано")
        self.assertEqual(body["final_generic"]["name"], "Не разобрано")
        # Второй товар ещё ждёт в «Колбаса»: обобщённый продукт остаётся.
        self.assertEqual((body["suggested"]["generic"]["exists"], body["suggested"]["pending_count"]), (True, 1))
        self.assertEqual(generic_of(SAUSAGE_A), "Не разобрано")
        self.ok(self.reject(second))
        self.assertFalse(GenericProduct.objects.filter(name="Колбаса").exists())
        self.assertFalse(Category.objects.filter(pk=category_id).exists())
        self.assertEqual(self.client.get(f"/api/categories/{category_id}/").status_code, 404)
        saved = snapshot()
        repeated = self.ok(self.reject(first, version=40))
        self.assertEqual((repeated["id"], repeated["status"], repeated["version"]), (first.pk, "rejected", 2))
        self.error(self.confirm(first, version=2), 409, "classification_resolved")
        self.assertEqual(snapshot(), saved)
        # Отклонённое не предлагается снова: повторный запуск оставляет товары без категории.
        suggest()
        self.assertEqual((generic_of(SAUSAGE_A), generic_of(SAUSAGE_B)), ("Не разобрано", "Не разобрано"))

    def test_stale_version_changes_nothing(self):
        entry = record(MILK)
        before = snapshot()
        self.error(self.confirm(entry, version=2), 409, "classification_changed")
        self.error(self.confirm(entry, version=2, generic_id=generic("Кефир").pk), 409, "classification_changed")
        self.error(self.reject(entry, version=2), 409, "classification_changed")
        self.error(self.confirm_many((entry.pk, 2)), 409, "classification_changed",
                   {"items.0": ["Предположение изменилось."]})
        self.assertEqual(snapshot(), before)
        self.ok(self.confirm(entry))

    def test_generic_parameter(self):
        entry = record(MILK)
        before = snapshot()
        self.error(self.confirm(entry, generic_id=999999), 400, "invalid_parameter",
                   {"generic_id": ["Обобщённый продукт не найден."]})
        self.error(self.confirm(entry, generic_id=service().pk), 400, "invalid_parameter",
                   {"generic_id": ["Нельзя выбрать «Не разобрано»."]})
        self.assertEqual(snapshot(), before)

    def test_order_of_checks(self):
        entry = record(MILK)
        body = {"version": 99, "generic_id": 999999}
        # Запись существует → состояние → версия → параметр.
        self.error(self.post(BASE + "999999/confirm/", body), 404, "not_found")
        self.error(self.post(self.url(entry, "confirm/"), body), 409, "classification_changed")
        self.ok(self.reject(entry))
        self.error(self.post(self.url(entry, "confirm/"), body), 409, "classification_resolved")
        self.assertEqual(self.ok(self.reject(entry, version=99))["status"], "rejected")  # повтор раньше версии

    def test_reconciliation_outcome_is_saved_before_the_refusal(self):
        juice, kefir = record(JUICE), record(KEFIR_A)
        Product.objects.filter(pk=juice.product_ref).update(generic=generic("Молоко"))
        self.error(self.confirm(juice), 409, "classification_resolved")
        body = self.ok(self.client.get(self.url(juice)))
        self.assertEqual((body["status"], body["resolution"], body["version"]), ("superseded", "changed", 2))
        self.assertEqual(body["final_generic"]["name"], "Молоко")
        self.assertEqual(generic_of(JUICE), "Молоко")  # значение человека осталось
        self.assertFalse(GenericProduct.objects.filter(name="Сок").exists())
        # Живое название изменили: снимок обновлён, версия выросла, клиент перечитывает и повторяет.
        GenericProduct.objects.filter(name="Кефир").update(name="Кефир и айран")
        self.error(self.confirm(kefir), 409, "classification_changed")
        fresh = self.ok(self.client.get(self.url(kefir)))
        self.assertEqual((fresh["status"], fresh["version"], fresh["suggested"]["generic"]["name"]),
                         ("pending", 2, "Кефир и айран"))
        self.assertEqual(self.ok(self.confirm(kefir, version=2))["status"], "confirmed")

    def test_confirm_many(self):
        first, second = record(KEFIR_A), record(KEFIR_B)
        body = self.ok(self.confirm_many((second.pk, 1), (first.pk, 1)))
        self.assertEqual(body["confirmed"], 2)
        self.assertEqual([item["id"] for item in body["results"]], sorted((first.pk, second.pk)))
        self.assertEqual({item["status"] for item in body["results"]}, {"confirmed"})
        self.assertEqual({item["suggested"]["generic"]["is_new"] for item in body["results"]}, {False})
        self.assertTrue(all(set(item) == RECORD_KEYS for item in body["results"]))
        saved = snapshot()
        self.assertEqual(self.ok(self.confirm_many((first.pk, 1), (second.pk, 9))), body)
        self.assertEqual(snapshot(), saved)
        # Часть уже подтверждена так же, остальные ожидают с верной версией.
        milk = record(MILK)
        mixed = self.ok(self.confirm_many((first.pk, 1), (milk.pk, 1)))
        self.assertEqual((mixed["confirmed"], {item["status"] for item in mixed["results"]}), (2, {"confirmed"}))

    def test_confirm_many_is_all_or_nothing(self):
        first, second, juice, cheese = record(KEFIR_A), record(KEFIR_B), record(JUICE), record(CHEESE)
        self.ok(self.reject(juice))
        self.ok(self.confirm(cheese, generic_id=generic("Молоко").pk))
        before = snapshot()
        self.error(self.confirm_many((first.pk, 1), (999999, 1)), 404, "not_found")
        self.error(self.confirm_many((first.pk, 1), (juice.pk, 2), (second.pk, 1)), 409, "classification_resolved",
                   {"items.1": ["Предположение уже решено."]})
        # Подтверждена другим значением — не повтор.
        self.error(self.confirm_many((cheese.pk, 2)), 409, "classification_resolved",
                   {"items.0": ["Предположение уже решено."]})
        self.error(self.confirm_many((first.pk, 3), (second.pk, 1)), 409, "classification_changed",
                   {"items.0": ["Предположение изменилось."]})
        # Решённая запись задаёт код, поля называют обе.
        self.error(self.confirm_many((first.pk, 3), (juice.pk, 2)), 409, "classification_resolved",
                   {"items.0": ["Предположение изменилось."], "items.1": ["Предположение уже решено."]})
        self.assertEqual(snapshot(), before)
        self.assertEqual((record(KEFIR_A).status, record(KEFIR_B).status), ("pending", "pending"))

    def test_runs_are_queued_once(self):
        self.assertFalse(ClassificationRun.objects.filter(status="queued").exists())
        created = self.ok(self.post(BASE + "runs/"), 202)
        self.assertEqual(set(created), {"created", "run", "executor"})
        self.assertIs(created["created"], True)
        self.assertEqual((created["run"]["status"], created["run"]["trigger"], created["run"]["scope"]),
                         ("queued", "manual", "all"))
        self.assertEqual(created["run"]["progress"],
                         {"requested": 1, "processed": 0, "applied": 0, "unknown": 0, "skipped": 0})
        self.assertEqual(created["executor"], {"available": False, "state": "absent", "last_seen_at": None})
        saved = snapshot()
        repeated = self.ok(self.post(BASE + "runs/"))
        self.assertEqual(repeated, {**created, "created": False})
        self.assertEqual(snapshot(), saved)
        self.assertEqual(ClassificationRun.objects.filter(status="queued").count(), 1)
        # Модель не вызывалась: товар по-прежнему без категории.
        self.assertEqual(generic_of(UNKNOWN), "Не разобрано")

    def test_run_with_nothing_to_suggest(self):
        Product.objects.filter(name=UNKNOWN).update(generic=generic("Молоко"))
        runs = ClassificationRun.objects.count()
        self.assertEqual(self.ok(self.post(BASE + "runs/")), {
            "created": False, "run": None, "executor": {"available": False, "state": "absent", "last_seen_at": None},
        })
        self.assertEqual(ClassificationRun.objects.count(), runs)
        # Залог и товар с содержательным обобщённым продуктом в запуск не попадают.
        add_product("Demo Neuer Artikel")
        run = self.ok(self.post(BASE + "runs/"), 202)["run"]
        self.assertEqual(run["progress"]["requested"], 1)
        self.assertEqual(ClassificationRun.objects.get(pk=run["id"]).product_ids, [product("Demo Neuer Artikel").pk])
        self.assertEqual((generic_of(DEPOSIT), generic_of(EXAMPLE)), ("Не разобрано", "Молоко"))

    def test_failure_in_the_middle_changes_nothing(self):
        entry = record(SAUSAGE_A)
        before = snapshot()
        self.client.raise_request_exception = False
        with patch.object(services, "_cleanup", side_effect=RuntimeError("secret")):
            response = self.reject(entry)
        self.assertEqual(response.status_code, 500)
        self.assertNotIn("secret", response.content.decode("utf-8"))
        self.assertEqual(snapshot(), before)


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class BusyTests(ClassificationApiMixin, ConcurrencyTestCase):
    """Занятый каталог: настоящие блокировки в другом соединении, отказ без изменений."""

    def setUp(self):
        super().setUp()
        self.client = local_client()

    def calls(self):
        milk, juice = record(MILK), record(JUICE)
        return {
            "confirm": lambda: self.confirm(milk),
            "choose another": lambda: self.confirm(juice, generic_id=generic("Молоко").pk),
            "reject": lambda: self.reject(juice),
            "confirm many": lambda: self.confirm_many((milk.pk, 1), (juice.pk, 1)),
            "runs": lambda: self.post(BASE + "runs/"),
        }

    def test_import_mutex_held_elsewhere_is_classification_busy(self):
        before = snapshot()
        with self.hold(import_lock):
            for name, call in self.calls().items():
                with self.subTest(call=name):
                    error = self.error(call(), 409, "classification_busy")
                    self.assertEqual(error["message"], "Каталог сейчас изменяется. Повторите позже.")
            # Чтение блокировку не берёт.
            self.ok(self.client.get(BASE))
            self.ok(self.client.get(BASE + "status/"))
        self.assertEqual(snapshot(), before)
        # Скрытого повтора не было: те же запросы теперь проходят.
        self.assertEqual(self.ok(self.calls()["confirm"]())["status"], "confirmed")
        self.assertEqual(self.ok(self.calls()["reject"]())["status"], "rejected")
        self.ok(self.calls()["runs"](), 202)

    def test_category_tree_held_elsewhere_is_classification_busy(self):
        juice = record(JUICE)
        before = snapshot()
        with self.hold(tree_lock):
            # Отклонение «Сок» удалило бы созданную корневую категорию «Напитки».
            self.error(self.reject(juice), 409, "classification_busy")
            self.error(self.confirm(juice, generic_id=generic("Молоко").pk), 409, "classification_busy")
            # Подтверждение категорий не создаёт и не удаляет: блокировка дерева ему не нужна.
            self.assertEqual(self.ok(self.confirm(record(MILK)))["status"], "confirmed")
        self.assertEqual(ProductClassification.objects.get(pk=juice.pk).status, "pending")
        self.assertEqual({key: value for key, value in snapshot().items() if key == "Category"},
                         {key: value for key, value in before.items() if key == "Category"})
        self.assertEqual(self.ok(self.reject(juice))["status"], "rejected")


def outline(body):
    """Форма ответа без значений: ключи верхнего уровня и ключи элементов страницы.

    Глубже не сравнивается намеренно: вложенные списки (цены товара, группы сравнения)
    бывают пустыми, а у сравнения часть ключей зависит от сравнимости цены.
    """
    items = body.get("results") if isinstance(body, dict) else None
    return sorted(body), sorted(set().union(*map(set, items))) if items else None


@tag("integration")
class OldReadApiTests(TestCase):
    """Старые GET каталога и цен: меняется только состав, форма, доступ, коды и число запросов прежние."""

    @classmethod
    def setUpTestData(cls):
        demo.seed_demo()

    def setUp(self):
        self.client = APIClient()  # аноним, локальный API выключен
        self.milk, self.kefir = product(MILK), product(KEFIR_A)
        self.service = service()
        self.dairy = Category.objects.get(name="Молочные продукты")

    def urls(self):
        return [
            "/api/countries/", "/api/stores/", "/api/brands/", "/api/categories/",
            f"/api/categories/{self.service.category_id}/", f"/api/categories/{self.dairy.pk}/",
            "/api/generic-products/", f"/api/generic-products/{self.service.pk}/",
            f"/api/generic-products/{self.service.pk}/comparison/", "/api/products/",
            f"/api/products/?generic={self.service.pk}", f"/api/products/?category={self.dairy.pk}",
            f"/api/products/{self.kefir.pk}/", f"/api/products/{self.kefir.pk}/prices/",
            f"/api/products/{self.kefir.pk}/prices/summary/", f"/api/products/{self.kefir.pk}/alternatives/",
            f"/api/products/{self.kefir.pk}/alternatives/?scope=category",
        ]

    def read(self):
        """``{url: (код, тело, число SQL-запросов)}``."""
        result = {}
        for url in self.urls():
            with CaptureQueriesContext(connection) as queries:
                response = self.client.get(url)
            result[url] = (response.status_code, response.json(), len(queries))
        return result

    def names(self, url):
        return {item["name"] for item in self.client.get(url).json()["results"]}

    def test_only_the_composition_changes_after_apply_and_returns_after_reject(self):
        before = self.read()
        self.assertEqual({code for code, _, _ in before.values()}, {200})
        self.assertEqual(before[f"/api/products/{self.kefir.pk}/"][1]["generic"]["name"], "Не разобрано")
        self.assertNotIn("Кефир", self.names("/api/generic-products/"))

        suggest()
        applied = self.read()
        kefir = generic("Кефир")
        for url in self.urls():
            with self.subTest(url=url):
                self.assertEqual(applied[url][0], 200)
                top, items = outline(applied[url][1])
                self.assertEqual(top, outline(before[url][1])[0])  # формат
                if items and outline(before[url][1])[1] and "alternatives" not in url and "comparison" not in url:
                    self.assertEqual(items, outline(before[url][1])[1])
                if "alternatives" in url:
                    # Прежний код сравнения читает последние цены ещё раз, когда у предложений есть
                    # сравнимая цена: «Кефир» (l) сравним, «Не разобрано» (pcs) — нет. От размера
                    # страницы число запросов по-прежнему не зависит.
                    self.assertEqual(applied[url][2], before[url][2] + 1)
                    with self.assertNumQueries(applied[url][2]):
                        self.client.get(url + ("&" if "?" in url else "?") + "page_size=1")
                else:
                    self.assertEqual(applied[url][2], before[url][2])  # число SQL-запросов
        card = applied[f"/api/products/{self.kefir.pk}/"][1]
        self.assertEqual(card["generic"], {"id": kefir.pk, "name": "Кефир", "base_unit": "l"})
        self.assertEqual(card["category"]["name"], "Молочные продукты")
        self.assertEqual(card["alternatives_count"], 1)  # второй кефир, а не все товары «Не разобрано»
        self.assertLess(card["alternatives_count"], before[f"/api/products/{self.kefir.pk}/"][1]["alternatives_count"])
        self.assertEqual(applied[f"/api/products/{self.kefir.pk}/prices/"][1]["product"]["base_unit"], "l")
        self.assertEqual(applied["/api/products/"][1]["count"], before["/api/products/"][1]["count"])
        service_products = f"/api/products/?generic={self.service.pk}"
        self.assertLess(applied[service_products][1]["count"], before[service_products][1]["count"])
        self.assertNotIn(KEFIR_A, {item["name"] for item in applied[service_products][1]["results"]})
        self.assertEqual(self.names(f"/api/products/?generic={kefir.pk}"), {KEFIR_A, KEFIR_B})
        self.assertIn(KEFIR_A, self.names(f"/api/products/?category={self.dairy.pk}"))
        self.assertTrue({"Кефир", "Сыр", "Колбаса", "Хлеб", "Сок"} <= self.names("/api/generic-products/"))
        categories = {item["name"] for item in applied["/api/categories/"][1]["results"]}
        self.assertTrue({"Мясные продукты", "Хлеб и выпечка", "Напитки", "Бытовая химия"} <= categories)
        self.assertEqual(self.client.get(f"/api/generic-products/{kefir.pk}/").status_code, 200)
        alternatives = applied[f"/api/products/{self.kefir.pk}/alternatives/"][1]
        self.assertEqual(alternatives["generic"]["name"], "Кефир")
        self.assertEqual({item["product"]["name"] for item in alternatives["results"]}, {KEFIR_A, KEFIR_B})
        # Подтверждение состава не меняет.
        services.confirm(record(MILK).pk, version=1, generic_id=generic("Молоко").pk)
        confirmed = self.read()
        self.assertEqual({url: body for url, (_, body, _) in confirmed.items()},
                         {url: body for url, (_, body, _) in applied.items()})

        created = [generic(name).pk for name in ("Кефир", "Сыр", "Колбаса", "Хлеб", "Сок")]
        created_category = Category.objects.get(name="Мясные продукты").pk
        for entry in ProductClassification.objects.filter(status="pending").order_by("pk"):
            services.reject(entry.pk, version=entry.version)
        # Подтверждённое «Молоко» остаётся у товара; для сравнения с исходным видом возвращаем его вручную.
        Product.objects.filter(pk=self.milk.pk).update(generic=self.service)
        after = self.read()
        for url in self.urls():
            with self.subTest(url=url, stage="rejected"):
                self.assertEqual(after[url], before[url])
        for pk in created:
            self.assertEqual(self.client.get(f"/api/generic-products/{pk}/").status_code, 404)
            self.assertEqual(self.client.get(f"/api/generic-products/{pk}/comparison/").status_code, 404)
        missing = self.client.get(f"/api/categories/{created_category}/")
        self.assertEqual((missing.status_code, missing.json()["error"]["code"]), (404, "not_found"))

    def test_old_api_stays_anonymous_and_read_only(self):
        suggest()
        with override_settings(DEBUG=False, ALLOW_LOCAL_RECOGNITION_API=False):
            for url in self.urls():
                with self.subTest(url=url):
                    self.assertEqual(self.client.get(url, REMOTE_ADDR="192.0.2.10").status_code, 200)
                    self.assertEqual(self.client.post(url, {}, format="json").status_code, 405)
            # Новый API при этом закрыт.
            self.assertEqual(self.client.get(BASE).status_code, 403)
