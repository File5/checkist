/** Wire types for backend 5e1adfa. Decimal values stay strings throughout the client. */
export type Decimal = string
export type ISODate = string
export type ISODateTime = string
export type CountryCode = string
export type CurrencyCode = string
export type Unit = 'pcs' | 'g' | 'kg' | 'ml' | 'l' | 'm'
export type BaseUnit = 'pcs' | 'kg' | 'l'
export type NormalizedUnit = BaseUnit | 'm'
export type ApiErrorReason =
  | 'invalid_parameter' | 'invalid_request' | 'range_too_large'
  | 'not_found' | 'page_out_of_range' | 'server'
  | 'network' | 'timeout' | 'invalid_response'
export type ApiFailure = {
  kind: 'error'
  reason: ApiErrorReason
  status?: number
  /** Invalid field names only; server messages must never reach the UI. */
  fields?: string[]
}
export type ApiResult<T> = { kind: 'ok'; data: T } | ApiFailure | { kind: 'aborted' }
export type RequestOptions = { signal?: AbortSignal; baseUrl?: string }
export type Results<T> = { results: T[] }
export type Page<T> = Results<T> & { count: number; page: number; page_size: number; pages: number }
export type PageParams = { page?: number; page_size?: number }

export type NamedObject = { id: number; name: string }
export type CategoryRef = NamedObject & { path: NamedObject[] }
export type Category = CategoryRef & {
  parent_id: number | null
  depth: number
  children_count: number
  generic_products_count: number
  products_count: number
  products_total: number
}
export type GenericRef = NamedObject & { base_unit: BaseUnit }
export type CategoryGeneric = GenericRef & { products_count: number }
export type CategoryDetail = Category & { children: Category[]; generic_products: CategoryGeneric[] }
export type GenericProduct = CategoryGeneric & { category: CategoryRef; countries: CountryCode[] }
export type CategoryParams = { q?: string }
export type GenericProductParams = PageParams & { q?: string; category?: number }
export type ProductOrdering = 'name' | '-name' | 'last_observed_at' | '-last_observed_at'
export type ProductParams = PageParams & {
  q?: string
  category?: number
  generic?: number
  brand?: number
  country?: CountryCode
  has_prices?: boolean
  ordering?: ProductOrdering
}

export type StoreBrief = NamedObject & { city: string; country: CountryCode }
export type Store = StoreBrief & { address: string; timezone: string }
export type StoreEntry = Store & { receipts_count: number }
export type ProductStore = Store & { observations: number; last_purchased_on: ISODate }
export type StoreParams = PageParams & { q?: string; country?: CountryCode }
export type NormalizedPrice = {
  normalized_price: Decimal | null
  normalized_unit: NormalizedUnit | null
  comparable: boolean
}
export type LastProductPrice = NormalizedPrice & {
  paid_unit_price: Decimal
  purchased_on: ISODate
  store_id: number
}
export type ProductPrice = {
  country: CountryCode
  currency: CurrencyCode
  observations: number
  last: LastProductPrice
}
export type Product = NamedObject & {
  brand: NamedObject | null
  model: string
  gtin: string
  package: { quantity: Decimal; unit: Unit } | null
  generic: GenericRef
  category: CategoryRef
  last_observed_at: ISODateTime | null
  prices: ProductPrice[]
}
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type ProductAlias = { store_name: string; raw_name: string; store_item_code: string }
export type ProductDetail = Product & {
  attributes: JsonValue
  aliases: ProductAlias[]
  stores: ProductStore[]
  alternatives_count: number
}

export type PriceProduct = NamedObject & { base_unit: BaseUnit }
export type PricePoint = NormalizedPrice & {
  observed_at: ISODateTime
  purchased_on: ISODate
  store: StoreBrief
  currency: CurrencyCode
  quantity: Decimal
  unit: Unit
  list_unit_price: Decimal
  paid_unit_price: Decimal
  discount_amount: Decimal
  receipt_id: number
  position: number
}
export type PriceHistory = Page<PricePoint> & { product: PriceProduct }
export type PriceFilters = {
  store?: number
  country?: CountryCode
  currency?: CurrencyCode
  date_from?: ISODate
  date_to?: ISODate
}
export type PriceParams = PriceFilters & PageParams & { ordering?: 'observed_at' | '-observed_at' }
export type PriceMode = 'paid' | 'list' | 'normalized'
export type PriceGroupBy = 'country' | 'store' | 'none'
export type PriceInterval = 'none' | 'day' | 'week' | 'month'
export type PriceSummaryParams = PriceFilters & {
  group_by?: PriceGroupBy
  interval?: PriceInterval
  price?: PriceMode
}
export type DatedPrice = { price: Decimal; purchased_on: ISODate }
export type PriceTotal = {
  count: number
  min: Decimal
  max: Decimal
  avg: Decimal
  first: DatedPrice
  last: DatedPrice
  change_percent: Decimal | null
}
export type PriceBucket = {
  period_start: ISODate
  count: number
  min: Decimal
  max: Decimal
  avg: Decimal
  last: Decimal
}
export type PriceSummaryGroup = {
  currency: CurrencyCode
  unit: Unit
  total: PriceTotal
  buckets: PriceBucket[]
}
type PriceSummaryBody = { product: PriceProduct; interval: PriceInterval } & (
  | { group_by: 'country'; groups: (PriceSummaryGroup & { country: CountryCode })[] }
  | { group_by: 'store'; groups: (PriceSummaryGroup & { store: Store })[] }
  | { group_by: 'none'; groups: PriceSummaryGroup[] }
)
export type PriceSummary = PriceSummaryBody & (
  | { price: 'paid' | 'list'; skipped_without_normalized?: never }
  | { price: 'normalized'; skipped_without_normalized: number }
)
