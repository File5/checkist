import copy
import json
from decimal import Decimal

from django.test import SimpleTestCase

from classification.dto import ClassificationResponse, Suggestion
from classification.validation import (
    SCHEMA_PATH, ClassificationOutputError, drop_reason, schema, validate_response,
)

ITEM_KEYS = ["product_id", "decision", "generic_id", "generic_name", "category_path", "base_unit", "confidence", "note"]


def item(product_id, decision="unknown", **fields):
    return {
        "product_id": product_id, "decision": decision, "generic_id": None, "generic_name": None,
        "category_path": None, "base_unit": None, "confidence": None, "note": None, **fields,
    }


def existing(product_id, generic_id=7, **fields):
    return item(product_id, "existing", generic_id=generic_id, **fields)


def new(product_id, name="Кефир", path=("Продукты питания", "Молочные продукты"), unit="l", **fields):
    return item(product_id, "new", generic_name=name, category_path=list(path), base_unit=unit, **fields)


def answer(*items):
    return {"schema_version": "1", "items": list(items)}


VALID = answer(existing(1), new(2, confidence=0.75, note="Кисломолочный напиток"), item(3))


class ValidResponseTests(SimpleTestCase):
    def test_parsed_object_text_and_bytes_give_the_same_response(self):
        response = validate_response(VALID, product_ids=(1, 2, 3))
        self.assertIsInstance(response, ClassificationResponse)
        self.assertEqual([entry.product_id for entry in response.items], [1, 2, 3])
        text = json.dumps(VALID, ensure_ascii=False)
        self.assertEqual(validate_response(text, product_ids=[1, 2, 3]), response)
        self.assertEqual(validate_response(text.encode("utf-8"), product_ids={1, 2, 3}), response)

    def test_suggestion_fields_and_round_trip(self):
        response = validate_response(VALID, product_ids=(1, 2, 3))
        self.assertEqual(response.items[1], Suggestion(
            product_id=2, decision="new", generic_id=None, generic_name="Кефир",
            category_path=("Продукты питания", "Молочные продукты"), base_unit="l",
            confidence=Decimal("0.75"), note="Кисломолочный напиток",
        ))
        # to_dict() is itself a valid answer: the private attempt stores it.
        self.assertEqual(response.to_dict(), VALID)
        self.assertEqual(validate_response(response.to_dict(), product_ids=(1, 2, 3)), response)

    def test_confidence_keeps_two_decimals(self):
        response = validate_response(answer(existing(1, confidence=0.333), existing(2, confidence=1)), product_ids=(1, 2))
        self.assertEqual([entry.confidence for entry in response.items], [Decimal("0.33"), Decimal("1.00")])

    def test_item_order_of_the_answer_is_kept(self):
        response = validate_response(answer(item(3), item(1), item(2)), product_ids=(1, 2, 3))
        self.assertEqual([entry.product_id for entry in response.items], [3, 1, 2])

    def test_filled_fields_of_existing_and_unknown_are_allowed(self):
        # The model may fill them anyway; applying ignores them.
        data = answer(
            existing(1, generic_name="Молоко", category_path=["Продукты питания"], base_unit="kg"),
            item(2, generic_id=5, generic_name="Сыр"),
        )
        response = validate_response(data, product_ids=(1, 2))
        self.assertEqual(response.items[0].base_unit, "kg")
        self.assertEqual(response.items[1].generic_id, 5)

    def test_empty_batch(self):
        self.assertEqual(validate_response(answer(), product_ids=()).items, ())

    def test_control_characters_do_not_fail_the_whole_answer(self):
        # A bad name is the fault of one item (name_invalid), not of the answer.
        response = validate_response(answer(new(1, name="Кефир\x00")), product_ids=(1,))
        self.assertEqual(drop_reason(response.items[0]), "name_invalid")


class InvalidResponseTests(SimpleTestCase):
    def assertInvalid(self, data, reason, *, product_ids=(1, 2, 3), path=None):
        with self.assertRaises(ClassificationOutputError) as caught:
            validate_response(data, product_ids=product_ids)
        self.assertEqual(caught.exception.reason, reason)
        if path is not None:
            self.assertEqual(caught.exception.path, path)
        # Diagnostics never repeat the input.
        self.assertEqual(str(caught.exception), "Classification output failed validation.")

    def changed(self, index, **fields):
        data = copy.deepcopy(VALID)
        data["items"][index].update(fields)
        return data

    def test_not_json(self):
        for text in ("", "not json", "{", b"\xff\xfe", "[1, 2"):
            with self.subTest(text=text):
                self.assertInvalid(text, "invalid_json")
        self.assertInvalid(json.dumps(VALID).encode("utf-16"), "invalid_json")

    def test_larger_than_four_mebibytes(self):
        padding = " " * (4 * 1024 * 1024)
        self.assertInvalid(json.dumps(VALID) + padding, "output_too_large")
        # A parsed object is measured too, before the schema looks at it.
        self.assertInvalid(answer(*[item(1, note="я" * 200)] * 20000), "output_too_large")

    def test_duplicate_key(self):
        self.assertInvalid('{"schema_version": "1", "schema_version": "1", "items": []}', "duplicate_key", product_ids=())
        text = json.dumps(VALID).replace('"note": null}', '"note": null, "note": null}', 1)
        self.assertInvalid(text, "duplicate_key")

    def test_nan_and_infinity(self):
        for constant in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(constant=constant):
                text = json.dumps(self.changed(0, confidence=0.5)).replace("0.5", constant, 1)
                self.assertInvalid(text, "nonfinite")
        self.assertInvalid(self.changed(0, confidence=float("nan")), "invalid_json")
        self.assertInvalid(self.changed(0, confidence=float("inf")), "invalid_json")

    def test_top_level_shape(self):
        for data in ([], 5, None, True):
            with self.subTest(data=data):
                self.assertInvalid(data, "type", path="")
        self.assertInvalid({"items": []}, "missing_key", path="/schema_version", product_ids=())
        self.assertInvalid({"schema_version": "1"}, "missing_key", path="/items", product_ids=())
        self.assertInvalid({**VALID, "unexpected": True}, "unknown_key", path="")
        self.assertInvalid({"schema_version": "1", "items": {}}, "type", path="/items", product_ids=())

    def test_schema_version(self):
        for version in ("2", "", "1.0", 1, None):
            with self.subTest(version=version):
                self.assertInvalid({**VALID, "schema_version": version}, "type" if not isinstance(version, str) else "enum")

    def test_item_shape(self):
        self.assertInvalid(answer("text"), "type", path="/items/0", product_ids=())
        self.assertInvalid(self.changed(1, secret="x"), "unknown_key", path="/items/1")
        for key in ITEM_KEYS:
            with self.subTest(missing=key):
                data = copy.deepcopy(VALID)
                del data["items"][2][key]
                self.assertInvalid(data, "missing_key", path=f"/items/2/{key}")

    def test_more_than_fifty_items(self):
        ids = tuple(range(1, 52))
        self.assertInvalid(answer(*map(item, ids)), "array_size", product_ids=ids, path="/items")
        self.assertEqual(len(validate_response(answer(*map(item, ids[:50])), product_ids=ids[:50]).items), 50)

    def test_field_types_and_ranges(self):
        cases = (
            ({"product_id": "1"}, "type"), ({"product_id": True}, "type"), ({"product_id": 1.0}, "type"),
            ({"product_id": 0}, "range"), ({"product_id": None}, "type"),
            ({"decision": "maybe"}, "enum"), ({"decision": None}, "type"), ({"decision": "Existing"}, "enum"),
            ({"generic_id": "7"}, "type"), ({"generic_id": 0}, "range"), ({"generic_id": True}, "type"),
            ({"generic_name": 5}, "type"), ({"generic_name": "я" * 101}, "string_size"),
            ({"category_path": "Продукты"}, "type"), ({"category_path": []}, "array_size"),
            ({"category_path": ["а", "б", "в", "г"]}, "array_size"), ({"category_path": [""]}, "string_size"),
            ({"category_path": ["я" * 101]}, "string_size"), ({"category_path": [None]}, "type"),
            ({"base_unit": "g"}, "enum"), ({"base_unit": "KG"}, "enum"), ({"base_unit": 1}, "type"),
            ({"confidence": "0.5"}, "type"), ({"confidence": -0.01}, "range"), ({"confidence": 1.01}, "range"),
            ({"confidence": True}, "type"),
            ({"note": 5}, "type"), ({"note": "я" * 201}, "string_size"),
        )
        for fields, reason in cases:
            with self.subTest(fields=fields):
                self.assertInvalid(self.changed(1, **fields), reason)
        # The boundaries themselves pass.
        validate_response(self.changed(1, generic_name="я" * 100, note="я" * 200, confidence=0), product_ids=(1, 2, 3))
        validate_response(self.changed(1, category_path=["а", "б", "в"], confidence=1), product_ids=(1, 2, 3))

    def test_product_outside_the_batch(self):
        self.assertInvalid(answer(item(1), item(2), item(3), item(4)), "foreign_product", path="/items/3/product_id")
        self.assertInvalid(answer(item(9)), "foreign_product", product_ids=(1,))

    def test_repeated_product(self):
        self.assertInvalid(answer(item(1), item(2), item(2), item(3)), "duplicate_product", path="/items/2/product_id")

    def test_missing_product(self):
        self.assertInvalid(answer(item(1), item(2)), "missing_product", path="/items")
        self.assertInvalid(answer(), "missing_product", product_ids=(1,))

    def test_existing_needs_a_generic_id(self):
        self.assertInvalid(answer(item(1, "existing")), "decision_fields", product_ids=(1,), path="/items/0/generic_id")

    def test_new_needs_name_path_and_unit(self):
        for key in ("generic_name", "category_path", "base_unit"):
            with self.subTest(key=key):
                self.assertInvalid(answer(new(1) | {key: None}), "decision_fields", product_ids=(1,), path=f"/items/0/{key}")


class SchemaFileTests(SimpleTestCase):
    """The schema file is what Codex gets through --output-schema; the check interprets the same file."""

    def test_file_is_strict_json_schema_of_version_one(self):
        loaded = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        self.assertEqual(loaded, schema())
        self.assertEqual(loaded["$schema"], "https://json-schema.org/draft/2020-12/schema")
        self.assertIs(loaded["additionalProperties"], False)
        self.assertEqual(loaded["required"], ["schema_version", "items"])
        self.assertEqual(loaded["properties"]["schema_version"], {"type": "string", "enum": ["1"]})
        items = loaded["properties"]["items"]
        self.assertEqual((items["type"], items["maxItems"]), ("array", 50))
        entry = items["items"]
        self.assertIs(entry["additionalProperties"], False)
        # Every key is required, as in the recognition schemas.
        self.assertEqual(entry["required"], ITEM_KEYS)
        self.assertEqual(list(entry["properties"]), ITEM_KEYS)
        self.assertEqual(entry["properties"]["decision"]["enum"], ["existing", "new", "unknown"])
        self.assertEqual(entry["properties"]["base_unit"]["enum"], ["kg", "l", "pcs", None])
        self.assertEqual(entry["properties"]["category_path"]["maxItems"], 3)

    def test_file_ends_with_one_line_feed_and_has_no_carriage_returns(self):
        raw = SCHEMA_PATH.read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertTrue(raw.endswith(b"}\n"))

    def test_dto_keys_match_the_schema(self):
        response = validate_response(VALID, product_ids=(1, 2, 3))
        self.assertEqual(list(response.to_dict()), schema()["required"])
        self.assertEqual(list(response.items[0].to_dict()), ITEM_KEYS)

    def test_examples_agree_with_the_schema_keywords(self):
        """Each keyword of the file decides at least one example: removing it would change the verdict."""
        entry = schema()["properties"]["items"]["items"]["properties"]
        examples = (
            ("product_id", "minimum", 0), ("generic_id", "minimum", 0),
            ("generic_name", "maxLength", "я" * 101), ("note", "maxLength", "я" * 201),
            ("category_path", "minItems", []), ("category_path", "maxItems", ["а"] * 4),
            ("confidence", "minimum", -1), ("confidence", "maximum", 2),
        )
        for key, keyword, value in examples:
            with self.subTest(key=key, keyword=keyword):
                self.assertIn(keyword, entry[key])
                with self.assertRaises(ClassificationOutputError):
                    validate_response(answer(new(1) | {key: value}), product_ids=(1,))
        self.assertEqual(entry["category_path"]["items"], {"type": "string", "minLength": 1, "maxLength": 100})


class DropReasonTests(SimpleTestCase):
    def reason(self, entry):
        return drop_reason(validate_response(answer(entry), product_ids=(entry["product_id"],)).items[0])

    def test_unknown_is_an_answer_not_an_error(self):
        self.assertEqual(self.reason(item(1)), "unknown")

    def test_valid_items_have_no_reason(self):
        self.assertIsNone(self.reason(existing(1)))
        self.assertIsNone(self.reason(new(1)))
        self.assertIsNone(self.reason(new(1, name="SSD-накопитель", path=("Электроника",), unit="pcs")))
        # For existing the other fields are ignored even when they are wrong.
        self.assertIsNone(self.reason(existing(1, generic_name="Не разобрано", category_path=["Milk", "Milk"])))

    def test_service_target(self):
        for name in ("Не разобрано", "не  РАЗОБРАНО"):
            with self.subTest(name=name):
                self.assertEqual(self.reason(new(1, name=name)), "service_target")
                self.assertEqual(self.reason(new(1, path=("Продукты питания", name))), "service_target")
                self.assertEqual(self.reason(new(1, path=(name,))), "service_target")

    def test_name_invalid(self):
        for name in ("", "   ", "Milk", "12345", "Кефир\x00", "\x1bКефир"):
            with self.subTest(name=name):
                self.assertEqual(self.reason(new(1, name=name)), "name_invalid")
        self.assertIsNone(self.reason(new(1, name="я" * 100)))

    def test_category_invalid(self):
        for path in (("Milk",), ("Продукты питания", "   "), ("Продукты\x00",), ("Продукты", "Dairy", "Кефир")):
            with self.subTest(path=path):
                self.assertEqual(self.reason(new(1, path=path)), "category_invalid")

    def test_neighbouring_path_elements_must_differ(self):
        self.assertEqual(self.reason(new(1, path=("Напитки", "напитки"))), "category_invalid")
        self.assertEqual(self.reason(new(1, path=("Еда", "Ёлка", "Елка"))), "category_invalid")
        # The same name under another parent is an ordinary tree.
        self.assertIsNone(self.reason(new(1, path=("Напитки", "Соки", "Напитки"))))
