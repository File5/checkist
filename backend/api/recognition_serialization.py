"""Allowlisted public projections. Never serialize model/JSON dictionaries whole."""
import re
from decimal import Decimal, InvalidOperation

from django.conf import settings
from django.db import connection
from django.db.models import Count, Exists, IntegerField, OuterRef, Q, Subquery, Value
from django.db.models.functions import Coalesce
from django.utils import timezone

from accounts.access import owner_q
from api.common import amount, iso_date, percent, price, quantity, store_object, utc_datetime
from receipts.decimal_math import price_context
from receipts.models import Receipt, ReceiptLine
from recognition.models import ProcessingJob, ReceiptImage, SourcePhoto
from recognition.queue import WORKER_LOCK
from recognition.statuses import EXECUTING_JOB_STATUSES


ISSUE_MESSAGES = {
    "missing_required": "Не удалось прочитать обязательное поле.",
    "invalid_value": "Значение не прошло проверку.",
    "total_mismatch": "Сумма чека не совпадает с суммой позиций.",
    "tax_mismatch": "Итоги налогов не совпадают.",
    "timezone_unknown": "Не удалось определить часовой пояс.",
    "time_ambiguous": "Время покупки неоднозначно.",
    "weak_identity": "Недостаточно данных для определения дубликата.",
    "identity_conflict": "Данные идентичности чека противоречат друг другу.",
    "product_unmatched": "Товар не сопоставлен.",
    "product_ambiguous": "Нужно выбрать товар.",
    "product_conflict": "Данные товара противоречат друг другу.",
    "geometry_requires_review": "Границы чека требуют проверки.",
    "clipped": "Чек обрезан на фотографии.",
    "overlap": "Чеки перекрываются.",
    "timeout": "Время обработки истекло.",
    "worker_lost": "Обработчик перестал отвечать.",
    "storage_unavailable": "Хранилище изображений недоступно.",
    "provider_error": "Не удалось распознать изображение.",
    "invalid_output": "Ответ распознавания не прошёл проверку.",
    "auth_required": "Требуется вход в сервис распознавания.",
    "rate_limited": "Сервис распознавания временно ограничил запросы.",
    "provider_unavailable": "Сервис распознавания недоступен.",
    "network_unavailable": "Сеть сервиса распознавания недоступна.",
    "configuration_error": "Настройки сервиса распознавания требуют проверки.",
    "invalid_input": "Изображение не подходит для распознавания.",
    "cancelled": "Обработка отменена.",
    "no_receipts": "На фотографии не найдены чеки.",
    "too_many_receipts": "На фотографии слишком много чеков.",
}
PUBLIC_POINTER = re.compile(
    r"/(?:|identity|geometry|bbox|quad|rotation_degrees|clipped|merchant|store|"
    r"operation|currency(?:_code)?|purchased_on|local_time|total|discount_total|prices_include_tax|"
    r"merchant/(?:country_code|brand_name)|store/(?:country_code|name|address_raw|city)|"
    r"(?:lines|discounts|taxes)(?:/[0-9]{1,4}(?:/(?:position|kind|parent_position|"
    r"raw_name|name|product|quantity|unit|unit_price|amount|discount_amount|tax_amount|"
    r"tax_code|tax_rate|net|tax|gross|line_position|barcode|store_item_code|is_excise|is_marked))?)?)\Z"
)
REVIEW_IMAGES = (Q(status="needs_review")
                | (~Q(issues=[]) & ~Q(status__in=["imported", "reused", "updated"])))
# Internal codes stay behind code=invalid_value; reason names them from this closed list.
ISSUE_REASONS = frozenset(ISSUE_MESSAGES) | {
    "optional_omitted", "operation_defaulted", "currency_inferred", "ambiguous_value", "country_unknown",
    "currency_unknown", "import_busy", "import_failed", "merchant_conflict", "merchant_tax_id_invalid",
    "product_package_invalid", "receipt_conflict", "receipt_invalid", "receipt_line_conflict",
    "receipt_structure_conflict", "store_ambiguous", "store_conflict", "tax_rate_invalid",
    "tax_rate_unconfirmed", "timestamp_ambiguous", "timestamp_conflict",
}
INFO_REASONS = frozenset({"operation_defaulted", "currency_inferred"})
WARNING_REASONS = frozenset({"optional_omitted", "clipped", "cancelled"})
ISSUE_COLLECTIONS = {"lines": "line", "discounts": "discount", "taxes": "tax"}
GEOMETRY_ATTRIBUTES = {"geometry": None, "bbox": "bbox", "quad": "quad",
                       "rotation_degrees": "rotation_degrees", "clipped": "clipped"}
CLOSED_LINE_POINTER = re.compile(r"/lines/([0-9]{1,4})/([a-z0-9_]+)(?:/[a-z0-9_]+){0,3}\Z")
CLOSED_POINTER = re.compile(r"/[a-z0-9_]+(?:/[a-z0-9_]+){0,3}\Z")


def issue_position(normalized, collection, index):
    rows = normalized.get(collection) if isinstance(normalized, dict) else None
    row = rows[index] if isinstance(rows, list) and index is not None and index < len(rows) else None
    value = row.get("position") if isinstance(row, dict) else None
    return value if type(value) is int and 1 <= value <= 32767 else None


def issue_context(field, normalized):
    # Derived from the stored pointer before it is replaced by "/". Only closed
    # vocabulary and integers leave here: never a closed field name or its value.
    entity, index, position, attribute = "unknown", None, None, "unknown"
    if isinstance(field, str):
        parts = field[1:].split("/")
        if PUBLIC_POINTER.fullmatch(field):
            if parts[0] in ISSUE_COLLECTIONS:
                entity = ISSUE_COLLECTIONS[parts[0]]
                index = int(parts[1]) if len(parts) > 1 else None
                attribute = parts[2] if len(parts) > 2 else None
                attribute = "name" if attribute == "raw_name" else attribute
                if entity != "tax":
                    position = issue_position(normalized, parts[0], index)
            elif parts[0] in GEOMETRY_ATTRIBUTES:
                entity, attribute = "geometry", GEOMETRY_ATTRIBUTES[parts[0]]
            else:
                entity = "receipt"
                attribute = "currency" if field == "/currency_code" else "_".join(parts) or None
        elif match := CLOSED_LINE_POINTER.fullmatch(field):
            entity, index = "line", int(match[1])
            attribute = "product" if match[2] == "product_hint" else "unknown"
            position = issue_position(normalized, "lines", index)
        elif CLOSED_POINTER.fullmatch(field):
            entity, attribute = "receipt", "receipt_metadata"
    return {"entity": entity, "index": index, "position": position, "attribute": attribute}


def public_issues(issues, *, status, normalized):
    result = []
    for issue in issues[:1000] if isinstance(issues, list) else []:
        if not isinstance(issue, dict):
            continue
        code = issue.get("code")
        reason = code if isinstance(code, str) and code in ISSUE_REASONS else "unknown"
        code = code if isinstance(code, str) and code in ISSUE_MESSAGES else "invalid_value"
        field = issue.get("field")
        context = issue_context(field, normalized)
        field = field if isinstance(field, str) and PUBLIC_POINTER.fullmatch(field) else "/"
        if reason in INFO_REASONS:
            severity = "info"
        elif reason in WARNING_REASONS or status not in ("needs_review", "failed"):
            severity = "warning"
        else:
            severity = "error"
        result.append({"code": code, "field": field, "message": ISSUE_MESSAGES[code],
                       "reason": reason, "severity": severity, "context": context})
    return result


def media_url(file):
    return file.url if file else None


def related_count(queryset, group):
    return Coalesce(Subquery(queryset.order_by().values(group).annotate(n=Count("pk")).values("n")[:1]),
                    Value(0), output_field=IntegerField())


# Rows of the request's user only: every view and every other module takes receipts,
# photos, jobs and crops from the four ``*_queryset(request)`` below. A job and a crop
# have no owner of their own, it is the owner of their photo.


def annotate_photos(photos):
    return photos.annotate(
        latest_job_id=Subquery(ProcessingJob.objects.filter(photo_id=OuterRef("pk"))
                              .order_by("-created_at", "-id").values("id")[:1]),
        image_count=related_count(ReceiptImage.objects.filter(photo_id=OuterRef("pk")), "photo_id"),
    )


def photos_queryset(request):
    return annotate_photos(SourcePhoto.objects.filter(owner_q(request)))


def photo_object(photo):
    return {
        "id": photo.pk, "created_at": utc_datetime(photo.created_at),
        "content_type": photo.content_type, "bytes": photo.bytes,
        "raw_width": photo.raw_width, "raw_height": photo.raw_height,
        "width": photo.width, "height": photo.height,
        "original_url": media_url(photo.original_file), "preview_url": media_url(photo.upright_file),
        "latest_job_id": photo.latest_job_id, "receipt_images_count": photo.image_count,
    }


# Two-key advisory locks appear in pg_locks as classid/objid with objsubid = 2.
# Advisory locks are per database: without that filter a dev/QA worker on the
# same cluster would look alive to another database.
# The same statement tells whether the worker executes a batch of generic product
# suggestions (a classification run with a live lease): one query, as before.
WORKER_SLOT_HELD = """
    SELECT EXISTS (
        SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND classid = %s AND objid = %s AND objsubid = 2
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
    ), EXISTS (
        SELECT 1 FROM classification_classificationrun
        WHERE status = 'running' AND lease_expires_at > clock_timestamp()
    )
"""


def executor_object():
    # busy: a live execution lease, even when its worker has just died.
    # idle: no such lease, but the worker's session lock is held. There is no
    # stored idle heartbeat/slot; the API only reads the lock and never takes
    # it, or it could block a starting worker. Never infer from Celery.
    now = timezone.now()
    active = ProcessingJob.objects.filter(status__in=EXECUTING_JOB_STATUSES)
    latest = active.order_by("-heartbeat_at", "-id").values("heartbeat_at", "lease_expires_at").first()
    with connection.cursor() as cursor:
        cursor.execute(WORKER_SLOT_HELD, WORKER_LOCK)
        held, classifying = cursor.fetchone()
    if (latest and latest["lease_expires_at"] > now) or classifying:
        state = "busy"
    else:
        state = "idle" if held else "absent"
    return {"available": state != "absent", "state": state,
            "last_seen_at": utc_datetime(latest["heartbeat_at"]) if latest else None}


def annotate_jobs(jobs):
    return jobs.annotate(
        items_count=Count("images"),
        has_review=Exists(ReceiptImage.objects.filter(job_id=OuterRef("pk"))
                         .filter(REVIEW_IMAGES)),
        has_active_sibling=Exists(ProcessingJob.objects.filter(photo_id=OuterRef("photo_id"),
                                  status__in=["queued", "running", "cancel_requested"])),
    )


def jobs_queryset(request):
    return annotate_jobs(ProcessingJob.objects.filter(owner_q(request, "photo__")))


def images_queryset(request):
    return ReceiptImage.objects.filter(owner_q(request, "photo__"))


def job_object(job, executor, *, items=None):
    code = job.error_code
    error = None
    if code:
        code = code if code in ISSUE_MESSAGES else "provider_error"
        error = {"code": code, "message": ISSUE_MESSAGES[code]}
    result = {
        "id": job.pk, "photo_id": job.photo_id, "retry_of": job.retry_of_id,
        "status": job.status, "stage": job.stage, "version": job.version,
        **{key: utc_datetime(getattr(job, key)) for key in
           ("created_at", "started_at", "finished_at", "cancel_requested_at", "heartbeat_at")},
        "stalled": bool(job.status in EXECUTING_JOB_STATUSES and job.lease_expires_at <= timezone.now()),
        "executor": executor,
        "progress": {"detected": job.detected_count, "current_position": job.current_position,
                     **{name: getattr(job, name + "_count") for name in
                        ("completed", "imported", "reused", "review", "failed", "cancelled")}},
        "review_required": job.has_review or code in {"geometry_requires_review", "clipped", "overlap"},
        "error": error,
        "actions": {"can_cancel": job.status in {"queued", "running"},
                    "can_retry": job.status in {"cancelled", "partial_succeeded", "failed"}
                    and not job.has_active_sibling},
        "items_count": job.items_count,
    }
    if items is not None:
        result["items"] = [{"image_id": image.pk, "position": image.position, "status": image.status,
                            "receipt_id": image.receipt_id} for image in items]
    return result


def safe_text(value, limit=4096):
    if not isinstance(value, str) or len(value) > limit or re.search(r"[\x00-\x1f\x7f-\x9f]", value):
        return None
    return value


def safe_decimal(value, places):
    # Persisted observations use decimal strings. Reject floats, booleans and
    # malformed values rather than exposing arbitrary nested JSON or NaN.
    if not isinstance(value, str) or not re.fullmatch(r"-?[0-9]{1,12}(?:\.[0-9]{1,4})?", value):
        return None
    try:
        from api.common import decimal_string
        return decimal_string(Decimal(value), places)
    except (ValueError, InvalidOperation):
        return None


def safe_country(value):
    return value if isinstance(value, str) and re.fullmatch(r"[A-Z]{2}", value) else None


def safe_int(value):
    return value if type(value) is int and 0 <= value <= 32767 else None


def safe_bool(value):
    return value if type(value) is bool else None


def normalized_public(value):
    if not isinstance(value, dict):
        return None
    merchant = value.get("merchant") if isinstance(value.get("merchant"), dict) else {}
    store = value.get("store") if isinstance(value.get("store"), dict) else {}
    result = {
        "proposed_receipt": {
            "store": None, "store_display_name": safe_text(merchant.get("brand_name"), 100) or safe_text(store.get("name"), 255),
            "address_display": safe_text(store.get("address_raw")),
            "country": safe_country(store.get("country_code")) or safe_country(merchant.get("country_code")),
            "currency": safe_text(value.get("currency_code"), 3),
            "operation": value.get("operation") if value.get("operation") in ("sale", "refund") else None,
            "purchased_on": safe_text(value.get("purchased_on"), 10),
            "local_time": safe_text(value.get("local_time"), 8),
            "total": safe_decimal(value.get("total"), 2),
            "discount_total": safe_decimal(value.get("discount_total"), 2),
            "prices_include_tax": safe_bool(value.get("prices_include_tax")),
        }, "lines": [], "discounts": [], "taxes": [],
    }
    for line in value.get("lines", [])[:1000] if isinstance(value.get("lines"), list) else []:
        if not isinstance(line, dict):
            continue
        public = {
            "position": safe_int(line.get("position")), "parent_position": safe_int(line.get("parent_position")),
            "kind": line.get("kind") if line.get("kind") in ReceiptLine.Kind.values else None,
            "name": safe_text(line.get("raw_name")),
            "unit": line.get("unit") if line.get("unit") in ("pcs", "kg", "g", "l", "ml", "m") else None,
            **{key: safe_decimal(line.get(key), places) for key, places in
               (("quantity", 3), ("unit_price", 4), ("amount", 2), ("discount_amount", 2), ("tax_amount", 2))},
            **{key: safe_text(line.get(key), limit) for key, limit in
               (("store_item_code", 64), ("barcode", 32), ("tax_code", 8))},
            **{key: safe_bool(line.get(key)) for key in ("is_excise", "is_marked")},
            "tax_rate": normalized_tax_rate(line.get("tax_rate")),
        }
        result["lines"].append(public)
    for discount in value.get("discounts", [])[:1000] if isinstance(value.get("discounts"), list) else []:
        if isinstance(discount, dict):
            result["discounts"].append({"position": safe_int(discount.get("position")),
                "line_position": safe_int(discount.get("line_position")),
                "name": safe_text(discount.get("name"), 255), "amount": safe_decimal(discount.get("amount"), 2)})
    for tax in value.get("taxes", [])[:100] if isinstance(value.get("taxes"), list) else []:
        if isinstance(tax, dict):
            result["taxes"].append({"tax_rate": normalized_tax_rate(tax.get("tax_rate")),
                "tax_code": safe_text(tax.get("tax_code"), 8),
                **{key: safe_decimal(tax.get(key), 2) for key in ("net", "tax", "gross")}})
    return result


def normalized_tax_rate(value):
    value = value if isinstance(value, dict) else {}
    return {"kind": value.get("kind") if value.get("kind") in ("vat", "exempt") else None,
            "rate": safe_decimal(value.get("rate"), 2)}


def confirmation(image):
    """The private record of a human confirmation kept in ``outcome_snapshot``, or None."""
    snapshot = image.outcome_snapshot if isinstance(image.outcome_snapshot, dict) else {}
    confirmed = snapshot.get("confirmed")
    return confirmed if isinstance(confirmed, dict) else None


def confirmed_at(confirmed):
    value = confirmed.get("at") if confirmed else None
    pattern = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?Z"
    return value if isinstance(value, str) and re.fullmatch(pattern, value) else None


def image_object(image, *, detail=False):
    from recognition.images import ImageError, validate_geometry
    confirmed = confirmation(image)
    # Issues of a confirmation point into the corrected DTO, not the provider one.
    normalized = confirmed.get("result") if confirmed else image.normalized_result
    try:
        bbox, quad, rotation = validate_geometry(image.bbox, image.quad, image.rotation_degrees)
    except ImageError:
        bbox, quad, rotation = None, None, None
    result = {
        "id": image.pk, "photo_id": image.photo_id, "job_id": image.job_id,
        "position": image.position, "created_at": utc_datetime(image.created_at),
        "status": image.status, "receipt_id": image.receipt_id,
        "receipt_deleted": image.receipt_id is None and isinstance(image.outcome_snapshot, dict)
        and bool(image.outcome_snapshot.get("receipt_id")),
        "image_url": media_url(image.file), "width": image.width, "height": image.height,
        "bbox": bbox, "clipped": image.clipped, "issues": public_issues(
            image.issues, status=image.status, normalized=normalized),
        "normalized_result": normalized_public(image.normalized_result) if image.status == "needs_review" else None,
        "confirmed_at": confirmed_at(confirmed),
    }
    if detail:
        result.update(quad=quad, rotation_degrees=rotation)
    return result


def receipts_queryset(request):
    images = ReceiptImage.objects.filter(receipt_id=OuterRef("pk"))
    lines = ReceiptLine.objects.filter(receipt_id=OuterRef("pk"))
    return Receipt.objects.filter(owner_q(request)).select_related("store__merchant").annotate(
        lines_count=related_count(lines, "receipt_id"),
        unmatched_products_count=related_count(lines.filter(kind="product", product__isnull=True), "receipt_id"),
        image_count=related_count(images, "receipt_id"),
        preview_file=Subquery(images.order_by("-created_at", "-id").values("file")[:1]),
        has_review=Exists(images.filter(REVIEW_IMAGES)),
    )


def receipt_object(receipt):
    base = f"/api/receipts/{receipt.pk}"
    return {
        "id": receipt.pk, "store": store_object(receipt.store), "currency": receipt.currency_id,
        "operation": receipt.operation, "purchased_on": iso_date(receipt.purchased_on),
        "purchased_at": utc_datetime(receipt.purchased_at), "total": amount(receipt.total),
        "discount_total": amount(receipt.discount_total), "prices_include_tax": receipt.prices_include_tax,
        "origin": "recognized" if receipt.image_count else "legacy/manual",
        "review_required": bool(receipt.has_review or receipt.unmatched_products_count),
        "lines_count": receipt.lines_count, "unmatched_products_count": receipt.unmatched_products_count,
        "receipt_images_count": receipt.image_count,
        "preview_image_url": settings.MEDIA_URL + receipt.preview_file if receipt.preview_file else None,
        "created_at": utc_datetime(receipt.created_at), "updated_at": utc_datetime(receipt.updated_at),
        "lines_url": base + "/lines/", "discounts_url": base + "/discounts/", "taxes_url": base + "/taxes/",
        "images_url": f"/api/recognition/receipt-images/?receipt={receipt.pk}",
    }


def tax_rate_object(rate):
    return None if rate is None else {"id": rate.pk, "country": rate.country_id, "kind": rate.kind, "rate": percent(rate.rate)}


def line_object(line):
    with price_context():
        paid = line.amount - line.discount_amount
    return {
        "id": line.pk, "position": line.position, "kind": line.kind, "parent_id": line.parent_id,
        "name": line.raw_name, "name_i18n": {key: val for key, val in line.name_i18n.items()
            if re.fullmatch(r"[a-z]{2,3}(?:-[A-Za-z]{2,4})?", key) and isinstance(val, str)}
            if isinstance(line.name_i18n, dict) else {},
        "store_item_code": line.store_item_code, "barcode": line.barcode,
        "quantity": quantity(line.quantity), "unit": line.unit, "unit_price": price(line.unit_price),
        "amount": amount(line.amount), "discount_amount": amount(line.discount_amount), "paid_amount": amount(paid),
        "product": {"id": line.product_id, "name": line.product.name} if line.product_id else None,
        "matching_status": "matched" if line.product_id else "unmatched",
        "tax_rate": tax_rate_object(line.tax_rate), "tax_code": line.tax_code, "tax_amount": amount(line.tax_amount),
        "is_excise": line.is_excise, "is_marked": line.is_marked,
    }


def discount_object(discount):
    return {"id": discount.pk, "position": discount.position, "line_id": discount.line_id,
            "name": discount.name, "amount": amount(discount.amount)}


def tax_object(tax):
    return {"id": tax.pk, "tax_rate": tax_rate_object(tax.tax_rate), "tax_code": tax.tax_code,
            **{key: amount(getattr(tax, key)) for key in ("net", "tax", "gross")}}
