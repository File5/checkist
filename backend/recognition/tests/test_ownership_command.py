import io
import json
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, connection, transaction
from django.db.migrations.loader import MigrationLoader
from django.test import TestCase, tag

from receipts import ownership_checks
from receipts.models import Receipt
from receipts.ownership_checks import RECEIPT_ROLLBACK_RULES
from recognition import ownership
from recognition.models import SourcePhoto
from stores.models import Country, Currency, Merchant, Store

# All names, numbers and keys are synthetic.

User = get_user_model()

PURCHASED_AT = datetime(2026, 3, 14, 11, 30, tzinfo=timezone.utc)
PURCHASED_ON = date(2026, 3, 14)
SHA256 = "c" * 64
FISCAL_KEY = "xa:synthetic-fiscal-key-4471"
RECEIPT_NUMBER = "SYNTH-NUMBER-90213"
TOTAL = Decimal("7731.19")


@tag("integration")
class CheckRollbackTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = User.objects.create_user("synthetic-owner-one")
        cls.other_owner = User.objects.create_user("synthetic-owner-two")
        cls.third_owner = User.objects.create_user("synthetic-owner-three")
        cls.country = Country.objects.create(code="XA", name="Synthetic country")
        cls.currency = Currency.objects.create(code="XTS", name="Synthetic currency")
        merchant = Merchant.objects.create(country=cls.country, legal_name="Synthetic merchant")
        cls.store = Store.objects.create(
            merchant=merchant, country=cls.country, address_raw="Synthetic street 1", timezone="UTC",
        )
        cls.other_store = Store.objects.create(
            merchant=merchant, country=cls.country, address_raw="Synthetic street 2", timezone="UTC",
        )

    def photo(self, owner, **fields):
        values = dict(
            owner=owner, original_file=f"originals/{uuid.uuid4()}/source.png", sha256=SHA256,
            content_type="image/png", bytes=100, raw_width=100, raw_height=200, width=100, height=200,
        )
        values.update(fields)
        return SourcePhoto.objects.create(**values)

    def receipt(self, owner, **fields):
        values = dict(
            owner=owner, store=self.store, currency=self.currency, operation=Receipt.Operation.SALE,
            purchased_at=PURCHASED_AT, purchased_on=PURCHASED_ON, total=TOTAL,
        )
        values.update(fields)
        return Receipt.objects.create(**values)

    def run_command(self):
        """(exit code, parsed stdout, raw stdout); a CommandError is what the shell sees as a non-zero exit."""
        out = io.StringIO()
        try:
            call_command("ownership", "check-rollback", stdout=out)
            code = 0
        except CommandError as error:
            code = error.returncode
        return code, json.loads(out.getvalue()), out.getvalue()

    def assertClean(self):
        code, payload, _raw = self.run_command()
        self.assertEqual(payload, {"conflicts": 0, "groups": []})
        self.assertEqual(code, 0)

    def assertGroups(self, expected):
        code, payload, raw = self.run_command()
        self.assertEqual(code, 1)
        self.assertEqual(payload["conflicts"], len(expected))
        self.assertEqual(
            [(group["rule"], [(row["id"], row["owner_id"]) for row in group["rows"]]) for group in payload["groups"]],
            expected,
        )
        return payload, raw

    # --- nothing to report ---

    def test_empty_database(self):
        self.assertClean()

    def test_empty_database_takes_one_query_per_rule(self):
        with self.assertNumQueries(4):
            self.assertClean()

    def test_single_owner_database_is_clean(self):
        self.photo(self.owner)
        self.photo(self.owner, sha256="d" * 64)
        self.receipt(self.owner, fiscal_key=FISCAL_KEY)
        self.receipt(self.owner, receipt_number=RECEIPT_NUMBER)
        self.receipt(self.owner)
        self.receipt(self.owner, purchased_at=PURCHASED_AT + timedelta(minutes=1))
        self.assertClean()

    def test_different_values_of_two_owners_are_clean(self):
        self.photo(self.owner)
        self.photo(self.other_owner, sha256="d" * 64)
        self.receipt(self.owner, fiscal_key=FISCAL_KEY)
        self.receipt(self.other_owner, fiscal_key=FISCAL_KEY + "-other")
        self.receipt(self.owner, receipt_number=RECEIPT_NUMBER)
        self.receipt(self.other_owner, receipt_number=RECEIPT_NUMBER + "-other")
        self.receipt(self.owner)
        self.receipt(self.other_owner, total=TOTAL + 1)
        self.assertClean()

    def test_same_number_is_clean_when_another_key_field_differs(self):
        self.receipt(self.owner, receipt_number=RECEIPT_NUMBER)
        self.receipt(self.other_owner, receipt_number=RECEIPT_NUMBER, store=self.other_store)
        self.receipt(self.other_owner, receipt_number=RECEIPT_NUMBER, purchased_on=PURCHASED_ON + timedelta(days=1))
        self.receipt(self.third_owner, receipt_number=RECEIPT_NUMBER, shift_number="7")
        self.receipt(self.third_owner, receipt_number=RECEIPT_NUMBER, register_code="K-2")
        self.assertClean()

    def test_same_store_time_total_is_clean_when_a_number_or_key_is_present(self):
        """The former constraint covered only rows with an empty number and an empty key."""
        self.receipt(self.owner)
        self.receipt(self.other_owner, fiscal_key=FISCAL_KEY)
        self.receipt(self.third_owner, receipt_number=RECEIPT_NUMBER)
        self.assertClean()

    def test_same_store_time_total_is_clean_when_a_key_field_differs(self):
        self.receipt(self.owner)
        self.receipt(self.other_owner, store=self.other_store)
        self.receipt(self.other_owner, purchased_at=PURCHASED_AT + timedelta(seconds=1))
        self.receipt(self.third_owner, total=TOTAL + Decimal("0.01"))
        self.assertClean()

    # --- one case per rule ---

    def test_same_file_of_two_owners(self):
        first = self.photo(self.owner)
        second = self.photo(self.other_owner)
        self.photo(self.owner, sha256="d" * 64)
        payload, _raw = self.assertGroups([
            ("photo_sha256", [(first.pk, self.owner.pk), (second.pk, self.other_owner.pk)]),
        ])
        self.assertEqual(payload["groups"][0]["model"], "recognition.SourcePhoto")
        self.assertEqual(payload["groups"][0]["constraint"], "recognition_sourcephoto.sha256 unique")

    def test_same_fiscal_key_of_two_owners(self):
        # Number, time and total differ: only the key matches.
        first = self.receipt(self.owner, fiscal_key=FISCAL_KEY, receipt_number="A-1")
        second = self.receipt(
            self.other_owner, fiscal_key=FISCAL_KEY, receipt_number="A-2", store=self.other_store,
            purchased_at=PURCHASED_AT + timedelta(hours=1), total=TOTAL + 5,
        )
        payload, _raw = self.assertGroups([
            ("receipt_fiscal_key", [(first.pk, self.owner.pk), (second.pk, self.other_owner.pk)]),
        ])
        self.assertEqual(payload["groups"][0]["model"], "receipts.Receipt")
        self.assertEqual(payload["groups"][0]["constraint"], "receipts_receipt_fiscal_key_uniq")

    def test_same_store_number_of_two_owners(self):
        fields = dict(receipt_number=RECEIPT_NUMBER, shift_number="7", register_code="K-2")
        first = self.receipt(self.owner, fiscal_key=FISCAL_KEY, **fields)
        # Time and total are not part of this key.
        second = self.receipt(
            self.other_owner, purchased_at=PURCHASED_AT + timedelta(hours=2), total=TOTAL + 5, **fields,
        )
        payload, _raw = self.assertGroups([
            ("receipt_store_number", [(first.pk, self.owner.pk), (second.pk, self.other_owner.pk)]),
        ])
        self.assertEqual(payload["groups"][0]["constraint"], "receipts_receipt_store_number_uniq")

    def test_same_store_time_total_of_two_owners(self):
        first = self.receipt(self.owner)
        second = self.receipt(self.other_owner, purchased_on=PURCHASED_ON + timedelta(days=1))
        payload, _raw = self.assertGroups([
            ("receipt_store_time_total", [(first.pk, self.owner.pk), (second.pk, self.other_owner.pk)]),
        ])
        self.assertEqual(payload["groups"][0]["constraint"], "receipts_receipt_store_time_total_uniq")

    # --- shape of the report ---

    def test_three_owners_form_one_group(self):
        rows = [self.receipt(owner, fiscal_key=FISCAL_KEY) for owner in (self.owner, self.other_owner, self.third_owner)]
        self.assertGroups([("receipt_fiscal_key", [(row.pk, row.owner_id) for row in rows])])

    def test_receipt_breaking_two_rules_is_reported_in_both(self):
        fields = dict(fiscal_key=FISCAL_KEY, receipt_number=RECEIPT_NUMBER)
        first = self.receipt(self.owner, **fields)
        second = self.receipt(self.other_owner, **fields)
        rows = [(first.pk, self.owner.pk), (second.pk, self.other_owner.pk)]
        self.assertGroups([("receipt_fiscal_key", rows), ("receipt_store_number", rows)])

    def test_groups_follow_rule_order_and_ids(self):
        late_a = self.receipt(self.owner, fiscal_key=FISCAL_KEY + "-late")
        early_a = self.receipt(self.owner, fiscal_key=FISCAL_KEY)
        timed_a = self.receipt(self.owner)
        photo_a = self.photo(self.owner)
        early_b = self.receipt(self.other_owner, fiscal_key=FISCAL_KEY)
        late_b = self.receipt(self.other_owner, fiscal_key=FISCAL_KEY + "-late")
        timed_b = self.receipt(self.other_owner)
        photo_b = self.photo(self.other_owner)
        self.receipt(self.third_owner, fiscal_key=FISCAL_KEY + "-single")
        one, two = self.owner.pk, self.other_owner.pk
        self.assertGroups([
            ("photo_sha256", [(photo_a.pk, one), (photo_b.pk, two)]),
            ("receipt_fiscal_key", [(late_a.pk, one), (late_b.pk, two)]),
            ("receipt_fiscal_key", [(early_a.pk, one), (early_b.pk, two)]),
            ("receipt_store_time_total", [(timed_a.pk, one), (timed_b.pk, two)]),
        ])

    def test_many_groups_are_read_in_chunks(self):
        expected = []
        for number in range(5):
            key = f"{FISCAL_KEY}-{number}"
            first = self.receipt(self.owner, fiscal_key=key)
            second = self.receipt(self.other_owner, fiscal_key=key)
            expected.append(("receipt_fiscal_key", [(first.pk, self.owner.pk), (second.pk, self.other_owner.pk)]))
        with mock.patch.object(ownership_checks, "GROUP_CHUNK", 2):
            # Four key queries and three row queries for five groups in chunks of two.
            with self.assertNumQueries(7):
                self.assertGroups(expected)

    def test_output_has_ids_only(self):
        self.photo(self.owner)
        self.photo(self.other_owner)
        fields = dict(fiscal_key=FISCAL_KEY, receipt_number=RECEIPT_NUMBER, raw_text="SYNTHETIC RAW TEXT 55817")
        self.receipt(self.owner, **fields)
        self.receipt(self.other_owner, **fields)
        self.receipt(self.owner)
        self.receipt(self.other_owner)
        payload, raw = self.assertGroups([
            (group["rule"], [(row["id"], row["owner_id"]) for row in group["rows"]])
            for group in ownership.rollback_summary()["groups"]
        ])
        self.assertEqual(payload["conflicts"], 4)
        for group in payload["groups"]:
            self.assertEqual(set(group), {"rule", "model", "constraint", "rows"})
            for row in group["rows"]:
                self.assertEqual(set(row), {"id", "owner_id"})
        for secret in (SHA256, FISCAL_KEY, RECEIPT_NUMBER, str(TOTAL), "SYNTHETIC RAW TEXT", "Synthetic street",
                       "synthetic-owner", "2026"):
            self.assertNotIn(secret, raw)

    def test_command_writes_nothing(self):
        self.photo(self.owner)
        self.photo(self.other_owner)
        self.receipt(self.owner, fiscal_key=FISCAL_KEY)
        self.receipt(self.other_owner, fiscal_key=FISCAL_KEY)
        before = (
            list(Receipt.objects.order_by("pk").values()), list(SourcePhoto.objects.order_by("pk").values()),
            User.objects.count(),
        )
        with self.assertNumQueries(6) as captured:
            code, _payload, _raw = self.run_command()
        self.assertEqual(code, 1)
        for query in captured.captured_queries:
            self.assertTrue(query["sql"].lstrip().upper().startswith("SELECT"), query["sql"])
        after = (
            list(Receipt.objects.order_by("pk").values()), list(SourcePhoto.objects.order_by("pk").values()),
            User.objects.count(),
        )
        self.assertEqual(after, before)

    def test_failure_message_and_exit_code(self):
        self.receipt(self.owner, fiscal_key=FISCAL_KEY)
        self.receipt(self.other_owner, fiscal_key=FISCAL_KEY)
        with self.assertRaises(CommandError) as caught:
            call_command("ownership", "check-rollback", stdout=io.StringIO())
        self.assertEqual(caught.exception.returncode, 1)
        self.assertIn("1 group(s)", str(caught.exception))
        self.assertNotIn(FISCAL_KEY, str(caught.exception))

    def test_unknown_action_is_rejected(self):
        with self.assertRaises(CommandError):
            call_command("ownership", "fix-rollback", stdout=io.StringIO())
        with self.assertRaises(CommandError):
            call_command("ownership", stdout=io.StringIO())

    # --- a duplicate inside one owner cannot exist ---

    def assertRejected(self, constraint, operation):
        with self.assertRaises(IntegrityError) as caught, transaction.atomic():
            operation()
        self.assertIn(constraint, str(caught.exception))

    def test_duplicate_of_one_owner_is_impossible(self):
        self.photo(self.owner)
        self.receipt(self.owner, fiscal_key=FISCAL_KEY)
        self.receipt(self.owner, receipt_number=RECEIPT_NUMBER)
        self.receipt(self.owner)
        self.assertRejected("rec_photo_owner_sha256_uniq", lambda: self.photo(self.owner))
        self.assertRejected(
            "receipts_receipt_owner_fiscal_key_uniq",
            lambda: self.receipt(self.owner, fiscal_key=FISCAL_KEY, total=TOTAL + 1),
        )
        self.assertRejected(
            "receipts_receipt_owner_store_number_uniq",
            lambda: self.receipt(self.owner, receipt_number=RECEIPT_NUMBER, total=TOTAL + 1),
        )
        self.assertRejected("receipts_receipt_owner_store_time_total_uniq", lambda: self.receipt(self.owner))
        self.assertEqual((SourcePhoto.objects.count(), Receipt.objects.count()), (1, 3))
        self.assertClean()

    # --- the rules repeat the constraints that the rollback restores ---

    def test_receipt_rules_match_the_constraints_before_owner(self):
        state = MigrationLoader(connection).project_state(("receipts", "0002_alter_receipttax_options"))
        former = {
            constraint.name: (tuple(constraint.fields), constraint.condition)
            for constraint in state.models["receipts", "receipt"].options["constraints"]
        }
        self.assertEqual(
            {rule.constraint: (rule.fields, rule.condition) for rule in RECEIPT_ROLLBACK_RULES}, former,
        )

    def test_photo_rule_matches_the_field_before_owner(self):
        state = MigrationLoader(connection).project_state(("recognition", "0001_initial"))
        photo = state.models["recognition", "sourcephoto"]
        self.assertTrue(photo.fields["sha256"].unique)
        self.assertNotIn("sha256", [
            field for constraint in photo.options.get("constraints", [])
            for field in getattr(constraint, "fields", ())
        ])
        self.assertEqual(ownership.PHOTO_ROLLBACK_RULE.fields, ("sha256",))
        self.assertIsNone(ownership.PHOTO_ROLLBACK_RULE.condition)
