"""Provisional product merges: detect, confirm, cancel, exclude.

Links are moved physically at the provisional stage: receipt lines and aliases
of absorbed products point at the surviving one, and the journal remembers who
owned what. Only ``product_id`` of a line or an alias is ever rewritten.

Every mutating operation is one transaction. It first takes the import mutex
(``recognition.importer.IMPORT_LOCK``, non-blocking), so imports and merges run
strictly in turn, then locks the group and its products in ascending id order.
A busy mutex or a lock wait beyond ``statement_timeout`` raises ``MergeBusy``
with a full rollback and no hidden retry. Writers outside the mutex (admin,
raw ORM/SQL) are only covered by the row locks.
"""
import json
import logging
from collections import defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field
from itertools import combinations

from django.db import DatabaseError, IntegrityError, connection, transaction
from django.db.models import Count, F, Max, Min, OuterRef, Subquery
from django.utils import timezone

from catalog.models import Product
from merges import detection
from merges.models import (
    ProductMerge, ProductMergeAlias, ProductMergeLine, ProductMergeMember, ProductMergeRejection,
)
from receipts.dedup import name_key
from receipts.models import ProductAlias, ReceiptLine

logger = logging.getLogger(__name__)

Status = ProductMerge.Status
Role = ProductMergeMember.Role
State = ProductMergeMember.State

# Lock not available, statement timeout, deadlock.
BUSY_SQLSTATES = frozenset({"55P03", "57014", "40P01"})
FACT_FIELDS = ("generic", "brand", "package", "gtin", "model", "attributes")
PRODUCT_UNIQUES = {
    "catalog_product_gtin_uniq": "gtin",
    "catalog_product_brand_name_package_uniq": "name",
}
ALIASES_LIMIT = 50


class MergeError(Exception):
    """Base class; ``code`` matches the API error code of the contract."""

    code = "merge_error"


class MergeNotFound(MergeError):
    code = "not_found"


class MergeBusy(MergeError):
    """An import or another merge operation holds the catalog; nothing was changed."""

    code = "merge_busy"


class MergeResolved(MergeError):
    """The group is already confirmed or cancelled."""

    code = "merge_resolved"

    def __init__(self, group):
        self.group = group
        super().__init__(self.code)


class MergeChanged(MergeError):
    """``version`` is stale: the member set changed after the client read the group."""

    code = "merge_changed"

    def __init__(self, group):
        self.group = group
        super().__init__(self.code)


class MergeConflict(MergeError):
    """Facts contradict and no human decision was given, or the result is not unique.

    ``fields`` maps a field to the ids of products holding the different values;
    for a unique violation against an outside product the list is empty.
    """

    code = "merge_conflict"

    def __init__(self, fields):
        self.fields = fields
        super().__init__(self.code)


class MergeInvalidParameter(MergeError):
    """``fields`` maps a parameter name to a short reason code."""

    code = "invalid_parameter"

    def __init__(self, fields):
        self.fields = fields
        super().__init__(self.code)


@dataclass(frozen=True)
class DetectResult:
    created: int
    extended: int
    group_ids: list
    proposals: list = field(default_factory=list)
    dry_run: bool = False


@dataclass
class MemberInfo:
    member: ProductMergeMember
    product: Product | None  # live product; None once it is deleted
    name: str
    facts: dict
    lines_count: int = 0
    first_purchased_on: object = None
    last_purchased_on: object = None
    aliases: list = field(default_factory=list)  # journal ProductAlias objects, merchant loaded

    @property
    def exists(self):
        return self.product is not None

    @property
    def classified(self):
        return not detection.is_service_generic((self.facts.get("generic") or {}).get("name"))


@dataclass
class GroupInfo:
    group: ProductMerge
    members: list
    conflicts: list  # [(field, [product ids])], live data of a pending group
    lines_count: int
    new_lines_count: int

    @property
    def pending(self):
        return self.group.status == Status.PENDING

    can_confirm = can_cancel = can_exclude = pending


def _sqlstate(error):
    return getattr(error.__cause__, "sqlstate", None)


def _constraint_name(error):
    return getattr(getattr(error.__cause__, "diag", None), "constraint_name", None)


@contextmanager
def _mutation():
    try:
        with transaction.atomic():
            from recognition.importer import IMPORT_LOCK  # lazy: the importer calls this module

            with connection.cursor() as cursor:
                cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [IMPORT_LOCK])
                if not cursor.fetchone()[0]:
                    raise MergeBusy(MergeBusy.code)
            yield
    except IntegrityError as error:
        unique = PRODUCT_UNIQUES.get(_constraint_name(error))
        if unique is None:
            raise
        raise MergeConflict({unique: []}) from None
    except DatabaseError as error:
        if _sqlstate(error) not in BUSY_SQLSTATES:
            raise
        raise MergeBusy(MergeBusy.code) from None


def _is_id(value):
    return isinstance(value, int) and not isinstance(value, bool)


def product_facts(product):
    """JSON snapshot of the facts; ``generic`` must be loaded."""
    return {
        "generic": {
            "id": product.generic_id, "name": product.generic.name, "base_unit": product.generic.base_unit,
        },
        "brand": {"id": product.brand_id, "name": product.brand.name} if product.brand_id else None,
        "model": product.model,
        "gtin": product.gtin,
        "package": (
            {"quantity": str(product.package_quantity), "unit": product.package_unit}
            if product.package_quantity is not None else None
        ),
        "attributes": product.attributes or {},
    }


def _fact_value(product, name):
    """Comparable value of a fact; ``None`` means empty."""
    if name == "generic":
        return None if detection.is_service_generic(product.generic.name) else product.generic_id
    if name == "brand":
        return product.brand_id
    if name == "package":
        return None if product.package_quantity is None else (product.package_quantity, product.package_unit)
    if name == "gtin":
        return detection.gtin_key(product.gtin) or None
    if name == "model":
        return product.model.strip() or None
    return json.dumps(product.attributes, sort_keys=True, ensure_ascii=False) if product.attributes else None


def _copy_fact(target, source, name):
    if name == "generic":
        target.generic = source.generic
    elif name == "brand":
        target.brand = source.brand
    elif name == "package":
        target.package_quantity, target.package_unit = source.package_quantity, source.package_unit
    else:
        setattr(target, name, getattr(source, name))


def find_conflicts(products):
    """``{field: [ids of products with a value]}`` where two or more distinct values exist."""
    conflicts = {}
    for name in FACT_FIELDS:
        values = {product.pk: _fact_value(product, name) for product in products}
        filled = {pk: value for pk, value in values.items() if value is not None}
        if len(set(filled.values())) > 1:
            conflicts[name] = sorted(filled)
    return conflicts


def _candidate(product, merchants):
    return detection.Candidate(
        id=product.pk, name=product.name, merchants=frozenset(merchants),
        gtin=product.gtin, brand=product.brand_id, model=product.model,
        package=None if product.package_quantity is None else (product.package_quantity, product.package_unit),
        service_generic=detection.is_service_generic(product.generic.name),
    )


def _load_candidates():
    """Candidates of the whole catalog and the member sets of pending groups.

    Aliases of an absorbed product already point at the surviving one, so the
    merchant of a journaled alias is credited to the member that owned it.
    """
    existing, member_product = defaultdict(set), {}
    for member_id, group_id, product_ref in ProductMergeMember.objects.filter(
        active_product__isnull=False,
    ).values_list("id", "group_id", "product_ref"):
        existing[group_id].add(product_ref)
        member_product[member_id] = product_ref
    owner = {
        alias_id: member_product[member_id]
        for alias_id, member_id in ProductMergeAlias.objects.filter(
            member_id__in=member_product,
        ).values_list("alias_id", "member_id")
    }
    merchants = defaultdict(set)
    for alias_id, product_id, merchant_id in ProductAlias.objects.values_list("id", "product_id", "merchant_id"):
        merchants[owner.get(alias_id, product_id)].add(merchant_id)
    candidates = [
        _candidate(product, merchants.get(product.pk, ()))
        for product in Product.objects.select_related("generic").order_by("pk")
    ]
    return candidates, dict(existing)


def _rejected_pairs():
    return frozenset(ProductMergeRejection.objects.values_list("product_low_id", "product_high_id"))


def _lock_group(group_id):
    try:
        return ProductMerge.objects.select_for_update().get(pk=group_id)
    except (ProductMerge.DoesNotExist, ValueError, TypeError):
        raise MergeNotFound(MergeNotFound.code) from None


def _lock_products(ids):
    """``FOR UPDATE`` in ascending id order; also holds back new references to these products."""
    return {
        product.pk: product
        for product in Product.objects.select_for_update(of=("self",)).select_related("generic", "brand").filter(
            pk__in=ids,
        ).order_by("pk")
    }


def _active(group):
    return sorted(
        (member for member in group.members.all() if member.state == State.ACTIVE),
        key=lambda member: member.product_ref,
    )


def _absorb(group, members, target_id, *, journal_target):
    """Journal the links of the members' products and move the sources' links to the target.

    Also picks up stray links: lines and aliases that pointed at an absorbed
    product later (import, admin). The target's own links are journaled only
    when the group is formed: its later lines are "new" and stay out of the journal.
    """
    # The target goes first: afterwards its product also holds the moved links of the others.
    for member in sorted(members, key=lambda item: item.product_ref != target_id):
        is_target = member.product_ref == target_id
        if is_target and not journal_target:
            continue
        line_ids = list(
            ReceiptLine.objects.filter(product_id=member.product_ref).exclude(merge_entries__member=member)
            .order_by("pk").values_list("pk", flat=True)
        )
        alias_ids = list(
            ProductAlias.objects.filter(product_id=member.product_ref).exclude(merge_entries__member=member)
            .order_by("pk").values_list("pk", flat=True)
        )
        if line_ids:
            # A link moved by a human belongs to its latest owner only.
            ProductMergeLine.objects.filter(member__group=group, line_id__in=line_ids).delete()
            ProductMergeLine.objects.bulk_create(ProductMergeLine(member=member, line_id=pk) for pk in line_ids)
        if alias_ids:
            ProductMergeAlias.objects.filter(member__group=group, alias_id__in=alias_ids).delete()
            ProductMergeAlias.objects.bulk_create(ProductMergeAlias(member=member, alias_id=pk) for pk in alias_ids)
        if not is_target:
            ReceiptLine.objects.filter(product_id=member.product_ref).update(product_id=target_id)
            ProductAlias.objects.filter(product_id=member.product_ref).update(product_id=target_id)


def _restore(group, members, target_id):
    """Return every member its own lines and aliases; the journal is left to the caller.

    Only links still pointing at the target are returned: a link a human changed
    meanwhile is not overwritten. A line of the target outside the journal goes
    to the owner of its alias, when the journal names exactly one such owner
    (same merchant and name key, and the same item code when the line has one).
    """
    owners = defaultdict(set)
    for entry in ProductMergeAlias.objects.filter(member__group=group).select_related("alias", "member"):
        alias = entry.alias
        owners[(alias.merchant_id, alias.name_key)].add((alias.store_item_code, entry.member.product_ref))
    journaled = ProductMergeLine.objects.filter(member__group=group).values("line_id")
    loose = defaultdict(list)
    for line in ReceiptLine.objects.filter(product_id=target_id).exclude(pk__in=journaled).select_related(
        "receipt__store",
    ).order_by("pk"):
        entries = owners.get((line.receipt.store.merchant_id, name_key(line.raw_name)), ())
        products = {
            product_ref for code, product_ref in entries
            if not line.store_item_code or code == line.store_item_code
        }
        if len(products) == 1 and target_id not in products:
            loose[products.pop()].append(line.pk)
    for member in members:
        if member.product_ref == target_id:
            continue
        ReceiptLine.objects.filter(
            pk__in=ProductMergeLine.objects.filter(member=member).values("line_id"), product_id=target_id,
        ).update(product_id=member.product_ref)
        ProductAlias.objects.filter(
            pk__in=ProductMergeAlias.objects.filter(member=member).values("alias_id"), product_id=target_id,
        ).update(product_id=member.product_ref)
        if loose[member.product_ref]:
            ReceiptLine.objects.filter(pk__in=loose[member.product_ref], product_id=target_id).update(
                product_id=member.product_ref,
            )


def _drop_journal(group):
    ProductMergeLine.objects.filter(member__group=group).delete()
    ProductMergeAlias.objects.filter(member__group=group).delete()


def _reject(group, pairs):
    ProductMergeRejection.objects.bulk_create(
        [
            ProductMergeRejection(product_low_id=low, product_high_id=high, group=group)
            for low, high in sorted({detection.pair_key(first, second) for first, second in pairs})
        ],
        ignore_conflicts=True,
    )


def _resolve(group, status):
    ProductMergeMember.objects.filter(group=group).update(active_product=None)
    group.status, group.resolved_at = status, timezone.now()
    group.save(update_fields=["status", "resolved_at", "version", "target_ref"])


def _keep_classification_rejections(target_id, absorbed_ids):
    """Rejection memory of the absorbed products goes to the survivor, in a savepoint; never fails the merge."""
    try:
        with transaction.atomic():
            from classification import services as classification  # lazy: classification imports merges

            classification.before_merge_confirmed(target_id=target_id, absorbed_ids=absorbed_ids)
    except Exception as error:
        logger.error(
            "Classification rejections transfer before merge confirmation failed: %s", type(error).__name__,
        )


def _notify_classification(target_id, absorbed_ids, generic_before):
    """Classification records of the merged products, in a savepoint; never fails the merge.

    ``generic_before`` — id of the generic product the survivor had before its facts were completed.
    """
    try:
        with transaction.atomic():
            from classification import services as classification  # lazy: classification imports merges

            classification.after_merge_confirmed(
                target_id=target_id, absorbed_ids=absorbed_ids, target_generic_before=generic_before,
            )
    except Exception as error:
        logger.error("Classification step after merge confirmation failed: %s", type(error).__name__)


def _fresh(group_id):
    return ProductMerge.objects.get(pk=group_id)


def _proposal_payload(proposal, names):
    return {
        "group_id": proposal.existing,
        "target_product_id": proposal.target_id,
        "product_ids": list(proposal.product_ids),
        "added_product_ids": list(proposal.added_ids),
        "names": {str(product_id): names.get(product_id, "") for product_id in proposal.product_ids},
    }


def _search(product_ids):
    candidates, existing = _load_candidates()
    scope = None if product_ids is None else frozenset(product_ids)
    proposals = detection.find_groups(candidates, _rejected_pairs(), existing, scope)
    return proposals, {candidate.id: candidate.name for candidate in candidates}


def detect(*, dry_run=False, product_ids=None):
    """Find duplicates and merge them provisionally.

    Pending groups are ready-made sets: a run only adds products to them or
    creates new groups, and repeating it over an unchanged catalog writes
    nothing. ``product_ids`` limits the search to pairs touching these products
    (the step after a receipt import). ``dry_run`` reads only and takes no lock.
    """
    if dry_run:
        proposals, names = _search(product_ids)
        return DetectResult(
            created=sum(proposal.existing is None for proposal in proposals),
            extended=sum(proposal.existing is not None for proposal in proposals),
            group_ids=[], proposals=[_proposal_payload(proposal, names) for proposal in proposals], dry_run=True,
        )
    with _mutation():
        # Links that arrived at absorbed products since the last operation.
        for group in ProductMerge.objects.filter(status=Status.PENDING).order_by("pk").prefetch_related("members"):
            members = _active(group)
            if ReceiptLine.objects.filter(product_id__in=[m.product_ref for m in members if m.role == Role.SOURCE]).exists() \
                    or ProductAlias.objects.filter(
                        product_id__in=[m.product_ref for m in members if m.role == Role.SOURCE]).exists():
                _lock_products([member.product_ref for member in members])
                _absorb(group, members, group.target_ref, journal_target=False)
        proposals, names = _search(product_ids)
        created, extended, group_ids, payloads = 0, 0, [], []
        for proposal in proposals:
            if proposal.existing is None:
                products = _lock_products(proposal.product_ids)
                if len(products) != len(proposal.product_ids):
                    continue  # a product disappeared between the search and the lock
                group = ProductMerge.objects.create(
                    target_ref=proposal.target_id, detector_version=detection.DETECTOR_VERSION,
                )
                members = ProductMergeMember.objects.bulk_create(
                    ProductMergeMember(
                        group=group, product_ref=product.pk, active_product=product, name=product.name,
                        facts=product_facts(product),
                        role=Role.TARGET if product.pk == proposal.target_id else Role.SOURCE,
                    )
                    for product in products.values()
                )
                _absorb(group, members, group.target_ref, journal_target=True)
                created += 1
            else:
                group = _lock_group(proposal.existing)
                if group.status != Status.PENDING:
                    continue
                products = _lock_products(proposal.product_ids)
                added = [products[product_id] for product_id in proposal.added_ids if product_id in products]
                if not added:
                    continue
                members = ProductMergeMember.objects.bulk_create(
                    ProductMergeMember(
                        group=group, product_ref=product.pk, active_product=product, name=product.name,
                        facts=product_facts(product), role=Role.SOURCE,
                    )
                    for product in added
                )
                _absorb(group, members, group.target_ref, journal_target=False)
                group.version = F("version") + 1
                group.save(update_fields=["version"])
                extended += 1
            group_ids.append(group.pk)
            payloads.append({**_proposal_payload(proposal, names), "group_id": group.pk,
                             "target_product_id": group.target_ref})
        return DetectResult(created, extended, group_ids, payloads)


def cancel(group_id):
    """Undo a pending group: every product gets its lines and aliases back.

    All member pairs are recorded as rejected. Repeating on a cancelled group
    returns it unchanged; a confirmed group raises ``MergeResolved``.
    """
    with _mutation():
        group = _lock_group(group_id)
        if group.status == Status.CANCELLED:
            return group
        if group.status == Status.CONFIRMED:
            raise MergeResolved(group)
        members = _active(group)
        ids = [member.product_ref for member in members]
        _lock_products(ids)
        _absorb(group, members, group.target_ref, journal_target=False)
        _restore(group, members, group.target_ref)
        _drop_journal(group)
        _reject(group, combinations(ids, 2))
        _resolve(group, Status.CANCELLED)
    return _fresh(group_id)


def exclude(group_id, *, version, product_id):
    """Take one record out of a pending group and restore it.

    Any record may be excluded, the surviving one too: the rest merge again
    onto the default survivor. Fewer than two records left cancel the group.
    """
    with _mutation():
        group = _lock_group(group_id)
        by_ref = {member.product_ref: member for member in group.members.all()}
        member = by_ref.get(product_id) if _is_id(product_id) else None
        if member is not None and member.state == State.EXCLUDED:
            return group
        if group.status != Status.PENDING:
            raise MergeResolved(group)
        if group.version != version:
            raise MergeChanged(group)
        if member is None:
            raise MergeInvalidParameter({"product_id": "not_member"})
        members = _active(group)
        products = _lock_products([item.product_ref for item in members])
        _absorb(group, members, group.target_ref, journal_target=False)
        _restore(group, members, group.target_ref)
        _drop_journal(group)
        remaining = [item for item in members if item.pk != member.pk]
        _reject(group, ((member.product_ref, item.product_ref) for item in remaining))
        member.state, member.active_product = State.EXCLUDED, None
        member.save(update_fields=["state", "active_product"])
        group.version += 1
        if len(remaining) < 2:
            _resolve(group, Status.CANCELLED)
        else:
            if member.role == Role.TARGET:
                merchants = frozenset()
                target = min(
                    (_candidate(products[item.product_ref], merchants) for item in remaining),
                    key=detection.target_key,
                ).id
                by_ref[target].role = Role.TARGET
                by_ref[target].save(update_fields=["role"])
                group.target_ref = target
            group.save(update_fields=["version", "target_ref"])
            _absorb(group, remaining, group.target_ref, journal_target=True)
    return _fresh(group_id)


def confirm(group_id, *, version, target_product_id, name_product_id=None, resolutions=None):
    """Make a pending merge final: absorbed products are deleted, facts completed.

    ``target_product_id`` — any active record; choosing another one moves all
    links to it. The name changes only with ``name_product_id`` (take the name
    of that record). An empty fact of the survivor is filled from the single
    value found in the group; a filled one is never overwritten. Two or more
    different values are a conflict a human resolves with ``resolutions``
    (``{field: product_id}``); without it nothing is saved.
    """
    with _mutation():
        group = _lock_group(group_id)
        if group.status == Status.CONFIRMED and group.target_ref == target_product_id:
            return group
        if group.status != Status.PENDING:
            raise MergeResolved(group)
        if group.version != version:
            raise MergeChanged(group)
        members = _active(group)
        by_ref = {member.product_ref: member for member in members}
        invalid = {}
        if not _is_id(target_product_id) or target_product_id not in by_ref:
            invalid["target_product_id"] = "not_member"
        if name_product_id is not None and (not _is_id(name_product_id) or name_product_id not in by_ref):
            invalid["name_product_id"] = "not_member"
        if resolutions is not None and not isinstance(resolutions, dict):
            invalid["resolutions"] = "invalid_type"
        if invalid:
            raise MergeInvalidParameter(invalid)
        products = _lock_products(by_ref)
        if len(products) != len(by_ref):
            raise MergeChanged(group)
        conflicts = find_conflicts(products.values())
        resolutions = dict(resolutions or {})
        for name, chosen in resolutions.items():
            if name not in conflicts:
                invalid[f"resolutions.{name}"] = "not_conflict"
            elif not _is_id(chosen) or chosen not in conflicts[name]:
                invalid[f"resolutions.{name}"] = "not_candidate"
        if invalid:
            raise MergeInvalidParameter(invalid)
        unresolved = {name: ids for name, ids in conflicts.items() if name not in resolutions}
        if unresolved:
            raise MergeConflict(unresolved)

        previous = group.target_ref
        _absorb(group, members, previous, journal_target=False)
        if target_product_id != previous:
            ReceiptLine.objects.filter(product_id=previous).update(product_id=target_product_id)
            ProductAlias.objects.filter(product_id=previous).update(product_id=target_product_id)
            # The partial unique index allows one active target: demote first.
            by_ref[previous].role = Role.SOURCE
            by_ref[previous].save(update_fields=["role"])
            by_ref[target_product_id].role = Role.TARGET
            by_ref[target_product_id].save(update_fields=["role"])
            group.target_ref = target_product_id
        absorbed = [product_id for product_id in by_ref if product_id != target_product_id]
        if ReceiptLine.objects.filter(product_id__in=absorbed).exists() \
                or ProductAlias.objects.filter(product_id__in=absorbed).exists():
            raise RuntimeError("links to absorbed products remain")
        target = products[target_product_id]
        generic_before = target.generic_id
        for name in FACT_FIELDS:
            values = {pk: _fact_value(product, name) for pk, product in products.items()}
            if name in resolutions:
                source = products[resolutions[name]]
            elif values[target.pk] is None:
                source = next((products[pk] for pk in sorted(values) if values[pk] is not None), None)
            else:
                source = None
            if source is not None and source.pk != target.pk:
                _copy_fact(target, source, name)
        if name_product_id is not None:
            target.name = products[name_product_id].name
        # The snapshot keeps what each record looked like right before the merge.
        for member in members:
            member.name, member.facts = products[member.product_ref].name, product_facts(products[member.product_ref])
            member.active_product = None
        ProductMergeMember.objects.bulk_update(members, ["name", "facts", "active_product"])
        _keep_classification_rejections(target_product_id, absorbed)
        Product.objects.filter(pk__in=absorbed).delete()
        target.save()
        _resolve(group, Status.CONFIRMED)
        _notify_classification(target_product_id, absorbed, generic_before)
    return _fresh(group_id)


def cancel_pending():
    """Cancel every pending group, each in its own transaction. Required before ``migrate merges zero``."""
    cancelled = []
    for group_id in ProductMerge.objects.filter(status=Status.PENDING).order_by("pk").values_list("pk", flat=True):
        if cancel(group_id).status == Status.CANCELLED:
            cancelled.append(group_id)
    return cancelled


def get_group(group_id):
    try:
        return ProductMerge.objects.get(pk=group_id)
    except (ProductMerge.DoesNotExist, ValueError, TypeError):
        raise MergeNotFound(MergeNotFound.code) from None


def groups(*, status=None, product=None):
    """Groups, newest first; ``product`` — a product id in any role."""
    queryset = ProductMerge.objects.order_by("-pk")
    if status is not None:
        queryset = queryset.filter(status=status)
    if product is not None:
        queryset = queryset.filter(members__product_ref=product)
    return queryset


def group_lines(group):
    """Purchases of the group with ``origin_product_id`` (``None`` — the line came after the merge).

    Pending: every line of the surviving product. Confirmed: the journaled
    lines. Cancelled: nothing, the journal is gone.
    """
    origin = ProductMergeLine.objects.filter(member__group=group, line=OuterRef("pk")).values("member__product_ref")
    if group.status == Status.PENDING:
        queryset = ReceiptLine.objects.filter(product_id=group.target_ref)
    elif group.status == Status.CONFIRMED:
        queryset = ReceiptLine.objects.filter(
            pk__in=ProductMergeLine.objects.filter(member__group=group).values("line_id"),
        )
    else:
        queryset = ReceiptLine.objects.none()
    return queryset.annotate(origin_product_id=Subquery(origin[:1])).select_related(
        "receipt__store__country", "receipt__store__merchant", "receipt__currency",
    ).order_by("receipt__purchased_at", "receipt_id", "position")


def describe(merge_groups, *, with_aliases=True):
    """``GroupInfo`` for each group in a fixed number of queries (6, or 5 without aliases).

    Member counts, dates and aliases come from the journal, i.e. they show the
    original ownership; conflicts are computed from live data of pending groups.
    """
    merge_groups = list(merge_groups)
    ids = [group.pk for group in merge_groups]
    members = defaultdict(list)
    for member in ProductMergeMember.objects.filter(group_id__in=ids).order_by("product_ref"):
        members[member.group_id].append(member)
    refs = {member.product_ref for items in members.values() for member in items}
    products = {
        product.pk: product
        for product in Product.objects.filter(pk__in=refs).select_related("generic", "brand")
    }
    journal = {
        row["member_id"]: row
        for row in ProductMergeLine.objects.filter(member__group_id__in=ids).values("member_id").annotate(
            count=Count("id"), first=Min("line__receipt__purchased_on"), last=Max("line__receipt__purchased_on"),
        )
    }
    aliases = defaultdict(list)
    if with_aliases:
        for entry in ProductMergeAlias.objects.filter(member__group_id__in=ids).select_related(
            "alias__merchant",
        ).order_by("alias__raw_name", "alias_id"):
            if len(aliases[entry.member_id]) < ALIASES_LIMIT:
                aliases[entry.member_id].append(entry.alias)
    pending = [group for group in merge_groups if group.status == Status.PENDING]
    on_target = dict(
        ReceiptLine.objects.filter(product_id__in=[group.target_ref for group in pending])
        .values_list("product_id").annotate(count=Count("id"))
    )
    journaled_on_target = dict(
        ProductMergeLine.objects.filter(
            member__group__in=pending, line__product_id=F("member__group__target_ref"),
        ).values_list("member__group_id").annotate(count=Count("line_id", distinct=True))
    )
    result = []
    for group in merge_groups:
        infos = []
        for member in members[group.pk]:
            product = products.get(member.product_ref)
            row = journal.get(member.pk, {})
            infos.append(MemberInfo(
                member=member, product=product,
                name=product.name if product else member.name,
                facts=product_facts(product) if product else member.facts,
                lines_count=row.get("count", 0), first_purchased_on=row.get("first"),
                last_purchased_on=row.get("last"), aliases=aliases[member.pk],
            ))
        if group.status == Status.PENDING:
            live = [info.product for info in infos if info.product and info.member.state == State.ACTIVE]
            conflicts = sorted(find_conflicts(live).items(), key=lambda item: FACT_FIELDS.index(item[0]))
            lines_count = on_target.get(group.target_ref, 0)
            new_lines_count = lines_count - journaled_on_target.get(group.pk, 0)
        else:
            conflicts, new_lines_count = [], 0
            lines_count = sum(info.lines_count for info in infos)
        result.append(GroupInfo(group, infos, conflicts, lines_count, new_lines_count))
    return result


def describe_group(group, *, with_aliases=True):
    return describe([group], with_aliases=with_aliases)[0]
