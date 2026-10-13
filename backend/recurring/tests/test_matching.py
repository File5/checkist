"""``recurring.matching`` без БД: окно месяца, признаки совпадения, одна трата — один платёж, предложения."""
from datetime import date
from decimal import Decimal

from django.test import SimpleTestCase

from budget.dashboard import Month
from recurring.matching import (
    Plan, Spend, assign, average, common_category, due_date, month_of, signals, suggest, window,
)

D = Decimal
# Дерево: 1 Жильё › 2 Аренда, 1 › 3 Коммунальные › 4 Свет, 3 › 5 Вода; 6 Подписки — отдельный корень.
PARENTS = {1: None, 2: 1, 3: 1, 4: 3, 5: 3, 6: None}
RENT = Plan(id=1, store_id=10, category_id=2, currency="KZT", amount=D("220000"), due_day=5)


def spend(pk, day, total, store_id=None, category_id=None, currency="KZT"):
    return Spend(pk, day, store_id, category_id, currency, D(total))


class WindowTests(SimpleTestCase):
    def test_window_runs_from_ten_days_before_due_to_ten_days_before_next_due(self):
        self.assertEqual(window(Month(2026, 10), 5), (date(2026, 9, 25), date(2026, 10, 26)))
        self.assertEqual(month_of(date(2026, 9, 24), 5), Month(2026, 9))
        self.assertEqual(month_of(date(2026, 9, 25), 5), Month(2026, 10))  # 25-го и позже — следующий месяц
        self.assertEqual(month_of(date(2026, 10, 25), 5), Month(2026, 10))
        self.assertEqual(month_of(date(2026, 10, 26), 5), Month(2026, 11))

    def test_day_31_is_the_last_day_of_a_short_month(self):
        self.assertEqual(due_date(Month(2026, 2), 31), date(2026, 2, 28))
        self.assertEqual(window(Month(2026, 2), 31), (date(2026, 2, 18), date(2026, 3, 21)))
        self.assertEqual(month_of(date(2026, 2, 17), 31), Month(2026, 1))
        self.assertEqual(month_of(date(2026, 3, 20), 31), Month(2026, 2))
        self.assertEqual(month_of(date(2026, 12, 25), 1), Month(2027, 1))

    def test_windows_of_a_year_cover_every_day_once(self):
        for due_day in (1, 5, 15, 28, 31):
            days = set()
            for month in range(1, 13):
                start, end = window(Month(2026, month), due_day)
                span = {start.toordinal() + step for step in range((end - start).days)}
                self.assertFalse(days & span, due_day)
                days |= span
            first, _ = window(Month(2026, 1), due_day)
            _, last = window(Month(2026, 12), due_day)
            self.assertEqual(len(days), (last - first).days, due_day)


class CategoryTests(SimpleTestCase):
    def test_common_category_of_lines(self):
        self.assertEqual(common_category({4, 5}, PARENTS), 3)
        self.assertEqual(common_category({4, 2}, PARENTS), 1)
        self.assertEqual(common_category({4}, PARENTS), 4)
        self.assertIsNone(common_category({4, 6}, PARENTS))
        self.assertIsNone(common_category(set(), PARENTS))

    def test_a_cycle_in_the_tree_ends(self):
        self.assertEqual(common_category({7}, {7: 8, 8: 7}), 7)
        self.assertIsNone(common_category({7, 8}, {7: 8, 8: 7}))


class SignalTests(SimpleTestCase):
    def test_two_of_three_signals(self):
        cases = [
            (spend(1, date(2026, 10, 5), "220000", store_id=10, category_id=2), 3),
            (spend(1, date(2026, 10, 5), "9000", store_id=10, category_id=2), 2),  # магазин и категория
            (spend(1, date(2026, 10, 5), "230000", store_id=10, category_id=4), 2),  # магазин и сумма
            (spend(1, date(2026, 10, 5), "200000", store_id=99, category_id=2), 2),  # категория и сумма
            (spend(1, date(2026, 10, 5), "165000", store_id=99, category_id=2), 2),  # −25 %: ещё близко
            (spend(1, date(2026, 10, 5), "160000", store_id=99, category_id=2), 1),  # −27 %: уже нет
            (spend(1, date(2026, 10, 5), "220000", store_id=None, category_id=None), 1),
        ]
        for item, expected in cases:
            self.assertEqual(signals(RENT, item, PARENTS), expected, item)

    def test_category_matches_descendants_not_ancestors(self):
        utilities = Plan(id=2, store_id=None, category_id=3, currency="KZT", amount=D("9000"), due_day=9)
        self.assertEqual(signals(utilities, spend(1, date(2026, 10, 9), "9500", category_id=4), PARENTS), 2)
        self.assertEqual(signals(utilities, spend(1, date(2026, 10, 9), "9500", category_id=1), PARENTS), 1)


class AssignTests(SimpleTestCase):
    months = [Month(2026, 9), Month(2026, 10)]

    def test_one_spend_pays_one_plan_for_one_month(self):
        rent = spend(1, date(2026, 10, 5), "220000", store_id=10, category_id=2)
        osi = spend(2, date(2026, 10, 12), "8900", store_id=10, category_id=1)
        bill = spend(3, date(2026, 10, 9), "9100", store_id=10, category_id=1)
        home = Plan(id=2, store_id=10, category_id=1, currency="KZT", amount=D("9100"), due_day=9)
        osi_plan = Plan(id=3, store_id=10, category_id=1, currency="KZT", amount=D("8900"), due_day=12)
        result = assign([RENT, home, osi_plan], [rent, osi, bill], self.months, PARENTS)
        self.assertEqual(result[(1, Month(2026, 10))], rent)
        self.assertEqual(result[(2, Month(2026, 10))], bill)
        self.assertEqual(result[(3, Month(2026, 10))], osi)
        self.assertNotIn((1, Month(2026, 9)), result)

    def test_best_candidate_wins_and_other_currency_never_pays(self):
        close = spend(1, date(2026, 10, 4), "221000", store_id=10, category_id=2)
        far = spend(2, date(2026, 10, 6), "260000", store_id=10, category_id=2)
        usd = spend(3, date(2026, 10, 5), "220000", store_id=10, category_id=2, currency="USD")
        refund = spend(4, date(2026, 10, 5), "-220000", store_id=10, category_id=2)
        result = assign([RENT], [far, usd, refund, close], self.months, PARENTS)
        self.assertEqual(result, {(1, Month(2026, 10)): close})

    def test_fixed_spend_stays_with_its_plan(self):
        added = spend(5, date(2026, 9, 5), "1000", category_id=6)
        result = assign([RENT], [added], self.months, PARENTS, fixed={(1, Month(2026, 9)): 5})
        self.assertEqual(result, {(1, Month(2026, 9)): added})

    def test_average(self):
        self.assertEqual(average([D("200"), D("225"), D("225")]), D("216.67"))
        self.assertIsNone(average([]))


class SuggestTests(SimpleTestCase):
    today = date(2026, 10, 13)

    def monthly(self, start_pk, months, total, **fields):
        return [spend(start_pk + index, date(2026, month, 5), total, **fields) for index, month in enumerate(months)]

    def test_three_months_in_a_row_with_similar_amount(self):
        spends = self.monthly(1, [7, 8, 9, 10], "220000", store_id=10, category_id=2)
        spends += self.monthly(20, [8, 9], "6700", store_id=11, category_id=6)  # два месяца — мало
        found = suggest(spends, self.today)
        self.assertEqual(len(found), 1)
        item = found[0]
        self.assertEqual((item.store_id, item.category_id, item.currency, item.amount, item.due_day, item.months),
                         (10, 2, "KZT", D("220000"), 5, 4))

    def test_price_rise_within_tolerance_keeps_the_chain(self):
        spends = [spend(1, date(2026, 7, 3), "200", store_id=10, category_id=6, currency="USD"),
                  spend(2, date(2026, 8, 3), "200", store_id=10, category_id=6, currency="USD"),
                  spend(3, date(2026, 9, 3), "225", store_id=10, category_id=6, currency="USD")]
        self.assertEqual(suggest(spends, self.today)[0].amount, D("225"))
        spends[2] = spend(3, date(2026, 9, 3), "300", store_id=10, category_id=6, currency="USD")
        self.assertEqual(suggest(spends, self.today), [])

    def test_a_gap_breaks_the_chain_but_not_an_older_one(self):
        spends = self.monthly(1, [5, 6, 7], "6700", store_id=10, category_id=6)
        spends += self.monthly(10, [9], "6700", store_id=10, category_id=6)  # август забыли
        self.assertEqual(suggest(spends, self.today)[0].months, 3)
        old = [spend(1 + index, date(2026, month, 5), "6700", store_id=10, category_id=6) for index, month in enumerate([1, 2, 3])]
        self.assertEqual(suggest(old, self.today), [])  # закончилась больше полугода назад

    def test_frequent_purchases_are_not_a_payment(self):
        spends = []
        for month in (7, 8, 9, 10):
            spends += [spend(month * 10 + day, date(2026, month, day), "2000", store_id=12, category_id=6)
                       for day in (2, 9, 16)]
        self.assertEqual(suggest(spends, self.today), [])

    def test_covered_suggestions_are_left_out(self):
        spends = self.monthly(1, [8, 9, 10], "220000", store_id=10, category_id=2)
        self.assertEqual(suggest(spends, self.today, lambda *key: True), [])
        self.assertEqual(len(suggest(spends, self.today, lambda store, category, currency, last: last.id != 3)), 1)
