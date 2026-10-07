"""Frozen request and response of one model call."""
import hashlib
import json
from dataclasses import dataclass
from decimal import Decimal

PROMPT_VERSION = "1"
SCHEMA_VERSION = "1"
INPUT_VERSION = "1"
CLASSIFIER_VERSION = 1

EXISTING, NEW, UNKNOWN = "existing", "new", "unknown"


def serialize(document):
    return json.dumps(document, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


@dataclass(frozen=True)
class ClassificationRequest:
    """``product_ids`` are the products of ``document``: the model answers exactly these."""

    document: dict
    product_ids: tuple
    sha256: str

    @classmethod
    def build(cls, document):
        return cls(
            document=document, product_ids=tuple(product["id"] for product in document["products"]),
            sha256=hashlib.sha256(serialize(document).encode("utf-8")).hexdigest(),
        )

    def to_json(self):
        return serialize(self.document)


@dataclass(frozen=True)
class Suggestion:
    product_id: int
    decision: str
    generic_id: int | None
    generic_name: str | None
    category_path: tuple | None
    base_unit: str | None
    confidence: Decimal | None
    note: str | None

    def to_dict(self):
        return {
            "product_id": self.product_id, "decision": self.decision, "generic_id": self.generic_id,
            "generic_name": self.generic_name,
            "category_path": None if self.category_path is None else list(self.category_path),
            "base_unit": self.base_unit,
            "confidence": None if self.confidence is None else float(self.confidence),
            "note": self.note,
        }


@dataclass(frozen=True)
class ClassificationResponse:
    items: tuple

    def to_dict(self):
        return {"schema_version": SCHEMA_VERSION, "items": [item.to_dict() for item in self.items]}
