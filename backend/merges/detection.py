"""Duplicate product detection, detector version 1. Pure functions, no database.

A pair is a candidate only when every signal holds: a shared merchant, equal
numeric signatures, a bounded edit distance between compact names, no
contradicting facts and no recorded rejection. Price and unit are not signals.
The rule separates the studied data but does not prove identity; that is why
the merge stays provisional until a human confirms it.
"""
import re
import unicodedata
from dataclasses import dataclass
from itertools import combinations

from recognition.resolution import canonical_gtin

DETECTOR_VERSION = 1
# The resolver's service generic (recognition/resolution.py); it counts as "no generic".
SERVICE_GENERIC_NAME = "Не разобрано"

_NUMBER = re.compile(r"\d+(?:[.,]\d+)*")


def compact(name):
    """Letters and digits only, case- and diacritic-insensitive (ü→u, й→и, ё→е)."""
    text = unicodedata.normalize("NFKD", unicodedata.normalize("NFKD", name or "").casefold())
    return "".join(char for char in text if not unicodedata.combining(char) and char.isalnum())


def numbers(name):
    """Numeric signature in order: «1,5%» → ("1.5",), «10er» → ("10",)."""
    return tuple(match.replace(",", ".") for match in _NUMBER.findall(name or ""))


def levenshtein(first, second):
    """Edit distance: insertion, deletion and substitution cost 1 each."""
    if len(first) < len(second):
        first, second = second, first
    previous = list(range(len(second) + 1))
    for row, left in enumerate(first, 1):
        current = [row]
        for column, right in enumerate(second, 1):
            current.append(min(
                previous[column] + 1, current[column - 1] + 1, previous[column - 1] + (left != right),
            ))
        previous = current
    return previous[-1]


def tolerance(length):
    """Allowed distance for the shorter compact name of the pair."""
    if length >= 12:
        return 2
    return 1 if length >= 6 else 0


def is_service_generic(name):
    return (name or "").casefold() == SERVICE_GENERIC_NAME.casefold()


def gtin_key(value):
    """Comparable GTIN: padded GTIN-14 when the checksum is valid, else the text itself."""
    value = (value or "").strip()
    return canonical_gtin(value) or value


@dataclass(frozen=True)
class Candidate:
    """Product as the detector sees it. ``brand`` and ``package`` are opaque comparable values."""

    id: int
    name: str
    merchants: frozenset = frozenset()
    gtin: str = ""
    brand: object = None
    package: object = None
    model: str = ""
    service_generic: bool = True


def facts_conflict(first, second):
    """Signal 4: both sides filled and different in GTIN, brand, package or model."""
    pairs = (
        (gtin_key(first.gtin), gtin_key(second.gtin)),
        (first.brand, second.brand),
        (first.package, second.package),
        ((first.model or "").strip(), (second.model or "").strip()),
    )
    return any(left not in (None, "") and right not in (None, "") and left != right for left, right in pairs)


def filled_facts(candidate):
    return sum(
        value not in (None, "")
        for value in (candidate.brand, gtin_key(candidate.gtin), (candidate.model or "").strip(), candidate.package)
    )


def target_key(candidate):
    """The default surviving record is the minimum by this key."""
    return (candidate.service_generic, -filled_facts(candidate), candidate.id)


def pair_key(first_id, second_id):
    return (first_id, second_id) if first_id < second_id else (second_id, first_id)


def name_distance(first, second):
    """Distance of a pair passing signals 1–3, otherwise ``None``."""
    if not first.merchants & second.merchants:
        return None
    if numbers(first.name) != numbers(second.name):
        return None
    left, right = compact(first.name), compact(second.name)
    shortest = min(len(left), len(right))
    # A name without letters or digits identifies nothing.
    if not shortest or abs(len(left) - len(right)) > tolerance(shortest):
        return None
    distance = levenshtein(left, right)
    return distance if distance <= tolerance(shortest) else None


def find_edges(candidates, rejected=frozenset()):
    """Candidate pairs ``(distance, low id, high id)`` passing signals 1–5, sorted."""
    edges = []
    for first, second in combinations(sorted(candidates, key=lambda item: item.id), 2):
        if pair_key(first.id, second.id) in rejected or facts_conflict(first, second):
            continue
        distance = name_distance(first, second)
        if distance is not None:
            edges.append((distance, first.id, second.id))
    return sorted(edges)


@dataclass(frozen=True)
class Proposal:
    """A found group. ``existing`` is the key of the pending group it extends, if any."""

    product_ids: tuple
    target_id: int
    existing: object = None
    added_ids: tuple = ()


def find_groups(candidates, rejected=frozenset(), existing=None, scope=None):
    """Deterministic grouping; the result does not depend on the input order.

    ``existing`` maps a key to the product ids of a pending group. Such groups
    are ready-made sets: they only grow and are never joined to each other.
    ``scope`` limits the search to pairs touching these product ids.
    Returns new groups and extended ones, ordered by the smallest product id.
    """
    by_id = {candidate.id: candidate for candidate in candidates}
    rejected = frozenset(rejected)
    sets, owner, origin = {}, {}, {}
    for key, ids in sorted((existing or {}).items(), key=lambda item: min(item[1])):
        members = frozenset(ids)
        slot = min(members)
        sets[slot], origin[slot] = set(members), key
        owner.update(dict.fromkeys(members, slot))
    for product_id in by_id:
        if product_id not in owner:
            sets[product_id] = {product_id}
            owner[product_id] = product_id

    def compatible(left, right):
        for first in left:
            for second in right:
                if pair_key(first, second) in rejected:
                    return False
                if first in by_id and second in by_id and facts_conflict(by_id[first], by_id[second]):
                    return False
        return True

    for _, low, high in find_edges(by_id.values(), rejected):
        if scope is not None and low not in scope and high not in scope:
            continue
        first, second = owner[low], owner[high]
        if first == second or (first in origin and second in origin):
            continue
        if not compatible(sets[first], sets[second]):
            continue
        keep, drop = (first, second) if first in origin or (second not in origin and first < second) else (second, first)
        sets[keep] |= sets.pop(drop)
        owner.update(dict.fromkeys(sets[keep], keep))

    proposals = []
    for slot, members in sets.items():
        key = origin.get(slot)
        added = tuple(sorted(members - set(existing[key]))) if key is not None else ()
        if len(members) < 2 or (key is not None and not added):
            continue
        ids = tuple(sorted(members))
        target = min((by_id[product_id] for product_id in ids if product_id in by_id), key=target_key).id
        proposals.append(Proposal(ids, target, key, added))
    return sorted(proposals, key=lambda proposal: proposal.product_ids)
