from datetime import date, time
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import patch

from django.db import OperationalError
from django.http import QueryDict
from django.test import RequestFactory, SimpleTestCase, TestCase, override_settings, tag
from rest_framework.test import APIClient

from api import stats_common
from api.params import STATS_INTERVALS, Params
from api.tests.factories import make_product, make_receipt
from catalog.models import Brand, Category, GenericProduct
from merges import services
from merges.models import ProductMerge, ProductMergeMember
from receipts.models import Receipt, ReceiptLine
from receipts.tests import samples
from receipts.tests.test_models import make_line
from stores.models import Store

D = Decimal
URL = "/api/stats/spending/"
MARCH = "date_from=2026-03-01&date_to=2026-03-31"


def parse(query, call):
    params = Params(QueryDict(query))
    return call(params), params.errors


class StatsParamsTests(SimpleTestCase):
    def test_required_date(self):
        required = lambda params: params.date("base_from", required=True)  # noqa: E731
        self.assertEqual(parse("base_from=2026-01-31", required), (date(2026, 1, 31), {}))
        for query in ("", "base_from=", "base_from=%20"):
            with self.subTest(query=query):
                self.assertEqual(parse(query, required), (None, {"base_from": ["Обязательный параметр."]}))
        self.assertEqual(parse("base_from=31.01.2026", required), (None, {"base_from": ["Ожидается дата ГГГГ-ММ-ДД."]}))
        self.assertEqual(parse("base_from=%09", required), (None, {"base_from": ["Управляющие символы недопустимы."]}))
        self.assertEqual(parse("", lambda params: params.date("base_from")), (None, {}))

    def test_required_date_range(self):
        call = lambda params: params.date_range("base_from", "base_to", required=True)  # noqa: E731
        self.assertEqual(parse("base_from=2020-01-01&base_to=2020-12-31", call),
                         ((date(2020, 1, 1), date(2020, 12, 31)), {}))
        self.assertEqual(parse("base_to=2020-12-31", call),
                         ((None, date(2020, 12, 31)), {"base_from": ["Обязательный параметр."]}))
        self.assertEqual(parse("", call), ((None, None), {
            "base_from": ["Обязательный параметр."], "base_to": ["Обязательный параметр."]}))
        self.assertEqual(parse("base_from=2021-01-01&base_to=2020-12-31", call)[1],
                         {"base_from": ["Должна быть не позже base_to."]})

    def test_interval(self):
        self.assertEqual(STATS_INTERVALS, ("month", "week", "quarter", "year"))
        self.assertEqual(parse("", lambda params: params.interval()), ("month", {}))
        for value in STATS_INTERVALS:
            self.assertEqual(parse(f"interval={value}", lambda params: params.interval()), (value, {}))
        self.assertEqual(parse("interval=day", lambda params: params.interval()), (
            "month", {"interval": ["Допустимые значения: month, week, quarter, year."]}))
        self.assertEqual(parse("interval=day", lambda params: params.interval(choices=("day", "week"), default="week")),
                         ("day", {}))

    def test_object_ids_format_is_checked_without_database(self):
        call = lambda params: params.object_ids("store", None)  # noqa: E731
        self.assertEqual(parse("", call), ([], {}))
        self.assertEqual(parse("store=", call), ([], {}))
        expected = {"store": ["Ожидаются целые положительные числа через запятую."]}
        for value in ("abc", "0", "-1", "1,,2", "1,", "1;2", "1.5", str(2**63), "1,x"):
            with self.subTest(value=value):
                self.assertEqual(parse(f"store={value}", call), ([], expected))
        many = ",".join(str(number) for number in range(1, 22))
        self.assertEqual(parse(f"store={many}", call), ([], {"store": ["Не больше 20 значений."]}))

    def test_receipt_q_and_ratio(self):
        scope = stats_common.Scope(country="DE", currency="EUR", stores=(3, 4))
        period = stats_common.Period(date(2026, 1, 1), None)
        self.assertEqual(dict(stats_common.receipt_q(scope, period, "receipt__").children), {
            "receipt__store__country_id": "DE", "receipt__currency_id": "EUR", "receipt__store_id__in": (3, 4),
            "receipt__purchased_on__gte": date(2026, 1, 1),
        })
        self.assertEqual(len(stats_common.receipt_q(stats_common.Scope())), 0)
        self.assertEqual(period.as_json(), {"date_from": "2026-01-01", "date_to": None})
        self.assertEqual(stats_common.ratio_percent(D("1"), D("3")), "33.33")
        self.assertEqual(stats_common.ratio_percent(D("-1"), D("8")), "-12.50")
        self.assertIsNone(stats_common.ratio_percent(D("1"), D("0")))
        self.assertIsNone(stats_common.ratio_percent(None, D("5")))
        self.assertEqual(stats_common.money(D("2.005")), "2.01")


class _Lines:
    """Строки чека с позициями по порядку."""

    def __init__(self, receipt):
        self.receipt, self.position = receipt, 0

    def add(self, product, amount, *, quantity="1", **fields):
        self.position += 1
        quantity, amount = D(quantity), D(amount)
        fields.setdefault("unit_price", abs(amount / quantity).quantize(D("0.0001")))
        return make_line(self.receipt, position=self.position, product=product, quantity=quantity, amount=amount,
                         **fields)


def spending_data():
    """Три чека EUR в Lidl (один — возврат в апреле), чек KZT в ДНС; названия вымышленные.

    EUR за всю историю: «Продукты питания» 9.60 (молоко 3.00 + 1.60 − 1.50, хлеб 1.50, набор 5.00),
    «Бытовая химия» 3.00, «Не разобрано» 0.95, несопоставленное 1.20, услуга 4.00,
    залог 0.25 − 0.25. Строки 18.75, чеки 18.25: скидка на весь чек 0.50.
    """
    lidl, dns = samples.lidl_store(), samples.dns_store()
    food = Category.objects.create(name="Продукты питания")
    dairy = Category.objects.create(name="Молочные продукты", parent=food)
    bakery = Category.objects.create(name="Хлеб", parent=food)
    chemistry = Category.objects.create(name="Бытовая химия")
    unassigned = Category.objects.create(name="Не разобрано")

    def generic(name, category, base_unit="pcs"):
        return GenericProduct.objects.create(name=name, category=category, base_unit=base_unit)

    milk_generic, unassigned_generic = generic("Молоко", dairy, "l"), generic("Не разобрано", unassigned)
    milk = make_product(milk_generic, "Демо-молоко 1 л")
    bread = make_product(generic("Хлеб", bakery, "kg"), "Демо-батон")
    box = make_product(generic("Наборы", food), "Демо-набор")
    soap = make_product(generic("Мыло", chemistry), "Демо-мыло")
    mystery = make_product(unassigned_generic, "ARTIKEL 77")

    first = make_receipt(lidl, "EUR", date(2026, 3, 1), total=D("14.45"), discount_total=D("0.50"))
    lines = _Lines(first)
    lines.add(milk, "3.00", quantity="2")
    lines.add(bread, "2.00", discount_amount=D("0.50"))
    lines.add(box, "5.00")
    lines.add(None, "1.20", raw_name="UNBEKANNT")
    lines.add(None, "0.25", kind="deposit", raw_name="Pfand")
    lines.add(None, "4.00", kind="service", raw_name="Доставка")
    second = make_receipt(lidl, "EUR", date(2026, 3, 31), at=time(23, 30), total=D("5.30"))
    lines = _Lines(second)
    lines.add(milk, "1.60", unit="l")
    lines.add(soap, "3.00")
    lines.add(mystery, "0.95")
    lines.add(None, "-0.25", quantity="-1", kind="deposit_return", raw_name="Pfandrückgabe")
    refund = make_receipt(lidl, "EUR", date(2026, 4, 1), at=time(0, 30), total=D("-1.50"),
                          operation=Receipt.Operation.REFUND)
    _Lines(refund).add(milk, "-1.50", quantity="-1")
    # 01:00 в Алматы — ещё 28 февраля по UTC: в март чек входит по локальной дате.
    kzt = make_receipt(dns, "KZT", date(2026, 3, 1), at=time(1, 0), total=D("1000.00"))
    _Lines(kzt).add(mystery, "1000.00")
    return SimpleNamespace(
        lidl=lidl, dns=dns, food=food, dairy=dairy, bakery=bakery, chemistry=chemistry, unassigned=unassigned,
        milk_generic=milk_generic, unassigned_generic=unassigned_generic,
        milk=milk, bread=bread, box=box, soap=soap, mystery=mystery,
        first=first, second=second, refund=refund, kzt=kzt,
    )


def item(kind, pk, name, amount, share, lines, receipts, **fields):
    return {
        "kind": kind, "id": pk, "name": name, "direct": False, "unassigned": False, "amount": amount,
        "share_percent": share, "lines_count": lines, "receipts_count": receipts, "quantity": None, "unit": None,
        **fields,
    }


def absorb(target, source):
    """Ожидающая группа слияния: ``source`` поглощён ``target``; строки не переносятся."""
    group = ProductMerge.objects.create(target_ref=target.pk, detector_version=1)
    for product, role in ((target, "target"), (source, "source")):
        ProductMergeMember.objects.create(
            group=group, product_ref=product.pk, active_product=product, role=role, name=product.name,
        )
    return group


@tag("integration")
@override_settings(DEBUG=True, ALLOW_LOCAL_RECOGNITION_API=True)
class SpendingAPITests(TestCase):
    maxDiff = None

    @classmethod
    def setUpTestData(cls):
        cls.data = spending_data()

    def setUp(self):
        self.client = APIClient()

    def get(self, query=""):
        response = self.client.get(f"{URL}?{query}")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def eur(self, query=""):
        return next(block for block in self.get(query)["currencies"] if block["currency"] == "EUR")

    def assert_identities(self, block):
        other = D(block["other"]["amount"]) if block["other"] else D(0)
        totals = block["totals"]
        self.assertEqual(sum(D(entry["amount"]) for entry in block["items"]) + other, D(totals["lines_paid"]))
        if totals["receipts_total"] is not None:
            self.assertEqual(D(totals["lines_paid"]) + D(totals["difference"]), D(totals["receipts_total"]))

    def assert_invalid(self, query, fields):
        response = self.client.get(f"{URL}?{query}")
        self.assertEqual(response.status_code, 400, response.content)
        error = response.json()["error"]
        self.assertEqual((error["code"], error["fields"]), ("invalid_parameter", fields))

    # --- форма ответа ---

    def test_full_response_by_category(self):
        data = self.data
        response = self.client.get(URL)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response.json(), {
            "group_by": "category", "date_from": None, "date_to": None, "parent": None,
            "currencies": [
                {
                    "currency": "EUR",
                    "totals": {"receipts_count": 3, "receipts_total": "18.25", "lines_paid": "18.75",
                               "difference": "-0.50"},
                    "items": [
                        item("category", data.food.pk, "Продукты питания", "9.60", "51.20", 5, 3),
                        item("category", data.chemistry.pk, "Бытовая химия", "3.00", "16.00", 1, 1),
                        item("category", data.unassigned.pk, "Не разобрано", "0.95", "5.07", 1, 1, unassigned=True),
                        item("unmatched", None, None, "1.20", "6.40", 1, 1),
                        item("service", None, None, "4.00", "21.33", 1, 1),
                        item("deposit", None, None, "0.00", None, 2, 2),
                    ],
                    "other": None,
                },
                {
                    "currency": "KZT",
                    "totals": {"receipts_count": 1, "receipts_total": "1000.00", "lines_paid": "1000.00",
                               "difference": "0.00"},
                    "items": [
                        item("category", data.unassigned.pk, "Не разобрано", "1000.00", "100.00", 1, 1,
                             unassigned=True),
                    ],
                    "other": None,
                },
            ],
        })
        for block in response.json()["currencies"]:
            self.assert_identities(block)

    def test_drill_down_and_parent(self):
        data = self.data
        body = self.get(f"category={data.food.pk}")
        self.assertEqual(body["parent"], {
            "id": data.food.pk, "name": "Продукты питания", "path": [{"id": data.food.pk, "name": "Продукты питания"}],
        })
        (block,) = body["currencies"]
        self.assertEqual(block["totals"], {
            "receipts_count": 3, "receipts_total": None, "lines_paid": "9.60", "difference": None,
        })
        self.assertEqual(block["items"], [
            item("category", data.food.pk, "Продукты питания", "5.00", "52.08", 1, 1, direct=True),
            item("category", data.dairy.pk, "Молочные продукты", "3.10", "32.29", 3, 3),
            item("category", data.bakery.pk, "Хлеб", "1.50", "15.63", 1, 1),
        ])
        self.assert_identities(block)
        leaf = self.get(f"category={data.dairy.pk}&group_by=product")
        self.assertEqual(leaf["parent"]["path"], [
            {"id": data.food.pk, "name": "Продукты питания"}, {"id": data.dairy.pk, "name": "Молочные продукты"},
        ])
        self.assertEqual([entry["id"] for entry in leaf["currencies"][0]["items"]], [data.milk.pk])
        unassigned = self.get(f"category={data.unassigned.pk}")
        self.assertEqual([block["currency"] for block in unassigned["currencies"]], ["EUR", "KZT"])
        self.assertEqual(unassigned["currencies"][0]["items"], [
            item("category", data.unassigned.pk, "Не разобрано", "0.95", "100.00", 1, 1, direct=True, unassigned=True),
        ])

    def test_group_by_generic_and_generic_filter(self):
        data = self.data
        block = self.eur("group_by=generic")
        self.assertEqual([(entry["kind"], entry["name"], entry["amount"]) for entry in block["items"]], [
            ("generic", "Наборы", "5.00"), ("generic", "Молоко", "3.10"), ("generic", "Мыло", "3.00"),
            ("generic", "Хлеб", "1.50"), ("generic", "Не разобрано", "0.95"),
            ("unmatched", None, "1.20"), ("service", None, "4.00"), ("deposit", None, "0.00"),
        ])
        self.assertEqual([entry["id"] for entry in block["items"] if entry["unassigned"]], [data.unassigned_generic.pk])
        self.assert_identities(block)
        body = self.get(f"generic={data.milk_generic.pk}&group_by=product")
        self.assertIsNone(body["parent"])
        (only,) = body["currencies"]
        self.assertEqual(only["totals"], {
            "receipts_count": 3, "receipts_total": None, "lines_paid": "3.10", "difference": None,
        })
        self.assertEqual(only["items"], [item("product", data.milk.pk, "Демо-молоко 1 л", "3.10", "100.00", 3, 3)])

    def test_group_by_product_quantity_and_unit(self):
        data = self.data
        block = self.eur(f"group_by=product&{MARCH}")
        found = {entry["id"]: entry for entry in block["items"] if entry["kind"] == "product"}
        # Молоко в марте куплено штуками и литрами — единица не одна.
        self.assertEqual((found[data.milk.pk]["amount"], found[data.milk.pk]["quantity"], found[data.milk.pk]["unit"]),
                         ("4.60", None, None))
        self.assertEqual((found[data.bread.pk]["amount"], found[data.bread.pk]["quantity"], found[data.bread.pk]["unit"]),
                         ("1.50", "1.000", "pcs"))
        self.assertFalse(found[data.mystery.pk]["unassigned"])
        self.assertEqual([entry["kind"] for entry in block["items"][-3:]], ["unmatched", "service", "deposit"])
        self.assertIsNone(block["items"][-3]["quantity"])
        self.assert_identities(block)
        april = self.eur("group_by=product&date_from=2026-04-01")
        self.assertEqual(april["items"], [
            item("product", data.milk.pk, "Демо-молоко 1 л", "-1.50", None, 1, 1, quantity="-1.000", unit="pcs"),
        ])
        self.assertEqual(april["totals"], {
            "receipts_count": 1, "receipts_total": "-1.50", "lines_paid": "-1.50", "difference": "0.00",
        })

    def test_group_by_store(self):
        data = self.data
        body = self.get("group_by=store")
        eur, kzt = body["currencies"]
        self.assertEqual(eur["items"], [
            item("store", data.lidl.pk, "Lidl", "18.25", "100.00", 11, 3, city=data.lidl.city, country="DE"),
        ])
        self.assertEqual(eur["totals"], {
            "receipts_count": 3, "receipts_total": "18.25", "lines_paid": "18.25", "difference": "0.00",
        })
        self.assertEqual((kzt["items"][0]["id"], kzt["items"][0]["country"], kzt["items"][0]["amount"]),
                         (data.dns.pk, "KZ", "1000.00"))
        self.assert_identities(eur)
        filtered = self.eur(f"group_by=store&category={data.food.pk}")
        self.assertEqual((filtered["items"][0]["amount"], filtered["items"][0]["lines_count"]), ("9.60", 5))
        self.assertIsNone(filtered["totals"]["receipts_total"])
        content = self.client.get(f"{URL}?group_by=store").content.decode()
        for hidden in ("legal_name", "tax_id", "address", "raw_text", "fiscal", "receipt_number"):
            self.assertNotIn(f'"{hidden}"', content)
        self.assertNotIn(data.lidl.merchant.tax_id, content)

    # --- период, фильтры, валюты ---

    def test_period_bounds_are_inclusive_local_dates(self):
        march = self.get(MARCH)
        self.assertEqual((march["date_from"], march["date_to"]), ("2026-03-01", "2026-03-31"))
        eur, kzt = march["currencies"]
        # 1 и 31 марта входят; возврат 1 апреля в 00:30 (31 марта по UTC) — нет.
        self.assertEqual(eur["totals"], {
            "receipts_count": 2, "receipts_total": "19.75", "lines_paid": "20.25", "difference": "-0.50",
        })
        # Чек KZT: 1 марта 01:00 местного времени, 28 февраля по UTC.
        self.assertEqual(kzt["totals"]["receipts_count"], 1)
        self.assertEqual(self.get("date_to=2026-02-28")["currencies"], [])
        self.assertEqual(self.eur("date_from=2026-03-31&date_to=2026-03-31")["totals"]["receipts_total"], "5.30")
        self.assertEqual(self.eur("date_from=2026-04-01&date_to=2026-04-01")["totals"]["receipts_total"], "-1.50")
        self.assertEqual(self.eur("date_to=2026-03-01")["totals"]["receipts_total"], "14.45")
        with self.settings(TIME_ZONE="Asia/Tokyo"):
            self.assertEqual(self.get(MARCH), march)

    def test_refund_is_subtracted(self):
        march = self.eur(MARCH)["items"][0]
        whole = self.eur()["items"][0]
        self.assertEqual((march["amount"], whole["amount"]), ("11.10", "9.60"))
        self.assertEqual((march["lines_count"], whole["lines_count"]), (4, 5))

    def test_filters(self):
        data = self.data
        self.assertEqual([block["currency"] for block in self.get("country=kz")["currencies"]], ["KZT"])
        self.assertEqual([block["currency"] for block in self.get("currency=eur")["currencies"]], ["EUR"])
        self.assertEqual(self.get("country=DE&currency=KZT")["currencies"], [])
        self.assertEqual([block["currency"] for block in self.get(f"store={data.dns.pk}")["currencies"]], ["KZT"])
        both = self.get(f"store={data.dns.pk},{data.lidl.pk},%20{data.dns.pk}")
        self.assertEqual([block["currency"] for block in both["currencies"]], ["EUR", "KZT"])
        self.assertEqual(self.get("country=RU")["currencies"], [])

    def test_empty_and_unknown_parameters(self):
        whole = self.get()
        self.assertEqual(self.get("date_from=&country=%20&store=&group_by=&category=&limit=&unknown=1&page=x"), whole)
        for query in ("category=999999", "generic=999999", f"category=999999&generic={self.data.milk_generic.pk}"):
            with self.subTest(query=query):
                body = self.get(query)
                self.assertEqual((body["parent"], body["currencies"]), (None, []))

    def test_one_currency_per_block_even_in_one_store(self):
        receipt = make_receipt(self.data.lidl, "KZT", date(2026, 3, 2), total=D("700.00"))
        _Lines(receipt).add(self.data.milk, "700.00")
        eur, kzt = self.get(f"store={self.data.lidl.pk}")["currencies"]
        self.assertEqual((eur["totals"]["receipts_total"], kzt["totals"]["receipts_total"]), ("18.25", "700.00"))
        self.assertEqual([entry["amount"] for entry in kzt["items"]], ["700.00"])

    # --- порядок и «прочее» ---

    def test_limit_folds_regular_items_only(self):
        block = self.eur("group_by=generic&limit=2")
        self.assertEqual([(entry["kind"], entry["amount"], entry["share_percent"]) for entry in block["items"]], [
            ("generic", "5.00", "26.67"), ("generic", "3.10", "16.53"),
            ("unmatched", "1.20", "6.40"), ("service", "4.00", "21.33"), ("deposit", "0.00", None),
        ])
        self.assertEqual(block["other"], {"count": 3, "amount": "5.45", "share_percent": "29.07"})
        self.assert_identities(block)
        self.assertIsNone(self.eur("group_by=generic&limit=5")["other"])
        self.assertEqual(self.eur("group_by=generic&limit=50")["items"], self.eur("group_by=generic")["items"])

    def test_order_by_amount_then_name_then_id(self):
        data = self.data
        twin_generic = GenericProduct.objects.create(name="Яблоки", category=data.food, base_unit="kg")
        # Одинаковое название допустимо только у разных брендов.
        twins = [
            make_product(twin_generic, "Демо-яблоко", brand=Brand.objects.create(name=brand))
            for brand in ("Демо-сад Б", "Демо-сад А")
        ]
        early = make_product(twin_generic, "Демо-айва")
        receipt = make_receipt(data.lidl, "EUR", date(2026, 5, 1), total=D("9.00"))
        lines = _Lines(receipt)
        for product in (*twins, early):
            lines.add(product, "3.00")
        block = self.eur("group_by=product&date_from=2026-05-01")
        self.assertEqual([entry["id"] for entry in block["items"]], [early.pk, twins[0].pk, twins[1].pk])
        self.assertLess(twins[0].pk, twins[1].pk)

    # --- слитые товары ---

    def test_absorbed_product_is_counted_at_the_target(self):
        data = self.data
        other_generic = GenericProduct.objects.create(name="Напитки", category=data.chemistry, base_unit="l")
        duplicate = make_product(other_generic, "Демо-молоко 1л")
        receipt = make_receipt(data.lidl, "EUR", date(2026, 3, 10), total=D("2.00"))
        _Lines(receipt).add(duplicate, "2.00", quantity="2")
        before = self.eur("group_by=product")
        self.assertIn(duplicate.pk, [entry["id"] for entry in before["items"]])
        group = absorb(data.milk, duplicate)

        block = self.eur("group_by=product")
        found = {entry["id"]: entry for entry in block["items"] if entry["kind"] == "product"}
        self.assertNotIn(duplicate.pk, found)
        self.assertEqual((found[data.milk.pk]["amount"], found[data.milk.pk]["lines_count"],
                          found[data.milk.pk]["receipts_count"]), ("5.10", 4, 4))
        self.assertEqual(block["totals"], before["totals"])
        self.assert_identities(block)
        # Категория и обобщённый продукт строки — оставляемого товара.
        self.assertEqual(self.eur("group_by=generic")["items"][0]["amount"], "5.10")
        self.assertNotIn("Напитки", [entry["name"] for entry in self.eur("group_by=generic")["items"]])
        self.assertEqual(self.eur(f"generic={data.milk_generic.pk}")["totals"]["lines_paid"], "5.10")
        self.assertEqual(self.get(f"generic={other_generic.pk}")["currencies"], [])
        self.assertEqual(self.eur(f"category={data.dairy.pk}")["totals"]["lines_paid"], "5.10")
        self.assertEqual(self.eur(f"category={data.chemistry.pk}")["totals"]["lines_paid"], "3.00")
        for query in ("", "group_by=generic", "group_by=product", "group_by=store"):
            content = self.client.get(f"{URL}?{query}").content.decode()
            self.assertNotIn(duplicate.name, content)

        services.cancel(group.pk)
        after = self.eur("group_by=product")
        self.assertEqual(after["items"], before["items"])

    # --- запросы ---

    def test_query_count_is_constant(self):
        data = self.data
        absorb(data.milk, make_product(data.milk_generic, "Демо-молоко дубль"))
        filters = f"country=DE&currency=EUR&store={data.lidl.pk}&{MARCH}"
        cases = (
            ("", 4), ("group_by=generic", 3), ("group_by=product", 3), ("group_by=store", 4),
            (f"category={data.food.pk}", 4), (f"generic={data.milk_generic.pk}&group_by=product", 3),
            (filters, 7), (f"group_by=store&category={data.food.pk}&{filters}", 8),
        )

        def measure():
            for query, expected in cases:
                with self.subTest(query=query), self.assertNumQueries(expected):
                    self.get(query)

        measure()
        for number in range(25):
            category = Category.objects.create(name=f"Демо-категория {number}", parent=data.food)
            generic = GenericProduct.objects.create(name=f"Демо-продукт {number}", category=category, base_unit="pcs")
            store = Store.objects.create(
                merchant=data.lidl.merchant, country_id="DE", name=f"Демо-магазин {number}", city="Musterstadt",
                address_raw=f"Beispielallee {number}", address_key=f"beispielallee {number}", timezone="Europe/Berlin",
            )
            receipt = make_receipt(store, "EUR", date(2026, 3, 5), total=D("2.00"))
            lines = _Lines(receipt)
            lines.add(make_product(generic, f"Демо-товар {number}"), "1.50")
            lines.add(None, "0.50", raw_name="UNBEKANNT")
        measure()
        self.assertEqual(len(self.eur("group_by=store&limit=50")["items"]), 26)
        with self.assertNumQueries(1):  # категории нет — до чеков дело не доходит
            self.get("category=999999")

    # --- ошибки и доступ ---

    def test_invalid_parameters(self):
        store_format = ["Ожидаются целые положительные числа через запятую."]
        cases = (
            ("date_from=2026-13-01", {"date_from": ["Ожидается дата ГГГГ-ММ-ДД."]}),
            ("date_to=01.03.2026", {"date_to": ["Ожидается дата ГГГГ-ММ-ДД."]}),
            ("date_from=2026-03-02&date_to=2026-03-01", {"date_from": ["Должна быть не позже date_to."]}),
            ("country=DEU", {"country": ["Ожидается код страны из двух букв."]}),
            ("country=ZZ", {"country": ["Неизвестный код страны."]}),
            ("country=DE,KZ", {"country": ["Ожидается код страны из двух букв."]}),
            ("currency=EU", {"currency": ["Ожидается код валюты из трёх букв."]}),
            ("currency=ZZZ", {"currency": ["Неизвестный код валюты."]}),
            ("store=abc", {"store": store_format}),
            ("store=0", {"store": store_format}),
            ("store=1,,2", {"store": store_format}),
            ("store=" + ",".join(str(number) for number in range(1, 22)), {"store": ["Не больше 20 значений."]}),
            ("store=999999", {"store": ["Магазин не найден."]}),
            (f"store={self.data.lidl.pk},999999", {"store": ["Магазин не найден."]}),
            ("group_by=brand", {"group_by": ["Допустимые значения: category, generic, product, store."]}),
            ("category=x", {"category": ["Ожидается целое положительное число."]}),
            ("category=0", {"category": ["Ожидается целое положительное число."]}),
            ("generic=-1", {"generic": ["Ожидается целое положительное число."]}),
            ("generic=" + "9" * 20, {"generic": ["Ожидается целое положительное число."]}),
            ("limit=0", {"limit": ["Допустимо от 1 до 500."]}),
            ("limit=501", {"limit": ["Допустимо от 1 до 500."]}),
            ("limit=ten", {"limit": ["Допустимо от 1 до 500."]}),
            ("country=%00", {"country": ["Управляющие символы недопустимы."]}),
        )
        for query, fields in cases:
            with self.subTest(query=query):
                self.assert_invalid(query, fields)
        self.assert_invalid("date_from=x&country=ZZ&store=a&group_by=b&category=c&generic=d&limit=0&currency=1", {
            "date_from": ["Ожидается дата ГГГГ-ММ-ДД."], "country": ["Неизвестный код страны."],
            "currency": ["Ожидается код валюты из трёх букв."], "store": store_format,
            "group_by": ["Допустимые значения: category, generic, product, store."],
            "category": ["Ожидается целое положительное число."], "generic": ["Ожидается целое положительное число."],
            "limit": ["Допустимо от 1 до 500."],
        })
        self.assertEqual(self.get("limit=1&limit=50")["group_by"], "category")
        for accepted in (1, 50, 51, 500):  # состав «прочего» клиент читает большим limit
            with self.subTest(limit=accepted):
                self.assertEqual(self.client.get(f"{URL}?limit={accepted}").status_code, 200)
        repeated = ",".join([str(self.data.lidl.pk)] * 30)  # повторы в пределе 20 не считаются
        self.assertEqual([block["currency"] for block in self.get(f"store={repeated}")["currencies"]], ["EUR"])

    def test_access_is_local_only(self):
        def denied(response):
            self.assertEqual(response.status_code, 403, response.content)
            self.assertEqual(response.json()["error"]["code"], "permission_denied")
            self.assertEqual(response["Cache-Control"], "no-store")
            self.assertNotIn("currencies", response.content.decode())

        with self.settings(ALLOW_LOCAL_RECOGNITION_API=False):
            denied(self.client.get(URL))
            denied(self.client.get(f"{URL}?limit=0"))
            denied(self.client.get("/api/stats/unknown/"))
        with self.settings(DEBUG=False):
            denied(self.client.get(URL))
        denied(self.client.get(URL, REMOTE_ADDR="10.0.0.5"))
        denied(self.client.get(URL, REMOTE_ADDR="10.0.0.5", HTTP_X_FORWARDED_FOR="127.0.0.1"))
        self.assertEqual(self.client.get(URL, REMOTE_ADDR="::1").status_code, 200)

    def test_methods_and_unknown_paths_follow_the_local_api(self):
        self.assertEqual(self.client.head(URL).status_code, 200)
        self.assertEqual(self.client.options(URL).status_code, 200)
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                ours = getattr(self.client, method)(URL)
                theirs = getattr(self.client, method)("/api/receipts/")
                self.assertEqual((ours.status_code, ours.json()), (theirs.status_code, theirs.json()))
                self.assertIn(ours.status_code, (403, 405))
        self.assertEqual(Receipt.objects.count(), 4)
        self.assertEqual(ReceiptLine.objects.count(), 12)
        for path in ("/api/stats/", "/api/stats/unknown/", "/api/stats/spending/extra/"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "not_found"))
                self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(self.client.get("/api/stats/spending").status_code, 301)
        response = self.client.get(URL, HTTP_ACCEPT="text/html")
        theirs = self.client.get("/api/receipts/", HTTP_ACCEPT="text/html")
        self.assertEqual((response.status_code, response.json()), (theirs.status_code, theirs.json()))

    def test_database_failure_is_a_safe_503(self):
        with patch("api.views.stats_spending.spending.collect", side_effect=OperationalError("PRIVATE DSN")):
            response = self.client.get(URL)
        self.assertEqual(response.status_code, 503, response.content)
        self.assertEqual(response.json()["error"]["code"], "database_unavailable")
        self.assertNotIn("PRIVATE", response.content.decode())
        self.assertEqual(response["Cache-Control"], "no-store")


@tag("integration")
class StatsParamsDatabaseTests(TestCase):
    def test_object_ids(self):
        first, second = samples.lidl_store(), samples.dns_store()
        call = lambda params: params.object_ids("store", Store.objects.all(), message="Магазин не найден.")  # noqa: E731
        with self.assertNumQueries(1):
            self.assertEqual(parse(f"store={second.pk},{first.pk},%20{second.pk}%20", call),
                             ([second.pk, first.pk], {}))
        self.assertEqual(parse(f"store={first.pk},999999", call), ([], {"store": ["Магазин не найден."]}))
        with self.assertNumQueries(0):
            self.assertEqual(parse("", call), ([], {}))
            self.assertEqual(parse("store=x", call)[0], [])
        # Повторы не считаются в пределе 20 значений.
        self.assertEqual(parse("store=" + ",".join([str(first.pk)] * 30), call), ([first.pk], {}))

    def test_read_scope_and_receipts(self):
        store = samples.lidl_store()
        params = Params(QueryDict(f"country=de&currency=eur&store={store.pk}&date_from=2026-03-01"))
        scope, period = stats_common.read_scope(params), stats_common.read_period(params)
        self.assertEqual(params.errors, {})
        self.assertEqual(scope, stats_common.Scope("DE", "EUR", (store.pk,)))
        inside = make_receipt(store, "EUR", date(2026, 3, 1))
        make_receipt(store, "EUR", date(2026, 2, 28))
        make_receipt(store, "KZT", date(2026, 3, 1))
        make_receipt(samples.dns_store(), "EUR", date(2026, 3, 1))
        request = RequestFactory().get(URL)
        self.assertEqual(list(stats_common.receipts(request, scope, period)), [inside])
        self.assertEqual(stats_common.receipts(request, stats_common.Scope()).count(), 4)
