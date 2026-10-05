"""Strict JSON/DTO validation, using only the standard library.

Schemas and this small interpreter share structural constraints. Geometry and
JSON Pointer checks are additional domain constraints. Import eligibility is
reported separately by observation_issues so incomplete OCR is retained.
"""
import json
import math
import re
import unicodedata
from datetime import date, time
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from recognition.dto import DetectionResult, ReceiptObservation, _typed
from recognition.geometry import GeometryError, validate_geometry

MAX_OUTPUT_BYTES = 4 * 1024 * 1024
SCHEMA_DIR = Path(__file__).resolve().parent / "schemas"


class SchemaValidationError(ValueError):
    """Only fixed reason codes and schema paths, never input values."""
    def __init__(self, path="", reason="invalid"):
        self.path = path
        self.reason = reason
        super().__init__("Recognition output failed validation.")


def _fail(path, reason):
    raise SchemaValidationError(path, reason)


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("", "duplicate_key")
        result[key] = value
    return result


def _constant(value):
    _fail("", "nonfinite")


def load_json(payload, *, max_bytes=MAX_OUTPUT_BYTES):
    if not isinstance(payload, (str, bytes)):
        _fail("", "json_type")
    try:
        if len(payload.encode("utf-8") if isinstance(payload, str) else payload) > max_bytes:
            _fail("", "output_too_large")
        # Explicit UTF-8; json.loads(bytes) would also accept UTF-16/UTF-32.
        text = payload.decode("utf-8") if isinstance(payload, bytes) else payload
        return json.loads(text, object_pairs_hook=_pairs, parse_constant=_constant)
    except (UnicodeError, json.JSONDecodeError, RecursionError, OverflowError):
        _fail("", "invalid_json")


@lru_cache(maxsize=2)
def _schema(name):
    return json.loads((SCHEMA_DIR / f"{name}.schema.json").read_text(encoding="utf-8"))


def _matches(value, kind):
    return {
        "null": lambda: value is None,
        "object": lambda: type(value) is dict,
        "array": lambda: type(value) is list,
        "string": lambda: type(value) is str,
        "integer": lambda: type(value) is int,
        "number": lambda: type(value) in (int, float) and math.isfinite(value),
        "boolean": lambda: type(value) is bool,
    }[kind]()


def _validate(value, schema, path=""):
    kinds = schema.get("type")
    if kinds and not any(_matches(value, k) for k in ([kinds] if isinstance(kinds, str) else kinds)):
        _fail(path, "type")
    if "enum" in schema and not any(type(value) is type(v) and value == v for v in schema["enum"]):
        _fail(path, "enum")
    if value is None:
        return
    if type(value) is dict:
        props = schema["properties"]
        if set(value) - set(props):
            # Do not include untrusted unknown keys in diagnostics.
            _fail(path, "unknown_key")
        for key in schema["required"]:
            if key not in value:
                _fail(path + "/" + key, "missing_key")
        for key in props:
            _validate(value[key], props[key], path + "/" + key)
    elif type(value) is list:
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 10000):
            _fail(path, "array_size")
        for i, item in enumerate(value):
            _validate(item, schema["items"], path + f"/{i}")
    elif type(value) is str:
        if len(value) > schema.get("maxLength", 255):
            _fail(path, "string_size")
        if "pattern" in schema and not re.fullmatch(schema["pattern"], value, flags=re.ASCII):
            _fail(path, "pattern")
        if any(unicodedata.category(c) in ("Cs", "Cc") and
               not (path == "/raw_text" and c in "\n\r\t") for c in value):
            _fail(path, "control_character")
        if path == "/raw_text" and len(value.encode("utf-8")) > 1024 * 1024:
            _fail(path, "string_size")
    elif type(value) in (int, float):
        if not math.isfinite(value) or not schema.get("minimum", -math.inf) <= value <= schema.get("maximum", math.inf):
            _fail(path, "range")


def _bounded(data, schema):
    try:
        if len(json.dumps(data, ensure_ascii=False, allow_nan=False).encode("utf-8")) > MAX_OUTPUT_BYTES:
            _fail("", "output_too_large")
        _validate(data, schema)
    except (TypeError, UnicodeError, RecursionError, OverflowError, ValueError) as exc:
        if isinstance(exc, SchemaValidationError):
            raise
        _fail("", "invalid_json")


def validate_detection(data, *, width, height):
    if isinstance(data, (bytes, str)):
        data = load_json(data)
    _bounded(data, _schema("detect"))
    if type(width) is not int or type(height) is not int or min(width, height) <= 0:
        raise ValueError("Expected positive integer image dimensions.")
    if (data["image_width"], data["image_height"]) != (width, height):
        _fail("", "image_dimensions")
    if data["receipt_count"] != len(data["receipts"]):
        _fail("/receipt_count", "receipt_count")
    ids = set()
    for i, receipt in enumerate(data["receipts"]):
        path = f"/receipts/{i}"
        if receipt["id"] in ids:
            _fail(path + "/id", "duplicate_id")
        ids.add(receipt["id"])
        try:
            validate_geometry(receipt["bbox"], receipt["quad"], receipt["rotation_degrees"])
        except GeometryError as error:
            _fail(path + ("/bbox" if error.reason == "area" else "/quad"), error.reason)
    return _typed(DetectionResult, data)


def _calendar(value, kind, path):
    if value is None:
        return
    pattern = {"date": r"[0-9]{4}-[0-9]{2}-[0-9]{2}", "time": r"[0-9]{2}:[0-9]{2}(:[0-9]{2})?",
               "offset": r"[+-][0-9]{2}:[0-9]{2}"}[kind]
    if not re.fullmatch(pattern, value):
        _fail(path, "calendar")
    try:
        if kind == "date":
            date.fromisoformat(value)
        elif kind == "time":
            time.fromisoformat(value)
        elif int(value[1:3]) > 14 or int(value[4:6]) > 59 or (int(value[1:3]) == 14 and value[4:6] != "00"):
            _fail(path, "offset")
    except ValueError:
        _fail(path, "calendar")


def _pointer(data, pointer):
    if not pointer.startswith("/") or re.search(r"~(?![01])", pointer):
        _fail("/fields", "pointer")
    obj = data
    for raw in pointer[1:].split("/"):
        key = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(obj, dict) and key in obj:
            obj = obj[key]
        elif isinstance(obj, list) and re.fullmatch(r"0|[1-9][0-9]*", key) and int(key) < len(obj):
            obj = obj[int(key)]
        else:
            _fail("/fields", "pointer")
    if isinstance(obj, (dict, list)) or pointer.startswith(("/fields/", "/warnings/")) or pointer == "/schema_version":
        _fail("/fields", "pointer")
    return obj


def validate_observation(data):
    if isinstance(data, (bytes, str)):
        data = load_json(data)
    _bounded(data, _schema("receipt"))
    for section in ("merchant", "store"):
        code = data[section]["country_code"]
        if code is not None and not re.fullmatch(r"[A-Z]{2}", code):
            _fail("/" + section + "/country_code", "country_code")
    if data["currency_code"] is not None and not re.fullmatch(r"[A-Z]{3}", data["currency_code"]):
        _fail("/currency_code", "currency_code")
    for key, kind in (("purchased_on", "date"), ("local_time", "time"), ("utc_offset_printed", "offset")):
        _calendar(data[key], kind, "/" + key)
    for source, stamp in data["timestamps"].items():
        for key, kind in (("date", "date"), ("time", "time"), ("utc_offset", "offset")):
            _calendar(stamp[key], kind, f"/timestamps/{source}/{key}")
        precision = stamp["precision"]
        expected = "second" if stamp["time"] and len(stamp["time"]) == 8 else "minute" if stamp["time"] else "date" if stamp["date"] else None
        if precision != expected:
            _fail(f"/timestamps/{source}/precision", "time_precision")
    paths = set()
    for field in data["fields"]:
        value = _pointer(data, field["path"])
        if field["path"] in paths:
            _fail("/fields", "duplicate_pointer")
        paths.add(field["path"])
        if field["status"] == "observed" and value in (None, ""):
            _fail("/fields", "evidence")
        if field["status"] in ("absent", "unreadable") and value is not None:
            _fail("/fields", "evidence")
    for collection in ("lines", "discounts"):
        positions = [v["position"] for v in data[collection]]
        if len(positions) != len(set(positions)):
            _fail("/" + collection, "duplicate_position")
    return _typed(ReceiptObservation, data)


def observation_issues(observation):
    """Raw domain findings, without losing structurally valid observations.

    Importer must additionally resolve country/store/timezone, FK and identity,
    run full_clean and validate_receipt inside its transaction. This is not an
    authorization or deduplication decision. The importer applies its optional
    field policy first; findings alone do not mean needs_review.
    """
    from receipts.decimal_math import price_context

    issues = []
    def issue(code, path):
        item = {"code": code, "path": path}
        if item not in issues:
            issues.append(item)

    for key in ("operation", "currency_code", "purchased_on", "local_time", "total"):
        if getattr(observation, key) in (None, ""):
            issue("missing_required", "/" + key)
    for key in ("country_code", "name", "address_raw"):
        if getattr(observation.store, key) in (None, ""):
            issue("missing_required", "/store/" + key)
    if not observation.lines:
        issue("missing_required", "/lines")
    stamp = observation.timestamps.fiscal
    if stamp.date is None and stamp.time is None:
        stamp = observation.timestamps.header
    if any(v is not None and v != getattr(observation, old) for v, old in (
            (stamp.date, "purchased_on"), (stamp.time, "local_time"), (stamp.utc_offset, "utc_offset_printed"))):
        issue("invalid_value", "/timestamps")
    evidence = {f.path: f.status for f in observation.fields}
    # The caller may use only observed identity facts to build strong keys.
    for key in fields_of_identity(observation):
        if evidence.get(key) != "observed":
            issue("identity_conflict", key)
    lines = {line.position: line for line in observation.lines}
    with price_context():
        for i, line in enumerate(observation.lines):
            path = f"/lines/{i}"
            for key in ("raw_name", "kind", "quantity", "unit", "unit_price", "amount"):
                if getattr(line, key) in (None, ""):
                    issue("missing_required", path + "/" + key)
            if line.quantity == 0 or (line.discount_amount is not None and line.discount_amount < 0):
                issue("invalid_value", path)
            if line.quantity is not None and line.amount is not None and line.quantity * line.amount < 0:
                issue("invalid_value", path)
            if line.kind == "deposit_return" and line.amount is not None and line.amount > 0:
                issue("invalid_value", path + "/amount")
            if line.parent_position is not None and (line.kind != "deposit" or
                    line.parent_position not in lines or line.parent_position == line.position or
                    lines[line.parent_position].kind != "product"):
                issue("invalid_value", path + "/parent_position")
            if None not in (line.quantity, line.unit_price, line.amount):
                expected = line.quantity * line.unit_price
                if abs(expected - line.amount) > Decimal("0.01"):
                    issue("total_mismatch", path + "/amount")
        for i, discount in enumerate(observation.discounts):
            if discount.amount is None:
                issue("missing_required", f"/discounts/{i}/amount")
            elif discount.amount <= 0:
                issue("invalid_value", f"/discounts/{i}/amount")
            if discount.line_position is not None and discount.line_position not in lines:
                issue("invalid_value", f"/discounts/{i}/line_position")
        for i, line in enumerate(observation.lines):
            linked = [d for d in observation.discounts if d.line_position == line.position]
            if line.discount_amount is not None and all(d.amount is not None for d in linked):
                if line.discount_amount != sum((d.amount for d in linked), Decimal(0)):
                    issue("total_mismatch", f"/lines/{i}/discount_amount")
        if observation.prices_include_tax is None:
            issue("missing_required", "/prices_include_tax")
        taxes_complete = all(t.tax is not None for t in observation.taxes)
        if observation.total is not None and all(l.amount is not None for l in observation.lines) and all(d.amount is not None for d in observation.discounts) and observation.prices_include_tax is not None and (observation.prices_include_tax or taxes_complete):
            total = sum((l.amount for l in observation.lines), Decimal(0)) - sum((d.amount for d in observation.discounts), Decimal(0))
            if observation.prices_include_tax is False:
                total += sum((t.tax for t in observation.taxes), Decimal(0))
            if abs(total - observation.total) > Decimal("0.01"):
                issue("total_mismatch", "/total")
        if observation.discount_total is not None and all(d.amount is not None for d in observation.discounts):
            if sum((d.amount for d in observation.discounts), Decimal(0)) != observation.discount_total:
                issue("total_mismatch", "/discount_total")
        for i, tax in enumerate(observation.taxes):
            if None not in (tax.net, tax.tax, tax.gross) and tax.net + tax.tax != tax.gross:
                issue("tax_mismatch", f"/taxes/{i}")
        if observation.taxes and observation.total is not None and all(t.gross is not None for t in observation.taxes):
            if sum((t.gross for t in observation.taxes), Decimal(0)) != observation.total:
                issue("tax_mismatch", "/taxes")
        rates = [line.tax_rate for line in observation.lines] + [tax.tax_rate for tax in observation.taxes]
        for rate in rates:
            if rate.kind == "exempt" and rate.rate is not None:
                issue("invalid_value", "/taxes")
            if rate.kind == "vat" and rate.rate is None:
                issue("missing_required", "/taxes")
        tax_keys = [(t.tax_rate.kind, t.tax_rate.rate) for t in observation.taxes]
        if len(tax_keys) != len(set(tax_keys)):
            issue("tax_mismatch", "/taxes")
    return issues


def fields_of_identity(observation):
    for key in ("receipt_number", "shift_number", "register_code", "purchased_on", "local_time", "total"):
        if getattr(observation, key) not in (None, ""):
            yield "/" + key
    for key in ("country_code", "name", "address_raw"):
        if getattr(observation.store, key) not in (None, ""):
            yield "/store/" + key
    for key, value in observation.fiscal.to_dict().items():
        if value not in (None, ""):
            yield "/fiscal/" + key
