"""Эталонные JSON для клиента сверяются целиком с настоящими HTTP-ответами."""
import json
from unittest.mock import patch

from django.test import TestCase, override_settings, tag

from api.tests.merge_factories import (
    EGG_IDS, MILK_IDS, NOW, PIZZA_IDS, PRIVATE, PUBLIC, expected, late_purchase, local_client, public_merge_data,
    restart_group_ids,
)
from catalog.models import Product
from merges import services
from merges.models import ProductMerge

EXAMPLES = {
    "detect.json", "group-pending.json", "group-pending-conflict.json", "group-confirmed.json",
    "group-cancelled.json", "groups.json", "lines.json", "error-merge-conflict.json", "error-merge-changed.json",
    "error-merge-resolved.json", "error-merge-busy.json", "error-invalid-parameter.json",
}
# Эталон проекции «своё / чужое»: с настоящим ответом его сверяет api/tests/test_projection.py.
PROJECTION_EXAMPLES = {"lines_foreign.json"}


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class PublicExamplesTests(TestCase):
    def setUp(self):
        restart_group_ids()
        self.client = local_client()
        self.seen = set()

    def check(self, name, response, status=200):
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertNotIn(PRIVATE, response.content.decode("utf-8"))
        self.assertEqual(response.json(), expected(name), name)
        self.seen.add(name)

    def post(self, path, body):
        return self.client.post(path, body, format="json")

    def group_of(self, product_id):
        return ProductMerge.objects.get(members__product_ref=product_id).pk

    def test_public_examples_match_actual_http_responses(self):
        store, names = public_merge_data()
        with patch("django.utils.timezone.now", return_value=NOW):
            self.check("detect.json", self.post("/api/product-merges/detect/", {}))
            pizza, milk, eggs = (self.group_of(ids[0]) for ids in (PIZZA_IDS, MILK_IDS, EGG_IDS))
            late_purchase(store, names)

            self.check("group-pending.json", self.client.get(f"/api/product-merges/{pizza}/"))
            self.check("lines.json", self.client.get(f"/api/product-merges/{pizza}/lines/"))
            self.check("group-pending-conflict.json", self.client.get(f"/api/product-merges/{milk}/"))

            confirm = {"version": 1, "target_product_id": MILK_IDS[0]}
            self.check("error-merge-conflict.json", self.post(f"/api/product-merges/{milk}/confirm/", confirm), 409)
            self.check(
                "error-merge-changed.json",
                self.post(f"/api/product-merges/{milk}/confirm/", {**confirm, "version": 7}), 409,
            )
            self.check(
                "error-invalid-parameter.json",
                self.post(f"/api/product-merges/{milk}/confirm/", {**confirm, "target_product_id": PIZZA_IDS[0]}),
                400,
            )
            self.check(
                "group-confirmed.json",
                self.post(f"/api/product-merges/{milk}/confirm/", {**confirm, "resolutions": {"generic": 2}}),
            )
            self.check("error-merge-resolved.json", self.post(f"/api/product-merges/{milk}/cancel/", {}), 409)
            self.check("group-cancelled.json", self.post(f"/api/product-merges/{eggs}/cancel/", {}))
            self.check("groups.json", self.client.get("/api/product-merges/"))
            with patch.object(services, "cancel", side_effect=services.MergeBusy("merge_busy")):
                self.check("error-merge-busy.json", self.post(f"/api/product-merges/{pizza}/cancel/", {}), 409)

        self.assertEqual(self.seen, EXAMPLES)
        self.assertEqual({path.name for path in PUBLIC.glob("*.json")}, EXAMPLES | PROJECTION_EXAMPLES)
        # Молоко подтверждено: поглощённые удалены, оставляемый получил выбранный обобщённый продукт.
        self.assertEqual(list(Product.objects.filter(pk__in=MILK_IDS).values_list("pk", "generic_id")), [(2, 92)])

    def test_examples_are_utf8_lf_json(self):
        for path in sorted(PUBLIC.glob("*.json")):
            with self.subTest(name=path.name):
                raw = path.read_bytes()
                self.assertNotIn(b"\r", raw)
                self.assertTrue(raw.endswith(b"\n"))
                self.assertEqual(
                    raw.decode("utf-8"), json.dumps(json.loads(raw), ensure_ascii=False, indent=2) + "\n",
                )
