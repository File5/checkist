/** Wire types of the statistics API (docs/api-contract.md). Money, quantities, prices and percents stay strings. */
import type { CategoryRef, CountryCode, CurrencyCode, Decimal, ISODate, NamedObject, Unit } from './types.ts'

/** Common filters of `/api/stats/*`. Empty strings and an empty store list are not sent. */
export type StatsFilters = {
  date_from?: ISODate; date_to?: ISODate
  country?: CountryCode; currency?: CurrencyCode
  /** Store ids, sent as one comma-separated value; the server accepts at most 20. */
  store?: readonly number[]
}
/** Echo of the requested period; `null` — the bound was not given. */
export type StatsPeriod = { date_from: ISODate | null; date_to: ISODate | null }

export const spendingGroupings = ['category', 'generic', 'product', 'store'] as const
export type SpendingGroupBy = typeof spendingGroupings[number]
export const spendingSpecialKinds = ['unmatched', 'service', 'deposit'] as const
export type SpendingSpecialKind = typeof spendingSpecialKinds[number]
export type SpendingParams = StatsFilters & {
  group_by?: SpendingGroupBy
  category?: number; generic?: number
  /** Regular items before «прочее»: 1–500, the server default is 10. */
  limit?: number
}
type SpendingItemBase = {
  /** Only a category: products lying directly in the category of the filter. */
  direct: boolean
  /** Category or generic product «Не разобрано». */
  unassigned: boolean
  amount: Decimal
  /** Share among the positive items of the block; `null` for an amount ≤ 0. */
  share_percent: Decimal | null
  lines_count: number; receipts_count: number
  /** Both set only for a product whose lines all share one unit. */
  quantity: Decimal | null; unit: Unit | null
}
export type SpendingRegularItem = SpendingItemBase & { kind: 'category' | 'generic' | 'product'; id: number; name: string }
export type SpendingStoreItem = SpendingItemBase & { kind: 'store'; id: number; name: string; city: string; country: CountryCode }
/** Lines without a product, services and deposits: never folded into «прочее», absent under a category/generic filter. */
export type SpendingSpecialItem = SpendingItemBase & { kind: SpendingSpecialKind; id: null; name: null }
export type SpendingItem = SpendingRegularItem | SpendingStoreItem | SpendingSpecialItem
export type SpendingOther = { count: number; amount: Decimal; share_percent: Decimal | null }
export type SpendingTotals = {
  receipts_count: number
  /** `null` together with `difference` under a category/generic filter. */
  receipts_total: Decimal | null
  lines_paid: Decimal
  difference: Decimal | null
}
/** One currency is one block: amounts of different currencies are never added. */
export type SpendingCurrency = { currency: CurrencyCode; totals: SpendingTotals; items: SpendingItem[]; other: SpendingOther | null }
export type Spending = StatsPeriod & {
  group_by: SpendingGroupBy
  /** Category of the `category` filter under any grouping; `null` without the filter or for an unknown category. */
  parent: CategoryRef | null
  currencies: SpendingCurrency[]
}

export const receiptIntervals = ['week', 'month', 'quarter', 'year'] as const
export type ReceiptInterval = typeof receiptIntervals[number]
export type ReceiptSeriesParams = StatsFilters & { interval?: ReceiptInterval }
/** An interval with at least one visit (sale receipt). */
export type ReceiptBucket = {
  period_start: ISODate; receipts_count: number
  total: Decimal; avg_receipt: Decimal; median_receipt: Decimal
  lines_count: number; lines_per_receipt: Decimal
  /** 4 places; `null` without product lines. */
  paid_per_line: Decimal | null
}
export type ReceiptSeriesCurrency = { currency: CurrencyCode; refunds_excluded: number; buckets: ReceiptBucket[] }
export type ReceiptSeries = StatsPeriod & { interval: ReceiptInterval; currencies: ReceiptSeriesCurrency[] }

/** All four dates are mandatory and `base_to` must precede `current_from`. */
export type ReceiptCompareParams = Pick<StatsFilters, 'country' | 'currency' | 'store'> & {
  base_from: ISODate; base_to: ISODate; current_from: ISODate; current_to: ISODate
  /** Matched products in `products`: 1–100, the server default is 20. */
  limit?: number
}
export type ComparePeriod = { date_from: ISODate; date_to: ISODate }
/** A period of the comparison; averages are `null` without visits. */
export type CompareSide = {
  receipts_count: number; months: Decimal; receipts_per_month: Decimal; refunds_excluded: number
  total: Decimal; avg_receipt: Decimal | null; median_receipt: Decimal | null
  lines_count: number; lines_per_receipt: Decimal | null; paid_per_line: Decimal | null
}
export type CompareChange = { avg_receipt: Decimal | null; avg_receipt_percent: Decimal | null }
/** `quantity + price + mix = change.avg_receipt`; without matched products only `quantity` and `price_per_line` are known. */
export type CompareEffects = {
  quantity: Decimal; price: Decimal | null; mix: Decimal | null
  /** `price + mix`, always present. */
  price_per_line: Decimal
  quantity_percent: Decimal | null; price_percent: Decimal | null; mix_percent: Decimal | null
}
/** Fisher index over products bought in both periods; coverage tells how representative it is. */
export type ComparePriceIndex = {
  fisher: Decimal; laspeyres: Decimal; paasche: Decimal; matched_products: number
  coverage_base_percent: Decimal; coverage_current_percent: Decimal
}
export type ComparePurchase = { price: Decimal; quantity: Decimal; amount: Decimal }
export type CompareProduct = { product: NamedObject; unit: Unit; base: ComparePurchase; current: ComparePurchase; price_change_percent: Decimal }
export type CompareCurrency = {
  currency: CurrencyCode; base: CompareSide; current: CompareSide; change: CompareChange
  /** `null` when either period has no visits or no product lines. */
  effects: CompareEffects | null
  /** `null` when no product was bought in both periods. */
  price_index: ComparePriceIndex | null
  products: CompareProduct[]; products_total: number
}
export type ReceiptCompare = { base: ComparePeriod; current: ComparePeriod; currencies: CompareCurrency[] }

/** Chart value of a wire decimal; `null` stays `null`, anything that is not a finite decimal becomes `null`. */
export function decimalNumber(value: Decimal | null | undefined): number | null {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}
/** Chart position of a wire date: UTC milliseconds of its midnight, independent of the browser time zone. */
export function dateMs(value: ISODate | null | undefined): number | null {
  const parts = typeof value === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null
  if (!parts) return null
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])]
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  // An impossible day (2026-02-30) would silently roll over to another one.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.getTime() : null
}
