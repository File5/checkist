import { amount, array, choice, currency, isId, isISODate, isISODateTime, nonNegativeInteger, nullable, object, record, text } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import type {
  BudgetLimit, BudgetLimitChange, BudgetLimitHistory, BudgetLimitSeries, CategorySpendCurrency, CategorySpendItem, CategorySpendLine, CategorySpendPart, CategorySpends, Dashboard, DashboardCategory,
  DashboardCurrency, DashboardRecent, DashboardSubCategory,
} from './budget-types.ts'
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
const dashboardCurrencyShape = object<Omit<DashboardCurrency, 'limited_spent'>>({
  currency, spent: amount, previous_spent: amount, limit_total: nullable(amount), categories: array(dashboardCategory),
})
const dashboardCurrency: Check = (value) => dashboardCurrencyShape(value) && optional(value, 'limited_spent', nullable(amount))
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

const named = object<{ id: number; name: string }>({ id: isId, name: text })
const categorySpendLine = object<CategorySpendLine>({ id: isId, name: text, amount, category_id: isId, category_name: text })
const categorySpendItem = object<CategorySpendItem>({
  receipt_id: isId, source: choice('photo', 'manual'), purchased_on: isISODate, store: nullable(named), note: (value) => typeof value === 'string',
  owner: username, owner_name: text, receipt_total: amount, category_amount: amount, lines: array(categorySpendLine),
})
const categorySpendPart = object<CategorySpendPart>({
  id: isId, name: text, direct: (value) => typeof value === 'boolean', children_count: nonNegativeInteger, amount, lines_count: nonNegativeInteger,
})
const categorySpendCurrency = object<CategorySpendCurrency>({
  currency, total: amount, receipts_count: nonNegativeInteger, parts: array(categorySpendPart), items: array(categorySpendItem),
})
export const isCategorySpends = object<CategorySpends>({
  month: isMonthCode, previous_month: isMonthCode,
  category: object<CategorySpends['category']>({ id: isId, name: text, path: array(named) }),
  children: array(named), currencies: array(categorySpendCurrency),
}) as Guard<CategorySpends>

export const isBudgetLimit = object<BudgetLimit>({ id: isId, category_id: isId, category_name: text, currency, amount })

export type BudgetLimitList = BudgetLimit[] | { results: BudgetLimit[] }
/** The list may come bare, as `{results}` or as a page: each is read as the list of limits. */
export const isBudgetLimitList: Guard<BudgetLimitList> = (value): value is BudgetLimitList =>
  Array.isArray(value) ? value.every(isBudgetLimit)
    : record(value) && Array.isArray(value.results) && value.results.every(isBudgetLimit)

const categoryRef = object<BudgetLimitChange['category']>({ id: isId, name: text, path: array(named) })
const limitChangeShape = object<BudgetLimitChange>({
  id: isId, changed_at: isISODateTime, effective_month: isMonthCode, kind: choice('created', 'changed', 'deleted'), category: categoryRef,
  currency, old_amount: nullable(amount), new_amount: nullable(amount), change_percent: nullable(amount), changed_by: nullable(isPerson),
})
/** The kind agrees with the amounts: a new limit has no old amount, a deleted one no new amount. */
const limitChange: Check = (value) => limitChangeShape(value) && {
  created: value.old_amount === null && value.new_amount !== null,
  changed: value.old_amount !== null && value.new_amount !== null,
  deleted: value.old_amount !== null && value.new_amount === null,
}[value.kind]
const limitSeries = object<BudgetLimitSeries>({
  category: categoryRef, currency, limit_id: nullable(isId), amount: nullable(amount),
  months: array(object<BudgetLimitSeries['months'][number]>({ month: isMonthCode, amount: nullable(amount) })),
})
const limitHistoryShape = object<BudgetLimitHistory>({
  months: isId, month_from: isMonthCode, month_to: isMonthCode, changes: array(limitChange), series: array(limitSeries),
})
/** Every series has every month of the window. */
export const isBudgetLimitHistory: Guard<BudgetLimitHistory> = (value): value is BudgetLimitHistory => limitHistoryShape(value)
  && value.month_from <= value.month_to
  && value.series.every((row) => row.months.length === value.months && row.months[0]?.month === value.month_from
    && row.months.at(-1)?.month === value.month_to)
