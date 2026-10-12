import { amount, array, bool, currency, isId, named, nonNegativeInteger, nullable, object, price, text, unit } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import type {
  TrendsCategory, TrendsCategoryCurrency, TrendsCategoryMonth, TrendsCategoryOption, TrendsIndexPoint, TrendsLegendCategory,
  TrendsMonthly, TrendsMonthlyCurrency, TrendsMonthPart, TrendsMonthSpend, TrendsMover, TrendsPrice, TrendsPrices, TrendsPricesCurrency,
  TrendsWindow,
} from './trends-types.ts'
import type { CategoryRef } from './types.ts'

/** The server allows a window of at most this many months. */
export const maxTrendsMonths = 36

const percent = amount
const month: Check = (value) => typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && !value.startsWith('0000')
const categoryRef = object<CategoryRef>({ id: isId, name: text, path: array(named) })
const windowFields = { months: isId, month_from: month, month_to: month }

/** Every block has every month of the window, ascending, from `month_from` to `month_to`: an empty month is never skipped. */
function fullWindow(answer: TrendsWindow, series: { month: string }[][]): boolean {
  return answer.months <= maxTrendsMonths && answer.month_from <= answer.month_to && series.every((entries) => {
    const months = entries.map((entry) => entry.month)
    return months.length === answer.months && months[0] === answer.month_from && months.at(-1) === answer.month_to
      && months.every((value, index) => index === 0 || months[index - 1] < value)
  })
}
/** Blocks are keyed by the currency: a repeated code would add up on a chart. */
const distinct = (blocks: { currency: string }[]) => new Set(blocks.map((block) => block.currency)).size === blocks.length

const legend = object<TrendsLegendCategory>({ id: isId, name: text, unassigned: bool, total: amount })
const monthPart = object<TrendsMonthPart>({ id: isId, amount })
const monthSpend = object<TrendsMonthSpend>({ month, total: amount, categories: array(monthPart), uncategorized: amount })
const monthlyBlockShape = object<TrendsMonthlyCurrency>({ currency, total: amount, average: amount, categories: array(legend), months: array(monthSpend) })
/** A category of a month is one of the legend, at most once. */
const monthlyBlock: Guard<TrendsMonthlyCurrency> = (value): value is TrendsMonthlyCurrency => monthlyBlockShape(value)
  && value.months.every((entry) => new Set(entry.categories.map((part) => part.id)).size === entry.categories.length
    && entry.categories.every((part) => value.categories.some((category) => category.id === part.id)))
const monthlyShape = object<TrendsMonthly>({ ...windowFields, currencies: array(monthlyBlock) })
export const isTrendsMonthly: Guard<TrendsMonthly> = (value): value is TrendsMonthly => monthlyShape(value)
  && distinct(value.currencies) && fullWindow(value, value.currencies.map((block) => block.months))

const option = object<TrendsCategoryOption>({ id: isId, name: text, path: array(text), depth: nonNegativeInteger })
const categoryMonth = object<TrendsCategoryMonth>({ month, amount, lines_count: nonNegativeInteger })
const categoryBlock = object<TrendsCategoryCurrency>({ currency, total: amount, average: amount, months: array(categoryMonth) })
const categoryShape = object<TrendsCategory>({
  ...windowFields, category: nullable(categoryRef), suggested: bool, options: array(option), currencies: array(categoryBlock),
})
export const isTrendsCategory: Guard<TrendsCategory> = (value): value is TrendsCategory => categoryShape(value)
  && distinct(value.currencies) && fullWindow(value, value.currencies.map((block) => block.months))
  // Without a category there is nothing to draw.
  && (value.category !== null || value.currencies.length === 0)

const point = object<TrendsIndexPoint>({
  month, index: nullable(percent), base_month: nullable(month), link_percent: nullable(percent), matched_products: nonNegativeInteger,
})
const priceAt = object<TrendsPrice>({ month, price })
const mover = object<TrendsMover>({ product: named, unit, old: priceAt, new: priceAt, change_percent: percent })
const pricesBlockShape = object<TrendsPricesCurrency>({
  currency, first_month: nullable(month), points: array(point), products_total: nonNegativeInteger, risers: array(mover), fallers: array(mover),
})
/** «Подорожало» never holds a fall and «подешевело» never a rise; a product changes its price between two different months. */
const pricesBlock: Guard<TrendsPricesCurrency> = (value): value is TrendsPricesCurrency => pricesBlockShape(value)
  && value.risers.every((entry) => !entry.change_percent.startsWith('-') && entry.old.month < entry.new.month)
  && value.fallers.every((entry) => entry.change_percent.startsWith('-') && entry.old.month < entry.new.month)
const pricesShape = object<TrendsPrices>({ ...windowFields, currencies: array(pricesBlock) })
export const isTrendsPrices: Guard<TrendsPrices> = (value): value is TrendsPrices => pricesShape(value)
  && distinct(value.currencies) && fullWindow(value, value.currencies.map((block) => block.points))
