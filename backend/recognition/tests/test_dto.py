import copy
import json
from decimal import Decimal, localcontext
from pathlib import Path

from django.test import SimpleTestCase

from recognition.dto import DetectionResult, PreparedImage, ReceiptObservation
from recognition.providers.fake import detection_payload, receipt_payload
from recognition.schema_validation import (
    MAX_OUTPUT_BYTES, SchemaValidationError, _schema, load_json,
    observation_issues, validate_detection, validate_observation,
)
from stores.normalize import address_key
from .import_fixtures import lidl_format_payload


class DTOTests(SimpleTestCase):
    def setUp(self):
        self.image = PreparedImage(Path("test.png"), "a" * 64, 1500, 1100)

    def test_k1_geometry_and_decimal_roundtrip(self):
        data = detection_payload(self.image)
        dto = validate_detection(json.dumps(data).encode(), width=1500, height=1100)
        self.assertIsInstance(dto, DetectionResult)
        self.assertEqual(dto.to_dict(), data)
        for position in (1, 2):
            with self.subTest(position=position):
                payload = receipt_payload(position)
                observation = validate_observation(json.dumps(payload))
                self.assertIsInstance(observation, ReceiptObservation)
                self.assertIsInstance(observation.total, Decimal)
                self.assertIsInstance(observation.lines[0].unit_price, Decimal)
                self.assertEqual(observation.to_dict(), payload)
                self.assertEqual(observation_issues(observation), [])

    def test_required_unknown_nullable_enum_and_bool(self):
        edits = [lambda d: d.pop("total"), lambda d: d.update(extra="private"),
                 lambda d: d["merchant"].update(extra=True), lambda d: d.update(operation="purchase"),
                 lambda d: d.update(total=4.42), lambda d: d.update(total=True),
                 lambda d: d["lines"][0].update(position=True), lambda d: d.update(prices_include_tax=0),
                 lambda d: d.update(schema_version="1"), lambda d: d["timestamps"].update(header=None),
                 lambda d: d["merchant"].update(tax_id_type="passport")]
        for edit in edits:
            data = receipt_payload()
            edit(data)
            with self.subTest(edit=edits.index(edit)), self.assertRaises(SchemaValidationError):
                validate_observation(data)

    def test_decimal_grammar_scale_and_bounds(self):
        for bad in ("1e2", "NaN", "Infinity", "1", "1.0", "1.000", "+1.00", " 1.00", "١.00", "1000000000000.00"):
            data = receipt_payload()
            data["total"] = bad
            with self.subTest(value=bad), self.assertRaises(SchemaValidationError):
                validate_observation(data)
        for key, bad in (("quantity", "1.00"), ("unit_price", "-1.0000"), ("unit_price", "10000000000.0000")):
            data = receipt_payload()
            data["lines"][0][key] = bad
            with self.subTest(key=key, bad=bad), self.assertRaises(SchemaValidationError):
                validate_observation(data)

    def test_money_does_not_depend_on_global_decimal_context(self):
        data = receipt_payload()
        with localcontext() as ctx:
            ctx.prec = 2
            obs = validate_observation(data)
            self.assertEqual(str(obs.total), "4.42")
            self.assertEqual(observation_issues(obs), [])
            self.assertEqual(ctx.prec, 2)

    def test_partial_values_are_preserved_with_issues(self):
        data = receipt_payload()
        data["total"] = None
        data["lines"][0]["quantity"] = None
        for field in data["fields"]:
            if field["path"] in ("/total", "/lines/0/quantity"):
                field.update(status="unreadable", confidence=None)
        dto = validate_observation(data)
        self.assertIsNone(dto.total)
        self.assertIsNone(dto.lines[0].quantity)
        self.assertIn({"code": "missing_required", "path": "/total"}, observation_issues(dto))

    def test_geometry_rejects_outside_degenerate_crossed_reversed_and_wrong_counts(self):
        edits = [lambda d: d.update(image_width=0), lambda d: d.update(image_height=1101),
                 lambda d: d.update(receipt_count=1), lambda d: d["receipts"][1].update(id=1),
                 lambda d: d["receipts"][0]["bbox"].update(x_min=-0.1),
                 lambda d: d["receipts"][0]["bbox"].update(x_max=0),
                 lambda d: d["receipts"][0]["quad"][0].update(x=1),
                 lambda d: d["receipts"][0]["quad"].reverse(),
                 lambda d: d["receipts"][0]["quad"].__setitem__(2, d["receipts"][0]["quad"][0]),
                 lambda d: d["receipts"][0].update(quad=d["receipts"][0]["quad"][:3]),
                 lambda d: d["receipts"][0].update(rotation_degrees=181),
                 lambda d: d["receipts"][0].update(confidence=float("nan"))]
        for edit in edits:
            data = detection_payload(self.image)
            edit(data)
            with self.subTest(edit=edits.index(edit)), self.assertRaises(SchemaValidationError):
                validate_detection(data, width=1500, height=1100)
        with self.assertRaises(SchemaValidationError):
            validate_detection(detection_payload(self.image, 11), width=1500, height=1100)
        self.assertEqual(validate_detection(detection_payload(self.image, 0), width=1500, height=1100).receipts, ())

    def test_self_intersection_and_near_zero_quad(self):
        data = detection_payload(self.image)
        q = data["receipts"][0]["quad"]
        q[1], q[2] = q[2], q[1]
        with self.assertRaises(SchemaValidationError):
            validate_detection(data, width=1500, height=1100)
        data = detection_payload(self.image)
        data["receipts"][0]["quad"] = [dict(x=0.1, y=0.1)] * 4
        with self.assertRaises(SchemaValidationError):
            validate_detection(data, width=1500, height=1100)

    def test_json_duplicates_utf8_finite_and_size(self):
        for payload in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":', b'\xff',
                        '{"x":1}'.encode("utf-16"), b" " * (MAX_OUTPUT_BYTES + 1)):
            with self.subTest(payload=payload[:30]), self.assertRaises(SchemaValidationError):
                load_json(payload)

    def test_calendar_precision_and_code_shapes(self):
        edits = [lambda d: d.update(purchased_on="2026-02-30"), lambda d: d.update(local_time="25:01:00"),
                 lambda d: d.update(utc_offset_printed="+14:01"), lambda d: d.update(currency_code="eur"),
                 lambda d: d["store"].update(country_code="XX1"),
                 lambda d: d["timestamps"]["header"].update(precision="minute")]
        for edit in edits:
            data = receipt_payload()
            edit(data)
            with self.subTest(edit=edits.index(edit)), self.assertRaises(SchemaValidationError):
                validate_observation(data)
        data = receipt_payload()
        data.update(local_time="14:35")
        data["timestamps"]["header"].update(time="14:35", precision="minute")
        self.assertEqual(validate_observation(data).local_time, "14:35")

    def test_pointers_are_concrete_known_unique_and_evidenced(self):
        for pointer in ("lines[*].amount", "/unknown", "/lines/00/amount", "/lines/999/amount", "/lines", "/store", "/~2"):
            data = receipt_payload()
            data["fields"][0]["path"] = pointer
            with self.subTest(pointer=pointer), self.assertRaises(SchemaValidationError):
                validate_observation(data)
        data = receipt_payload()
        data["fields"].append(copy.deepcopy(data["fields"][0]))
        with self.assertRaises(SchemaValidationError): validate_observation(data)
        data = receipt_payload()
        data["fields"][0]["status"] = "absent"
        with self.assertRaises(SchemaValidationError): validate_observation(data)

    def test_bounded_arrays_strings_raw_text_and_positions(self):
        edits = [lambda d: d.update(lines=d["lines"] * 251), lambda d: d.update(taxes=d["taxes"] * 51),
                 lambda d: d.update(discounts=d["discounts"] * 1001), lambda d: d.update(warnings=["w"] * 101),
                 lambda d: d.update(receipt_number="x" * 65), lambda d: d.update(raw_text="я" * 524289),
                 lambda d: d["store"].update(name="line\x00name"),
                 lambda d: d["lines"][1].update(position=1)]
        for edit in edits:
            data = receipt_payload()
            edit(data)
            with self.subTest(edit=edits.index(edit)), self.assertRaises(SchemaValidationError):
                validate_observation(data)

    def test_domain_issues_do_not_discard_conflicting_observations(self):
        edits = [(lambda d: d.update(total="1.00"), "total_mismatch"),
                 (lambda d: d["discounts"][0].update(amount="-0.20"), "invalid_value"),
                 (lambda d: d["lines"][3].update(parent_position=99), "invalid_value"),
                 (lambda d: d["taxes"][0].update(gross="999.00"), "tax_mismatch"),
                 (lambda d: d["timestamps"]["header"].update(time="15:35:20"), "invalid_value"),
                 (lambda d: d.update(fields=[]), "identity_conflict")]
        for edit, expected in edits:
            data = receipt_payload()
            edit(data)
            with self.subTest(expected=expected):
                obs = validate_observation(data)
                self.assertIn(expected, [v["code"] for v in observation_issues(obs)])

    def test_every_schema_object_is_closed_and_all_properties_required(self):
        def walk(schema):
            if schema.get("type") == "object":
                self.assertIs(schema["additionalProperties"], False)
                self.assertEqual(set(schema["properties"]), set(schema["required"]))
            for value in schema.get("properties", {}).values(): walk(value)
            if "items" in schema: walk(schema["items"])
        for name in ("detect", "receipt"): walk(_schema(name))

    def test_tax_exclusive_prices_and_line_discount_match_model_rules(self):
        data = receipt_payload(2)
        data.update(prices_include_tax=False,total="6.39")
        data["taxes"][0].update(net="6.00",tax="0.39",gross="6.39")
        self.assertEqual(observation_issues(validate_observation(data)),[])
        data = receipt_payload()
        data["lines"][0]["discount_amount"] = "0.00"
        self.assertIn({"code":"total_mismatch","path":"/lines/0/discount_amount"},observation_issues(validate_observation(data)))

    def test_deposit_return_parent_is_rejected_for_existing_model(self):
        data=receipt_payload()
        data["lines"][3].update(kind="deposit_return",quantity="-1.000",amount="-0.25")
        dto=validate_observation(data)
        self.assertIn({"code":"invalid_value","path":"/lines/3/parent_position"},observation_issues(dto))

    def test_print_line_breaks_normalize_before_validation_without_mutating_input(self):
        for separator in ("\n", "\r", "\r\n", "\t", " \r\n\t "):
            data = receipt_payload()
            address = "Testweg 17" + separator + "88131 Lindau"
            data["store"]["address_raw"] = address
            data["store"]["name"] = "TEST" + separator + "MARKT"
            data["merchant"]["legal_name"] = "TEST" + separator + "GmbH"
            data["lines"][0]["raw_name"] = "MILCH" + separator + "1 L"
            data["lines"][0]["product_hint"]["name"] = "MILCH" + separator + "1 L"
            data["discounts"][0]["name"] = "Rabatt" + separator + "MILCH"
            with self.subTest(separator=separator):
                dto = validate_observation(data)
                self.assertEqual(dto.store.address_raw, "Testweg 17, 88131 Lindau")
                self.assertEqual(address_key(dto.store.address_raw), address_key("Testweg 17 88131 Lindau"))
                self.assertEqual(dto.store.name, "TEST MARKT")
                self.assertEqual(dto.merchant.legal_name, "TEST GmbH")
                self.assertEqual(dto.lines[0].raw_name, "MILCH 1 L")
                self.assertEqual(dto.lines[0].product_hint.name, "MILCH 1 L")
                self.assertEqual(dto.discounts[0].name, "Rabatt MILCH")
                self.assertEqual(data["store"]["address_raw"], address)
                self.assertEqual(validate_observation(json.dumps(data)).to_dict(), dto.to_dict())

    def test_other_controls_and_line_breaks_in_identifiers_are_rejected(self):
        for control in ("\x00", "\x0b", "\x0c", "\x1f", "\x7f", "\x85"):
            data = receipt_payload()
            data["store"]["address_raw"] = "Testweg\n17" + control + "Lindau"
            with self.subTest(control=control), self.assertRaises(SchemaValidationError) as caught:
                validate_observation(data)
            self.assertEqual((caught.exception.path, caught.exception.reason), ("/store/address_raw", "control_character"))
        for section, key in (("store", "branch_code"), ("merchant", "tax_id"), ("fiscal", "register_serial")):
            data = receipt_payload()
            data[section][key] = "TEST\n123"
            with self.subTest(key=key), self.assertRaises(SchemaValidationError) as caught:
                validate_observation(data)
            self.assertEqual(caught.exception.reason, "control_character")

    def test_z_offsets_are_canonical_in_all_timestamp_sources(self):
        for offset in ("Z", "z", "+00:00"):
            data = lidl_format_payload()
            data["utc_offset_printed"] = offset
            for stamp in data["timestamps"].values():
                stamp["utc_offset"] = offset
            with self.subTest(offset=offset):
                dto = validate_observation(data)
                self.assertEqual(dto.utc_offset_printed, "+00:00")
                self.assertEqual(dto.timestamps.fiscal.utc_offset, "+00:00")
                self.assertEqual(dto.timestamps.header.utc_offset, "+00:00")
                self.assertEqual(dto.local_time, "17:01:56")
                self.assertNotIn({"code": "invalid_value", "path": "/timestamps"}, observation_issues(dto))
                self.assertEqual(data["utc_offset_printed"], offset)

    def test_invalid_offsets_still_fail_in_every_source(self):
        for bad in ("UTC", "+25:00", " Z", "Z\n", "+00:60", "+14:01"):
            for source in (None, "header", "fiscal"):
                data = receipt_payload()
                target = data if source is None else data["timestamps"][source]
                target["utc_offset_printed" if source is None else "utc_offset"] = bad
                with self.subTest(bad=bad, source=source), self.assertRaises(SchemaValidationError):
                    validate_observation(data)
