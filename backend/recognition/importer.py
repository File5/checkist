"""Fenced, atomic import of one already schema-validated ReceiptObservation.

import_receipt(image, observation, *, run_token, version, on_saved=None) -> ImportResult.
Pass result.job_version to subsequent queue writes. ImportBusy is a transient
control signal: defer this crop and keep its fence alive; no result is written.
FenceLost is propagated: cancelled/expired/stale work must not write anything.
Do not wrap this service in a caller transaction or run OCR while importing.
"""
import logging
from dataclasses import dataclass, replace
from datetime import date
from decimal import Decimal

from django.conf import settings
from django.core.exceptions import ValidationError
from django.db import IntegrityError, connection, transaction

from receipts.decimal_math import price_context
from receipts.dedup import build_fiscal_key, find_duplicates, name_key
from receipts.models import Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from receipts.validation import validate_receipt

from .dto import ReceiptObservation
from .import_policy import derive_line_values, optional_field, prepare_observation
from .models import ReceiptImage
from .queue import fenced_job, save_image_result
from .resolution import (
    ResolutionError, canonical_gtin, clean_save, issue, product_matches_hint, purchased_at, resolve_country,
    resolve_currency, resolve_product, resolve_store, resolve_tax_rate,
)
from .schema_validation import observation_issues
from .statuses import ImageStatus, ImportEffect, TERMINAL_IMAGE_STATUSES

# CK OCR IMP, distinct from category locks and the queue's two-int lock.
IMPORT_LOCK = 0x434B4F4352494D50
RECEIPT_UNIQUES = {
    "receipts_receipt_fiscal_key_uniq", "receipts_receipt_store_number_uniq",
    "receipts_receipt_store_time_total_uniq",
}


logger = logging.getLogger(__name__)


class ImportBusy(RuntimeError):
    code = "import_busy"


@dataclass(frozen=True)
class ImportResult:
    outcome: str
    receipt: Receipt | None
    issues: list
    image: ReceiptImage
    job_version: int


def _domain_observation(observation):
    """Derive only arithmetic/defaults with recorded JSON pointers, not facts."""
    observation, derived = derive_line_values(observation)
    taxes = []
    for i, tax in enumerate(observation.taxes):
        values = {k: getattr(tax, k) for k in ("net", "tax", "gross")}
        missing = [k for k, v in values.items() if v is None]
        if len(missing) == 1:
            key = missing[0]
            values[key] = (values["net"] + values["tax"] if key == "gross" else
                           values["gross"] - values["tax"] if key == "net" else
                           values["gross"] - values["net"])
            derived.append(f"/taxes/{i}/{key}")
        taxes.append(replace(tax, **values))
    lines = []
    for i, line in enumerate(observation.lines):
        values = {}
        linked = [d for d in observation.discounts if d.line_position == line.position]
        if line.discount_amount is None and all(d.amount is not None for d in linked):
            values["discount_amount"] = sum((d.amount for d in linked), Decimal(0))
            derived.append(f"/lines/{i}/discount_amount")
        for key in ("is_excise", "is_marked"):
            if getattr(line, key) is None:
                values[key] = False
                derived.append(f"/lines/{i}/{key}")
        lines.append(replace(line, **values))
    values = {}
    if observation.discount_total is None and all(d.amount is not None for d in observation.discounts):
        values["discount_total"] = sum((d.amount for d in observation.discounts), Decimal(0))
        derived.append("/discount_total")
    return replace(observation, taxes=tuple(taxes), lines=tuple(lines), **values), derived


def _detect_product_merges(receipt):
    """Duplicate search over the products of this receipt, in its own savepoint.

    Runs inside the import transaction under ``IMPORT_LOCK``. A failure rolls
    back the savepoint only and never the receipt; the next ``detect`` catches
    up. The log names the error class, never receipt data.
    """
    from merges import services  # lazy: merges.services imports IMPORT_LOCK from this module

    try:
        with transaction.atomic():
            product_ids = set(
                ReceiptLine.objects.filter(receipt=receipt, product__isnull=False).values_list("product_id", flat=True)
            )
            if product_ids:
                services.detect(product_ids=product_ids)
    except Exception as error:
        logger.error("Product merge detection after import failed: %s", type(error).__name__)


def effective_observation(observation):
    """Import policy and arithmetic of one observation: (effective, notices, derived)."""
    effective, notices = prepare_observation(observation)
    effective, derived = _domain_observation(effective)
    if any(v["code"] == "operation_defaulted" for v in notices):
        derived.append("/operation")
    if observation.prices_include_tax is None:
        derived.append("/prices_include_tax")
    return effective, notices, derived


def _preflight(observation, derived=(), *, store=None):
    issues = [issue(v["code"], v["path"]) for v in observation_issues(observation)]
    notices = [v for v in issues if v["code"] == "total_mismatch"
               and (v["field"] == "/discount_total" or v["field"].endswith("/discount_amount"))]
    issues = [v for v in issues if v not in notices]
    # C3 explicitly permits country inference. Store name can come from merchant,
    # and an existing branch may be resolved without reprinting its address.
    allowed = {"/store/country_code"}
    if observation.currency_code is None:
        # Resolve this only from an existing store; never from a guessed shop.
        allowed.add("/currency_code")
    if observation.merchant.legal_name or observation.merchant.brand_name:
        allowed.add("/store/name")
    if observation.store.branch_code:
        allowed.add("/store/address_raw")
    if store is not None:
        # A shop chosen by a person needs neither a printed name nor an address.
        allowed.update({"/store/name", "/store/address_raw"})
    issues = [v for v in issues if not (v["code"] == "missing_required" and v["field"] in allowed)]
    for evidence in observation.fields:
        parts = evidence.path.split("/")
        if (len(parts) == 4 and parts[1] == "lines" and parts[2].isdigit()
                and int(parts[2]) < len(observation.lines) and parts[3] in {"quantity", "unit_price", "amount", "unit"}
                and evidence.status in {"absent", "unreadable"} and evidence.path not in derived
                and getattr(observation.lines[int(parts[2])], parts[3]) is not None):
            issues.append(issue("invalid_value", evidence.path))
        if (evidence.status == "ambiguous" and not optional_field(evidence.path)
                and evidence.path not in {"/confidence", "/raw_text"} and evidence.path not in derived
                and not (evidence.path == "/currency_code" and observation.currency_code is None)):
            issues.append(issue("ambiguous_value", evidence.path))
    for i, discount in enumerate(observation.discounts):
        if not discount.name:
            issues.append(issue("missing_required", f"/discounts/{i}/name"))
    for i, tax in enumerate(observation.taxes):
        if None in (tax.net, tax.tax, tax.gross) or tax.tax_rate.kind is None:
            issues.append(issue("missing_required", f"/taxes/{i}"))
        if (tax.tax_rate.kind == "exempt" or tax.tax_rate.rate == 0) and tax.tax not in (None, 0):
            issues.append(issue("tax_mismatch", f"/taxes/{i}/tax"))
    for i, line in enumerate(observation.lines):
        if line.unit_price is not None and line.unit_price < 0:
            issues.append(issue("invalid_value", f"/lines/{i}/unit_price"))
    if issues:
        raise ResolutionError(*issues)
    return notices


def _header(observation, country, store, currency):
    fiscal = {k: v for k, v in observation.fiscal.to_dict().items() if v not in (None, "")}
    try:
        fiscal_key = build_fiscal_key(country.pk, fiscal)
    except ValueError:
        fiscal_key = ""  # Too long for the model; fall back to exact weak identity.
    return dict(
        store=store, currency=currency, operation=observation.operation,
        purchased_at=purchased_at(observation, store), purchased_on=date.fromisoformat(observation.purchased_on),
        receipt_number=observation.receipt_number or "", shift_number=observation.shift_number or "",
        register_code=observation.register_code or "", fiscal=fiscal, fiscal_key=fiscal_key,
        total=observation.total, discount_total=observation.discount_total,
        prices_include_tax=observation.prices_include_tax, raw_text=observation.raw_text or "",
    )


def _duplicate(header):
    candidates = find_duplicates(header)
    selected = []
    for candidate in candidates:
        fiscal = header["fiscal_key"] and candidate.fiscal_key == header["fiscal_key"]
        number = (all(header[k] for k in ("receipt_number", "register_code", "shift_number"))
                  and candidate.store_id == header["store"].pk
                  and candidate.purchased_on == header["purchased_on"]
                  and all(getattr(candidate, k) == header[k] for k in ("receipt_number", "register_code", "shift_number")))
        exact = (candidate.store_id == header["store"].pk and candidate.purchased_at == header["purchased_at"]
                 and candidate.total == header["total"])
        if fiscal or number or exact:
            if header["fiscal_key"] and candidate.fiscal_key and header["fiscal_key"] != candidate.fiscal_key:
                raise ResolutionError(issue("identity_conflict", "/fiscal"))
            if exact and all(header[k] and getattr(candidate, k) for k in ("receipt_number", "register_code", "shift_number")):
                if any(header[k] != getattr(candidate, k) for k in ("receipt_number", "register_code", "shift_number")):
                    raise ResolutionError(issue("identity_conflict", "/identity"))
            selected.append(candidate)
    if len(selected) > 1:
        # Exact weak matches denote the same receipt in v1. Prefer the actual
        # strong match; never choose between contradictory strong identities.
        keys = {c.fiscal_key for c in selected if c.fiscal_key}
        numbers = {(c.store_id, c.purchased_on, c.receipt_number, c.register_code, c.shift_number)
                   for c in selected if c.receipt_number and c.register_code and c.shift_number}
        if len(keys) > 1 or len(numbers) > 1:
            raise ResolutionError(issue("identity_conflict", "/identity"))
        selected.sort(key=lambda c: not (header["fiscal_key"] and c.fiscal_key == header["fiscal_key"]))
    return selected[0] if selected else None


def _create_graph(header, observation, country, derived, confirmed=None):
    stamp = observation.timestamps.fiscal if observation.timestamps.fiscal.time else observation.timestamps.header
    recognition = {
        "derived": derived, "time_precision": stamp.precision,
        "country_source": "observed" if observation.store.country_code or observation.merchant.country_code else "fallback",
        "timezone": header["store"].timezone, "utc_offset_printed": observation.utc_offset_printed,
    }
    if confirmed is not None:
        recognition["confirmed"] = confirmed
    receipt = clean_save(Receipt(**header, extra={"recognition": recognition}))
    issues, lines = [], {}
    def tax_rate(rate, field):
        # prepare_observation already requires observed kind/rate, and may
        # discard tax rows. Their new indexes need not match original evidence.
        return resolve_tax_rate(rate, country, field, confirmed=True)
    # Parents may occur after their child in the printed order. Create all rows
    # first, then connect only the already validated references.
    for i, observed in enumerate(observation.lines):
        resolution = _resolve_product(observed, header["store"].merchant, field=f"/lines/{i}/product_hint")
        product = resolution.product
        issues.extend(resolution.issues)
        rate = tax_rate(observed.tax_rate, f"/lines/{i}/tax_rate")
        values = {k: getattr(observed, k) for k in (
            "position", "kind", "raw_name", "quantity", "unit", "unit_price", "amount",
            "discount_amount", "tax_amount", "is_excise", "is_marked",
        )}
        values.update({k: getattr(observed, k) or "" for k in ("store_item_code", "barcode", "tax_code")})
        lines[observed.position] = clean_save(ReceiptLine(receipt=receipt, product=product, tax_rate=rate, **values))
    for observed in observation.lines:
        if observed.parent_position is not None:
            line = lines[observed.position]
            line.parent = lines[observed.parent_position]
            clean_save(line)
    for observed in observation.discounts:
        clean_save(ReceiptDiscount(
            receipt=receipt, line=lines.get(observed.line_position), position=observed.position,
            name=observed.name, amount=observed.amount,
        ))
    for i, observed in enumerate(observation.taxes):
        rate = tax_rate(observed.tax_rate, f"/taxes/{i}/tax_rate")
        if rate is None:
            raise ResolutionError(issue("missing_required", f"/taxes/{i}/tax_rate"))
        clean_save(ReceiptTax(receipt=receipt, tax_rate=rate, tax_code=observed.tax_code or "",
                              net=observed.net, tax=observed.tax, gross=observed.gross))
    if validate_receipt(receipt):
        # Core facts and total were checked before writes. Other invariants are
        # warnings (e.g. rounded unit prices); never expose private validator text.
        issues.append(issue("receipt_invalid", "/"))
    return receipt, ImportEffect.CREATED, issues


def _same_line(saved, observed):
    if name_key(saved.raw_name) != name_key(observed.raw_name):
        return False
    for key in ("kind", "quantity", "unit", "unit_price", "amount", "discount_amount"):
        if getattr(saved, key) != getattr(observed, key):
            return False
    if (saved.parent.position if saved.parent_id else None) != observed.parent_position:
        return False
    # Unknown optional facts do not contradict the old photograph.
    for key in ("store_item_code", "barcode", "tax_code", "tax_amount"):
        if getattr(observed, key) not in (None, "") and getattr(saved, key) not in (None, "", getattr(observed, key)):
            return False
    if observed.tax_rate.kind is not None and saved.tax_rate_id:
        if (saved.tax_rate.kind, saved.tax_rate.rate) != (observed.tax_rate.kind, observed.tax_rate.rate):
            return False
    return True


def _resolve_product(observed, merchant, *, field):
    from .resolution import ProductResolution

    try:
        with transaction.atomic():
            return resolve_product(observed, merchant, field=field)
    except ValidationError:
        # A bad optional catalogue hint must not discard the readable line or
        # leave an unused partial catalogue graph behind.
        return ProductResolution(None, [issue("product_package_invalid", field)])


def _update_graph(receipt, header, observation):
    receipt = Receipt.objects.select_for_update().get(pk=receipt.pk)
    issues, changed = [], False
    for key in ("store", "currency"):
        if getattr(receipt, key + "_id") != header[key].pk:
            issues.append(issue("receipt_conflict", "/" + key))
    for key in ("operation", "purchased_at", "purchased_on", "total", "discount_total", "prices_include_tax"):
        if getattr(receipt, key) != header[key]:
            issues.append(issue("receipt_conflict", "/local_time" if key == "purchased_at" else "/" + key))
    for key in ("receipt_number", "shift_number", "register_code"):
        value, previous = header[key], getattr(receipt, key)
        if previous and value and previous != value:
            issues.append(issue("receipt_conflict", "/" + key))
        elif not previous and value:
            setattr(receipt, key, value)
            changed = True
    fiscal = dict(receipt.fiscal) if isinstance(receipt.fiscal, dict) else {}
    if not isinstance(receipt.fiscal, dict):
        issues.append(issue("receipt_conflict", "/fiscal"))
    for key, value in (header["fiscal"].items() if isinstance(receipt.fiscal, dict) else ()):
        if fiscal.get(key) not in (None, "", value):
            issues.append(issue("receipt_conflict", "/fiscal/" + key))
    fiscal_conflict = any(v["field"].startswith("/fiscal/") for v in issues)
    for key, value in (header["fiscal"].items() if isinstance(receipt.fiscal, dict) else ()):
        if not fiscal_conflict and fiscal.get(key) in (None, ""):
            fiscal[key] = value
            changed = True
    if isinstance(receipt.fiscal, dict):
        receipt.fiscal = fiscal
    if not receipt.fiscal_key and header["fiscal_key"]:
        try:
            consistent = isinstance(receipt.fiscal, dict) and build_fiscal_key(receipt.store.country_id, fiscal) == header["fiscal_key"]
        except ValueError:
            consistent = False
        if consistent:
            receipt.fiscal_key = header["fiscal_key"]
            changed = True
        else:
            issues.append(issue("receipt_conflict", "/fiscal"))
    if not receipt.raw_text and header["raw_text"]:
        receipt.raw_text = header["raw_text"]
        changed = True
    lines = list(receipt.lines.select_for_update(of=("self",)).select_related("parent", "tax_rate", "product__brand").order_by("position"))
    observed_lines = {line.position: line for line in observation.lines}
    line_indexes = {line.position: i for i, line in enumerate(observation.lines)}
    if {line.position for line in lines} != set(observed_lines):
        issues.append(issue("receipt_structure_conflict", "/lines"))
    for line in lines:
        observed = observed_lines.get(line.position)
        field = f"/lines/{line_indexes[line.position]}" if observed is not None else "/lines"
        if observed is None or not _same_line(line, observed):
            issues.append(issue("receipt_line_conflict", field))
            continue
        if line.kind == "product" and line.product_id is None:
            resolution = _resolve_product(observed, receipt.store.merchant, field=field + "/product_hint")
            issues.extend(resolution.issues)
            if resolution.product:
                line.product = resolution.product
                clean_save(line)
                changed = True
        elif line.product_id:
            # Inspect a stronger identity without creating unused products/aliases.
            gtins = {g for g in (canonical_gtin(observed.product_hint.gtin), canonical_gtin(observed.barcode)) if g}
            if len(gtins) > 1 or not product_matches_hint(line.product, observed.product_hint, next(iter(gtins), None)):
                issues.append(issue("product_conflict", field + "/product_hint"))
    saved_discounts = [(d.position, d.line.position if d.line_id else None, name_key(d.name), d.amount)
                       for d in receipt.discounts.select_related("line").order_by("position")]
    new_discounts = sorted((d.position, d.line_position, name_key(d.name), d.amount) for d in observation.discounts)
    if saved_discounts != new_discounts:
        issues.append(issue("receipt_structure_conflict", "/discounts"))
    saved_taxes = {(t.tax_rate.kind, t.tax_rate.rate): (t.net, t.tax, t.gross)
                   for t in receipt.taxes.select_related("tax_rate")}
    new_taxes = {(t.tax_rate.kind, t.tax_rate.rate): (t.net, t.tax, t.gross) for t in observation.taxes}
    if saved_taxes != new_taxes:
        issues.append(issue("receipt_structure_conflict", "/taxes"))
    if changed:
        clean_save(receipt)
    return receipt, ImportEffect.UPDATED if changed else ImportEffect.LINKED, issues


def _import_domain(observation, derived, *, require_duplicate=False, link_only=False, store=None, confirmed=None):
    """Resolve, deduplicate and write one effective observation; raises ResolutionError.

    ``store`` is a shop already chosen by a person: it replaces store and
    country resolution. ``confirmed`` is recorded in ``extra`` of a NEW receipt
    only; an existing receipt is never rewritten.
    """
    notices = _preflight(observation, derived, store=store)
    country = resolve_country(observation) if store is None else store.country
    with transaction.atomic():
        if store is None:
            store = resolve_store(observation, country, allow_create=observation.currency_code is not None,
                                  notices=notices)
        if store is None:
            raise ResolutionError(issue("missing_required", "/currency_code"))
        currency = resolve_currency(observation, store=store)
        if observation.currency_code is None:
            derived = [*derived, "/currency_code"]
            notices.append(issue("currency_inferred", "/currency_code", "Валюта определена по стране известного магазина."))
        if observation.merchant.tax_id_type and store.merchant.tax_id_type and observation.merchant.tax_id_type != store.merchant.tax_id_type:
            notices.append(issue("merchant_conflict", "/merchant/tax_id_type"))
        header = _header(observation, country, store, currency)
        receipt = _duplicate(header)
        if receipt and receipt.store_id != store.pk:
            # A global fiscal match can expose a contradictory shop observation.
            # Keep the candidate/header in memory, roll back unused new stores.
            transaction.set_rollback(True)
    if receipt:
        if link_only:
            return receipt, ImportEffect.LINKED, notices + [issue("receipt_conflict", "/")]
        receipt, effect, issues = _update_graph(receipt, header, observation)
        return receipt, effect, notices + issues
    if require_duplicate:
        raise ResolutionError(issue("identity_conflict", "/"))
    # The worker's call stays exactly as it was; only a confirmation adds its mark.
    mark = () if confirmed is None else (confirmed,)
    receipt, effect, issues = _create_graph(header, observation, country, derived, *mark)
    return receipt, effect, notices + issues


def _constraint_name(error):
    return getattr(getattr(error.__cause__, "diag", None), "constraint_name", None)


def import_receipt(image, observation, *, run_token, version, on_saved=None):
    """Returns created/linked/updated/needs_review/failed, receipt or None, issues.

    Non-blocking notices may accompany a successful Receipt (e.g. an ambiguous
    product). Domain failure rolls back the ENTIRE store/catalog/receipt graph;
    normalized input and safe issues are persisted outside that savepoint.
    A busy mutex or invalid fence raises without changing the image/version.
    Optional on_saved(locked_job) -> job runs after linkage, inside the SAME
    durable transaction. The worker uses it to terminalize the final import
    atomically; it must only perform fenced DB writes, never provider/file I/O.
    """
    if not isinstance(observation, ReceiptObservation):
        raise TypeError("observation must be a schema-validated ReceiptObservation")
    image_id = image.pk
    normalized = observation.to_dict()
    with price_context():
        effective, notices, derived = effective_observation(observation)
        with transaction.atomic(durable=True):
            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [IMPORT_LOCK])
                if not cursor.fetchone()[0]:
                    raise ImportBusy()
            with fenced_job(image.job_id, run_token, version) as job:
                current = ReceiptImage.objects.select_for_update().get(pk=image_id, job=job, photo_id=job.photo_id)
                if current.status in TERMINAL_IMAGE_STATUSES:
                    # Recovery can replay a committed crop without new writes.
                    outcome = ("needs_review" if current.status == ImageStatus.NEEDS_REVIEW else
                               "failed" if current.status in {ImageStatus.FAILED, ImageStatus.CANCELLED} else current.import_effect)
                    if on_saved is not None:
                        job = on_saved(job)
                    return ImportResult(outcome, current.receipt, current.issues, current, job.version)
                receipt, effect, issues = None, ImportEffect.NONE, []
                status = None
                try:
                    with transaction.atomic():
                        receipt, effect, issues = _import_domain(effective, derived)
                except IntegrityError as error:
                    if _constraint_name(error) in RECEIPT_UNIQUES:
                        # A writer outside the OCR mutex won a known unique race.
                        # Re-read after rollback, once; never retry the create.
                        try:
                            with transaction.atomic():
                                receipt, effect, issues = _import_domain(effective, derived, require_duplicate=True)
                        except ResolutionError as problem:
                            receipt, effect, issues = None, ImportEffect.NONE, problem.issues
                        except IntegrityError as retry_error:
                            if _constraint_name(retry_error) in RECEIPT_UNIQUES:
                                try:
                                    with transaction.atomic():
                                        receipt, effect, issues = _import_domain(effective, derived, require_duplicate=True, link_only=True)
                                except ResolutionError as problem:
                                    receipt, effect, issues = None, ImportEffect.NONE, problem.issues
                                except Exception:
                                    status, issues = ImageStatus.FAILED, [issue("import_failed", "/", "Не удалось сохранить чек.")]
                            else:
                                status, issues = ImageStatus.FAILED, [issue("import_failed", "/", "Не удалось сохранить чек.")]
                        except Exception:
                            status, issues = ImageStatus.FAILED, [issue("import_failed", "/", "Не удалось сохранить чек.")]
                    else:
                        status, issues = ImageStatus.FAILED, [issue("import_failed", "/", "Не удалось сохранить чек.")]
                except ResolutionError as problem:
                    issues = problem.issues
                except ValidationError:
                    issues = [issue("invalid_value", "/", "Значения не соответствуют модели чека.")]
                except Exception:
                    status, issues = ImageStatus.FAILED, [issue("import_failed", "/", "Не удалось сохранить чек.")]
                if receipt is not None and settings.PRODUCT_MERGE_AUTO_DETECT:
                    _detect_product_merges(receipt)
                if status is None:
                    status = ImageStatus.NEEDS_REVIEW if receipt is None else {
                        ImportEffect.CREATED: ImageStatus.IMPORTED, ImportEffect.LINKED: ImageStatus.REUSED,
                        ImportEffect.UPDATED: ImageStatus.UPDATED,
                    }[effect]
                issues = notices + issues
                if current.clipped:
                    issues.append(issue("clipped", "/clipped"))
                saved, job = save_image_result(
                    job.pk, run_token, version, image_id, status=status, normalized_result=normalized,
                    issues=issues, receipt=receipt, import_effect=effect,
                )
                if on_saved is not None:
                    job = on_saved(job)
                outcome = "needs_review" if status == ImageStatus.NEEDS_REVIEW else "failed" if status == ImageStatus.FAILED else effect
                return ImportResult(outcome, receipt, issues, saved, job.version)
