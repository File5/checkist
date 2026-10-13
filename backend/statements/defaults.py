"""Встроенные образцы: известные сети и сервисы, коды MCC, вид операции и красивые названия мест.

Только общие названия, никаких людей: личные правила («Олег Б. → Жильё › Аренда») человек
заводит сам на экране правил. Категория образца — путь имён в общем дереве; если такой
категории в дереве нет, образец молчит и строку разбирает модель или человек.
Правила человека и семьи (``StatementRule``) важнее образцов.
"""
import re

FOOD = ("Еда и напитки",)
CAFE = ("Кафе и рестораны",)
TRANSPORT = ("Транспорт",)
HEALTH = ("Здоровье",)
CLOTHES = ("Одежда",)
FUN = ("Развлечения",)
SUBS = ("Связь и подписки",)
ELECTRONICS = ("Электроника",)
SHOP = ("Покупки онлайн",)
BANK = ("Банк и комиссии",)
GOV = ("Госуслуги и страховка",)
EDU = ("Образование",)
REPAIR = ("Ремонт и обустройство",)

# (образец по получателю, путь категории, название места; None — получатель как есть, "" — без места)
BUILTIN = [
    (r"\bonay\b|avtobys|metro\s*almaty|yandex\.?\s*go\b|яндекс\s*go|\buber\b|\bbolt\b|whoosh|indrive", TRANSPORT, None),
    (r"\bmagnum\b|\bsmall\b|galmart|\barbuz|anvar|анвар|toimart|metro\s*cash|city\s*market|ramstore|рамстор|"
     r"\bspar\b|airba\s*fresh|yandex\.?\s*lavka|яндекс\s*лавка", FOOD, None),
    (r"yandex\.?\s*eda|яндекс\s*еда|\bglovo\b|\bwolt\b|starbucks|\bkfc\b|mcdonald|burger\s*king|coffee\s*boom|"
     r"del\s*papa|\bnavat\b|salam\s*bro|hardee|додо|dodo\s*pizza", CAFE, None),
    (r"youtube|apple\.com|netflix|spotify|openai|chatgpt|anthropic|google\s*\*|beeline|kcell|\bactiv\b|tele2|"
     r"\bizi\b|altel", SUBS, None),
    (r"аптек|apteka|europharma|биосфера|biosfera|sadyhan|садыхан|фарма|pharm", HEALTH, None),
    (r"\bsteam\b|kinopark|chaplin|ticketon|тикетон|nintendo|playstation|xsolla", FUN, None),
    (r"\bozon\b|wildberries|aliexpress|alipay|\btemu\b", SHOP, None),
    (r"technodom|sulpak|mechta|xiaomi|\balser\b", ELECTRONICS, None),
    (r"\bzara\b|lc\s*waikiki|uniqlo|\bh&m\b|defacto|bershka", CLOTHES, None),
    (r"комисси|годовое\s*обслуживание|обслуживание\s*карты", BANK, ""),
    (r"госпошлин|\bцон\b|egov|штраф", GOV, None),
]
BUILTIN = [(re.compile(pattern, re.IGNORECASE), path, place) for pattern, path, place in BUILTIN]

# Коды MCC продавца (ForteBank пишет их в деталях покупки).
MCC = {}
for _codes, _path in [
    ("5411 5499 5441 5422 5451 5462", FOOD), ("5812 5813 5814", CAFE),
    ("4111 4112 4121 4131 4789 5541 5542", TRANSPORT), ("5912 8011 8021 8062 8071 8099", HEALTH),
    ("5734 7372 5968 5817 4814 4899", SUBS), ("5816 7922 7832 7994 7941 7996 7997", FUN),
    ("5732 5722 5045", ELECTRONICS), ("5200 5251 5211 5231", REPAIR), ("5651 5691 5699 5661 5697", CLOTHES),
    ("8299 8220 8241", EDU), ("5262 5310 5311 5399 5964", SHOP), ("9311 9222 9399", GOV),
]:
    for _code in _codes.split():
        MCC[_code] = _path

# Красивые названия мест для известных написаний (как в первых импортах).
PLACES = [
    (r"^magnum", "MAGNUM"), (r"^city\s*market", "City Market"), (r"^yandex\.?\s*go", "Yandex Go"),
    (r"^yandex\.?\s*eda", "Yandex Eda"), (r"^metro\s*almaty", "Metro Almaty"), (r"steam", "Steam"),
    (r"^anthropic", "Anthropic"), (r"^openai", "OpenAI"), (r"^ozon", "OZON"), (r"whoosh", "Whoosh"),
    (r"^apple\.com", "Apple"), (r"^youtube", "YouTube"), (r"^beeline", "Beeline"), (r"^netflix", "Netflix"),
]
PLACES = [(re.compile(pattern, re.IGNORECASE), name) for pattern, name in PLACES]
# Получатели, у которых нет места: QR-оплата через другой банк.
NO_PLACE = re.compile(r"^kaspi_qr|^qr\b", re.IGNORECASE)

# Вид движения по операции банка.
CASH_OPERATIONS = re.compile(r"^Снятие", re.IGNORECASE)
TRANSFER_OPERATIONS = re.compile(r"^(?:Перевод|Списание)", re.IGNORECASE)
INCOME_OPERATIONS = re.compile(r"^(?:Пополнение|Кэшбэк|Вознаграждение)", re.IGNORECASE)
REFUND_OPERATIONS = re.compile(r"^(?:Покупка|Возврат)", re.IGNORECASE)
# Между своими счетами: депозит, «свои счета», карта другого своего банка в деталях перевода.
OWN_MOVE = re.compile(
    r"депозит|между\s*(?:своими\s*)?счетами|на\s*сво[йи]\s*счет|со?\s*сво(?:его|их)\s*счет|собственн|"
    r"kaspi\s*gold|kaspi\s*депозит|forte\s*bank|fortebank|\bown\s*account",
    re.IGNORECASE,
)


def place_for(merchant):
    """Название места по получателю: известное написание — красиво, QR — без места, иначе как есть."""
    if not merchant or NO_PLACE.search(merchant):
        return ""
    for pattern, name in PLACES:
        if pattern.search(merchant):
            return name
    return merchant[:100]
