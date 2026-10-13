import re
from io import StringIO
from unittest import SkipTest
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.db import ProgrammingError, connection, transaction
from django.test import TestCase

from health.management.commands.grafana_reader import columns
from health.tests.test_grafana_dashboards import builder

ROLE = "checkist_grafana_test"
PASSWORD = {"OBS_TEST_GRAFANA_PASSWORD": "test-only-grafana-password"}


class GrafanaReaderTests(TestCase):
    """Role, password and grants roll back with the test transaction; checks run under SET LOCAL ROLE."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        with connection.cursor() as cursor:
            cursor.execute("SELECT rolsuper OR rolcreaterole FROM pg_roles WHERE rolname = current_user")
            if not cursor.fetchone()[0]:
                raise SkipTest("the test database user cannot create roles")

    def run_command(self, *args):
        out = StringIO()
        call_command("grafana_reader", "--role", ROLE, "--password-env", "OBS_TEST_GRAFANA_PASSWORD", *args,
                     stdout=out)
        return out.getvalue()

    def as_reader(self, statement):
        # A failed statement rolls the savepoint back, and the role with it.
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(f"SET LOCAL ROLE {ROLE}")
            cursor.execute(statement)
            rows = cursor.fetchall() if cursor.description else None
            cursor.execute("RESET ROLE")
        return rows

    def test_the_role_reads_the_listed_columns_only(self):
        with patch.dict("os.environ", PASSWORD):
            self.assertIn("created", self.run_command())
        with connection.cursor() as cursor:
            cursor.execute("SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = %s",
                           [ROLE])
            self.assertEqual(cursor.fetchone(), (True, False, False, False))
        for allowed in (
            "SELECT id, owner_id, store_id, source, currency_id, purchased_on, total, payment_method, hidden "
            "FROM receipts_receipt",
            "SELECT receipt_id, amount, discount_amount, category_id, product_id FROM receipts_receiptline",
            "SELECT id, name, parent_id FROM catalog_category",
            "SELECT user_id, household_id FROM accounts_membership",
            "SELECT id, name, merchant_id, merged_into_id FROM stores_store",
            "SELECT owner_id, amount, received_on, currency_id FROM incomes_income",
        ):
            with self.subTest(allowed=allowed):
                self.assertIsInstance(self.as_reader(allowed), list)
        for denied in (
            # People, sessions and tokens.
            "SELECT id FROM auth_user", "SELECT password FROM auth_user", "SELECT username FROM auth_user",
            "SELECT session_key FROM django_session", "SELECT token_hash FROM accounts_invite",
            "SELECT endpoint FROM push_pushsubscription", "SELECT role FROM accounts_membership",
            # Free text and addresses.
            "SELECT note FROM receipts_receipt", "SELECT raw_text FROM receipts_receipt",
            "SELECT fiscal FROM receipts_receipt", "SELECT * FROM receipts_receipt",
            "SELECT raw_name FROM receipts_receiptline", "SELECT note FROM incomes_income",
            "SELECT address_raw FROM stores_store", "SELECT legal_name FROM stores_merchant",
            "SELECT text FROM receipts_manualparserequest", "SELECT details FROM statements_statementrow",
            # Tables the dashboard does not read.
            "SELECT code FROM stores_currency", "SELECT day FROM rates_rate",
            # Writes.
            "INSERT INTO catalog_category (name) VALUES ('x')", "UPDATE catalog_category SET name = 'x'",
            "DELETE FROM receipts_receipt",
        ):
            with self.subTest(denied=denied), self.assertRaises(ProgrammingError):
                self.as_reader(denied)

    def test_a_new_role_needs_a_password(self):
        with patch.dict("os.environ", {}, clear=False), self.assertRaisesMessage(CommandError, "set the password"):
            self.run_command()

    def test_a_rerun_without_the_password_keeps_the_role(self):
        with patch.dict("os.environ", PASSWORD):
            self.run_command()
        self.assertIn("updated", self.run_command())
        self.assertEqual(self.as_reader("SELECT id FROM catalog_category"), [])

    def test_the_grants_are_exactly_what_the_spending_dashboard_reads(self):
        spending = builder().build()["checkist-spending"]
        queries = [variable["query"] for variable in spending["templating"]["list"]]
        queries += [target["rawSql"] for panel in spending["panels"] for target in panel.get("targets", [])]
        # Not more: every granted table and column is read by some query.
        text = "\n".join(queries)
        for table, names in columns().items():
            for name in names:
                with self.subTest(table=table, column=name):
                    self.assertIn(table, text)
                    self.assertRegex(text, rf"\b{name}\b")
        # Enough: every query runs as the role (the macros of Grafana replaced by literals).
        with patch.dict("os.environ", PASSWORD):
            self.run_command()
        for query in queries:
            expanded = re.sub(r"\$__timeFilter\(([^)]+)\)", r"\1 BETWEEN '2026-01-01' AND '2026-12-31'", query)
            expanded = expanded.replace("$household", "'0'").replace("$currency", "KZT").replace("%", "%%")
            with self.subTest(query=query[:60]):
                self.assertIsInstance(self.as_reader(expanded), list)

    def test_the_role_name_is_an_identifier(self):
        with self.assertRaisesMessage(CommandError, "--role"):
            call_command("grafana_reader", "--role", 'x"; DROP TABLE auth_user; --', stdout=StringIO())
