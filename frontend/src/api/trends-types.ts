/** Wire types of «Динамика» (`/api/stats/trends/*`, docs/api-contract.md). Money, prices and percents stay strings. */
import type { CategoryRef, CurrencyCode, Decimal, NamedObject, Unit } from './types.ts'
import type { InBase } from './base-currency.ts'

/** `YYYY-MM`. */
export type MonthLabel = string
/** The window of every trends answer: `months` calendar months, `month_from` … `month_to` inclusive. */
export type TrendsWindow = { months: number; month_from: MonthLabel; month_to: MonthLabel }
/**
 * The window: either `from` … `to` (both inclusive, at most 60 months; without `to` — the server's current month), or the
 * older `months` (1–60, the server default is 12) ending at `month` (the server's current one by default). Never both.
 */
export type TrendsParams = { months?: number; month?: MonthLabel; from?: MonthLabel; to?: MonthLabel }
/** `/api/stats/trends/range/`: the first and the last month with receipts (`null` without any), the server's month, the widest window. */
export type TrendsRange = { first_month: MonthLabel | null; last_month: MonthLabel | null; current_month: MonthLabel; max_months: number }

export type TrendsLegendCategory = NamedObject & { unassigned: boolean; total: Decimal }
export type TrendsMonthPart = { id: number; amount: Decimal }
export type TrendsMonthSpend = {
  month: MonthLabel
  /** Σ of the month's receipts, refunds with their sign — «потрачено». */
  total: Decimal
  /** Top-level categories with spending in this month, in the order of the legend. */
  categories: TrendsMonthPart[]
  /** Services, deposits, lines without a category and receipt-wide discounts: `total − Σ categories`; may be negative. */
  uncategorized: Decimal
}
/** A category with its amount in every month of the window (`amounts[i]` — month `i`). */
export type TrendsCategoryRow = NamedObject & {
  parent_id: number | null
  depth: number
  /** Lines lying in the category itself, not in a sub-category (only among the parts of «Категория во времени»). */
  direct: boolean
  total: Decimal
  amounts: Decimal[]
  /** The last month of the window against the one before it; `null` when that one is zero or absent. */
  change_percent: Decimal | null
  /** `total` over the months of the window. */
  average: Decimal
  /** Every month against the one before it (`change_percents[i]` — month `i`); the first and any after a zero month — `null`. */
  change_percents: (Decimal | null)[]
}
/** The last month of the window against the previous one and against the average of the window. */
export type TrendsSummary = {
  month: MonthLabel; spent: Decimal
  previous_month: MonthLabel | null; previous: Decimal | null
  change_percent: Decimal | null
  average_change_percent: Decimal | null
}
/** One currency; every month of the window is present, an empty one with zeros. */
export type TrendsMonthlyCurrency = {
  currency: CurrencyCode; total: Decimal; average: Decimal
  /** Top-level categories of the window by their total, descending. */
  categories: TrendsLegendCategory[]
  months: TrendsMonthSpend[]
  summary: TrendsSummary
  /** «Месяц к месяцу»: every top-level category, then its direct sub-categories with spending. */
  rows: TrendsCategoryRow[]
}
export type TrendsMonthly = TrendsWindow & InBase & { currencies: TrendsMonthlyCurrency[]; base?: TrendsMonthlyCurrency | null }

export type TrendsCategoryOption = NamedObject & { path: string[]; depth: number }
export type TrendsCategoryMonth = { month: MonthLabel; amount: Decimal; lines_count: number }
export type TrendsCategoryCurrency = {
  currency: CurrencyCode; total: Decimal; average: Decimal; months: TrendsCategoryMonth[]
  /** Direct sub-categories with spending and, last, the category's own lines (`direct`); empty without sub-categories. */
  parts: TrendsCategoryRow[]
}
export type TrendsCategory = TrendsWindow & InBase & {
  base?: TrendsCategoryCurrency | null
  /** The asked category, or the one the server suggests without `category`; `null` — nothing was spent in the window. */
  category: CategoryRef | null
  suggested: boolean
  /** Categories with spending in the window and their ancestors, in the order of the tree. */
  options: TrendsCategoryOption[]
  currencies: TrendsCategoryCurrency[]
}
export type TrendsCategoryParams = TrendsParams & { category?: number }

export type TrendsIndexPoint = {
  month: MonthLabel
  /** 100 — the first month of the window with purchases; `null` — no purchases or no products in common with the base. */
  index: Decimal | null
  base_month: MonthLabel | null
  link_percent: Decimal | null
  matched_products: number
}
export type TrendsPrice = { month: MonthLabel; price: Decimal }
export type TrendsMover = { product: NamedObject; unit: Unit; old: TrendsPrice; new: TrendsPrice; change_percent: Decimal }
export type TrendsPricesCurrency = {
  currency: CurrencyCode
  first_month: MonthLabel | null
  points: TrendsIndexPoint[]
  /** Products (with a unit) bought in at least two months of the window. */
  products_total: number
  /** Of them: the last price is higher / lower than the first one. */
  risen_total: number
  fallen_total: number
  /** The last month with an index, when it is not the first one, and that index − 100. */
  index_month: MonthLabel | null
  change_percent: Decimal | null
  risers: TrendsMover[]
  fallers: TrendsMover[]
}
export type TrendsPrices = TrendsWindow & { currencies: TrendsPricesCurrency[] }

/** The limit changed this month: the amount before the month and in it (null — no limit then). */
export type TrendsLimitChange = { old: Decimal | null; new: Decimal | null }
/** A month of a limit: `limit` — the limit of that month (null — none, then `percent` is null too); `change` — set when
 * the limit changed this month. */
export type TrendsLimitMonth = {
  month: MonthLabel; spent: Decimal; percent: Decimal | null; limit: Decimal | null; change: TrendsLimitChange | null
}
/** A limit and the share of the month's limit used in every month of the window. A limit deleted since has `id` and
 * `amount` (the current one) null. */
export type TrendsLimit = {
  id: number | null; category: CategoryRef | null; currency: CurrencyCode; amount: Decimal | null; months: TrendsLimitMonth[]
}
/** `base_limits` — the same limits in the family's base currency; `getTrendsLimits` reads them into `limits`. */
export type TrendsLimits = TrendsWindow & InBase & { limits: TrendsLimit[]; base_limits?: TrendsLimit[] }
