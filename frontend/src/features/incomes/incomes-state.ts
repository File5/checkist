/** «Доходы»: the words of the line of «Главная» and of the list, the lines of «Динамика»; no network, no React. */
import type { IncomeFigures, IncomeTrends } from '../../api/incomes'
import type { LineChartSeries } from '../../lib/charts'
import { chartNumber } from '../../lib/charts/scale'
import { formatMoney } from '../../lib/money'
import { glue } from '../../lib/text'
import { monthStart } from '../stats/trends-state'

/** The two lines of «Доход и отложено»: what came in and what was left of it; a month without an income is a gap, not a zero. */
export function incomeSeries(data: IncomeTrends): LineChartSeries[] {
  const line = (key: 'income' | 'saved', label: string, slot: number): LineChartSeries => ({
    key, label, slot,
    points: data.items.flatMap((item) => {
      const value = chartNumber(item[key])
      return value === null ? [] : [{ x: monthStart(item.month), value, valueText: formatMoney(item[key], data.base_currency) }]
    }),
  })
  return [line('income', 'Доход', 2), line('saved', 'Отложено', 0)]
}

export type SummaryPart = { label: string; value: string; note?: string }

/** «Доход 950 000 ₸ · Потрачено 200 000 ₸ · Отложено 750 000 ₸ (79 %)»; `null` while no income of the month is entered
 * — the line asks for it instead of showing a zero. Spent more than came in — «Перерасход». */
export function summaryParts(figures: IncomeFigures, currency: string): SummaryPart[] | null {
  if (figures.income === null || figures.saved === null) return null
  const over = figures.saved.startsWith('-')
  const percent = figures.saved_percent === null ? undefined : glue(String(Math.round(Math.abs(Number(figures.saved_percent)))), '%')
  return [
    { label: 'Доход', value: formatMoney(figures.income, currency) },
    { label: 'Потрачено', value: formatMoney(figures.spent, currency) },
    { label: over ? 'Перерасход' : 'Отложено', value: formatMoney(over ? figures.saved.slice(1) : figures.saved, currency), note: percent },
  ]
}

/** The line under a save or a deletion, on «Доходы»; the page reads it once. */
let notice: string | undefined
export function setIncomeNotice(message: string) { notice = message }
export function takeIncomeNotice(): string | undefined {
  const message = notice
  notice = undefined
  return message
}
