import type { CategoryRef, CurrencyCode, Decimal, ISODate, ISODateTime } from './types.ts'
import type { ReceiptSource } from './receipts-types.ts'
import type { Person } from '../lib/people.ts'
import type { InBase } from './base-currency.ts'

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
  /** Spent in the categories counted in `limit_total` (each with its sub-categories); optional for older servers. */
  limited_spent?: Decimal | null
  /** Sorted by `spent` descending; a category with a limit is present even with nothing spent. */
  categories: DashboardCategory[]
}
/** A recent spend: the title is the store, or what a manual spend was about. */
export type DashboardRecent = {
  id: number; source: ReceiptSource; title: string; category_name: string | null
  /** `owner` — username; `owner_name` — the name to show, missing from an older server. */
  owner: string; owner_name?: string
  purchased_on: ISODate; total: Decimal; currency: CurrencyCode; lines_count: number
  /** The total in the family's base currency at the rate of its day; null — no rate; missing from an older server. */
  base_total?: Decimal | null
}
/** `GET /api/dashboard/?month=YYYY-MM`. `members` — usernames of the family, or just one's own;
 * `people` — the same with names to show, missing from an older server. */
/** The family's budget of the month in the base currency beside what was spent (2026-10-13); null — no budget. */
export type DashboardBudget = { amount: Decimal; currency: CurrencyCode; spent: Decimal }
/** «Можно тратить в день» (2026-10-13, the current month only): (`amount` − `spent` − `unpaid`) / `days_left`.
 * `basis` — the month budget, else the top-level limits, else the income; `per_day` null — `overspent` instead. */
export type DashboardAllowance = {
  currency: CurrencyCode; basis: 'budget' | 'limits' | 'income'; amount: Decimal; spent: Decimal; unpaid: Decimal
  unpaid_count: number; days_left: number; per_day: Decimal | null; overspent: Decimal | null
}
export type Dashboard = InBase & {
  /** The month in the base currency (null — nothing to show); read into `currencies` by `getDashboard`. */
  base?: DashboardCurrency | null
  /** Missing from an older server. */
  budget?: DashboardBudget | null
  allowance?: DashboardAllowance | null
  month: MonthCode; previous_month: MonthCode; days_left: number; members: string[]; people?: Person[]
  /** One block per currency from an older server; one block of the base currency (or none) from a newer one (api/base-currency.ts). */
  currencies: DashboardCurrency[]; recent: DashboardRecent[]
}

/** A line of a receipt or spend that belongs to the category (or a descendant): its name, paid amount and category. */
export type CategorySpendLine = { id: number; name: string; amount: Decimal; category_id: number; category_name: string }
/** A receipt or spend with lines in the category: `category_amount` — their sum, `receipt_total` — the whole receipt. */
export type CategorySpendItem = {
  receipt_id: number; source: ReceiptSource; purchased_on: ISODate; store: { id: number; name: string } | null; note: string
  owner: string; owner_name: string; receipt_total: Decimal; category_amount: Decimal; lines: CategorySpendLine[]
  /** The currency of the receipt and the sum of its lines of the category in it: in a block of the base currency the
   * amounts above are converted. Missing from an older server. */
  currency?: CurrencyCode; original_amount?: Decimal
}
/** A direct sub-category with its descendants, or the category itself (`direct`). */
export type CategorySpendPart = { id: number; name: string; direct: boolean; children_count: number; amount: Decimal; lines_count: number }
export type CategorySpendCurrency = {
  currency: CurrencyCode; total: Decimal; receipts_count: number; parts: CategorySpendPart[]; items: CategorySpendItem[]
}
/** `GET /api/stats/category-spends/?category=ID&month=YYYY-MM`: what the money of a category went on in a month. */
export type CategorySpends = InBase & {
  base?: CategorySpendCurrency | null
  month: MonthCode; previous_month: MonthCode
  category: { id: number; name: string; path: { id: number; name: string }[] }
  children: { id: number; name: string }[]
  currencies: CategorySpendCurrency[]
}

/** A monthly limit of a category (any level) in one currency, shared by the family (or one's own without a family). */
export type BudgetLimit = {
  id: number; category_id: number; category_name: string; currency: CurrencyCode; amount: Decimal
  /** The family's base currency and the limit in it at today's rate (null — no rate); missing from an older server.
   * A new or changed limit is in the base currency only; an older one in another currency stays readable. */
  base_currency?: CurrencyCode; base_amount?: Decimal | null
}
/** Body of `POST /api/budget/limits/`. */
export type BudgetLimitInput = { category_id: number; currency: CurrencyCode; amount: Decimal }

/** What a change did: a new limit (`old_amount` null), another amount, or a deleted limit (`new_amount` null). */
export type BudgetLimitChangeKind = 'created' | 'changed' | 'deleted'
/** An entry of the limits journal: who changed which limit and when; it counts from `effective_month` on.
 * `change_percent` — (new − old) / old × 100, only for `changed`; `changed_by` is null when unknown (limits saved before the journal). */
export type BudgetLimitChange = {
  id: number; changed_at: ISODateTime; effective_month: MonthCode; kind: BudgetLimitChangeKind; category: CategoryRef
  currency: CurrencyCode; old_amount: Decimal | null; new_amount: Decimal | null; change_percent: Decimal | null
  changed_by: Person | null
}
/** The limit of a pair «category and currency» in every month of the window; `amount` null — no limit that month. */
export type BudgetLimitSeries = {
  category: CategoryRef; currency: CurrencyCode; limit_id: number | null; amount: Decimal | null
  months: { month: MonthCode; amount: Decimal | null }[]
}
/** `GET /api/budget/limits/history/`: changes newest first and the limit of each pair by month. */
export type BudgetLimitHistory = {
  months: number; month_from: MonthCode; month_to: MonthCode; changes: BudgetLimitChange[]; series: BudgetLimitSeries[]
}
export type BudgetLimitHistoryParams = { category?: number; currency?: CurrencyCode; from?: MonthCode; to?: MonthCode }

/** `GET|POST /api/budget/month/`: the family's budget of the current month (one amount, the base currency);
 * `amount` null — none. `currency` — of the amount (null without one), `base_currency` — new amounts are set in it. */
export type MonthBudget = { amount: Decimal | null; currency: CurrencyCode | null; base_currency: CurrencyCode }
