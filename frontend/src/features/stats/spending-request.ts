import { getLocalJson } from '../../api/local'
import { getSpending, listParam, omitEmpty } from '../../api/stats'
import type { Spending, SpendingParams } from '../../api/stats'
import { isSpending } from '../../api/stats-schema'
import type { Guard } from '../../api/schema'
import type { LocalApiResult, RequestOptions } from '../../api/types'

/**
 * The server names the category of the filter (`parent`) under every breakdown, while the shared guard accepts it
 * only with `group_by=category`. Until the guard follows the server, such an answer is checked here: `parent` by
 * the shared guard under `category`, the rest of the answer unchanged.
 */
export const isFilteredSpending: Guard<Spending> = (value): value is Spending => {
  if (typeof value !== 'object' || value === null) return false
  const answer = value as Record<string, unknown>
  if (answer.parent === null || answer.group_by === 'category') return isSpending(value)
  return isSpending({ ...answer, group_by: 'category', currencies: [] }) && isSpending({ ...answer, parent: null })
}

/** Spending for the screen: the shared adapter, except a category filter under another breakdown (see the guard above). */
export function loadSpending(params: SpendingParams, options: RequestOptions = {}): Promise<LocalApiResult<Spending>> {
  const { category, group_by } = params
  if (category === undefined || group_by === undefined || group_by === 'category') return getSpending(params, options)
  const { date_from, date_to, country, currency, store, generic, limit } = params
  return getLocalJson('stats/spending/',
    omitEmpty({ date_from, date_to, country, currency, store: listParam(store), group_by, category, generic, limit }), isFilteredSpending, options)
}
