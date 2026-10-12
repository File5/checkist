"""«Динамика»: ``/api/stats/trends/monthly|category|prices|limits|range/``."""
from datetime import date
from decimal import Decimal
from unittest import mock

from django.test import SimpleTestCase, TestCase, tag
from rest_framework.test import APIClient

from accounts.models import Household, Membership
from api.tests.accounts_helpers import NOT_FOUND, TwoUsers, accounts_mode, local_single_mode, make_user
from api.tests.factories import make_product, make_receipt
from api.tests.test_stats_spending import absorb
from budget.models import BudgetLimit
from catalog.models import Category, GenericProduct
from catalog.units import BaseUnit
from receipts import basket, manual, trends
from receipts.models import Receipt, ReceiptLine
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line

D = Decimal
MONTHLY = "/api/stats/trends/monthly/"
CATEGORY = "/api/stats/trends/category/"
PRICES = "/api/stats/trends/prices/"
LIMITS = "/api/stats/trends/limits/"
RANGE = "/api/stats/trends/range/"
PERIOD = "from=2026-06&to=2026-09"
WINDOW = "month=2026-09&months=4"
MONTHS = ["2026-06", "2026-07", "2026-08", "2026-09"]


class WindowTests(SimpleTestCase):
    def test_window_crosses_years_and_ends_at_the_month(self):
        self.assertEqual(trends.window(date(2026, 2, 17), 3), [date(2025, 12, 1), date(2026, 1, 1), date(2026, 2, 1)])
        self.assertEqual(trends.window(date(2026, 9, 30), 1), [date(2026, 9, 1)])
        self.assertEqual(len(trends.window(date(2026, 9, 1), 36)), 36)
        self.assertEqual(trends.window(date(2026, 9, 1), 24)[0], date(2024, 10, 1))
        self.assertEqual(trends.month_end(date(2024, 2, 1)), date(2024, 2, 29))
        self.assertEqual(trends.month_end(date(2026, 12, 1)), date(2026, 12, 31))
        self.assertEqual(trends.label(date(987, 3, 1)), "0987-03")


def purchase(product_id, paid, quantity, unit="pcs"):
    return basket.Purchase(product_id, unit, D(paid), D(quantity))


class ChainIndexTests(SimpleTestCase):
    months = [date(2026, month, 1) for month in (1, 2, 3, 4, 5)]

    def test_chain_through_gaps_and_months_without_common_products(self):
        jan, feb, mar, apr, may = self.months
        by_month = {
            jan: [purchase(1, "2.00", "2"), purchase(2, "3.00", "1")],
            # февраль пуст; март — только новый товар: индекса нет, опорный — январь
            mar: [purchase(3, "9.00", "1")],
            apr: [purchase(1, "2.40", "2"), purchase(2, "3.00", "1"), purchase(None, "5.00", "1")],
            may: [purchase(1, "1.10", "1"), purchase(2, "0.00", "1")],
        }
        points = trends.chain_index(by_month, self.months)
        self.assertEqual([point.month for point in points], self.months)
        self.assertEqual(points[0].index, 100)
        self.assertEqual((points[1].index, points[1].base_month), (None, None))
        self.assertEqual((points[2].index, points[2].base_month, points[2].matched_products), (None, jan, 0))
        self.assertEqual((points[3].index, points[3].base_month, points[3].matched_products), (D("108"), jan, 2))
        self.assertEqual(round(points[3].link_percent, 2), D("8.00"))
        # Товар с нулевой суммой в индекс не входит; цена молока 1,20 → 1,10.
        self.assertEqual((points[4].base_month, points[4].matched_products), (apr, 1))
        self.assertEqual(round(points[4].index, 2), D("99.00"))

    def test_movers_are_first_and_last_month_prices(self):
        jan, feb, mar, apr, may = self.months
        by_month = {
            jan: [purchase(1, "2.00", "2"), purchase(2, "3.00", "1"), purchase(4, "4.00", "1", "kg")],
            mar: [purchase(1, "3.00", "2"), purchase(4, "5.00", "1", "pcs")],
            may: [purchase(1, "2.20", "2"), purchase(2, "1.50", "1"), purchase(5, "1.00", "1")],
        }
        risers, fallers, total, risen, fallen = trends.movers(by_month, self.months, {1: "Молоко", 2: "Хлеб"})
        self.assertEqual((risen, fallen), (1, 1))
        self.assertEqual(total, 2)  # товар 4 в разных единицах — разные товары, товар 5 куплен однажды
        self.assertEqual([(m.product_id, m.old_month, m.new_month, m.change_percent) for m in risers],
                         [(1, jan, may, D("10.00"))])
        self.assertEqual([(m.product_id, m.old_price, m.new_price, m.change_percent) for m in fallers],
                         [(2, D("3.00"), D("1.50"), D("-50.00"))])


def spend(owner, category, total, on, currency="KZT"):
    return manual.create(owner, {"total": total, "currency": currency, "category": category.pk,
                                 "purchased_on": on.isoformat()})


class Lines:
    def __init__(self, receipt):
        self.receipt, self.position = receipt, 0

    def add(self, product, amount, quantity="1", unit="pcs", kind=ReceiptLine.Kind.PRODUCT, **fields):
        self.position += 1
        make_line(self.receipt, position=self.position, product=product, kind=kind, amount=D(amount),
                  quantity=D(quantity), unit=unit, unit_price=abs(D(amount) / D(quantity)), **fields)
        return self


class TrendsFixture:
    """Июнь — сентябрь 2026: фото-чеки в EUR и KZT, коммуналка ручными тратами в KZT, июль пуст."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        owner = cls.fixture_owner()
        cls.food = Category.objects.create(name="Демо-еда")
        cls.dairy = Category.objects.create(name="Демо-молочное", parent=cls.food)
        cls.housing = Category.objects.create(name="Демо-жильё")
        cls.utilities = Category.objects.create(name="Демо-коммуналка", parent=cls.housing)
        cls.empty = Category.objects.create(name="Демо-пусто")

        def product(name, category, unit=BaseUnit.PCS):
            return make_product(GenericProduct.objects.create(name=f"{name} (род)", category=category, base_unit=unit), name)

        cls.milk = product("Демо-молоко", cls.dairy, BaseUnit.L)
        cls.bread = product("Демо-хлеб", cls.food)
        cls.cheese = product("Демо-сыр", cls.dairy)
        cls.kz_milk = product("Демо-сүт", cls.dairy, BaseUnit.L)
        cls.kz_bread = product("Демо-нан", cls.food)
        store, kz = samples.lidl_store(), samples.dns_store()

        def receipt(where, currency, on, total, **fields):
            return make_receipt(where, currency, on, owner=owner, total=D(total), **fields)

        Lines(receipt(store, "EUR", date(2026, 5, 31), "7.00")).add(cls.milk, "7.00", "1", "l")  # до окна
        Lines(receipt(store, "EUR", date(2026, 6, 10), "6.00")).add(cls.milk, "2.00", "2", "l").add(cls.bread, "3.00") \
            .add(None, "1.00", kind=ReceiptLine.Kind.SERVICE, raw_name="Пакет")
        Lines(receipt(store, "EUR", date(2026, 8, 5), "5.40")).add(cls.milk, "2.40", "2", "l").add(cls.bread, "3.00")
        Lines(receipt(store, "EUR", date(2026, 9, 15), "5.10")).add(cls.milk, "1.10", "1", "l").add(cls.cheese, "4.00")
        Lines(receipt(store, "EUR", date(2026, 9, 20), "-1.10", operation=Receipt.Operation.REFUND)) \
            .add(cls.milk, "-1.10", "-1", "l")
        Lines(receipt(store, "EUR", date(2026, 10, 1), "9.00")).add(cls.milk, "9.00", "1", "l")  # после окна
        Lines(receipt(kz, "KZT", date(2026, 6, 3), "650.00")).add(cls.kz_milk, "450.00", "1", "l").add(cls.kz_bread, "200.00")
        Lines(receipt(kz, "KZT", date(2026, 9, 3), "650.00")).add(cls.kz_milk, "500.00", "1", "l").add(cls.kz_bread, "150.00")
        for total, on in (("30000", date(2026, 6, 1)), ("32000", date(2026, 8, 1)), ("35000", date(2026, 9, 1))):
            spend(owner, cls.utilities, total, on)


def month(label, total, categories=(), uncategorized="0.00"):
    return {"month": label, "total": total, "categories": [{"id": pk, "amount": amount} for pk, amount in categories],
            "uncategorized": uncategorized}


@tag("integration")
@local_single_mode()
class TrendsAPITests(TrendsFixture, TestCase):
    maxDiff = None

    @classmethod
    def fixture_owner(cls):
        return local_user()

    def get(self, url, query=WINDOW, status=200):
        response = APIClient().get(f"{url}?{query}")
        self.assertEqual(response.status_code, status, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        return response.json()

    def test_monthly_by_root_category_with_empty_months(self):
        food, housing = self.food.pk, self.housing.pk
        body = self.get(MONTHLY)
        for block in body["currencies"]:
            del block["summary"], block["rows"]
        self.assertEqual(body, {
            "months": 4, "month_from": "2026-06", "month_to": "2026-09",
            "currencies": [
                {
                    "currency": "EUR", "total": "15.40", "average": "3.85",
                    "categories": [{"id": food, "name": "Демо-еда", "unassigned": False, "total": "14.40"}],
                    "months": [
                        month("2026-06", "6.00", [(food, "5.00")], "1.00"),
                        month("2026-07", "0.00"),
                        month("2026-08", "5.40", [(food, "5.40")]),
                        # Возврат — со своим знаком, как в /api/stats/spending/.
                        month("2026-09", "4.00", [(food, "4.00")]),
                    ],
                },
                {
                    "currency": "KZT", "total": "98300.00", "average": "24575.00",
                    "categories": [
                        {"id": housing, "name": "Демо-жильё", "unassigned": False, "total": "97000.00"},
                        {"id": food, "name": "Демо-еда", "unassigned": False, "total": "1300.00"},
                    ],
                    "months": [
                        month("2026-06", "30650.00", [(housing, "30000.00"), (food, "650.00")]),
                        month("2026-07", "0.00"),
                        month("2026-08", "32000.00", [(housing, "32000.00")]),
                        month("2026-09", "35650.00", [(housing, "35000.00"), (food, "650.00")]),
                    ],
                },
            ],
        })

    def test_monthly_summary_and_month_to_month_rows(self):
        eur, kzt = self.get(MONTHLY)["currencies"]
        self.assertEqual(eur["summary"], {
            "month": "2026-09", "spent": "4.00", "previous_month": "2026-08", "previous": "5.40",
            "change_percent": "-25.93", "average_change_percent": "3.90",
        })
        self.assertEqual(kzt["summary"]["change_percent"], "11.41")
        row = lambda pk, name, parent, depth, amounts, total, change: {  # noqa: E731
            "id": pk, "name": name, "parent_id": parent, "depth": depth, "direct": False, "total": total,
            "amounts": amounts, "change_percent": change,
        }
        self.assertEqual(kzt["rows"][0]["average"], "24250.00")
        self.assertEqual(kzt["rows"][0]["change_percents"], [None, "-100.00", None, "9.38"])
        for entry in kzt["rows"]:
            del entry["average"], entry["change_percents"]
        housing, food = self.housing.pk, self.food.pk
        self.assertEqual(kzt["rows"], [
            row(housing, "Демо-жильё", None, 0, ["30000.00", "0.00", "32000.00", "35000.00"], "97000.00", "9.38"),
            row(self.utilities.pk, "Демо-коммуналка", housing, 1, ["30000.00", "0.00", "32000.00", "35000.00"], "97000.00", "9.38"),
            # Июль и август без трат: изменения к нулю нет.
            row(food, "Демо-еда", None, 0, ["650.00", "0.00", "0.00", "650.00"], "1300.00", None),
            row(self.dairy.pk, "Демо-молочное", food, 1, ["450.00", "0.00", "0.00", "500.00"], "950.00", None),
        ])
        one = self.get(MONTHLY, "month=2026-09&months=1")["currencies"][0]
        self.assertEqual((one["summary"]["previous_month"], one["summary"]["previous"], one["summary"]["change_percent"]),
                         (None, None, None))
        self.assertEqual(one["summary"]["average_change_percent"], "0.00")

    def test_months_default_and_window_end(self):
        with mock.patch("api.views.stats_trends.timezone.localdate", return_value=date(2026, 9, 14)):
            body = self.get(MONTHLY, "")
        self.assertEqual((body["months"], body["month_from"], body["month_to"]), (12, "2025-10", "2026-09"))
        self.assertEqual([len(block["months"]) for block in body["currencies"]], [12, 12])
        body = self.get(MONTHLY, "month=2026-07&months=24")
        self.assertEqual((body["month_from"], body["month_to"]), ("2024-08", "2026-07"))
        self.assertEqual(body["currencies"][0]["months"][-2:], [
            month("2026-06", "6.00", [(self.food.pk, "5.00")], "1.00"), month("2026-07", "0.00")])
        self.assertEqual(self.get(MONTHLY, "month=2020-01&months=6")["currencies"], [])

    def test_category_series_of_a_sub_category(self):
        body = self.get(CATEGORY, f"{WINDOW}&category={self.utilities.pk}")
        self.assertEqual(body["category"], {
            "id": self.utilities.pk, "name": "Демо-коммуналка",
            "path": [{"id": self.housing.pk, "name": "Демо-жильё"}, {"id": self.utilities.pk, "name": "Демо-коммуналка"}],
        })
        self.assertFalse(body["suggested"])
        self.assertEqual(body["currencies"], [{
            "currency": "KZT", "total": "97000.00", "average": "24250.00",
            "months": [
                {"month": "2026-06", "amount": "30000.00", "lines_count": 1},
                {"month": "2026-07", "amount": "0.00", "lines_count": 0},
                {"month": "2026-08", "amount": "32000.00", "lines_count": 1},
                {"month": "2026-09", "amount": "35000.00", "lines_count": 1},
            ],
            "parts": [],
        }])
        # Категория с потомками; пустая категория — без блоков; варианты — категории с тратами и их предки.
        (housing,) = self.get(CATEGORY, f"{WINDOW}&category={self.housing.pk}")["currencies"]
        self.assertEqual(housing["months"], body["currencies"][0]["months"])
        self.assertEqual([(part["id"], part["direct"], part["depth"]) for part in housing["parts"]], [(self.utilities.pk, False, 1)])
        self.assertEqual(self.get(CATEGORY, f"{WINDOW}&category={self.empty.pk}")["currencies"], [])
        self.assertEqual(body["options"], [
            {"id": self.food.pk, "name": "Демо-еда", "path": ["Демо-еда"], "depth": 0},
            {"id": self.dairy.pk, "name": "Демо-молочное", "path": ["Демо-еда", "Демо-молочное"], "depth": 1},
            {"id": self.housing.pk, "name": "Демо-жильё", "path": ["Демо-жильё"], "depth": 0},
            {"id": self.utilities.pk, "name": "Демо-коммуналка", "path": ["Демо-жильё", "Демо-коммуналка"], "depth": 1},
        ])

    def test_category_with_products_and_refund_in_two_currencies(self):
        eur, kzt = self.get(CATEGORY, f"{WINDOW}&category={self.food.pk}")["currencies"]
        self.assertEqual((eur["currency"], [entry["amount"] for entry in eur["months"]], eur["total"], eur["average"]),
                         ("EUR", ["5.00", "0.00", "5.40", "4.00"], "14.40", "3.60"))
        self.assertEqual([entry["lines_count"] for entry in eur["months"]], [2, 0, 2, 3])
        # Подкатегория и строки прямо в категории (хлеб) — отдельные части.
        self.assertEqual([(part["id"], part["direct"], part["amounts"]) for part in eur["parts"]], [
            (self.dairy.pk, False, ["2.00", "0.00", "2.40", "4.00"]), (self.food.pk, True, ["3.00", "0.00", "3.00", "0.00"])])
        self.assertEqual((kzt["currency"], [entry["amount"] for entry in kzt["months"]]),
                         ("KZT", ["650.00", "0.00", "0.00", "650.00"]))

    def test_category_is_suggested_without_parameter(self):
        body = self.get(CATEGORY)
        # Траты в трёх месяцах у обеих корневых категорий: первая по имени.
        self.assertEqual((body["category"]["id"], body["suggested"]), (self.food.pk, True))
        self.assertEqual(len(body["currencies"]), 2)
        empty = self.get(CATEGORY, "month=2020-01&months=3")
        self.assertEqual((empty["category"], empty["suggested"], empty["options"], empty["currencies"]),
                         (None, True, [], []))

    def test_unknown_category_is_not_found(self):
        self.assertEqual(self.get(CATEGORY, f"{WINDOW}&category=999999", status=404), NOT_FOUND)

    def test_price_index_on_matched_products(self):
        eur, kzt = self.get(PRICES)["currencies"]
        milk = {"id": self.milk.pk, "name": "Демо-молоко"}
        self.assertEqual(eur, {
            "currency": "EUR", "first_month": "2026-06",
            "points": [
                {"month": "2026-06", "index": "100.00", "base_month": None, "link_percent": None, "matched_products": 0},
                {"month": "2026-07", "index": None, "base_month": None, "link_percent": None, "matched_products": 0},
                {"month": "2026-08", "index": "108.00", "base_month": "2026-06", "link_percent": "8.00",
                 "matched_products": 2},
                # Сыр новый, возврат в цены не входит: только молоко 1,20 → 1,10.
                {"month": "2026-09", "index": "99.00", "base_month": "2026-08", "link_percent": "-8.33",
                 "matched_products": 1},
            ],
            "products_total": 2, "risen_total": 1, "fallen_total": 0, "index_month": "2026-09", "change_percent": "-1.00",
            "risers": [{"product": milk, "unit": "l", "old": {"month": "2026-06", "price": "1.0000"},
                        "new": {"month": "2026-09", "price": "1.1000"}, "change_percent": "10.00"}],
            "fallers": [],
        })
        self.assertEqual([point["index"] for point in kzt["points"]], ["100.00", None, None, "100.00"])
        self.assertEqual(kzt["points"][3]["base_month"], "2026-06")
        self.assertEqual([(entry["product"]["id"], entry["change_percent"]) for entry in kzt["risers"]],
                         [(self.kz_milk.pk, "11.11")])
        self.assertEqual([(entry["product"]["id"], entry["change_percent"]) for entry in kzt["fallers"]],
                         [(self.kz_bread.pk, "-25.00")])
        self.assertEqual((kzt["risen_total"], kzt["fallen_total"], kzt["change_percent"]), (1, 1, "0.00"))
        first_only = self.get(PRICES, "month=2026-06&months=1")["currencies"][0]
        self.assertEqual((first_only["index_month"], first_only["change_percent"]), (None, None))

    def test_limit_history(self):
        owner = local_user()
        housing = BudgetLimit.objects.create(user=owner, category=self.housing, currency_id="KZT", amount=D("32000"))
        food = BudgetLimit.objects.create(user=owner, category=self.food, currency_id="EUR", amount=D("5"))
        # Лимит подкатегории (другая ветка разрешает их): траты подкатегории с её потомками.
        dairy = BudgetLimit.objects.create(user=owner, category=self.dairy, currency_id="EUR", amount=D("2"))
        body = self.get(LIMITS)
        self.assertEqual((body["months"], body["month_from"]), (4, "2026-06"))
        self.assertEqual([(entry["id"], entry["currency"], entry["amount"]) for entry in body["limits"]],
                         [(food.pk, "EUR", "5.00"), (dairy.pk, "EUR", "2.00"), (housing.pk, "KZT", "32000.00")])
        self.assertEqual(body["limits"][0]["category"]["id"], self.food.pk)
        self.assertEqual(body["limits"][0]["months"], [
            {"month": "2026-06", "spent": "5.00", "percent": "100.00", "limit": "5.00", "change": None},
            {"month": "2026-07", "spent": "0.00", "percent": "0.00", "limit": "5.00", "change": None},
            {"month": "2026-08", "spent": "5.40", "percent": "108.00", "limit": "5.00", "change": None},
            {"month": "2026-09", "spent": "4.00", "percent": "80.00", "limit": "5.00", "change": None},
        ])  # лимит без журнала (заведён мимо сервиса) — текущей суммой во всех месяцах
        self.assertEqual([entry["percent"] for entry in body["limits"][1]["months"]], ["100.00", "0.00", "120.00", "200.00"])
        self.assertEqual([entry["percent"] for entry in body["limits"][2]["months"]], ["93.75", "0.00", "100.00", "109.38"])
        BudgetLimit.objects.all().delete()
        with self.assertNumQueries(4):  # категории, пользователь local, лимиты, журнал — чеки не читаются
            self.assertEqual(self.get(LIMITS)["limits"], [])

    def test_manual_spends_do_not_make_a_price_block(self):
        Receipt.objects.filter(source=Receipt.Source.PHOTO, currency_id="KZT").delete()
        self.assertEqual([block["currency"] for block in self.get(PRICES)["currencies"]], ["EUR"])
        self.assertEqual(self.get(PRICES, "month=2020-01&months=6")["currencies"], [])

    def test_absorbed_product_counts_at_the_target(self):
        duplicate = make_product(self.milk.generic, "Демо-молоко дубль")
        line = ReceiptLine.objects.get(product=self.milk, receipt__purchased_on=date(2026, 9, 15))
        line.product = duplicate
        line.save(update_fields=["product"])
        self.assertEqual(self.get(PRICES)["currencies"][0]["points"][3]["matched_products"], 0)
        absorb(self.milk, duplicate)
        eur = self.get(PRICES)["currencies"][0]
        self.assertEqual((eur["points"][3]["index"], eur["points"][3]["matched_products"]), ("99.00", 1))
        self.assertNotIn("дубль", str(eur))

    def test_invalid_parameters(self):
        for query, fields in (
            ("months=0", {"months": ["Допустимо от 1 до 60."]}),
            ("months=61&month=2026-13", {"months": ["Допустимо от 1 до 60."], "month": ["Месяц в формате ГГГГ-ММ."]}),
            ("months=x", {"months": ["Допустимо от 1 до 60."]}),
            ("from=2026-13&to=26-01", {"from": ["Месяц в формате ГГГГ-ММ."], "to": ["Месяц в формате ГГГГ-ММ."]}),
            ("from=1900-12&to=2026-01", {"from": ["Месяц в формате ГГГГ-ММ."]}),
            ("from=2026-06-01", {"from": ["Месяц в формате ГГГГ-ММ."]}),
            ("from=2026-09&to=2026-06", {"to": ["Начало периода позже конца."]}),
            ("from=2021-09&to=2026-09", {"from": ["Период — не больше 60 месяцев."]}),
            ("from=2026-06&to=2026-09&months=4", {"from": ["Укажите либо from и to, либо months и month."]}),
            ("to=2026-09&month=2026-09", {"from": ["Укажите либо from и to, либо months и month."]}),
        ):
            for url in (MONTHLY, CATEGORY, PRICES, LIMITS):
                with self.subTest(url=url, query=query):
                    error = self.get(url, query, status=400)["error"]
                    self.assertEqual((error["code"], error["fields"]), ("invalid_parameter", fields))
        error = self.get(CATEGORY, "category=0", status=400)["error"]
        self.assertEqual(list(error["fields"]), ["category"])

    def test_period_from_to_is_the_same_window(self):
        BudgetLimit.objects.create(user=local_user(), category=self.food, currency_id="EUR", amount=D("5"))
        for url in (MONTHLY, CATEGORY, PRICES, LIMITS):
            with self.subTest(url=url):
                body = self.get(url, PERIOD)
                self.assertEqual((body["months"], body["month_from"], body["month_to"]), (4, "2026-06", "2026-09"))
                self.assertEqual(body, self.get(url, WINDOW))
        self.assertEqual(self.get(CATEGORY, f"{PERIOD}&category={self.dairy.pk}"),
                         self.get(CATEGORY, f"{WINDOW}&category={self.dairy.pk}"))

    def test_period_bounds_and_defaults(self):
        one = self.get(MONTHLY, "from=2026-09&to=2026-09")
        self.assertEqual((one["months"], one["month_from"], one["month_to"]), (1, "2026-09", "2026-09"))
        longest = self.get(MONTHLY, "from=2021-10&to=2026-09")
        self.assertEqual((longest["months"], longest["month_from"]), (60, "2021-10"))
        self.assertEqual([len(block["months"]) for block in longest["currencies"]], [60, 60])
        self.assertEqual(self.get(MONTHLY, "months=60&month=2026-09"), longest)
        across = self.get(MONTHLY, "from=2025-11&to=2026-02")
        self.assertEqual(across["currencies"], [])  # через Новый год, чеков в окне нет
        self.assertEqual((across["months"], across["month_from"], across["month_to"]), (4, "2025-11", "2026-02"))
        with mock.patch("api.views.stats_trends.timezone.localdate", return_value=date(2026, 9, 14)):
            only_from = self.get(MONTHLY, "from=2026-06")
            only_to = self.get(MONTHLY, "to=2026-07")
            empty_values = self.get(MONTHLY, "from=&to=&months=")
            future = self.get(MONTHLY, "from=2026-10", status=400)["error"]["fields"]
        self.assertEqual((only_from["months"], only_from["month_from"], only_from["month_to"]), (4, "2026-06", "2026-09"))
        self.assertEqual((only_to["months"], only_to["month_from"], only_to["month_to"]), (12, "2025-08", "2026-07"))
        self.assertEqual((empty_values["months"], empty_values["month_to"]), (12, "2026-09"))
        self.assertEqual(future, {"from": ["Начало периода позже конца."]})

    def test_range_of_the_receipts(self):
        with mock.patch("api.views.stats_trends.timezone.localdate", return_value=date(2026, 10, 12)):
            body = self.get(RANGE, "")
        self.assertEqual(body, {"first_month": "2026-05", "last_month": "2026-10", "current_month": "2026-10", "max_months": 60})
        Receipt.objects.all().delete()
        with mock.patch("api.views.stats_trends.timezone.localdate", return_value=date(2027, 1, 2)):
            self.assertEqual(self.get(RANGE, ""),
                             {"first_month": None, "last_month": None, "current_month": "2027-01", "max_months": 60})

    def test_query_count_does_not_grow_with_data(self):
        # Категории, строки, итоги чеков, товары; у цен — покупки и имена.
        BudgetLimit.objects.create(user=local_user(), category=self.food, currency_id="EUR", amount=D("5"))
        cases = ((MONTHLY, 4), (CATEGORY, 4), (PRICES, 2), (LIMITS, 7), (RANGE, 1))

        def measure():
            for url, expected in cases:
                for query in (f"{WINDOW}&months=24", "from=2021-10&to=2026-09"):
                    with self.subTest(url=url, query=query), self.assertNumQueries(expected):
                        self.get(url, query)

        measure()
        store = samples.lidl_store()
        for number in range(30):
            category = Category.objects.create(name=f"Демо-категория {number}", parent=self.food)
            generic = GenericProduct.objects.create(name=f"Демо-род {number}", category=category, base_unit=BaseUnit.PCS)
            item = make_product(generic, f"Демо-товар {number}")
            for on in (date(2026, 6, 2 + number % 20), date(2026, 8, 2 + number % 20)):
                Lines(make_receipt(store, "EUR", on, total=D("2.00"))).add(item, "1.50").add(None, "0.50", raw_name="X")
            spend(local_user(), category, "10", date(2026, 7, 1), currency="EUR")
        measure()
        self.assertEqual(self.get(PRICES)["currencies"][0]["products_total"], 32)

    def test_methods_and_access(self):
        self.assertEqual(APIClient().post(MONTHLY, {}, format="json").status_code, 405)
        with self.settings(ALLOW_LOCAL_RECOGNITION_API=False):
            for url in (MONTHLY, CATEGORY, PRICES, LIMITS, RANGE):
                self.assertEqual(APIClient().get(url).status_code, 403)
        self.assertEqual(APIClient().get("/api/stats/trends/").status_code, 404)


@tag("integration")
@accounts_mode()
class TrendsFamilyTests(TrendsFixture, TwoUsers, TestCase):
    """Чеки ``third`` видит ``first`` из той же семьи; ``second`` вне семьи видит только свои."""

    @classmethod
    def fixture_owner(cls):
        cls.third = make_user("synthetic-user-three")
        family = Household.objects.create(name="Демо-семья")
        for account in (cls.first, cls.third):
            Membership.objects.create(user=account, household=family)
        return cls.third

    def get(self, account, url, query=WINDOW):
        response = self.client_of(account).get(f"{url}?{query}")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_family_member_sees_family_trends(self):
        spend(self.first, self.utilities, "1000", date(2026, 7, 1))
        for account in (self.first, self.third):
            kzt = self.get(account, MONTHLY)["currencies"][1]
            self.assertEqual([entry["total"] for entry in kzt["months"]],
                             ["30650.00", "1000.00", "32000.00", "35650.00"])
            self.assertEqual(len(self.get(account, PRICES)["currencies"]), 2)
            self.assertEqual(self.get(account, CATEGORY, f"{WINDOW}&category={self.utilities.pk}")["currencies"][0]
                             ["total"], "98000.00")

    def test_outsider_sees_only_own(self):
        spend(self.second, self.utilities, "70", date(2026, 8, 11))
        body = self.get(self.second, MONTHLY)
        self.assertEqual([(block["currency"], block["total"]) for block in body["currencies"]], [("KZT", "70.00")])
        self.assertEqual(self.get(self.second, PRICES)["currencies"], [])
        category = self.get(self.second, CATEGORY)
        self.assertEqual(category["category"]["id"], self.housing.pk)
        self.assertEqual([option["id"] for option in category["options"]], [self.housing.pk, self.utilities.pk])
        self.assertNotIn("70.00", str(self.get(self.first, MONTHLY)))
        own = self.get(self.second, RANGE, "")
        self.assertEqual((own["first_month"], own["last_month"]), ("2026-08", "2026-08"))
        self.assertEqual(self.get(self.first, RANGE, "")["first_month"], "2026-05")

    def test_family_limit_history_counts_family_spends(self):
        family = Household.objects.get(name="Демо-семья")
        BudgetLimit.objects.create(household=family, category=self.housing, currency_id="KZT", amount=D("40000"))
        BudgetLimit.objects.create(user=self.second, category=self.housing, currency_id="KZT", amount=D("100"))
        spend(self.second, self.utilities, "70", date(2026, 8, 11))
        (limit,) = self.get(self.first, LIMITS)["limits"]
        self.assertEqual([entry["percent"] for entry in limit["months"]], ["75.00", "0.00", "80.00", "87.50"])
        (own,) = self.get(self.second, LIMITS)["limits"]
        self.assertEqual([entry["percent"] for entry in own["months"]], ["0.00", "0.00", "70.00", "0.00"])

    def test_guest_is_not_authenticated(self):
        for url in (MONTHLY, CATEGORY, PRICES, LIMITS, RANGE):
            self.assertEqual(APIClient().get(url).status_code, 401)


@tag("integration")
@local_single_mode()
class UtilitiesShapeTests(TestCase):
    """Как на сервере: полгода коммуналки и аренды ручными тратами по подкатегориям (май — октябрь 2026)."""

    maxDiff = None

    @classmethod
    def setUpTestData(cls):
        owner = local_user()
        cls.housing = Category.objects.create(name="Демо-жильё")
        cls.utilities = Category.objects.create(name="Демо-коммунальные услуги", parent=cls.housing)
        cls.rent = Category.objects.create(name="Демо-аренда", parent=cls.housing)
        cls.children = {
            name: Category.objects.create(name=name, parent=cls.utilities)
            for name in ("Демо-электричество", "Демо-вода", "Демо-отопление и газ", "Демо-вывоз мусора", "Демо-ОСИ")
        }
        bills = {"Демо-электричество": 9000, "Демо-вода": 3000, "Демо-отопление и газ": 12000, "Демо-вывоз мусора": 800, "Демо-ОСИ": 4000}
        for number, month_number in enumerate(range(5, 11)):
            on = date(2026, month_number, 5)
            for name, amount in bills.items():
                # Отопление — только в холодные месяцы; остальное растёт понемногу.
                if name == "Демо-отопление и газ" and month_number in (6, 7, 8):
                    continue
                spend(owner, cls.children[name], str(amount + number * 100), on)
            spend(owner, cls.rent, "150000", on)
        spend(owner, cls.utilities, "500", date(2026, 10, 20))  # без подкатегории

    def get(self, url, query):
        response = APIClient().get(f"{url}?{query}")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_utilities_over_time_with_children(self):
        body = self.get(CATEGORY, f"month=2026-10&months=6&category={self.utilities.pk}")
        (kzt,) = body["currencies"]
        self.assertEqual([entry["amount"] for entry in kzt["months"]],
                         ["28800.00", "17200.00", "17600.00", "18000.00", "30800.00", "31800.00"])
        parts = [(part["name"], part["direct"], part["amounts"][-1]) for part in kzt["parts"]]
        self.assertEqual(parts, [
            # По убыванию суммы за окно (отопления летом нет); строки самой категории — последними.
            ("Демо-электричество", False, "9500.00"), ("Демо-отопление и газ", False, "12500.00"), ("Демо-ОСИ", False, "4500.00"),
            ("Демо-вода", False, "3500.00"), ("Демо-вывоз мусора", False, "1300.00"), ("Демо-коммунальные услуги", True, "500.00"),
        ])
        self.assertEqual(kzt["parts"][1]["amounts"][1:4], ["0.00", "0.00", "0.00"])
        for index, entry in enumerate(kzt["months"]):
            self.assertEqual(sum(D(part["amounts"][index]) for part in kzt["parts"]), D(entry["amount"]))
        self.assertEqual([option["depth"] for option in body["options"]], [0, 1, 1, 2, 2, 2, 2, 2])

    def test_month_to_month_rows_show_rent_and_utilities(self):
        (kzt,) = self.get(MONTHLY, "month=2026-10&months=6")["currencies"]
        self.assertEqual([(row["name"], row["depth"], row["change_percent"]) for row in kzt["rows"]], [
            ("Демо-жильё", 0, "0.55"), ("Демо-аренда", 1, "0.00"), ("Демо-коммунальные услуги", 1, "3.25"),
        ])


@tag("integration")
@local_single_mode()
class RealShapeMonthRowsTests(TestCase):
    """Как у человека на iPhone: аренда 200 000 в июне и 220 000 с июля, коммуналка и ОСИ помесячно; окно 6 месяцев до октября."""

    @classmethod
    def setUpTestData(cls):
        owner = local_user()
        cls.housing = Category.objects.create(name="Демо-жильё")
        cls.rent = Category.objects.create(name="Демо-аренда", parent=cls.housing)
        cls.utilities = Category.objects.create(name="Демо-коммунальные услуги", parent=cls.housing)
        cls.osi = Category.objects.create(name="Демо-ОСИ/КСК", parent=cls.housing)
        spend(owner, cls.rent, "200000", date(2026, 6, 1))
        for month_number in range(7, 11):
            spend(owner, cls.rent, "220000", date(2026, month_number, 1))
        for month_number, amount in ((5, "9800"), (6, "8100"), (7, "7900"), (8, "8300"), (9, "10732"), (10, "18923")):
            spend(owner, cls.utilities, amount, date(2026, month_number, 10))
        for month_number, amount in ((9, "9659"), (10, "9269")):
            spend(owner, cls.osi, amount, date(2026, month_number, 12))

    def rows(self, query):
        response = APIClient().get(f"{MONTHLY}?{query}")
        self.assertEqual(response.status_code, 200, response.content)
        (kzt,) = response.json()["currencies"]
        return {row["name"]: row for row in kzt["rows"]}

    def test_every_row_has_every_month_of_the_window(self):
        for query in ("month=2026-10&months=6", "from=2026-05&to=2026-10"):
            with self.subTest(query=query):
                rows = self.rows(query)
                rent = rows["Демо-аренда"]
                self.assertEqual(rent["amounts"], ["0.00", "200000.00", "220000.00", "220000.00", "220000.00", "220000.00"])
                self.assertEqual(rent["change_percents"], [None, None, "10.00", "0.00", "0.00", "0.00"])
                self.assertEqual((rent["total"], rent["average"]), ("1080000.00", "180000.00"))
                utilities = rows["Демо-коммунальные услуги"]
                self.assertEqual(utilities["amounts"][-2:], ["10732.00", "18923.00"])
                self.assertEqual(utilities["change_percents"][-1], "76.32")
                self.assertEqual(rows["Демо-ОСИ/КСК"]["amounts"], ["0.00"] * 4 + ["9659.00", "9269.00"])
                self.assertTrue(all(len(row["amounts"]) == 6 and len(row["change_percents"]) == 6 for row in rows.values()))
        self.assertEqual(len(self.rows("from=2026-09&to=2026-10")["Демо-аренда"]["amounts"]), 2)
