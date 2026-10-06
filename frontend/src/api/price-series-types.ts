/** Wire types of `GET /api/products/{id}/prices/series/` (docs/api-contract.md). Prices stay strings with 4 places. */
import type { CountryCode, CurrencyCode, Decimal, GenericRef, ISODate, NamedObject, PriceProduct, StoreBrief, Unit } from './types.ts'

export const priceSeriesIntervals = ['day', 'week', 'month'] as const
export type PriceSeriesInterval = typeof priceSeriesIntervals[number]
export const priceSeriesKinds = ['paid', 'normalized'] as const
/** `paid` — per unit of the line; `normalized` — per kg / l / pcs. */
export type PriceSeriesKind = typeof priceSeriesKinds[number]
export const similarStatuses = ['ok', 'disabled', 'generic_unassigned', 'none'] as const
/** `disabled` — not requested; `generic_unassigned` — the product is in «Не разобрано»; `none` — nothing to compare with. */
export type SimilarStatus = typeof similarStatuses[number]

export type PriceSeriesParams = {
  date_from?: ISODate; date_to?: ISODate
  /** Country codes, sent as one comma-separated value; the server accepts at most 20. */
  country?: readonly CountryCode[]
  currency?: CurrencyCode
  interval?: PriceSeriesInterval
  price?: PriceSeriesKind
  similar?: 'generic' | 'none'
  /** Similar products shown: 1–20, the server default is 8. */
  similar_limit?: number
}
export type PriceSeriesPoint = { period_start: ISODate; count: number; min: Decimal; max: Decimal; avg: Decimal; last: Decimal }
type PriceSeriesLineBase = {
  product: NamedObject; country: CountryCode; currency: CurrencyCode; unit: Unit
  /** The unit equals the base unit of the generic product; possible only for normalized prices. */
  comparable: boolean
  observations: number; points: PriceSeriesPoint[]
}
/** The product itself in one store, currency and unit. */
export type OwnPriceSeries = PriceSeriesLineBase & { role: 'own'; store: StoreBrief }
/** Another visible product of the same generic product in one country, currency and unit; it has no store. */
export type SimilarPriceSeries = PriceSeriesLineBase & { role: 'similar'; store: null }
export type PriceSeriesLine = OwnPriceSeries | SimilarPriceSeries
export type PriceSeries = {
  product: PriceProduct; generic: GenericRef
  price: PriceSeriesKind; interval: PriceSeriesInterval
  /** Own observations left out for lack of a normalized price; 0 for paid prices. */
  skipped_without_normalized: number
  /** Own series first, then similar ones; empty for a product without observations. */
  series: PriceSeriesLine[]
  /** More than 20 own series existed; the ones with the most observations are kept. */
  own_truncated: boolean
  similar: { status: SimilarStatus; products_total: number; products_shown: number }
}
