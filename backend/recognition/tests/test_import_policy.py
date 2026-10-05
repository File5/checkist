from dataclasses import replace
from decimal import Decimal

from django.test import SimpleTestCase

from recognition.dto import FieldObservation
from recognition.import_policy import prepare_observation
from recognition.importer import _domain_observation
from recognition.providers.codex_cli import PACKAGE_ROOT
from recognition.providers.fake import receipt_payload
from recognition.schema_validation import _schema, validate_observation
from .import_fixtures import observation


class ImportPolicyTests(SimpleTestCase):
    def test_arithmetic_requires_two_observed_operands_and_preserves_original(self):
        obs = observation()
        for key, expected in (("quantity", Decimal("2.000")), ("unit_price", Decimal("1.2900")),
                              ("amount", Decimal("2.58"))):
            with self.subTest(key=key):
                incoming = replace(obs, lines=(replace(obs.lines[0], **{key: None}),))
                effective, derived = _domain_observation(incoming)
                self.assertEqual(getattr(effective.lines[0], key), expected)
                self.assertIn("/lines/0/" + key, derived)
                self.assertIsNone(getattr(incoming.lines[0], key))
                uncertain = replace(incoming, fields=tuple(replace(f, status="ambiguous")
                    if f.path == "/lines/0/" + ("unit_price" if key == "quantity" else "quantity") else f
                    for f in incoming.fields))
                self.assertIsNone(getattr(_domain_observation(uncertain)[0].lines[0], key))

    def test_arithmetic_does_not_round_quantity_or_price_or_divide_by_zero(self):
        obs = observation()
        cases = (
            dict(quantity=None, unit_price=Decimal("3"), amount=Decimal("1")),
            dict(quantity=Decimal("3"), unit_price=None, amount=Decimal("1")),
            dict(quantity=None, unit_price=Decimal("0"), amount=Decimal("0")),
            dict(quantity=Decimal("0"), unit_price=None, amount=Decimal("0")),
            dict(quantity=None, unit_price=None, amount=Decimal("1")),
        )
        for values in cases:
            with self.subTest(values=values):
                incoming = replace(obs, lines=(replace(obs.lines[0], **values),))
                effective, derived = _domain_observation(incoming)
                self.assertNotIn("/lines/0/quantity", derived)
                self.assertNotIn("/lines/0/unit_price", derived)
                for key in values:
                    self.assertEqual(getattr(effective.lines[0], key), values[key])

    def test_derived_amount_uses_cent_rounding_and_preserves_refund_sign(self):
        obs = observation()
        for quantity, expected in (("1.005", "1.01"), ("-1.005", "-1.01")):
            incoming = replace(obs, lines=(replace(obs.lines[0], quantity=Decimal(quantity),
                                                   unit_price=Decimal("1"), amount=None),))
            self.assertEqual(_domain_observation(incoming)[0].lines[0].amount, Decimal(expected))

    def test_piece_default_requires_observed_integer_count_without_weight_rate(self):
        obs = observation()
        for quantity, status, text, expected in (("2", "absent", "MILCH 1 L", "pcs"),
                ("0.5", "absent", "APFEL", None), ("2", "unreadable", "MILCH", None),
                ("2", "ambiguous", "MILCH", None), ("2", "absent", "APFEL pro kg", None)):
            incoming = replace(obs, lines=(replace(obs.lines[0], quantity=Decimal(quantity), unit=None, raw_name=text),),
                fields=tuple(f for f in obs.fields if f.path != "/lines/0/unit")
                + (FieldObservation("/lines/0/unit", status, None, None),))
            effective, derived = _domain_observation(incoming)
            self.assertEqual(effective.lines[0].unit, expected)
            self.assertEqual("/lines/0/unit" in derived, expected is not None)

    def test_prompt_schema_validator_agree_on_operation_and_nullable_fiscal(self):
        prompt = (PACKAGE_ROOT / "prompts/receipt.txt").read_text(encoding="utf-8")
        self.assertIn("operation=sale", prompt)
        self.assertIn("register_serial", prompt)
        self.assertEqual(_schema("receipt")["properties"]["operation"]["enum"], ["sale", "refund", None])
        for operation in ("sale", "refund", None):
            payload = receipt_payload()
            payload.update(operation=operation)
            payload["fiscal"]["register_serial"] = None
            obs = observation(payload)
            data = obs.to_dict()
            data["fields"].append({"path": "/fiscal/register_serial", "status": "ambiguous", "confidence": None, "note": None})
            self.assertEqual(validate_observation(data).operation, operation)

    def test_missing_operation_defaults_to_sale_but_explicit_return_does_not(self):
        for text, expected in (("Barzahlung\nRueckgeld 0.58", "sale"), ("REFUND\nMILCH", "refund"),
                               ("ВОЗВРАТ ПРИХОДА\nМОЛОКО", "refund")):
            obs = replace(observation(), operation=None, raw_text=text)
            effective, issues = prepare_observation(obs)
            self.assertEqual(effective.operation, expected)
            self.assertIn("operation_defaulted", [v["code"] for v in issues])
            self.assertIsNone(obs.operation)
        obs = replace(observation(), operation=None)
        obs = replace(obs, lines=(replace(obs.lines[0], quantity=Decimal("-2"), amount=Decimal("-2.58")),))
        self.assertEqual(prepare_observation(obs)[0].operation, "refund")

    def test_uncertain_and_unevidenced_identifiers_cannot_make_a_strong_key(self):
        for status, value in (("ambiguous", "WRONG-KASSE"), ("ambiguous", None), ("unreadable", None)):
            obs = observation()
            obs = replace(obs, fiscal=replace(obs.fiscal, register_serial=value), fields=tuple(
                replace(f, status=status) if f.path == "/fiscal/register_serial" else f for f in obs.fields))
            effective, issues = prepare_observation(obs)
            self.assertIsNone(effective.fiscal.register_serial)
            self.assertIn("optional_omitted", [v["code"] for v in issues])
            self.assertEqual(obs.fiscal.register_serial, value)
        effective, _ = prepare_observation(replace(observation(), fields=()))
        self.assertIsNone(effective.receipt_number)
        self.assertIsNone(effective.fiscal.register_serial)

    def test_optional_tax_and_product_uncertainty_is_discarded_without_guessing(self):
        obs = observation()
        changed = {"/lines/0/store_item_code", "/lines/0/tax_rate/rate", "/lines/0/product_hint/name"}
        obs = replace(obs, fields=tuple(replace(f, status="ambiguous") if f.path in changed else f for f in obs.fields))
        effective, issues = prepare_observation(obs)
        self.assertIsNone(effective.lines[0].tax_rate.kind)
        self.assertIsNone(effective.lines[0].product_hint.name)
        self.assertEqual(effective.lines[0].raw_name, "MILCH 1 L")
        self.assertEqual(effective.lines[0].amount, Decimal("2.58"))
        self.assertTrue(issues)

    def test_incomplete_or_inconsistent_tax_summary_is_optional(self):
        obs = observation()
        for tax in (replace(obs.taxes[0], net=None, tax=None), replace(obs.taxes[0], gross=Decimal("999"))):
            effective, issues = prepare_observation(replace(obs, taxes=(tax,)))
            self.assertEqual(effective.taxes, ())
            self.assertEqual(effective.total, obs.total)
            self.assertTrue(issues)

    def test_oversized_fiscal_key_is_omitted_instead_of_failing_import(self):
        obs = observation()
        obs = replace(obs, fiscal=replace(obs.fiscal, register_serial="S" * 150, tse_transaction="T" * 100))
        effective, issues = prepare_observation(obs)
        self.assertIsNone(effective.fiscal.register_serial)
        self.assertIsNone(effective.fiscal.tse_transaction)
        self.assertEqual(len(issues), 2)
