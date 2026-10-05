"""Provider-neutral observations. No ORM; Decimal values serialize as strings.

Construct observations through schema_validation, not by trusting CLI JSON.
Nullable observations are preserved for review; they are not import defaults.
"""
from dataclasses import dataclass, fields, is_dataclass
from decimal import Decimal
from pathlib import Path
from typing import get_args, get_origin, get_type_hints


def _json_value(value):
    if is_dataclass(value):
        return {f.name: _json_value(getattr(value, f.name)) for f in fields(value)}
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_json_value(v) for v in value]
    return value


class JSONDTO:
    def to_dict(self):
        return _json_value(self)


def _typed(cls, value):
    """Internal conversion, called only after strict validation."""
    if value is None:
        return None
    if get_origin(cls) is tuple:
        return tuple(_typed(get_args(cls)[0], v) for v in value)
    if get_origin(cls) is not None:
        return _typed(next(t for t in get_args(cls) if t is not type(None)), value)
    if cls is Decimal:
        return Decimal(value)
    if is_dataclass(cls):
        return cls(**{k: _typed(t, value[k]) for k, t in get_type_hints(cls).items()})
    return value


@dataclass(frozen=True)
class PreparedImage:
    path: Path
    sha256: str
    width: int
    height: int
    orientation: int = 1


@dataclass(frozen=True)
class PreparedReceiptImage(PreparedImage):
    position: int = 1
    # Text angle in the unrectified crop: positive clockwise, [-180, 180].
    rotation_degrees: float = 0


# Both names refer to the same crop input contract.
PreparedReceiptCrop = PreparedReceiptImage


@dataclass(frozen=True)
class Point(JSONDTO):
    x: float
    y: float


@dataclass(frozen=True)
class BoundingBox(JSONDTO):
    x_min: float
    y_min: float
    x_max: float
    y_max: float


@dataclass(frozen=True)
class DetectedReceipt(JSONDTO):
    """quad: TL, TR, BR, BL relative to the text, clockwise with image y down.

    rotation_degrees: signed clockwise text angle, [-180, 180]; 270 is -90.
    Geometry validation preserves any cyclic start, never sorts by frame axes.
    """
    id: int
    bbox: BoundingBox
    quad: tuple[Point, ...]
    rotation_degrees: float
    confidence: float | None
    clipped: bool


@dataclass(frozen=True)
class DetectionResult(JSONDTO):
    schema_version: str
    image_width: int
    image_height: int
    receipt_count: int
    receipts: tuple[DetectedReceipt, ...]
    warnings: tuple[str, ...]


@dataclass(frozen=True)
class MerchantObservation(JSONDTO):
    country_code: str | None
    legal_name: str | None
    brand_name: str | None
    tax_id_type: str | None
    tax_id: str | None


@dataclass(frozen=True)
class StoreObservation(JSONDTO):
    country_code: str | None
    name: str | None
    branch_code: str | None
    address_raw: str | None
    postal_code: str | None
    region: str | None
    city: str | None
    street: str | None
    house: str | None


@dataclass(frozen=True)
class FiscalObservation(JSONDTO):
    fn: str | None
    fd: str | None
    fp: str | None
    rn_kkt: str | None
    zn_kkt: str | None
    rnm: str | None
    znm: str | None
    ofd: str | None
    document: str | None
    tse_transaction: str | None
    register_serial: str | None
    signature_counter: str | None
    transaction_start: str | None
    transaction_end: str | None
    signature: str | None


@dataclass(frozen=True)
class TimestampObservation(JSONDTO):
    date: str | None
    time: str | None
    utc_offset: str | None
    precision: str | None


@dataclass(frozen=True)
class Timestamps(JSONDTO):
    header: TimestampObservation
    fiscal: TimestampObservation


@dataclass(frozen=True)
class TaxRateObservation(JSONDTO):
    kind: str | None
    rate: Decimal | None


@dataclass(frozen=True)
class ProductHint(JSONDTO):
    name: str | None
    brand: str | None
    gtin: str | None
    package_quantity: Decimal | None
    package_unit: str | None


@dataclass(frozen=True)
class LineObservation(JSONDTO):
    position: int
    kind: str | None
    parent_position: int | None
    raw_name: str | None
    store_item_code: str | None
    barcode: str | None
    quantity: Decimal | None
    unit: str | None
    unit_price: Decimal | None
    amount: Decimal | None
    discount_amount: Decimal | None
    tax_rate: TaxRateObservation
    tax_code: str | None
    tax_amount: Decimal | None
    is_excise: bool | None
    is_marked: bool | None
    product_hint: ProductHint


@dataclass(frozen=True)
class DiscountObservation(JSONDTO):
    position: int
    line_position: int | None
    name: str | None
    amount: Decimal | None


@dataclass(frozen=True)
class TaxObservation(JSONDTO):
    tax_rate: TaxRateObservation
    tax_code: str | None
    net: Decimal | None
    tax: Decimal | None
    gross: Decimal | None


@dataclass(frozen=True)
class FieldObservation(JSONDTO):
    path: str
    status: str
    confidence: float | None
    note: str | None


@dataclass(frozen=True)
class ReceiptObservation(JSONDTO):
    schema_version: str
    merchant: MerchantObservation
    store: StoreObservation
    operation: str | None
    currency_code: str | None
    purchased_on: str | None
    local_time: str | None
    utc_offset_printed: str | None
    receipt_number: str | None
    shift_number: str | None
    register_code: str | None
    fiscal: FiscalObservation
    total: Decimal | None
    discount_total: Decimal | None
    prices_include_tax: bool | None
    raw_text: str | None
    lines: tuple[LineObservation, ...]
    discounts: tuple[DiscountObservation, ...]
    taxes: tuple[TaxObservation, ...]
    confidence: float | None
    fields: tuple[FieldObservation, ...]
    warnings: tuple[str, ...]
    timestamps: Timestamps
