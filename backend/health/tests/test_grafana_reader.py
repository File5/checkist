from io import StringIO
from unittest import SkipTest
from unittest.mock import patch

from django.core.management import CommandError, call_command
from django.db import ProgrammingError, connection, transaction
from django.test import TestCase

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
            "SELECT id, username, first_name, is_active FROM auth_user",
            "SELECT id, owner_id, total, currency_id, purchased_on, hidden, note FROM receipts_receipt",
            "SELECT receipt_id, amount, discount_amount, category_id, product_id FROM receipts_receiptline",
            "SELECT id, name, parent_id FROM catalog_category",
            "SELECT user_id, household_id FROM accounts_membership",
            "SELECT amount, received_on FROM incomes_income",
            "SELECT currency, day, value, quant FROM rates_rate",
        ):
            with self.subTest(allowed=allowed):
                self.assertIsInstance(self.as_reader(allowed), list)
        for denied in (
            "SELECT password FROM auth_user", "SELECT * FROM auth_user", "SELECT email FROM auth_user",
            "SELECT session_key FROM django_session", "SELECT raw_text FROM receipts_receipt",
            "SELECT raw_name FROM receipts_receiptline", "SELECT text FROM receipts_manualparserequest",
            "SELECT token_hash FROM accounts_invite", "SELECT endpoint FROM push_pushsubscription",
            "INSERT INTO stores_currency (code, name) VALUES ('XXX', 'x')",
            "UPDATE catalog_category SET name = 'x'", "DELETE FROM rates_rate",
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

    def test_the_role_name_is_an_identifier(self):
        with self.assertRaisesMessage(CommandError, "--role"):
            call_command("grafana_reader", "--role", 'x"; DROP TABLE auth_user; --', stdout=StringIO())
