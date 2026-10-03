from datetime import date
from decimal import Decimal

from django.test import TestCase, tag

from api.common import utc_datetime
from api.tests import factories
from catalog.models import Brand, Category, Product
from catalog.units import Unit
from receipts.dedup import name_key
from receipts.models import ProductAlias
from receipts.tests import samples
from receipts.tests.test_models import make_line
from stores.models import Merchant, Store

D = Decimal
NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}


class ProductsTestCase(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = data = factories.save_samples()
        food = Category.objects.get(name="Продукты питания")
        dairy = Category.objects.get(name="Молочные продукты")
        electronics = Category.objects.get(name="Электроника")
        cls.food, cls.dairy, cls.electronics = food, dairy, electronics
        cls.samsung = Brand.objects.get(name="Samsung")
        milk_generic = {"id": data.milk.pk, "name": "Молоко", "base_unit": "l"}
        dairy_category = {
            "id": dairy.pk, "name": "Молочные продукты",
            "path": [{"id": food.pk, "name": "Продукты питания"}, {"id": dairy.pk, "name": "Молочные продукты"}],
        }
        cls.shop_milk = {
            "id": data.shop_milk.pk, "name": "Молоко Фермерское 2,5% 850мл пэт",
            "brand": None, "model": "", "gtin": "",
            "package": {"quantity": "850.000", "unit": "ml"},
            "generic": milk_generic, "category": dairy_category,
            "last_observed_at": "2026-09-28T06:58:00Z",
            "prices": [{
                "country": "RU", "currency": "RUB", "observations": 1,
                "last": {
                    "paid_unit_price": "111.0000", "normalized_price": "130.5882", "normalized_unit": "l",
                    "comparable": True, "purchased_on": "2026-09-28", "store_id": data.shop_store.pk,
                },
            }],
        }
        cls.lidl_milk = {
            "id": data.lidl_milk.pk, "name": "GQ EgSB H-Milch 1,5%",
            "brand": None, "model": "", "gtin": "", "package": None,
            "generic": milk_generic, "category": dairy_category,
            "last_observed_at": "2026-10-01T16:59:00Z",
            "prices": [{
                "country": "DE", "currency": "EUR", "observations": 6,
                "last": {
                    "paid_unit_price": "1.0900", "normalized_price": None, "normalized_unit": None,
                    "comparable": False, "purchased_on": "2026-10-01", "store_id": data.lidl_store.pk,
                },
            }],
        }
        cls.ssd = {
            "id": data.ssd.pk, "name": "SSD Samsung 990 PRO 2 TB",
            "brand": {"id": cls.samsung.pk, "name": "Samsung"}, "model": "MZ-V9P2T0BW", "gtin": "", "package": None,
            "generic": {"id": data.ssd_generic.pk, "name": "SSD-накопитель", "base_unit": "pcs"},
            "category": {
                "id": electronics.pk, "name": "Электроника", "path": [{"id": electronics.pk, "name": "Электроника"}],
            },
            # Смещение Алматы зависит от версии tzdata, поэтому момент берётся из чека.
            "last_observed_at": utc_datetime(data.dns.purchased_at),
            "prices": [{
                "country": "KZ", "currency": "KZT", "observations": 1,
                "last": {
                    "paid_unit_price": "189490.0000", "normalized_price": None, "normalized_unit": None,
                    "comparable": False, "purchased_on": "2026-09-11", "store_id": data.dns_store.pk,
                },
            }],
        }

    def body(self, query=""):
        response = self.client.get(f"/api/products/{query}")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def ids(self, query=""):
        return [row["id"] for row in self.body(query)["results"]]


@tag("integration")
class ProductListTests(ProductsTestCase):
    def test_exact_body(self):
        self.assertEqual(self.body(), {
            "count": 3, "page": 1, "page_size": 50, "pages": 1,
            "results": [self.lidl_milk, self.ssd, self.shop_milk],
        })
        self.assertRegex(self.ssd["last_observed_at"], r"^2026-09-11T1[01]:15:44Z$")

    def test_product_without_observations(self):
        product = factories.make_product(self.data.milk, "Ряженка 4%", package=("0.5", Unit.L), gtin="4600000000017")
        row = next(row for row in self.body()["results"] if row["id"] == product.pk)
        self.assertEqual(row, {
            **self.shop_milk, "id": product.pk, "name": "Ряженка 4%", "gtin": "4600000000017",
            "package": {"quantity": "0.500", "unit": "l"}, "last_observed_at": None, "prices": [],
        })

    def test_two_currencies_give_two_price_entries(self):
        line = factories.second_currency(self.data)
        row = self.body(f"?generic={self.data.milk.pk}&country=RU")["results"][0]
        self.assertEqual(row["prices"], [
            {
                "country": "RU", "currency": "EUR", "observations": 1,
                "last": {
                    "paid_unit_price": "1.2000", "normalized_price": "1.4118", "normalized_unit": "l",
                    "comparable": True, "purchased_on": "2026-07-01", "store_id": line.receipt.store_id,
                },
            },
            *self.shop_milk["prices"],
        ])
        # Момент последнего наблюдения — общий по группам, а цены валют не смешиваются.
        self.assertEqual(row["last_observed_at"], "2026-09-28T06:58:00Z")

    def test_unit_mismatch_is_not_comparable(self):
        line = factories.unit_mismatch(self.data)
        last = self.client.get(f"/api/products/{line.product_id}/").json()["prices"][0]["last"]
        self.assertEqual(
            (last["normalized_price"], last["normalized_unit"], last["comparable"]), ("3.0000", "kg", False),
        )

    def test_discount_is_in_paid_price_and_deposit_is_not_an_observation(self):
        product = factories.make_product(self.data.milk, "Кефир со скидкой", package=("1", Unit.L))
        line = factories.observe(product, self.data.lidl_store, "EUR", date(2026, 7, 5), "2.00", discount="0.50")
        make_line(
            line.receipt, position=2, kind="deposit", parent=line, product=product, raw_name="Pfand",
            unit_price=D("0.25"), amount=D("0.25"),
        )
        price = self.client.get(f"/api/products/{product.pk}/").json()["prices"]
        self.assertEqual((price[0]["observations"], price[0]["last"]["paid_unit_price"]), (1, "1.5000"))

    def test_filters_one_by_one(self):
        data = self.data
        unobserved = factories.make_product(data.milk, "Ряженка 4%", gtin="4600000000017")
        brand = Brand.objects.create(name="Простоквашино")
        branded = factories.make_product(data.milk, "Кефир 1%", brand=brand)
        missing = max(Product.objects.values_list("pk", flat=True)) + 1000
        cases = [
            ("?q=MILCH", [data.lidl_milk.pk]),  # название, без учёта регистра
            ("?q=фермерское", [data.shop_milk.pk]),
            ("?q=простокваш", [branded.pk]),  # название бренда
            ("?q=mz-v9", [data.ssd.pk]),  # модель
            ("?q=4600000000017", [unobserved.pk]),  # gtin целиком
            ("?q=46000000", []),  # часть gtin не ищется
            ("?q=нет такого", []),
            (f"?category={self.food.pk}", [data.lidl_milk.pk, branded.pk, data.shop_milk.pk, unobserved.pk]),
            (f"?category={self.dairy.pk}", [data.lidl_milk.pk, branded.pk, data.shop_milk.pk, unobserved.pk]),
            (f"?category={self.electronics.pk}", [data.ssd.pk]),
            (f"?category={missing}", []),
            (f"?generic={data.ssd_generic.pk}", [data.ssd.pk]),
            (f"?generic={missing}", []),
            (f"?brand={self.samsung.pk}", [data.ssd.pk]),
            (f"?brand={brand.pk}", [branded.pk]),
            (f"?brand={missing}", []),
            ("?country=RU", [data.shop_milk.pk]),
            ("?country=de", [data.lidl_milk.pk]),
            ("?country=KZ", [data.ssd.pk]),
            ("?has_prices=1", [data.lidl_milk.pk, data.ssd.pk, data.shop_milk.pk]),
            ("?has_prices=0", [branded.pk, unobserved.pk]),
            ("?unknown=1&q=", [data.lidl_milk.pk, data.ssd.pk, branded.pk, data.shop_milk.pk, unobserved.pk]),
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.ids(query), expected)

    def test_filters_combined(self):
        data = self.data
        unobserved = factories.make_product(data.milk, "Ряженка 4%")
        cases = [
            (f"?category={self.food.pk}&country=DE", [data.lidl_milk.pk]),
            (f"?category={self.electronics.pk}&country=DE", []),
            (f"?generic={data.milk.pk}&has_prices=0", [unobserved.pk]),
            (f"?generic={data.milk.pk}&has_prices=1&ordering=-name", [data.shop_milk.pk, data.lidl_milk.pk]),
            (f"?q=samsung&brand={self.samsung.pk}&country=KZ&has_prices=1&category={self.electronics.pk}", [data.ssd.pk]),
            (f"?q=молоко&brand={self.samsung.pk}", []),
            ("?country=RU&has_prices=0", []),
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.ids(query), expected)

    def test_refund_and_deposit_do_not_count_as_prices(self):
        product = factories.make_product(self.data.milk, "Только возврат")
        receipt = factories.make_receipt(self.data.lidl_store, "EUR", date(2026, 7, 9), operation="refund")
        make_line(receipt, product=product)
        self.assertEqual(self.ids("?has_prices=0"), [product.pk])
        self.assertNotIn(product.pk, self.ids("?country=DE"))

    def test_orderings(self):
        data = self.data
        # Одно название, разная фасовка: порядок определяет id.
        first = factories.make_product(data.milk, "Йогурт", package=("100", Unit.G))
        second = factories.make_product(data.milk, "Йогурт", package=("200", Unit.G))
        lidl, ssd, shop = data.lidl_milk.pk, data.ssd.pk, data.shop_milk.pk
        cases = [
            ("", [lidl, ssd, first.pk, second.pk, shop]),
            ("?ordering=name", [lidl, ssd, first.pk, second.pk, shop]),
            ("?ordering=-name", [shop, first.pk, second.pk, ssd, lidl]),
            # Товары без наблюдений — в конце при любом направлении.
            ("?ordering=last_observed_at", [ssd, shop, lidl, first.pk, second.pk]),
            ("?ordering=-last_observed_at", [lidl, shop, ssd, first.pk, second.pk]),
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.ids(query), expected)
                self.assertEqual(self.ids(query), expected)  # повторный запрос — тот же порядок

    def test_ordering_by_last_observation_ignores_non_observations(self):
        # Возврат позже всех покупок не делает товар «последним».
        receipt = factories.make_receipt(self.data.dns_store, "KZT", date(2026, 12, 1), operation="refund")
        make_line(receipt, product=self.data.ssd)
        self.assertEqual(
            self.ids("?ordering=-last_observed_at"), [self.data.lidl_milk.pk, self.data.shop_milk.pk, self.data.ssd.pk],
        )
        body = self.body("?ordering=-last_observed_at&page_size=1")
        self.assertEqual((body["count"], body["pages"]), (3, 3))

    def test_pagination(self):
        lidl, ssd, shop = self.data.lidl_milk.pk, self.data.ssd.pk, self.data.shop_milk.pk
        first = self.body("?page_size=2")
        self.assertEqual(
            (first["count"], first["page"], first["page_size"], first["pages"], [row["id"] for row in first["results"]]),
            (3, 1, 2, 2, [lidl, ssd]),
        )
        second = self.body("?page_size=2&page=2")
        self.assertEqual((second["page"], second["results"]), (2, [self.shop_milk]))
        self.assertEqual(self.body("?page_size=200")["page_size"], 200)
        for query in ("?page_size=2&page=3", "?page=2", "?q=нет такого&page=2"):
            with self.subTest(query=query):
                response = self.client.get(f"/api/products/{query}")
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.json(), {
                    "error": {"code": "page_out_of_range", "message": "Страница за пределами диапазона."},
                })

    def test_query_count_does_not_grow_with_page_size(self):
        # Дерево категорий, COUNT, страница, группы цен, последние цены.
        with self.assertNumQueries(5):
            self.assertEqual(len(self.body()["results"]), 3)
        brand = Brand.objects.create(name="Простоквашино")
        for number in range(40):
            product = factories.make_product(self.data.milk, f"Товар {number:02}", brand=brand if number % 2 else None)
            for store, currency in ((self.data.lidl_store, "EUR"), (self.data.shop_store, "RUB")):
                factories.observe(product, store, currency, date(2026, 8, 1), "2.00")
        with self.assertNumQueries(5):
            results = self.body("?page_size=200")["results"]
        self.assertEqual(len(results), 43)
        self.assertEqual({len(row["prices"]) for row in results if row["name"].startswith("Товар")}, {2})
        with self.assertNumQueries(5):
            self.assertEqual(len(self.body("?page_size=10&ordering=-last_observed_at")["results"]), 10)
        with self.assertNumQueries(6):  # ещё проверка кода страны
            self.assertEqual(len(self.body("?page_size=200&country=RU&has_prices=1")["results"]), 41)


@tag("integration")
class ProductDetailTests(ProductsTestCase):
    def store(self, store, name, observations, last_purchased_on):
        return {
            "id": store.pk, "name": name, "city": store.city, "address": store.address_raw,
            "country": store.country_id, "timezone": store.timezone,
            "observations": observations, "last_purchased_on": last_purchased_on,
        }

    def detail(self, pk):
        response = self.client.get(f"/api/products/{pk}/")
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_exact_body(self):
        data = self.data
        with self.assertNumQueries(9):
            body = self.detail(data.shop_milk.pk)
        self.assertEqual(body, {
            **self.shop_milk,
            "attributes": {"fat_percent": 2.5, "packaging": "пэт"},
            "aliases": [{
                "store_name": "Магазин «Елена»", "raw_name": "Молоко Фермерское 2,5% 850мл пэт",
                "store_item_code": "3079",
            }],
            "stores": [self.store(data.shop_store, "Магазин «Елена»", 1, "2026-09-28")],
            "alternatives_count": 1,
        })

    def test_other_samples(self):
        data = self.data
        with self.assertNumQueries(8):  # у продавца есть вывеска: его магазины не читаются
            body = self.detail(data.lidl_milk.pk)
        self.assertEqual(body, {
            **self.lidl_milk,
            "attributes": {"fat_percent": 1.5},
            "aliases": [{"store_name": "Lidl", "raw_name": samples.MILK, "store_item_code": ""}],
            "stores": [self.store(data.lidl_store, "Lidl", 6, "2026-10-01")],
            "alternatives_count": 1,
        })
        self.assertEqual(self.detail(data.ssd.pk), {
            **self.ssd,
            "attributes": {"capacity_tb": 2, "form_factor": "M.2", "interface": "PCIe, NVMe 1.4"},
            "aliases": [{"store_name": "DNS", "raw_name": samples.DNS_SSD_NAME, "store_item_code": "5412016"}],
            "stores": [self.store(data.dns_store, "DNS", 1, "2026-09-11")],
            "alternatives_count": 0,
        })

    def test_product_without_observations_and_aliases(self):
        product = factories.make_product(self.data.ssd_generic, "SSD без покупок")
        with self.assertNumQueries(6):
            body = self.detail(product.pk)
        self.assertEqual(
            (body["last_observed_at"], body["prices"], body["attributes"], body["aliases"], body["stores"]),
            (None, [], {}, [], []),
        )
        self.assertEqual(body["alternatives_count"], 1)

    def test_stores_are_ordered_by_last_purchase(self):
        data = self.data
        factories.observe(data.shop_milk, data.lidl_store, "EUR", date(2026, 9, 30), "1.10")
        factories.observe(data.shop_milk, data.lidl_store, "EUR", date(2026, 9, 29), "1.10")
        factories.observe(data.shop_milk, data.dns_store, "KZT", date(2026, 9, 30), "650.00")
        self.assertLess(data.lidl_store.pk, data.dns_store.pk)
        body = self.detail(data.shop_milk.pk)
        self.assertEqual(body["stores"], [
            # Равные даты — по id магазина: образцы создают Lidl раньше DNS.
            self.store(data.lidl_store, "Lidl", 2, "2026-09-30"),
            self.store(data.dns_store, "DNS", 1, "2026-09-30"),
            self.store(data.shop_store, "Магазин «Елена»", 1, "2026-09-28"),
        ])
        self.assertEqual(
            [(row["country"], row["currency"], row["observations"]) for row in body["prices"]],
            [("DE", "EUR", 2), ("KZ", "KZT", 1), ("RU", "RUB", 1)],
        )
        self.assertEqual(body["last_observed_at"], "2026-09-30T10:00:00Z")  # 12:00 в Берлине

    def test_alias_store_name_without_brand(self):
        product = self.data.shop_milk
        with_store = Merchant.objects.create(country_id="RU", legal_name="ИП Тестов Т.Т.")
        store = Store.objects.create(
            merchant=with_store, country_id="RU", address_raw="г. Тестоград, ул. Примерная, 1", timezone="Europe/Moscow",
        )
        Store.objects.create(
            merchant=with_store, country_id="RU", name="Второй магазин",
            address_raw="г. Тестоград, ул. Примерная, 2", timezone="Europe/Moscow",
        )
        without_store = Merchant.objects.create(country_id="RU", legal_name="ИП Безмагазинный Б.Б.")
        for merchant, raw_name in ((with_store, "А молоко"), (without_store, "Б молоко")):
            ProductAlias.objects.create(merchant=merchant, product=product, name_key=name_key(raw_name), raw_name=raw_name)
        response = self.client.get(f"/api/products/{product.pk}/")
        self.assertEqual(response.json()["aliases"], [
            {"store_name": f"Магазин №{store.pk}", "raw_name": "А молоко", "store_item_code": ""},
            {"store_name": "", "raw_name": "Б молоко", "store_item_code": ""},
            {"store_name": "Магазин «Елена»", "raw_name": "Молоко Фермерское 2,5% 850мл пэт", "store_item_code": "3079"},
        ])
        self.assertNotIn("ИП ", response.content.decode())

    def test_aliases_and_stores_are_limited_to_50(self):
        product = factories.make_product(self.data.milk, "Товар с длинными списками")
        merchant = self.data.lidl_store.merchant
        ProductAlias.objects.bulk_create([
            ProductAlias(merchant=merchant, product=product, name_key=f"alias {number:02}", raw_name=f"Alias {number:02}")
            for number in range(55)
        ])
        for number in range(52):
            store = Store.objects.create(
                merchant=merchant, country_id="DE", address_raw=f"Teststraße {number}, 50667 Köln", timezone="Europe/Berlin",
            )
            factories.observe(product, store, "EUR", date(2026, 8, 1), "1.00")
        with self.assertNumQueries(8):
            body = self.detail(product.pk)
        self.assertEqual([row["raw_name"] for row in body["aliases"]], [f"Alias {number:02}" for number in range(50)])
        self.assertEqual(len(body["stores"]), 50)
        ids = [row["id"] for row in body["stores"]]
        self.assertEqual(ids, sorted(ids))  # равные даты — по id магазина
        self.assertEqual(body["prices"][0]["observations"], 52)

    def test_not_found(self):
        missing = max(Product.objects.values_list("pk", flat=True)) + 1000
        for pk in (missing, 0, 10**30):
            with self.subTest(pk=pk), self.assertNumQueries(0 if pk != missing else 1):
                response = self.client.get(f"/api/products/{pk}/")
                self.assertEqual((response.status_code, response.json()), (404, NOT_FOUND))
