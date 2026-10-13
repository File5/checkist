"""Read-only PostgreSQL role of Grafana «Checkist · Траты» (docs/observability.md).

    GRAFANA_DB_PASSWORD=... python manage.py grafana_reader [--password-env NAME] [--role NAME]

Creates the role or updates it, then sets its privileges anew: CONNECT, USAGE on ``public`` and SELECT
only on the columns the spending dashboard reads — no users, sessions, tokens, notes, receipt texts or
photos. Column grants, not views: a view would block a later migration that alters a column it reads.
No default privileges: a new table stays closed until it is added here and the command is run again.
Without the password variable an existing role keeps its password (a re-run after a migration).
"""
import os
import re

from django.apps import apps
from django.core.management.base import BaseCommand, CommandError
from django.db import connection, transaction
from psycopg import sql

# {model: fields}: exactly the columns the SQL of «Checkist · Траты» reads (test_grafana_reader checks
# both ways) — no free text (notes, raw receipt and line texts), no addresses, no people's data
# beyond the family name of the variable. A renamed field fails here loudly.
READABLE = {
    "accounts.Household": ("id", "name"),
    "accounts.Membership": ("user", "household"),
    "receipts.Receipt": ("id", "owner", "store", "source", "currency", "purchased_on", "total", "payment_method",
                         "hidden"),
    "receipts.ReceiptLine": ("receipt", "product", "category", "amount", "discount_amount"),
    "catalog.Category": ("id", "name", "parent"),
    "catalog.GenericProduct": ("id", "category"),
    "catalog.Product": ("id", "generic"),
    "stores.Store": ("id", "name", "merchant", "merged_into"),
    "stores.Merchant": ("id", "brand_name"),
    "incomes.Income": ("owner", "received_on", "amount", "currency"),
}
ROLE_NAME = re.compile(r"[a-z_][a-z0-9_]{0,62}")


def columns():
    """``{table: [column, ...]}`` of ``READABLE``."""
    result = {}
    for label, fields in READABLE.items():
        meta = apps.get_model(label)._meta
        result[meta.db_table] = [meta.get_field(name).column for name in fields]
    return result


class Command(BaseCommand):
    help = "Create or update the read-only PostgreSQL role of Grafana (docs/observability.md)."

    def add_arguments(self, parser):
        parser.add_argument("--password-env", default="GRAFANA_DB_PASSWORD",
                            help="Environment variable with the password (default GRAFANA_DB_PASSWORD).")
        parser.add_argument("--role", default="checkist_grafana", help="Role name (default checkist_grafana).")

    def handle(self, *args, password_env, role, **options):
        if not ROLE_NAME.fullmatch(role):
            raise CommandError("--role: expected a lowercase PostgreSQL identifier.")
        password = os.environ.get(password_env, "")
        name = sql.Identifier(role)
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", [role])
            exists = cursor.fetchone() is not None
            if not exists and not password:
                raise CommandError(f"{password_env}: set the password of the new role {role}.")
            attributes = sql.SQL(
                "LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5")
            if password:
                attributes = sql.SQL("{} PASSWORD {}").format(attributes, sql.Literal(password))
            verb = sql.SQL("ALTER ROLE") if exists else sql.SQL("CREATE ROLE")
            statements = [
                sql.SQL("{} {} {}").format(verb, name, attributes),
                # Belt and braces: the grants below already allow nothing but SELECT.
                sql.SQL("ALTER ROLE {} SET default_transaction_read_only = on").format(name),
                sql.SQL("ALTER ROLE {} SET statement_timeout = '30s'").format(name),
                sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(
                    sql.Identifier(connection.settings_dict["NAME"]), name),
                sql.SQL("GRANT USAGE ON SCHEMA public TO {}").format(name),
                # Anew on every run: a column taken out of READABLE is closed again.
                sql.SQL("REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {}").format(name),
                sql.SQL("REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {}").format(name),
            ]
            for table, names in columns().items():
                statements.append(sql.SQL("GRANT SELECT ({}) ON {} TO {}").format(
                    sql.SQL(", ").join(map(sql.Identifier, names)), sql.Identifier(table), name))
            for statement in statements:
                cursor.execute(statement.as_string(cursor.connection))
        self.stdout.write(f"{role}: {'updated' if exists else 'created'}, SELECT on {len(READABLE)} tables.")
