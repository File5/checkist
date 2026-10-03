from datetime import timezone
from decimal import ROUND_HALF_UP, Decimal

from catalog.models import Category
from config.exceptions import ObjectNotFound

MAX_CATEGORIES = 5000

_QUANTA = {places: Decimal(1).scaleb(-places) for places in (2, 3, 4)}


# --- числа и время ---

def decimal_string(value, places):
    """``Decimal`` -> строка с ``places`` знаками (``ROUND_HALF_UP``); ``None`` остаётся ``None``.

    ``float`` отклоняется: деньги идут от БД до JSON только как ``Decimal``.
    """
    if value is None:
        return None
    if isinstance(value, (float, bool)):
        raise TypeError("Ожидается Decimal, int или строка с десятичным числом.")
    quantum = _QUANTA.get(places) or Decimal(1).scaleb(-places)
    return str(Decimal(value).quantize(quantum, rounding=ROUND_HALF_UP))


def price(value):
    """Цена за единицу: 4 знака, ``"130.5882"``."""
    return decimal_string(value, 4)


def amount(value):
    """Сумма: 2 знака, ``"0.00"``."""
    return decimal_string(value, 2)


def quantity(value):
    """Количество: 3 знака, ``"850.000"``."""
    return decimal_string(value, 3)


def percent(value):
    """Процент: 2 знака, ``"3.81"``."""
    return decimal_string(value, 2)


def utc_datetime(value):
    """Момент в ISO 8601, UTC с ``Z``: ``"2026-06-02T16:12:00Z"``; ``None`` остаётся ``None``."""
    if value is None:
        return None
    return value.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def iso_date(value):
    """Дата ``ГГГГ-ММ-ДД``; ``None`` остаётся ``None``."""
    return None if value is None else value.isoformat()


# --- объекты ---

def get_or_404(queryset, pk):
    """Объект ``queryset`` по ключу либо ``404 not_found`` в формате API."""
    try:
        return queryset.get(pk=pk)
    except queryset.model.DoesNotExist:
        raise ObjectNotFound() from None


def store_name(store):
    """Вывеска продавца, иначе название магазина, иначе ``"Магазин №<id>"``.

    Юридическое название и налоговый номер наружу не идут: у предпринимателя это
    ФИО и ИНН физического лица. Нужен загруженный ``store.merchant``.
    """
    return store.merchant.brand_name or store.name or f"Магазин №{store.pk}"


def store_brief(store):
    """``{"id", "name", "city", "country"}`` — магазин в точке истории и в сравнении."""
    return {"id": store.pk, "name": store_name(store), "city": store.city, "country": store.country_id}


def store_object(store):
    """Полный объект магазина: ``{"id", "name", "city", "address", "country", "timezone"}``."""
    return {
        "id": store.pk,
        "name": store_name(store),
        "city": store.city,
        "address": store.address_raw,
        "country": store.country_id,
        "timezone": store.timezone,
    }


def brand_brief(brand):
    """``{"id", "name"}`` либо ``None``, если бренда нет."""
    return None if brand is None else {"id": brand.pk, "name": brand.name}


def package(product):
    """Фасовка товара ``{"quantity": "850.000", "unit": "ml"}`` либо ``None``."""
    if product.package_quantity is None:
        return None
    return {"quantity": quantity(product.package_quantity), "unit": product.package_unit}


def generic_brief(generic):
    """``{"id", "name", "base_unit"}`` обобщённого продукта."""
    return {"id": generic.pk, "name": generic.name, "base_unit": generic.base_unit}


# --- категории ---

class CategoryLimitExceeded(Exception):
    """Категорий больше ``MAX_CATEGORIES``: ответ — ``500``, справочнику нужен другой контракт."""


class CategoryTree:
    """Карта всех категорий, загруженная одним запросом; создавайте один раз на HTTP-запрос.

    БД не запрещает циклы в дереве. Узел, входящий в цикл, и узел с несуществующим
    родителем считаются корневыми (``depth`` 0, путь из одного узла); ``parent_id``
    при этом остаётся как в БД. Все обходы конечны.
    """

    def __init__(self, rows):
        """``rows`` — ``(id, name, parent_id)``; в коде используйте ``CategoryTree.load()``."""
        self._names = {}
        self._parents = {}
        for pk, name, parent_id in rows:
            self._names[pk] = name
            self._parents[pk] = parent_id
        cyclic = self._cyclic()
        # Родитель для обходов: у корня, узла из цикла и узла-сироты его нет.
        self._effective = {
            pk: None if pk in cyclic or parent_id not in self._names else parent_id
            for pk, parent_id in self._parents.items()
        }
        self._children = {pk: [] for pk in self._names}
        self._roots = []
        for pk in sorted(self._names, key=lambda pk: (self._names[pk], pk)):
            parent_id = self._effective[pk]
            (self._roots if parent_id is None else self._children[parent_id]).append(pk)
        self._paths = {}

    @classmethod
    def load(cls, limit=MAX_CATEGORIES):
        rows = list(Category.objects.order_by("pk").values_list("pk", "name", "parent_id")[:limit + 1])
        if len(rows) > limit:
            raise CategoryLimitExceeded(f"Категорий больше {limit}.")
        return cls(rows)

    def _cyclic(self):
        """Узлы, входящие в цикл; за линейное время."""
        done, cyclic = set(), set()
        for start in self._parents:
            trail, position = [], {}
            current = start
            while current in self._parents and current not in done and current not in position:
                position[current] = len(trail)
                trail.append(current)
                current = self._parents[current]
            if current in position:
                cyclic.update(trail[position[current]:])
            done.update(trail)
        return cyclic

    def __contains__(self, pk):
        return pk in self._names

    def __len__(self):
        return len(self._names)

    def name(self, pk):
        return self._names[pk]

    def parent_id(self, pk):
        """Родитель как в БД — в том числе у узла из цикла."""
        return self._parents[pk]

    def path_ids(self, pk):
        """Идентификаторы от корня до узла включительно."""
        if pk not in self._paths:
            chain = []
            current = pk
            while current is not None and current not in self._paths:
                chain.append(current)
                current = self._effective[current]
            path = list(self._paths[current]) if current is not None else []
            for node in reversed(chain):
                path = [*path, node]
                self._paths[node] = path
        return self._paths[pk]

    def path(self, pk):
        """Путь ``[{"id", "name"}, ...]`` от корня до узла включительно."""
        return [{"id": node, "name": self._names[node]} for node in self.path_ids(pk)]

    def depth(self, pk):
        return len(self.path_ids(pk)) - 1

    def roots(self):
        """Корневые узлы по ``name, id``."""
        return list(self._roots)

    def children(self, pk):
        """Прямые потомки по ``name, id``."""
        return list(self._children[pk])

    def descendant_ids(self, pk):
        """Узел и все его потомки — для фильтра «категория с потомками»."""
        found, stack = [], [pk]
        while stack:
            current = stack.pop()
            found.append(current)
            stack.extend(self._children[current])
        return found

    def ordered_ids(self):
        """Все узлы в порядке обхода в глубину, братья по ``name, id``."""
        ordered, stack = [], list(reversed(self._roots))
        while stack:
            current = stack.pop()
            ordered.append(current)
            stack.extend(reversed(self._children[current]))
        return ordered

    def category(self, pk):
        """Вложенный объект категории: ``{"id", "name", "path"}``."""
        return {"id": pk, "name": self._names[pk], "path": self.path(pk)}
