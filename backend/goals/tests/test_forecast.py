"""``goals.forecast``: проценты по дням, капитализация 1-го числа, сверка, аннуитет и месяцы до цели.

Ставка 12 % годовых: в день — 12 / 100 / 365, в месяц — 1 %. Ожидаемые числа сверены с формулами в комментариях.
"""
from datetime import date
from decimal import Decimal

from django.test import SimpleTestCase

from goals import forecast
from goals.forecast import State

RATE = Decimal(12)
DAY = RATE / 100 / 365
JAN = [(date(2026, 1, 15), Decimal(100000), True)]


def cents(value):
    return round(value, 2)


class DailyTests(SimpleTestCase):
    def test_daily_accrual_capitalised_on_the_first(self):
        state, deposits, points = forecast.daily(JAN, RATE, True, date(2026, 3, 1))
        # 15–31 января — 17 дней на 100 000; 1 февраля они прибавлены к остатку, 28 дней февраля — уже на него;
        # 1 марта прибавлены и февральские. 100 000 × (1 + 17d) × (1 + 28d).
        self.assertEqual(cents(Decimal(100000) * (1 + 17 * DAY) * (1 + 28 * DAY)), Decimal("101484.60"))
        self.assertEqual((cents(state.total), state.accrued, deposits), (Decimal("101484.60"), 0, Decimal(100000)))
        self.assertEqual([(month.isoformat(), cents(total)) for month, total, _deposits in points],
                         [("2026-01-01", Decimal("100558.90")), ("2026-02-01", Decimal("101484.60")),
                          ("2026-03-01", Decimal("101484.60"))])
        # Сегодня не начисляется: в день взноса — ровно взнос.
        self.assertEqual(forecast.daily(JAN, RATE, True, date(2026, 1, 15))[0].total, Decimal(100000))

    def test_without_capitalisation_interest_waits_apart_and_earns_nothing(self):
        state, _deposits, _points = forecast.daily(JAN, RATE, False, date(2026, 3, 1))
        # 45 дней простых процентов: 100 000 × (1 + 45d).
        self.assertEqual((state.balance, cents(state.accrued), cents(state.total)),
                         (Decimal(100000), Decimal("1479.45"), Decimal("101479.45")))

    def test_reconciliation_up_and_down_and_the_count_goes_on_from_it(self):
        estimate = cents(forecast.daily(JAN, RATE, True, date(2026, 3, 1))[0].total)
        for bank, difference in ((Decimal(101600), Decimal("115.40")), (Decimal(101400), Decimal("-84.60"))):
            with self.subTest(bank=bank):
                self.assertEqual(bank - estimate, difference)
                events = JAN + [(date(2026, 3, 1), difference, False)]
                state, deposits, _points = forecast.daily(events, RATE, True, date(2026, 3, 1))
                self.assertEqual((cents(state.total), deposits), (bank, Decimal(100000)))
                # Дальше — от сверенного остатка: 31 день марта, 1 апреля прибавлены.
                later = forecast.daily(events, RATE, True, date(2026, 4, 1))[0].total
                self.assertEqual(cents(later), cents(state.total * (1 + 31 * DAY)))

    def test_without_events_nothing_and_a_later_contribution_counts_without_interest(self):
        self.assertEqual(forecast.daily([], RATE, True, date(2026, 3, 1)), (State(), 0, []))
        state, deposits, _points = forecast.daily([(date(2026, 5, 1), Decimal(10), True)], RATE, True, date(2026, 3, 1))
        self.assertEqual((state.total, deposits), (Decimal(10), Decimal(10)))


class ForecastTests(SimpleTestCase):
    def test_a_year_with_and_without_capitalisation(self):
        self.assertEqual(cents(forecast.project(State(Decimal(1000000)), RATE, True, 12).total), Decimal("1126825.03"))
        self.assertEqual(cents(forecast.project(State(Decimal(1000000)), RATE, False, 12).total), Decimal("1120000.00"))

    def test_annuity_and_zero_rate(self):
        # 100 000 в конце каждого месяца под 1 %: 100 000 × (1,01¹² − 1) / 0,01 = 1 268 250,30.
        self.assertEqual(cents(forecast.need(State(), RATE, True, 12, Decimal("1268250.30"))), Decimal("100000.00"))
        # Ставка 0 — прежнее «осталось / месяцев»: (600 000 − 100 000) / 7.
        self.assertEqual(cents(forecast.need(State(Decimal(100000)), 0, True, 7, Decimal(600000))), Decimal("71428.57"))

    def test_interest_alone_reaches_the_goal(self):
        # 1 000 000 за год вырастут до 1 126 825,03 — взносов не нужно.
        self.assertEqual(forecast.need(State(Decimal(1000000)), RATE, True, 12, Decimal(1100000)), 0)
        self.assertGreater(forecast.need(State(Decimal(1000000)), 0, True, 12, Decimal(1100000)), 0)

    def test_months_to_the_goal(self):
        # По 100 000: 100 000 → 201 000 → 303 010 — три месяца; без процентов 301 000 — только за четыре.
        self.assertEqual(forecast.months_to(State(), RATE, True, Decimal(301000), Decimal(100000)), 3)
        self.assertEqual(forecast.months_to(State(), 0, True, Decimal(301000), Decimal(100000)), 4)
        self.assertEqual(forecast.months_to(State(Decimal(5)), RATE, True, Decimal(5), 0), 0)
        self.assertIsNone(forecast.months_to(State(), 0, True, Decimal(1), 0))

    def test_every_loop_is_bounded(self):
        # Прогноз — не дальше HORIZON месяцев, сколько бы ни попросили.
        far = forecast.project(State(Decimal(1)), RATE, True, 10 ** 9)
        self.assertEqual(far, forecast.project(State(Decimal(1)), RATE, True, forecast.HORIZON))
        # Начисление — отрезками: 26 лет с одним взносом считаются по месяцам.
        state, _deposits, points = forecast.daily([(date(2000, 1, 1), Decimal(1000), True)], RATE, True, date(2026, 3, 1))
        self.assertEqual(len(points), 315)
        self.assertGreater(state.total, Decimal(1000))
