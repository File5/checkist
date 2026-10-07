"""Check of a model answer. Pure functions, no database.

``validate_response`` rejects an answer as a whole; ``drop_reason`` names the
reason one valid item is not applied. Reasons that need the catalog
(``unknown_generic``, ambiguity, the rejection memory, ...) belong to
``classification.services.apply``.
"""
import json
import math
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from classification import taxonomy
from classification.dto import EXISTING, NEW, UNKNOWN, ClassificationResponse, Suggestion
from recognition.schema_validation import MAX_OUTPUT_BYTES, SchemaValidationError, load_json

SCHEMA_PATH = Path(__file__).resolve().parent / "schemas" / "classification.schema.json"


class ClassificationOutputError(ValueError):
    """The whole answer is invalid. Only a fixed reason and a schema path, never input values."""

    def __init__(self, path="", reason="invalid"):
        self.path = path
        self.reason = reason
        super().__init__("Classification output failed validation.")


def _fail(path, reason):
    raise ClassificationOutputError(path, reason)


@lru_cache(maxsize=1)
def schema():
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


_TYPES = {
    "null": lambda value: value is None,
    "object": lambda value: type(value) is dict,
    "array": lambda value: type(value) is list,
    "string": lambda value: type(value) is str,
    "integer": lambda value: type(value) is int,
    "number": lambda value: type(value) in (int, float) and math.isfinite(value),
}


def _validate(value, rules, path=""):
    """The subset of JSON Schema the schema file uses."""
    kinds = rules.get("type")
    if kinds and not any(_TYPES[kind](value) for kind in ([kinds] if isinstance(kinds, str) else kinds)):
        _fail(path, "type")
    if "enum" in rules and not any(type(value) is type(option) and value == option for option in rules["enum"]):
        _fail(path, "enum")
    if type(value) is dict:
        properties = rules.get("properties", {})
        if rules.get("additionalProperties") is False and set(value) - set(properties):
            _fail(path, "unknown_key")  # the key itself is untrusted and stays out of diagnostics
        for key in rules.get("required", ()):
            if key not in value:
                _fail(f"{path}/{key}", "missing_key")
        for key, item in value.items():
            if key in properties:
                _validate(item, properties[key], f"{path}/{key}")
    elif type(value) is list:
        if not rules.get("minItems", 0) <= len(value) <= rules.get("maxItems", math.inf):
            _fail(path, "array_size")
        for index, item in enumerate(value):
            _validate(item, rules.get("items", {}), f"{path}/{index}")
    elif type(value) is str:
        if not rules.get("minLength", 0) <= len(value) <= rules.get("maxLength", math.inf):
            _fail(path, "string_size")
    elif type(value) in (int, float):
        if not rules.get("minimum", -math.inf) <= value <= rules.get("maximum", math.inf):
            _fail(path, "range")


def validate_response(data, *, product_ids):
    """``ClassificationResponse`` for the products of one batch, or ``ClassificationOutputError``.

    ``data`` is the JSON text (str/bytes) or the parsed object. Every product of
    the batch has exactly one item and there are no other ids.
    """
    if isinstance(data, (str, bytes)):
        try:
            data = load_json(data)
        except SchemaValidationError as error:
            _fail("", error.reason)
    else:
        try:
            if len(json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_OUTPUT_BYTES:
                _fail("", "output_too_large")
        except (TypeError, ValueError, UnicodeError, RecursionError, OverflowError) as error:
            if isinstance(error, ClassificationOutputError):
                raise
            _fail("", "invalid_json")
    _validate(data, schema())
    expected, seen, items = set(product_ids), set(), []
    for index, item in enumerate(data["items"]):
        path = f"/items/{index}"
        product_id = item["product_id"]
        if product_id not in expected:
            _fail(f"{path}/product_id", "foreign_product")
        if product_id in seen:
            _fail(f"{path}/product_id", "duplicate_product")
        seen.add(product_id)
        if item["decision"] == EXISTING and item["generic_id"] is None:
            _fail(f"{path}/generic_id", "decision_fields")
        if item["decision"] == NEW:
            for key in ("generic_name", "category_path", "base_unit"):
                if item[key] is None:
                    _fail(f"{path}/{key}", "decision_fields")
        items.append(Suggestion(
            product_id=product_id, decision=item["decision"], generic_id=item["generic_id"],
            generic_name=item["generic_name"],
            category_path=None if item["category_path"] is None else tuple(item["category_path"]),
            base_unit=item["base_unit"],
            confidence=None if item["confidence"] is None else Decimal(str(item["confidence"])).quantize(
                Decimal("0.01")),
            note=item["note"],
        ))
    if seen != expected:
        _fail("/items", "missing_product")
    return ClassificationResponse(items=tuple(items))


def drop_reason(suggestion):
    """Why a valid item is not applied, judged without the catalog; ``None`` — nothing found.

    For ``existing`` the name, the path and the unit are ignored even when filled.
    """
    if suggestion.decision == UNKNOWN:
        return "unknown"
    if suggestion.decision != NEW:
        return None
    path = suggestion.category_path
    if taxonomy.is_service_name(suggestion.generic_name) or any(taxonomy.is_service_name(name) for name in path):
        return "service_target"
    if not taxonomy.is_valid_name(suggestion.generic_name):
        return "name_invalid"
    keys = [taxonomy.name_key(name) for name in path]
    if not all(taxonomy.is_valid_name(name) for name in path) \
            or any(first == second for first, second in zip(keys, keys[1:])):
        return "category_invalid"
    return None
