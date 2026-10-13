"""История трат без чека (``receipts.history``): подсказки при вводе, частые траты, похожие траты и места.

Модель не вызывается. Данные вымышленные.
"""
from django.db import connection
from django.test import SimpleTestCase, TestCase, tag
from django.test.utils import CaptureQueriesContext

from catalog.models import Category
from receipts import history, manual
from receipts.models import Receipt
from receipts.ownership import local_user
from stores import merging
from stores.models import Merchant, Store


class WordsTests(SimpleTestCase):
    def test_words_skip_numbers_and_single_letters(self):
        self.assertEqual(history.words("клод 225 12.09 a 5к такси до"), ["клод", "такси", "до"])
        self.assertEqual(history.words("a b c d e f g h"), [])
        self.assertEqual(len(history.words("раз два три четыре пять")), history.WORDS_MAX)

    def test_latin(self):
        self.assertEqual(history.latin("Магнум"), "magnum")
        self.assertEqual(history.latin("Яндекс"), "yandeks")
        self.assertEqual(history.latin("Қазақ"), "kazak")


@tag("integration")
class HistoryTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.owner = local_user()
        cls.subs = Category.objects.create(name="Демо-подписки")
        cls.food = Category.objects.create(name="Демо-еда")
        for day, total in (("2026-07-12", "200"), ("2026-08-12", "225"), ("2026-09-12", "225")):
            cls.spend("CLAUDE.AI SUBSCRIPTION", total, cls.subs, day, currency="USD", note="Claude Max")
        cls.anthropic = cls.spend("Anthropic Claude", "225", cls.subs, "2026-10-12", currency="USD").store
        cls.spend("MAGNUM", "4500", cls.food, "2026-10-01")
        cls.spend("MAGNUM", "5200", cls.food, "2026-10-05")
        cls.itemized = manual.create(cls.owner, {"currency": "KZT", "store_name": "Демо-магнит", "purchased_on": "2026-10-06",
                                                 "lines": [{"name": "Молоко", "amount": "450", "category": cls.food.pk},
                                                           {"name": "Хлеб", "amount": "230.50"}]})
        cls.spend(None, "990", cls.subs, "2026-10-07", note="Комиссия за перевод")

    @classmethod
    def spend(cls, store, total, category, day, *, currency="KZT", note=""):
        return manual.create(cls.owner, {"total": total, "currency": currency, "category": category.pk,
                                         "purchased_on": day, "store_name": store, "note": note})

    def receipts(self):
        return Receipt.objects.all()

    def test_suggest_by_the_start_of_a_store_name_most_used_first(self):
        found = history.suggest(self.receipts(), "cla")
        self.assertEqual([(item["store_name"], item["uses"], item["total"]) for item in found],
                         [("CLAUDE.AI SUBSCRIPTION", 3, "225.00"), ("Anthropic Claude", 1, "225.00")])
        self.assertEqual(found[0]["category"], {"id": self.subs.pk, "name": "Демо-подписки"})
        self.assertEqual((found[0]["currency"], found[0]["note"], found[0]["purchased_on"], found[0]["lines"]),
                         ("USD", "Claude Max", "2026-09-12", []))
        self.assertEqual(set(found[0]), {"receipt_id", "store_name", "category", "currency", "total", "note",
                                         "purchased_on", "lines", "uses"})

    def test_suggest_by_a_spelling_note_lines_and_cyrillic_typed_for_latin(self):
        claude = Receipt.objects.filter(store__name="CLAUDE.AI SUBSCRIPTION").first().store
        merging.merge(claude.pk, [self.anthropic.pk])
        found = history.suggest(self.receipts(), "anthrop")
        self.assertEqual([(item["store_name"], item["uses"]) for item in found], [("CLAUDE.AI SUBSCRIPTION", 4)])
        self.assertEqual([item["note"] for item in history.suggest(self.receipts(), "перевод")], ["Комиссия за перевод"])
        self.assertIsNone(history.suggest(self.receipts(), "перевод")[0]["store_name"])
        [itemized] = history.suggest(self.receipts(), "молок")
        self.assertIsNone(itemized["category"])
        self.assertEqual(itemized["lines"], [{"name": "Молоко", "amount": "450.00", "category": self.food.pk},
                                             {"name": "Хлеб", "amount": "230.50", "category": None}])
        self.assertEqual([item["store_name"] for item in history.suggest(self.receipts(), "магн")], ["MAGNUM", "Демо-магнит"])

    def test_every_word_must_match_and_numbers_are_ignored(self):
        self.assertEqual(history.suggest(self.receipts(), "claude магнум"), [])
        self.assertEqual(len(history.suggest(self.receipts(), "claude 225")), 2)
        self.assertEqual(history.suggest(self.receipts(), "225"), [])

    def test_frequent_are_repeated_spends_most_used_first(self):
        self.assertEqual([(item["store_name"], item["uses"], item["total"]) for item in history.frequent(self.receipts())],
                         [("CLAUDE.AI SUBSCRIPTION", 3, "225.00"), ("MAGNUM", 2, "5200.00")])

    def test_similar_spends_for_the_model(self):
        found = history.similar(self.receipts(), "claude подписка")
        self.assertEqual([(item["store_name"], item["category"], item["currency"]) for item in found],
                         [("Anthropic Claude", self.subs.pk, "USD"), ("CLAUDE.AI SUBSCRIPTION", self.subs.pk, "USD")])
        self.assertEqual(history.similar(self.receipts(), "такси до аэропорта"), [])
        self.assertEqual([item["store_name"] for item in history.similar(self.receipts(), "магнум 5000")], ["MAGNUM"])

    def test_store_names_frequent_first_with_spellings(self):
        claude = Receipt.objects.filter(store__name="CLAUDE.AI SUBSCRIPTION").first().store
        merging.merge(claude.pk, [self.anthropic.pk])
        long = manual.create(self.owner, {"total": "1", "category": self.food.pk, "store_name": "Демо-длинное"}).store
        Store.objects.filter(pk=long.pk).update(name="Д" * (manual.STORE_NAME_MAX + 1))
        Merchant.objects.filter(pk=long.merchant_id).update(brand_name="")  # a photo store may carry a longer name
        names = history.store_names(self.receipts())
        self.assertEqual(names[:2], [{"name": "CLAUDE.AI SUBSCRIPTION", "aliases": ["Anthropic Claude"]},
                                     {"name": "MAGNUM", "aliases": []}])
        self.assertEqual(len(names), 3)  # and «Демо-магнит»; the long name is left out

    def test_query_count_does_not_grow_with_spends(self):
        def count(call):
            with CaptureQueriesContext(connection) as queries:
                call()
            return len(queries)

        before = [count(lambda: history.suggest(self.receipts(), "демо")), count(lambda: history.frequent(self.receipts())),
                  count(lambda: history.similar(self.receipts(), "claude")), count(lambda: history.store_names(self.receipts()))]
        for day in range(1, 20):
            self.spend(f"Демо-место {day}", "100", self.food, f"2026-09-{day:02}")
        after = [count(lambda: history.suggest(self.receipts(), "демо")), count(lambda: history.frequent(self.receipts())),
                 count(lambda: history.similar(self.receipts(), "claude")), count(lambda: history.store_names(self.receipts()))]
        self.assertEqual(before, after)
