from dataclasses import replace
from decimal import Decimal

from django.test import SimpleTestCase

from recognition.dto import FieldObservation
from recognition.import_policy import prepare_observation
from recognition.importer import _domain_observation, _preflight
from recognition.providers.codex_cli import PACKAGE_ROOT
from recognition.providers.fake import receipt_payload
from recognition.resolution import ResolutionError
from recognition.schema_validation import _schema, validate_observation
from .import_fixtures import observation, sparse_lidl_format_payload


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

    def test_arithmetic_accepts_missing_or_observed_evidence_for_each_operand(self):
        obs = observation()
        for missing, expected in (("quantity", Decimal("2.000")), ("unit_price", Decimal("1.2900")),
                                  ("amount", Decimal("2.58"))):
            operands = [key for key in ("quantity", "unit_price", "amount") if key != missing]
            for observed in ((), (operands[0],), (operands[1],), tuple(operands)):
                with self.subTest(missing=missing, observed=observed):
                    incoming = replace(obs, lines=(replace(obs.lines[0], **{missing: None}),),
                        fields=tuple(f for f in obs.fields if not f.path.startswith("/lines/0/")
                                     or f.path in {"/lines/0/" + key for key in observed}))
                    effective, derived = _domain_observation(incoming)
                    self.assertEqual(getattr(effective.lines[0], missing), expected)
                    self.assertIn("/lines/0/" + missing, derived)
                    self.assertIsNone(getattr(incoming.lines[0], missing))

    def test_arithmetic_blocks_explicit_uncertainty_and_contradictory_operands(self):
        obs = observation()
        for missing in ("quantity", "unit_price", "amount"):
            for operand in (key for key in ("quantity", "unit_price", "amount") if key != missing):
                for status in ("ambiguous", "unreadable", "absent"):
                    with self.subTest(missing=missing, operand=operand, status=status):
                        incoming = replace(obs, lines=(replace(obs.lines[0], **{missing: None}),),
                            fields=(FieldObservation("/lines/0/" + operand, status, None, None),))
                        effective, derived = _domain_observation(incoming)
                        self.assertIsNone(getattr(effective.lines[0], missing))
                        self.assertNotIn("/lines/0/" + missing, derived)
            for status in ("ambiguous", "unreadable"):
                with self.subTest(missing=missing, status=status):
                    incoming = replace(obs, lines=(replace(obs.lines[0], **{missing: None}),),
                        fields=(FieldObservation("/lines/0/" + missing, status, None, None),))
                    effective, derived = _domain_observation(incoming)
                    self.assertIsNone(getattr(effective.lines[0], missing))
                    self.assertNotIn("/lines/0/" + missing, derived)

    def test_arithmetic_quantity_can_supply_missing_piece_unit(self):
        incoming = replace(observation(), fields=())
        incoming = replace(incoming, lines=(replace(incoming.lines[0], quantity=None, unit=None),))
        effective, derived = _domain_observation(incoming)
        self.assertEqual((effective.lines[0].quantity, effective.lines[0].unit), (Decimal("2.000"), "pcs"))
        self.assertIn("/lines/0/quantity", derived)
        self.assertIn("/lines/0/unit", derived)

    def test_piece_unit_does_not_use_explicitly_uncertain_or_absent_count(self):
        obs = observation()
        for status in ("ambiguous", "unreadable", "absent"):
            with self.subTest(status=status):
                incoming = replace(obs, lines=(replace(obs.lines[0], unit=None),),
                    fields=(FieldObservation("/lines/0/quantity", status, None, None),))
                effective, derived = _domain_observation(incoming)
                self.assertIsNone(effective.lines[0].unit)
                self.assertNotIn("/lines/0/unit", derived)

    def test_arithmetic_does_not_round_quantity_or_price_or_divide_by_zero(self):
        obs = observation()
        cases = (
            dict(quantity=None, unit_price=Decimal("3"), amount=Decimal("1")),
            dict(quantity=Decimal("3"), unit_price=None, amount=Decimal("1")),
            dict(quantity=None, unit_price=Decimal("0"), amount=Decimal("0")),
            dict(quantity=Decimal("0"), unit_price=None, amount=Decimal("0")),
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

    def test_amount_only_lines_default_to_one_piece_and_keep_observation(self):
        for kind, amount, quantity, price in (("product", "3.49", "1.000", "3.4900"),
                ("deposit", "0.25", "1.000", "0.2500"),
                ("deposit_return", "-0.25", "-1.000", "0.2500")):
            payload = receipt_payload()
            payload["lines"][0].update(kind=kind, quantity=None, unit_price=None, unit=None, amount=amount)
            incoming = observation(payload)
            with self.subTest(kind=kind):
                effective, derived = _domain_observation(incoming)
                line = effective.lines[0]
                self.assertEqual((line.quantity, line.unit, line.unit_price), (Decimal(quantity), "pcs", Decimal(price)))
                for key in ("quantity", "unit", "unit_price"):
                    self.assertIn("/lines/0/" + key, derived)
                    self.assertIsNone(getattr(incoming.lines[0], key))
                self.assertEqual(line.amount, Decimal(amount))

    def test_amount_only_defaults_without_evidence_include_negative_deposit_return(self):
        for kind, amount, quantity in (("product", "3.49", "1.000"), ("deposit", "0.25", "1.000"),
                                       ("deposit_return", "-0.25", "-1.000")):
            for unit in (None, "pcs"):
                with self.subTest(kind=kind, unit=unit):
                    incoming = replace(observation(), fields=())
                    incoming = replace(incoming, lines=(replace(incoming.lines[0], kind=kind, amount=Decimal(amount),
                                                               quantity=None, unit_price=None, unit=unit),))
                    effective, derived = _domain_observation(incoming)
                    self.assertEqual((effective.lines[0].quantity, effective.lines[0].unit, effective.lines[0].unit_price),
                                     (Decimal(quantity), "pcs", abs(Decimal(amount))))
                    self.assertIn("/lines/0/quantity", derived)
                    self.assertIn("/lines/0/unit_price", derived)
                    self.assertIsNone(incoming.lines[0].quantity)

    def test_amount_only_defaults_require_missing_fields_and_usable_amount(self):
        edits = (
            {"amount": None}, {"amount": "-1.00"}, {"kind": "service"}, {"kind": "deposit_return"},
            {"unit": "kg"}, {"raw_name": "APFEL pro kg"}, {"quantity": "0.500"},
        )
        for edit in edits:
            payload = receipt_payload()
            payload["lines"][0].update(quantity=None, unit_price=None, unit=None, amount="1.00")
            payload["lines"][0].update(edit)
            incoming = observation(payload)
            with self.subTest(edit=edit):
                effective, derived = _domain_observation(incoming)
                self.assertNotIn("/lines/0/quantity", derived)
                self.assertEqual(effective.lines[0].quantity, incoming.lines[0].quantity)
        for key in ("quantity", "unit_price", "unit", "amount"):
            for status in (("ambiguous", "unreadable", "absent") if key == "amount" else ("ambiguous", "unreadable")):
                payload = receipt_payload()
                payload["lines"][0].update(quantity=None, unit_price=None, unit=None)
                incoming = observation(payload)
                incoming = replace(incoming, fields=tuple(f for f in incoming.fields if f.path != "/lines/0/" + key)
                                   + (FieldObservation("/lines/0/" + key, status, None, None),))
                with self.subTest(key=key, status=status):
                    effective, derived = _domain_observation(incoming)
                    self.assertIsNone(effective.lines[0].quantity)
                    self.assertNotIn("/lines/0/quantity", derived)

    def test_other_weighted_line_does_not_block_integer_piece_or_amount_defaults(self):
        for quantity, price, amount in (("2.000", "1.2900", "2.58"), ("-5.000", "0.2500", "-1.25"),
                                       (None, None, "3.49")):
            payload = receipt_payload()
            payload["raw_text"] = "APFEL 2 EUR/kg\nMILCH 1.29 x 2\n"
            payload["lines"][0].update(quantity=quantity, unit_price=price, unit=None, amount=amount,
                                       kind="deposit_return" if amount.startswith("-") else "product")
            with self.subTest(quantity=quantity):
                effective, derived = _domain_observation(observation(payload))
                self.assertEqual(effective.lines[0].unit, "pcs")
                self.assertIn("/lines/0/unit", derived)
                self.assertEqual((effective.lines[1].quantity, effective.lines[1].unit, effective.lines[1].unit_price),
                                 (Decimal("0.500"), "kg", Decimal("2.0000")))

    def test_contradictory_printed_values_are_preserved_without_defaults(self):
        payload = receipt_payload()
        payload["lines"][0].update(quantity="2.000", unit_price="1.2900", amount="3.49", unit=None)
        payload.update(total="5.33", taxes=[])
        incoming = observation(payload)
        effective, derived = _domain_observation(incoming)
        self.assertEqual((effective.lines[0].quantity, effective.lines[0].unit_price, effective.lines[0].amount),
                         (Decimal("2.000"), Decimal("1.2900"), Decimal("3.49")))
        self.assertNotIn("/lines/0/quantity", derived)
        self.assertNotIn("/lines/0/unit_price", derived)
        with self.assertRaises(ResolutionError) as caught:
            _preflight(effective, derived)
        self.assertIn(("total_mismatch", "/lines/0/amount"),
                      [(v["code"], v["field"]) for v in caught.exception.issues])

    def test_preflight_blocks_absent_or_unreadable_evidence_for_populated_line_values(self):
        # validate_observation rejects these contradictions too; direct DTO
        # consumers must not bypass the import guard with complete numbers.
        for key in ("quantity", "unit_price", "amount", "unit"):
            for status in ("absent", "unreadable"):
                with self.subTest(key=key, status=status):
                    incoming = replace(observation(),
                        fields=(FieldObservation("/lines/0/" + key, status, None, None),))
                    effective, notices = prepare_observation(incoming)
                    effective, derived = _domain_observation(effective)
                    with self.assertRaises(ResolutionError) as caught:
                        _preflight(effective, derived)
                    self.assertIn(("invalid_value", "/lines/0/" + key),
                                  [(v["code"], v["field"]) for v in caught.exception.issues])

    def test_sparse_real_response_shape_passes_full_preflight_without_mutating_payload(self):
        payload = sparse_lidl_format_payload()
        self.assertEqual([f["path"] for f in payload["fields"] if f["path"].startswith("/lines/")],
                         ["/lines/1/raw_name", "/lines/2/raw_name"])
        incoming = validate_observation(payload)
        effective, notices = prepare_observation(incoming)
        effective, derived = _domain_observation(effective)
        self.assertEqual(_preflight(effective, derived), [])
        self.assertEqual((effective.lines[1].quantity, effective.lines[1].unit, effective.lines[1].unit_price),
                         (Decimal("1.000"), "pcs", Decimal("3.4900")))
        self.assertEqual(effective.lines[2].unit, "pcs")
        self.assertEqual(effective.lines[0].unit, "kg")
        self.assertEqual((effective.lines[21].quantity, effective.lines[21].unit), (Decimal("-5.000"), "pcs"))
        self.assertIsNone(incoming.lines[1].quantity)
        self.assertIn("\n", payload["store"]["address_raw"])
        self.assertEqual(payload["utc_offset_printed"], "Z")

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
