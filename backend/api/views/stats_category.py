"""``GET /api/stats/category-spends/``: на что ушли деньги категории за месяц.

Доступ и чеки — как у прочих ``/api/stats/*``: чеки пользователя запроса и его семьи
(``owner_q``). ``category`` — обязательна (неизвестная — ``404``), ``month`` — ``ГГГГ-ММ``,
по умолчанию текущий месяц сервера. Расчёт — ``receipts.category_spends``; число запросов
к БД от объёма данных не зависит.
"""
from django.utils import timezone
from rest_framework.response import Response

from accounts.people import display_name
from config.exceptions import ObjectNotFound
from receipts import category_spends

from .. import common, stats_common
from ..params import Params
from .budget import read_month
from .recognition_base import LocalAPIView


def _part(part, tree):
    return {
        "id": part.id, "name": tree.name(part.id), "direct": part.direct,
        "children_count": len(tree.children(part.id)) if not part.direct else 0,
        "amount": stats_common.money(part.amount), "lines_count": part.lines_count,
    }


def _receipt(item, tree):
    receipt = item.receipt
    return {
        # Валюта чека и сумма его строк категории в ней: в блоке основной валюты суммы ниже — пересчёт.
        "currency": receipt.currency_id, "original_amount": stats_common.money(item.original),
        "receipt_id": receipt.pk, "source": receipt.source,
        "purchased_on": common.iso_date(receipt.purchased_on),
        "store": None if receipt.store_id is None else {"id": receipt.store_id, "name": common.store_name(receipt.store)},
        "note": receipt.note,
        "owner": receipt.owner.get_username(), "owner_name": display_name(receipt.owner),
        "receipt_total": stats_common.money(receipt.total if item.total is None else item.total),
        "category_amount": stats_common.money(item.amount),
        "lines": [
            {"id": line.id, "name": line.name, "amount": stats_common.money(line.amount),
             "category_id": line.category_id, "category_name": tree.name(line.category_id)}
            for line in item.lines
        ],
    }


def _block(block, tree):
    return {
        "currency": block.currency,
        "total": stats_common.money(block.total),
        "receipts_count": len(block.receipts),
        "parts": [_part(part, tree) for part in category_spends.ordered_parts(block, tree)],
        "items": [_receipt(item, tree) for item in category_spends.ordered_receipts(block)],
    }


class CategorySpendsView(LocalAPIView):
    """Одна категория (с потомками) за месяц: итог, разбивка по подкатегориям и чеки со строками."""

    def get(self, request):
        params = Params(request.query_params)
        month = read_month(params, timezone.localdate())
        category = params.integer("category")
        if category is None and params.raw("category") is None:
            params.error("category", "Обязательный параметр.")
        params.check()
        tree = common.CategoryTree.load()
        if category not in tree:
            raise ObjectNotFound()
        period = stats_common.Period(month.first, month.last)
        receipts = stats_common.receipts(request, stats_common.Scope(), period)
        loaded = category_spends.load(receipts, tree, category, stats_common.owner_product_id())
        blocks = stats_common.primary_first(request, category_spends.group(loaded, tree, category))
        converter = stats_common.converter(request, category_spends.needs(loaded))
        in_base = category_spends.group(loaded, tree, category, converter)
        block = stats_common.base_block(in_base, converter.base)
        unconverted = [(found.currency, len(found.receipts), found.total) for found in in_base
                       if found.currency != converter.base]
        return Response({
            "month": month.label(), "previous_month": month.previous().label(),
            "category": {**tree.category(category), "icon": tree.icon(category)},
            "children": [{"id": pk, "name": tree.name(pk)} for pk in tree.children(category)],
            "currencies": [_block(found, tree) for found in blocks],
            **stats_common.base_fields(converter, block and _block(block, tree), unconverted),
        })
