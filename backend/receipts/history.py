"""История трат без чека для «Новой траты»: подсказки при вводе, частые траты, похожие траты и места для модели.

Модель здесь не участвует. Трата повторяется «как в прошлый раз»: место, категория, валюта, сумма, комментарий,
у траты с позициями — позиции. Одинаковые повторы (место, валюта, категория либо названия позиций) показываются
один раз — последней тратой и числом таких трат ``uses``. Чеки на входе — уже видимые человеку
(``accounts.access.visible_receipts_q``); число запросов не зависит от числа трат.
"""
import re
from collections import Counter
from difflib import SequenceMatcher

from django.db.models import Count, Exists, OuterRef, Q

from receipts.manual import STORE_NAME_MAX
from receipts.models import Receipt, ReceiptLine
from stores import merging
from stores.models import Store

RECENT = 300  # последние траты, среди которых ищутся частые и похожие
MATCHED = 100  # последние совпавшие с вводом траты
SUGGEST_LIMIT = 5
FREQUENT_LIMIT = 4
SIMILAR_LIMIT = 10
SIMILAR_MIN = 0.5  # среднее по словам ввода
WORD_MIN = 0.75  # «подписка» — «подписки», но не «выписка»
STORES_LIMIT = 100
WORDS_MAX = 4


def _spends(receipts, limit):
    """Последние траты без чека из ``receipts``, новые сверху; три запроса."""
    rows = list(receipts.filter(source=Receipt.Source.MANUAL).select_related("store__merchant")
                .order_by("-purchased_at", "-pk")[:limit])
    lines = {}
    for line in (ReceiptLine.objects.filter(receipt_id__in=[row.pk for row in rows]).order_by("position", "pk")
                 .values("receipt_id", "raw_name", "amount", "category_id", "category__name")):
        lines.setdefault(line["receipt_id"], []).append(line)
    spellings = merging.aliases({row.store_id for row in rows if row.store_id})
    return [_spend(row, lines.get(row.pk, []), spellings.get(row.store_id, [])) for row in rows]


def _spend(receipt, lines, aliases):
    # Как у клиента (draftFromReceipt): одна строка с именем своей категории — трата без позиций.
    single = len(lines) == 1 and lines[0]["category_id"] is not None and lines[0]["raw_name"] == lines[0]["category__name"]
    category = {"id": lines[0]["category_id"], "name": lines[0]["category__name"]} if single else None
    positions = [] if single else [{"name": line["raw_name"], "amount": str(line["amount"]), "category": line["category_id"]}
                                   for line in lines]
    store = None if receipt.store is None else merging.display_name(receipt.store)
    return {
        "receipt_id": receipt.pk, "store_name": store, "category": category, "currency": receipt.currency_id,
        "total": str(receipt.total), "note": receipt.note, "purchased_on": receipt.purchased_on.isoformat(),
        "lines": positions,
        "key": (receipt.store_id, receipt.currency_id, category["id"] if single else tuple(p["name"] for p in positions)),
        "text": " ".join([store or "", *aliases, receipt.note, *(line["raw_name"] for line in lines)]),
    }


def _distinct(spends, order):
    """Одна трата на повтор (последняя) с числом таких трат ``uses``; порядок — ``order(трата)``."""
    uses = Counter(spend["key"] for spend in spends)
    first = {}
    for spend in spends:
        first.setdefault(spend["key"], {**spend, "uses": uses[spend["key"]]})
    return sorted(first.values(), key=order)


def public(spend):
    """Подсказка без служебных ключей."""
    return {key: value for key, value in spend.items() if key not in ("key", "text", "score", "index")}


def words(text):
    """Слова ввода для поиска: без чисел (суммы, даты), не короче двух букв, не больше ``WORDS_MAX``."""
    return [word for word in text.split() if len(word) >= 2 and not re.search(r"[0-9]", word)][:WORDS_MAX]


def suggest(receipts, text, limit=SUGGEST_LIMIT):
    """Траты, где каждое слово ``text`` есть в месте (с вариантами написания), комментарии либо позициях;
    частые сначала. Пусто без слов."""
    found = words(text)
    if not found:
        return []
    for word in found:
        match = Q()
        for spelling in {word, latin(word)}:  # «магн» находит «MAGNUM»
            spelled = Store.objects.filter(merged_into_id=OuterRef("store_id")).filter(
                Q(merchant__brand_name__icontains=spelling) | Q(name__icontains=spelling))
            lines = ReceiptLine.objects.filter(receipt_id=OuterRef("pk"), raw_name__icontains=spelling)
            match |= (Q(store__merchant__brand_name__icontains=spelling) | Q(store__name__icontains=spelling)
                      | Q(note__icontains=spelling) | Q(Exists(spelled)) | Q(Exists(lines)))
        receipts = receipts.filter(match)
    spends = _spends(receipts, MATCHED)
    recency = {spend["key"]: index for index, spend in reversed(list(enumerate(spends)))}
    return [public(spend) for spend in _distinct(spends, lambda spend: (-spend["uses"], recency[spend["key"]]))[:limit]]


def frequent(receipts, limit=FREQUENT_LIMIT):
    """Повторяющиеся траты (не меньше двух раз среди последних ``RECENT``), частые сначала."""
    spends = _spends(receipts, RECENT)
    recency = {spend["key"]: index for index, spend in reversed(list(enumerate(spends)))}
    repeated = [spend for spend in _distinct(spends, lambda spend: (-spend["uses"], recency[spend["key"]])) if spend["uses"] > 1]
    return [public(spend) for spend in repeated[:limit]]


# Кириллица латиницей, как пишут вывески и выписки: «магнум» — «magnum», «яндекс» — «yandeks».
LATIN = str.maketrans({
    "а": "a", "б": "b", "в": "v", "г": "g", "д": "d", "е": "e", "ё": "e", "ж": "zh", "з": "z", "и": "i", "й": "y",
    "к": "k", "л": "l", "м": "m", "н": "n", "о": "o", "п": "p", "р": "r", "с": "s", "т": "t", "у": "u", "ф": "f",
    "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "sch", "ъ": "", "ы": "y", "ь": "", "э": "e", "ю": "yu", "я": "ya",
    "ә": "a", "ғ": "g", "қ": "k", "ң": "n", "ө": "o", "ұ": "u", "ү": "u", "һ": "h", "і": "i",
})


def latin(word):
    return word.lower().translate(LATIN)


def _fold(text):
    return re.findall(r"[^\W\d_]{3,}", (text or "").lower().replace("ё", "е"))


def _closeness(word, other):
    """1 — одно слово начало другого, иначе доля совпадения, если она не меньше ``WORD_MIN``, иначе 0."""
    if other.startswith(word) or word.startswith(other):
        return 1.0
    ratio = SequenceMatcher(None, word, other).ratio()
    return ratio if ratio >= WORD_MIN else 0.0


def _score(wanted, candidate):
    """Среднее по словам ввода лучшего совпадения со словами траты (и с кириллицей латиницей)."""
    if not wanted or not candidate:
        return 0.0
    return sum(max(_closeness(spelling, other) for spelling in {word, latin(word)} for other in candidate)
               for word in wanted) / len(wanted)


def similar(receipts, text, limit=SIMILAR_LIMIT):
    """До ``limit`` прошлых трат, похожих на ``text`` (место с вариантами, комментарий, позиции, категория),
    похожие сначала, одна на повтор; без похожих — пусто. Для разбора словами (вход модели)."""
    wanted = _fold(text)
    scored = []
    for index, spend in enumerate(_spends(receipts, RECENT)):
        category = spend["category"]["name"] if spend["category"] else ""
        score = _score(wanted, _fold(f"{spend['text']} {category}"))
        if score >= SIMILAR_MIN:
            scored.append({**spend, "score": score, "index": index})
    best = _distinct(scored, lambda spend: (-spend["score"], spend["index"]))
    return [{**public(spend), "category": spend["category"]["id"] if spend["category"] else None} for spend in best[:limit]]


def store_names(receipts, limit=STORES_LIMIT):
    """Места семьи по числу трат (частые сначала): ``[{"name", "aliases"}]``; три запроса. Названия длиннее
    ``STORE_NAME_MAX`` (вывески чеков с фото) модель вернуть не может — их нет."""
    counts = list(receipts.filter(store__isnull=False).values("store_id").annotate(uses=Count("pk"))
                  .order_by("-uses", "store_id")[:limit])
    ids = [row["store_id"] for row in counts]
    stores = Store.objects.select_related("merchant").in_bulk(ids)
    spellings = merging.aliases(ids)
    names = [(merging.display_name(stores[pk]), spellings.get(pk, [])) for pk in ids]
    return [{"name": name, "aliases": also} for name, also in names if len(name) <= STORE_NAME_MAX]
