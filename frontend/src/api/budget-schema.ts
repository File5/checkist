import { amount, array, choice, currency, isId, isISODate, nonNegativeInteger, nullable, object, record, text } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import type { BudgetLimit, Dashboard, DashboardCategory, DashboardCurrency, DashboardRecent } from './budget-types.ts'

/** A month the calendar knows: `2026-10`, never `2026-13` or `0000-01`. */
export const isMonthCode: Guard<string> = (value): value is string => typeof value === 'string'
  && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) && !value.startsWith('0000')
const username: Check = (value) => typeof value === 'string' && value.length > 0

const dashboardCategory = object<DashboardCategory>({
  category_id: nullable(isId), name: text, spent: amount, limit: nullable(amount), limit_id: nullable(isId),
})
const dashboardCurrency = object<DashboardCurrency>({
  currency, spent: amount, previous_spent: amount, limit_total: nullable(amount), categories: array(dashboardCategory),
})
const dashboardRecent = object<DashboardRecent>({
  id: isId, source: choice('photo', 'manual'), title: text, category_name: nullable(text), owner: username,
  purchased_on: isISODate, total: amount, currency, lines_count: nonNegativeInteger,
})
export const isDashboard = object<Dashboard>({
  month: isMonthCode, previous_month: isMonthCode, days_left: nonNegativeInteger, members: array(username),
  currencies: array(dashboardCurrency), recent: array(dashboardRecent),
})

export const isBudgetLimit = object<BudgetLimit>({ id: isId, category_id: isId, category_name: text, currency, amount })

export type BudgetLimitList = BudgetLimit[] | { results: BudgetLimit[] }
/** The list may come bare, as `{results}` or as a page: each is read as the list of limits. */
export const isBudgetLimitList: Guard<BudgetLimitList> = (value): value is BudgetLimitList =>
  Array.isArray(value) ? value.every(isBudgetLimit)
    : record(value) && Array.isArray(value.results) && value.results.every(isBudgetLimit)
