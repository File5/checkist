"""Разбор XML Нацбанка на образцах настоящего ответа и загрузка без сети (``urlopen`` подменён)."""
import socket
import urllib.error
from datetime import date
from decimal import Decimal
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, override_settings

from rates import nbrk
from rates.nbrk import FetchError, Item

D = Decimal
FIXTURES = Path(__file__).resolve().parent / "fixtures"
SAMPLE = (FIXTURES / "nbrk-2026-10-09.xml").read_bytes()
EMPTY = (FIXTURES / "nbrk-empty.xml").read_bytes()


def answer(content, status=200):
    response = mock.MagicMock()
    response.status = status
    response.read.side_effect = lambda size=-1: content if size < 0 else content[:size]
    response.__enter__.return_value = response
    return response


class ParseTests(SimpleTestCase):
    def test_sample_answer(self):
        self.assertEqual(nbrk.parse(SAMPLE), [
            Item("AMD", D("12.47"), 10), Item("USD", D("448.94"), 1), Item("EUR", D("502.05"), 1),
            Item("RUB", D("5.26"), 1), Item("UZS", D("3.8"), 100),
        ])

    def test_no_rates_for_the_day_is_an_empty_list(self):
        self.assertEqual(nbrk.parse(EMPTY), [])

    def test_broken_rows_are_skipped(self):
        rows = "".join(f"<item><title>{code}</title><description>{value}</description><quant>{quant}</quant></item>"
                       for code, value, quant in (
                           ("usd", "448.94", "1"),  # регистр кода не важен
                           ("US", "1", "1"), ("EUR", "-5", "1"), ("RUB", "0", "1"), ("GBP", "1e3", "1"),
                           ("CNY", "63.2", "0"), ("TRY", "10.5", "x"), ("USD", "1.00", "1"),  # повтор кода
                           ("KGS", "5.71", "1")))
        found = nbrk.parse(f"<rates><date>09.10.2026</date>{rows}</rates>".encode())
        self.assertEqual(found, [Item("USD", D("448.94"), 1), Item("KGS", D("5.71"), 1)])

    def test_not_the_expected_xml(self):
        for content in (b"", b"<html><body>502</body></html>", b"<rates><item>", b"not xml"):
            with self.subTest(content=content), self.assertRaises(FetchError):
                nbrk.parse(content)

    def test_xml_with_a_dtd_is_refused(self):
        bomb = (b'<?xml version="1.0"?><!DOCTYPE rates [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>'
                b"<rates><item><title>USD</title><description>&b;</description><quant>1</quant></item></rates>")
        with self.assertRaises(FetchError):
            nbrk.parse(bomb)

    def test_url_of_a_day(self):
        self.assertEqual(nbrk.url(date(2026, 10, 9)), "https://nationalbank.kz/rss/get_rates.cfm?fdate=09.10.2026")
        with override_settings(RATES_NBRK_URL="http://127.0.0.1:9/rates?d={date}"):
            self.assertEqual(nbrk.url(date(2026, 1, 2)), "http://127.0.0.1:9/rates?d=02.01.2026")


class FetchTests(SimpleTestCase):
    def test_fetch_reads_and_parses_with_a_timeout(self):
        with mock.patch("rates.nbrk.urllib.request.urlopen", return_value=answer(SAMPLE)) as urlopen:
            found = nbrk.fetch(date(2026, 10, 9), timeout=3)
        self.assertEqual(len(found), 5)
        request = urlopen.call_args.args[0]
        self.assertEqual(request.full_url, "https://nationalbank.kz/rss/get_rates.cfm?fdate=09.10.2026")
        self.assertEqual(urlopen.call_args.kwargs, {"timeout": 3})

    def test_network_failures_become_fetch_errors(self):
        for error in (urllib.error.URLError("down"), socket.timeout("slow"), ConnectionResetError("reset")):
            with self.subTest(error=error), mock.patch("rates.nbrk.urllib.request.urlopen", side_effect=error):
                with self.assertRaises(FetchError):
                    nbrk.fetch(date(2026, 10, 9))

    def test_bad_status_and_oversized_answers(self):
        with mock.patch("rates.nbrk.urllib.request.urlopen", return_value=answer(SAMPLE, status=500)):
            with self.assertRaisesMessage(FetchError, "HTTP 500"):
                nbrk.fetch(date(2026, 10, 9))
        huge = b"<rates>" + b" " * nbrk.MAX_BYTES + b"</rates>"
        with mock.patch("rates.nbrk.urllib.request.urlopen", return_value=answer(huge)):
            with self.assertRaisesMessage(FetchError, "too large"):
                nbrk.fetch(date(2026, 10, 9))
