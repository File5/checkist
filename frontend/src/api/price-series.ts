import { getJson, invalidIds } from './http.ts'
import { isPriceSeries } from './price-series-schema.ts'
import { listParam, omitEmpty } from './stats.ts'
import type { PriceSeries, PriceSeriesParams } from './price-series-types.ts'
import type { ApiResult, RequestOptions } from './types.ts'

export type * from './price-series-types.ts'
export { priceSeriesIntervals, priceSeriesKinds, similarStatuses } from './price-series-types.ts'

/** Price series of a product by store and of similar products by country. Open like the catalog: no local flag, no cookies. */
export async function getProductPriceSeries(
  productId: number, params: PriceSeriesParams = {}, options: RequestOptions = {},
): Promise<ApiResult<PriceSeries>> {
  const { date_from, date_to, currency, interval, price, similar, similar_limit } = params
  return invalidIds({ productId, similar_limit }, options.signal) ?? getJson(
    `products/${productId}/prices/series/`,
    omitEmpty({ date_from, date_to, country: listParam(params.country), currency, interval, price, similar, similar_limit }),
    isPriceSeries, options)
}
