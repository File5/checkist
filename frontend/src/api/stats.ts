import { invalidIds } from './http.ts'
import type { Query } from './http.ts'
import { getLocalJson } from './local.ts'
import { isId } from './schema.ts'
import { isReceiptCompare, isReceiptSeries, isSpending } from './stats-schema.ts'
import type { ApiFailure, LocalApiFailure, LocalApiResult, RequestOptions } from './types.ts'
import type {
  ReceiptCompare, ReceiptCompareParams, ReceiptSeries, ReceiptSeriesParams, Spending, SpendingParams, StatsFilters,
} from './stats-types.ts'

export type * from './stats-types.ts'
export { dateMs, decimalNumber, receiptIntervals, spendingGroupings, spendingSpecialKinds } from './stats-types.ts'

/** Several values travel as one comma-separated parameter; an empty list is not sent. */
export function listParam(values: readonly (string | number)[] | undefined): string | undefined {
  return values?.length ? values.join(',') : undefined
}
/** The server treats an empty parameter as absent, so it is never sent. */
export function omitEmpty(query: Query): Query {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== ''))
}
const filters = ({ country, currency, store }: StatsFilters): Query => ({ country, currency, store: listParam(store) })
/** Ids are refused locally before a rounded number can reach the server. */
function refused(ids: Query, store: readonly number[] | undefined, signal?: AbortSignal): ApiFailure | { kind: 'aborted' } | undefined {
  const failure = invalidIds(ids, signal)
  if (failure?.kind === 'aborted' || !store?.some((id) => !isId(id))) return failure
  return { kind: 'error', reason: 'invalid_parameter', fields: [...(failure?.fields ?? []), 'store'] }
}

/** What a statistics screen has to tell apart; the failure itself keeps `reason`, `status` and `fields`. */
export type StatsFailureKind = 'invalid_parameter' | 'range_too_large' | 'permission_denied' | 'not_found' | 'unavailable' | 'invalid_response'
/** `permission_denied` — the local mode is off (`/api/stats/*` only); `not_found` — the product of a price series. */
export function statsFailureKind(failure: ApiFailure | LocalApiFailure): StatsFailureKind {
  switch (failure.reason) {
    case 'invalid_parameter': case 'range_too_large': case 'permission_denied': case 'not_found': return failure.reason
    case 'network': case 'timeout': case 'server': case 'database_unavailable': return 'unavailable'
    default: return 'invalid_response'
  }
}

/** Spending of a period by category, generic product, product or store; one block per currency. */
export async function getSpending(params: SpendingParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Spending>> {
  const { date_from, date_to, group_by, category, generic, limit } = params
  return refused({ category, generic, limit }, params.store, options.signal) ?? getLocalJson(
    'stats/spending/', omitEmpty({ date_from, date_to, ...filters(params), group_by, category, generic, limit }), isSpending, options)
}
/** Visits over time: receipts, average and median receipt, lines per receipt. */
export async function getReceiptSeries(params: ReceiptSeriesParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<ReceiptSeries>> {
  const { date_from, date_to, interval } = params
  return refused({}, params.store, options.signal) ?? getLocalJson(
    'stats/receipts/series/', omitEmpty({ date_from, date_to, ...filters(params), interval }), isReceiptSeries, options)
}
/** Why the average receipt changed between two periods: quantity, prices and mix. */
export async function getReceiptCompare(params: ReceiptCompareParams, options: RequestOptions = {}): Promise<LocalApiResult<ReceiptCompare>> {
  const { base_from, base_to, current_from, current_to, limit } = params
  return refused({ limit }, params.store, options.signal) ?? getLocalJson(
    'stats/receipts/compare/', omitEmpty({ base_from, base_to, current_from, current_to, ...filters(params), limit }), isReceiptCompare, options)
}
