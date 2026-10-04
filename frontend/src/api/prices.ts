import { getJson, invalidIds } from './http.ts'
import { isPriceHistory, isPriceSummary } from './schema.ts'
import type { ApiResult, PriceHistory, PriceParams, PriceSummary, PriceSummaryParams, RequestOptions } from './types.ts'

export async function getProductPrices(
  productId: number, params: PriceParams = {}, options: RequestOptions = {},
): Promise<ApiResult<PriceHistory>> {
  return invalidIds({ productId, store: params.store }, options.signal)
    ?? getJson(`products/${productId}/prices/`, params, isPriceHistory, options)
}
export async function getProductPriceSummary(
  productId: number, params: PriceSummaryParams = {}, options: RequestOptions = {},
): Promise<ApiResult<PriceSummary>> {
  return invalidIds({ productId, store: params.store }, options.signal)
    ?? getJson(`products/${productId}/prices/summary/`, params, isPriceSummary, options)
}
