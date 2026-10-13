import importlib.util
import json

from django.conf import settings
from django.test import SimpleTestCase

GRAFANA = settings.BASE_DIR.parent / "deploy" / "grafana"
SOURCES = {"checkist-prometheus", "checkist-postgres", "loki"}


def builder():
    spec = importlib.util.spec_from_file_location("build_dashboards", GRAFANA / "build_dashboards.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GrafanaDashboardTests(SimpleTestCase):
    def test_the_json_is_the_output_of_the_builder(self):
        # Edit build_dashboards.py and run it; the JSON is never edited by hand.
        built = builder().build()
        self.assertEqual(set(built), {"checkist-service", "checkist-spending", "checkist-errors"})
        files = {path.stem: path for path in (GRAFANA / "dashboards").glob("*.json")}
        self.assertEqual(set(files), set(built))
        for uid, dashboard in built.items():
            with self.subTest(uid=uid):
                self.assertEqual(json.loads(files[uid].read_text(encoding="utf-8")), dashboard)

    def test_panels_use_the_provisioned_sources_by_uid(self):
        for uid, dashboard in builder().build().items():
            used = {panel["datasource"]["uid"] for panel in dashboard["panels"] if "datasource" in panel}
            used |= {target["datasource"]["uid"] for panel in dashboard["panels"] for target in panel.get("targets", [])}
            with self.subTest(uid=uid):
                self.assertLessEqual(used, SOURCES)
                ids = [panel["id"] for panel in dashboard["panels"]]
                self.assertEqual(len(ids), len(set(ids)))

    def test_spending_hides_hidden_payments_and_never_adds_currencies(self):
        spending = builder().build()["checkist-spending"]
        queries = [target["rawSql"] for panel in spending["panels"] for target in panel.get("targets", [])]
        for query in queries:
            with self.subTest(query=query[:60]):
                self.assertIn("currency_id = '$currency'", query)
                if "receipts_receipt" in query:
                    self.assertIn("NOT r.hidden", query)
                self.assertNotIn("password", query)
