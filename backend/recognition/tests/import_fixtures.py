"""Fictional K1 observations and live fences; no provider/network or media I/O."""
import copy
import uuid
from datetime import timedelta

from recognition.models import ProcessingJob
from recognition.providers.fake import receipt_payload
from recognition.queue import db_now
from recognition.schema_validation import validate_observation
from .test_models import make_image, make_photo


def observation(data=None):
    data = receipt_payload() if data is None else data
    data["fields"] = []

    def evidence(value, path=""):
        if isinstance(value, dict):
            for key, child in value.items():
                if key not in {"fields", "warnings", "schema_version", "raw_text"}:
                    evidence(child, path + "/" + key)
        elif isinstance(value, list):
            for i, child in enumerate(value):
                evidence(child, path + f"/{i}")
        elif value not in (None, ""):
            data["fields"].append({"path": path, "status": "observed", "confidence": 1, "note": None})

    evidence(data)
    return validate_observation(data)


def live_image(**fields):
    # Construct two valid live jobs for race tests without bypassing claim's
    # single-worker policy in production. Every import still uses queue fencing.
    now = db_now()
    job = ProcessingJob.objects.create(
        photo=make_photo(), status="running", stage="import", detected_count=1,
        run_token=uuid.uuid4(), started_at=now, heartbeat_at=now,
        lease_expires_at=now + timedelta(seconds=120), processing_deadline_at=now + timedelta(minutes=10),
    )
    return make_image(job, **fields), job


def another_receipt(data=None):
    data = receipt_payload() if data is None else data
    data["receipt_number"] = "000124"
    data["fiscal"]["tse_transaction"] = "98766"
    data["local_time"] = "14:45:20"
    data["timestamps"]["header"]["time"] = data["local_time"]
    return data


def lidl_format_payload():
    """Fictional seller, Lidl print conventions; 40.80 EUR including discounts."""
    data = receipt_payload()
    data["merchant"].update(country_code=None, legal_name=None, brand_name="TEST DISCOUNT",
                            tax_id_type="vat_id", tax_id="DE999999994")
    data["store"].update(country_code=None, name="TEST DISCOUNT", address_raw="Testweg 17\n88131 Lindau",
                         postal_code="88131", city="Lindau", street="Testweg", house="17")
    data.update(purchased_on="2026-10-01", local_time="17:01:56", utc_offset_printed="Z",
                receipt_number="026914/85", shift_number=None, register_code=None,
                total="40.80", discount_total="2.40", raw_text="TEST RECEIPT\nZwiebeln 2.99 EUR/kg\n")
    data["fiscal"].update(register_serial="TEST-KASSE-85", tse_transaction="629834",
                           signature_counter="1273291", transaction_start="2026-10-01T16:59:45.000Z",
                           transaction_end="2026-10-01T17:01:56.000Z")
    data["timestamps"] = {
        "header": {"date": "2026-10-01", "time": "18:59", "utc_offset": None, "precision": "minute"},
        "fiscal": {"date": "2026-10-01", "time": "17:01:56", "utc_offset": "Z", "precision": "second"},
    }
    template = data["lines"][0]
    lines = []
    for position in range(1, 23):
        line = copy.deepcopy(template)
        line.update(position=position, raw_name=f"TEST WARE {position}", quantity=None, unit=None,
                    unit_price=None, amount="2.00", discount_amount=None,
                    product_hint={key: None for key in template["product_hint"]})
        lines.append(line)
    lines[0].update(raw_name="Zwiebeln weiß", quantity="0.294", unit="kg", unit_price="2.9900", amount="0.88")
    lines[1].update(raw_name="Steinof.PizzaSpezial", amount="3.49")
    lines[2].update(raw_name="Müller Kalinka Kefir", quantity="2.000", unit_price="1.2900", amount="2.58")
    lines[16].update(raw_name="Red Bull White Peach", amount="1.85")
    lines[17].update(kind="deposit", parent_position=17, raw_name="Pfand 0,25 M", amount="0.25",
                     tax_rate={"kind": "vat", "rate": "19.00"}, tax_code="B")
    lines[18].update(raw_name="Erdnusskerne ungesal", amount="1.99", discount_amount="0.20")
    lines[19].update(amount="0.85", tax_rate={"kind": "vat", "rate": "19.00"}, tax_code="B")
    lines[20].update(amount="6.56")
    lines[21].update(kind="deposit_return", raw_name="Pfandrückgabe", quantity="-5.000",
                     unit_price="0.2500", amount="-1.25")
    data["lines"] = lines
    data["discounts"] = [
        {"position": 1, "line_position": 9, "name": "Preisvorteil", "amount": "0.20"},
        {"position": 2, "line_position": 21, "name": "Preisvorteil", "amount": "2.00"},
        {"position": 3, "line_position": 19, "name": "Rabatt Snack", "amount": "0.20"},
    ]
    data["taxes"] = [
        {"tax_rate": {"kind": "vat", "rate": "7.00"}, "tax_code": "A", "net": "37.10", "tax": "2.60", "gross": "39.70"},
        {"tax_rate": {"kind": "vat", "rate": "19.00"}, "tax_code": "B", "net": "0.92", "tax": "0.18", "gross": "1.10"},
    ]
    # Regenerate evidence for the changed nullable values and line positions.
    data["fields"] = observation(copy.deepcopy(data)).to_dict()["fields"]
    return data


def sparse_lidl_format_payload():
    """Real-response evidence shape: headers and two names, no line numbers.

    Keep the raw multiline address/Z offsets and fictional values of the
    fully evidenced fixture. Call validate_observation directly: observation()
    would silently repopulate evidence and hide the regression.
    """
    data = lidl_format_payload()
    data["fields"] = [field for field in data["fields"] if
                      not field["path"].startswith(("/lines/", "/discounts/", "/taxes/"))
                      or field["path"] in {"/lines/1/raw_name", "/lines/2/raw_name"}]
    return data
