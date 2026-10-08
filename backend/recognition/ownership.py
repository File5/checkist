"""Rollback check for ownership: rows that would break the former global uniqueness.

Reversing ``recognition.0004`` restores ``unique=True`` on ``SourcePhoto.sha256`` and fails as a
whole when two owners hold the same file. Read only. The receipt rules live in
``receipts.ownership_checks``; this module adds the photo rule and the summary for the command.
"""
from receipts.ownership_checks import RollbackRule, receipt_rollback_conflicts, rule_groups

from .models import SourcePhoto

# The former constraint had an auto-generated name: recognition_sourcephoto_sha256_<hash>_uniq.
PHOTO_ROLLBACK_RULE = RollbackRule(
    name="photo_sha256",
    constraint="recognition_sourcephoto.sha256 unique",
    fields=("sha256",),
)

MODELS = {"photo_sha256": "recognition.SourcePhoto"}
RECEIPT_MODEL = "receipts.Receipt"


def photo_rollback_conflicts():
    """``[(RollbackRule, [(photo_id, owner_id), ...]), ...]`` ordered by the photo id."""
    return [(PHOTO_ROLLBACK_RULE, rows) for rows in rule_groups(PHOTO_ROLLBACK_RULE, SourcePhoto.objects.all())]


def rollback_summary():
    """Every group that blocks the rollback: ids and owner ids only, no receipt or file content."""
    groups = [
        {
            "rule": rule.name,
            "model": MODELS.get(rule.name, RECEIPT_MODEL),
            "constraint": rule.constraint,
            "rows": [{"id": pk, "owner_id": owner_id} for pk, owner_id in rows],
        }
        for rule, rows in [*photo_rollback_conflicts(), *receipt_rollback_conflicts()]
    ]
    return {"conflicts": len(groups), "groups": groups}
