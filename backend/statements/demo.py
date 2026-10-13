"""Вымышленные выписки для тестов и демо: текст в формате Kaspi Gold и ForteBank и PDF с этим текстом.

Настоящих выписок в репозитории нет и быть не должно: имена, суммы и получатели здесь
придуманы. ``pdf_bytes`` собирает минимальный PDF без новых зависимостей: стандартный
шрифт с собственной однобайтовой кодировкой и картой ``ToUnicode``, чтобы PDFium вынул
кириллицу и «₸» ровно так, как из выписки банка.
"""
from datetime import date, timedelta

LINES_PER_PAGE = 60


def _cmap(codes):
    blocks = []
    pairs = sorted(codes.items(), key=lambda item: item[1])
    for start in range(0, len(pairs), 100):
        chunk = pairs[start:start + 100]
        body = "\n".join(f"<{code:02X}> <{ord(char):04X}>" for char, code in chunk)
        blocks.append(f"{len(chunk)} beginbfchar\n{body}\nendbfchar")
    return (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n"
        "/CMapName /Checkist-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<01> <FF>\nendcodespacerange\n"
        + "\n".join(blocks)
        + "\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n"
    )


def pdf_bytes(lines, *, lines_per_page=LINES_PER_PAGE):
    """PDF с текстом ``lines`` (по строке на линию, ``lines_per_page`` на страницу); не больше 255 разных знаков."""
    chars = sorted({char for line in lines for char in line})
    if len(chars) > 255:
        raise ValueError("Too many distinct characters for one font.")
    codes = {char: index for index, char in enumerate(chars, start=1)}
    pages = [lines[start:start + lines_per_page] for start in range(0, len(lines), lines_per_page)] or [[]]
    objects = {}
    font, cmap = 3, 4
    kids = []
    next_id = 5
    for page_lines in pages:
        content = ["BT", "/F1 9 Tf", "11 TL", "30 810 Td"]
        for line in page_lines:
            content.append("<" + "".join(f"{codes[char]:02X}" for char in line) + "> Tj T*")
        content.append("ET")
        stream = "\n".join(content).encode("ascii")
        page_id, content_id = next_id, next_id + 1
        next_id += 2
        kids.append(page_id)
        objects[page_id] = (f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "
                            f"/Resources << /Font << /F1 {font} 0 R >> >> /Contents {content_id} 0 R >>").encode("ascii")
        objects[content_id] = b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"\nendstream"
    widths = " ".join("500" for _ in range(255))
    objects[1] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[2] = f"<< /Type /Pages /Kids [{' '.join(f'{kid} 0 R' for kid in kids)}] /Count {len(kids)} >>".encode("ascii")
    objects[font] = (f"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 1 /LastChar 255 "
                     f"/Widths [{widths}] /ToUnicode {cmap} 0 R >>").encode("ascii")
    cmap_stream = _cmap(codes).encode("ascii")
    objects[cmap] = b"<< /Length %d >>\nstream\n" % len(cmap_stream) + cmap_stream + b"\nendstream"
    output = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = {}
    for number in sorted(objects):
        offsets[number] = len(output)
        output += b"%d 0 obj\n" % number + objects[number] + b"\nendobj\n"
    xref = len(output)
    count = max(objects) + 1
    output += b"xref\n0 %d\n0000000000 65535 f \n" % count
    for number in range(1, count):
        output += b"%010d 00000 n \n" % offsets[number]
    output += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (count, xref)
    return bytes(output)


def _kaspi_money(amount):
    whole, cents = f"{amount:.2f}".split(".")
    groups = []
    while whole:
        groups.insert(0, whole[-3:])
        whole = whole[:-3]
    return " ".join(groups) + "," + cents


def kaspi_line(day, amount, operation, details, foreign=None):
    """Строка Kaspi Gold: ``amount`` со знаком (отрицательная — расход)."""
    sign = "-" if amount < 0 else "+"
    extra = f" ({foreign})" if foreign else ""
    return f"{day:%d.%m.%y} {sign} {_kaspi_money(abs(amount))} ₸{extra} {operation} {details}"


def forte_line(day, amount, operation, details, currency="KZT"):
    return f"{day:%d.%m.%Y} {amount:.2f} {currency} {operation} {details}"


def kaspi_header(start, end):
    return [
        "АО «Kaspi Bank», kaspi.kz",
        f"ВЫПИСКА по Kaspi Gold за период с {start:%d.%m.%y} по {end:%d.%m.%y}",
        "Номер карты: *0000",
        "Дата Сумма Операция Детали",
    ]


def forte_header(start, end):
    return [
        "АО «ForteBank»",
        f"Выписка по счету за период {start:%d.%m.%Y} - {end:%d.%m.%Y}",
        "Дата Сумма Валюта Описание операции",
    ]


def demo_kaspi_lines(end, duplicates=()):
    """Вымышленный месяц Kaspi Gold до ``end``: узнаваемые сети, незнакомые места, переводы, поступления, возврат.

    ``duplicates`` — ``(дата, сумма, место)`` уже внесённых трат: такие строки попадут в черновик дублями.
    """
    day = lambda back: end - timedelta(days=back)  # noqa: E731
    start = day(29)
    rows = [
        kaspi_line(day(28), -18450, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
        kaspi_line(day(27), -1450, "Покупка", "YANDEX.GO"),
        kaspi_line(day(26), -2990, "Покупка", "YouTube Premium", foreign="-6,49 USD"),
        kaspi_line(day(25), -3200, "Покупка", "ИП Кофейня Зерно"),
        kaspi_line(day(24), -12800, "Покупка", 'ТОО "Фикус и Ко"'),
        kaspi_line(day(23), -50000, "Перевод", "Мария К."),
        kaspi_line(day(22), -220000, "Перевод", "Олег Б."),
        kaspi_line(day(21), -20000, "Снятие", "Банкомат Kaspi"),
        kaspi_line(day(20), 150000, "Пополнение", "С Kaspi Депозита"),
        kaspi_line(day(19), 35000, "Перевод", "Дмитрий С."),
        kaspi_line(day(18), -6400, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
        kaspi_line(day(18), 1200, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
        kaspi_line(day(16), -4700, "Покупка", "ИП Аптека Здоровье"),
        kaspi_line(day(14), -8900, "Покупка", "Студия йоги Лотос"),
        kaspi_line(day(12), -990, "Разное", "Комиссия за перевод"),
        kaspi_line(day(10), 412, "Разное", "Kaspi Бонус: кэшбэк"),
        kaspi_line(day(9), -2300, "Покупка", "YANDEX.GO"),
        kaspi_line(day(7), -15600, "Покупка", "Галерея подарков Сувенир"),
        kaspi_line(day(5), -9100, "Покупка", 'ТОО "MAGNUM CASH&CARRY"'),
    ]
    for when, amount, place in duplicates:
        rows.append(kaspi_line(when, -amount, "Покупка", place))
    return kaspi_header(start, end) + rows + ["Итого расходов:"]


def demo_forte_lines(end):
    day = lambda back: end - timedelta(days=back)  # noqa: E731
    start = day(20)
    return forte_header(start, end) + [
        forte_line(day(19), -2590, "Покупка", "MAGNUM AKSAI, ALMATY, KZ, MCC: 5411"),
        forte_line(day(18), -6700, "Платеж", "Beeline Казахстан, PAYMENT_ID=1a2b3c4d"),
        forte_line(day(17), 670, "Платеж", "Beeline Казахстан, PAYMENT_ID=1a2b3c4d"),
        forte_line(day(15), -45000, "Перевод", "между своими счетами"),
        forte_line(day(12), -3100, "Покупка", "TOO CAFE LUNA, ALMATY, KZ,"),
        "MCC: 5814",
        forte_line(day(10), -12000, "Покупка", "OZON, MOSCOW, RU, MCC: 5964"),
        forte_line(day(10), 2000, "Возврат", "OZON, MOSCOW, RU"),
        forte_line(day(5), 250000, "Пополнение счета", "Зарплата ТОО Ромашка"),
    ]
