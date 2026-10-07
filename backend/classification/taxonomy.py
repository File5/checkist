"""Names of categories and generic products: the matching key and the checks. No database."""
import unicodedata

# The resolver's service generic product and its root category (recognition/resolution.py).
SERVICE_NAME = "Не разобрано"
BASE_UNITS = ("kg", "l", "pcs")
NAME_MAX_LENGTH = 100  # GenericProduct.name and Category.name
PATH_MAX_LENGTH = 3  # the root and at most two levels below it

_DASHES = str.maketrans(dict.fromkeys("‐‑‒–—−", "-"))


def name_key(text):
    """One key for categories and generic products.

    NFKC, casefold, ё → е, every dash → "-", whitespace runs → one space.
    Punctuation and grammatical number are kept: «Яйцо» and «Яйца» differ.
    """
    text = unicodedata.normalize("NFKC", text or "").casefold().replace("ё", "е").translate(_DASHES)
    return " ".join(text.split())


SERVICE_KEY = name_key(SERVICE_NAME)


def display_name(text):
    """Name of a new record: NFC, whitespace collapsed, first letter capital, the rest as sent."""
    text = " ".join(unicodedata.normalize("NFC", text or "").split())
    return text[:1].upper() + text[1:]


def is_valid_name(text):
    """1–100 characters after normalisation, no control characters, at least one Cyrillic letter."""
    text = display_name(text)
    return (
        0 < len(text) <= NAME_MAX_LENGTH
        and not any(unicodedata.category(char) in ("Cc", "Cs") for char in text)
        and any(char.isalpha() and "CYRILLIC" in unicodedata.name(char, "") for char in text)
    )


def is_service_name(text):
    return name_key(text) == SERVICE_KEY
