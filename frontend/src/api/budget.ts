import { invalidIds } from './http.ts'
import { getLocalJson, mutate } from './local.ts'
import { isBudgetLimit, isBudgetLimitList, isDashboard, isMonthCode } from './budget-schema.ts'
import type { BudgetLimit, BudgetLimitInput, Dashboard, MonthCode } from './budget-types.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'

export type * from './budget-types.ts'

/** The month on the dashboard; without `month` the server takes its current month. */
export async function getDashboard(month?: MonthCode, options: RequestOptions = {}): Promise<LocalApiResult<Dashboard>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  if (month !== undefined && !isMonthCode(month)) return { kind: 'error', reason: 'invalid_parameter', fields: ['month'] }
  return getLocalJson('dashboard/', { month }, isDashboard, options)
}

/** Every limit the person may change: the family's, or one's own without a family. */
export async function getBudgetLimits(options: RequestOptions = {}): Promise<LocalApiResult<BudgetLimit[]>> {
  const result = await getLocalJson('budget/limits/', {}, isBudgetLimitList, options)
  if (result.kind !== 'ok') return result
  return { kind: 'ok', data: Array.isArray(result.data) ? result.data : result.data.results }
}

/** A new limit; the pair category + currency is unique, the category is top-level and the amount above zero. Never replayed implicitly. */
export async function createBudgetLimit(input: BudgetLimitInput, options: RequestOptions = {}): Promise<LocalApiResult<BudgetLimit>> {
  return invalidIds({ category_id: input.category_id }, options.signal)
    ?? mutate('budget/limits/', JSON.stringify(input), isBudgetLimit, options)
}

export async function updateBudgetLimit(id: number, amount: string, options: RequestOptions = {}): Promise<LocalApiResult<BudgetLimit>> {
  return invalidIds({ id }, options.signal)
    ?? mutate(`budget/limits/${id}/`, JSON.stringify({ amount }), isBudgetLimit, options, false, undefined, { method: 'PATCH' })
}

export async function deleteBudgetLimit(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return invalidIds({ id }, options.signal)
    ?? mutate(`budget/limits/${id}/`, '', (value): value is null => value === null, options, false, undefined, { method: 'DELETE' })
}
