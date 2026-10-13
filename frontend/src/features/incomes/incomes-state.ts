/** «Доходы»: the words of the line of «Главная» and of the list, the lines of «Динамика»; no network, no React. */
import type { IncomeFigures, IncomeStats, IncomeTrends } from '../../api/incomes'
import { decimalNumber } from '../../api/stats'
import { parseMonthParam } from '../../navigation/routes'
import type { LineChartSeries } from '../../lib/charts'
import { chartNumber } from '../../lib/charts/scale'
import { formatMoney } from '../../lib/money'
import { glue } from '../../lib/text'
import { monthStart } from '../stats/trends-state'

/** The two lines of «Доход и отложено»: what came in and what was left of it; a month without an income is a gap, not a zero.
 * `spent` adds the third, «Потрачено», for «Доходы» of the statistics: income against spends. */
export function incomeSeries(data: IncomeTrends, spent = false): LineChartSeries[] {
  const line = (key: 'income' | 'saved' | 'spent', label: string, slot: number): LineChartSeries => ({
    key, label, slot,
    points: data.items.flatMap((item) => {
      const value = chartNumber(item[key])
      return value === null ? [] : [{ x: monthStart(item.month), value, valueText: formatMoney(item[key], data.base_currency) }]
    }),
  })
  return [line('income', 'Доход', 2), ...(spent ? [line('spent', 'Потрачено', 1)] : []), line('saved', 'Отложено', 0)]
}

export type CategoryRow = { id: number; label: string; amount: string; bar: number; tone: number }
/** «Доход по категориям» of the statistics: the sums of the server in its order, a bar against the largest one (2–100 %)
 * and one of the six category colours by place; the client adds no money and counts no share of its own. */
export function categoryRows(data: IncomeStats): CategoryRow[] {
  const largest = Math.max(0, ...data.categories.map((row) => decimalNumber(row.total) ?? 0))
  return data.categories.map((row, index) => {
    const value = decimalNumber(row.total) ?? 0
    return { id: row.id, label: row.name, amount: formatMoney(row.total, data.base_currency), tone: (index % 6) + 1,
      bar: largest > 0 && value > 0 ? Math.max(2, Math.round((value / largest) * 100)) : 0 }
  })
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

/** The month last opened on «Доходы» in this tab of the browser: `/incomes` without a month opens it again until the
 * session ends; a new session opens the current month. Without storage — always the current one. */
export const INCOME_MONTH_KEY = 'checkist.incomes.month'
export function sessionIncomeMonth(): string | undefined {
  try {
    return parseMonthParam(window.sessionStorage.getItem(INCOME_MONTH_KEY))
  } catch {
    return undefined
  }
}
export function rememberIncomeMonth(month: string) {
  try {
    window.sessionStorage.setItem(INCOME_MONTH_KEY, month)
  } catch { /* No storage: a new visit opens the current month. */ }
}

/** The line under a save or a deletion, on «Доходы»; the page reads it once. */
let notice: string | undefined
export function setIncomeNotice(message: string) { notice = message }
export function takeIncomeNotice(): string | undefined {
  const message = notice
  notice = undefined
  return message
}
