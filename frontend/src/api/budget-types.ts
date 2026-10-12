import type { CurrencyCode, Decimal, ISODate } from './types.ts'
import type { ReceiptSource } from './receipts-types.ts'
import type { Person } from '../lib/people.ts'

/** `YYYY-MM`: a calendar month in the server's timezone. */
export type MonthCode = string

/** A sub-category under a top-level row: only one with a limit of its own or with a limited descendant.
 * `spent` — its own lines and those of all its descendants. */
export type DashboardSubCategory = {
  category_id: number; name: string; spent: Decimal; limit: Decimal | null; limit_id: number | null
  children: DashboardSubCategory[]
}
/** A top-level category of the month: children are rolled up; «Не разобрано» comes as it is.
 * `limit` / `limit_id` are null for a category without a limit in this currency.
 * `children` — the limited sub-categories (and their ancestors), the same order; missing from an older server. */
export type DashboardCategory = {
  category_id: number | null; name: string; spent: Decimal; limit: Decimal | null; limit_id: number | null
  children?: DashboardSubCategory[]
}
/** One currency of the month. Currencies are never summed together. */
export type DashboardCurrency = {
  currency: CurrencyCode; spent: Decimal; previous_spent: Decimal; limit_total: Decimal | null
  /** Sorted by `spent` descending; a category with a limit is present even with nothing spent. */
  categories: DashboardCategory[]
}
/** A recent spend: the title is the store, or what a manual spend was about. */
export type DashboardRecent = {
  id: number; source: ReceiptSource; title: string; category_name: string | null
  /** `owner` — username; `owner_name` — the name to show, missing from an older server. */
  owner: string; owner_name?: string
  purchased_on: ISODate; total: Decimal; currency: CurrencyCode; lines_count: number
}
/** `GET /api/dashboard/?month=YYYY-MM`. `members` — usernames of the family, or just one's own;
 * `people` — the same with names to show, missing from an older server. */
export type Dashboard = {
  month: MonthCode; previous_month: MonthCode; days_left: number; members: string[]; people?: Person[]
  currencies: DashboardCurrency[]; recent: DashboardRecent[]
}

/** A line of a receipt or spend that belongs to the category (or a descendant): its name, paid amount and category. */
export type CategorySpendLine = { id: number; name: string; amount: Decimal; category_id: number; category_name: string }
/** A receipt or spend with lines in the category: `category_amount` — their sum, `receipt_total` — the whole receipt. */
export type CategorySpendItem = {
  receipt_id: number; source: ReceiptSource; purchased_on: ISODate; store: { id: number; name: string } | null; note: string
  owner: string; owner_name: string; receipt_total: Decimal; category_amount: Decimal; lines: CategorySpendLine[]
}
/** A direct sub-category with its descendants, or the category itself (`direct`). */
export type CategorySpendPart = { id: number; name: string; direct: boolean; children_count: number; amount: Decimal; lines_count: number }
export type CategorySpendCurrency = {
  currency: CurrencyCode; total: Decimal; receipts_count: number; parts: CategorySpendPart[]; items: CategorySpendItem[]
}
/** `GET /api/stats/category-spends/?category=ID&month=YYYY-MM`: what the money of a category went on in a month. */
export type CategorySpends = {
  month: MonthCode; previous_month: MonthCode
  category: { id: number; name: string; path: { id: number; name: string }[] }
  children: { id: number; name: string }[]
  currencies: CategorySpendCurrency[]
}

/** A monthly limit of a category (any level) in one currency, shared by the family (or one's own without a family). */
export type BudgetLimit = { id: number; category_id: number; category_name: string; currency: CurrencyCode; amount: Decimal }
/** Body of `POST /api/budget/limits/`. */
export type BudgetLimitInput = { category_id: number; currency: CurrencyCode; amount: Decimal }
