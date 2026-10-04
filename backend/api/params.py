import re
from datetime import date

from config.exceptions import InvalidParameter
from stores.models import Country, Currency

from .pagination import DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PageParams

MAX_ID = 2**63 - 1  # BigAutoField
MAX_COUNTRIES = 20
SEARCH_MIN_LENGTH = 2
SEARCH_MAX_LENGTH = 100

_INTEGER = re.compile(r"[0-9]{1,19}")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")
_COUNTRY = re.compile(r"[A-Z]{2}")
_CURRENCY = re.compile(r"[A-Z]{3}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")  # Unicode Cc: C0, DEL, C1


class Params:
    """Разбор и проверка query-параметров одного запроса.

    Каждый метод возвращает разобранное значение либо ``default``, если параметра нет
    или он пуст (``?q=`` и ``?q=%20`` — то же, что без параметра). Недопустимое
    значение не прерывает разбор: ошибка копится по имени параметра, метод возвращает
    ``default``, а ``check()`` в конце поднимает один ``400 invalid_parameter`` со
    всеми ошибками в ``fields``. Неизвестные параметры не читаются и потому
    игнорируются. Повторённый параметр — берётся последнее значение.

        params = Params(request.query_params)
        country = params.country()
        date_from, date_to = params.date_range()
        page = params.page()
        params.check()

    В сообщения попадают только фиксированные тексты и допустимые значения — не
    присланное значение.
    """

    def __init__(self, query):
        self.query = query
        self.errors = {}

    def raw(self, name):
        """Значение без пробелов по краям; управляющие символы — ошибка до нормализации."""
        value = self.query.get(name)
        if value is None:
            return None
        if _CONTROL.search(value):
            # Проверяем исходное значение: strip() иначе молча уберёт, например, TAB/LF.
            # Некоторые параметры (target_currency) читаются несколько раз.
            if name not in self.errors:
                self.error(name, "Управляющие символы недопустимы.")
            return None
        return value.strip() or None

    def error(self, name, message):
        """Добавить ошибку параметра — для проверок вне этого модуля (например, курсов)."""
        self.errors.setdefault(name, []).append(message)

    def check(self):
        """Поднять ``InvalidParameter``, если накопились ошибки."""
        if self.errors:
            raise InvalidParameter(self.errors)

    # --- простые значения ---

    def integer(self, name, *, default=None, minimum=1, maximum=MAX_ID, message=None):
        """Целое в ``[minimum, maximum]``; по умолчанию — положительный идентификатор."""
        value = self.raw(name)
        if value is None:
            return default
        if _INTEGER.fullmatch(value) and minimum <= int(value) <= maximum:
            return int(value)
        self.error(name, message or "Ожидается целое положительное число.")
        return default

    def boolean(self, name, *, default=None):
        """``1`` — ``True``, ``0`` — ``False``."""
        value = self.raw(name)
        if value is None:
            return default
        if value in ("1", "0"):
            return value == "1"
        self.error(name, "Ожидается 1 или 0.")
        return default

    def choice(self, name, choices, *, default=None):
        """Одно из ``choices`` (``ordering``, ``interval``, ``group_by``, ``price``, ``scope``)."""
        value = self.raw(name)
        if value is None:
            return default
        if value in choices:
            return value
        self.error(name, f"Допустимые значения: {', '.join(choices)}.")
        return default

    def search(self, name="q"):
        """Строка поиска от 2 до 100 символов без пробелов по краям и управляющих символов."""
        value = self.raw(name)
        if value is None:
            return None
        if SEARCH_MIN_LENGTH <= len(value) <= SEARCH_MAX_LENGTH:
            return value
        self.error(name, f"Ожидается от {SEARCH_MIN_LENGTH} до {SEARCH_MAX_LENGTH} символов.")
        return None

    # --- даты ---

    def date(self, name):
        """Дата ``ГГГГ-ММ-ДД``."""
        value = self.raw(name)
        if value is None:
            return None
        if _DATE.fullmatch(value):
            try:
                return date.fromisoformat(value)
            except ValueError:
                pass
        self.error(name, "Ожидается дата ГГГГ-ММ-ДД.")
        return None

    def date_range(self, from_name="date_from", to_name="date_to"):
        """Пара дат, обе необязательны и включительны; ``date_from > date_to`` — ошибка."""
        date_from, date_to = self.date(from_name), self.date(to_name)
        if date_from and date_to and date_from > date_to:
            self.error(from_name, f"Должна быть не позже {to_name}.")
        return date_from, date_to

    # --- справочники ---

    def _codes(self, name, pattern, model, expected, unknown, *, many, maximum=None):
        value = self.raw(name)
        if value is None:
            return [] if many else None
        codes = [part.strip().upper() for part in value.split(",")] if many else [value.upper()]
        codes = list(dict.fromkeys(codes))  # без повторов, порядок сохранён
        empty = [] if many else None
        if not all(pattern.fullmatch(code) for code in codes):
            self.error(name, expected)
            return empty
        if maximum is not None and len(codes) > maximum:
            self.error(name, f"Не больше {maximum} значений.")
            return empty
        known = set(model.objects.filter(pk__in=codes).values_list("pk", flat=True))
        if len(known) != len(codes):
            self.error(name, unknown)
            return empty
        return codes if many else codes[0]

    def country(self, name="country"):
        """Код страны из справочника (регистр не важен) либо ``None``. Один запрос."""
        return self._codes(
            name, _COUNTRY, Country, "Ожидается код страны из двух букв.", "Неизвестный код страны.", many=False,
        )

    def countries(self, name="country", *, maximum=MAX_COUNTRIES):
        """Коды стран через запятую, не больше ``maximum``; без параметра — ``[]``. Один запрос."""
        return self._codes(
            name, _COUNTRY, Country, "Ожидаются коды стран из двух букв через запятую.",
            "Неизвестный код страны.", many=True, maximum=maximum,
        )

    def currency(self, name="currency"):
        """Код валюты из справочника (регистр не важен) либо ``None``. Один запрос."""
        return self._codes(
            name, _CURRENCY, Currency, "Ожидается код валюты из трёх букв.", "Неизвестный код валюты.", many=False,
        )

    def object_id(self, name, queryset, *, message="Объект не найден."):
        """Идентификатор существующего объекта ``queryset``; несуществующий — ошибка ``400``.

        Для фильтров, где опечатка должна быть заметна (магазин в истории цен). Один запрос.
        """
        value = self.integer(name)
        if value is None:
            return None
        if queryset.filter(pk=value).exists():
            return value
        self.error(name, message)
        return None

    # --- пагинация ---

    def page(self, *, default=DEFAULT_PAGE_SIZE, maximum=MAX_PAGE_SIZE):
        """``page`` (с 1) и ``page_size`` (от 1 до ``maximum``) — ``PageParams`` для ``paginate``."""
        return PageParams(
            page=self.integer("page", default=1, message="Ожидается целое число от 1."),
            page_size=self.integer(
                "page_size", default=default, maximum=maximum, message=f"Допустимо от 1 до {maximum}.",
            ),
        )
