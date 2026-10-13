import { invalidIds } from './http.ts'
import { getLocalJson, mutate } from './local.ts'
import { isBudgetLimit, isBudgetLimitHistory, isBudgetLimitList, isCategorySpends, isDashboard, isMonthBudget, isMonthCode } from './budget-schema.ts'
import type {
  BudgetLimit, BudgetLimitHistory, BudgetLimitHistoryParams, BudgetLimitInput, CategorySpends, Dashboard, MonthBudget, MonthCode,
} from './budget-types.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'
import { resultInBase } from './base-currency.ts'

export type * from './budget-types.ts'

/** The month on the dashboard; without `month` the server takes its current month. */
export async function getDashboard(month?: MonthCode, options: RequestOptions = {}): Promise<LocalApiResult<Dashboard>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  if (month !== undefined && !isMonthCode(month)) return { kind: 'error', reason: 'invalid_parameter', fields: ['month'] }
  return resultInBase(await getLocalJson('dashboard/', { month }, isDashboard, options))
}

/** What the money of a category (with its descendants) went on in a month: receipts and spends with their lines. */
export async function getCategorySpends(category: number, month?: MonthCode, options: RequestOptions = {}): Promise<LocalApiResult<CategorySpends>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  if (!Number.isSafeInteger(category) || category < 1) return { kind: 'error', reason: 'invalid_parameter', fields: ['category'] }
  if (month !== undefined && !isMonthCode(month)) return { kind: 'error', reason: 'invalid_parameter', fields: ['month'] }
  return resultInBase(await getLocalJson('stats/category-spends/', { category, month }, isCategorySpends, options))
}

/** Every limit the person may change: the family's, or one's own without a family. */
export async function getBudgetLimits(options: RequestOptions = {}): Promise<LocalApiResult<BudgetLimit[]>> {
  const result = await getBudgetLimitBook(options)
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.limits } : result
}

/** The limits and the family's base currency — new limits are set in it only (2026-10-13); an older server names none. */
export async function getBudgetLimitBook(options: RequestOptions = {}): Promise<LocalApiResult<{ limits: BudgetLimit[]; baseCurrency?: string }>> {
  const result = await getLocalJson('budget/limits/', {}, isBudgetLimitList, options)
  if (result.kind !== 'ok') return result
  return Array.isArray(result.data) ? { kind: 'ok', data: { limits: result.data } }
    : { kind: 'ok', data: { limits: result.data.results, baseCurrency: result.data.base_currency } }
}

/** A new limit; the pair category + currency is unique, the category is top-level and the amount above zero. Never replayed implicitly. */
export async function createBudgetLimit(input: BudgetLimitInput, options: RequestOptions = {}): Promise<LocalApiResult<BudgetLimit>> {
  return invalidIds({ category_id: input.category_id }, options.signal)
    ?? mutate('budget/limits/', JSON.stringify(input), isBudgetLimit, options)
}

/** A new amount; with `currency` the limit moves to it too — a limit of another currency becomes one in the base currency. */
export async function updateBudgetLimit(id: number, amount: string, options: RequestOptions = {}, currency?: string): Promise<LocalApiResult<BudgetLimit>> {
  return invalidIds({ id }, options.signal)
    ?? mutate(`budget/limits/${id}/`, JSON.stringify(currency ? { amount, currency } : { amount }), isBudgetLimit, options, false, undefined, { method: 'PATCH' })
}

export async function deleteBudgetLimit(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return invalidIds({ id }, options.signal)
    ?? mutate(`budget/limits/${id}/`, '', (value): value is null => value === null, options, false, undefined, { method: 'DELETE' })
}

/** The family's budget of the current month (2026-10-13): one amount over the limits, in the base currency. */
export async function getMonthBudget(options: RequestOptions = {}): Promise<LocalApiResult<MonthBudget>> {
  return getLocalJson('budget/month/', {}, isMonthBudget, options)
}

/** Sets the budget from the current month on (`amount`) or removes it from this month (`null`); past months keep theirs. */
export async function saveMonthBudget(amount: string | null, options: RequestOptions = {}): Promise<LocalApiResult<MonthBudget | null>> {
  return amount === null
    ? mutate('budget/month/', '', (value): value is null => value === null, options, false, undefined, { method: 'DELETE' })
    : mutate('budget/month/', JSON.stringify({ amount }), isMonthBudget, options)
}

/** The journal of the limits the person sees (the family's, or one's own) and each limit by month of the window. */
export async function getBudgetLimitHistory(params: BudgetLimitHistoryParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<BudgetLimitHistory>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  const { category, currency, from, to } = params
  if (from !== undefined && !isMonthCode(from)) return { kind: 'error', reason: 'invalid_parameter', fields: ['from'] }
  if (to !== undefined && !isMonthCode(to)) return { kind: 'error', reason: 'invalid_parameter', fields: ['to'] }
  return (category === undefined ? null : invalidIds({ category }, options.signal))
    ?? getLocalJson('budget/limits/history/', { category, currency, from, to }, isBudgetLimitHistory, options)
}
