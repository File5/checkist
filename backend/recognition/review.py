"""Human confirmation of one ``needs_review`` crop: corrections plus import.

confirm(image_id, body) -> ConfirmResult. ``body`` is the parsed JSON object of
the request, already checked by ``known_structure``. One transaction: the
import mutex (non-blocking), the job row, then the image row — the order of
``queue.fenced_job`` / ``save_image_result`` — the state checks, the domain
import in a savepoint and the image/job writes. Every refusal rolls back all
of it and nothing is retried here. No draft is stored: the corrected values
live only in the request and, after success, in ``outcome_snapshot``.

The stored ``normalized_result`` stays the provider DTO. Closed facts (receipt
number, shift, register, fiscal fields, tax ID, legal name, raw text) are
carried from it with their evidence and are never accepted from the body.
"""
import copy
import hashlib
import json
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, time, timezone

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import DatabaseError, IntegrityError, connection, transaction

from receipts.decimal_math import price_context
from stores.models import Country, Currency, Store

from .dto import FiscalObservation, MerchantObservation, ProductHint, StoreObservation
from .importer import (
    IMPORT_LOCK, RECEIPT_UNIQUES, _constraint_name, _detect_product_merges, _import_domain,
    _request_product_classification, effective_observation,
)
from .models import ProcessingJob, ReceiptImage
from .queue import db_now, refresh_progress
from .resolution import ResolutionError, issue
from .schema_validation import SchemaValidationError, validate_observation
from .statuses import ImageStatus, ImportEffect, JobStatus, TERMINAL_JOB_STATUSES

MAX_ID = 2**63 - 1  # BigAutoField
MAX_POSITION = 32767
MAX_FIELDS = 10000  # receipt.schema.json: /fields maxItems
# Lock not available, statement timeout, deadlock.
BUSY_SQLSTATES = frozenset({"55P03", "57014", "40P01"})
SUCCESS_STATUSES = {
    ImportEffect.CREATED: ImageStatus.IMPORTED, ImportEffect.LINKED: ImageStatus.REUSED,
    ImportEffect.UPDATED: ImageStatus.UPDATED,
}

TOP_KEYS = ("receipt", "lines", "discounts", "taxes")
RECEIPT_KEYS = ("store_id", "store_name", "address", "country", "currency", "operation", "purchased_on",
                "local_time", "total", "prices_include_tax")
RECEIPT_OPTIONAL_KEYS = ("utc_offset",)
LINE_KEYS = ("position", "source_position", "kind", "parent_position", "name", "quantity", "unit", "unit_price",
             "amount", "tax_rate", "tax_code")
RATE_KEYS = ("kind", "rate")
DISCOUNT_KEYS = ("position", "line_position", "name", "amount")
TAX_KEYS = ("tax_rate", "tax_code", "net", "tax", "gross")
LIMITS = {"lines": (1, 1000), "discounts": (0, 1000), "taxes": (0, 100)}

KINDS = ("product", "service", "deposit", "deposit_return")
UNITS = ("pcs", "g", "kg", "ml", "l", "m")
MONEY = re.compile(r"-?[0-9]{1,12}\.[0-9]{2}")
QUANTITY = re.compile(r"-?[0-9]{1,9}\.[0-9]{3}")
UNIT_PRICE = re.compile(r"[0-9]{1,10}\.[0-9]{4}")
RATE = re.compile(r"[0-9]{1,3}\.[0-9]{2}")

# Facts of a recognized line that the form neither shows nor sends.
LINE_INHERITED = ("store_item_code", "barcode", "tax_amount", "is_excise", "is_marked")
LINE_CLOSED_EVIDENCE = re.compile(
    r"/lines/([0-9]+)/((?:store_item_code|barcode|tax_amount|is_excise|is_marked)|product_hint/[a-z_]+)\Z")
STORE_PARTS = ("postal_code", "region", "city", "street", "house")
CLOSED_HEADER = frozenset({
    "/merchant/country_code", "/merchant/legal_name", "/merchant/tax_id_type", "/merchant/tax_id",
    "/store/branch_code", "/receipt_number", "/shift_number", "/register_code", "/raw_text", "/confidence",
    *("/store/" + key for key in STORE_PARTS),
})
PUBLIC_HEADER = ("/merchant/brand_name", "/store/country_code", "/store/name", "/store/address_raw", "/operation",
                 "/currency_code", "/purchased_on", "/local_time", "/utc_offset_printed", "/total",
                 "/prices_include_tax")
LINE_PUBLIC = ("position", "kind", "parent_position", "raw_name", "quantity", "unit", "unit_price", "amount",
               "tax_rate/kind", "tax_rate/rate", "tax_code")
DISCOUNT_PUBLIC = ("position", "line_position", "name", "amount")
TAX_PUBLIC = ("tax_rate/kind", "tax_rate/rate", "tax_code", "net", "tax", "gross")
ROW_EVIDENCE = re.compile(r"/(?:lines|discounts|taxes)/[0-9]+/(.+)\Z")
DOMAIN_ROW = re.compile(r"/(taxes|discounts)/([0-9]+)((?:/.*)?)\Z")


class ReviewError(Exception):
    """Base class; ``code`` matches the API error code of the contract."""

    code = "review_error"

    def __init__(self):
        super().__init__(self.code)


class ReviewNotFound(ReviewError):
    code = "not_found"


class ReviewJobActive(ReviewError):
    """The job of this crop is not finished: the worker still decides its outcome."""

    code = "job_active"


class ReviewUnavailable(ReviewError):
    """The crop is not ``needs_review`` and was not confirmed through this service."""

    code = "review_unavailable"


class ReviewResolved(ReviewError):
    """The crop is already confirmed with other content."""

    code = "review_resolved"


class ReviewBusy(ReviewError):
    """An import or a merge holds the mutex, a row lock timed out, or a unique race."""

    code = "review_busy"


class ReviewInvalidParameter(ReviewError):
    """``fields``: ``{"lines.0.quantity": reason}``; reasons are a closed list, never values."""

    code = "invalid_parameter"

    def __init__(self, fields):
        self.fields = dict(fields)
        super().__init__()


class ReviewInvalid(ReviewError):
    """The corrected data is well formed but the import rules refuse it; nothing is saved.

    ``issues`` use indexes of the request arrays; ``normalized`` is the corrected DTO.
    """

    code = "review_invalid"

    def __init__(self, issues, normalized):
        self.issues, self.normalized = list(issues), normalized
        super().__init__()


@dataclass(frozen=True)
class ConfirmResult:
    image_id: int
    job_id: int
    replayed: bool


def known_structure(data):
    """True if no object of the body has a key outside the contract (any level)."""

    def only(value, keys):
        return not isinstance(value, dict) or not set(value) - set(keys)

    def rows(name, keys, rate=False):
        value = data.get(name)
        for row in value if isinstance(value, list) else ():
            if not only(row, keys) or rate and isinstance(row, dict) and not only(row.get("tax_rate"), RATE_KEYS):
                return False
        return True

    return (isinstance(data, dict) and only(data, TOP_KEYS)
            and only(data.get("receipt"), RECEIPT_KEYS + RECEIPT_OPTIONAL_KEYS)
            and rows("lines", LINE_KEYS, rate=True) and rows("discounts", DISCOUNT_KEYS)
            and rows("taxes", TAX_KEYS, rate=True))


class _Errors(dict):
    def add(self, path, reason):
        self.setdefault(path, reason)


def _is_int(value):
    return type(value) is int


def _text(errors, path, value, limit, *, separator=" ", nullable=True):
    """Printed text as the observation stores it: line breaks collapsed, edges trimmed."""
    if value is None:
        if not nullable:
            errors.add(path, "null")
        return None
    if type(value) is not str:
        errors.add(path, "type")
        return None
    value = re.sub(r"[ \r\n\t]*[\r\n\t][ \r\n\t]*", separator, value.strip(" \r\n\t"))
    if not value:
        errors.add(path, "blank")
    elif len(value) > limit:
        errors.add(path, "too_long")
    elif any(unicodedata.category(char) in ("Cs", "Cc") for char in value):
        errors.add(path, "format")
    else:
        return value
    return None


def _decimal(errors, path, value, pattern, *, nullable=True):
    # Decimal strings only: a JSON number would already have lost its scale.
    if value is None:
        if not nullable:
            errors.add(path, "null")
    elif type(value) is not str:
        errors.add(path, "type")
    elif not pattern.fullmatch(value):
        errors.add(path, "format")
    else:
        return value
    return None


def _choice(errors, path, value, choices, *, nullable=True):
    if value is None:
        if not nullable:
            errors.add(path, "null")
    elif type(value) is not str:
        errors.add(path, "type")
    elif value not in choices:
        errors.add(path, "choice")
    else:
        return value
    return None


def _integer(errors, path, value, *, maximum=MAX_POSITION, nullable=True):
    if value is None:
        if not nullable:
            errors.add(path, "null")
    elif not _is_int(value):
        errors.add(path, "type")
    elif not 1 <= value <= maximum:
        errors.add(path, "range")
    else:
        return value
    return None


def _code(errors, path, value, length, model):
    if value is None:
        return None
    if type(value) is not str:
        errors.add(path, "type")
    elif not re.fullmatch(rf"[A-Za-z]{{{length}}}", value):
        errors.add(path, "format")
    elif not model.objects.filter(pk=value.upper()).exists():
        errors.add(path, "unknown")
    else:
        return value.upper()
    return None


def _calendar(errors, path, value, kind, *, nullable=False):
    if value is None:
        if not nullable:
            errors.add(path, "null")
        return None
    if type(value) is not str:
        errors.add(path, "type")
        return None
    pattern = {"date": r"[0-9]{4}-[0-9]{2}-[0-9]{2}", "time": r"[0-9]{2}:[0-9]{2}(:[0-9]{2})?",
               "offset": r"[+-][0-9]{2}:[0-9]{2}"}[kind]
    try:
        if not re.fullmatch(pattern, value, flags=re.ASCII):
            raise ValueError
        if kind == "date":
            date.fromisoformat(value)
        elif kind == "time":
            time.fromisoformat(value)
        elif int(value[1:3]) > 14 or int(value[4:6]) > 59 or (int(value[1:3]) == 14 and value[4:6] != "00"):
            raise ValueError
    except ValueError:
        errors.add(path, "format")
        return None
    return value


def _object(errors, path, value, keys, optional=()):
    """The dict itself, with ``required`` recorded for each missing key; None if not an object."""
    if not isinstance(value, dict):
        errors.add(path, "type")
        return None
    for key in keys:
        if key not in value:
            errors.add(f"{path}.{key}", "required")
    return {key: value.get(key) for key in (*keys, *(key for key in optional if key in value))}


def _rate(errors, path, value, *, kind_required=False):
    row = _object(errors, path, value, RATE_KEYS)
    if row is None:
        return {"kind": None, "rate": None}
    kind = _choice(errors, path + ".kind", row["kind"], ("vat", "exempt"), nullable=not kind_required)
    rate = _decimal(errors, path + ".rate", row["rate"], RATE)
    if path + ".kind" not in errors and path + ".rate" not in errors:
        if kind == "vat" and rate is None:
            errors.add(path + ".rate", "null")
        elif kind != "vat" and row["rate"] is not None:
            errors.add(path + ".rate", "choice")
    return {"kind": kind, "rate": rate}


def _rows(errors, data, name):
    value = data.get(name)
    if not isinstance(value, list):
        errors.add(name, "type")
        return []
    low, high = LIMITS[name]
    if not low <= len(value) <= high:
        errors.add(name, "size")
        return []
    return value


def _unique(errors, path, value, seen):
    if value is not None:
        if value in seen:
            errors.add(path, "duplicate")
        seen.add(value)


def recognized_positions(stored):
    """Positions of the recognized lines, exactly those the public projection shows."""
    lines = stored.get("lines") if isinstance(stored, dict) else None
    if not isinstance(lines, list):
        return set()
    return {line["position"] for line in lines if isinstance(line, dict)
            and _is_int(line.get("position")) and 1 <= line["position"] <= MAX_POSITION}


def clean_body(data, stored):
    """(normalized body, chosen Store | None), or ReviewInvalidParameter with every bad path."""
    errors = _Errors()
    for key in TOP_KEYS:
        if key not in data:
            errors.add(key, "required")

    cleaned = {"receipt": {}, "lines": [], "discounts": [], "taxes": []}
    store = None
    if "receipt" in data:
        receipt = _object(errors, "receipt", data["receipt"], RECEIPT_KEYS, RECEIPT_OPTIONAL_KEYS)
        if receipt is not None:
            store_id = _integer(errors, "receipt.store_id", receipt["store_id"], maximum=MAX_ID)
            if store_id is not None:
                store = Store.objects.select_related("merchant", "country").filter(pk=store_id).first()
                if store is None:
                    errors.add("receipt.store_id", "unknown")
            cleaned["receipt"] = {
                "store_id": store_id,
                "store_name": _text(errors, "receipt.store_name", receipt["store_name"], 100),
                "address": _text(errors, "receipt.address", receipt["address"], 4096, separator=", "),
                "country": _code(errors, "receipt.country", receipt["country"], 2, Country),
                "currency": _code(errors, "receipt.currency", receipt["currency"], 3, Currency),
                "operation": _choice(errors, "receipt.operation", receipt["operation"], ("sale", "refund")),
                "purchased_on": _calendar(errors, "receipt.purchased_on", receipt["purchased_on"], "date"),
                "local_time": _calendar(errors, "receipt.local_time", receipt["local_time"], "time"),
                "total": _decimal(errors, "receipt.total", receipt["total"], MONEY, nullable=False),
                "prices_include_tax": receipt["prices_include_tax"],
            }
            if receipt["prices_include_tax"] is not None and type(receipt["prices_include_tax"]) is not bool:
                errors.add("receipt.prices_include_tax", "type")
            if "utc_offset" in receipt:
                cleaned["receipt"]["utc_offset"] = _calendar(
                    errors, "receipt.utc_offset", receipt["utc_offset"], "offset", nullable=True)

    positions, sources, known = set(), set(), recognized_positions(stored)
    lines = _rows(errors, data, "lines") if "lines" in data else []
    for index, value in enumerate(lines):
        path = f"lines.{index}"
        row = _object(errors, path, value, LINE_KEYS)
        if row is None:
            continue
        line = {
            "position": _integer(errors, path + ".position", row["position"], nullable=False),
            "source_position": _integer(errors, path + ".source_position", row["source_position"]),
            "kind": _choice(errors, path + ".kind", row["kind"], KINDS, nullable=False),
            "parent_position": _integer(errors, path + ".parent_position", row["parent_position"]),
            "name": _text(errors, path + ".name", row["name"], 4096, nullable=False),
            "quantity": _decimal(errors, path + ".quantity", row["quantity"], QUANTITY),
            "unit": _choice(errors, path + ".unit", row["unit"], UNITS),
            "unit_price": _decimal(errors, path + ".unit_price", row["unit_price"], UNIT_PRICE),
            "amount": _decimal(errors, path + ".amount", row["amount"], MONEY),
            "tax_rate": _rate(errors, path + ".tax_rate", row["tax_rate"]),
            "tax_code": _text(errors, path + ".tax_code", row["tax_code"], 8),
        }
        if line["quantity"] is not None and not line["quantity"].strip("-0."):
            errors.add(path + ".quantity", "range")
        _unique(errors, path + ".position", line["position"], positions)
        _unique(errors, path + ".source_position", line["source_position"], sources)
        if line["source_position"] is not None and line["source_position"] not in known:
            errors.add(path + ".source_position", "reference")
        cleaned["lines"].append(line)
    products = {line["position"] for line in cleaned["lines"] if line["kind"] == "product"}
    # References are judged only against a sound set of positions: one error per cause.
    sound = not any(re.fullmatch(r"lines(\.[0-9]+(\.position)?)?", path) for path in errors)
    if sound:
        for index, line in enumerate(cleaned["lines"]):
            parent = line["parent_position"]
            if parent is not None and (line["kind"] != "deposit" or parent == line["position"]
                                       or parent not in products):
                errors.add(f"lines.{index}.parent_position", "reference")

    seen = set()
    for index, value in enumerate(_rows(errors, data, "discounts") if "discounts" in data else []):
        path = f"discounts.{index}"
        row = _object(errors, path, value, DISCOUNT_KEYS)
        if row is None:
            continue
        discount = {
            "position": _integer(errors, path + ".position", row["position"], nullable=False),
            "line_position": _integer(errors, path + ".line_position", row["line_position"]),
            "name": _text(errors, path + ".name", row["name"], 255, nullable=False),
            "amount": _decimal(errors, path + ".amount", row["amount"], MONEY, nullable=False),
        }
        if discount["amount"] is not None and (discount["amount"].startswith("-")
                                               or not discount["amount"].strip("0.")):
            errors.add(path + ".amount", "range")
        _unique(errors, path + ".position", discount["position"], seen)
        if sound and discount["line_position"] is not None and discount["line_position"] not in positions:
            errors.add(path + ".line_position", "reference")
        cleaned["discounts"].append(discount)

    for index, value in enumerate(_rows(errors, data, "taxes") if "taxes" in data else []):
        path = f"taxes.{index}"
        row = _object(errors, path, value, TAX_KEYS)
        if row is None:
            continue
        tax = {
            "tax_rate": _rate(errors, path + ".tax_rate", row["tax_rate"], kind_required=True),
            "tax_code": _text(errors, path + ".tax_code", row["tax_code"], 8),
            **{key: _decimal(errors, f"{path}.{key}", row[key], MONEY) for key in ("net", "tax", "gross")},
        }
        if [value.get(key, "") for key in ("net", "tax", "gross")].count(None) > 1:
            errors.add(path, "too_many_null")
        cleaned["taxes"].append(tax)

    if errors:
        raise ReviewInvalidParameter(errors)
    return cleaned, store


def request_sha256(cleaned):
    """Identity of a confirmation: SHA-256 of the canonical normalized body."""
    text = json.dumps(cleaned, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _skeleton():
    empty = {"date": None, "time": None, "utc_offset": None, "precision": None}
    return {
        "schema_version": "2",
        "merchant": dict.fromkeys(MerchantObservation.__dataclass_fields__),
        "store": dict.fromkeys(StoreObservation.__dataclass_fields__),
        "operation": None, "currency_code": None, "purchased_on": None, "local_time": None,
        "utc_offset_printed": None, "receipt_number": None, "shift_number": None, "register_code": None,
        "fiscal": dict.fromkeys(FiscalObservation.__dataclass_fields__),
        "total": None, "discount_total": None, "prices_include_tax": None, "raw_text": None,
        "lines": [], "discounts": [], "taxes": [], "confidence": None, "fields": [], "warnings": [],
        "timestamps": {"header": dict(empty), "fiscal": dict(empty)},
    }


def _base(stored):
    try:
        return validate_observation(copy.deepcopy(stored)).to_dict()
    except (SchemaValidationError, TypeError, KeyError, ValueError):
        # A partial or damaged DTO still deserves a confirmation: no closed facts then.
        return _skeleton()


def _same(sent, recognized):
    return sent == ((recognized or "").strip() or None)


def _pointer(data, path):
    value = data
    for key in path[1:].split("/"):
        value = value[int(key)] if isinstance(value, list) else value[key]
    return value


def build_observation(stored, cleaned, store=None):
    """The corrected observation as a JSON dict: stored DTO below, body values on top."""
    base = _base(stored)
    data = copy.deepcopy(base)
    receipt, merchant, shop = cleaned["receipt"], data["merchant"], data["store"]
    fields = [dict(field) for field in base["fields"]
              if field["path"] in CLOSED_HEADER or field["path"].startswith("/fiscal/")]

    if not _same(receipt["store_name"], merchant["brand_name"] or shop["name"]):
        # Another seller name was typed: the recognized legal name belonged to the old one.
        merchant.update(brand_name=receipt["store_name"], legal_name=None)
        shop["name"] = receipt["store_name"]
    if not _same(receipt["address"], shop["address_raw"]):
        shop.update(address_raw=receipt["address"], **dict.fromkeys(STORE_PARTS))
    if store is not None:
        shop["country_code"] = store.country_id
    elif receipt["country"] is not None:
        if receipt["country"] != (shop["country_code"] or merchant["country_code"]):
            merchant["country_code"] = None
        shop["country_code"] = receipt["country"]

    unchanged = (receipt["purchased_on"], receipt["local_time"]) == (base["purchased_on"], base["local_time"])
    offset = receipt["utc_offset"] if "utc_offset" in receipt else base["utc_offset_printed"] if unchanged else None
    data.update(
        currency_code=receipt["currency"], operation=receipt["operation"], purchased_on=receipt["purchased_on"],
        local_time=receipt["local_time"], utc_offset_printed=offset, total=receipt["total"],
        prices_include_tax=receipt["prices_include_tax"],
        discount_total=None,  # arithmetic of the discounts below, derived by the import
        timestamps={
            "header": {"date": receipt["purchased_on"], "time": receipt["local_time"], "utc_offset": offset,
                       "precision": "second" if len(receipt["local_time"]) == 8 else "minute"},
            "fiscal": {"date": None, "time": None, "utc_offset": None, "precision": None},
        },
    )

    sources = {line["position"]: (index, line) for index, line in enumerate(base["lines"])}
    evidence = {}
    for field in base["fields"]:
        if match := LINE_CLOSED_EVIDENCE.fullmatch(field["path"]):
            evidence.setdefault(int(match[1]), []).append((match[2], field))
    data["lines"] = []
    for index, row in enumerate(cleaned["lines"]):
        old_index, source = sources.get(row["source_position"], (None, None))
        hint = dict(source["product_hint"]) if source else dict.fromkeys(ProductHint.__dataclass_fields__)
        renamed = source is None or not _same(row["name"], source["raw_name"])
        if renamed:
            hint["name"] = None
        data["lines"].append({
            "position": row["position"], "kind": row["kind"], "parent_position": row["parent_position"],
            "raw_name": row["name"], "quantity": row["quantity"], "unit": row["unit"],
            "unit_price": row["unit_price"], "amount": row["amount"], "discount_amount": None,
            "tax_rate": dict(row["tax_rate"]), "tax_code": row["tax_code"], "product_hint": hint,
            **{key: source[key] if source else None for key in LINE_INHERITED},
        })
        for tail, field in evidence.get(old_index, ()):
            if not (renamed and tail == "product_hint/name"):
                fields.append({**field, "path": f"/lines/{index}/{tail}"})
    data["discounts"] = [dict(row) for row in cleaned["discounts"]]
    data["taxes"] = [{**row, "tax_rate": dict(row["tax_rate"])} for row in cleaned["taxes"]]

    # A person vouches for what was sent: filled is read, empty is not printed.
    public = list(PUBLIC_HEADER)
    for name, tails in (("lines", LINE_PUBLIC), ("discounts", DISCOUNT_PUBLIC), ("taxes", TAX_PUBLIC)):
        public += [f"/{name}/{index}/{tail}" for index in range(len(data[name])) for tail in tails]
    # Closed evidence survives only where its value did: a reset fact has none.
    fields = [field for field in fields if LINE_CLOSED_EVIDENCE.fullmatch(field["path"])
              or _pointer(data, field["path"]) == _pointer(base, field["path"])]
    fields += [{"path": path, "status": "absent" if _pointer(data, path) in (None, "") else "observed",
                "confidence": None, "note": None} for path in public]
    data["fields"] = _compact(fields)
    return data


def _compact(fields):
    """Fit the schema limit of evidence entries without changing what the import decides.

    Only a doubt (ambiguous/unreadable) and an ``observed`` identity or tax
    rate influence the import; other row entries are a record, dropped last.
    """
    if len(fields) <= MAX_FIELDS:
        return fields

    def decisive(field):
        match = ROW_EVIDENCE.fullmatch(field["path"])
        return (match is None or field["status"] in ("ambiguous", "unreadable")
                or field["status"] == "observed" and match[1] in ("tax_rate/kind", "tax_rate/rate"))

    return [field for field in fields if decisive(field)]


def _schema_field(path):
    """Body path of a schema refusal that ``clean_body`` did not foresee."""
    parts = path.strip("/").split("/")
    if parts[0] in ("lines", "discounts", "taxes"):
        return ".".join("name" if part == "raw_name" else part for part in parts)
    names = {"total": "total", "currency_code": "currency", "operation": "operation",
             "purchased_on": "purchased_on", "local_time": "local_time", "utc_offset_printed": "utc_offset",
             "prices_include_tax": "prices_include_tax", "store/name": "store_name",
             "merchant/brand_name": "store_name", "store/address_raw": "address", "store/country_code": "country"}
    return "receipt." + names["/".join(parts)] if "/".join(parts) in names else "receipt"


def _body_indexes(observation, effective):
    """Rows the import policy kept -> their indexes in the request arrays."""
    discounts = {row.position: index for index, row in enumerate(observation.discounts)}
    taxes, start = {}, 0
    for kept, row in enumerate(effective.taxes):
        for index in range(start, len(observation.taxes)):
            sent = observation.taxes[index]
            if sent.tax_rate == row.tax_rate and all(
                    getattr(sent, key) in (None, getattr(row, key)) for key in ("net", "tax", "gross")):
                taxes[kept], start = index, index + 1
                break
    return {"discounts": {kept: discounts[row.position] for kept, row in enumerate(effective.discounts)},
            "taxes": taxes}


def _to_body(issues, indexes):
    result = []
    for item in issues:
        match = DOMAIN_ROW.fullmatch(item["field"]) if isinstance(item.get("field"), str) else None
        if match and int(match[2]) in indexes[match[1]]:
            item = {**item, "field": f"/{match[1]}/{indexes[match[1]][int(match[2])]}{match[3]}"}
        result.append(item)
    return result


def confirm(image_id, body):
    """Apply the corrections and import the crop, or raise a ReviewError; no partial effect."""
    image = ReceiptImage.objects.filter(pk=image_id).first()
    if image is None:
        raise ReviewNotFound()
    cleaned, store = clean_body(body, image.normalized_result)
    digest = request_sha256(cleaned)
    try:
        observation = validate_observation(build_observation(image.normalized_result, cleaned, store))
    except SchemaValidationError as error:
        raise ReviewInvalidParameter({_schema_field(error.path): "format"}) from None
    normalized = observation.to_dict()
    with price_context():
        effective, notices, derived = effective_observation(observation)
        indexes = _body_indexes(observation, effective)
        try:
            with transaction.atomic():
                return _confirm(image, store, digest, normalized, effective, notices, derived, indexes)
        except DatabaseError as error:
            if getattr(error.__cause__, "sqlstate", None) not in BUSY_SQLSTATES:
                raise
            raise ReviewBusy() from None


def _confirm(image, store, digest, normalized, effective, notices, derived, indexes):
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [IMPORT_LOCK])
        if not cursor.fetchone()[0]:
            raise ReviewBusy()
    try:
        job = ProcessingJob.objects.select_for_update().get(pk=image.job_id)
        image = ReceiptImage.objects.select_for_update().get(pk=image.pk, job=job)
    except (ProcessingJob.DoesNotExist, ReceiptImage.DoesNotExist):
        raise ReviewNotFound() from None
    if job.status not in TERMINAL_JOB_STATUSES:
        raise ReviewJobActive()
    snapshot = image.outcome_snapshot if isinstance(image.outcome_snapshot, dict) else {}
    confirmed = snapshot.get("confirmed")
    if isinstance(confirmed, dict) and image.receipt_id is not None:
        if confirmed.get("request_sha256") != digest:
            raise ReviewResolved()
        return ConfirmResult(image.pk, job.pk, True)
    if image.status != ImageStatus.NEEDS_REVIEW:
        raise ReviewUnavailable()

    stamp = db_now().astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    try:
        with transaction.atomic():
            receipt, effect, issues = _import_domain(
                effective, derived, store=store, confirmed={"image_id": image.pk, "at": stamp})
    except ResolutionError as problem:
        raise ReviewInvalid(notices + _to_body(problem.issues, indexes), normalized) from None
    except ValidationError:
        raise ReviewInvalid(
            notices + [issue("invalid_value", "/", "Значения не соответствуют модели чека.")], normalized) from None
    except IntegrityError as error:
        if _constraint_name(error) not in RECEIPT_UNIQUES:
            raise
        # A writer outside the mutex won a known unique race. No hidden re-read here:
        # the person repeats the request and the receipt is then found as a duplicate.
        raise ReviewBusy() from None
    if settings.PRODUCT_MERGE_AUTO_DETECT:
        _detect_product_merges(receipt)
    if settings.PRODUCT_CLASSIFICATION_AUTO_SUGGEST:
        _request_product_classification(receipt)

    issues = notices + _to_body(issues, indexes)
    if image.clipped:
        issues.append(issue("clipped", "/clipped"))
    previous = image.issues
    image.status = SUCCESS_STATUSES[effect]
    image.receipt = receipt
    image.import_effect = effect
    image.issues = issues
    image.outcome_snapshot = {"receipt_id": receipt.pk, "confirmed": {
        "at": stamp, "request_sha256": digest, "previous_issues": previous, "result": normalized,
    }}
    image.save(update_fields=["status", "receipt", "import_effect", "issues", "outcome_snapshot"])
    images = refresh_progress(job)
    if job.status == JobStatus.PARTIAL_SUCCEEDED and all(
            item.status in SUCCESS_STATUSES.values() for item in images):
        job.status = JobStatus.SUCCEEDED
    job.version += 1
    job.save()
    return ConfirmResult(image.pk, job.pk, False)
