"""Образцы чеков для тестов: ДНС (Казахстан), магазин предпринимателя (Россия), Lidl (Германия).

Источник — пересказ трёх фотографий; сами фото в репозитории не хранятся, и сверить
с ними эти данные нельзя.

**ДНС.** Реквизиты юрлица, номера, суммы и фискальные данные — как в пересказе.
Казахский вариант адреса и названия позиции на фото есть, но в пересказ не попал:
значения ``kk`` здесь восстановлены, а не списаны с чека.

**Магазин в России.** ФИО и ИНН предпринимателя и ФИО кассира ВЫМЫШЛЕНЫ: данные
физических лиц в репозиторий не переносятся. Поэтому продавец образца не совпадает
с продавцом настоящего чека. Остальное (адрес, фискальные реквизиты, позиции,
суммы) — как в пересказе. Секунды времени покупки не напечатаны и приняты за ноль.

**Lidl — СИНТЕТИЧЕСКИЕ ДАННЫЕ.** Полного состава позиций шести чеков в пересказе
нет, а перечисленные позиции не дают в сумме напечатанный итог 54,43. Шесть чеков
собраны из описанных фрагментов (названия, цены, формат строк с количеством, весом,
залогом, возвратом тары и скидками), а итоги, сумма скидок и таблица налогов
пересчитаны под этот состав и с настоящими не совпадают. Кроме состава:

- С чека взяты только даты, магазин, UST-ID, серийный номер кассы и — для чека
  29.06 — номер ``475298/12`` и номер TSE-транзакции ``427161``. Номера остальных
  пяти чеков, их TSE-транзакции, все счётчики подписи и все Prüfwert выдуманы;
  минуты, прочитанные как «11:5x» и «15:4x», приняты за 11:50 и 15:40; начало и
  конец транзакции приняты равными времени чека.
- ДОПУЩЕНИЕ ДЛЯ ТЕСТА ИСТОРИИ ЦЕН: «GQ EgSB H-Milch 1,5%» стоит 1,05 в пяти чеках
  и 1,09 в чеке 01.10. Подорожания в пересказе нет — оно введено, чтобы ряд цен
  не был константой и история цен проверялась по существу.
- «Rabatt Snack -0,20» привязана к «Geflügelfrikadell.»: под какой строкой она
  напечатана, в пересказе не сказано.
- «CocaCola Zero» не включена: её цена не прочитана. Залог после напитка показан
  на «Fanta».
- ``legal_name`` продавца — «Lidl»: юрлицо на фото не прочитано.

**Каталог** (категории, обобщённые продукты, товары, сопоставления) заведён для
проверки сопоставления и нормализованной цены; фасовка товара указана только там,
где она напечатана в названии на чеке.

Данные оплаты картой (слип терминала, маска карты, RRN, код авторизации) в образцы
не входят. Способ оплаты записан в ``extra`` одного чека как пример поля «прочее».
"""

from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from django.db import transaction

from catalog.models import Brand, Category, GenericProduct, Product
from catalog.units import BaseUnit, Unit
from receipts.dedup import build_fiscal_key, find_alias, name_key
from receipts.models import ProductAlias, Receipt, ReceiptDiscount, ReceiptLine, ReceiptTax
from stores.models import Merchant, Store, TaxRate
from stores.normalize import address_key

D = Decimal
PRODUCT = ReceiptLine.Kind.PRODUCT
DEPOSIT = ReceiptLine.Kind.DEPOSIT
DEPOSIT_RETURN = ReceiptLine.Kind.DEPOSIT_RETURN


def line(raw_name, amount, tax_code="", **fields):
    """Строка образца: поля ReceiptLine плюс ``deposit_of`` (позиция товара, к которому
    относится залог) и ``discounts`` (список ``(название, сумма)`` под этой строкой).

    Без ``quantity`` и ``unit_price`` это одна штука по цене, равной сумме.
    """
    amount = D(amount)
    fields.setdefault("quantity", D("1"))
    fields.setdefault("unit_price", amount)
    return {"raw_name": raw_name, "amount": amount, "tax_code": tax_code, **fields}


def tax(code, net, tax_amount, gross):
    return {"tax_code": code, "net": D(net), "tax": D(tax_amount), "gross": D(gross)}


def local(timezone, year, month, day, hour, minute, second=0):
    return datetime(year, month, day, hour, minute, second, tzinfo=ZoneInfo(timezone))


# --- Чек 1: ДНС, Казахстан ---------------------------------------------------------

DNS_MERCHANT = {
    "country_id": "KZ",
    "legal_name": "ТОО «ДНС КАЗАХСТАН»",
    "brand_name": "DNS",
    "tax_id_type": Merchant.TaxIdType.BIN,
    "tax_id": "210140004940",
    "extra": {
        "legal_name_kk": "«DNS QAZAQSTAN (ДНС КАЗАХСТАН)» ЖШС",
        "vat_certificate": {"series": "62001", "number": "1025833"},
    },
}
DNS_STORE = {
    "country_id": "KZ",
    "address_raw": "г. Алматы, Алатауский район, мкр. Самғау, ул. Ырысты, д. 46/4",
    "address_i18n": {
        "kk": "Алматы қ., Алатау ауданы, Самғау ш/а, Ырысты көш., 46/4 үй",
        "ru": "г. Алматы, Алатауский район, мкр. Самғау, ул. Ырысты, д. 46/4",
    },
    "region": "Алатауский район",
    "city": "Алматы",
    "street": "мкр. Самғау, ул. Ырысты",
    "house": "46/4",
    "timezone": "Asia/Almaty",
}
DNS_SSD_NAME = "SSD M.2 PCIe 2 TB Samsung 990 PRO, MZ-V9P2T0BW, NVMe 1.4 (Гарантия - 12 мес.)"
DNS_KZ = {
    "currency": "KZT",
    "tax_rates": {"": D("16.00")},
    "receipt": {
        "operation": Receipt.Operation.SALE,
        "purchased_at": local("Asia/Almaty", 2026, 9, 11, 16, 15, 44),
        "purchased_on": date(2026, 9, 11),
        "receipt_number": "5",
        "shift_number": "139",
        "fiscal": {
            "fp": "1443445223777",
            "rnm": "601004679109",
            "znm": "SWK00524382",
            "ofd": "ТОО «Smartcontract» (WOFD)",
            "document": "К-00132661",
        },
        "total": D("189490.00"),
        "extra": {"check_site": "consumer.wofd.kz"},
    },
    "lines": [
        line(
            DNS_SSD_NAME, "189490.00",
            name_i18n={
                "kk": "SSD M.2 PCIe 2 TB Samsung 990 PRO, MZ-V9P2T0BW, NVMe 1.4 (Кепілдік - 12 ай)",
                "ru": DNS_SSD_NAME,
            },
            # Правило по умолчанию: 13-значный код — штрихкод, второй — артикул магазина.
            store_item_code="5412016", barcode="0200200605191",
            tax_amount=D("26136.55"),  # 189 490 × 16 / 116
        ),
    ],
    "taxes": [tax("", "163353.45", "26136.55", "189490.00")],  # нетто вычислено
}

# --- Чек 2: магазин предпринимателя, Россия ----------------------------------------

# ФИО и ИНН вымышлены; контрольные разряды ИНН намеренно неверны.
SHOP_MERCHANT = {
    "country_id": "RU",
    "legal_name": "ИП Соколов Д.В.",
    "tax_id_type": Merchant.TaxIdType.INN,
    "tax_id": "420500000000",
    "extra": {
        "full_name": "Индивидуальный предприниматель Соколов Дмитрий Викторович",
        "tax_system": "Патент",
    },
}
SHOP_STORE = {
    "country_id": "RU",
    "name": "Магазин «Елена»",
    "address_raw": (
        "42 - Кемеровская область - Кузбасс, г.о. Кемеровский, 650003, Кемерово г., Ленинградский пр-т, 40а"
    ),
    "postal_code": "650003",
    "region": "Кемеровская область - Кузбасс",
    "city": "Кемерово",
    "street": "Ленинградский пр-т",
    "house": "40а",
    "timezone": "Asia/Novokuznetsk",
}
SHOP_MILK_NAME = "Молоко Фермерское 2,5% 850мл пэт"
SHOP_RU = {
    "currency": "RUB",
    "tax_rates": {"": None},  # «без НДС» — не то же самое, что ставка 0%
    "receipt": {
        "operation": Receipt.Operation.SALE,  # «ПРИХОД»
        # В шапке 13:52, в фискальном блоке 13:58: при расхождении берётся фискальное время.
        "purchased_at": local("Asia/Novokuznetsk", 2026, 9, 28, 13, 58),
        "purchased_on": date(2026, 9, 28),
        "receipt_number": "2968",
        "register_code": "1",
        "fiscal": {
            "rn_kkt": "0008478541006984",
            "zn_kkt": "0554330012114239",
            "fn": "7382440900170413",
            "fd": "72473",
            "fp": "4256906086",
        },
        "total": D("670.00"),
        "extra": {"cashier": "Иванова А.А.", "header_time": "13:52", "payment": "безналичными"},
    },
    "lines": [
        line(SHOP_MILK_NAME, "111.00", store_item_code="3079", is_marked=True, extra={"subject": "ТОВАР"}),
        line("Пряники Яшкино Мятные 350гр", "98.00", store_item_code="1346", extra={"subject": "ТОВАР"}),
        line(
            "Напиток энергет. BURN Цитрус без сахара 0,449л", "142.00",
            store_item_code="2489", is_marked=True, extra={"subject": "ТОВАР"},
        ),
        line(
            "Парламент Aqua Blue", "319.00",
            store_item_code="326", is_marked=True, is_excise=True, extra={"subject": "ПОДАКЦИЗНЫЙ ТОВАР"},
        ),
    ],
    "taxes": [tax("", "670.00", "0.00", "670.00")],
}

# --- Чек 3: Lidl, Германия — шесть синтетических чеков одного магазина --------------

LIDL_MERCHANT = {
    "country_id": "DE",
    "legal_name": "Lidl",
    "brand_name": "Lidl",
    "tax_id_type": Merchant.TaxIdType.VAT_ID,
    "tax_id": "DE813389027",
}
LIDL_STORE = {
    "country_id": "DE",
    "branch_code": "5597",
    "address_raw": "Kemptener Straße 17, 88131 Lindau",
    "postal_code": "88131",
    "city": "Lindau",
    "street": "Kemptener Straße",
    "house": "17",
    "timezone": "Europe/Berlin",
}
LIDL_REGISTER_SERIAL = "LDL-000-5597-85"
LIDL_TAX_RATES = {"A": D("7.00"), "B": D("19.00")}  # еда — A, напитки и их залог — B

MILK = "GQ EgSB H-Milch 1,5%"
KEFIR = "Müller Kalinka Kefir"
BARILLA = "Barilla Spaghetti"
ONION = "Zwiebeln weiß"
PIZZA_HOT_DOG = "Pizza Hot Dog"
PIZZA_SPEZIAL = "Steinof. PizzaSpezial"
FRIKADELLEN = "Geflügelfrikadell."
QUARK = "Speisequark 0%"
LEERDAMMER = "Leerdammer Original"
PFAND_B = "Pfand 0,25 M"
PFAND_A = "Pfand 0,25 7% M"
PFAND_RETURN = "Pfandrückgabe"


def _lidl(day, month, hour, minute, number, tse, counter, total, lines, taxes, discount_total="0.00"):
    at = local("Europe/Berlin", 2026, month, day, hour, minute)
    return {
        "currency": "EUR",
        "tax_rates": LIDL_TAX_RATES,
        "receipt": {
            "operation": Receipt.Operation.SALE,
            "purchased_at": at,
            "purchased_on": at.date(),
            "receipt_number": number,
            "fiscal": {
                "tse_transaction": tse,
                "register_serial": LIDL_REGISTER_SERIAL,
                "signature_counter": counter,
                "transaction_start": at.isoformat(),
                "transaction_end": at.isoformat(),
                "signature": f"synthetic-{tse}",
            },
            "total": D(total),
            "discount_total": D(discount_total),
        },
        "lines": lines,
        "taxes": taxes,
    }


LIDL_DE = [
    # 02.06: залог после напитка, ставка B.
    _lidl(
        2, 6, 11, 50, "468911/12", "401873", "803912", "7.27",
        [
            line(PIZZA_HOT_DOG, "3.99", "A"),
            line(MILK, "1.05", "A"),
            line("Fanta Orange", "0.99", "B"),
            line(PFAND_B, "0.25", "B", kind=DEPOSIT, deposit_of=3),
            line(QUARK, "0.99", "A"),
        ],
        [tax("A", "5.64", "0.39", "6.03"), tax("B", "1.04", "0.20", "1.24")],
    ),
    # 09.06: количество 1,29 x 2, залог после кефира (ставка A, количество 2), весовой товар.
    _lidl(
        9, 6, 18, 36, "470544/12", "409412", "818990", "8.50",
        [
            line(PIZZA_SPEZIAL, "3.49", "A"),
            line(KEFIR, "2.58", "A", quantity=D("2"), unit_price=D("1.29")),
            line(PFAND_A, "0.50", "A", kind=DEPOSIT, deposit_of=2, quantity=D("2"), unit_price=D("0.25")),
            line(MILK, "1.05", "A"),
            # 0,294 kg x 2,99 EUR/kg = 0,87906, на чеке 0,88.
            line(ONION, "0.88", "A", quantity=D("0.294"), unit=Unit.KG, unit_price=D("2.99")),
        ],
        [tax("A", "7.94", "0.56", "8.50")],
    ),
    # 17.06: возврат тары отрицательной строкой.
    _lidl(
        17, 6, 15, 40, "472630/12", "416950", "834066", "6.27",
        [
            line(MILK, "1.05", "A"),
            line(BARILLA, "1.99", "A"),
            line(FRIKADELLEN, "2.99", "A"),
            line("Fanta Exotic", "0.99", "B"),
            line(PFAND_B, "0.25", "B", kind=DEPOSIT, deposit_of=4),
            line(PFAND_RETURN, "-1.00", "B", kind=DEPOSIT_RETURN, quantity=D("-4"), unit_price=D("0.25")),
        ],
        [tax("A", "5.64", "0.39", "6.03"), tax("B", "0.20", "0.04", "0.24")],
    ),
    # 29.06: скидки на позиции, 0,20 + 2,00 + 0,20 = 2,40. Номер чека и TSE — с фото.
    _lidl(
        29, 6, 16, 2, "475298/12", "427161", "854488", "15.28",
        [
            line(PIZZA_HOT_DOG, "3.99", "A"),
            line(LEERDAMMER, "2.89", "A", discounts=[("Preisvorteil", "0.20")]),
            line(BARILLA, "3.98", "A", quantity=D("2"), unit_price=D("1.99"), discounts=[("Preisvorteil", "2.00")]),
            line(FRIKADELLEN, "2.99", "A", discounts=[("Rabatt Snack", "0.20")]),
            line(MILK, "1.05", "A"),
            line(KEFIR, "1.29", "A"),
            line(PFAND_A, "0.25", "A", kind=DEPOSIT, deposit_of=6),
            line("Fanta Orange", "0.99", "B"),
            line(PFAND_B, "0.25", "B", kind=DEPOSIT, deposit_of=8),
        ],
        [tax("A", "13.12", "0.92", "14.04"), tax("B", "1.04", "0.20", "1.24")],
        discount_total="2.40",
    ),
    # 06.07: два возврата тары по разным ставкам, итог по ставке B отрицательный.
    _lidl(
        6, 7, 16, 28, "477015/12", "433708", "867582", "2.33",
        [
            line(MILK, "2.10", "A", quantity=D("2"), unit_price=D("1.05")),
            line(QUARK, "0.99", "A"),
            line(PIZZA_SPEZIAL, "3.49", "A"),
            line(PFAND_RETURN, "-3.00", "B", kind=DEPOSIT_RETURN, quantity=D("-12"), unit_price=D("0.25")),
            line(PFAND_RETURN, "-1.25", "A", kind=DEPOSIT_RETURN, quantity=D("-5"), unit_price=D("0.25")),
        ],
        [tax("A", "4.98", "0.35", "5.33"), tax("B", "-2.52", "-0.48", "-3.00")],
    ),
    # 01.10: цена молока 1,09 вместо 1,05 — допущение для теста, см. docstring модуля.
    _lidl(
        1, 10, 18, 59, "498127/12", "512336", "1024840", "10.15",
        [
            line(MILK, "1.09", "A"),
            line(PIZZA_HOT_DOG, "3.99", "A"),
            line(KEFIR, "2.58", "A", quantity=D("2"), unit_price=D("1.29")),
            line(PFAND_A, "0.50", "A", kind=DEPOSIT, deposit_of=3, quantity=D("2"), unit_price=D("0.25")),
            line(BARILLA, "1.99", "A"),
        ],
        [tax("A", "9.49", "0.66", "10.15")],
    ),
]

# --- Сохранение --------------------------------------------------------------------


def _merchant(fields):
    fields = dict(fields)
    merchant, _ = Merchant.objects.get_or_create(
        country_id=fields.pop("country_id"), tax_id=fields.pop("tax_id"), defaults=fields,
    )
    return merchant


def _store(merchant, fields):
    key = address_key(fields["address_raw"], fields.get("address_i18n"))
    store, _ = Store.objects.get_or_create(merchant=merchant, address_key=key, defaults=fields)
    return store


def dns_store():
    return _store(_merchant(DNS_MERCHANT), DNS_STORE)


def shop_store():
    return _store(_merchant(SHOP_MERCHANT), SHOP_STORE)


def lidl_store():
    return _store(_merchant(LIDL_MERCHANT), LIDL_STORE)


def _alias(store, product, raw_name, store_item_code=""):
    ProductAlias.objects.get_or_create(
        merchant=store.merchant, name_key=name_key(raw_name), store_item_code=store_item_code,
        defaults={"product": product, "raw_name": raw_name},
    )


def save_catalog():
    """Каталог и сопоставления образцов; повторный вызов ничего не дублирует.

    Возвращает товары: ``shop_milk``, ``lidl_milk`` (один обобщённый продукт «Молоко»)
    и ``ssd``. Остальные позиции образцов остаются несопоставленными.
    """
    food, _ = Category.objects.get_or_create(name="Продукты питания", parent=None)
    dairy, _ = Category.objects.get_or_create(name="Молочные продукты", parent=food)
    electronics, _ = Category.objects.get_or_create(name="Электроника", parent=None)
    milk, _ = GenericProduct.objects.get_or_create(
        name="Молоко", defaults={"category": dairy, "base_unit": BaseUnit.L},
    )
    ssd_generic, _ = GenericProduct.objects.get_or_create(
        name="SSD-накопитель", defaults={"category": electronics, "base_unit": BaseUnit.PCS},
    )
    samsung, _ = Brand.objects.get_or_create(name="Samsung")

    shop_milk, _ = Product.objects.get_or_create(
        brand=None, name=SHOP_MILK_NAME, package_quantity=D("850"), package_unit=Unit.ML,
        defaults={"generic": milk, "attributes": {"fat_percent": 2.5, "packaging": "пэт"}},
    )
    # Фасовка на чеке Lidl не напечатана, поэтому не задана: нормализованной цены нет.
    lidl_milk, _ = Product.objects.get_or_create(
        brand=None, name=MILK, package_quantity=None, package_unit="",
        defaults={"generic": milk, "attributes": {"fat_percent": 1.5}},
    )
    ssd, _ = Product.objects.get_or_create(
        brand=samsung, name="SSD Samsung 990 PRO 2 TB", package_quantity=None, package_unit="",
        defaults={
            "generic": ssd_generic, "model": "MZ-V9P2T0BW",
            "attributes": {"capacity_tb": 2, "form_factor": "M.2", "interface": "PCIe, NVMe 1.4"},
        },
    )

    _alias(shop_store(), shop_milk, SHOP_MILK_NAME, "3079")
    _alias(lidl_store(), lidl_milk, MILK)
    _alias(dns_store(), ssd, DNS_SSD_NAME, "5412016")
    return {"shop_milk": shop_milk, "lidl_milk": lidl_milk, "ssd": ssd}


def _tax_rate(store, sample, code):
    rate = sample["tax_rates"][code]
    return TaxRate.objects.get(country_id=store.country_id, rate=rate)


@transaction.atomic
def save_receipt(store, sample):
    """Сохраняет образец целиком: чек, строки, скидки, итоги по ставкам.

    ``fiscal_key`` собирается из ``fiscal``, товар строки ищется по сопоставлениям
    продавца. Дубликат отклоняет БД — ``IntegrityError``, от чека ничего не остаётся.
    """
    fields = sample["receipt"]
    receipt = Receipt.objects.create(
        store=store, currency_id=sample["currency"],
        fiscal_key=build_fiscal_key(store.country_id, fields.get("fiscal")), **fields,
    )
    saved = {}
    discount_position = 0
    for position, spec in enumerate(sample["lines"], start=1):
        spec = dict(spec)
        spec.setdefault("kind", PRODUCT)
        discounts = [(name, D(amount)) for name, amount in spec.pop("discounts", ())]
        deposit_of = spec.pop("deposit_of", None)
        product = None
        if spec["kind"] == PRODUCT:
            alias = find_alias(store.merchant, spec["raw_name"], spec.get("store_item_code", ""))
            product = alias and alias.product
        saved[position] = ReceiptLine.objects.create(
            receipt=receipt, position=position, product=product,
            parent=saved[deposit_of] if deposit_of else None,
            tax_rate=_tax_rate(store, sample, spec["tax_code"]),
            discount_amount=sum((amount for _, amount in discounts), D("0.00")),
            **spec,
        )
        for name, amount in discounts:
            discount_position += 1
            ReceiptDiscount.objects.create(
                receipt=receipt, line=saved[position], position=discount_position, name=name, amount=amount,
            )
    for spec in sample["taxes"]:
        ReceiptTax.objects.create(receipt=receipt, tax_rate=_tax_rate(store, sample, spec["tax_code"]), **spec)
    return receipt


def save_dns_kz():
    save_catalog()
    return save_receipt(dns_store(), DNS_KZ)


def save_shop_ru():
    save_catalog()
    return save_receipt(shop_store(), SHOP_RU)


def save_lidl_de():
    """Шесть чеков одного магазина, по возрастанию даты."""
    save_catalog()
    store = lidl_store()
    return [save_receipt(store, sample) for sample in LIDL_DE]
