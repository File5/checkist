/** «Динамика» without React: requests from the address, chart series and the texts around them. Pure. */
import { decimalNumber } from '../../api/stats'
import type {
  TrendsCategory, TrendsCategoryCurrency, TrendsCategoryParams, TrendsMonthlyCurrency, TrendsMover, TrendsParams, TrendsPricesCurrency,
} from '../../api/trends'
import type { Decimal } from '../../api/types'
import type { LineChartPoint, LineChartSeries, StackedColumn, StackedLegendEntry } from '../../lib/charts'
import { formatAxisTick } from '../../lib/charts/scale'
import { categoryTone } from '../../lib/category-tone'
import { formatAmount, formatPercent, formatPrice } from '../../lib/format'
import { glue } from '../../lib/text'
import { spendingHref, trendsHref, trendsMonthChoices } from '../../navigation'
import type { TrendsMonths, TrendsQuery } from '../../navigation'
import { intervalName } from './receipts-series'

export const defaultTrendsMonths = 12
/** The key of what has no category in «Траты по месяцам»: services, deposits, lines without a category, discounts. */
export const uncategorizedKey = 'uncategorized'
export const uncategorizedLabel = 'Без категории'

export const windowMonths = (query: TrendsQuery): TrendsMonths => query.months ?? defaultTrendsMonths
/** The window ends at the server's current month; the opened column and the category never change it. */
export const windowParams = (query: TrendsQuery): TrendsParams => ({ months: windowMonths(query) })
export const categoryParams = (query: TrendsQuery): TrendsCategoryParams => ({ ...windowParams(query), ...(query.category && { category: query.category }) })

/** `YYYY-MM` as the period start the charts work with. */
export const monthStart = (month: string) => `${month}-01`
/** «сентябрь 2026», short — «сен 2026». */
export const monthName = (month: string, short = false) => intervalName(monthStart(month), 'month', short)
const prepositional = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре']
const genitive = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']
const monthWord = (words: readonly string[], month: string) => glue(words[Number(month.slice(5, 7)) - 1] ?? month, month.slice(0, 4))
/** «в сентябре 2026». */
export const inMonth = (month: string) => `в ${monthWord(prepositional, month)}`
/** «с сентября 2026». */
export const sinceMonth = (month: string) => `с ${monthWord(genitive, month)}`
const startName = (x: string) => intervalName(x, 'month')
const startTick = (x: string) => intervalName(x, 'month', true)
export { startName as formatMonthStart, startTick as formatMonthTick }

/** Money axis: whole or with two decimals, like an amount. */
export const moneyAxis = (value: number, step?: number) => formatAxisTick(value, step, true)
/** Index axis: as many decimals as the step has. */
export const indexAxis = (value: number, step?: number) => formatAxisTick(value, step)

export interface WindowChoice { months: TrendsMonths; label: string; href: string; active: boolean }
/** 6, 12 and 24 months; switching keeps the category and closes the opened month (it may be outside the new window). */
export function windowChoices(query: TrendsQuery): WindowChoice[] {
  const current = windowMonths(query)
  return trendsMonthChoices.map((months) => ({
    months, label: glue(String(months), months === 24 ? 'месяца' : 'месяцев'),
    href: trendsHref({ ...query, month: undefined, months: months === 12 ? undefined : months }), active: months === current,
  }))
}

// --- «Траты по месяцам» ---

const positive = (value: Decimal) => (decimalNumber(value) ?? 0) > 0

export interface MonthlyChart { legend: StackedLegendEntry[]; columns: StackedColumn[] }
/** Columns of one currency: categories in the order of the legend, then «Без категории» when it is positive. */
export function monthlyChart(block: TrendsMonthlyCurrency, query: TrendsQuery): MonthlyChart {
  const money = (value: Decimal) => formatAmount(value, block.currency)
  const withRest = block.months.some((entry) => positive(entry.uncategorized))
  const legend: StackedLegendEntry[] = [
    ...block.categories.map((category) => ({
      key: String(category.id), label: category.name, tone: categoryTone(category.id), note: money(category.total),
    })),
    ...(withRest ? [{ key: uncategorizedKey, label: uncategorizedLabel, tone: 0 }] : []),
  ]
  const columns = block.months.map((entry): StackedColumn => ({
    x: monthStart(entry.month),
    totalText: money(entry.total),
    href: monthHref(query, entry.month),
    segments: [
      ...entry.categories.map((part) => ({ key: String(part.id), value: decimalNumber(part.amount) ?? 0, valueText: money(part.amount) })),
      ...(positive(entry.uncategorized)
        ? [{ key: uncategorizedKey, value: decimalNumber(entry.uncategorized) ?? 0, valueText: money(entry.uncategorized) }] : []),
    ],
  }))
  return { legend, columns }
}

/** A column opens its month; the opened one closes again. */
export const monthHref = (query: TrendsQuery, month: string) => trendsHref({ ...query, month: query.month === month ? undefined : month })
export const closeMonthHref = (query: TrendsQuery) => trendsHref({ ...query, month: undefined })

export interface BreakdownRow { key: string; label: string; tone: number; amount: string; href?: string }
export interface MonthBreakdown {
  month: string
  title: string
  total: string
  rows: BreakdownRow[]
  /** The same month on «Траты» with the drill-down into products. */
  spendingHref: string
}
/** The opened month of one currency; `null` when the month is outside the window of the answer. */
export function monthBreakdown(block: TrendsMonthlyCurrency, month: string | undefined): MonthBreakdown | null {
  const entry = month === undefined ? undefined : block.months.find((item) => item.month === month)
  if (!entry) return null
  const money = (value: Decimal) => formatAmount(value, block.currency)
  const names = new Map(block.categories.map((category) => [category.id, category.name]))
  const [year, number] = entry.month.split('-').map(Number)
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate()
  const period = { date_from: `${entry.month}-01`, date_to: `${entry.month}-${String(last).padStart(2, '0')}`, currency: block.currency }
  const rows: BreakdownRow[] = entry.categories.map((part) => ({
    key: String(part.id), label: names.get(part.id) ?? '', tone: categoryTone(part.id), amount: money(part.amount),
    href: spendingHref({ ...period, category: part.id }),
  }))
  if (decimalNumber(entry.uncategorized) !== 0) rows.push({ key: uncategorizedKey, label: uncategorizedLabel, tone: 0, amount: money(entry.uncategorized) })
  return { month: entry.month, title: monthName(entry.month), total: money(entry.total), rows, spendingHref: spendingHref(period) }
}

/** «В среднем 45 000,00 KZT в месяц», the total of the window — for the head of a currency block. */
export function monthlySummary(block: Pick<TrendsMonthlyCurrency, 'currency' | 'total' | 'average'>): { total: string; average: string } {
  return { total: formatAmount(block.total, block.currency), average: formatAmount(block.average, block.currency) }
}

// --- «Категория во времени» ---

/** «Жильё › Коммунальные услуги». */
export const optionLabel = (path: readonly string[]) => path.join(' › ')
export const categoryHref = (query: TrendsQuery, category: number | undefined) => trendsHref({ ...query, category })

/** Monthly spend of the category and its average as two lines; every month is a point, an empty one is zero. */
export function categoryChart(block: TrendsCategoryCurrency): LineChartSeries[] {
  const money = (value: Decimal) => formatAmount(value, block.currency)
  const points = (pick: (amount: Decimal) => Decimal): LineChartPoint[] => block.months.map((entry) => ({
    x: monthStart(entry.month), value: decimalNumber(pick(entry.amount)) ?? 0, valueText: money(pick(entry.amount)),
  }))
  return [
    { key: 'amount', label: 'Потрачено за месяц', shortLabel: 'месяц', points: points((amount) => amount) },
    { key: 'average', label: 'В среднем за месяц', shortLabel: 'среднее', points: points(() => block.average), slot: 1 },
  ]
}

export interface CategoryChange { last: string; previous: string; text: string; tone: 'more' | 'less' | 'same' }
/** The last month against the one before it: «на 3 000,00 KZT больше, чем в августе 2026». Strings only, no arithmetic on money. */
export function lastMonthChange(block: TrendsCategoryCurrency): CategoryChange | null {
  const [previous, last] = block.months.slice(-2)
  if (!previous || !last) return null
  const a = decimalNumber(previous.amount) ?? 0
  const b = decimalNumber(last.amount) ?? 0
  const tone = b > a ? 'more' : b < a ? 'less' : 'same'
  const text = tone === 'same' ? `Столько же, сколько ${inMonth(previous.month)}`
    : `${tone === 'more' ? 'Больше' : 'Меньше'}, чем ${inMonth(previous.month)} (${formatAmount(previous.amount, block.currency)})`
  return { last: formatAmount(last.amount, block.currency), previous: formatAmount(previous.amount, block.currency), text, tone }
}

/** What the person is looking at: the chosen category, or the suggestion of the server. */
export function categoryHeading(data: TrendsCategory): string {
  if (data.category === null) return 'Трат по категориям за это время нет'
  return optionLabel(data.category.path.map((node) => node.name))
}

// --- «Как менялись цены» ---

export function indexChart(block: TrendsPricesCurrency): LineChartSeries[] {
  return [{
    key: 'index', label: 'Индекс цен семьи', shortLabel: 'индекс',
    points: block.points.flatMap((point) => {
      const value = decimalNumber(point.index)
      return point.index === null || value === null ? [] : [{ x: monthStart(point.month), value, valueText: formatIndexValue(point.index) }]
    }),
  }]
}
/** «108,25» — the index of a month, 100 is the first month with purchases. */
export const formatIndexValue = (value: Decimal) => formatPercent(value).replace(/\u00a0%$/, '')

/** The last month with an index against 100: «Цены выросли на 8,25 % с июня 2025». */
export function indexSummary(block: TrendsPricesCurrency): { text: string; tone: 'more' | 'less' | 'same' } | null {
  const last = [...block.points].reverse().find((point) => point.index !== null)
  if (!last || last.index === null || block.first_month === null || last.month === block.first_month) return null
  const value = decimalNumber(last.index) ?? 100
  const since = sinceMonth(block.first_month)
  if (value === 100) return { text: `Цены на те же товары не изменились ${since}`, tone: 'same' }
  // The change is the index minus 100: both are already two-place strings, so the text keeps the server's digits.
  const change = indexChange(last.index)
  return { text: `Цены на те же товары ${value > 100 ? 'выросли' : 'снизились'} на ${change} ${since}`, tone: value > 100 ? 'more' : 'less' }
}
/** `|index − 100|` of a two-place string as a percent text; exact on the digits, never through a float. */
export function indexChange(index: Decimal): string {
  const match = /^(-?)(\d+)\.(\d{2})$/.exec(index)
  if (!match) return '—'
  const cents = BigInt(`${match[1]}${match[2]}${match[3]}`) - 10000n
  const absolute = cents < 0n ? -cents : cents
  return formatPercent(`${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`)
}

export interface MoverRow { key: string; productId: number; name: string; old: string; next: string; change: string; oldMonth: string; newMonth: string }
export function moverRows(movers: readonly TrendsMover[], currency: string): MoverRow[] {
  return movers.map((mover) => ({
    key: `${mover.product.id}-${mover.unit}`, productId: mover.product.id, name: mover.product.name,
    old: formatPrice(mover.old.price, currency, mover.unit), next: formatPrice(mover.new.price, currency, mover.unit),
    change: `${mover.change_percent.startsWith('-') ? '' : '+'}${formatPercent(mover.change_percent)}`,
    oldMonth: monthName(mover.old.month), newMonth: monthName(mover.new.month),
  }))
}
