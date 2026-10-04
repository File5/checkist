from urllib.parse import urlencode

from django.http import QueryDict
from django.test import SimpleTestCase, TestCase, tag

from api.pagination import (
    COMPARE_MAX_PAGE_SIZE, COMPARE_PAGE_SIZE, HISTORY_MAX_PAGE_SIZE, HISTORY_PAGE_SIZE, PageParams, paginate,
)
from api.params import Params
from catalog.models import Brand
from config.exceptions import InvalidParameter, PageOutOfRange


def page_of(query, **limits):
    params = Params(QueryDict(query))
    page = params.page(**limits)
    params.check()
    return page


class PageParamsTests(SimpleTestCase):
    def test_defaults(self):
        self.assertEqual(page_of(""), PageParams(page=1, page_size=50))
        self.assertEqual(
            page_of("", default=HISTORY_PAGE_SIZE, maximum=HISTORY_MAX_PAGE_SIZE), PageParams(1, 200),
        )
        self.assertEqual(
            page_of("", default=COMPARE_PAGE_SIZE, maximum=COMPARE_MAX_PAGE_SIZE), PageParams(1, 50),
        )

    def test_bounds_are_inclusive(self):
        self.assertEqual(page_of("page=3&page_size=1"), PageParams(3, 1))
        self.assertEqual(page_of("page_size=200"), PageParams(1, 200))
        self.assertEqual(page_of("page_size=500", default=200, maximum=500), PageParams(1, 500))
        self.assertEqual(page_of("page_size=100", default=50, maximum=100), PageParams(1, 100))

    def test_empty_values_mean_defaults(self):
        self.assertEqual(page_of("page=&page_size="), PageParams(1, 50))

    def test_invalid_page_size(self):
        cases = [
            ("page_size=0", {}, "Допустимо от 1 до 200."),
            ("page_size=201", {}, "Допустимо от 1 до 200."),
            ("page_size=-1", {}, "Допустимо от 1 до 200."),
            ("page_size=abc", {}, "Допустимо от 1 до 200."),
            ("page_size=1.5", {}, "Допустимо от 1 до 200."),
            ("page_size=501", {"default": 200, "maximum": 500}, "Допустимо от 1 до 500."),
            ("page_size=101", {"default": 50, "maximum": 100}, "Допустимо от 1 до 100."),
        ]
        for query, limits, message in cases:
            with self.subTest(query=query), self.assertRaises(InvalidParameter) as raised:
                page_of(query, **limits)
            self.assertEqual(raised.exception.fields, {"page_size": [message]})

    def test_invalid_page(self):
        for value in ("0", "-1", "abc", "1.0", "+1", "٣", "9" * 20):
            with self.subTest(value=value), self.assertRaises(InvalidParameter) as raised:
                page_of(urlencode({"page": value}))
            self.assertEqual(raised.exception.fields, {"page": ["Ожидается целое число от 1."]})

    def test_both_errors_are_reported_together(self):
        with self.assertRaises(InvalidParameter) as raised:
            page_of("page=0&page_size=0")
        self.assertEqual(set(raised.exception.fields), {"page", "page_size"})


class PaginateSequenceTests(SimpleTestCase):
    items = list(range(1, 8))  # 7 элементов

    def test_first_middle_and_last_page(self):
        self.assertEqual(
            paginate(self.items, PageParams(1, 3)),
            {"count": 7, "page": 1, "page_size": 3, "pages": 3, "results": [1, 2, 3]},
        )
        self.assertEqual(paginate(self.items, PageParams(2, 3))["results"], [4, 5, 6])
        self.assertEqual(paginate(self.items, PageParams(3, 3))["results"], [7])

    def test_exact_multiple_has_no_extra_page(self):
        self.assertEqual(paginate(self.items[:6], PageParams(2, 3))["pages"], 2)
        with self.assertRaises(PageOutOfRange):
            paginate(self.items[:6], PageParams(3, 3))

    def test_page_size_larger_than_set(self):
        self.assertEqual(
            paginate(self.items, PageParams(1, 200)),
            {"count": 7, "page": 1, "page_size": 200, "pages": 1, "results": self.items},
        )

    def test_page_out_of_range(self):
        for page in (4, 10**18):
            with self.subTest(page=page), self.assertRaises(PageOutOfRange):
                paginate(self.items, PageParams(page, 3))

    def test_empty_set_on_first_page_is_ok(self):
        self.assertEqual(
            paginate([], PageParams(1, 50)),
            {"count": 0, "page": 1, "page_size": 50, "pages": 0, "results": []},
        )

    def test_empty_set_beyond_first_page_is_out_of_range(self):
        with self.assertRaises(PageOutOfRange):
            paginate([], PageParams(2, 50))

    def test_serialize_is_applied_to_page_items_only(self):
        seen = []

        def serialize(item):
            seen.append(item)
            return {"id": item}

        self.assertEqual(paginate(self.items, PageParams(2, 3), serialize)["results"], [{"id": 4}, {"id": 5}, {"id": 6}])
        self.assertEqual(seen, [4, 5, 6])


@tag("integration")
class PaginateQuerySetTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.brands = [Brand.objects.create(name=f"Бренд {number}") for number in range(1, 6)]

    def test_page_of_queryset_is_count_and_one_select(self):
        queryset = Brand.objects.order_by("name", "pk")
        with self.assertNumQueries(2):
            page = paginate(queryset, PageParams(2, 2), lambda brand: brand.name)
        self.assertEqual(page, {"count": 5, "page": 2, "page_size": 2, "pages": 3, "results": ["Бренд 3", "Бренд 4"]})

    def test_out_of_range_page_does_not_select(self):
        with self.assertNumQueries(1), self.assertRaises(PageOutOfRange):
            paginate(Brand.objects.order_by("pk"), PageParams(10**18, 2))

    def test_empty_queryset(self):
        page = paginate(Brand.objects.filter(name="нет такого").order_by("pk"), PageParams(1, 50))
        self.assertEqual(page, {"count": 0, "page": 1, "page_size": 50, "pages": 0, "results": []})
