import { invalidIds } from './http.ts'
import { getLocalJson } from './local.ts'
import { omitEmpty } from './stats.ts'
import { isTrendsCategory, isTrendsLimits, isTrendsMonthly, isTrendsPrices } from './trends-schema.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'
import type { TrendsCategory, TrendsCategoryParams, TrendsLimits, TrendsMonthly, TrendsParams, TrendsPrices } from './trends-types.ts'

export type * from './trends-types.ts'
export { maxTrendsMonths } from './trends-schema.ts'

/** «Траты по месяцам»: spending of every month of the window by top-level category, one block per currency. */
export async function getTrendsMonthly(params: TrendsParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<TrendsMonthly>> {
  const { months, month } = params
  return invalidIds({ months }, options.signal) ?? getLocalJson('stats/trends/monthly/', omitEmpty({ months, month }), isTrendsMonthly, options)
}
/** «Категория во времени»: spending of one category with its sub-categories; without `category` the server suggests one. */
export async function getTrendsCategory(params: TrendsCategoryParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<TrendsCategory>> {
  const { months, month, category } = params
  return invalidIds({ months, category }, options.signal)
    ?? getLocalJson('stats/trends/category/', omitEmpty({ months, month, category }), isTrendsCategory, options)
}
/** «Как менялись цены»: a chained price index on products bought in neighbouring months, and the biggest changes. */
export async function getTrendsPrices(params: TrendsParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<TrendsPrices>> {
  const { months, month } = params
  return invalidIds({ months }, options.signal) ?? getLocalJson('stats/trends/prices/', omitEmpty({ months, month }), isTrendsPrices, options)
}
/** «Лимиты по месяцам»: every limit of the person and the family, and the share used in each month. */
export async function getTrendsLimits(params: TrendsParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<TrendsLimits>> {
  const { months, month } = params
  return invalidIds({ months }, options.signal) ?? getLocalJson('stats/trends/limits/', omitEmpty({ months, month }), isTrendsLimits, options)
}
