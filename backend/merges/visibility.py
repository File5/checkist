"""Catalog visibility of products absorbed by a pending merge.

An absorbed product is an active ``source`` member of a pending group. Its
``ProductMergeMember.active_product`` is set exactly for that time, so one
indexed lookup answers the question; no group join is needed.
"""
from django.db.models import Exists, OuterRef, Q

from merges.models import ProductMergeMember

Role = ProductMergeMember.Role


def absorbed():
    """Members that hide their product: active sources of pending groups."""
    return ProductMergeMember.objects.filter(active_product__isnull=False, role=Role.SOURCE)


def visible(queryset):
    """Product queryset without absorbed products (``NOT EXISTS``, no extra query)."""
    return queryset.filter(~Exists(absorbed().filter(active_product=OuterRef("pk"))))


def visible_q(prefix=""):
    """The same condition as a ``Q`` for a relation path to Product, e.g. ``visible_q("products__")``.

    For filtered aggregates such as ``Count("products", filter=visible_q("products__"))``.
    The reverse one-to-one adds a single-valued LEFT JOIN, so rows are not multiplied.
    """
    return Q(**{f"{prefix}pending_merge_member__isnull": True}) | Q(**{f"{prefix}pending_merge_member__role": Role.TARGET})


def absorbed_product_ids():
    return absorbed().values("active_product_id")


def is_absorbed(product_id):
    return absorbed().filter(active_product_id=product_id).exists()
