"""Проекция «своё / чужое»: общие цены без ссылок на чужие чеки.

Цены, магазины и товары общие, чеки личные. В точках ``products/{id}/prices/`` у чужого
наблюдения ``null`` в пяти полях и ``own: false``; ``stores.receipts_count`` считает свои
чеки; ``products.last_observed_at`` — ``null``, если самое позднее наблюдение чужое;
покупки группы слияния не модератор видит только свои, модератор — все, у чужих
``receipt_id: null``. Эталоны для клиента — ``fixtures/auth/prices_foreign_point.json`` и
``merges/tests/fixtures/public/lines_foreign.json``. Данные вымышленные, MEDIA временный.
"""
import json
import re
import tempfile
from datetime import date, time
from decimal import Decimal
from pathlib import Path

from django.test import TestCase, override_settings, tag
from django.urls import URLPattern, get_resolver, resolve
from rest_framework.test import APIClient

from api.tests.accounts_helpers import TwoUsers, accounts_mode, local_single_mode, make_user
from api.tests.factories import make_product, make_receipt
from api.tests.merge_factories import PIZZA_IDS, expected as merge_fixture, public_merge_data
from catalog.models import Category, GenericProduct, Product
from catalog.units import Unit
from merges import services
from merges.models import ProductMerge
from merges.visibility import visible
from receipts.models import Receipt
from receipts.ownership import local_user
from receipts.tests import samples
from receipts.tests.test_models import make_line
from recognition.models import ProcessingJob
from recognition.tests.test_models import make_image, make_photo
from stores.models import Merchant, Store

D = Decimal
FIXTURES = Path(__file__).resolve().parent / "fixtures/auth"
# Поля точки истории цен, по которым находится чек: у чужого наблюдения они null.
PRIVATE_POINT_KEYS = ("observed_at", "quantity", "discount_amount", "receipt_id", "position")
POINT_KEYS = {
    "observed_at", "purchased_on", "store", "currency", "quantity", "unit", "list_unit_price", "paid_unit_price",
    "discount_amount", "normalized_price", "normalized_unit", "comparable", "receipt_id", "position", "own",
}
PRODUCT_KEYS = {
    "id", "name", "brand", "model", "gtin", "package", "generic", "category", "last_observed_at", "prices",
}
LAST_PRICE_KEYS = {
    "paid_unit_price", "normalized_price", "normalized_unit", "comparable", "purchased_on", "store_id",
}
EMPTY_PAGE = {"count": 0, "page": 1, "page_size": 50, "pages": 0, "results": []}
PAGE_OUT_OF_RANGE = "page_out_of_range"
PERIODS = "base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-12-31"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def buy(owner, product, store, on, unit_price, *, currency="EUR", at=time(12, 0), receipt_id=None,
        quantity="1", discount="0.00", position=1):
    """Чек владельца с одной строкой товара — одно наблюдение цены. Возвращает строку."""
    quantity, unit_price = D(quantity), D(unit_price)
    explicit = {} if receipt_id is None else {"id": receipt_id}
    receipt = make_receipt(store, currency, on, at=at, owner=owner, **explicit)
    return make_line(
        receipt, product=product, position=position, raw_name=product.name, quantity=quantity, unit=Unit.PCS,
        unit_price=unit_price, amount=(quantity * unit_price).quantize(D("0.01")), discount_amount=D(discount),
    )


def piece_generic(name):
    category = Category.objects.create(name=f"{name} (категория)")
    return GenericProduct.objects.create(name=name, category=category, base_unit="pcs")


def body(response):
    assert response.status_code == 200, (response.status_code, response.content)
    return response.json()


class ProjectionMixin(TwoUsers):
    def get(self, account, path):
        return body(self.client_of(account).get(path))


@tag("integration")
@accounts_mode()
class PricePointProjectionTests(ProjectionMixin, TestCase):
    """Точки истории цен: чужая остаётся на своём месте, но без пяти полей чека."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        # Явные id: страница сравнивается с эталоном целиком. Чеки этого класса — только с явными id.
        merchant = Merchant.objects.create(
            id=61, country_id="DE", legal_name="Synthetic Projection GmbH", brand_name="Demomarkt",
        )
        cls.store = Store.objects.create(
            id=61, merchant=merchant, country_id="DE", name="Demomarkt", city="Musterstadt",
            address_raw="Beispielallee 1", timezone="Europe/Berlin",
        )
        category = Category.objects.create(name="Демо-молочные продукты (проекция)")
        generic = GenericProduct.objects.create(id=95, name="Демо-молоко (проекция)", category=category, base_unit="l")
        cls.product = make_product(generic, "Демо-молоко 1 л", package=("1", Unit.L), id=71)
        buy(cls.first, cls.product, cls.store, date(2026, 6, 9), "1.05", receipt_id=21, quantity="2",
            discount="0.20", position=2)
        buy(cls.second, cls.product, cls.store, date(2026, 6, 29), "1.10", receipt_id=22, quantity="3",
            discount="0.30")
        cls.url = f"/api/products/{cls.product.pk}/prices/"

    def points(self, account, query=""):
        return self.get(account, self.url + query)["results"]

    def test_page_with_own_and_foreign_point_matches_the_example(self):
        response = self.client_of(self.first).get(self.url)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json(), fixture("prices_foreign_point.json"))

    def test_example_is_utf8_lf_json(self):
        raw = (FIXTURES / "prices_foreign_point.json").read_bytes()
        self.assertNotIn(b"\r", raw)
        self.assertEqual(raw.decode("utf-8"), json.dumps(json.loads(raw), ensure_ascii=False, indent=2) + "\n")

    def test_each_user_sees_private_fields_only_of_own_point(self):
        foreign, own = self.points(self.second)
        self.assertEqual({key: foreign[key] for key in PRIVATE_POINT_KEYS}, dict.fromkeys(PRIVATE_POINT_KEYS))
        self.assertIs(foreign["own"], False)
        self.assertEqual({key: own[key] for key in (*PRIVATE_POINT_KEYS, "own")}, {
            "observed_at": "2026-06-29T10:00:00Z", "quantity": "3.000", "discount_amount": "0.30",
            "receipt_id": 22, "position": 1, "own": True,
        })

    def test_every_point_has_the_same_keys(self):
        for account in (self.first, self.second, self.moderator):
            for point in self.points(account):
                with self.subTest(account=account.username, own=point["own"]):
                    self.assertEqual(set(point), POINT_KEYS)
                    self.assertIsInstance(point["own"], bool)

    def test_public_part_of_a_point_is_the_same_for_everyone(self):
        def public(account):
            return [
                {key: value for key, value in point.items() if key not in (*PRIVATE_POINT_KEYS, "own")}
                for point in self.points(account)
            ]

        expected = public(self.first)
        self.assertEqual([point["paid_unit_price"] for point in expected], ["0.9500", "1.0000"])
        self.assertEqual([point["purchased_on"] for point in expected], ["2026-06-09", "2026-06-29"])
        self.assertEqual(public(self.second), expected)
        self.assertEqual(public(self.moderator), expected)

    def test_user_without_receipts_sees_only_foreign_points(self):
        points = self.points(self.moderator)
        self.assertEqual([point["own"] for point in points], [False, False])
        for point in points:
            self.assertEqual({key: point[key] for key in PRIVATE_POINT_KEYS}, dict.fromkeys(PRIVATE_POINT_KEYS))

    def test_order_and_pages_do_not_depend_on_the_reader(self):
        cases = (
            ("", ["2026-06-09", "2026-06-29"]),
            ("?ordering=-observed_at", ["2026-06-29", "2026-06-09"]),
            ("?page_size=1&page=2", ["2026-06-29"]),
            ("?ordering=-observed_at&page_size=1&page=2", ["2026-06-09"]),
            ("?date_from=2026-06-20", ["2026-06-29"]),
        )
        for query, days in cases:
            for account in (self.first, self.second, self.moderator):
                with self.subTest(query=query, account=account.username):
                    page = self.get(account, self.url + query)
                    self.assertEqual([point["purchased_on"] for point in page["results"]], days)
                    self.assertEqual(page["count"], 1 if "date_from" in query else 2)

    def test_summary_and_series_count_both_owners_and_are_the_same_for_everyone(self):
        base = f"/api/products/{self.product.pk}/prices/"
        for path in ("summary/", "summary/?group_by=store&interval=month", "summary/?price=normalized", "series/"):
            with self.subTest(path=path):
                bodies = [self.get(account, base + path) for account in (self.first, self.second, self.moderator)]
                self.assertEqual(bodies[1], bodies[0])
                self.assertEqual(bodies[2], bodies[0])
        (group,) = self.get(self.first, base + "summary/")["groups"]
        self.assertEqual(
            (group["total"]["count"], group["total"]["min"], group["total"]["max"]), (2, "0.9500", "1.0000"),
        )

    def test_local_single_owns_only_receipts_of_local(self):
        with local_single_mode():
            client = APIClient()
            self.assertEqual([point["own"] for point in body(client.get(self.url))["results"]], [False, False])
            buy(local_user(), self.product, self.store, date(2026, 7, 6), "1.20", receipt_id=23)
            with self.assertNumQueries(3):  # товар, COUNT, страница — как до проекции
                response = client.get(self.url)
            points = body(response)["results"]
        self.assertEqual([point["own"] for point in points], [False, False, True])
        self.assertEqual(
            {key: points[2][key] for key in PRIVATE_POINT_KEYS},
            {"observed_at": "2026-07-06T10:00:00Z", "quantity": "1.000", "discount_amount": "0.00",
             "receipt_id": 23, "position": 1},
        )


@tag("integration")
@accounts_mode()
class StoresCountTests(ProjectionMixin, TestCase):
    """``stores.receipts_count`` — число своих чеков; сам магазин общий."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.lindau = samples.lidl_store()
        cls.berlin = Store.objects.create(
            merchant=cls.lindau.merchant, country_id="DE", city="Berlin",
            address_raw="Teststraße 1, 10115 Berlin", timezone="Europe/Berlin",
        )
        make_receipt(cls.lindau, "EUR", date(2026, 6, 9), owner=cls.first)
        make_receipt(cls.lindau, "EUR", date(2026, 6, 10), owner=cls.first)
        make_receipt(cls.lindau, "EUR", date(2026, 6, 9), owner=cls.second)
        make_receipt(cls.berlin, "EUR", date(2026, 6, 11), owner=cls.second)

    def counts(self, page):
        return {store["id"]: store["receipts_count"] for store in page["results"]}

    def test_count_holds_only_own_receipts(self):
        lindau, berlin = self.lindau.pk, self.berlin.pk
        cases = (
            (self.first, {lindau: 2, berlin: 0}), (self.second, {lindau: 1, berlin: 1}),
            (self.moderator, {lindau: 0, berlin: 0}),
        )
        for account, expected in cases:
            with self.subTest(account=account.username):
                page = self.get(account, "/api/stores/")
                # Магазин без своих чеков остаётся в списке: он общий.
                self.assertEqual(page["count"], 2)
                self.assertEqual(self.counts(page), expected)

    def test_filters_keep_own_counts(self):
        self.assertEqual(self.counts(self.get(self.first, "/api/stores/?q=Berlin")), {self.berlin.pk: 0})
        self.assertEqual(self.counts(self.get(self.second, "/api/stores/?q=Berlin")), {self.berlin.pk: 1})
        self.assertEqual(
            self.counts(self.get(self.first, "/api/stores/?country=DE")), {self.lindau.pk: 2, self.berlin.pk: 0},
        )

    def test_store_object_has_the_same_keys(self):
        (first, *_rest) = self.get(self.first, "/api/stores/")["results"]
        self.assertEqual(set(first), {"id", "name", "city", "address", "country", "timezone", "receipts_count"})

    def test_local_single_counts_receipts_of_local(self):
        with local_single_mode():
            client = APIClient()
            self.assertEqual(
                self.counts(body(client.get("/api/stores/"))), {self.lindau.pk: 0, self.berlin.pk: 0},
            )
            make_receipt(self.lindau, "EUR", date(2026, 6, 12), owner=local_user())
            self.assertEqual(
                self.counts(body(client.get("/api/stores/"))), {self.lindau.pk: 1, self.berlin.pk: 0},
            )


@tag("integration")
@accounts_mode()
class ProductLastObservedTests(ProjectionMixin, TestCase):
    """``last_observed_at`` — точный момент покупки: чужой не отдаётся."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.store = samples.lidl_store()
        generic = piece_generic("Демо-хлеб (проекция)")
        cls.theirs_last = make_product(generic, "Демо-хлеб, последняя покупка чужая")
        buy(cls.first, cls.theirs_last, cls.store, date(2026, 6, 9), "1.00")
        buy(cls.second, cls.theirs_last, cls.store, date(2026, 6, 29), "1.10")
        cls.mine_last = make_product(generic, "Демо-хлеб, последняя покупка своя")
        buy(cls.second, cls.mine_last, cls.store, date(2026, 6, 9), "2.00")
        buy(cls.first, cls.mine_last, cls.store, date(2026, 6, 29), "2.10")
        # Один момент: позднее то наблюдение, у которого больше id чека, — второго пользователя.
        cls.same_moment = make_product(generic, "Демо-хлеб, покупки в один момент")
        buy(cls.first, cls.same_moment, cls.store, date(2026, 7, 2), "3.00")
        buy(cls.second, cls.same_moment, cls.store, date(2026, 7, 2), "3.10")
        # Две группы цен (EUR и RUB): последнее наблюдение товара — в чужой группе.
        cls.two_groups = make_product(generic, "Демо-хлеб, две валюты")
        buy(cls.first, cls.two_groups, cls.store, date(2026, 6, 10), "4.00")
        buy(cls.second, cls.two_groups, cls.store, date(2026, 7, 1), "400.00", currency="RUB")
        cls.unbought = make_product(generic, "Демо-хлеб без покупок")

    def expected(self):
        """Товар -> (момент для первого, момент для второго)."""
        return {
            self.theirs_last.pk: (None, "2026-06-29T10:00:00Z"),
            self.mine_last.pk: ("2026-06-29T10:00:00Z", None),
            self.same_moment.pk: (None, "2026-07-02T10:00:00Z"),
            self.two_groups.pk: (None, "2026-07-01T10:00:00Z"),
            self.unbought.pk: (None, None),
        }

    def test_product_card_hides_the_moment_of_a_foreign_purchase(self):
        for pk, moments in self.expected().items():
            for account, moment in zip((self.first, self.second), moments):
                with self.subTest(product=pk, account=account.username):
                    self.assertEqual(self.get(account, f"/api/products/{pk}/")["last_observed_at"], moment)
            with self.subTest(product=pk, account="moderator"):
                self.assertIsNone(self.get(self.moderator, f"/api/products/{pk}/")["last_observed_at"])

    def test_product_list_hides_the_moment_of_a_foreign_purchase(self):
        for index, account in enumerate((self.first, self.second)):
            with self.subTest(account=account.username):
                rows = {row["id"]: row for row in self.get(account, "/api/products/")["results"]}
                self.assertEqual(
                    {pk: rows[pk]["last_observed_at"] for pk in self.expected()},
                    {pk: moments[index] for pk, moments in self.expected().items()},
                )

    def test_day_and_price_of_the_last_purchase_stay_shared(self):
        for account in (self.first, self.second, self.moderator):
            with self.subTest(account=account.username):
                row = self.get(account, f"/api/products/{self.theirs_last.pk}/")
                (group,) = row["prices"]
                self.assertEqual(set(row) & PRODUCT_KEYS, PRODUCT_KEYS)
                self.assertEqual(set(group["last"]), LAST_PRICE_KEYS)
                self.assertEqual(
                    (group["observations"], group["last"]["purchased_on"], group["last"]["paid_unit_price"]),
                    (2, "2026-06-29", "1.1000"),
                )
        groups = self.get(self.first, f"/api/products/{self.two_groups.pk}/")["prices"]
        self.assertEqual(
            [(group["currency"], group["last"]["purchased_on"]) for group in groups],
            [("EUR", "2026-06-10"), ("RUB", "2026-07-01")],
        )

    def test_ordering_by_the_moment_uses_every_observation(self):
        for query in ("?ordering=-last_observed_at", "?ordering=last_observed_at"):
            with self.subTest(query=query):
                ids = [
                    [row["id"] for row in self.get(account, "/api/products/" + query)["results"]]
                    for account in (self.first, self.second, self.moderator)
                ]
                self.assertEqual(ids[1], ids[0])
                self.assertEqual(ids[2], ids[0])
        newest = self.get(self.first, "/api/products/?ordering=-last_observed_at")["results"][0]
        # Первым идёт товар с самой поздней покупкой, хотя её момент первому пользователю не показан.
        self.assertEqual((newest["id"], newest["last_observed_at"]), (self.same_moment.pk, None))

    def test_local_single_shows_the_moment_only_of_receipts_of_local(self):
        url = f"/api/products/{self.theirs_last.pk}/"
        with local_single_mode():
            client = APIClient()
            self.assertIsNone(body(client.get(url))["last_observed_at"])
            buy(local_user(), self.theirs_last, self.store, date(2026, 7, 10), "1.20")
            self.assertEqual(body(client.get(url))["last_observed_at"], "2026-07-10T10:00:00Z")
            rows = {row["id"]: row for row in body(client.get("/api/products/"))["results"]}
        self.assertEqual(rows[self.theirs_last.pk]["last_observed_at"], "2026-07-10T10:00:00Z")
        self.assertIsNone(rows[self.mine_last.pk]["last_observed_at"])


def merge_data_of(owners):
    """Каталог эталонов слияния с ожидающими группами; ``owners`` — владелец -> id его чеков."""
    public_merge_data()
    for owner, receipt_ids in owners.items():
        Receipt.objects.filter(pk__in=receipt_ids).update(owner=owner)
    services.detect()
    return ProductMerge.objects.get(members__product_ref=PIZZA_IDS[0])


@tag("integration")
@accounts_mode()
class MergeLinesProjectionTests(ProjectionMixin, TestCase):
    """Покупки группы слияния: не модератор видит свои строки, модератор — все, чужие без чека."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.nobody = make_user("synthetic-user-three")
        # Строки пиццы: 101 (чек 9), 104 (чек 10), 107 (чек 11), 108 (чек 13).
        cls.group = merge_data_of({cls.moderator: (9, 11), cls.first: (10,), cls.second: (13,)})
        cls.url = f"/api/product-merges/{cls.group.pk}/lines/"

    def rows(self, account, query=""):
        return [(line["line_id"], line["receipt_id"]) for line in self.get(account, self.url + query)["results"]]

    def test_moderator_page_with_own_and_foreign_line_matches_the_example(self):
        response = self.client_of(self.moderator).get(self.url)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response.json(), merge_fixture("lines_foreign.json"))

    def test_foreign_line_differs_from_the_old_example_only_in_receipt_id(self):
        old, new = merge_fixture("lines.json")["results"][:4], merge_fixture("lines_foreign.json")["results"]
        self.assertEqual([line["receipt_id"] for line in new], [9, None, 11, None])
        self.assertEqual([{**line, "receipt_id": None} for line in new], [{**line, "receipt_id": None} for line in old])
        for line in new:
            self.assertEqual(set(line), set(old[0]))  # поля ``own`` нет

    def test_reader_who_is_not_a_moderator_gets_only_own_lines(self):
        self.assertEqual(self.rows(self.first), [(104, 10)])
        self.assertEqual(self.rows(self.second), [(108, 13)])
        page = self.get(self.first, self.url)
        self.assertEqual((page["count"], page["page"], page["page_size"], page["pages"]), (1, 1, 50, 1))
        self.assertEqual(page["results"], [merge_fixture("lines.json")["results"][1]])
        self.assertEqual(self.get(self.nobody, self.url), EMPTY_PAGE)

    def test_pages_of_a_reader_count_only_own_lines(self):
        response = self.client_of(self.first).get(self.url + "?page=2")
        self.assertEqual(response.status_code, 404, response.content)
        self.assertEqual(response.json()["error"]["code"], PAGE_OUT_OF_RANGE)
        self.assertEqual(self.rows(self.moderator, "?page_size=2&page=2"), [(107, 11), (108, None)])

    def test_group_object_is_the_same_for_everyone(self):
        url = f"/api/product-merges/{self.group.pk}/"
        group = self.get(self.moderator, url)
        self.assertEqual(group["lines_count"], 4)
        for account in (self.first, self.second, self.nobody):
            with self.subTest(account=account.username):
                self.assertEqual(self.get(account, url), group)

    def test_confirmed_group_keeps_the_projection(self):
        services.confirm(self.group.pk, version=1, target_product_id=self.group.target_ref)
        self.assertEqual(self.rows(self.moderator), [(101, 9), (104, None), (107, 11), (108, None)])
        self.assertEqual(self.rows(self.first), [(104, 10)])
        self.assertEqual(self.get(self.nobody, self.url), EMPTY_PAGE)

    def test_local_single_reads_every_line_and_opens_only_receipts_of_local(self):
        with local_single_mode():
            client = APIClient()
            page = body(client.get(self.url))
            self.assertEqual(
                [(line["line_id"], line["receipt_id"]) for line in page["results"]],
                [(101, None), (104, None), (107, None), (108, None)],
            )
            Receipt.objects.filter(pk=9).update(owner=local_user())
            page = body(client.get(self.url))
        self.assertEqual(
            [(line["line_id"], line["receipt_id"]) for line in page["results"]],
            [(101, 9), (104, None), (107, None), (108, None)],
        )


# Маршруты, которые обход не читает, и почему.
SKIPPED_ROUTES = {
    **dict.fromkeys(
        ("auth-login", "auth-logout", "auth-password", "recognition-cancel", "recognition-retry",
         "recognition-image-confirm", "product-merges-detect", "product-merges-confirm", "product-merges-cancel",
         "product-merges-exclude", "product-classifications-confirm-many", "product-classifications-confirm",
         "product-classifications-reject"),
        "только POST",
    ),
    **dict.fromkeys(
        ("api-not-found", "recognition-not-found", "receipts-not-found", "product-merges-not-found",
         "product-classifications-not-found", "stats-not-found"),
        "ответ 404 без данных",
    ),
    **dict.fromkeys(
        ("product-classifications-detail", "product-classifications-run"),
        "нужна запись предположения; в её форме только поля каталога",
    ),
}
RECEIPT_LINK = re.compile(r"/api/receipts/(\d+)/")


def route_names(patterns=None):
    """Имена всех маршрутов ``api.urls``, включая вложенные ``include``."""
    names = set()
    for pattern in get_resolver("api.urls").url_patterns if patterns is None else patterns:
        if isinstance(pattern, URLPattern):
            names.add(pattern.name)
        else:
            names |= route_names(pattern.url_patterns)
    return names


def receipt_ids_in(value):
    """Все значения ключа ``receipt_id`` в JSON, включая ``None``."""
    if isinstance(value, dict):
        found = [value["receipt_id"]] if "receipt_id" in value else []
        return found + [item for child in value.values() for item in receipt_ids_in(child)]
    if isinstance(value, list):
        return [item for child in value for item in receipt_ids_in(child)]
    return []


@tag("integration")
@accounts_mode()
class NoForeignReceiptIdTests(ProjectionMixin, TestCase):
    """Обход всех GET-маршрутов API: ни один ответ не ведёт к чужому чеку."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.group = merge_data_of({cls.first: (9, 11), cls.second: (10, 13)})
        cls.receipts = {cls.first.pk: {9, 11}, cls.second.pk: {10, 13}, cls.moderator.pk: set()}
        cls.recognition = {}
        for account, receipt_id in ((cls.first, 9), (cls.second, 10)):
            photo = make_photo(owner=account)
            job = ProcessingJob.objects.create(photo=photo)
            image = make_image(job, status="imported", receipt_id=receipt_id, import_effect="created",
                               outcome_snapshot={"receipt_id": receipt_id})
            cls.recognition[account.pk] = {"photos": photo.pk, "jobs": job.pk, "receipt-images": image.pk}

    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="checkist-projection-test-")
        self.addCleanup(directory.cleanup)
        override = override_settings(MEDIA_ROOT=directory.name)
        override.enable()
        self.addCleanup(override.disable)

    def paths(self, receipts, recognition):
        """Адреса обхода: каталог и цены целиком, свои чеки и распознавание, статистика, слияния."""
        paths = [
            "/api/me/", "/api/auth/csrf/",
            "/api/countries/", "/api/countries/?all=1", "/api/stores/", "/api/brands/", "/api/categories/",
            "/api/generic-products/", "/api/products/", "/api/products/?ordering=-last_observed_at",
            "/api/receipts/", "/api/receipts/?ordering=purchased_at",
            "/api/recognition/csrf/", "/api/recognition/photos/", "/api/recognition/jobs/",
            "/api/recognition/receipt-images/",
            "/api/stats/spending/", "/api/stats/spending/?group_by=product", "/api/stats/spending/?group_by=store",
            "/api/stats/receipts/series/", f"/api/stats/receipts/compare/?{PERIODS}",
            "/api/product-merges/", "/api/product-classifications/", "/api/product-classifications/status/",
            "/api/product-classifications/runs/",
        ]
        paths += [f"/api/categories/{pk}/" for pk in Category.objects.values_list("pk", flat=True)]
        for pk in GenericProduct.objects.values_list("pk", flat=True):
            paths += [f"/api/generic-products/{pk}/", f"/api/generic-products/{pk}/comparison/"]
        for pk in visible(Product.objects.order_by("pk")).values_list("pk", flat=True):
            base = f"/api/products/{pk}/"
            paths += [
                base, base + "prices/", base + "prices/?ordering=-observed_at", base + "prices/summary/",
                base + "prices/summary/?group_by=store&interval=month", base + "prices/series/",
                base + "alternatives/", base + "alternatives/?scope=category",
            ]
        for pk in ProductMerge.objects.values_list("pk", flat=True):
            paths += [f"/api/product-merges/{pk}/", f"/api/product-merges/{pk}/lines/"]
        for pk in sorted(receipts):
            base = f"/api/receipts/{pk}/"
            paths += [base, base + "lines/", base + "discounts/", base + "taxes/"]
        for resource, pk in recognition.items():
            paths.append(f"/api/recognition/{resource}/{pk}/")
        return paths

    def walk(self, client, receipts, recognition):
        """Читает все адреса; возвращает имена маршрутов и найденные значения ``receipt_id``."""
        routes, found = set(), []
        for path in self.paths(receipts, recognition):
            with self.subTest(path=path):
                response = client.get(path)
                self.assertEqual(response.status_code, 200, response.content)
                routes.add(resolve(path.partition("?")[0]).url_name)
                ids = receipt_ids_in(response.json())
                found += ids
                self.assertLessEqual({pk for pk in ids if pk is not None}, receipts)
                links = {int(pk) for pk in RECEIPT_LINK.findall(response.content.decode("utf-8"))}
                self.assertLessEqual(links, receipts)
                if path.startswith("/api/receipts/?") or path == "/api/receipts/":
                    self.assertEqual({row["id"] for row in response.json()["results"]}, receipts)
        return routes, found

    def test_walk_covers_every_get_route(self):
        routes, _found = self.walk(self.client_of(self.first), self.receipts[self.first.pk],
                                   self.recognition[self.first.pk])
        self.assertEqual(routes | set(SKIPPED_ROUTES), route_names())
        self.assertEqual(routes & set(SKIPPED_ROUTES), set())

    def test_no_response_leads_to_a_foreign_receipt(self):
        for account in (self.first, self.second):
            with self.subTest(account=account.username):
                own = self.receipts[account.pk]
                _routes, found = self.walk(self.client_of(account), own, self.recognition[account.pk])
                # Обход не пустой: свои чеки названы, чужие строки и точки пришли без чека.
                self.assertEqual({pk for pk in found if pk is not None}, own)
                self.assertIn(None, found)

    def test_moderator_without_receipts_gets_no_receipt_id_at_all(self):
        _routes, found = self.walk(self.client_of(self.moderator), set(), {})
        self.assertTrue(found)
        self.assertEqual(set(found), {None})
        # Модератор видит все четыре покупки группы пиццы — каждую без ссылки на чек.
        lines = self.get(self.moderator, f"/api/product-merges/{self.group.pk}/lines/")
        self.assertEqual([line["receipt_id"] for line in lines["results"]], [None] * 4)

    def test_local_single_gets_no_receipt_id_of_other_owners(self):
        with local_single_mode():
            _routes, found = self.walk(APIClient(), set(), {})
        self.assertTrue(found)
        self.assertEqual(set(found), {None})

    def test_foreign_receipt_and_recognition_rows_are_not_found(self):
        client = self.client_of(self.first)
        for pk in sorted(self.receipts[self.second.pk]):
            for tail in ("", "lines/", "discounts/", "taxes/"):
                with self.subTest(path=f"receipts/{pk}/{tail}"):
                    self.assertEqual(client.get(f"/api/receipts/{pk}/{tail}").status_code, 404)
        for resource, pk in self.recognition[self.second.pk].items():
            with self.subTest(resource=resource):
                self.assertEqual(client.get(f"/api/recognition/{resource}/{pk}/").status_code, 404)
        for receipt_id in sorted(self.receipts[self.second.pk]):
            with self.subTest(receipt=receipt_id):
                page = self.get(self.first, f"/api/recognition/receipt-images/?receipt={receipt_id}")
                self.assertEqual(page["count"], 0)
