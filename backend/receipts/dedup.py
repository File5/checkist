import unicodedata

from receipts.models import ProductAlias, Receipt
from stores.models import Store

FISCAL_KEY_MAX_LENGTH = 160
NAME_KEY_MAX_LENGTH = 255

# Страна -> реквизиты из Receipt.fiscal, из которых собирается ключ, по порядку.
FISCAL_KEY_PARTS = {
    "RU": ("fn", "fd"),  # ФН, ФД
    "KZ": ("rnm", "fp"),  # РНМ, ФП
    "DE": ("register_serial", "tse_transaction"),  # серийный номер кассы, номер TSE-транзакции
}


def _fiscal_part(value):
    if value is None or isinstance(value, (bool, float)):
        return ""
    # Реквизит печатают с пробелами-разделителями («7382 4409 ...») — в ключ они не входят.
    return "".join(str(value).split())


def build_fiscal_key(country_code, fiscal):
    """Канонический фискальный идентификатор: ``ru:<ФН>:<ФД>``, ``kz:<РНМ>:<ФП>``,
    ``de:<серийный номер кассы>:<номер TSE-транзакции>``.

    Пустая строка — ключ собрать нельзя: схемы для страны нет или не хватает реквизита.
    Такой чек дедуплицируется по следующим уровням.
    """
    code = (country_code or "").strip().upper()
    names = FISCAL_KEY_PARTS.get(code)
    if names is None or not isinstance(fiscal, dict):
        return ""
    parts = [_fiscal_part(fiscal.get(name)) for name in names]
    if not all(parts):
        return ""
    key = ":".join([code.lower(), *parts])
    if len(key) > FISCAL_KEY_MAX_LENGTH:
        raise ValueError(f"fiscal_key: longer than {FISCAL_KEY_MAX_LENGTH} characters.")
    return key


def name_key(raw_name):
    """Нормализованное название с чека: нижний регистр, схлопнутые пробелы.

    Пунктуация сохраняется: в названиях товаров она значима («2,5%», «0.5л»).
    """
    text = unicodedata.normalize("NFC", raw_name or "").lower()
    return " ".join(text.split())[:NAME_KEY_MAX_LENGTH].rstrip()


def _value(data, name, default=""):
    if isinstance(data, dict):
        return data.get(name, default)
    return getattr(data, name, default)


def _store_id(data):
    store = _value(data, "store", None)
    if store is None:
        return _value(data, "store_id", None)
    return getattr(store, "pk", store)


def _fiscal_key(data, store_id):
    key = _value(data, "fiscal_key") or ""
    fiscal = _value(data, "fiscal", None)
    if key or not fiscal or store_id is None:
        return key
    store = _value(data, "store", None)
    country_code = getattr(store, "country_id", None)
    if country_code is None:
        country_code = Store.objects.filter(pk=store_id).values_list("country_id", flat=True).first()
    return build_fiscal_key(country_code, fiscal)


def find_duplicates(receipt_data):
    """Сохранённые чеки, похожие на ввод, до его сохранения: три уровня по очереди.

    ``receipt_data`` — словарь полей Receipt (``store`` — объект или id) либо
    несохранённый/сохранённый Receipt; сам чек из результата исключается.

    В отличие от unique-ограничений БД уровни не зависят от того, какие поля
    заполнены у сохранённого чека: чек, введённый с фискальным ключом, находится
    по вводу без ключа — по номеру либо по моменту покупки и сумме. Пустые смена
    и касса сравнению не мешают: на вводе это «неизвестно», а не «другая».
    Результат — кандидаты, от более сильного уровня к слабому, без повторов.
    """
    store_id = _store_id(receipt_data)
    queries = []

    fiscal_key = _fiscal_key(receipt_data, store_id)
    if fiscal_key:
        queries.append(Receipt.objects.filter(fiscal_key=fiscal_key))

    if store_id is not None:
        in_store = Receipt.objects.filter(store_id=store_id)

        receipt_number = _value(receipt_data, "receipt_number") or ""
        purchased_on = _value(receipt_data, "purchased_on", None)
        if receipt_number and purchased_on is not None:
            by_number = in_store.filter(purchased_on=purchased_on, receipt_number=receipt_number)
            for field in ("shift_number", "register_code"):
                value = _value(receipt_data, field) or ""
                if value:
                    by_number = by_number.filter(**{f"{field}__in": [value, ""]})
            queries.append(by_number)

        purchased_at = _value(receipt_data, "purchased_at", None)
        total = _value(receipt_data, "total", None)
        if purchased_at is not None and total is not None:
            queries.append(in_store.filter(purchased_at=purchased_at, total=total))

    own_pk = None if isinstance(receipt_data, dict) else getattr(receipt_data, "pk", None)
    found = {}
    for query in queries:
        for receipt in query.order_by("pk"):
            if receipt.pk != own_pk:
                found.setdefault(receipt.pk, receipt)
    return list(found.values())


def find_alias(merchant, raw_name, store_item_code=""):
    """ProductAlias для строки чека: по ``(merchant, store_item_code)``, если код есть,
    иначе по ``(merchant, name_key)``. ``None`` — товар не сопоставлен.
    """
    key = name_key(raw_name)
    aliases = ProductAlias.objects.filter(merchant=merchant).select_related("product")
    if store_item_code:
        candidates = list(aliases.filter(store_item_code=store_item_code).order_by("pk"))
        # Один код с разными написаниями названия: точное написание предпочтительнее.
        return next((alias for alias in candidates if alias.name_key == key), next(iter(candidates), None))
    # Без кода сначала сопоставление, заведённое без кода.
    return aliases.filter(name_key=key).order_by("store_item_code", "pk").first()
