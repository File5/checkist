"""Discard uncertain optional observations, preserving the original DTO for audit.

No guessed identifiers or product assignments. Explicit quantity defaults and
arithmetic derivations are recorded separately from printed facts. Issue objects
keep the public v1 shape; successful imports can carry non-blocking notices.
"""
import re
from dataclasses import fields, is_dataclass, replace
from decimal import Decimal, ROUND_HALF_UP

from receipts.dedup import FISCAL_KEY_PARTS, build_fiscal_key
from .resolution import COUNTRY_BY_CURRENCY, issue


def optional_field(path):
    return (path.startswith(("/fiscal/", "/taxes/", "/discounts/"))
            or path in {"/operation", "/receipt_number", "/shift_number", "/register_code", "/discount_total",
                        "/prices_include_tax", "/merchant/tax_id", "/merchant/tax_id_type",
                        "/merchant/legal_name", "/merchant/brand_name", "/store/name", "/store/branch_code",
                        "/store/postal_code", "/store/region", "/store/city", "/store/street", "/store/house"}
            or path.startswith("/lines/") and len(path.split("/")) > 3 and path.split("/")[3] in {
                "store_item_code", "barcode", "tax_rate", "tax_code", "tax_amount",
                "is_excise", "is_marked", "product_hint", "parent_position", "discount_amount",
            })


def prepare_observation(observation):
    evidence = {f.path: f.status for f in observation.fields}
    notices = []

    def omit(path):
        item = issue("optional_omitted", path, "Необязательное поле пропущено.")
        if item not in notices:
            notices.append(item)

    def mask(value, path=""):
        if is_dataclass(value):
            return replace(value, **{f.name: mask(getattr(value, f.name), path + "/" + f.name)
                                     for f in fields(value) if f.name not in {"fields", "warnings"}})
        if isinstance(value, tuple):
            return tuple(mask(v, path + f"/{i}") for i, v in enumerate(value))
        strong_part = path.startswith("/fiscal/") or path in {
            "/receipt_number", "/shift_number", "/register_code", "/merchant/tax_id", "/merchant/tax_id_type",
            "/store/branch_code",
        }
        if optional_field(path) and ((evidence.get(path) in {"ambiguous", "unreadable"})
                              or strong_part and value not in (None, "") and evidence.get(path) != "observed"):
            omit(path)
            return None
        return value

    effective = mask(observation)
    if effective.receipt_number and not (effective.register_code and effective.shift_number):
        # Receipt's number unique constraint also applies to incomplete tuples.
        # Do not let such a tuple masquerade as strong identity and prevent a
        # new receipt at a different exact time/total. Original DTO keeps it.
        omit("/receipt_number")
        effective = replace(effective, receipt_number=None)
    if effective.operation is None:
        # A printed return heading or negative product quantities is explicit
        # return evidence; returning a bottle alone is still a sale receipt.
        refund = any(l.kind == "product" and l.quantity is not None and l.quantity < 0
                     for l in effective.lines) or bool(re.search(
                         r"(?im)^\s*(?:refund|retour(?:e)?|r[üu]ckgabe|возврат(?: прихода)?|қайтару)\b",
                         effective.raw_text or ""))
        effective = replace(effective, operation="refund" if refund else "sale")
        notices.append(issue("operation_defaulted", "/operation", "Тип операции определён при импорте."))
    if effective.prices_include_tax is None:
        effective = replace(effective, prices_include_tax=True)
        notices.append(issue("optional_omitted", "/prices_include_tax"))

    merchant = effective.merchant
    country = effective.store.country_code or merchant.country_code or COUNTRY_BY_CURRENCY.get(effective.currency_code)
    tax_type = merchant.tax_id_type or {"RU": "inn", "KZ": "bin", "DE": "vat_id"}.get(country)
    tax_id = "".join((merchant.tax_id or "").split()).upper()
    pattern = {"inn": r"(?:[0-9]{10}|[0-9]{12})", "bin": r"[0-9]{12}"}.get(tax_type)
    if tax_type == "vat_id" and country == "DE":
        pattern = r"DE[0-9]{9}"
    if tax_id and pattern and not re.fullmatch(pattern, tax_id):
        omit("/merchant/tax_id")
        effective = replace(effective, merchant=replace(merchant, tax_id=None, tax_id_type=None))
    try:
        build_fiscal_key(country, effective.fiscal.to_dict())
    except ValueError:
        for key in FISCAL_KEY_PARTS.get(country, ()):
            omit("/fiscal/" + key)
        effective = replace(effective, fiscal=replace(effective.fiscal, **{
            key: None for key in FISCAL_KEY_PARTS.get(country, ())
        }))

    lines = []
    for i, line in enumerate(effective.lines):
        hint = line.product_hint
        if (hint.package_quantity is None) != (hint.package_unit is None) or hint.package_quantity is not None and hint.package_quantity <= 0:
            omit(f"/lines/{i}/product_hint/package_quantity")
            hint = replace(hint, package_quantity=None, package_unit=None)
        rate = line.tax_rate
        if not _usable_rate(rate, evidence, f"/lines/{i}/tax_rate"):
            if rate.kind is not None or rate.rate is not None:
                omit(f"/lines/{i}/tax_rate")
            rate = replace(rate, kind=None, rate=None)
        parent = line.parent_position
        if parent is not None and (line.kind != "deposit" or parent == line.position
                                  or not any(l.position == parent and l.kind == "product" for l in effective.lines)):
            omit(f"/lines/{i}/parent_position")
            parent = None
        lines.append(replace(line, product_hint=hint, tax_rate=rate, parent_position=parent))

    taxes = []
    for i, tax in enumerate(effective.taxes):
        values = [tax.net, tax.tax, tax.gross]
        invalid = (not _usable_rate(tax.tax_rate, evidence, f"/taxes/{i}/tax_rate")
                   or values.count(None) > 1
                   or None not in values and tax.net + tax.tax != tax.gross
                   or (tax.tax_rate.kind == "exempt" or tax.tax_rate.rate == 0) and tax.tax not in (None, 0)
                   or any(t.tax_rate == tax.tax_rate for t in taxes))
        if invalid:
            omit(f"/taxes/{i}")
        else:
            taxes.append(tax)
    if taxes and effective.total is not None:
        gross = sum((t.gross if t.gross is not None else t.net + t.tax for t in taxes), Decimal(0))
        if gross != effective.total:
            omit("/taxes")
            taxes = []
    discounts = []
    for i, discount in enumerate(effective.discounts):
        if not discount.name or discount.amount is None or discount.amount <= 0:
            omit(f"/discounts/{i}")
        else:
            if discount.line_position is not None and not any(l.position == discount.line_position for l in lines):
                omit(f"/discounts/{i}/line_position")
                discount = replace(discount, line_position=None)
            discounts.append(discount)
    # These aggregates are arithmetic, not independent printed identities.
    for i, line in enumerate(lines):
        amount = sum((d.amount for d in discounts if d.line_position == line.position), Decimal(0))
        if line.discount_amount not in (None, amount):
            omit(f"/lines/{i}/discount_amount")
            lines[i] = replace(line, discount_amount=None)
    discount_total = effective.discount_total
    if discount_total not in (None, sum((d.amount for d in discounts), Decimal(0))):
        omit("/discount_total")
        discount_total = None
    return replace(effective, lines=tuple(lines), taxes=tuple(taxes), discounts=tuple(discounts),
                   discount_total=discount_total), notices


def _usable_rate(rate, evidence, path):
    return (rate.kind in {"vat", "exempt"} and evidence.get(path + "/kind") == "observed"
            and (rate.kind == "exempt" and rate.rate is None or rate.kind == "vat" and rate.rate is not None
                 and rate.rate >= 0 and evidence.get(path + "/rate") == "observed"))


def derive_line_values(observation):
    """Use two printed numbers; never round an inferred quantity or price.

    A missing amount follows the receipt's cent precision. Amount-only product
    and deposit lines default to one piece; negative deposit returns to minus one.
    Unit defaults use only this line's evidence for a weight/volume rate.
    Unreadable/ambiguous units and non-null uncertain numbers stay unresolved.
    """
    evidence = {f.path: f.status for f in observation.fields}
    derived, lines = [], []
    weight_rate = r"(?:/\s*|\b(?:per|pro|за)\s+)(?:kg|g|l|ml|кг|г|л|мл)\b"
    for i, line in enumerate(observation.lines):
        path = f"/lines/{i}"
        values = {key: getattr(line, key) for key in ("quantity", "unit_price", "amount")}
        unit = line.unit
        weighted = re.search(weight_rate, line.raw_name or "", re.IGNORECASE)
        defaulted = (line.kind in {"product", "deposit", "deposit_return"}
                     and line.quantity is None and line.unit_price is None and line.amount is not None
                     and evidence.get(path + "/amount") == "observed"
                     and all(evidence.get(path + "/" + key) in (None, "absent")
                             for key in ("quantity", "unit_price"))
                     and (unit == "pcs" or unit is None and evidence.get(path + "/unit") in (None, "absent"))
                     and not weighted
                     and (line.amount < 0 if line.kind == "deposit_return" else line.amount >= 0))
        if defaulted:
            values.update(quantity=Decimal("-1.000") if line.kind == "deposit_return" else Decimal("1.000"),
                          unit_price=abs(line.amount).quantize(Decimal("0.0001")))
            derived.extend((path + "/quantity", path + "/unit_price"))
        missing = [key for key, value in values.items() if value is None]
        if len(missing) == 1 and all(evidence.get(path + "/" + key) == "observed"
                                     for key in values if key not in missing):
            key = missing[0]
            quantity, price, amount = (values[k] for k in ("quantity", "unit_price", "amount"))
            value = None
            if key == "amount":
                value = (quantity * price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
            elif key == "quantity" and price > 0:
                candidate = amount / price
                if candidate == candidate.quantize(Decimal("0.001")):
                    value = candidate.quantize(Decimal("0.001"))
            elif key == "unit_price" and quantity != 0:
                candidate = amount / quantity
                if candidate == candidate.quantize(Decimal("0.0001")):
                    value = candidate.quantize(Decimal("0.0001"))
            if value is not None:
                values[key] = value
                derived.append(path + "/" + key)
        if (unit is None and evidence.get(path + "/unit") in (None, "absent")
                and (defaulted or evidence.get(path + "/quantity") == "observed")
                and values["quantity"] is not None
                and values["quantity"] == values["quantity"].to_integral_value() and not weighted):
            unit = "pcs"
            derived.append(path + "/unit")
        lines.append(replace(line, unit=unit, **values))
    return replace(observation, lines=tuple(lines)), derived
