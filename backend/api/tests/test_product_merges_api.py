"""HTTP API слияния дублей: доступ, тело, чтение, операции и таблица повторов и ошибок."""
import json
import time
from unittest.mock import patch

from django.db import OperationalError
from django.test import TestCase, override_settings, tag
from rest_framework.test import APIClient

from api.tests.merge_factories import demo_groups, local_client, pending_group, product
from catalog.models import Brand, Product
from merges import demo, services
from merges.models import ProductMerge, ProductMergeRejection
from merges.tests.factories import EGGS, MAULTASCHEN, MILK, PIZZA, ZIMBO, add_line, add_product, snapshot
from merges.tests.test_concurrency import ConcurrencyTestCase
from receipts.models import ProductAlias, ReceiptLine
from recognition.importer import IMPORT_LOCK
from stores.models import Store

BASE = "/api/product-merges/"
GROUP_KEYS = {
    "id", "status", "version", "created_at", "resolved_at", "target_product_id", "members", "conflicts",
    "lines_count", "new_lines_count", "actions",
}
MEMBER_KEYS = {
    "product_id", "role", "state", "exists", "name", "brand", "model", "gtin", "package", "generic", "classified",
    "lines_count", "first_purchased_on", "last_purchased_on", "aliases",
}
LINE_KEYS = {
    "line_id", "receipt_id", "position", "purchased_on", "store", "name", "quantity", "unit", "unit_price",
    "amount", "discount_amount", "currency", "origin_product_id",
}


class MergeApiMixin:
    def error(self, response, status, code, fields=None):
        self.assertEqual(response.status_code, status, response.content)
        body = response.json()
        self.assertEqual(set(body), {"error"})
        self.assertEqual(body["error"]["code"], code)
        self.assertEqual(set(body["error"]) - {"fields"}, {"code", "message"})
        if fields is None:
            self.assertNotIn("fields", body["error"])
        else:
            self.assertEqual(set(body["error"]["fields"]), set(fields))
            for messages in body["error"]["fields"].values():
                self.assertTrue(messages and all(isinstance(message, str) for message in messages))
        self.assertEqual(response["Cache-Control"], "no-store")
        return body["error"]

    def ok(self, response):
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        return response.json()

    def post(self, path, body=None):
        return self.client.post(path, {} if body is None else body, format="json")

    def raw(self, path, data, content_type="application/json"):
        return self.client.post(path, data, content_type=content_type)

    def url(self, group, action=""):
        return f"{BASE}{group.pk}/{action}"

    def confirm(self, group, **body):
        body.setdefault("version", group.version)
        body.setdefault("target_product_id", group.target_ref)
        return self.post(self.url(group, "confirm/"), body)


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class AccessAndBodyTests(MergeApiMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        demo_groups()
        cls.group = pending_group(PIZZA[0])

    def setUp(self):
        self.client = local_client()

    def paths(self):
        return (
            ("get", BASE), ("get", self.url(self.group)), ("get", self.url(self.group, "lines/")),
            ("post", BASE + "detect/"), ("post", self.url(self.group, "confirm/")),
            ("post", self.url(self.group, "cancel/")), ("post", self.url(self.group, "exclude/")),
        )

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
                with self.subTest(overrides=overrides, extra=extra, path=path), override_settings(**overrides), \
                        self.assertNumQueries(0):
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
            for method, path in self.paths():
                if method != "post":
                    continue
                with self.subTest(client=name, path=path), self.assertNumQueries(0):
                    self.error(client.post(path, {}, format="json"), 403, "csrf_failed")
        # Чтение токена не требует.
        self.ok(without_token.get(BASE))
        self.assertEqual(snapshot(), before)

    def test_methods_and_unknown_paths(self):
        for method, path in self.paths():
            other = "post" if method == "get" else "get"
            with self.subTest(path=path, method=other):
                response = getattr(self.client, other)(path, **({"format": "json"} if other == "post" else {}))
                self.error(response, 405, "method_not_allowed")
        for path in (BASE + "0/", BASE + "9" * 20 + "/", BASE + "abc/", self.url(self.group, "merge/"),
                     BASE + "detect/extra/", BASE + "0/cancel/"):
            with self.subTest(path=path):
                self.error(self.client.get(path), 404, "not_found")
                self.error(self.post(path), 404, "not_found")
        # Число из 19 цифр больше BigAutoField: тот же 404, без запроса.
        with self.assertNumQueries(0):
            self.error(self.client.get(BASE + "9223372036854775808/"), 404, "not_found")
            self.error(self.client.get(BASE + "9223372036854775808/lines/"), 404, "not_found")
            self.error(self.post(BASE + "9223372036854775808/cancel/"), 404, "not_found")

    def test_body_structure_is_invalid_request(self):
        before = snapshot()
        confirm, cancel, exclude = (self.url(self.group, action) for action in ("confirm/", "cancel/", "exclude/"))
        valid = {"version": 1, "target_product_id": self.group.target_ref}
        cases = (
            (cancel, b""), (cancel, b"[]"), (cancel, b"null"), (cancel, b'{"extra": 1}'), (cancel, b"{"),
            (cancel, b"\xff\xfe"), (cancel, b'{"a": NaN}'), (cancel, b"{}" + b" " * 4095),
            (BASE + "detect/", b'{"dry_run": true}'), (BASE + "detect/", b""),
            (confirm, json.dumps({**valid, "unknown": 1}).encode()),
            (confirm, b'{"version": 1, "version": 1, "target_product_id": 1}'),
            (confirm, json.dumps({**valid, "resolutions": {"x": "y" * 4096}}).encode()),
            (exclude, b'{"version": 1, "product_id": 1, "target_product_id": 1}'),
        )
        for path, data in cases:
            with self.subTest(path=path, data=data[:40]), self.assertNumQueries(0):
                self.error(self.raw(path, data), 400, "invalid_request")
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"):
            with self.subTest(content_type=content_type), self.assertNumQueries(0):
                self.error(self.raw(cancel, b"{}", content_type), 415, "unsupported_media_type")
        self.assertEqual(snapshot(), before)

    def test_body_at_the_size_limit_is_accepted(self):
        response = self.raw(BASE + "detect/", b"{}" + b" " * 4094)
        self.assertEqual(self.ok(response), {"created": 0, "extended": 0, "group_ids": []})

    def test_value_types_are_invalid_parameter(self):
        before = snapshot()
        confirm, exclude = self.url(self.group, "confirm/"), self.url(self.group, "exclude/")
        target = self.group.target_ref
        cases = (
            (confirm, {}, {"version", "target_product_id"}),
            (confirm, {"version": 1}, {"target_product_id"}),
            (confirm, {"version": "1", "target_product_id": target}, {"version"}),
            (confirm, {"version": True, "target_product_id": 1.5}, {"version", "target_product_id"}),
            (confirm, {"version": 0, "target_product_id": -1}, {"version", "target_product_id"}),
            (confirm, {"version": 1, "target_product_id": 2 ** 63}, {"target_product_id"}),
            (confirm, {"version": 1, "target_product_id": target, "name_product_id": None}, {"name_product_id"}),
            (confirm, {"version": 1, "target_product_id": target, "name_product_id": "5"}, {"name_product_id"}),
            (confirm, {"version": 1, "target_product_id": target, "resolutions": []}, {"resolutions"}),
            (confirm, {"version": 1, "target_product_id": target, "resolutions": {"generic": "2"}},
             {"resolutions.generic"}),
            (confirm, {"version": 1, "target_product_id": target, "resolutions": {"name": target}},
             {"resolutions.name"}),
            (exclude, {}, {"version", "product_id"}),
            (exclude, {"version": 1, "product_id": None}, {"product_id"}),
            (exclude, {"version": [1], "product_id": {}}, {"version", "product_id"}),
        )
        for path, body, fields in cases:
            with self.subTest(path=path, body=body), self.assertNumQueries(0):
                self.error(self.post(path, body), 400, "invalid_parameter", fields)
        self.assertEqual(snapshot(), before)

    def test_query_parameters(self):
        for query, fields in (("status=open", {"status"}), ("product=0", {"product"}), ("product=abc", {"product"}),
                              ("page=0", {"page"}), ("page_size=201", {"page_size"})):
            with self.subTest(query=query), self.assertNumQueries(0):
                self.error(self.client.get(f"{BASE}?{query}"), 400, "invalid_parameter", fields)
        self.error(self.client.get(self.url(self.group, "lines/") + "?page_size=201"), 400, "invalid_parameter",
                   {"page_size"})
        self.error(self.client.get(BASE + "?page=2"), 404, "page_out_of_range")
        self.error(self.client.get(self.url(self.group, "lines/") + "?page=2"), 404, "page_out_of_range")

    def test_other_database_failure_is_503(self):
        with patch.object(services, "cancel", side_effect=OperationalError("PRIVATE DETAIL")):
            response = self.post(self.url(self.group, "cancel/"))
        self.error(response, 503, "database_unavailable")
        self.assertNotIn("PRIVATE", response.content.decode())
        with patch.object(services, "groups", side_effect=OperationalError("PRIVATE DETAIL")):
            self.error(self.client.get(BASE), 503, "database_unavailable")


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class ReadTests(MergeApiMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        demo_groups()

    def setUp(self):
        self.client = local_client()

    def test_list_is_brief_newest_first_and_filtered(self):
        body = self.ok(self.client.get(BASE))
        self.assertEqual((body["count"], body["page"], body["page_size"], body["pages"]), (7, 1, 50, 1))
        ids = [group["id"] for group in body["results"]]
        self.assertEqual(ids, sorted(ids, reverse=True))
        for group in body["results"]:
            self.assertEqual(set(group), GROUP_KEYS - {"conflicts"} | {"has_conflicts"})
            for member in group["members"]:
                self.assertEqual(set(member), MEMBER_KEYS - {"aliases"})
        milk = pending_group(MILK[0])
        self.assertEqual({group["id"] for group in body["results"] if group["has_conflicts"]}, {milk.pk})

        services.cancel(pending_group(EGGS[0]).pk)
        services.confirm(pending_group(ZIMBO[0]).pk, version=1, target_product_id=product(ZIMBO[0]).pk)
        counts = {
            status: self.ok(self.client.get(f"{BASE}?status={status}"))["count"]
            for status in ("pending", "confirmed", "cancelled")
        }
        self.assertEqual(counts, {"pending": 5, "confirmed": 1, "cancelled": 1})
        paged = self.ok(self.client.get(f"{BASE}?page_size=3&page=3"))
        self.assertEqual((paged["count"], paged["pages"], len(paged["results"])), (7, 3, 1))

    def test_product_filter_finds_a_group_by_any_member(self):
        pizza = pending_group(PIZZA[0])
        for name in PIZZA:
            with self.subTest(name=name):
                body = self.ok(self.client.get(f"{BASE}?product={product(name).pk}"))
                self.assertEqual([group["id"] for group in body["results"]], [pizza.pk])
        self.assertEqual(self.ok(self.client.get(f"{BASE}?product={product('Pizza Hot Dog').pk}"))["count"], 0)
        # После подтверждения удалённый id по-прежнему находит группу и оставляемый товар.
        absorbed = product(PIZZA[1]).pk
        services.confirm(pizza.pk, version=1, target_product_id=pizza.target_ref)
        body = self.ok(self.client.get(f"{BASE}?product={absorbed}&status=confirmed"))
        self.assertEqual(
            [(group["id"], group["status"], group["target_product_id"]) for group in body["results"]],
            [(pizza.pk, "confirmed", pizza.target_ref)],
        )
        member = next(item for item in body["results"][0]["members"] if item["product_id"] == absorbed)
        self.assertEqual((member["exists"], member["name"]), (False, PIZZA[1]))

    def test_group_shows_original_ownership(self):
        group = pending_group(PIZZA[0])
        body = self.ok(self.client.get(self.url(group)))
        self.assertEqual(set(body), GROUP_KEYS)
        self.assertEqual((body["status"], body["version"], body["resolved_at"]), ("pending", 1, None))
        self.assertEqual(body["target_product_id"], product(PIZZA[0]).pk)
        self.assertEqual([member["product_id"] for member in body["members"]], sorted(product(n).pk for n in PIZZA))
        by_name = {member["name"]: member for member in body["members"]}
        self.assertEqual(set(by_name), set(PIZZA))
        for member in body["members"]:
            self.assertEqual(set(member), MEMBER_KEYS)
            self.assertEqual(
                member["aliases"],
                [{"store_name": "Demomarkt", "raw_name": member["name"], "store_item_code": ""}],
            )
            self.assertEqual((member["exists"], member["state"], member["classified"]), (True, "active", False))
        self.assertEqual({name: member["role"] for name, member in by_name.items()},
                         {PIZZA[0]: "target", PIZZA[1]: "source", PIZZA[2]: "source"})
        self.assertEqual({name: member["lines_count"] for name, member in by_name.items()},
                         {PIZZA[0]: 1, PIZZA[1]: 1, PIZZA[2]: 2})
        self.assertEqual((by_name[PIZZA[2]]["first_purchased_on"], by_name[PIZZA[2]]["last_purchased_on"]),
                         ("2026-06-09", "2026-07-06"))
        self.assertEqual((body["lines_count"], body["new_lines_count"], body["conflicts"]), (4, 0, []))
        self.assertEqual(body["actions"], {"can_confirm": True, "can_cancel": True, "can_exclude": True})

    def test_conflicts_are_read_from_live_data(self):
        group = pending_group(MILK[0])
        ids = sorted(product(name).pk for name in ("GQ EgSB H-Milch 1,5%", "GO EgSB H-Milch 1,5%"))
        self.assertEqual(self.ok(self.client.get(self.url(group)))["conflicts"],
                         [{"field": "generic", "product_ids": ids}])
        Product.objects.filter(pk=product("GO EgSB H-Milch 1,5%").pk).update(generic=product(MILK[0]).generic)
        self.assertEqual(self.ok(self.client.get(self.url(group)))["conflicts"], [])

    def test_lines_hide_private_fields_and_mark_new_purchases(self):
        group = pending_group(PIZZA[0])
        target = product(PIZZA[0])
        ReceiptLine.objects.filter(product=target).update(extra={"raw_text": "PRIVATE LINE"})
        for line in ReceiptLine.objects.filter(product=target).select_related("receipt"):
            receipt = line.receipt
            receipt.raw_text, receipt.fiscal, receipt.shift_number = "PRIVATE TEXT", {"k": "PRIVATE FISCAL"}, "PRIVATE"
            receipt.save(update_fields=["raw_text", "fiscal", "shift_number"])
        late = add_line(target, PIZZA[0])
        response = self.client.get(self.url(group, "lines/"))
        body = self.ok(response)
        for private in ("PRIVATE", "DEMO-MERGE", "DEMOMERGE", "вымышленный", "TEST-MERGE"):
            self.assertNotIn(private, response.content.decode("utf-8"))
        self.assertEqual((body["count"], body["page_size"], body["pages"]), (5, 50, 1))
        for line in body["results"]:
            self.assertEqual(set(line), LINE_KEYS)
            self.assertEqual(set(line["store"]), {"id", "name", "city", "country"})
            self.assertEqual((line["store"]["name"], line["currency"]), ("Demomarkt", "EUR"))
        keys = [(line["purchased_on"], line["receipt_id"], line["position"]) for line in body["results"]]
        self.assertEqual(keys, sorted(keys))
        self.assertEqual([line["purchased_on"] for line in body["results"]],
                         ["2026-06-09", "2026-06-29", "2026-07-06", "2026-10-01", "2026-11-02"])
        origin = {line["line_id"]: line["origin_product_id"] for line in body["results"]}
        self.assertIsNone(origin.pop(late.pk))
        names = {line["line_id"]: line["name"] for line in body["results"]}
        for line_id, product_id in origin.items():
            self.assertEqual(Product.objects.get(pk=product_id).name, names[line_id])
        last = body["results"][3]
        self.assertEqual(
            {key: last[key] for key in ("quantity", "unit", "unit_price", "amount", "discount_amount")},
            {"quantity": "1.000", "unit": "pcs", "unit_price": "3.4900", "amount": "3.49", "discount_amount": "0.00"},
        )
        self.assertEqual(self.ok(self.client.get(self.url(group)))["new_lines_count"], 1)
        paged = self.ok(self.client.get(self.url(group, "lines/") + "?page_size=2&page=3"))
        self.assertEqual([line["line_id"] for line in paged["results"]], [late.pk])

    def test_lines_of_resolved_groups(self):
        pizza, eggs = pending_group(PIZZA[0]), pending_group(EGGS[0])
        services.confirm(pizza.pk, version=1, target_product_id=pizza.target_ref)
        services.cancel(eggs.pk)
        self.assertEqual(self.ok(self.client.get(self.url(pizza, "lines/")))["count"], 4)
        self.assertEqual(self.ok(self.client.get(self.url(eggs, "lines/"))),
                         {"count": 0, "page": 1, "page_size": 50, "pages": 0, "results": []})

    def test_receipts_api_shows_the_surviving_product(self):
        target, absorbed = product(PIZZA[0]), product(PIZZA[2])
        line = ReceiptLine.objects.filter(raw_name=PIZZA[2]).order_by("pk").first()
        body = self.ok(self.client.get(f"/api/receipts/{line.receipt_id}/lines/"))
        row = next(item for item in body["results"] if item["id"] == line.pk)
        self.assertEqual((row["name"], row["product"]), (PIZZA[2], {"id": target.pk, "name": PIZZA[0]}))
        self.assertEqual((row["position"], row["amount"]), (line.position, "3.49"))
        self.assertEqual(self.ok(self.client.get(f"/api/receipts/?product={absorbed.pk}"))["count"], 0)
        self.assertEqual(self.ok(self.client.get(f"/api/receipts/?product={target.pk}"))["count"], 4)

    def test_not_found(self):
        missing = ProductMerge.objects.order_by("-pk").first().pk + 100
        for path in (f"{BASE}{missing}/", f"{BASE}{missing}/lines/"):
            with self.subTest(path=path), self.assertNumQueries(1):
                self.error(self.client.get(path), 404, "not_found")
        for action, body in (("confirm/", {"version": 1, "target_product_id": 1}), ("cancel/", {}),
                             ("exclude/", {"version": 1, "product_id": 1})):
            with self.subTest(action=action):
                self.error(self.post(f"{BASE}{missing}/{action}", body), 404, "not_found")

    def test_query_counts_do_not_depend_on_the_number_of_groups(self):
        group = pending_group(MILK[0])
        with self.assertNumQueries(7):  # COUNT, страница, 5 запросов описания на всю страницу
            self.assertEqual(len(self.ok(self.client.get(BASE))["results"]), 7)
        with self.assertNumQueries(7):
            self.assertEqual(len(self.ok(self.client.get(BASE + "?page_size=1"))["results"]), 1)
        with self.assertNumQueries(2):  # пустая страница: COUNT и страница, описание не читается
            self.assertEqual(self.ok(self.client.get(BASE + "?status=cancelled"))["results"], [])
        with self.assertNumQueries(7):  # группа и 6 запросов описания
            self.ok(self.client.get(self.url(group)))
        with self.assertNumQueries(3):  # группа, COUNT, страница со связями чека
            self.ok(self.client.get(self.url(group, "lines/")))

    def test_merchant_without_a_sign_is_named_by_its_store(self):
        store = Store.objects.get(merchant__tax_id=demo.MERCHANTS[demo.MAIN]["tax_id"])
        store.merchant.brand_name = ""
        store.merchant.save(update_fields=["brand_name"])
        Store.objects.filter(pk=store.pk).update(name="Demo Filiale")
        group = pending_group(PIZZA[0])
        with self.assertNumQueries(8):  # ещё магазины продавцов без вывески — один запрос на группу
            body = self.ok(self.client.get(self.url(group)))
        self.assertEqual({alias["store_name"] for member in body["members"] for alias in member["aliases"]},
                         {"Demo Filiale"})
        self.assertNotIn("вымышленный", json.dumps(body, ensure_ascii=False))


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class OperationTests(MergeApiMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        demo_groups()

    def setUp(self):
        self.client = local_client()

    def test_detect_repeats_without_writes_and_extends(self):
        before = snapshot()
        self.assertEqual(self.ok(self.post(BASE + "detect/")), {"created": 0, "extended": 0, "group_ids": []})
        self.assertEqual(snapshot(), before)
        group = pending_group(PIZZA[0])
        added = add_product("Steinhof PizzaSpezial.")
        first = add_product("Demo Senf Mittelscharf")
        add_product("Demo Senf Mittelscharf.")
        body = self.ok(self.post(BASE + "detect/"))
        self.assertEqual((body["created"], body["extended"]), (1, 1))
        new = pending_group(first.name)
        self.assertEqual(sorted(body["group_ids"]), sorted([group.pk, new.pk]))
        extended = self.ok(self.client.get(self.url(group)))
        self.assertEqual(extended["version"], 2)
        self.assertIn(added.pk, [member["product_id"] for member in extended["members"]])
        self.assertEqual(self.ok(self.post(BASE + "detect/")), {"created": 0, "extended": 0, "group_ids": []})

    def test_confirm_deletes_absorbed_keeps_links_and_name(self):
        group = pending_group(PIZZA[0])
        target, absorbed = product(PIZZA[0]).pk, [product(name).pk for name in PIZZA[1:]]
        lines = ReceiptLine.objects.count()
        aliases = ProductAlias.objects.count()
        rows = list(ReceiptLine.objects.order_by("pk").values())
        body = self.ok(self.confirm(group))
        self.assertEqual((body["status"], body["target_product_id"], body["conflicts"]), ("confirmed", target, []))
        self.assertIsNotNone(body["resolved_at"])
        self.assertEqual(body["actions"], {"can_confirm": False, "can_cancel": False, "can_exclude": False})
        self.assertEqual({member["product_id"]: member["exists"] for member in body["members"]},
                         {target: True, **{pk: False for pk in absorbed}})
        self.assertEqual({member["name"] for member in body["members"]}, set(PIZZA))
        self.assertFalse(Product.objects.filter(pk__in=absorbed).exists())
        self.assertEqual(Product.objects.get(pk=target).name, PIZZA[0])
        self.assertEqual((ReceiptLine.objects.count(), ProductAlias.objects.count()), (lines, aliases))
        self.assertFalse(ReceiptLine.objects.filter(raw_name__in=PIZZA, product__isnull=True).exists())
        self.assertEqual(ProductAlias.objects.filter(product_id=target).count(), 3)
        # У строк изменился только product_id.
        after = list(ReceiptLine.objects.order_by("pk").values())
        for old, new in zip(rows, after):
            old.pop("product_id"), new.pop("product_id")
        self.assertEqual(after, rows)

    def test_confirm_repeat_and_resolved(self):
        group = pending_group(PIZZA[0])
        other = product(PIZZA[1]).pk
        first = self.ok(self.confirm(group))
        before = snapshot()
        # Повтор с тем же target_product_id, даже с устаревшей версией, — та же группа без записей.
        self.assertEqual(self.ok(self.confirm(group)), first)
        self.assertEqual(self.ok(self.confirm(group, version=99)), first)
        self.error(self.confirm(group, target_product_id=other), 409, "merge_resolved")
        self.error(self.post(self.url(group, "cancel/")), 409, "merge_resolved")
        self.error(self.post(self.url(group, "exclude/"), {"version": 1, "product_id": other}), 409, "merge_resolved")
        self.assertEqual(snapshot(), before)

    def test_confirm_with_another_target_and_name(self):
        group = pending_group(PIZZA[0])
        chosen, name_from = product(PIZZA[2]), product(PIZZA[1])
        body = self.ok(self.confirm(group, target_product_id=chosen.pk, name_product_id=name_from.pk))
        self.assertEqual(body["target_product_id"], chosen.pk)
        self.assertEqual({member["product_id"]: member["role"] for member in body["members"]}[chosen.pk], "target")
        self.assertEqual(list(Product.objects.filter(name__in=PIZZA).values_list("pk", "name")),
                         [(chosen.pk, PIZZA[1])])
        self.assertEqual(ReceiptLine.objects.filter(raw_name__in=PIZZA, product=chosen).count(), 4)
        self.assertEqual(ProductAlias.objects.filter(product=chosen).count(), 3)

    def test_confirm_parameters_outside_active_members(self):
        group = pending_group(MAULTASCHEN[0])
        outsider = product("Pizza Hot Dog").pk
        excluded = product(MAULTASCHEN[2]).pk
        version = self.ok(self.post(self.url(group, "exclude/"), {"version": 1, "product_id": excluded}))["version"]
        before = snapshot()
        cases = (
            ({"target_product_id": outsider}, {"target_product_id"}),
            ({"target_product_id": excluded}, {"target_product_id"}),
            ({"name_product_id": outsider}, {"name_product_id"}),
            ({"target_product_id": outsider, "name_product_id": excluded}, {"target_product_id", "name_product_id"}),
            ({"resolutions": {"brand": outsider}}, {"resolutions.brand"}),
        )
        for body, fields in cases:
            with self.subTest(body=body):
                self.error(self.confirm(group, version=version, **body), 400, "invalid_parameter", fields)
        self.error(self.post(self.url(group, "exclude/"), {"version": version, "product_id": outsider}),
                   400, "invalid_parameter", {"product_id"})
        self.assertEqual(snapshot(), before)

    def test_fact_conflict_needs_a_human_decision(self):
        group = pending_group(MILK[0])
        target, other = product("GQ EgSB H-Milch 1,5%"), product("GO EgSB H-Milch 1,5%")
        before = snapshot()
        self.error(self.confirm(group), 409, "merge_conflict", {"generic"})
        self.error(self.confirm(group, resolutions={}), 409, "merge_conflict", {"generic"})
        # Запись без значения спорного поля и поле без противоречия решением не являются.
        self.error(self.confirm(group, resolutions={"generic": product(MILK[1]).pk}), 400, "invalid_parameter",
                   {"resolutions.generic"})
        self.error(self.confirm(group, resolutions={"generic": target.pk, "brand": target.pk}), 400,
                   "invalid_parameter", {"resolutions.brand"})
        self.assertEqual(snapshot(), before)

        body = self.ok(self.confirm(group, resolutions={"generic": other.pk}))
        self.assertEqual((body["status"], body["conflicts"]), ("confirmed", []))
        target.refresh_from_db()
        self.assertEqual((target.generic_id, target.name), (other.generic_id, MILK[0]))
        self.assertEqual(list(Product.objects.filter(name__in=MILK).values_list("pk", flat=True)), [target.pk])

    def test_empty_fact_is_filled_and_filled_one_is_kept(self):
        group = pending_group(MILK[0])
        target = product(MILK[0])
        Product.objects.filter(pk=product(MILK[1]).pk).update(model="H 1,5")
        self.ok(self.confirm(group, resolutions={"generic": target.pk}))
        target.refresh_from_db()
        self.assertEqual((target.model, target.generic.name), ("H 1,5", demo.MILK_GENERIC))

    def test_result_colliding_with_an_outside_product(self):
        brand = Brand.objects.create(name="Demo Marke Zed")
        target = add_product("Demo Essig Hell Flasche")
        add_product("Demo Essig Hell Flasche.", brand=brand)
        other_store = Store.objects.get(merchant__tax_id=demo.MERCHANTS[demo.OTHER]["tax_id"])
        add_product("Demo Essig Hell Flasche", brand=brand, store=other_store)
        self.ok(self.post(BASE + "detect/"))
        group = pending_group(target.name)
        before = snapshot()
        self.error(self.confirm(group, target_product_id=target.pk), 409, "merge_conflict", {"name"})
        self.assertEqual(snapshot(), before)

    def test_stale_version_changes_nothing(self):
        group = pending_group(PIZZA[0])
        before = snapshot()
        self.error(self.confirm(group, version=2), 409, "merge_changed")
        self.error(self.post(self.url(group, "exclude/"), {"version": 2, "product_id": group.target_ref}),
                   409, "merge_changed")
        self.assertEqual(snapshot(), before)
        # Состав изменился: прежняя версия больше не подходит.
        add_product("Steinhof PizzaSpezial.")
        self.ok(self.post(BASE + "detect/"))
        self.error(self.confirm(group, version=1), 409, "merge_changed")
        self.assertEqual(self.ok(self.confirm(group, version=2))["status"], "confirmed")

    def test_cancel_restores_every_record_and_repeats(self):
        group = pending_group(PIZZA[0])
        late = add_line(product(PIZZA[0]), PIZZA[2])  # пришла за время ожидания по написанию третьей записи
        body = self.ok(self.post(self.url(group, "cancel/")))
        self.assertEqual((body["status"], body["lines_count"], body["new_lines_count"]), ("cancelled", 0, 0))
        self.assertEqual({member["exists"] for member in body["members"]}, {True})
        for name in PIZZA:
            item = product(name)
            self.assertEqual(set(ReceiptLine.objects.filter(product=item).values_list("raw_name", flat=True)), {name})
            self.assertEqual(list(ProductAlias.objects.filter(product=item).values_list("raw_name", flat=True)), [name])
        late.refresh_from_db()
        self.assertEqual(late.product.name, PIZZA[2])
        self.assertEqual(ProductMergeRejection.objects.filter(group=group).count(), 3)

        before = snapshot()
        self.assertEqual(self.ok(self.post(self.url(group, "cancel/"))), body)
        self.error(self.confirm(group), 409, "merge_resolved")
        self.error(self.post(self.url(group, "exclude/"), {"version": 1, "product_id": group.target_ref}),
                   409, "merge_resolved")
        # Отменённые пары новым поиском не предлагаются.
        self.assertEqual(self.ok(self.post(BASE + "detect/")), {"created": 0, "extended": 0, "group_ids": []})
        self.assertEqual(snapshot(), before)
        self.assertEqual(self.client.get("/api/products/?q=pizzaspezial").json()["count"], 3)

    def test_exclude_restores_one_record_and_repeats(self):
        group = pending_group(MAULTASCHEN[0])
        excluded = product(MAULTASCHEN[1])
        body = self.ok(self.post(self.url(group, "exclude/"), {"version": 1, "product_id": excluded.pk}))
        self.assertEqual((body["status"], body["version"]), ("pending", 2))
        states = {member["product_id"]: (member["state"], member["lines_count"]) for member in body["members"]}
        self.assertEqual(states[excluded.pk], ("excluded", 0))
        self.assertEqual(sum(state == "active" for state, _ in states.values()), 2)
        self.assertEqual(set(ReceiptLine.objects.filter(product=excluded).values_list("raw_name", flat=True)),
                         {MAULTASCHEN[1]})
        self.assertEqual(self.client.get(f"/api/products/{excluded.pk}/").json()["name"], MAULTASCHEN[1])

        before = snapshot()
        for version in (1, 2, 99):  # повтор уже исключённой записи — текущая группа при любой версии
            with self.subTest(version=version):
                repeat = self.post(self.url(group, "exclude/"), {"version": version, "product_id": excluded.pk})
                self.assertEqual(self.ok(repeat), body)
        self.assertEqual(snapshot(), before)

    def test_exclude_the_target_and_down_to_one_record(self):
        group = pending_group(MAULTASCHEN[0])
        target = product(MAULTASCHEN[0])
        body = self.ok(self.post(self.url(group, "exclude/"), {"version": 1, "product_id": target.pk}))
        self.assertEqual((body["status"], body["version"]), ("pending", 2))
        self.assertNotEqual(body["target_product_id"], target.pk)
        self.assertEqual(self.client.get(f"/api/products/{target.pk}/").json()["id"], target.pk)

        eggs = pending_group(EGGS[0])
        gone = product(EGGS[1]).pk
        body = self.ok(self.post(self.url(eggs, "exclude/"), {"version": 1, "product_id": gone}))
        self.assertEqual((body["status"], body["actions"]["can_exclude"]), ("cancelled", False))
        # Повтор исключения, отменившего группу, — та же группа.
        self.assertEqual(self.ok(self.post(self.url(eggs, "exclude/"), {"version": 1, "product_id": gone})), body)
        self.error(self.post(self.url(eggs, "exclude/"), {"version": 2, "product_id": product(EGGS[0]).pk}),
                   409, "merge_resolved")

    def test_failure_in_the_middle_changes_nothing(self):
        group = pending_group(PIZZA[0])
        before = snapshot()
        self.client.raise_request_exception = False
        for action, body, patched in (
            ("confirm/", {"version": 1, "target_product_id": group.target_ref}, "_resolve"),
            ("cancel/", {}, "_reject"),
            ("exclude/", {"version": 1, "product_id": group.target_ref}, "_reject"),
        ):
            with self.subTest(action=action), patch.object(services, patched, side_effect=RuntimeError("PRIVATE")):
                response = self.post(self.url(group, action), body)
                self.assertEqual(response.status_code, 500, response.content)
                self.assertEqual(response.json()["error"]["code"], "internal_error")
                self.assertNotIn("PRIVATE", response.content.decode())
                self.assertEqual(snapshot(), before)


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class BusyTests(MergeApiMixin, ConcurrencyTestCase):
    """Настоящие блокировки PostgreSQL в другом соединении."""

    def setUp(self):
        super().setUp()
        self.client = local_client()

    def test_import_mutex_held_elsewhere_is_merge_busy(self):
        group = pending_group(PIZZA[0])
        before = snapshot()
        requests = (
            (BASE + "detect/", {}),
            (self.url(group, "confirm/"), {"version": 1, "target_product_id": group.target_ref}),
            (self.url(group, "cancel/"), {}),
            (self.url(group, "exclude/"), {"version": 1, "product_id": group.target_ref}),
        )
        with self.hold(lambda cursor: cursor.execute("SELECT pg_advisory_xact_lock(%s)", [IMPORT_LOCK])):
            for path, body in requests:
                with self.subTest(path=path):
                    started = time.monotonic()
                    self.error(self.post(path, body), 409, "merge_busy")
                    self.assertLess(time.monotonic() - started, 1.5)  # без ожидания и скрытого повтора
            # Чтение остаётся доступным.
            self.assertEqual(self.ok(self.client.get(BASE))["count"], 7)
            self.ok(self.client.get(self.url(group)))
            self.ok(self.client.get(self.url(group, "lines/")))
        self.assertEqual(snapshot(), before)
        self.assertEqual(self.ok(self.post(self.url(group, "cancel/")))["status"], "cancelled")

    def test_locked_receipt_line_is_merge_busy_after_the_statement_timeout(self):
        group = pending_group(PIZZA[0])
        line = ReceiptLine.objects.filter(raw_name=PIZZA[1]).first()
        before = snapshot()
        with self.hold(lambda cursor: cursor.execute(
            "SELECT id FROM receipts_receiptline WHERE id = %s FOR UPDATE", [line.pk],
        )):
            started = time.monotonic()
            self.error(self.post(self.url(group, "cancel/")), 409, "merge_busy")
            self.assertLess(time.monotonic() - started, 6)
        self.assertEqual(snapshot(), before)
        self.assertEqual(self.ok(self.post(self.url(group, "cancel/")))["status"], "cancelled")
