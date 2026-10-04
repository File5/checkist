from dataclasses import dataclass

from config.exceptions import PageOutOfRange

DEFAULT_PAGE_SIZE = 50
MAX_PAGE_SIZE = 200
# Точки истории цен.
HISTORY_PAGE_SIZE = 200
HISTORY_MAX_PAGE_SIZE = 500
# Сравнение альтернатив.
COMPARE_PAGE_SIZE = 50
COMPARE_MAX_PAGE_SIZE = 100


@dataclass(frozen=True)
class PageParams:
    """Разобранные ``page`` и ``page_size``; создаёт ``Params.page()``."""

    page: int = 1
    page_size: int = DEFAULT_PAGE_SIZE


def paginate(items, page_params, serialize=None):
    """Страница набора в формате контракта: ``{count, page, page_size, pages, results}``.

    ``items`` — ``QuerySet`` (тогда выполняются ``COUNT`` и запрос страницы) или
    последовательность; порядок задаёт вызывающий код и заканчивает его первичным
    ключом. ``serialize`` — функция элемента; без неё элементы отдаются как есть.
    Чтобы сериализовать страницу целиком (одна сводка цен на все товары страницы),
    вызовите без ``serialize`` и замените ``results``.

    Пустой набор на первой странице — ``pages: 0`` и ``results: []``. Страница дальше
    последней — ``404 page_out_of_range`` (``PageOutOfRange``); проверка идёт до
    выборки, поэтому огромный номер страницы не доходит до БД как ``OFFSET``.
    Ссылок ``next`` / ``previous`` нет намеренно.
    """
    count = items.count() if hasattr(items, "values_list") else len(items)
    pages = -(-count // page_params.page_size)
    if page_params.page > max(pages, 1):
        raise PageOutOfRange()
    start = (page_params.page - 1) * page_params.page_size
    results = list(items[start:start + page_params.page_size])
    if serialize is not None:
        results = [serialize(item) for item in results]
    return {
        "count": count,
        "page": page_params.page,
        "page_size": page_params.page_size,
        "pages": pages,
        "results": results,
    }
