"""Общие части эндпоинтов ``/api/stats/*``: фильтры, деньги, слитые товары.

Период — по локальной дате чека ``purchased_on``, обе границы включительно. Валюты
не складываются: каждый расчёт делит строки по коду валюты чека. Модули расчёта в
``receipts`` о слияниях не знают — выражение ``owner_product_id`` передаёт им слой API.
"""
from dataclasses import dataclass
from datetime import date

from django.db.models import BigIntegerField, Case, F, Q, When

from accounts.access import owner_q
from merges.models import ProductMergeMember
from receipts.decimal_math import price_context
from receipts.models import Receipt
from stores.models import Store

from . import common

STORE_NOT_FOUND = "Магазин не найден."


# --- фильтры ---

@dataclass(frozen=True)
class Period:
    """Границы локальной даты чека, обе включительно; ``None`` — без границы."""

    date_from: date | None = None
    date_to: date | None = None

    def as_json(self):
        return {"date_from": common.iso_date(self.date_from), "date_to": common.iso_date(self.date_to)}


@dataclass(frozen=True)
class Scope:
    """Страна магазина, валюта чека и магазины; ``None`` и ``()`` — без фильтра."""

    country: str | None = None
    currency: str | None = None
    stores: tuple = ()


def read_period(params, from_name="date_from", to_name="date_to", *, required=False):
    """Период из двух параметров; ошибки копятся в ``params``."""
    return Period(*params.date_range(from_name, to_name, required=required))


def read_scope(params):
    """``country``, ``currency``, ``store`` (id через запятую, не больше 20). До трёх запросов."""
    return Scope(
        country=params.country(),
        currency=params.currency(),
        stores=tuple(params.object_ids("store", Store.objects.all(), message=STORE_NOT_FOUND)),
    )


def receipt_q(scope, period=None, prefix=""):
    """Условие на чек; ``prefix`` — путь до ``Receipt``, например ``"receipt__"`` от строки."""
    conditions = {"store__country_id": scope.country, "currency_id": scope.currency}
    if scope.stores:
        conditions["store_id__in"] = scope.stores
    if period is not None:
        conditions["purchased_on__gte"] = period.date_from
        conditions["purchased_on__lte"] = period.date_to
    return Q(**{f"{prefix}{field}": value for field, value in conditions.items() if value is not None})


def receipts(request, scope, period=None):
    """Чеки пользователя запроса по фильтрам: статистика двух пользователей не складывается.

    Закрытые поля не выбирайте — расчётам нужны только суммы и ключи.
    """
    return Receipt.objects.filter(owner_q(request), receipt_q(scope, period))


# --- слитые товары ---

def owner_product_id(prefix=""):
    """Товар, которому принадлежит строка: оставляемый вместо поглощённого.

    Слияние переносит строки на оставляемый товар сразу, но «отбившаяся» строка может
    ещё указывать на поглощённый. Выражение даёт ``target_ref`` его ожидающей группы,
    иначе ``product_id``; у несопоставленной строки — ``NULL``. Обратная связь один к
    одному добавляет два LEFT JOIN без размножения строк. ``prefix`` — путь до
    ``ReceiptLine``.
    """
    member = f"{prefix}product__pending_merge_member__"
    return Case(
        When(**{f"{member}role": ProductMergeMember.Role.SOURCE}, then=F(f"{member}group__target_ref")),
        default=F(f"{prefix}product_id"),
        output_field=BigIntegerField(),
    )


# --- числа ---

money = common.amount


def ratio_percent(part, whole):
    """``part / whole × 100`` двумя знаками строкой; ``None``, если нечего делить."""
    if part is None or not whole:
        return None
    with price_context():
        return common.percent(part * 100 / whole)
