"""Разбор текста выписок Kaspi Gold и ForteBank и извлечение текста из PDF. Только вымышленные строки."""
import time
from datetime import date
from decimal import Decimal
from unittest.mock import patch

from django.test import SimpleTestCase

from statements import demo, extract, parsers
from statements.extract import StatementError

DAY = date(2026, 9, 12)


class DetectBankTests(SimpleTestCase):
    def test_kaspi_and_forte_by_their_header(self):
        self.assertEqual(parsers.detect_bank("\n".join(demo.kaspi_header(DAY, DAY))), parsers.KASPI)
        self.assertEqual(parsers.detect_bank("\n".join(demo.forte_header(DAY, DAY))), parsers.FORTE)

    def test_the_first_mark_decides(self):
        # A transfer to a ForteBank card inside a Kaspi Gold statement does not change the bank.
        text = "\n".join(demo.kaspi_header(DAY, DAY) + [demo.kaspi_line(DAY, -5000, "Перевод", "На карту ForteBank*0000")])
        self.assertEqual(parsers.detect_bank(text), parsers.KASPI)

    def test_other_and_unknown_banks_are_refused(self):
        for text in ("АО «Halyk Bank»\nВыписка по карте\n12.09.2026 -2590.00 KZT Покупка MAGNUM",
                     "Jusan Bank\nВыписка", "Просто текст без банка", ""):
            with self.subTest(text=text[:20]), self.assertRaises(parsers.UnsupportedBank):
                parsers.detect_bank(text)


class KaspiTests(SimpleTestCase):
    def test_rows_signs_amounts_and_merchants(self):
        text = "\n".join(demo.kaspi_header(DAY, DAY) + [
            "12.09.26 - 2 590,00 ₸ Покупка ТОО \"Магазин у дома\"",
            "13.09.26\u00a0-\u00a01\u202f234 567,89 ₸ (-10,00 USD) Покупка APPLE.COM/BILL",
            "14.09.26 + 15 000,00 ₸ Пополнение С Kaspi Депозита",
            "15.09.26 - 990,00 ₸ Разное Комиссия за перевод",
            "16.09.26 - 50 000,00 ₸ Перевод Мария К.",
            "Итого расходов: 1 288 157,89 ₸",
            "31.02.26 - 100,00 ₸ Покупка Несуществующий день",
        ])
        rows = parsers.parse_kaspi(text)
        self.assertEqual(len(rows), 5)
        self.assertEqual(rows[0], parsers.ParsedRow(DAY, Decimal("-2590.00"), "KZT", "Покупка",
                                                    'ТОО "Магазин у дома"', "Магазин у дома"))
        self.assertEqual((rows[1].amount, rows[1].merchant), (Decimal("-1234567.89"), "APPLE.COM/BILL"))
        self.assertEqual((rows[2].amount, rows[2].operation), (Decimal("15000.00"), "Пополнение"))
        self.assertEqual((rows[3].operation, rows[3].merchant), ("Разное", "Комиссия за перевод"))
        self.assertEqual((rows[4].operation, rows[4].merchant, rows[4].date), ("Перевод", "Мария К.", date(2026, 9, 16)))

    def test_header_and_blank_lines_give_no_rows(self):
        self.assertEqual(parsers.parse_kaspi("\n".join(demo.kaspi_header(DAY, DAY))), [])


class ForteTests(SimpleTestCase):
    def test_rows_with_continuation_mcc_and_payment_id(self):
        text = "\n".join(demo.forte_header(DAY, DAY) + [
            "12.09.2026 -2590.00 KZT Покупка MAGNUM AKSAI, ALMATY, KZ, MCC: 5411",
            "13.09.2026 -3100.00 KZT (-6.50 USD) Покупка TOO CAFE LUNA, ALMATY,",
            "KZ, MCC: 5814",
            "Страница 1 из 2",
            "14.09.2026 -6700.00 KZT Платеж Beeline Казахстан, PAYMENT_ID=1a2b3c4d5e",
            "15.09.2026 -45 000.00 KZT Перевод между своими счетами",
            "16.09.2026 250000.00 KZT Пополнение счета Зарплата",
            "17.09.2026 12.00 USD Возврат OZON, MOSCOW, RU",
        ])
        rows = parsers.parse_forte(text)
        self.assertEqual(len(rows), 6)
        self.assertEqual((rows[0].merchant, rows[0].mcc, rows[0].amount), ("MAGNUM AKSAI", "5411", Decimal("-2590.00")))
        self.assertEqual((rows[1].merchant, rows[1].mcc, rows[1].operation), ("CAFE LUNA", "5814", "Покупка"))
        self.assertNotIn("Страница", rows[1].details)
        self.assertEqual((rows[2].merchant, rows[2].payment_id), ("Beeline Казахстан", "1a2b3c4d"))
        self.assertEqual((rows[3].amount, rows[3].operation, rows[3].merchant),
                         (Decimal("-45000.00"), "Перевод", "между своими счетами"))
        self.assertEqual((rows[4].operation, rows[4].amount), ("Пополнение счета", Decimal("250000.00")))
        self.assertEqual((rows[5].currency, rows[5].operation, rows[5].merchant), ("USD", "Возврат", "OZON"))

    def test_parse_picks_the_bank(self):
        bank, rows = parsers.parse("\n".join(demo.demo_forte_lines(DAY)))
        self.assertEqual((bank, len(rows)), (parsers.FORTE, 8))


class HostileTextTests(SimpleTestCase):
    """A crafted PDF must not hold the web process: linear patterns, capped lines, text and rows."""

    LONG = "1 " * 50_000  # 100 000 characters of digits and spaces, no currency after them
    # A digit and a run of spaces: the former patterns backtracked quadratically here (20 000 spaces — 0,7 s and
    # 2 s, 100 000 — tens of seconds).
    SPACES = "1" + " " * 100_000

    def assertFast(self, call):
        started = time.perf_counter()
        call()
        self.assertLess(time.perf_counter() - started, 0.5)

    def test_amount_patterns_are_linear_on_digits_and_spaces(self):
        self.assertFast(lambda: self.assertIsNone(parsers._KASPI_ROW.match("12.09.26 - " + self.LONG)))
        self.assertFast(lambda: self.assertIsNone(parsers._FORTE_ROW.match("12.09.2026 -" + self.LONG)))
        self.assertFast(lambda: self.assertIsNone(parsers._KASPI_ROW.match("12.09.26 - " + "1" * 100_000)))
        self.assertFast(lambda: self.assertIsNone(parsers._KASPI_ROW.match("12.09.26 - " + self.SPACES)))
        self.assertFast(lambda: self.assertIsNone(parsers._FORTE_ROW.match("12.09.2026 -" + self.SPACES)))

    def test_long_lines_are_skipped_and_the_statement_still_parses(self):
        for header, line, parse in ((demo.kaspi_header(DAY, DAY), "12.09.26 - ", parsers.parse_kaspi),
                                    (demo.forte_header(DAY, DAY), "12.09.2026 -", parsers.parse_forte)):
            text = "\n".join(header + [line + self.LONG, line + self.SPACES + "₸ Покупка X"] * 5)
            self.assertFast(lambda: self.assertEqual(parse(text), []))
        rows = parsers.parse_kaspi("\n".join([demo.kaspi_line(DAY, -100, "Покупка", "Магазин"), "x" * (parsers.MAX_LINE + 1)]))
        self.assertEqual(len(rows), 1)

    def test_too_much_text_or_rows_is_refused(self):
        with self.assertRaises(parsers.TooLarge):
            parsers.parse("Kaspi Gold\n" + "x" * parsers.MAX_TEXT)
        line = demo.kaspi_line(DAY, -100, "Покупка", "Магазин")
        with patch.object(parsers, "MAX_ROWS", 3), self.assertRaises(parsers.TooLarge):
            parsers.parse("\n".join(demo.kaspi_header(DAY, DAY) + [line] * 4))
        with patch.object(parsers, "MAX_ROWS", 3), self.assertRaises(parsers.TooLarge):
            parsers.parse("\n".join(demo.forte_header(DAY, DAY) + [demo.forte_line(DAY, -100, "Покупка", "X")] * 4))
        # A row continues on at most MAX_CONTINUATION lines.
        text = "\n".join(demo.forte_header(DAY, DAY) + [demo.forte_line(DAY, -100, "Покупка", "A,")] + ["продолжение"] * 50)
        self.assertLessEqual(parsers.parse_forte(text)[0].details.count("продолжение"), parsers.MAX_CONTINUATION)


class ExtractTests(SimpleTestCase):
    """The real extraction path: a child process with PDFium, on a minimal synthetic PDF."""

    def test_synthetic_pdf_gives_the_text_back(self):
        lines = demo.demo_kaspi_lines(DAY)
        text = extract.pdf_text(demo.pdf_bytes(lines))
        bank, rows = parsers.parse(text)
        self.assertEqual(bank, parsers.KASPI)
        self.assertEqual(len(rows), 20)
        self.assertEqual((rows[0].merchant, rows[0].amount), ("MAGNUM CASH&CARRY", Decimal("-18450.00")))
        self.assertIn("₸", text)

    def test_pages_are_joined(self):
        lines = demo.demo_forte_lines(DAY)
        text = extract.pdf_text(demo.pdf_bytes(lines, lines_per_page=4))
        self.assertEqual(len(parsers.parse(text)[1]), 8)

    def test_refusals(self):
        with self.assertRaises(StatementError) as raised:
            extract.pdf_text(b"\x89PNG\r\n\x1a\nnot a statement")
        self.assertEqual(raised.exception.code, "unsupported_format")
        with self.assertRaises(StatementError) as raised:
            extract.pdf_text(b"%PDF-1.4\nbroken")
        self.assertEqual(raised.exception.code, "invalid_pdf")
        with patch.object(extract, "MAX_PAGES", 1), self.assertRaises(StatementError) as raised:
            extract.pdf_text(demo.pdf_bytes(demo.demo_forte_lines(DAY), lines_per_page=4))
        self.assertEqual(raised.exception.code, "pdf_too_many_pages")
        with patch.object(extract, "MAX_BYTES", 10), self.assertRaises(StatementError) as raised:
            extract.pdf_text(demo.pdf_bytes(["x"]))
        self.assertEqual(raised.exception.code, "upload_too_large")
