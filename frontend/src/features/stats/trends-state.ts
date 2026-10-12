/** «Динамика» without React: requests from the address, chart series and the texts around them. Pure. */
import { decimalNumber } from '../../api/stats'
import type {
  TrendsCategory, TrendsCategoryCurrency, TrendsCategoryParams, TrendsLimit, TrendsMonthlyCurrency, TrendsMover, TrendsParams,
  TrendsPricesCurrency,
} from '../../api/trends'
import type { Decimal } from '../../api/types'
import type { LineChartPoint, LineChartSeries, StackedColumn, StackedLegendEntry } from '../../lib/charts'
import { formatAxisTick } from '../../lib/charts/scale'
import { categoryTone } from '../../lib/category-tone'
import { formatPercent, formatPrice } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { glue } from '../../lib/text'
import { spendingHref, trendsHref, trendsMonthChoices } from '../../navigation'
import type { TrendsMonths, TrendsQuery } from '../../navigation'
import type { StatsRequestState } from './receipts-request'
import { intervalName } from './receipts-series'

/**
 * The one place where «Динамика» turns a sum into text. When the central money helper arrives (`lib/money.ts`,
 * `formatMoney`, rounding up to whole units for display), swap the body of this function and nothing else.
 */
export function money(value: Decimal | null, currency: string): string {
  return formatMoney(value, currency)
}

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
  const amount = (value: Decimal) => money(value, block.currency)
  const withRest = block.months.some((entry) => positive(entry.uncategorized))
  const legend: StackedLegendEntry[] = [
    ...block.categories.map((category) => ({
      key: String(category.id), label: category.name, tone: categoryTone(category.id), note: amount(category.total),
    })),
    ...(withRest ? [{ key: uncategorizedKey, label: uncategorizedLabel, tone: 0 }] : []),
  ]
  const columns = block.months.map((entry): StackedColumn => ({
    x: monthStart(entry.month),
    totalText: amount(entry.total),
    href: monthHref(query, entry.month),
    segments: [
      ...entry.categories.map((part) => ({ key: String(part.id), value: decimalNumber(part.amount) ?? 0, valueText: amount(part.amount) })),
      ...(positive(entry.uncategorized)
        ? [{ key: uncategorizedKey, value: decimalNumber(entry.uncategorized) ?? 0, valueText: amount(entry.uncategorized) }] : []),
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
  const amount = (value: Decimal) => money(value, block.currency)
  const names = new Map(block.categories.map((category) => [category.id, category.name]))
  const [year, number] = entry.month.split('-').map(Number)
  const last = new Date(Date.UTC(year, number, 0)).getUTCDate()
  const period = { date_from: `${entry.month}-01`, date_to: `${entry.month}-${String(last).padStart(2, '0')}`, currency: block.currency }
  const rows: BreakdownRow[] = entry.categories.map((part) => ({
    key: String(part.id), label: names.get(part.id) ?? '', tone: categoryTone(part.id), amount: amount(part.amount),
    href: spendingHref({ ...period, category: part.id }),
  }))
  if (decimalNumber(entry.uncategorized) !== 0) rows.push({ key: uncategorizedKey, label: uncategorizedLabel, tone: 0, amount: amount(entry.uncategorized) })
  return { month: entry.month, title: monthName(entry.month), total: amount(entry.total), rows, spendingHref: spendingHref(period) }
}

/** «В среднем 45 000,00 KZT в месяц», the total of the window — for the head of a currency block. */
export function monthlySummary(block: Pick<TrendsMonthlyCurrency, 'currency' | 'total' | 'average'>): { total: string; average: string } {
  return { total: money(block.total, block.currency), average: money(block.average, block.currency) }
}

// --- «Категория во времени» ---

/** «Жильё › Коммунальные услуги». */
export const optionLabel = (path: readonly string[]) => path.join(' › ')
export const categoryHref = (query: TrendsQuery, category: number | undefined) => trendsHref({ ...query, category })

/** Monthly spend of the category and its average as two lines; every month is a point, an empty one is zero. */
export function categoryChart(block: TrendsCategoryCurrency): LineChartSeries[] {
  const amount = (value: Decimal) => money(value, block.currency)
  const points = (pick: (amount: Decimal) => Decimal): LineChartPoint[] => block.months.map((entry) => ({
    x: monthStart(entry.month), value: decimalNumber(pick(entry.amount)) ?? 0, valueText: amount(pick(entry.amount)),
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
    : `${tone === 'more' ? 'Больше' : 'Меньше'}, чем ${inMonth(previous.month)} (${money(previous.amount, block.currency)})`
  return { last: money(last.amount, block.currency), previous: money(previous.amount, block.currency), text, tone }
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

/** The index of the last month against 100: «Цены на те же товары выросли на 8,25 % с июня 2025». */
export function indexSummary(block: TrendsPricesCurrency): { text: string; badge: ChangeBadge } | null {
  const badge = changeBadge(block.change_percent)
  if (badge === null || block.first_month === null) return null
  const since = sinceMonth(block.first_month)
  const text = badge.tone === 'same' ? `Цены на те же товары не изменились ${since}`
    : `Цены на те же товары ${badge.tone === 'up' ? 'выросли' : 'снизились'} на ${badge.magnitude} ${since}`
  return { text, badge }
}

export interface MoverRow { key: string; productId: number; name: string; old: string; next: string; change: string; oldMonth: string; newMonth: string }
export function moverRows(movers: readonly TrendsMover[], currency: string): MoverRow[] {
  return movers.map((mover) => ({
    key: `${mover.product.id}-${mover.unit}`, productId: mover.product.id, name: mover.product.name,
    old: formatPrice(mover.old.price, currency, mover.unit), next: formatPrice(mover.new.price, currency, mover.unit),
    change: changeBadge(mover.change_percent)?.text ?? formatPercent(mover.change_percent),
    oldMonth: monthName(mover.old.month), newMonth: monthName(mover.new.month),
  }))
}

// --- изменения: стрелка, знак и слово, не только цвет ---

export interface ChangeBadge {
  tone: 'up' | 'down' | 'same'
  arrow: '▲' | '▼' | '='
  /** «+12,41 %», «−3,10 %», «0,00 %». */
  text: string
  /** «12,41 %» without a sign, for a sentence. */
  magnitude: string
  /** For assistive technology and the title: «больше на 12,41 %». */
  words: string
}
/** A percent string of the server as a badge; `null` — nothing to compare with. */
export function changeBadge(percent: Decimal | null, more = 'больше', less = 'меньше'): ChangeBadge | null {
  if (percent === null) return null
  const negative = percent.startsWith('-')
  const magnitude = formatPercent(negative ? percent.slice(1) : percent)
  if (/^-?0+(\.0+)?$/.test(percent)) return { tone: 'same', arrow: '=', text: magnitude, magnitude, words: 'без изменений' }
  return negative
    ? { tone: 'down', arrow: '▼', text: `\u2212${magnitude}`, magnitude, words: `${less} на ${magnitude}` }
    : { tone: 'up', arrow: '▲', text: `+${magnitude}`, magnitude, words: `${more} на ${magnitude}` }
}

// --- сводка сверху ---

export interface SpendSummaryCard {
  currency: string
  monthTitle: string
  spent: string
  vsPrevious: { badge: ChangeBadge; label: string } | null
  vsAverage: { badge: ChangeBadge; label: string } | null
  average: string
}
export function spendSummary(block: TrendsMonthlyCurrency): SpendSummaryCard {
  const { summary } = block
  const vsPrevious = changeBadge(summary.change_percent)
  const vsAverage = changeBadge(summary.average_change_percent)
  return {
    currency: block.currency, monthTitle: monthName(summary.month), spent: money(summary.spent, block.currency),
    vsPrevious: vsPrevious && summary.previous_month ? { badge: vsPrevious, label: `чем ${inMonth(summary.previous_month)}` } : null,
    vsAverage: vsAverage ? { badge: vsAverage, label: 'чем в среднем за период' } : null,
    average: money(block.average, block.currency),
  }
}

// --- «Месяц к месяцу» ---

export interface MonthRow {
  key: string
  id: number
  name: string
  depth: number
  previous: string
  last: string
  badge: ChangeBadge | null
  /** Drawing values of every month for the sparkline. */
  values: number[]
  href: string
}
/** Rows of one currency: top-level categories with their sub-categories; the link opens the category over time. */
export function monthRows(block: TrendsMonthlyCurrency, query: TrendsQuery): MonthRow[] {
  return block.rows.map((row) => ({
    key: String(row.id), id: row.id, name: row.name, depth: row.depth,
    previous: money(row.amounts.at(-2) ?? null, block.currency), last: money(row.amounts.at(-1) ?? null, block.currency),
    badge: changeBadge(row.change_percent),
    values: row.amounts.map((value) => decimalNumber(value) ?? 0),
    href: trendsHref({ ...query, category: row.id }),
  }))
}
/** Column headings of «Месяц к месяцу»: the two last months of the window. */
export function monthRowHeadings(block: TrendsMonthlyCurrency): { previous: string; last: string } {
  const months = block.months.map((entry) => entry.month)
  return { previous: months.length > 1 ? monthName(months[months.length - 2]) : '—', last: monthName(months[months.length - 1]) }
}

// --- части категории ---

/** The category over time split by its direct sub-categories; `null` without sub-categories. */
export function partsChart(block: TrendsCategoryCurrency, name: string, months: readonly string[]): { legend: StackedLegendEntry[]; columns: StackedColumn[] } | null {
  if (block.parts.length === 0) return null
  const amount = (value: Decimal) => money(value, block.currency)
  const legend = block.parts.map((part) => ({
    key: String(part.id), label: part.direct ? `${name}: без подкатегории` : part.name, tone: part.direct ? 0 : categoryTone(part.id),
    note: amount(part.total),
  }))
  const columns = months.map((month, index): StackedColumn => ({
    x: monthStart(month),
    totalText: amount(block.months[index]?.amount ?? '0.00'),
    segments: block.parts.map((part) => ({ key: String(part.id), value: decimalNumber(part.amounts[index]) ?? 0, valueText: amount(part.amounts[index]) }))
      .filter((segment) => segment.value !== 0),
  }))
  return { legend, columns }
}

// --- «Лимиты по месяцам» ---

export interface LimitCell { month: string; title: string; short: string; percent: string; spent: string; over: boolean; fill: number }
export interface LimitRow { key: string; name: string; currency: string; amount: string; cells: LimitCell[]; overCount: number }
/** Every limit with a cell per month: the share used, over the limit marked by more than colour (the word «сверх»). */
export function limitRows(limits: readonly TrendsLimit[]): LimitRow[] {
  return limits.map((limit) => {
    const cells = limit.months.map((entry): LimitCell => {
      const value = decimalNumber(entry.percent) ?? 0
      return {
        month: entry.month, title: monthName(entry.month), short: monthName(entry.month, true), percent: formatPercent(entry.percent),
        spent: money(entry.spent, limit.currency), over: value > 100, fill: Math.max(0, Math.min(100, Math.round(value))),
      }
    })
    return {
      key: String(limit.id), name: limit.category ? optionLabel(limit.category.path.map((node) => node.name)) : 'Категория удалена',
      currency: limit.currency, amount: money(limit.amount, limit.currency), cells, overCount: cells.filter((cell) => cell.over).length,
    }
  })
}

// --- «Что подорожало» ---

/** «Подорожало: 23 товара, подешевело: 4 товара». */
export function moverCounts(block: TrendsPricesCurrency): string {
  const goods = (count: number) => glue(String(count), plural(count, 'товар', 'товара', 'товаров'))
  return `Подорожало: ${goods(block.risen_total)}, подешевело: ${goods(block.fallen_total)}`
}
function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  if (units === 1) return one
  if (units >= 2 && units <= 4) return few
  return many
}

// --- состояние блока ---

export type BlockState<T> = StatsRequestState<T>
/** A block that has not asked yet is loading: every block asks as soon as the screen opens. */
export const loadingOf = <T>(state: BlockState<T>) => (state.kind === 'idle' ? { kind: 'loading' as const } : state)
