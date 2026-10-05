"""Deterministic K1 synthetic observations, with explicit test/demo scenarios.

FakeProvider(scenario="success2", gate=threading.Event(), entered=Event()).
gate releases pause_detect/pause_recognize; entered signals deterministic
readiness. Without a gate the pause lasts until deadline or cancellation.
Repeat scenarios return the same identity irrespective of crop position.
"""
import copy
import time

from recognition.dto import FiscalObservation
from recognition.demo import rotated_demo_receipts
from recognition.providers.base import ProviderError
from recognition.schema_validation import SchemaValidationError, validate_detection, validate_observation

SCENARIOS = (
    "success2", "one_receipt", "no_receipts", "too_many_receipts", "provider_auth_failure",
    "provider_error", "malformed_schema", "partial_missing_quantity", "inconsistent_total",
    "duplicate_strong", "duplicate_weak", "partial_success", "pause_detect", "pause_recognize", "late_completion",
    "tax_id_present", "tax_id_absent", "rotated_receipt", "rotated_two_receipts",
)
ALIASES = {"success": "success2", "single": "one_receipt", "invalid_output": "malformed_schema",
           "incomplete": "partial_missing_quantity", "repeat": "duplicate_strong", "pause": "pause_detect"}


def detection_payload(image, count=2):
    # K1 double.png: 1500x1100, papers (80,110)-(640,990) and (820,70)-(1380,950).
    boxes = [(80 / 1500, 110 / 1100, 640 / 1500, 990 / 1100),
             (820 / 1500, 70 / 1100, 1380 / 1500, 950 / 1100)]
    if count == 1:
        boxes = [(120 / 800, 100 / 1100, 680 / 800, 980 / 1100)]
    receipts = []
    for i in range(count):
        x1, y1, x2, y2 = boxes[i % len(boxes)]
        receipts.append({"id": i + 1, "bbox": dict(x_min=x1, y_min=y1, x_max=x2, y_max=y2),
                         "quad": [dict(x=x1,y=y1), dict(x=x2,y=y1), dict(x=x2,y=y2), dict(x=x1,y=y2)],
                         "rotation_degrees": 0, "confidence": 1, "clipped": False})
    return {"schema_version": "1", "image_width": image.width, "image_height": image.height,
            "receipt_count": count, "receipts": receipts, "warnings": []}


def _line(position, name, quantity, unit, price, amount, rate="7.00", *, kind="product", parent=None):
    return {"position": position, "kind": kind, "parent_position": parent, "raw_name": name,
            "store_item_code": None, "barcode": None, "quantity": quantity, "unit": unit,
            "unit_price": price, "amount": amount, "discount_amount": "0.00",
            "tax_rate": {"kind": "vat", "rate": rate}, "tax_code": "A" if rate == "7.00" else "B",
            "tax_amount": None, "is_excise": None, "is_marked": None,
            "product_hint": {"name": name if kind == "product" else None, "brand": None,
                             "gtin": None, "package_quantity": None, "package_unit": None}}


def receipt_payload(position=1):
    """Public test helper: mutable, independent payload; all persons fictional."""
    second = position == 2
    data = {
        "schema_version": "2",
        "merchant": {"country_code": "DE", "legal_name": "TESTSHOP GmbH" if second else "TESTMARKT GmbH",
                     "brand_name": "TESTSHOP" if second else "TESTMARKT", "tax_id_type": None, "tax_id": None},
        "store": {"country_code": "DE", "name": "TESTSHOP" if second else "TESTMARKT", "branch_code": None,
                  "address_raw": "Beispielweg 4, 20095 Hamburg" if second else "Teststrasse 12, 10115 Berlin",
                  "postal_code": "20095" if second else "10115", "region": None,
                  "city": "Hamburg" if second else "Berlin", "street": "Beispielweg" if second else "Teststrasse",
                  "house": "4" if second else "12"},
        "operation": "sale", "currency_code": "EUR", "purchased_on": "2026-10-04",
        "local_time": "16:10:00" if second else "14:35:20", "utc_offset_printed": None,
        "receipt_number": "000777" if second else "000123", "shift_number": "3" if second else "7",
        "register_code": "01" if second else "02",
        "fiscal": {key: None for key in FiscalObservation.__dataclass_fields__},
        "total": "6.00" if second else "4.42", "discount_total": "0.00" if second else "0.20",
        "prices_include_tax": True, "raw_text": "SYNTHETIC RECEIPT - TEST ONLY\n",
        "lines": ([_line(1, "BROT", "1.000", "pcs", "1.5000", "1.50"),
                   _line(2, "KAESE 200 G", "2.000", "pcs", "2.2500", "4.50")] if second else
                  [_line(1, "MILCH 1 L", "2.000", "pcs", "1.2900", "2.58"),
                   _line(2, "APFEL", "0.500", "kg", "2.0000", "1.00"),
                   _line(3, "MINERALWASSER 0.5 L", "1.000", "pcs", "0.7900", "0.79", "19.00"),
                   _line(4, "PFAND zu MINERALWASSER", "1.000", "pcs", "0.2500", "0.25", "19.00", kind="deposit", parent=3)]),
        "discounts": [] if second else [{"position":1, "line_position":1, "name":"Rabatt MILCH", "amount":"0.20"}],
        "taxes": ([{"tax_rate":{"kind":"vat","rate":"7.00"},"tax_code":"A","net":"5.61","tax":"0.39","gross":None}] if second else
                  [{"tax_rate":{"kind":"vat","rate":"7.00"},"tax_code":"A","net":"3.16","tax":"0.22","gross":None},
                   {"tax_rate":{"kind":"vat","rate":"19.00"},"tax_code":"B","net":"0.87","tax":"0.17","gross":None}]),
        "confidence": 1, "fields": [], "warnings": [],
        "timestamps": {"header":{"date":"2026-10-04","time":"16:10:00" if second else "14:35:20", "utc_offset":None,"precision":"second"},
                       "fiscal":{"date":None,"time":None,"utc_offset":None,"precision":None}},
    }
    data["fiscal"].update(register_serial="TEST-KASSE-01" if second else "TEST-KASSE-02",
                          tse_transaction="12345" if second else "98765")
    if not second:
        data["lines"][0]["discount_amount"] = "0.20"
    def evidence(obj, path=""):
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key not in ("fields", "warnings", "raw_text", "schema_version"):
                    evidence(value, path + "/" + key)
        elif isinstance(obj, list):
            for i, value in enumerate(obj): evidence(value, path + f"/{i}")
        elif obj is not None:
            data["fields"].append({"path":path, "status":"observed", "confidence":1, "note":None})
    evidence(copy.deepcopy(data))
    return data


class FakeProvider:
    def __init__(self, scenario="success2", *, gate=None, entered=None):
        self.scenario = ALIASES.get(scenario, scenario)
        if self.scenario not in SCENARIOS:
            raise ProviderError("configuration_error")
        self.gate, self.entered = gate, entered

    def _stage(self, phase, run):
        run.stage(phase)
        if self.scenario == "provider_auth_failure":
            raise ProviderError("auth_required")
        if self.scenario == "provider_error":
            raise ProviderError("provider_unavailable")
        if self.scenario in ("pause_" + phase, "late_completion"):
            if self.entered is not None:
                self.entered.set()
            while self.gate is None or not self.gate.is_set():
                run.check()
                if self.gate is None:
                    time.sleep(0.02)
                else:
                    self.gate.wait(0.02)
            run.check()  # late release never resurrects a cancelled result

    def detect(self, prepared_image, run):
        self._stage("detect", run)
        count = 0 if self.scenario == "no_receipts" else 11 if self.scenario == "too_many_receipts" else 1 if self.scenario in ("one_receipt", "duplicate_strong", "duplicate_weak", "tax_id_present", "tax_id_absent") else 2
        data = detection_payload(prepared_image, count)
        if self.scenario in {"rotated_receipt", "rotated_two_receipts"}:
            data["receipts"] = rotated_demo_receipts(single=self.scenario == "rotated_receipt")
            data["receipt_count"] = len(data["receipts"])
        if self.scenario == "malformed_schema":
            data["unexpected"] = True
        try:
            value = validate_detection(data, width=prepared_image.width, height=prepared_image.height)
        except SchemaValidationError:
            raise ProviderError("invalid_output", reason="too_many_receipts" if count > 10 else None) from None
        run.check()
        return value

    def recognize(self, prepared_crop, run):
        self._stage("recognize", run)
        data = receipt_payload(1 if self.scenario.startswith("duplicate_") else getattr(prepared_crop, "position", 1))
        if self.scenario == "partial_missing_quantity" or (self.scenario == "partial_success" and getattr(prepared_crop, "position", 1) == 2):
            # Two missing operands are genuinely unusable. Missing quantity
            # alone can now be recovered from the printed price and amount.
            for key in ("quantity", "unit_price"):
                data["lines"][0][key] = None
                field = next(f for f in data["fields"] if f["path"] == "/lines/0/" + key)
                field.update(status="unreadable", confidence=None)
        if self.scenario == "inconsistent_total":
            data["total"] = "123.45"
        if self.scenario == "duplicate_weak":
            data["fiscal"] = {key: None for key in data["fiscal"]}
            data["fields"] = [f for f in data["fields"] if not f["path"].startswith("/fiscal/")]
        if self.scenario in {"tax_id_present", "tax_id_absent"}:
            # R2: identical receipt without either strong key, only seller ID
            # completeness differs. Intended for HTTP and human QA acceptance.
            cleared = {"/receipt_number", "/shift_number", "/register_code"}
            for key in ("receipt_number", "shift_number", "register_code"):
                data[key] = None
            data["fiscal"] = {key: None for key in data["fiscal"]}
            data["fields"] = [f for f in data["fields"]
                              if f["path"] not in cleared and not f["path"].startswith("/fiscal/")]
            if self.scenario == "tax_id_present":
                data["merchant"].update(tax_id="DE999999994", tax_id_type="vat_id")
                data["fields"].extend({"path": path, "status": "observed", "confidence": 1, "note": None}
                                      for path in ("/merchant/tax_id", "/merchant/tax_id_type"))
        if self.scenario == "malformed_schema":
            data["total"] = 4.42
        try:
            value = validate_observation(data)
        except SchemaValidationError:
            raise ProviderError("invalid_output") from None
        run.check()
        return value
