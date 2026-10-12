import { amount, array, choice, currency, isId, isISODate, nonNegativeInteger, nullable, object, record, text } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import type { BudgetLimit, Dashboard, DashboardCategory, DashboardCurrency, DashboardRecent, DashboardSubCategory } from './budget-types.ts'
import { isPerson } from '../lib/people.ts'

/** A month the calendar knows: `2026-10`, never `2026-13` or `0000-01`. */
export const isMonthCode: Guard<string> = (value): value is string => typeof value === 'string'
  && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && !value.startsWith('0000')
const username: Check = (value) => typeof value === 'string' && value.length > 0

/** A field an older server leaves out: missing passes, anything else must pass `check`. */
const optional = (value: unknown, key: string, check: Check) => !Object.hasOwn(value as object, key) || check((value as Record<string, unknown>)[key])
const subCategoryShape = object<Omit<DashboardSubCategory, 'children'>>({
  category_id: isId, name: text, spent: amount, limit: nullable(amount), limit_id: nullable(isId),
})
/** The tree is as deep as the catalog; 32 levels is far more than any real one and keeps a hostile answer finite. */
const subCategory = (depth: number): Check => (value) => depth < 32 && subCategoryShape(value)
  && array(subCategory(depth + 1))((value as Record<string, unknown>).children)
const categoryShape = object<Omit<DashboardCategory, 'children'>>({
  category_id: nullable(isId), name: text, spent: amount, limit: nullable(amount), limit_id: nullable(isId),
})
const dashboardCategory: Check = (value) => categoryShape(value) && optional(value, 'children', array(subCategory(0)))
const dashboardCurrency = object<DashboardCurrency>({
  currency, spent: amount, previous_spent: amount, limit_total: nullable(amount), categories: array(dashboardCategory),
})
const dashboardRecent = object<Omit<DashboardRecent, 'owner_name'>>({
  id: isId, source: choice('photo', 'manual'), title: text, category_name: nullable(text), owner: username,
  purchased_on: isISODate, total: amount, currency, lines_count: nonNegativeInteger,
})
const recentItem: Check = (value) => dashboardRecent(value) && optional(value, 'owner_name', text)
const dashboardShape = object<Omit<Dashboard, 'people'>>({
  month: isMonthCode, previous_month: isMonthCode, days_left: nonNegativeInteger, members: array(username),
  currencies: array(dashboardCurrency), recent: array(recentItem),
})
export const isDashboard: Guard<Dashboard> = (value): value is Dashboard => dashboardShape(value)
  && optional(value, 'people', array(isPerson))

export const isBudgetLimit = object<BudgetLimit>({ id: isId, category_id: isId, category_name: text, currency, amount })

export type BudgetLimitList = BudgetLimit[] | { results: BudgetLimit[] }
/** The list may come bare, as `{results}` or as a page: each is read as the list of limits. */
export const isBudgetLimitList: Guard<BudgetLimitList> = (value): value is BudgetLimitList =>
  Array.isArray(value) ? value.every(isBudgetLimit)
    : record(value) && Array.isArray(value.results) && value.results.every(isBudgetLimit)
