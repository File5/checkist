"""Public shapes of the product-merge API. Private receipt fields never leave here."""
from api.common import amount, iso_date, price, quantity, store_brief, utc_datetime
from api.views.catalog import alias_objects
from merges import services


def _member_object(info, aliases):
    facts = info.facts
    package = facts.get("package")
    result = {
        "product_id": info.member.product_ref,
        "role": info.member.role,
        "state": info.member.state,
        "exists": info.exists,
        "name": info.name,
        "brand": facts.get("brand"),
        "model": facts.get("model", ""),
        "gtin": facts.get("gtin", ""),
        "package": package and {"quantity": quantity(package["quantity"]), "unit": package["unit"]},
        "generic": facts.get("generic"),
        "classified": info.classified,
        "lines_count": info.lines_count,
        "first_purchased_on": iso_date(info.first_purchased_on),
        "last_purchased_on": iso_date(info.last_purchased_on),
    }
    if aliases is not None:
        result["aliases"] = aliases
    return result


def _group_object(info, *, brief):
    group = info.group
    aliases = {}
    if not brief:
        # One call for the whole group: stores of merchants without a sign are read once.
        flat = [(member.member.pk, alias) for member in info.members for alias in member.aliases]
        for (member_id, _), value in zip(flat, alias_objects([alias for _, alias in flat])):
            aliases.setdefault(member_id, []).append(value)
    result = {
        "id": group.pk,
        "status": group.status,
        "version": group.version,
        "created_at": utc_datetime(group.created_at),
        "resolved_at": utc_datetime(group.resolved_at),
        "target_product_id": group.target_ref,
        "members": [
            _member_object(member, None if brief else aliases.get(member.member.pk, []))
            for member in info.members
        ],
    }
    if brief:
        result["has_conflicts"] = bool(info.conflicts)
    else:
        result["conflicts"] = [
            {"field": field, "product_ids": list(product_ids)} for field, product_ids in info.conflicts
        ]
    result.update({
        "lines_count": info.lines_count,
        "new_lines_count": info.new_lines_count,
        "actions": {
            "can_confirm": info.can_confirm, "can_cancel": info.can_cancel, "can_exclude": info.can_exclude,
        },
    })
    return result


def group_object(group):
    """Full «Группа» of the contract."""
    return _group_object(services.describe_group(group), brief=False)


def group_briefs(groups):
    """Brief groups of one list page: no ``aliases``, ``has_conflicts`` instead of ``conflicts``."""
    groups = list(groups)
    if not groups:
        return []
    return [_group_object(info, brief=True) for info in services.describe(groups, with_aliases=False)]


def line_object(line, own=True):
    """A purchase of the group; ``origin_product_id`` is ``None`` for a line that came after the merge.

    ``own=False`` — a line of somebody else's receipt (only a moderator gets those):
    ``receipt_id`` is ``None``, the receipt cannot be opened; the other fields stay.
    """
    receipt = line.receipt
    return {
        "line_id": line.pk,
        "receipt_id": line.receipt_id if own else None,
        "position": line.position,
        "purchased_on": iso_date(receipt.purchased_on),
        "store": store_brief(receipt.store),
        "name": line.raw_name,
        "quantity": quantity(line.quantity),
        "unit": line.unit,
        "unit_price": price(line.unit_price),
        "amount": amount(line.amount),
        "discount_amount": amount(line.discount_amount),
        "currency": receipt.currency_id,
        "origin_product_id": line.origin_product_id,
    }
