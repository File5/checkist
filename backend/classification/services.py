"""Suggested generic products: apply, confirm, choose another, reject, cancel.

A suggestion is applied at once: ``Product.generic`` moves from the service
generic product to the suggested one and a pending record remembers both.
A human then confirms, chooses another existing generic product or rejects.
Automation only ever changes a product whose generic product is the service
one; a value set by a human is never overwritten.

Every mutating operation is one transaction. It first takes the import mutex
(``recognition.importer.IMPORT_LOCK``, non-blocking), so imports, merges and
these operations run strictly in turn. The category tree lock
(``catalog.admin.CATEGORY_TREE_LOCK``, non-blocking) is taken only when a
category is created or deleted. Then rows: records, products, generic products,
in ascending id order. A busy lock or a wait beyond ``statement_timeout``
raises ``ClassificationBusy`` with a full rollback and no hidden retry.

The one refusal that saves something is the reconciliation of a record
(``_reconcile``): a record that lost its product, whose product was moved by a
human or whose snapshot is stale is updated and committed, and only then the
operation raises ``ClassificationResolved`` / ``ClassificationChanged``.

``Product.generic`` is written in four places only: ``apply`` (the product has
the service generic product), ``confirm`` with another generic product (the
decision of a human), and ``reject`` / ``cancel_pending`` through
``_return_product``. The reconciliation, the cleanup and the merge steps never
write it.

The rejection memory of a product absorbed by a confirmed merge belongs to the
survivor: ``before_merge_confirmed`` moves the rows before the absorbed
products are deleted, and the reconciliation restores what a failed transfer
or an earlier merge lost (``_inherit_rejections``).
"""
import uuid
from collections import Counter, defaultdict
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import timedelta

from django.conf import settings
from django.db import DatabaseError, IntegrityError, connection, transaction
from django.db.models import Case, Count, Exists, F, IntegerField, OuterRef, Q, Value, When
from django.db.models.deletion import ProtectedError

from catalog.models import Category, GenericProduct, Product
from catalog.units import BaseUnit
from classification import dto, taxonomy
from classification.models import (
    ClassificationRejection, ClassificationRun, CreatedCategory, CreatedGenericProduct, CreatedState,
    ProductClassification,
)
from classification.validation import drop_reason
from merges.detection import is_service_generic
from merges.models import ProductMerge, ProductMergeMember
from merges.visibility import visible
from receipts.models import ProductAlias, ReceiptLine

Status = ProductClassification.Status
Resolution = ProductClassification.Resolution
RunStatus = ClassificationRun.Status
Trigger = ClassificationRun.Trigger
Scope = ClassificationRun.Scope

# Lock not available, statement timeout, deadlock.
BUSY_SQLSTATES = frozenset({"55P03", "57014", "40P01"})
MANY_LIMIT = 100
ALIASES_LIMIT = 10
MAX_ID = 2**63 - 1
LEASE_MARGIN_SECONDS = 60
# Outcomes of the reconciliation of one record.
_CHANGED, _RESOLVED = "changed", "resolved"


class ClassificationError(Exception):
    """Base class; ``code`` matches the API error code of the contract."""

    code = "classification_error"

    def __init__(self):
        super().__init__(self.code)


class ClassificationNotFound(ClassificationError):
    code = "not_found"


class ClassificationBusy(ClassificationError):
    """An import, a merge, another operation or the category admin holds the catalog; nothing changed."""

    code = "classification_busy"


class ClassificationResolved(ClassificationError):
    """The record is not pending and the request is not a repeat, or the reconciliation closed it.

    ``record`` is the record of a single operation. For ``confirm_many`` it is
    ``None`` and ``fields`` maps ``items.N`` to ``resolved`` / ``changed``.
    """

    code = "classification_resolved"

    def __init__(self, record=None, fields=None):
        self.record = record
        self.fields = fields or {}
        super().__init__()


class ClassificationChanged(ClassificationError):
    """``version`` is stale, or the reconciliation updated the record. ``fields`` as above."""

    code = "classification_changed"

    def __init__(self, record=None, fields=None):
        self.record = record
        self.fields = fields or {}
        super().__init__()


class ClassificationInvalidParameter(ClassificationError):
    """``fields`` maps a parameter name to a reason: unknown, service_generic, too_many, duplicate, empty."""

    code = "invalid_parameter"

    def __init__(self, fields):
        self.fields = fields
        super().__init__()


@dataclass(frozen=True)
class Source:
    """Who suggested: the classifier and the versions of its prompt and schema."""

    provider: str
    model: str = ""
    prompt_version: str = dto.PROMPT_VERSION
    schema_version: str = dto.SCHEMA_VERSION
    classifier_version: int = dto.CLASSIFIER_VERSION


@dataclass(frozen=True)
class ApplyResult:
    record_ids: list
    applied: int
    unknown: int
    skipped: dict  # reason code -> count, without "unknown"


@dataclass
class RecordInfo:
    record: ProductClassification
    product: Product | None  # live product; None once it is deleted
    product_generic: GenericProduct | None  # current generic product of the live product
    aliases: list = field(default_factory=list)  # up to 10 ProductAlias, merchant loaded
    merge_group_id: int | None = None  # pending merge group that absorbed the product
    suggested_generic: GenericProduct | None = None  # live; None once it is deleted
    category_path: list = field(default_factory=list)  # [(id, name, is_new)] from the root
    generic_is_new: bool = False
    pending_count: int = 0  # pending records with the same suggested generic product, whole database
    can_act: bool = False


@dataclass(frozen=True)
class Summary:
    pending_count: int
    unclassified_count: int
    run: ClassificationRun | None


class _Session:
    """State of one mutation: the category rows, the tree lock and the cleanup counters."""

    def __init__(self):
        self._rows = None
        self.tree_locked = False
        self.removed_generics = 0
        self.removed_categories = 0

    @property
    def rows(self):
        """``{category id: (name, parent id)}``, read once and kept current by the callers."""
        if self._rows is None:
            self._rows = {
                pk: (name, parent_id)
                for pk, name, parent_id in Category.objects.values_list("pk", "name", "parent_id")
            }
        return self._rows

    def forget(self):
        """After a rolled-back savepoint: the cache and a lock taken inside it are gone."""
        self._rows = None
        self.tree_locked = False

    def lock_tree(self):
        """Before creating or deleting a category. Busy — the whole operation is refused."""
        if self.tree_locked:
            return
        from catalog.admin import CATEGORY_TREE_LOCK  # lazy: the admin module is not needed otherwise

        with connection.cursor() as cursor:
            cursor.execute("SELECT pg_try_advisory_xact_lock(%s, %s)", CATEGORY_TREE_LOCK)
            if not cursor.fetchone()[0]:
                raise ClassificationBusy()
        self.tree_locked = True
        self._rows = None  # the tree is read again under the lock


def _sqlstate(error):
    return getattr(error.__cause__, "sqlstate", None)


@contextmanager
def _mutation(*, lock=True):
    """A copy of the merge mutation on purpose: ``merges.services`` stays untouched."""
    try:
        with transaction.atomic():
            if lock:
                from recognition.importer import IMPORT_LOCK  # lazy: the importer will call this module

                with connection.cursor() as cursor:
                    cursor.execute("SELECT pg_try_advisory_xact_lock(%s)", [IMPORT_LOCK])
                    if not cursor.fetchone()[0]:
                        raise ClassificationBusy()
            yield _Session()
    except DatabaseError as error:
        if _sqlstate(error) not in BUSY_SQLSTATES:
            raise
        raise ClassificationBusy() from None


def _db_now():
    # clock_timestamp, not the transaction time: leases use the current database time.
    with connection.cursor() as cursor:
        cursor.execute("SELECT clock_timestamp()")
        return cursor.fetchone()[0]


def _is_id(value):
    return isinstance(value, int) and not isinstance(value, bool) and 0 < value <= MAX_ID


def _rejection_key(name):
    return taxonomy.name_key(name)[:100]


def _facts(product):
    """JSON snapshot of the product facts; ``brand`` must be loaded."""
    return {
        "brand": {"id": product.brand_id, "name": product.brand.name} if product.brand_id else None,
        "package": (
            {"quantity": str(product.package_quantity), "unit": product.package_unit}
            if product.package_quantity is not None else None
        ),
    }


def _path(category_id, rows):
    """``[{"id", "name"}]`` from the root; a cycle or a lost parent ends the walk."""
    path, seen = [], set()
    while category_id is not None and category_id in rows and category_id not in seen:
        seen.add(category_id)
        name, parent_id = rows[category_id]
        path.append({"id": category_id, "name": name})
        category_id = parent_id
    return path[::-1]


def _lock_records(ids):
    return list(
        ProductClassification.objects.select_for_update(of=("self",)).filter(pk__in=ids).order_by("pk")
    )


def _lock_record(record_id):
    records = _lock_records([record_id]) if _is_id(record_id) else []
    if not records:
        raise ClassificationNotFound()
    return records[0]


def _lock_products(ids):
    """``FOR UPDATE`` in ascending id order; ``generic`` and ``brand`` are loaded."""
    return {
        product.pk: product
        for product in Product.objects.select_for_update(of=("self",)).select_related("generic", "brand").filter(
            pk__in=ids,
        ).order_by("pk")
    }


# --- Selection -----------------------------------------------------------------------------------


def candidates(*, product_ids=None, auto=False):
    """Products that may get a suggestion, in ascending id order.

    The generic product is the service one, there is no pending record, the
    product is not absorbed by a pending merge and it is not a service or a
    deposit (no receipt lines, or at least one line of kind ``product``).
    ``auto`` — the run after an import: also no record of any status, ever.
    """
    lines = ReceiptLine.objects.filter(product_id=OuterRef("pk"))
    queryset = visible(Product.objects.filter(
        generic__name__iexact=taxonomy.SERVICE_NAME, pending_classification__isnull=True,
    )).filter(~Exists(lines) | Exists(lines.filter(kind=ReceiptLine.Kind.PRODUCT)))
    if product_ids is not None:
        queryset = queryset.filter(pk__in=list(product_ids))
    if auto:
        queryset = queryset.filter(~Exists(ProductClassification.objects.filter(product_ref=OuterRef("pk"))))
    return queryset.order_by("pk")


# --- Journal of created records and the cleanup ---------------------------------------------------


def _mark(journal, state):
    journal.state, journal.resolved_at = state, _db_now()
    journal.save(update_fields=["state", "resolved_at"])


def _delete(queryset):
    """Delete in a savepoint; a refusal means somebody uses the object."""
    try:
        with transaction.atomic():
            queryset.delete()
        return True
    except (ProtectedError, IntegrityError):
        return False


def _keep_categories(category_id):
    """``provisional → kept`` for the created ancestors, the category itself included."""
    seen, now = set(), _db_now()
    while category_id is not None and category_id not in seen:
        seen.add(category_id)
        CreatedCategory.objects.filter(category_id=category_id, state=CreatedState.PROVISIONAL).update(
            state=CreatedState.KEPT, resolved_at=now,
        )
        category_id = Category.objects.filter(pk=category_id).values_list("parent_id", flat=True).first()


def _keep_generic(generic_id):
    """The generic product is accepted by a human: it and its created ancestors become ordinary."""
    changed = CreatedGenericProduct.objects.filter(generic_id=generic_id, state=CreatedState.PROVISIONAL).update(
        state=CreatedState.KEPT, resolved_at=_db_now(),
    )
    if changed:
        _keep_categories(
            GenericProduct.objects.filter(pk=generic_id).values_list("category_id", flat=True).first()
        )


def _settle_category(category_id, session):
    """Remove a created category that became empty, then look at its parent."""
    seen = set()
    while category_id is not None and category_id not in seen:
        seen.add(category_id)
        journal = CreatedCategory.objects.select_for_update(of=("self",)).filter(
            category_id=category_id, state=CreatedState.PROVISIONAL,
        ).first()
        if journal is None:
            return
        generics = GenericProduct.objects.filter(category_id=category_id)
        children = Category.objects.filter(parent_id=category_id)
        if generics.exists() or children.exists():
            # Something not created by the mechanism, or already accepted, lives here.
            if generics.exclude(classification_origin__state=CreatedState.PROVISIONAL).exists() \
                    or children.exclude(classification_origin__state=CreatedState.PROVISIONAL).exists():
                _keep_categories(category_id)
            return
        parent_id = Category.objects.filter(pk=category_id).values_list("parent_id", flat=True).first()
        session.lock_tree()
        if not _delete(Category.objects.filter(pk=category_id)):
            _mark(journal, CreatedState.KEPT)
            return
        _mark(journal, CreatedState.REMOVED)
        session.removed_categories += 1
        session.rows.pop(category_id, None)
        category_id = parent_id


def _cleanup(generic_refs, session):
    """Remove created generic products nobody uses any more, and their emptied created categories.

    A created generic product used by a product without a pending record on it
    becomes ordinary (``kept``); one that only other pending records point at is
    left as it is. Records not created by the mechanism are never touched.
    """
    for ref in sorted({ref for ref in generic_refs if ref is not None}):
        journal = CreatedGenericProduct.objects.select_for_update(of=("self",)).filter(
            generic_id=ref, state=CreatedState.PROVISIONAL,
        ).first()
        if journal is None:
            continue
        products = Product.objects.filter(generic_id=ref)  # products hidden by a merge count too
        waiting = ProductClassification.objects.filter(status=Status.PENDING, suggested_generic_ref=ref)
        if not products.exists() and not waiting.exists():
            category_id = GenericProduct.objects.filter(pk=ref).values_list("category_id", flat=True).first()
            if _delete(GenericProduct.objects.filter(pk=ref)):
                _mark(journal, CreatedState.REMOVED)
                session.removed_generics += 1
                _settle_category(category_id, session)
            else:
                _keep_generic(ref)
        elif products.exclude(
            pending_classification__status=Status.PENDING, pending_classification__suggested_generic_ref=ref,
        ).exists():
            _keep_generic(ref)


# --- Reconciliation -------------------------------------------------------------------------------


def _close(record, status, resolution, final):
    """Resolve the record; ``final`` — the generic product left with the product, if any."""
    record.status, record.resolution = status, resolution
    record.active_product = None
    record.resolved_at = _db_now()
    record.final_generic_ref = final.pk if final else None
    record.final_generic_name = final.name if final else ""
    record.final_base_unit = final.base_unit if final else ""
    record.version += 1
    record.save()


def _absorbed_by(product_ref):
    """The survivor of the latest confirmed merge that absorbed this product, or ``None``."""
    return (
        ProductMergeMember.objects.filter(
            product_ref=product_ref, state=ProductMergeMember.State.ACTIVE,
            group__status=ProductMerge.Status.CONFIRMED,
        ).exclude(group__target_ref=product_ref).order_by("-group_id")
        .values_list("group__target_ref", flat=True).first()
    )


def _successor(product_ref):
    """The surviving product of the confirmed merges that absorbed this one, or ``None``."""
    current, seen = product_ref, {product_ref}
    while True:
        target = _absorbed_by(current)
        if target is None or target in seen:
            break
        seen.add(target)
        current = target
    return None if current == product_ref else current


def _absorbed_values(product_ids):
    """``{survivor id: [(absorbed id, generic id, merged at)]}`` — meaningful values of absorbed duplicates.

    Read from the journal of confirmed merges: the snapshot of an absorbed
    record is taken right before the merge.
    """
    found = defaultdict(list)
    if not product_ids:
        return found
    for target_ref, product_ref, facts, resolved_at in ProductMergeMember.objects.filter(
        state=ProductMergeMember.State.ACTIVE, group__status=ProductMerge.Status.CONFIRMED,
        group__target_ref__in=product_ids,
    ).exclude(product_ref=F("group__target_ref")).values_list(
        "group__target_ref", "product_ref", "facts", "group__resolved_at",
    ):
        generic = (facts or {}).get("generic") or {}
        if generic.get("id") is not None and not is_service_generic(generic.get("name")):
            found[target_ref].append((product_ref, generic["id"], resolved_at))
    return found


def _carriers(record):
    """Products a moved record belonged to before its present one."""
    carriers, current = set(), record.origin_product_ref
    while current is not None and current != record.product_ref and current not in carriers:
        carriers.add(current)
        current = _absorbed_by(current)
    return carriers


def _was_suggestion(product_ref, generic_id):
    """The absorbed product had this value only as a suggestion nobody confirmed.

    Its record on the value was pending at the merge: closed as ``merged`` since
    then, or still waiting for the reconciliation. A record a duplicate of a
    human had settled before (``_settled_by_duplicate``) does not count.
    """
    return any(
        not _settled_by_duplicate(record)
        for record in ProductClassification.objects.filter(
            Q(status=Status.PENDING) | Q(resolution=Resolution.MERGED),
            product_ref=product_ref, suggested_generic_ref=generic_id,
        )
    )


def _settled_by_duplicate(record, absorbed=None):
    """A duplicate merged into the product had the suggested value on its own: set by a human or confirmed.

    Without the suggestion the merge would have completed the empty fact of
    the product with that value, so it is no longer the mechanism's to undo.
    The value of a duplicate is not its own when it was a pending suggestion at
    the merge: a record of that duplicate, or this very record, which the merge
    moved here. A merge older than the record says nothing about its value.
    ``absorbed`` — the entry of ``_absorbed_values`` for the product, when read.
    """
    if absorbed is None:
        absorbed = _absorbed_values([record.product_ref])[record.product_ref]
    carriers = None
    for product_ref, generic_id, merged_at in absorbed:
        if generic_id != record.suggested_generic_ref or merged_at < record.created_at:
            continue
        if carriers is None:
            carriers = _carriers(record)
        if product_ref not in carriers and not _was_suggestion(product_ref, generic_id):
            return True
    return False


def _snapshot(generic, session):
    return generic.name, generic.base_unit, _path(generic.category_id, session.rows)


def _orphan(record, session):
    """The product is gone: the record is closed, and the merge survivor, if any, is left as it is.

    The record never moves here. Whether the survivor owes its value to this
    suggestion is known only to the merge step (``after_merge_confirmed``): the
    journal of a merge keeps the survivor's facts as they are after the merge.
    """
    successor_id = _successor(record.product_ref)
    successor = _lock_products([successor_id]).get(successor_id) if successor_id is not None else None
    _close(
        record, Status.SUPERSEDED,
        Resolution.MERGED if successor_id is not None else Resolution.PRODUCT_REMOVED,
        successor.generic if successor is not None else None,
    )
    return _RESOLVED


def _reconcile(records, session):
    """Bring locked pending records in line with the catalog; ``{record id: outcome}``.

    Outcomes: the snapshot of the record was updated (``changed``); the record
    was closed as superseded (``resolved``) — its product is gone, has another
    value, or shares the suggested one with a merged duplicate that had it from
    a human (``_settled_by_duplicate``). Records in line with the catalog
    are absent from the result. ``Product.generic`` is never written here; the
    catalog only loses created records that became empty.
    """
    outcomes, touched = {}, []
    pending = [record for record in records if record.status == Status.PENDING]
    products = _lock_products([record.active_product_id for record in pending if record.active_product_id])
    absorbed = _absorbed_values(list(products))
    for record in pending:
        product = products.get(record.active_product_id)
        if product is None:
            outcomes[record.pk] = _orphan(record, session)
            if outcomes[record.pk] == _RESOLVED:
                touched.append(record.suggested_generic_ref)
        elif product.generic_id != record.suggested_generic_ref:
            # A human changed the value meanwhile: it stays, the record steps aside.
            _close(record, Status.SUPERSEDED, Resolution.CHANGED, product.generic)
            touched.append(record.suggested_generic_ref)
            outcomes[record.pk] = _RESOLVED
        elif _settled_by_duplicate(record, absorbed[product.pk]):
            # A human gave the same value to a duplicate merged into this product: it is not a suggestion any more.
            _close(record, Status.SUPERSEDED, Resolution.MERGED, product.generic)
            touched.append(record.suggested_generic_ref)
            outcomes[record.pk] = _RESOLVED
        else:
            snapshot = _snapshot(product.generic, session)
            if snapshot != (
                record.suggested_generic_name, record.suggested_base_unit, record.suggested_category_path,
            ):
                (record.suggested_generic_name, record.suggested_base_unit,
                 record.suggested_category_path) = snapshot
                record.version += 1
                record.save()
                outcomes[record.pk] = _CHANGED
    _cleanup(touched, session)
    return outcomes


def _inherit_rejections(target_ids=None):
    """Safety net of ``before_merge_confirmed``: rejections lost with absorbed products return to the survivors.

    Read from what outlives a deleted product: a closed record ``rejected`` /
    ``other`` is what ``_remember`` wrote the row from, and the journal of
    confirmed merges names the survivor. A survivor that lacks the row gets it
    again, with the name and the record of the lost one. ``target_ids`` limits
    the survivors. A merge confirmed before the transfer existed is restored
    the same way. Nothing to restore — one query and no writes.
    """
    absorbed = ProductMergeMember.objects.filter(
        ~Q(group__target_ref=OuterRef("product_ref")), product_ref=OuterRef("product_ref"),
        state=ProductMergeMember.State.ACTIVE, group__status=ProductMerge.Status.CONFIRMED,
    )
    successors, wanted = {}, {}
    for record_id, product_ref, name in ProductClassification.objects.filter(
        Exists(absorbed), resolution__in=[Resolution.REJECTED, Resolution.OTHER],
    ).order_by("pk").values_list("pk", "product_ref", "suggested_generic_name"):
        if product_ref not in successors:
            successors[product_ref] = _successor(product_ref)
        successor = successors[product_ref]
        if successor is not None and (target_ids is None or successor in target_ids):
            # The earliest record of a name wins, as the earliest row does in the transfer.
            wanted.setdefault((successor, _rejection_key(name)), (name, record_id))
    if not wanted:
        return
    known = set(
        ClassificationRejection.objects.filter(product_id__in={successor for successor, _key in wanted})
        .values_list("product_id", "generic_key")
    )
    missing = {pair: source for pair, source in wanted.items() if pair not in known}
    if not missing:
        return
    # A survivor deleted since (admin) has no memory to restore.
    alive = set(
        Product.objects.select_for_update(of=("self",)).filter(pk__in={successor for successor, _key in missing})
        .order_by("pk").values_list("pk", flat=True)
    )
    ClassificationRejection.objects.bulk_create([
        ClassificationRejection(product_id=successor, generic_key=key, generic_name=name, classification_id=record_id)
        for (successor, key), (name, record_id) in missing.items() if successor in alive
    ])


def _reconcile_pending(session):
    _inherit_rejections()
    records = list(
        ProductClassification.objects.select_for_update(of=("self",)).filter(status=Status.PENDING).order_by("pk")
    )
    return len(_reconcile(records, session))


def reconcile():
    """Reconcile every pending record in one transaction; the number of records changed.

    Rejections restored for merge survivors (``_inherit_rejections``) are not counted.
    """
    with _mutation() as session:
        return _reconcile_pending(session)


def _after(record_id, outcome):
    """The committed record, or the refusal the reconciliation calls for."""
    record = ProductClassification.objects.get(pk=record_id)
    if outcome == _RESOLVED:
        raise ClassificationResolved(record)
    if outcome == _CHANGED:
        raise ClassificationChanged(record)
    return record


# --- Apply ----------------------------------------------------------------------------------------


class _Generics:
    """Generic products of the catalog by id and by name key."""

    def __init__(self):
        self.by_id, self.by_key = {}, defaultdict(list)
        for generic in GenericProduct.objects.order_by("pk"):
            self.add(generic)

    def add(self, generic):
        self.by_id[generic.pk] = generic
        self.by_key[taxonomy.name_key(generic.name)].append(generic)


def _resolve_path(path, session, run):
    """Id of the category for the path, creating missing levels; ``None`` — ambiguous."""
    parent_id, missing = None, len(path)
    for index, raw in enumerate(path):
        key = taxonomy.name_key(raw)
        matches = [
            pk for pk, (name, parent) in session.rows.items() if parent == parent_id and taxonomy.name_key(name) == key
        ]
        if len(matches) > 1:
            return None
        if not matches:
            missing = index
            break
        parent_id = matches[0]
    if missing == len(path):
        return parent_id
    if not session.tree_locked:
        session.lock_tree()
        return _resolve_path(path, session, run)  # once more over the tree read under the lock
    # A new category is always a leaf under an already resolved parent: no cycles.
    for raw in path[missing:]:
        name = taxonomy.display_name(raw)
        category = Category.objects.create(parent_id=parent_id, name=name)
        CreatedCategory.objects.create(
            category=category, category_ref=category.pk, name=name, parent_ref=parent_id, run=run,
        )
        session.rows[category.pk] = (name, parent_id)
        parent_id = category.pk
    return parent_id


def _apply_item(item, product, rejected_keys, generics, session, run, source):
    """Apply one suggestion; the new record, or the reason code it was skipped with."""
    if item.decision == dto.EXISTING:
        generic = generics.by_id.get(item.generic_id)
        if generic is None:
            return "unknown_generic"
        if is_service_generic(generic.name):
            return "service_target"
    else:
        matches = generics.by_key.get(taxonomy.name_key(item.generic_name), [])
        if len(matches) > 1:
            return "generic_ambiguous"
        # An existing generic product wins: its name, category and base unit stay.
        generic = matches[0] if matches else None
    name = generic.name if generic is not None else taxonomy.display_name(item.generic_name)
    if _rejection_key(name) in rejected_keys:
        return "rejected_before"
    if generic is None:
        category_id = _resolve_path(item.category_path, session, run)
        if category_id is None:
            return "category_ambiguous"
        generic = GenericProduct.objects.create(name=name, category_id=category_id, base_unit=item.base_unit)
        CreatedGenericProduct.objects.create(
            generic=generic, generic_ref=generic.pk, name=name, base_unit=generic.base_unit,
            category_ref=category_id, run=run,
        )
        generics.add(generic)
    previous = product.generic
    product.generic = generic
    product.save(update_fields=["generic"])
    return ProductClassification.objects.create(
        product_ref=product.pk, active_product=product, product_name=product.name, product_facts=_facts(product),
        previous_generic_ref=previous.pk, previous_generic_name=previous.name,
        previous_generic_base_unit=previous.base_unit,
        suggested_generic=generic, suggested_generic_ref=generic.pk, suggested_generic_name=generic.name,
        suggested_base_unit=generic.base_unit, suggested_category_path=_path(generic.category_id, session.rows),
        run=run, classifier_version=source.classifier_version, provider=source.provider, model=source.model,
        prompt_version=source.prompt_version, schema_version=source.schema_version, confidence=item.confidence,
    )


def _count(run, *, applied=0, unknown=0, skipped=None):
    """Add the counters of one batch to the run; the cursor and the status belong to the executor."""
    if run is None:
        return
    skipped = dict(skipped or {})
    row = ClassificationRun.objects.select_for_update().get(pk=run.pk)
    row.applied_count += applied
    row.unknown_count += unknown
    row.skipped_count += sum(skipped.values())
    stats = Counter(row.stats)
    stats.update(skipped)
    if unknown:
        stats["unknown"] += unknown
    row.stats = dict(stats)
    row.version += 1
    row.save(update_fields=["applied_count", "unknown_count", "skipped_count", "stats", "version"])


def count_skipped(run, reason, count):
    """Record products of a batch that got no suggestion for a reason outside ``apply``."""
    if run is not None and count:
        with transaction.atomic():
            _count(run, skipped={reason: count})


def apply(run, response, *, source):
    """Apply a checked model answer: products move to the suggested generic products at once.

    Only the batch executor calls this. Each item is checked again under the
    lock: the product exists, its generic product is the service one, it has no
    pending record, a pending merge did not absorb it and the suggested name is
    not in its rejection memory. A failed item is skipped with a reason, the
    rest is applied. ``run`` may be ``None`` (no run counters, no source run).
    Repeating the same answer does nothing: every item is ``not_eligible``.
    """
    with _mutation() as session:
        _reconcile_pending(session)
        items = sorted(response.items, key=lambda item: item.product_id)
        ids = [item.product_id for item in items]
        products = _lock_products(ids)
        eligible = set(candidates(product_ids=ids).values_list("pk", flat=True))
        rejected = defaultdict(set)
        for product_id, key in ClassificationRejection.objects.filter(product_id__in=ids).values_list(
                "product_id", "generic_key"):
            rejected[product_id].add(key)
        generics = _Generics()
        record_ids, unknown, skipped = [], 0, Counter()
        for item in items:
            product = products.get(item.product_id)
            if product is None or product.pk not in eligible:
                skipped["not_eligible"] += 1
                continue
            reason = drop_reason(item)
            if reason == "unknown":
                unknown += 1
                continue
            if reason is None:
                try:
                    with transaction.atomic():
                        outcome = _apply_item(item, product, rejected[product.pk], generics, session, run, source)
                except IntegrityError:
                    # A race with a writer outside the mutex (admin): only this item is lost.
                    outcome = "catalog_conflict"
                    session.forget()
                    generics = _Generics()
                    product.refresh_from_db(fields=["generic"])
                if not isinstance(outcome, str):
                    record_ids.append(outcome.pk)
                    continue
                reason = outcome
            skipped[reason] += 1
        _count(run, applied=len(record_ids), unknown=unknown, skipped=skipped)
    return ApplyResult(record_ids=record_ids, applied=len(record_ids), unknown=unknown, skipped=dict(skipped))


# --- Decisions of a human -------------------------------------------------------------------------


def _remember(record, product):
    """The rejected pair "product, suggested name": never suggested to this product again."""
    ClassificationRejection.objects.get_or_create(
        product=product, generic_key=_rejection_key(record.suggested_generic_name),
        defaults={"generic_name": record.suggested_generic_name, "classification": record},
    )


def _service_generic(session):
    """The service generic product, created the way ``recognition.resolution`` creates it."""
    generic = GenericProduct.objects.filter(name__iexact=taxonomy.SERVICE_NAME).first()
    if generic is not None:
        return generic
    category = Category.objects.filter(parent=None, name=taxonomy.SERVICE_NAME).first()
    if category is None:
        session.lock_tree()
        category = Category.objects.create(parent=None, name=taxonomy.SERVICE_NAME)
    return GenericProduct.objects.create(name=taxonomy.SERVICE_NAME, category=category, base_unit=BaseUnit.PCS)


def _return_product(record, product, session):
    """Put the product back into the generic product it had before the suggestion.

    Only for a pending record after its reconciliation: the product still has
    the suggested value, no duplicate merged into it had that value from a
    human, and the value was written by the mechanism — by
    ``apply`` to this product, or by a merge that completed the empty fact of
    this product with the suggestion (``after_merge_confirmed``, which then
    stores this product's own previous value in the record).
    """
    previous = GenericProduct.objects.filter(pk=record.previous_generic_ref).first() or _service_generic(session)
    product.generic = previous
    product.save(update_fields=["generic"])
    return previous


def _confirm_suggested(record, product):
    _close(record, Status.CONFIRMED, Resolution.CONFIRMED, product.generic)
    _keep_generic(product.generic_id)


def confirm(record_id, *, version, generic_id):
    """Confirm the suggestion, or choose another existing generic product.

    ``generic_id`` is required: equal to the suggested one it confirms, any other
    one moves the product there and remembers the suggestion as rejected.
    Repeating the request on a record confirmed with the same ``generic_id``
    returns it unchanged at any ``version``. Order of checks: the record exists,
    repeat, status, reconciliation, ``version``, the parameter.
    """
    with _mutation() as session:
        record = _lock_record(record_id)
        # Strict type first: True == 1 and 1.0 == 1 must not pass for an id.
        valid = _is_id(generic_id)
        if valid and record.status == Status.CONFIRMED and record.final_generic_ref == generic_id:
            return record
        if record.status != Status.PENDING:
            raise ClassificationResolved(record)
        outcome = _reconcile([record], session).get(record.pk)
        if outcome is None:
            if record.version != version:
                raise ClassificationChanged(record)
            product = _lock_products([record.active_product_id])[record.active_product_id]
            if valid and generic_id == record.suggested_generic_ref:
                _confirm_suggested(record, product)
            else:
                chosen = None
                if valid:
                    chosen = GenericProduct.objects.select_for_update().filter(pk=generic_id).first()
                if chosen is None:
                    raise ClassificationInvalidParameter({"generic_id": "unknown"})
                if is_service_generic(chosen.name):
                    raise ClassificationInvalidParameter({"generic_id": "service_generic"})
                product.generic = chosen
                product.save(update_fields=["generic"])
                _remember(record, product)
                _close(record, Status.CONFIRMED, Resolution.OTHER, chosen)
                _keep_generic(chosen.pk)
                _cleanup([record.suggested_generic_ref], session)
    return _after(record_id, outcome)


def reject(record_id, *, version):
    """Return the product to its previous generic product and remember the refusal.

    Created generic products and categories left empty are removed. Repeating on
    a rejected record returns it unchanged at any ``version``.
    """
    with _mutation() as session:
        record = _lock_record(record_id)
        if record.status == Status.REJECTED:
            return record
        if record.status != Status.PENDING:
            raise ClassificationResolved(record)
        outcome = _reconcile([record], session).get(record.pk)
        if outcome is None:
            if record.version != version:
                raise ClassificationChanged(record)
            product = _lock_products([record.active_product_id])[record.active_product_id]
            previous = _return_product(record, product, session)
            _remember(record, product)
            _close(record, Status.REJECTED, Resolution.REJECTED, previous)
            _cleanup([record.suggested_generic_ref], session)
    return _after(record_id, outcome)


def confirm_many(items):
    """Confirm the suggested value of 1–100 records ``(id, version)``: all or nothing.

    A record already confirmed with its suggested value counts as done. A
    missing record — ``ClassificationNotFound``. A record resolved otherwise or
    closed by the reconciliation — ``ClassificationResolved``; a stale version or
    an updated snapshot — ``ClassificationChanged``; both carry ``fields`` with
    every failed ``items.N``. Then nothing is confirmed (the reconciliation of
    the failed records stays). Returns the records in ascending id order.
    """
    items = list(items)
    if not items:
        raise ClassificationInvalidParameter({"items": "empty"})
    if len(items) > MANY_LIMIT:
        raise ClassificationInvalidParameter({"items": "too_many"})
    index, duplicates = {}, {}
    for position, (record_id, _version) in enumerate(items):
        if record_id in index:
            duplicates[f"items.{position}.id"] = "duplicate"
        index.setdefault(record_id, position)
    if duplicates:
        raise ClassificationInvalidParameter(duplicates)
    versions = dict(items)
    failed = {}
    with _mutation() as session:
        records = _lock_records([record_id for record_id in index if _is_id(record_id)])
        if len(records) != len(index):
            raise ClassificationNotFound()
        outcomes = _reconcile(records, session)
        todo = []
        for record in records:
            name = f"items.{index[record.pk]}"
            if record.status == Status.CONFIRMED and record.final_generic_ref == record.suggested_generic_ref \
                    and record.pk not in outcomes:
                continue
            if record.status != Status.PENDING or outcomes.get(record.pk) == _RESOLVED:
                failed[name] = _RESOLVED
            elif record.pk in outcomes or record.version != versions[record.pk]:
                failed[name] = _CHANGED
            else:
                todo.append(record)
        if not failed:
            products = _lock_products([record.active_product_id for record in todo])
            for record in todo:
                _confirm_suggested(record, products[record.active_product_id])
    if failed:
        error = ClassificationResolved if _RESOLVED in failed.values() else ClassificationChanged
        raise error(fields=dict(sorted(failed.items(), key=lambda item: int(item[0].split(".")[1]))))
    return list(ProductClassification.objects.filter(pk__in=index).order_by("pk"))


def _own_values(target_id, absorbed_ids, records):
    """Generic products the absorbed products had on their own, not as a pending suggestion.

    Read from the journal of the confirmed merge: the snapshot of an absorbed
    record is taken right before the merge. A pending record a duplicate of a
    human had settled, but no reconciliation closed yet, is not a suggestion.
    """
    suggested = {
        (record.product_ref, record.suggested_generic_ref) for record in records
        if not _settled_by_duplicate(record)
    }
    values = set()
    for product_ref, facts in ProductMergeMember.objects.filter(
        product_ref__in=absorbed_ids, state=ProductMergeMember.State.ACTIVE,
        group__status=ProductMerge.Status.CONFIRMED, group__target_ref=target_id,
    ).values_list("product_ref", "facts"):
        generic = (facts or {}).get("generic") or {}
        if not is_service_generic(generic.get("name")) and (product_ref, generic.get("id")) not in suggested:
            values.add(generic.get("id"))
    return values


def _move(record, target, previous, session):
    """The pending record follows the suggestion to the merge survivor that received it."""
    if record.origin_product_ref is None:
        record.origin_product_ref = record.product_ref
    record.product_ref, record.active_product = target.pk, target
    record.product_name, record.product_facts = target.name, _facts(target)
    # What a rejection returns the survivor to is the survivor's own previous value.
    record.previous_generic_ref, record.previous_generic_name = previous.pk, previous.name
    record.previous_generic_base_unit = previous.base_unit
    (record.suggested_generic_name, record.suggested_base_unit,
     record.suggested_category_path) = _snapshot(target.generic, session)
    record.version += 1
    record.save()


def before_merge_confirmed(*, target_id, absorbed_ids):
    """Step of ``merges.services.confirm`` right before the absorbed products are deleted.

    Their rejection memory goes to the survivor: what a human refused for a
    duplicate is never suggested to the merged product. The rows themselves
    move, so ``pk``, ``created_at``, the name and the record stay. A name the
    survivor already has, or an earlier row has brought, is left behind and
    deleted with its product. Runs inside the merge transaction, which already
    holds the mutex.
    """
    with _mutation():
        kept = set(
            ClassificationRejection.objects.filter(product_id=target_id).values_list("generic_key", flat=True)
        )
        for rejection in ClassificationRejection.objects.select_for_update(of=("self",)).filter(
                product_id__in=list(absorbed_ids)).order_by("pk"):
            if rejection.generic_key not in kept:
                kept.add(rejection.generic_key)
                rejection.product_id = target_id
                rejection.save(update_fields=["product"])


def after_merge_confirmed(*, target_id, absorbed_ids, target_generic_before):
    """Step of ``merges.services.confirm``: records of the absorbed products follow the merge.

    ``target_generic_before`` — id of the generic product the survivor had
    before the merge completed its facts. A pending record of an absorbed
    product moves to the survivor only when the survivor's value comes from the
    suggestion: before the merge the survivor had the service generic product,
    now it has the suggested one, no absorbed product had that value on its own
    (set by a human or confirmed) and the survivor has no pending record. In
    every other case the record is closed as ``merged`` and the survivor is not
    touched: a value it had before the merge is never undone by a rejection.
    Then the survivor's own pending record is reconciled: ``changed`` when the
    human chose another value, ``merged`` when an absorbed product had the
    suggested value on its own — the survivor keeps it, nothing is left to
    reject. First the rejection memory a failed ``before_merge_confirmed`` lost
    is restored for the survivor. Runs inside the merge transaction, which
    already holds the mutex.
    """
    absorbed_ids = list(absorbed_ids)
    with _mutation() as session:
        _inherit_rejections([target_id])
        records = _lock_records(list(
            ProductClassification.objects.filter(status=Status.PENDING, product_ref__in=absorbed_ids)
            .values_list("pk", flat=True)
        ))
        if records:
            target = _lock_products([target_id]).get(target_id)
            previous = GenericProduct.objects.filter(pk=target_generic_before).first()
            inherited = previous is not None and is_service_generic(previous.name)
            own = _own_values(target_id, absorbed_ids, records) if inherited else set()
            touched = []
            for record in records:
                if record.active_product_id is not None:
                    _reconcile([record], session)  # the product is still there: not absorbed after all
                elif inherited and target is not None and target.generic_id == record.suggested_generic_ref \
                        and record.suggested_generic_ref not in own \
                        and not ProductClassification.objects.filter(active_product=target).exists():
                    _move(record, target, previous, session)
                else:
                    _orphan(record, session)
                    touched.append(record.suggested_generic_ref)
            _cleanup(touched, session)
        _reconcile(_lock_records(list(
            ProductClassification.objects.filter(status=Status.PENDING, active_product_id=target_id)
            .values_list("pk", flat=True)
        )), session)


# --- Runs -----------------------------------------------------------------------------------------


def default_source(classifier=None):
    """Source of a run: the given classifier, else the configured provider."""
    if classifier is not None:
        return Source(provider=classifier.name, model=classifier.model)
    provider = getattr(settings, "RECEIPT_OCR_PROVIDER", "codex_cli")
    return Source(provider=provider, model="" if provider == "fake" else getattr(settings, "RECEIPT_OCR_MODEL", ""))


def lease_until(now):
    return now + timedelta(seconds=settings.PRODUCT_CLASSIFICATION_TIMEOUT_SECONDS + LEASE_MARGIN_SECONDS)


def _new_run(*, trigger, scope, ids, limit, status=RunStatus.QUEUED, source=None):
    source = source or default_source()
    fields = {}
    if status == RunStatus.RUNNING:
        now = _db_now()
        fields = {"run_token": uuid.uuid4(), "started_at": now, "heartbeat_at": now, "lease_expires_at": lease_until(now)}
    return ClassificationRun.objects.create(
        status=status, trigger=trigger, scope=scope, product_ids=ids[:limit], requested_count=len(ids[:limit]),
        remaining_count=max(0, len(ids) - limit), provider=source.provider, model=source.model,
        prompt_version=source.prompt_version, schema_version=source.schema_version,
        classifier_version=source.classifier_version, **fields,
    )


def _finish(run, status, error_code=""):
    run.status, run.error_code = status, error_code
    run.finished_at = _db_now()
    run.run_token = run.heartbeat_at = run.lease_expires_at = None
    run.version += 1
    run.save()


def request_run(*, trigger, product_ids=None):
    """Queue "suggest for these products"; ``(run | None, created)``. The model is not called.

    ``manual`` / ``command``: no candidates — ``(None, False)``; an active run
    (queued or running) is returned as is, a queued run limited to products is
    widened to all candidates. ``import``: only products that never had a
    record; they join the queued run of either scope behind its cursor or start
    a new one; what the run limit cuts off is counted as remaining. The import
    mutex is taken unless the trigger is ``import`` (the import already holds it).
    """
    limit = settings.PRODUCT_CLASSIFICATION_RUN_LIMIT
    if trigger == Trigger.IMPORT:
        with transaction.atomic():
            ids = list(candidates(product_ids=product_ids, auto=True).values_list("pk", flat=True))
            if not ids:
                return None, False
            queued = ClassificationRun.objects.select_for_update().filter(status=RunStatus.QUEUED).first()
            if queued is None:
                return _new_run(trigger=trigger, scope=Scope.PRODUCTS, ids=ids, limit=limit), True
            # A run waiting between batches keeps the ids its cursor already passed.
            done = queued.product_ids[:queued.cursor]
            merged = done + sorted((set(queued.product_ids[queued.cursor:]) | set(ids)) - set(done))
            kept = merged[:max(limit, queued.cursor)]
            changed, remaining = kept != queued.product_ids, queued.remaining_count
            if queued.scope == Scope.PRODUCTS:
                if changed:
                    remaining = max(0, len(merged) - limit)
            elif len(merged) > len(kept):
                # As in a manual run: its candidates outside the list. A product cut off by the
                # limit changes nothing but this number.
                remaining = candidates().exclude(pk__in=kept).count()
                changed = changed or remaining != queued.remaining_count
            if changed:
                queued.product_ids, queued.requested_count, queued.remaining_count = kept, len(kept), remaining
                queued.version += 1
                queued.save(update_fields=["product_ids", "requested_count", "remaining_count", "version"])
            return queued, False
    with _mutation() as session:
        _reconcile_pending(session)
        ids = list(candidates(product_ids=product_ids).values_list("pk", flat=True))
        if not ids:
            return None, False
        active = {
            run.status: run
            for run in ClassificationRun.objects.select_for_update().filter(
                status__in=[RunStatus.QUEUED, RunStatus.RUNNING]).order_by("pk")
        }
        queued = active.get(RunStatus.QUEUED)
        if queued is not None and queued.scope == Scope.PRODUCTS and product_ids is None:
            # A run waiting between batches keeps the ids its cursor already passed.
            done = queued.product_ids[:queued.cursor]
            ids = done + [pk for pk in ids if pk not in set(done)]
            queued.scope, queued.product_ids = Scope.ALL, ids[:limit]
            queued.requested_count = len(queued.product_ids)
            queued.remaining_count = max(0, len(ids) - limit)
            queued.version += 1
            queued.save(update_fields=["scope", "product_ids", "requested_count", "remaining_count", "version"])
        if active:
            return queued or active[RunStatus.RUNNING], False
        scope = Scope.ALL if product_ids is None else Scope.PRODUCTS
        return _new_run(trigger=trigger, scope=scope, ids=ids, limit=limit), True


def start_run(*, product_ids=None, limit=None, source=None):
    """A run of the ``suggest`` command, created already ``running``; ``None`` — nothing to do.

    A running run with a live lease (the worker executes a batch) — ``ClassificationBusy``;
    one with an expired lease is closed as ``failed`` / ``worker_lost``.
    """
    run_limit = settings.PRODUCT_CLASSIFICATION_RUN_LIMIT
    limit = run_limit if limit is None else max(1, min(limit, run_limit))
    with _mutation() as session:
        _reconcile_pending(session)
        running = ClassificationRun.objects.select_for_update().filter(status=RunStatus.RUNNING).first()
        if running is not None:
            if running.lease_expires_at > _db_now():
                raise ClassificationBusy()
            _finish(running, RunStatus.FAILED, "worker_lost")
        ids = list(candidates(product_ids=product_ids).values_list("pk", flat=True))
        if not ids:
            return None
        return _new_run(
            trigger=Trigger.COMMAND, scope=Scope.ALL if product_ids is None else Scope.PRODUCTS, ids=ids,
            limit=limit, status=RunStatus.RUNNING, source=source,
        )


def advance_run(run, consumed):
    """Move the cursor of a running run past one batch and extend its lease."""
    with transaction.atomic():
        row = ClassificationRun.objects.select_for_update().get(pk=run.pk, status=RunStatus.RUNNING)
        now = _db_now()
        row.cursor = min(len(row.product_ids), row.cursor + consumed)
        row.heartbeat_at, row.lease_expires_at = now, lease_until(now)
        row.version += 1
        row.save(update_fields=["cursor", "heartbeat_at", "lease_expires_at", "version"])
    return row


def finish_run(run, *, error_code=""):
    """Final status of a running run: ``succeeded``, or ``failed`` with the code."""
    with transaction.atomic():
        row = ClassificationRun.objects.select_for_update().get(pk=run.pk, status=RunStatus.RUNNING)
        _finish(row, RunStatus.FAILED if error_code else RunStatus.SUCCEEDED, error_code)
    return row


def cancel_pending():
    """Undo every pending suggestion, each in its own transaction. Required before ``migrate classification zero``.

    A product goes back to its previous generic product unless a human changed
    it meanwhile; created records left empty are removed; the rejection memory
    is not written. The queued run is cancelled; a run executing a batch raises
    ``ClassificationBusy`` (stop the worker first).
    """
    result = {"cancelled": [], "superseded": [], "runs_cancelled": [], "removed_generics": 0, "removed_categories": 0}
    with _mutation():
        for run in ClassificationRun.objects.select_for_update().filter(
                status__in=[RunStatus.QUEUED, RunStatus.RUNNING]).order_by("pk"):
            if run.status == RunStatus.QUEUED:
                _finish(run, RunStatus.CANCELLED)
                result["runs_cancelled"].append(run.pk)
            elif run.lease_expires_at > _db_now():
                raise ClassificationBusy()
            else:
                _finish(run, RunStatus.FAILED, "worker_lost")
    for record_id in ProductClassification.objects.filter(status=Status.PENDING).order_by("pk").values_list(
            "pk", flat=True):
        with _mutation() as session:
            records = _lock_records([record_id])
            if not records or records[0].status != Status.PENDING:
                continue
            record = records[0]
            if _reconcile([record], session).get(record.pk) == _RESOLVED:
                result["superseded"].append(record.pk)
            else:
                product = _lock_products([record.active_product_id])[record.active_product_id]
                previous = _return_product(record, product, session)
                _close(record, Status.REJECTED, Resolution.CANCELLED, previous)
                _cleanup([record.suggested_generic_ref], session)
                result["cancelled"].append(record.pk)
            result["removed_generics"] += session.removed_generics
            result["removed_categories"] += session.removed_categories
    return result


# --- Reading --------------------------------------------------------------------------------------


def get_record(record_id):
    try:
        return ProductClassification.objects.select_related("run").get(pk=record_id)
    except (ProductClassification.DoesNotExist, ValueError, TypeError):
        raise ClassificationNotFound() from None


def records(*, status=None, product=None, generic=None, run=None, ordering="generic"):
    """Records; ``product`` — a product id, also one the record came from; ``generic`` — the suggested one.

    ``ordering``: ``generic`` keeps the records of one suggested generic product
    together (name, id, record id); ``-id`` — newest first.
    """
    queryset = ProductClassification.objects.select_related("run")
    if status is not None:
        queryset = queryset.filter(status=status)
    if product is not None:
        queryset = queryset.filter(Q(product_ref=product) | Q(origin_product_ref=product))
    if generic is not None:
        queryset = queryset.filter(suggested_generic_ref=generic)
    if run is not None:
        queryset = queryset.filter(run_id=run)
    if ordering == "-id":
        return queryset.order_by("-pk")
    return queryset.order_by("suggested_generic_name", "suggested_generic_ref", "pk")


def _merge_group_id(product):
    try:
        member = product.pending_merge_member
    except ProductMergeMember.DoesNotExist:
        return None
    return member.group_id if member.role == ProductMergeMember.Role.SOURCE else None


def describe(records):
    """``RecordInfo`` for each record in 7 queries, whatever the page size.

    Fewer only when a lookup set is empty (no record, or no live product or
    generic product on the page): such a query is not sent at all.

    Live data win over the snapshots while the objects exist. ``can_act`` is a
    hint: the record is pending, its product exists and still has the suggested
    generic product; the service checks again under the lock.
    """
    records = list(records)
    products = {
        product.pk: product
        for product in Product.objects.filter(pk__in={record.product_ref for record in records}).select_related(
            "generic", "brand", "pending_merge_member")
    }
    refs = {record.suggested_generic_ref for record in records}
    generics = GenericProduct.objects.in_bulk(refs)
    rows = {pk: (name, parent_id) for pk, name, parent_id in Category.objects.values_list("pk", "name", "parent_id")}
    aliases = defaultdict(list)
    for alias in ProductAlias.objects.filter(product_id__in=products).select_related("merchant").order_by(
            "raw_name", "pk"):
        if len(aliases[alias.product_id]) < ALIASES_LIMIT:
            aliases[alias.product_id].append(alias)
    paths = {pk: _path(generic.category_id, rows) for pk, generic in generics.items()}
    new_generics = set(CreatedGenericProduct.objects.filter(
        generic_id__in=generics, state=CreatedState.PROVISIONAL).values_list("generic_id", flat=True))
    new_categories = set(CreatedCategory.objects.filter(
        category_id__in={step["id"] for path in paths.values() for step in path},
        state=CreatedState.PROVISIONAL,
    ).values_list("category_id", flat=True))
    pending = dict(
        ProductClassification.objects.filter(status=Status.PENDING, suggested_generic_ref__in=refs)
        .values_list("suggested_generic_ref").annotate(count=Count("id"))
    )
    result = []
    for record in records:
        product = products.get(record.product_ref)
        generic = generics.get(record.suggested_generic_ref)
        if generic is not None:
            path = [(step["id"], step["name"], step["id"] in new_categories) for step in paths[generic.pk]]
        else:
            path = [(step["id"], step["name"], False) for step in record.suggested_category_path]
        result.append(RecordInfo(
            record=record, product=product, product_generic=product.generic if product else None,
            aliases=aliases[record.product_ref] if product else [],
            merge_group_id=_merge_group_id(product) if product else None,
            suggested_generic=generic, category_path=path, generic_is_new=record.suggested_generic_ref in new_generics,
            pending_count=pending.get(record.suggested_generic_ref, 0),
            can_act=(
                record.status == Status.PENDING and product is not None
                and product.generic_id == record.suggested_generic_ref
            ),
        ))
    return result


def summary():
    """Counts for the screen and the run to show: the running one, else the queued one, else the latest.

    Three queries.
    """
    run = ClassificationRun.objects.annotate(rank=Case(
        When(status=RunStatus.RUNNING, then=Value(0)), When(status=RunStatus.QUEUED, then=Value(1)),
        default=Value(2), output_field=IntegerField(),
    )).order_by("rank", "-pk").first()
    return Summary(
        pending_count=ProductClassification.objects.filter(status=Status.PENDING).count(),
        unclassified_count=candidates().count(), run=run,
    )


def get_run(run_id):
    try:
        return ClassificationRun.objects.get(pk=run_id)
    except (ClassificationRun.DoesNotExist, ValueError, TypeError):
        raise ClassificationNotFound() from None


def runs(*, status=None):
    """Runs, newest first."""
    queryset = ClassificationRun.objects.order_by("-pk")
    if status is not None:
        queryset = queryset.filter(status=status)
    return queryset
