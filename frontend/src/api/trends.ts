import { invalidIds } from './http.ts'
import { getLocalJson } from './local.ts'
import { omitEmpty } from './stats.ts'
import { isTrendsCategory, isTrendsLimits, isTrendsMonthly, isTrendsPrices, isTrendsRange } from './trends-schema.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'
import { resultInBase } from './base-currency.ts'
import type { TrendsCategory, TrendsCategoryParams, TrendsLimits, TrendsMonthly, TrendsParams, TrendsPrices, TrendsRange } from './trends-types.ts'

export type * from './trends-types.ts'
export { maxTrendsMonths } from './trends-schema.ts'

/** «Траты по месяцам»: spending of every month of the window by top-level category, one block per currency. */
export async function getTrendsMonthly(params: TrendsParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<TrendsMonthly>> {
  const { months, month, from, to } = params
  return invalidIds({ months }, options.signal) ?? resultInBase(await getLocalJson('stats/trends/monthly/', omitEmpty({ months, month, from, to }), isTrendsMonthly, options))
}
/** «Категория во времени»: spending of one category with its sub-categories; without `category` the server suggests one. */
export async function getTrendsCategory(params: TrendsCategoryParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<TrendsCategory>> {
  const { months, month, from, to, category } = params
  return invalidIds({ months, category }, options.signal)
    ?? resultInBase(await getLocalJson('stats/trends/category/', omitEmpty({ months, month, from, to, category }), isTrendsCategory, options))
}
/** «Как менялись цены»: a chained price index on products bought in neighbouring months, and the biggest changes. */
export async function getTrendsPrices(params: TrendsParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<TrendsPrices>> {
  const { months, month, from, to } = params
  return invalidIds({ months }, options.signal) ?? getLocalJson('stats/trends/prices/', omitEmpty({ months, month, from, to }), isTrendsPrices, options)
}
/** «Лимиты по месяцам»: every limit of the person and the family, and the share used in each month. */
export async function getTrendsLimits(params: TrendsParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<TrendsLimits>> {
  const { months, month, from, to } = params
  return invalidIds({ months }, options.signal) ?? resultInBase(await getLocalJson('stats/trends/limits/', omitEmpty({ months, month, from, to }), isTrendsLimits, options),
    { from: 'base_limits', to: 'limits', list: true })
}
/** The first and the last month with receipts and the server's month: the ready periods of «Динамика» are built from them. */
export async function getTrendsRange(options: RequestOptions = {}): Promise<LocalApiResult<TrendsRange>> {
  return getLocalJson('stats/trends/range/', {}, isTrendsRange, options)
}
