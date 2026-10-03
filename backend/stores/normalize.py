import unicodedata

ADDRESS_KEY_MAX_LENGTH = 255


def normalize_address(value):
    """Нижний регистр, без пунктуации, со схлопнутыми пробелами."""
    # NFC, а не NFKC: совместимая форма превращает «№» в буквы «No», и они попали бы в ключ.
    text = unicodedata.normalize("NFC", value or "").lower()
    kept = (char if unicodedata.category(char)[0] in "LNM" else " " for char in text)
    return " ".join("".join(kept).split())


def address_language(address_i18n):
    """Код языка, по которому строится ключ: первый по алфавиту с непустым адресом."""
    if not isinstance(address_i18n, dict):
        return None
    codes = [
        code for code, text in address_i18n.items()
        if isinstance(code, str) and isinstance(text, str) and normalize_address(text)
    ]
    # Вторичный ключ делает выбор однозначным, если коды различаются только регистром.
    return min(codes, key=lambda code: (code.strip().lower(), code), default=None)


def address_key(address_raw, address_i18n=None):
    """Ключ идентификации магазина по адресу.

    Для двуязычного чека ключ строится по одному языку из address_i18n, поэтому
    не зависит от того, какой вариант оказался в address_raw и в каком порядке
    варианты введены. Без вариантов по языкам используется address_raw.
    """
    code = address_language(address_i18n)
    source = address_raw if code is None else address_i18n[code]
    return normalize_address(source)[:ADDRESS_KEY_MAX_LENGTH].rstrip()
