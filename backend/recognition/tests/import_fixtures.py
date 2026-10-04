"""Fictional K1 observations and live fences; no provider/network or media I/O."""
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
