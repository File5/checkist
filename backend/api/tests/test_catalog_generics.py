from django.test import TestCase, tag

from api.tests import factories
from api.tests.merge_factories import demo_groups
from merges import demo
from catalog.models import Category, GenericProduct
from catalog.units import BaseUnit

NOT_FOUND = {"error": {"code": "not_found", "message": "Не найдено."}}


@tag("integration")
class GenericProductsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.data = data = factories.save_samples()
        cls.food = Category.objects.get(name="Продукты питания")
        cls.dairy = Category.objects.get(name="Молочные продукты")
        cls.electronics = Category.objects.get(name="Электроника")
        cls.milk = {
            "id": data.milk.pk, "name": "Молоко", "base_unit": "l",
            "category": {
                "id": cls.dairy.pk, "name": "Молочные продукты",
                "path": [
                    {"id": cls.food.pk, "name": "Продукты питания"},
                    {"id": cls.dairy.pk, "name": "Молочные продукты"},
                ],
            },
            "products_count": 2, "countries": ["DE", "RU"],
        }
        cls.ssd = {
            "id": data.ssd_generic.pk, "name": "SSD-накопитель", "base_unit": "pcs",
            "category": {
                "id": cls.electronics.pk, "name": "Электроника",
                "path": [{"id": cls.electronics.pk, "name": "Электроника"}],
            },
            "products_count": 1, "countries": ["KZ"],
        }

    def names(self, query=""):
        response = self.client.get(f"/api/generic-products/{query}")
        self.assertEqual(response.status_code, 200)
        return [row["name"] for row in response.json()["results"]]

    def test_exact_body(self):
        with self.assertNumQueries(4):
            response = self.client.get("/api/generic-products/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {
            "count": 2, "page": 1, "page_size": 50, "pages": 1, "results": [self.ssd, self.milk],
        })

    def test_filters(self):
        missing = max(Category.objects.values_list("pk", flat=True)) + 1000
        cases = [
            (f"?category={self.food.pk}", ["Молоко"]),  # с потомками
            (f"?category={self.dairy.pk}", ["Молоко"]),
            (f"?category={self.electronics.pk}", ["SSD-накопитель"]),
            (f"?category={missing}", []),
            ("?q=МОЛ", ["Молоко"]),
            ("?q=ssd", ["SSD-накопитель"]),
            ("?q=нет такого", []),
            (f"?category={self.food.pk}&q=мол", ["Молоко"]),
            (f"?category={self.electronics.pk}&q=мол", []),
            ("?unknown=1", ["SSD-накопитель", "Молоко"]),
        ]
        for query, expected in cases:
            with self.subTest(query=query):
                self.assertEqual(self.names(query), expected)

    def test_generic_without_products(self):
        kefir = GenericProduct.objects.create(name="Кефир", category=self.dairy, base_unit=BaseUnit.L)
        body = self.client.get(f"/api/generic-products/{kefir.pk}/").json()
        self.assertEqual(body, {**self.milk, "id": kefir.pk, "name": "Кефир", "products_count": 0, "countries": []})

    def test_countries_need_observations(self):
        factories.make_product(self.data.milk, "Без наблюдений")
        factories.observe(self.data.shop_milk, self.data.dns_store, "KZT", self.data.dns.purchased_on, "650.00")
        body = self.client.get(f"/api/generic-products/{self.data.milk.pk}/").json()
        self.assertEqual((body["products_count"], body["countries"]), (3, ["DE", "KZ", "RU"]))

    def test_order_pagination_and_query_count(self):
        for number in range(30):
            generic = GenericProduct.objects.create(name=f"Продукт {number:02}", category=self.dairy, base_unit=BaseUnit.KG)
            product = factories.make_product(generic, f"Товар {number:02}")
            factories.observe(product, self.data.lidl_store, "EUR", self.data.lidl[0].purchased_on, "1.00")
        with self.assertNumQueries(4):
            body = self.client.get("/api/generic-products/?page_size=200").json()
        self.assertEqual((body["count"], body["pages"], len(body["results"])), (32, 1, 32))
        self.assertEqual(
            [row["name"] for row in body["results"]],
            ["SSD-накопитель", "Молоко", *(f"Продукт {number:02}" for number in range(30))],
        )
        second = self.client.get("/api/generic-products/?page_size=10&page=4").json()
        self.assertEqual((second["pages"], [row["name"] for row in second["results"]]), (4, ["Продукт 28", "Продукт 29"]))
        response = self.client.get("/api/generic-products/?page_size=10&page=5")
        self.assertEqual((response.status_code, response.json()["error"]["code"]), (404, "page_out_of_range"))

    def test_detail(self):
        with self.assertNumQueries(3):
            response = self.client.get(f"/api/generic-products/{self.data.milk.pk}/")
        self.assertEqual((response.status_code, response.json()), (200, self.milk))
        self.assertEqual(self.client.get(f"/api/generic-products/{self.data.ssd_generic.pk}/").json(), self.ssd)

    def test_detail_not_found(self):
        missing = max(GenericProduct.objects.values_list("pk", flat=True)) + 1000
        for pk in (missing, 0, 10**30):
            with self.subTest(pk=pk):
                response = self.client.get(f"/api/generic-products/{pk}/")
                self.assertEqual((response.status_code, response.json()), (404, NOT_FOUND))


# --- ожидающее слияние дублей: поглощённые товары скрыты, формы ответов прежние ---
@tag("integration")
class PendingMergeGenericsTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        demo_groups()

    def test_counters_skip_absorbed_products(self):
        with self.assertNumQueries(4):
            body = self.client.get("/api/generic-products/").json()
        rows = {generic["name"]: generic for generic in body["results"]}
        self.assertEqual(
            {name: row["products_count"] for name, row in rows.items()},
            {demo.SERVICE_GENERIC_NAME: 22, demo.MILK_GENERIC: 1, demo.OTHER_MILK_GENERIC: 0},
        )
        # Страны — по строкам чеков: у обобщённого продукта без видимых товаров наблюдений не осталось.
        self.assertEqual({name: row["countries"] for name, row in rows.items()},
                         {demo.SERVICE_GENERIC_NAME: ["DE"], demo.MILK_GENERIC: ["DE"], demo.OTHER_MILK_GENERIC: []})
        self.assertEqual(set(rows[demo.MILK_GENERIC]),
                         {"id", "name", "base_unit", "category", "products_count", "countries"})

    def test_detail_counter(self):
        generic = GenericProduct.objects.get(name=demo.SERVICE_GENERIC_NAME)
        with self.assertNumQueries(3):
            body = self.client.get(f"/api/generic-products/{generic.pk}/").json()
        self.assertEqual((body["products_count"], body["countries"]), (22, ["DE"]))
