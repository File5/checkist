import json
from datetime import date, datetime, time, timedelta, timezone
from decimal import Decimal

from django.test import SimpleTestCase, TestCase, override_settings, tag

from api.tests import factories
from api.tests.factories import make_product, observe
from api.views import price_series
from catalog.models import Category, GenericProduct
from catalog.units import Unit
from merges import services
from merges.models import ProductMerge, ProductMergeMember
from receipts.models import Receipt, ReceiptLine
from receipts.tests import samples
from stores.models import Store

D = Decimal
INVALID = {"code": "invalid_parameter", "message": "Некорректные параметры запроса."}
NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}
TOO_LARGE = {"error": {
    "code": "range_too_large", "message": "Слишком большой диапазон: сузьте даты или укрупните интервал.",
}}
BODY_KEYS = {
    "product", "generic", "price", "interval", "skipped_without_normalized", "series", "own_truncated", "similar",
}
SERIES_KEYS = {"role", "product", "store", "country", "currency", "unit", "comparable", "observations", "points"}
POINT_KEYS = {"period_start", "count", "min", "max", "avg", "last"}


def url(product):
    return f"/api/products/{getattr(product, 'pk', product)}/prices/series/"


def point(period_start, count, low, high=None, avg=None, last=None):
    """Точка; без ``high``, ``avg`` и ``last`` все цены интервала равны ``low``."""
    return {
        "period_start": period_start, "count": count, "min": low, "max": high or low,
        "avg": avg or low, "last": last or high or low,
    }


def similar(status, total=0, shown=0):
    return {"status": status, "products_total": total, "products_shown": shown}


def absorb(target, source):
    """Ожидающая группа слияния: ``source`` поглощён ``target``; строки не переносятся."""
    group = ProductMerge.objects.create(target_ref=target.pk, detector_version=1)
    for product, role in ((target, "target"), (source, "source")):
        ProductMergeMember.objects.create(
            group=group, product_ref=product.pk, active_product=product, role=role, name=product.name,
        )
    return group


def bulk_days(product, store, start, days, currency="EUR"):
    """По одной покупке товара в каждый из ``days`` дней подряд, цена 1.00."""
    dates = [start + timedelta(days=offset) for offset in range(days)]
    receipts = Receipt.objects.bulk_create([
        Receipt(
            store=store, currency_id=currency, operation=Receipt.Operation.SALE,
            purchased_at=datetime.combine(day, time(12, 0), tzinfo=timezone.utc), purchased_on=day,
            receipt_number=f"series-{product.pk}-{store.pk}-{offset}", total=D("1.00"),
        )
        for offset, day in enumerate(dates)
    ])
    ReceiptLine.objects.bulk_create([
        ReceiptLine(
            receipt=receipt, position=1, kind=ReceiptLine.Kind.PRODUCT, raw_name="Молоко", product=product,
            quantity=D("1"), unit=Unit.PCS, unit_price=D("1.00"), amount=D("1.00"),
        )
        for receipt in receipts
    ])
    return dates


class SeriesShapeTests(SimpleTestCase):
    """Сборка ряда из строк интервалов — без БД."""

    ROWS = [
        {"period": date(2026, 6, 1), "bucket_count": 3, "bucket_min": D("1.0000"), "bucket_max": D("2.0000"),
         "bucket_sum": D("4.0000"), "paid_unit_price": D("2.0000"), "normalized_price": D("2.0000"), "key": "a"},
        {"period": date(2026, 7, 1), "bucket_count": 1, "bucket_min": D("1.5"), "bucket_max": D("1.5"),
         "bucket_sum": D("1.5"), "paid_unit_price": D("1.5"), "normalized_price": D("1.5"), "key": "a"},
    ]

    def test_points_and_observations(self):
        series = price_series._series(
            "similar", (7, "Молоко"), None, "DE", "EUR", "pcs", self.ROWS, "paid_unit_price", "l",
        )
        self.assertEqual(set(series), SERIES_KEYS)
        self.assertEqual(series["product"], {"id": 7, "name": "Молоко"})
        self.assertEqual((series["role"], series["store"], series["observations"]), ("similar", None, 4))
        self.assertEqual(series["points"], [
            point("2026-06-01", 3, "1.0000", "2.0000", avg="1.3333"),  # 4 / 3, ROUND_HALF_UP
            point("2026-07-01", 1, "1.5000"),
        ])

    def test_comparable_only_for_normalized_price_in_base_unit(self):
        def comparable(value_field, unit, base_unit):
            return price_series._series("own", (1, "x"), None, "DE", "EUR", unit, self.ROWS, value_field, base_unit)[
                "comparable"
            ]

        self.assertTrue(comparable("normalized_price", "l", "l"))
        self.assertFalse(comparable("normalized_price", "kg", "l"))
        # Оплаченная цена за единицу строки несравнима, даже если единица совпала с базовой.
        self.assertFalse(comparable("paid_unit_price", "pcs", "pcs"))

    def test_grouped_keeps_row_order(self):
        rows = [{"key": "b", "n": 1}, {"key": "a", "n": 2}, {"key": "b", "n": 3}]
        grouped = price_series._grouped(rows, ("key",))
        self.assertEqual(list(grouped), [("b",), ("a",)])
        self.assertEqual([row["n"] for row in grouped[("b",)]], [1, 3])

    def test_limits(self):
        self.assertEqual(price_series.INTERVALS, ("month", "day", "week"))
        self.assertEqual((price_series.MAX_OWN_SERIES, price_series.MAX_SIMILAR, price_series.SIMILAR_LIMIT), (20, 20, 8))
        self.assertEqual(price_series.MAX_POINTS, 1000)


class SeriesTestCase(TestCase):
    def get(self, product, **query):
        return self.client.get(url(product), query)

    def body(self, product, **query):
        response = self.get(product, **query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def series(self, product, **query):
        return self.body(product, **query)["series"]

    def new_store(self, merchant, country, number, city="Musterstadt", zone="Europe/Berlin"):
        return Store.objects.create(
            merchant=merchant, country_id=country, name=f"Демо-магазин {number}", city=city,
            address_raw=f"Beispielallee {number}", address_key=f"beispielallee {number}", timezone=zone,
        )


@tag("integration")
class PriceSeriesTests(SeriesTestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = factories.save_samples()
        cls.lidl_milk, cls.shop_milk = cls.data.lidl_milk, cls.data.shop_milk
        cls.lidl, cls.shop = cls.data.lidl_store, cls.data.shop_store
        cls.milk = cls.data.milk
        cls.lidl_brief = {"id": cls.lidl.pk, "name": "Lidl", "city": "Lindau", "country": "DE"}
        # Образцы: шесть покупок в Lidl (четыре в июне, по одной в июле и октябре), одна в магазине RU.
        cls.own = {
            "role": "own", "product": {"id": cls.lidl_milk.pk, "name": samples.MILK}, "store": cls.lidl_brief,
            "country": "DE", "currency": "EUR", "unit": "pcs", "comparable": False, "observations": 6,
            "points": [point("2026-06-01", 4, "1.0500"), point("2026-07-01", 1, "1.0500"),
                       point("2026-10-01", 1, "1.0900")],
        }
        cls.shop_series = {
            "role": "similar", "product": {"id": cls.shop_milk.pk, "name": samples.SHOP_MILK_NAME}, "store": None,
            "country": "RU", "currency": "RUB", "unit": "pcs", "comparable": False, "observations": 1,
            "points": [point("2026-09-01", 1, "111.0000")],
        }

    def new_product(self, name="Молоко 1 л", package=("1", Unit.L), generic=None):
        return make_product(generic or self.milk, name, package=package)

    def new_generic(self, name="Кефир", base_unit="l"):
        return GenericProduct.objects.create(name=name, category=self.milk.category, base_unit=base_unit)

    # --- тело ответа ---

    def test_exact_default_body(self):
        response = self.get(self.lidl_milk)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Content-Type"], "application/json")
        self.assertEqual(response.json(), {
            "product": {"id": self.lidl_milk.pk, "name": samples.MILK, "base_unit": "l"},
            "generic": {"id": self.milk.pk, "name": "Молоко", "base_unit": "l"},
            "price": "paid", "interval": "month",
            "skipped_without_normalized": 0,
            "series": [self.own, self.shop_series],
            "own_truncated": False,
            "similar": similar("ok", 1, 1),
        })

    def test_body_from_the_other_side(self):
        body = self.body(self.shop_milk)
        own, other = body["series"]
        self.assertEqual(own, {
            **self.shop_series, "role": "own",
            "store": {"id": self.shop.pk, "name": own["store"]["name"], "city": self.shop.city, "country": "RU"},
        })
        self.assertEqual(other, {**self.own, "role": "similar", "store": None})
        self.assertEqual(body["similar"], similar("ok", 1, 1))

    def test_shape_and_decimal_strings(self):
        Receipt.objects.update(raw_text="RAW-TEXT-OF-RECEIPT")
        for product in (self.lidl_milk, self.shop_milk, self.data.ssd):
            for price in ("paid", "normalized"):
                with self.subTest(product=product.name, price=price):
                    body = self.body(product, price=price, interval="day")
                    self.assertEqual(set(body), BODY_KEYS)
                    self.assertEqual(set(body["similar"]), {"status", "products_total", "products_shown"})
                    for entry in body["series"]:
                        self.assertEqual(set(entry), SERIES_KEYS)
                        self.assertEqual(set(entry["product"]), {"id", "name"})
                        if entry["role"] == "own":
                            self.assertEqual(set(entry["store"]), {"id", "name", "city", "country"})
                        else:
                            self.assertIsNone(entry["store"])
                        self.assertEqual(entry["observations"], sum(item["count"] for item in entry["points"]))
                        for item in entry["points"]:
                            self.assertEqual(set(item), POINT_KEYS)
                            self.assertIsInstance(item["count"], int)
                            for key in ("min", "max", "avg", "last"):
                                self.assertRegex(item[key], r"^\d+\.\d{4}$")
                    text = json.dumps(body, ensure_ascii=False)
                    for secret in (
                        "RAW-TEXT-OF-RECEIPT", "Соколов", "420500000000", "ДНС КАЗАХСТАН", "210140004940",
                        "DE813389027", "Иванова", samples.LIDL_REGISTER_SERIAL, "synthetic-",
                    ):
                        self.assertNotIn(secret, text)

    # --- интервалы и точки ---

    def test_intervals(self):
        product = self.new_product(generic=self.new_generic())
        # 2026-06-29 — понедельник; 28-е — воскресенье предыдущей недели.
        for day, price in ((date(2026, 6, 28), "1.00"), (date(2026, 6, 29), "1.10"), (date(2026, 7, 1), "1.30"),
                           (date(2026, 7, 5), "1.20"), (date(2026, 7, 6), "1.40")):
            observe(product, self.lidl, "EUR", day, price)
        cases = {
            "month": [point("2026-06-01", 2, "1.0000", "1.1000", avg="1.0500"),
                      point("2026-07-01", 3, "1.2000", "1.4000", avg="1.3000")],
            "week": [point("2026-06-22", 1, "1.0000"),
                     point("2026-06-29", 3, "1.1000", "1.3000", avg="1.2000", last="1.2000"),
                     point("2026-07-06", 1, "1.4000")],
            "day": [point("2026-06-28", 1, "1.0000"), point("2026-06-29", 1, "1.1000"),
                    point("2026-07-01", 1, "1.3000"), point("2026-07-05", 1, "1.2000"),
                    point("2026-07-06", 1, "1.4000")],
        }
        for interval, points in cases.items():
            with self.subTest(interval=interval):
                body = self.body(product, interval=interval)
                (entry,) = body["series"]
                self.assertEqual(body["interval"], interval)
                self.assertEqual(entry["points"], points)
                self.assertEqual(entry["observations"], 5)
        self.assertEqual(self.body(product)["interval"], "month")

    def test_last_is_the_last_observation_and_avg_is_simple(self):
        product = self.new_product(generic=self.new_generic())
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.00", at=time(9, 0))
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "3.00", at=time(18, 0))
        # Количество не взвешивает среднее: (1.00 + 3.00 + 1.25) / 3.
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.25", at=time(10, 0), quantity="10")
        (entry,) = self.series(product, interval="day")
        self.assertEqual(entry["points"], [point("2026-07-01", 3, "1.0000", "3.0000", avg="1.7500", last="3.0000")])

    def test_paid_price_includes_line_discount(self):
        product = self.new_product(generic=self.new_generic())
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "2.00", quantity="2", discount="1.00")
        (entry,) = self.series(product)
        self.assertEqual(entry["points"], [point("2026-07-01", 1, "1.5000")])

    def test_only_sale_product_lines_with_positive_quantity(self):
        product = self.new_product(generic=self.new_generic())
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.00")
        refund = observe(product, self.lidl, "EUR", date(2026, 7, 2), "9.00")
        Receipt.objects.filter(pk=refund.receipt_id).update(operation=Receipt.Operation.REFUND)
        observe(product, self.lidl, "EUR", date(2026, 7, 3), "9.00", kind=ReceiptLine.Kind.SERVICE)
        (entry,) = self.series(product, interval="day")
        self.assertEqual(entry["points"], [point("2026-07-01", 1, "1.0000")])

    # --- свои ряды ---

    def test_own_series_split_by_store_currency_and_unit(self):
        product = self.new_product(generic=self.new_generic())
        berlin = self.new_store(self.lidl.merchant, "DE", 1, city="Berlin")
        observe(product, berlin, "EUR", date(2026, 7, 1), "1.00")
        observe(product, berlin, "EUR", date(2026, 7, 2), "1.00")
        observe(product, berlin, "EUR", date(2026, 7, 3), "1.00")
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.10")
        observe(product, self.lidl, "EUR", date(2026, 7, 2), "1.10")
        observe(product, self.lidl, "KZT", date(2026, 7, 3), "600.00")
        observe(product, self.lidl, "KZT", date(2026, 7, 4), "600.00")
        observe(product, self.lidl, "EUR", date(2026, 7, 5), "0.90", quantity="1.5", unit=Unit.L)
        found = [(entry["store"]["id"], entry["currency"], entry["unit"], entry["observations"])
                 for entry in self.series(product)]
        # По убыванию наблюдений, затем магазин, валюта, единица.
        self.assertEqual(found, [
            (berlin.pk, "EUR", "pcs", 3), (self.lidl.pk, "EUR", "pcs", 2), (self.lidl.pk, "KZT", "pcs", 2),
            (self.lidl.pk, "EUR", "l", 1),
        ])
        self.assertLess(self.lidl.pk, berlin.pk)
        for entry in self.series(product):
            self.assertEqual((entry["role"], entry["country"], entry["comparable"]), ("own", "DE", False))

    def test_equal_observations_are_ordered_by_store_id(self):
        product = self.new_product(generic=self.new_generic())
        stores = [self.new_store(self.lidl.merchant, "DE", number) for number in range(3)]
        for store in reversed(stores):
            observe(product, store, "EUR", date(2026, 7, 1), "1.00")
        self.assertEqual([entry["store"]["id"] for entry in self.series(product)], [store.pk for store in stores])

    def test_own_truncated_keeps_20_series_with_most_observations(self):
        product = self.new_product(generic=self.new_generic())
        stores = [self.new_store(self.lidl.merchant, "DE", number) for number in range(21)]
        for store in stores[:20]:
            observe(product, store, "EUR", date(2026, 7, 1), "1.00")
        body = self.body(product)
        self.assertFalse(body["own_truncated"])
        self.assertEqual(len(body["series"]), 20)

        # Двадцать первый магазин; у первого и последнего — по второму наблюдению.
        observe(product, stores[20], "EUR", date(2026, 7, 1), "1.00")
        observe(product, stores[20], "EUR", date(2026, 7, 2), "1.00")
        observe(product, stores[0], "EUR", date(2026, 7, 2), "1.00")
        body = self.body(product)
        self.assertTrue(body["own_truncated"])
        shown = [entry["store"]["id"] for entry in body["series"]]
        # Отброшен ряд с одним наблюдением и наибольшим id магазина.
        self.assertEqual(shown, [stores[0].pk, stores[20].pk, *(store.pk for store in stores[1:19])])
        self.assertEqual([entry["observations"] for entry in body["series"]], [2, 2, *[1] * 18])
        # Усечение считает ряды, а не магазины: фильтр возвращает полный набор.
        body = self.body(product, date_from="2026-07-02", date_to="2026-07-02")
        self.assertEqual((body["own_truncated"], len(body["series"])), (False, 2))

    # --- нормализованная цена ---

    def test_normalized_price(self):
        body = self.body(self.lidl_milk, price="normalized")
        self.assertEqual(body["price"], "normalized")
        # У товара Lidl нет фасовки: все шесть наблюдений пропущены, своих рядов нет.
        self.assertEqual(body["skipped_without_normalized"], 6)
        self.assertEqual(body["series"], [{
            **self.shop_series, "unit": "l", "comparable": True,
            "points": [point("2026-09-01", 1, "130.5882")],  # 111.00 за 850 мл
        }])
        self.assertEqual(body["similar"], similar("ok", 1, 1))

        body = self.body(self.shop_milk, price="normalized")
        self.assertEqual(body["skipped_without_normalized"], 0)
        (own,) = body["series"]
        self.assertEqual((own["role"], own["unit"], own["comparable"]), ("own", "l", True))
        # У похожего товара Lidl нормализованных наблюдений нет — в счёт похожих он не идёт.
        self.assertEqual(body["similar"], similar("none"))

    def test_normalized_unit_other_than_base_unit_is_not_comparable(self):
        line = factories.unit_mismatch(self.data)  # «Молоко сухое 500 г» у продукта с base_unit='l'
        body = self.body(line.product, price="normalized")
        (own, other) = body["series"]
        self.assertEqual((own["unit"], own["comparable"]), ("kg", False))
        self.assertEqual(own["points"], [point("2026-07-01", 1, "3.0000")])
        self.assertEqual((other["product"]["id"], other["comparable"]), (self.shop_milk.pk, True))

    def test_skipped_counts_only_own_product_in_filters(self):
        product = self.new_product("Молоко без фасовки", package=None)
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.00")
        observe(product, self.lidl, "EUR", date(2026, 8, 1), "1.00")
        observe(product, self.lidl, "EUR", date(2026, 8, 2), "2.00", quantity="0.5", unit=Unit.L)
        body = self.body(product, price="normalized")
        self.assertEqual(body["skipped_without_normalized"], 2)
        (own,) = [entry for entry in body["series"] if entry["role"] == "own"]
        self.assertEqual(own["points"], [point("2026-08-01", 1, "2.0000")])
        self.assertEqual(self.body(product, price="normalized", date_from="2026-08-01")["skipped_without_normalized"], 1)
        self.assertEqual(self.body(product, price="normalized", country="RU")["skipped_without_normalized"], 0)
        self.assertEqual(self.body(product, date_from="2026-08-01")["skipped_without_normalized"], 0)

    # --- похожие товары ---

    def test_similar_none_disables_search(self):
        body = self.body(self.lidl_milk, similar="none")
        self.assertEqual(body["series"], [self.own])
        self.assertEqual(body["similar"], similar("disabled"))

    def test_generic_unassigned(self):
        category = Category.objects.create(name="Не разобрано")
        generic = GenericProduct.objects.create(name="Не разобрано", category=category, base_unit="pcs")
        product = self.new_product("Unbekannt A", package=None, generic=generic)
        other = self.new_product("Unbekannt B", package=None, generic=generic)
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.00")
        observe(other, self.lidl, "EUR", date(2026, 7, 1), "2.00")
        body = self.body(product)
        self.assertEqual([entry["role"] for entry in body["series"]], ["own"])
        self.assertEqual(body["similar"], similar("generic_unassigned"))
        self.assertEqual(body["generic"], {"id": generic.pk, "name": "Не разобрано", "base_unit": "pcs"})
        # Явное similar=none важнее: поиск выключен.
        self.assertEqual(self.body(product, similar="none")["similar"], similar("disabled"))

    def test_status_none_without_other_products(self):
        body = self.body(self.data.ssd)
        self.assertEqual([entry["role"] for entry in body["series"]], ["own"])
        self.assertEqual(body["similar"], similar("none"))
        # Товар того же продукта без наблюдений похожим не считается.
        make_product(self.data.ssd_generic, "SSD без покупок")
        self.assertEqual(self.body(self.data.ssd)["similar"], similar("none"))

    def test_similar_limit_and_order(self):
        generic = self.new_generic()
        product = self.new_product("Кефир свой", generic=generic)
        observe(product, self.lidl, "EUR", date(2026, 7, 1), "1.00")
        names = ("Кефир В", "Кефир А", "Кефир Б", "Кефир А")  # два товара с одним названием
        others = [make_product(generic, name, package=(str(index + 1), Unit.L)) for index, name in enumerate(names)]
        counts = (1, 2, 3, 2)
        for other, count in zip(others, counts):
            for day in range(count):
                observe(other, self.lidl, "EUR", date(2026, 7, 1 + day), "1.00")

        def shown(**query):
            body = self.body(product, **query)
            return [entry["product"]["id"] for entry in body["series"] if entry["role"] == "similar"], body["similar"]

        # Ряды — по name, id товара.
        self.assertEqual(shown(), ([others[1].pk, others[3].pk, others[2].pk, others[0].pk], similar("ok", 4, 4)))
        # Отбор — по числу наблюдений, затем name, id.
        self.assertEqual(shown(similar_limit=1), ([others[2].pk], similar("ok", 4, 1)))
        self.assertEqual(shown(similar_limit=2), ([others[1].pk, others[2].pk], similar("ok", 4, 2)))
        self.assertEqual(
            shown(similar_limit=3), ([others[1].pk, others[3].pk, others[2].pk], similar("ok", 4, 3)),
        )
        # Число наблюдений считается в окне фильтров.
        self.assertEqual(
            shown(similar_limit=1, date_from="2026-07-01", date_to="2026-07-01"),
            ([others[1].pk], similar("ok", 4, 1)),
        )
        self.assertEqual(shown(similar_limit=20)[1], similar("ok", 4, 4))

    def test_default_similar_limit_is_8(self):
        generic = self.new_generic()
        product = self.new_product("Кефир свой", generic=generic)
        for number in range(10):
            other = make_product(generic, f"Кефир {number:02}", package=("1", Unit.L))
            observe(other, self.lidl, "EUR", date(2026, 7, 1), "1.00")
        body = self.body(product)
        self.assertEqual(body["similar"], similar("ok", 10, 8))
        self.assertEqual([entry["product"]["name"] for entry in body["series"]],
                         [f"Кефир {number:02}" for number in range(8)])
        # У товара без своих наблюдений похожие ряды остаются.
        self.assertTrue(all(entry["role"] == "similar" for entry in body["series"]))

    def test_similar_series_split_by_country_currency_and_unit(self):
        generic = self.new_generic()
        product = self.new_product("Кефир свой", generic=generic)
        other = self.new_product("Кефир чужой", generic=generic)
        berlin = self.new_store(self.lidl.merchant, "DE", 1, city="Berlin")
        observe(other, self.shop, "RUB", date(2026, 7, 1), "90.00")
        observe(other, self.lidl, "EUR", date(2026, 7, 1), "1.00")
        observe(other, berlin, "EUR", date(2026, 7, 2), "1.20")  # другой магазин той же страны — тот же ряд
        observe(other, self.lidl, "KZT", date(2026, 7, 1), "550.00")
        observe(other, self.lidl, "EUR", date(2026, 7, 3), "0.80", quantity="2", unit=Unit.L)
        found = self.series(product)
        self.assertEqual(
            [(entry["country"], entry["currency"], entry["unit"], entry["observations"]) for entry in found],
            [("DE", "EUR", "l", 1), ("DE", "EUR", "pcs", 2), ("DE", "KZT", "pcs", 1), ("RU", "RUB", "pcs", 1)],
        )
        self.assertEqual(found[1]["points"], [point("2026-07-01", 2, "1.0000", "1.2000", avg="1.1000")])
        self.assertTrue(all(entry["store"] is None and entry["role"] == "similar" for entry in found))
        # Цены разных валют не смешаны: у каждого ряда своя валюта.
        self.assertEqual(self.body(product)["similar"], similar("ok", 1, 1))

    # --- фильтры ---

    def test_country_list_and_currency(self):
        def roles(**query):
            return [(entry["role"], entry["country"]) for entry in self.series(self.lidl_milk, **query)]

        self.assertEqual(roles(country="DE"), [("own", "DE")])
        self.assertEqual(roles(country="RU"), [("similar", "RU")])
        self.assertEqual(roles(country="de, ru"), [("own", "DE"), ("similar", "RU")])
        self.assertEqual(roles(country="KZ"), [])
        self.assertEqual(roles(currency="rub"), [("similar", "RU")])
        self.assertEqual(roles(currency="EUR", country="RU"), [])
        self.assertEqual(self.body(self.lidl_milk, country="DE")["similar"], similar("none"))
        self.assertEqual(self.body(self.lidl_milk, country="KZ")["series"], [])

    def test_dates_are_inclusive_local_dates(self):
        def points(**query):
            return [item["period_start"] for item in self.series(self.lidl_milk, similar="none", **query)[0]["points"]]

        self.assertEqual(points(date_from="2026-07-01"), ["2026-07-01", "2026-10-01"])
        self.assertEqual(points(date_from="2026-06-02", date_to="2026-06-02", interval="day"), ["2026-06-02"])
        self.assertEqual(points(date_to="2026-10-01", date_from="2026-10-01", interval="day"), ["2026-10-01"])
        self.assertEqual(self.series(self.lidl_milk, date_from="2026-10-02"), [])
        # Чек около полуночи относится к локальной дате магазина, а не к дате UTC.
        product = self.new_product(generic=self.new_generic())
        almaty = self.data.dns_store
        observe(product, almaty, "KZT", date(2026, 8, 1), "500.00", at=time(0, 30))
        (entry,) = self.series(product, interval="day", date_from="2026-08-01", date_to="2026-08-01")
        self.assertEqual(entry["points"], [point("2026-08-01", 1, "500.0000")])
        self.assertEqual(self.series(product, date_to="2026-07-31"), [])

    def test_unknown_and_empty_parameters_are_ignored(self):
        default = self.body(self.lidl_milk)
        self.assertEqual(self.body(self.lidl_milk, store="999", group_by="x", ordering="y", page="0"), default)
        self.assertEqual(self.body(
            self.lidl_milk, price="", interval=" ", similar="", similar_limit="", country="", currency="",
            date_from="", date_to="",
        ), default)

    # --- пусто и 404 ---

    def test_product_without_observations(self):
        product = self.new_product(generic=self.new_generic())
        for query in ({}, {"price": "normalized"}, {"interval": "day"}):
            with self.subTest(query=query):
                body = self.body(product, **query)
                self.assertEqual(body["series"], [])
                self.assertEqual(body["own_truncated"], False)
                self.assertEqual(body["skipped_without_normalized"], 0)
                self.assertEqual(body["similar"], similar("none"))
        self.assertEqual(self.body(product, similar="none")["similar"], similar("disabled"))

    def test_not_found(self):
        absorbed = self.new_product("Молоко дубль")
        absorb(self.shop_milk, absorbed)
        for pk in (999999, 2**63 - 1, 2**63, absorbed.pk):
            with self.subTest(pk=pk):
                response = self.get(pk)
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), NOT_FOUND)
        # 404 раньше разбора параметров, как у /prices/.
        self.assertEqual(self.get(999999, interval="year").status_code, 404)
        self.assertEqual(self.client.get("/api/products/abc/prices/series/").status_code, 404)

    # --- слитые товары ---

    def test_absorbed_product_is_not_similar_and_its_lines_belong_to_the_target(self):
        duplicate = self.new_product("Молоко Фермерское дубль", package=("850", Unit.ML))
        observe(duplicate, self.shop, "RUB", date(2026, 9, 5), "119.00")
        before = self.body(self.lidl_milk)
        self.assertEqual(before["similar"], similar("ok", 2, 2))
        self.assertIn(duplicate.pk, [entry["product"]["id"] for entry in before["series"]])

        group = absorb(self.shop_milk, duplicate)
        body = self.body(self.lidl_milk)
        self.assertEqual(body["similar"], similar("ok", 1, 1))
        self.assertNotIn(duplicate.name, json.dumps(body, ensure_ascii=False))
        self.assertNotIn(duplicate.pk, [entry["product"]["id"] for entry in body["series"]])
        # «Отбившаяся» строка поглощённого товара относится к оставляемому.
        merged = {**self.shop_series, "observations": 2,
                  "points": [point("2026-09-01", 2, "111.0000", "119.0000", avg="115.0000", last="111.0000")]}
        self.assertEqual(body["series"], [self.own, merged])
        own = self.series(self.shop_milk, similar="none")
        self.assertEqual([(entry["role"], entry["observations"]) for entry in own], [("own", 2)])
        # Слитый дубль другого обобщённого продукта не делает товар похожим.
        foreign = self.new_product("Кефир дубль", generic=self.new_generic())
        absorb(self.data.ssd, foreign)
        self.assertEqual(self.body(foreign.generic.products.create(name="Кефир свой"))["similar"], similar("none"))

        services.cancel(group.pk)
        self.assertEqual(self.body(self.lidl_milk), before)

    def test_target_of_a_group_stays_visible(self):
        absorb(self.shop_milk, self.new_product("Молоко дубль"))
        self.assertEqual(self.body(self.shop_milk)["series"][0]["role"], "own")
        self.assertEqual(self.body(self.lidl_milk)["series"], [self.own, self.shop_series])

    # --- запросы ---

    def test_query_count_is_constant(self):
        absorb(self.shop_milk, self.new_product("Молоко дубль"))
        observe(self.new_product("Молоко литр"), self.lidl, "EUR", date(2026, 7, 1), "1.00")
        cases = (
            # товар, ряды своего (2), магазины, похожие (2), их интервалы
            ({}, 7),
            ({"similar": "none"}, 4),
            # + пропущенные без нормализованной цены
            ({"price": "normalized", "interval": "day"}, 8),
            # + справочники страны и валюты
            ({"country": "DE,RU", "currency": "EUR", "date_from": "2026-01-01", "date_to": "2026-12-31"}, 9),
        )

        def measure():
            for query, expected in cases:
                with self.subTest(query=query), self.assertNumQueries(expected):
                    self.body(self.shop_milk if query.get("price") else self.lidl_milk, **query)

        measure()
        for number in range(12):
            store = self.new_store(self.lidl.merchant, "DE", number)
            other = make_product(self.milk, f"Молоко демо {number}", package=("1", Unit.L))
            for day in range(1, 4):
                observe(self.lidl_milk, store, "EUR", date(2026, 7, day), "1.00")
                observe(self.shop_milk, store, "EUR", date(2026, 7, day), "1.00")
                observe(other, store, "EUR", date(2026, 7, day), "1.00")
        measure()
        body = self.body(self.lidl_milk, similar_limit=20)
        self.assertEqual(body["similar"], similar("ok", 14, 14))
        # 13 магазинов своего товара; у похожего товара RU теперь два ряда — RUB и EUR.
        self.assertEqual([entry["role"] for entry in body["series"]], ["own"] * 13 + ["similar"] * 15)

    def test_invalid_request_does_not_read_lines(self):
        with self.assertNumQueries(1):  # только товар
            self.assertEqual(self.get(self.lidl_milk, interval="year").status_code, 400)
        product = self.new_product(generic=self.new_generic())
        with self.assertNumQueries(2):  # товар и его ряды: рядов нет — интервалы и магазины не читаются
            self.body(product, similar="none")

    # --- ошибки и доступ ---

    def assert_invalid(self, fields, **query):
        response = self.get(self.lidl_milk, **query)
        self.assertEqual(response.status_code, 400, response.content)
        self.assertEqual(response.json(), {"error": {**INVALID, "fields": fields}})

    def test_invalid_parameters(self):
        self.assert_invalid({"interval": ["Допустимые значения: month, day, week."]}, interval="none")
        self.assert_invalid({"interval": ["Допустимые значения: month, day, week."]}, interval="quarter")
        self.assert_invalid({"price": ["Допустимые значения: paid, normalized."]}, price="list")
        self.assert_invalid({"similar": ["Допустимые значения: generic, none."]}, similar="all")
        for value in ("0", "21", "-1", "abc", "1.5"):
            with self.subTest(similar_limit=value):
                self.assert_invalid({"similar_limit": ["Допустимо от 1 до 20."]}, similar_limit=value)
        self.assert_invalid({"date_from": ["Ожидается дата ГГГГ-ММ-ДД."]}, date_from="2026-13-01")
        self.assert_invalid({"date_from": ["Должна быть не позже date_to."]}, date_from="2026-07-02", date_to="2026-07-01")
        self.assert_invalid({"country": ["Ожидаются коды стран из двух букв через запятую."]}, country="DEU")
        self.assert_invalid({"country": ["Неизвестный код страны."]}, country="DE,ZZ")
        self.assert_invalid(
            {"country": ["Не больше 20 значений."]},
            country=",".join(f"{a}{b}" for a in "AB" for b in "ABCDEFGHIJK"[:11])[:62],
        )
        self.assert_invalid({"currency": ["Ожидается код валюты из трёх букв."]}, currency="EU")
        self.assert_invalid({"currency": ["Неизвестный код валюты."]}, currency="ZZZ")
        # Все ошибки — одним ответом.
        self.assert_invalid(
            {
                "date_to": ["Ожидается дата ГГГГ-ММ-ДД."], "currency": ["Неизвестный код валюты."],
                "interval": ["Допустимые значения: month, day, week."],
                "price": ["Допустимые значения: paid, normalized."],
                "similar": ["Допустимые значения: generic, none."],
                "similar_limit": ["Допустимо от 1 до 20."],
            },
            date_to="вчера", currency="ZZZ", interval="x", price="x", similar="x", similar_limit="x",
        )

    @override_settings(DEBUG=False, ALLOW_LOCAL_RECOGNITION_API=False)
    def test_access_is_open_like_other_read_endpoints(self):
        self.assertEqual(self.get(self.lidl_milk).status_code, 200)
        response = self.client.get(url(self.lidl_milk), REMOTE_ADDR="203.0.113.7")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.head(url(self.lidl_milk)).status_code, 200)

    def test_methods_and_trailing_slash(self):
        for method in ("post", "put", "patch", "delete"):
            with self.subTest(method=method):
                response = getattr(self.client, method)(url(self.lidl_milk))
                self.assertEqual(response.status_code, 405)
                self.assertEqual(response.json()["error"]["code"], "method_not_allowed")
        self.assertEqual(self.client.get(f"/api/products/{self.lidl_milk.pk}/prices/series/x/").status_code, 404)

    def test_existing_price_endpoints_are_untouched(self):
        points = self.client.get(f"/api/products/{self.lidl_milk.pk}/prices/").json()
        self.assertEqual(set(points), {"product", "count", "page", "page_size", "pages", "results"})
        summary = self.client.get(f"/api/products/{self.lidl_milk.pk}/prices/summary/", {"interval": "month"}).json()
        self.assertEqual(set(summary), {"product", "price", "group_by", "interval", "groups"})
        (group,) = summary["groups"]
        # Точки ряда — те же интервалы, что у сводки по стране.
        self.assertEqual(group["buckets"], self.own["points"])


@tag("integration")
class PriceSeriesRangeTests(SeriesTestCase):
    """Потолок 1000 точек на весь ответ: свои и похожие ряды вместе."""

    START = date(2024, 1, 1)

    @classmethod
    def setUpTestData(cls):
        data = factories.save_samples()
        generic = GenericProduct.objects.create(name="Кефир", category=data.milk.category, base_unit="l")
        cls.lidl = data.lidl_store
        cls.long = make_product(generic, "Кефир каждый день", package=("1", Unit.L))
        cls.days = bulk_days(cls.long, cls.lidl, cls.START, 1001)
        cls.half = make_product(generic, "Кефир полгода", package=("1", Unit.L))
        bulk_days(cls.half, data.shop_store, cls.START, 400, currency="RUB")
        cls.alone = make_product(generic, "Кефир редкий", package=("1", Unit.L))
        observe(cls.alone, cls.lidl, "EUR", cls.START, "1.00")

    def assert_too_large(self, product, **query):
        response = self.get(product, **query)
        self.assertEqual(response.status_code, 400, response.content[:200])
        self.assertEqual(response.json(), TOO_LARGE)

    def test_own_points_over_the_limit(self):
        self.assert_too_large(self.long, interval="day", similar="none")
        self.assert_too_large(self.long, interval="day", similar="none", price="normalized")

    def test_exactly_1000_points(self):
        day_before_last = self.days[-2].isoformat()
        (entry,) = self.series(self.long, interval="day", similar="none", date_to=day_before_last)
        self.assertEqual((len(entry["points"]), entry["observations"]), (1000, 1000))
        self.assertEqual(entry["points"][0]["period_start"], self.START.isoformat())
        self.assertEqual(entry["points"][-1]["period_start"], day_before_last)

    def test_own_and_similar_points_are_counted_together(self):
        # 600 своих + 400 + 1 похожих = 1001.
        date_to = self.days[599].isoformat()
        self.assert_too_large(self.long, interval="day", date_to=date_to)
        # Без одного похожего товара — ровно 1000.
        body = self.body(self.long, interval="day", date_to=date_to, similar_limit=1)
        self.assertEqual(sum(len(entry["points"]) for entry in body["series"]), 1000)
        self.assertEqual(body["similar"], similar("ok", 2, 1))
        # Только похожие: 1001 + 400 точек при одном своём наблюдении.
        self.assert_too_large(self.alone, interval="day")
        self.assertEqual(len(self.series(self.alone, interval="day", similar="none")), 1)

    def test_coarser_interval_fits(self):
        body = self.body(self.long, interval="week")
        self.assertEqual(body["series"][0]["observations"], 1001)
        self.assertEqual(sum(entry["observations"] for entry in body["series"]), 1001 + 400 + 1)
        self.assertEqual(body["series"][0]["points"][0], point("2024-01-01", 7, "1.0000"))
