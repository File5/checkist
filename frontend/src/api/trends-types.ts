/** Wire types of «Динамика» (`/api/stats/trends/*`, docs/api-contract.md). Money, prices and percents stay strings. */
import type { CategoryRef, CurrencyCode, Decimal, NamedObject, Unit } from './types.ts'

/** `YYYY-MM`. */
export type MonthLabel = string
/** The window of every trends answer: `months` calendar months, `month_from` … `month_to` inclusive. */
export type TrendsWindow = { months: number; month_from: MonthLabel; month_to: MonthLabel }
/** `months` — 1–36, the server default is 12; `month` — the last month of the window, the server's current one by default. */
export type TrendsParams = { months?: number; month?: MonthLabel }

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
/** One currency; every month of the window is present, an empty one with zeros. */
export type TrendsMonthlyCurrency = {
  currency: CurrencyCode; total: Decimal; average: Decimal
  /** Top-level categories of the window by their total, descending. */
  categories: TrendsLegendCategory[]
  months: TrendsMonthSpend[]
}
export type TrendsMonthly = TrendsWindow & { currencies: TrendsMonthlyCurrency[] }

export type TrendsCategoryOption = NamedObject & { path: string[]; depth: number }
export type TrendsCategoryMonth = { month: MonthLabel; amount: Decimal; lines_count: number }
export type TrendsCategoryCurrency = { currency: CurrencyCode; total: Decimal; average: Decimal; months: TrendsCategoryMonth[] }
export type TrendsCategory = TrendsWindow & {
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
  risers: TrendsMover[]
  fallers: TrendsMover[]
}
export type TrendsPrices = TrendsWindow & { currencies: TrendsPricesCurrency[] }
