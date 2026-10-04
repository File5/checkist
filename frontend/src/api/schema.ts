import type {
  BaseUnit, Category, CategoryDetail, CategoryGeneric, CategoryRef, DatedPrice, GenericProduct,
  GenericRef, JsonValue, LastProductPrice, NamedObject, NormalizedPrice, Page, PriceBucket,
  PriceHistory, PricePoint, PriceProduct, PriceSummary, PriceSummaryGroup, PriceTotal, Product,
  ProductAlias, ProductDetail, ProductPrice, ProductStore, Results, Store, StoreBrief, StoreEntry,
} from './types.ts'

type Check = (value: unknown) => boolean
type Guard<T> = (value: unknown) => value is T
export type { Check, Guard }
const text: Check = (value) => typeof value === 'string'
const bool: Check = (value) => typeof value === 'boolean'
export const isId: Guard<number> = (value): value is number => Number.isSafeInteger(value) && (value as number) > 0
const nonNegativeInteger: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0
const nullable = (check: Check): Check => (value) => value === null || check(value)
const array = (check: Check): Check => (value) => Array.isArray(value) && value.every(check)
const choice = (...values: string[]): Check => (value) => typeof value === 'string' && values.includes(value)
const baseUnit = choice('pcs', 'kg', 'l')
const normalizedUnit = choice('pcs', 'kg', 'l', 'm')
const unit = choice('pcs', 'g', 'kg', 'ml', 'l', 'm')
// Reference models limit length, but do not validate ISO syntax on stored codes.
// Query syntax is stricter and belongs to the request/navigation validation.
const referenceCode = (maximum: number): Check => (value) => typeof value === 'string'
  && value.length > 0 && Array.from(value).length <= maximum
const country = referenceCode(2)
const currency = referenceCode(3)
const decimal = (places: number): Check => (value) => typeof value === 'string'
  && new RegExp(`^-?\\d+\\.\\d{${places}}$`).test(value)
const price = decimal(4)
const amount = decimal(2)
const quantity = decimal(3)

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Require all documented fields, allowing additive fields for forward compatibility. */
function object<T>(shape: { [K in keyof T]-?: Check }): Guard<T> {
  return (value): value is T => record(value) && Object.entries<Check>(shape).every(
    ([key, check]) => Object.hasOwn(value, key) && check(value[key]),
  )
}

export { text, bool, nonNegativeInteger, nullable, array, choice, country, currency, decimal, amount, price, quantity, record, object, named, store, unit }

export function isISODate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= days[month - 1]
}

export function isISODateTime(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z$/.exec(value)
  return parts !== null && isISODate(parts[1]) && Number(parts[2]) < 24
    && Number(parts[3]) < 60 && Number(parts[4]) < 60
}

const named = object<NamedObject>({ id: isId, name: text })
const categoryRef = object<CategoryRef>({ id: isId, name: text, path: array(named) })
export const isCategory = object<Category>({
  id: isId, name: text, path: array(named), parent_id: nullable(isId), depth: nonNegativeInteger,
  children_count: nonNegativeInteger, generic_products_count: nonNegativeInteger,
  products_count: nonNegativeInteger, products_total: nonNegativeInteger,
})
const genericRef = object<GenericRef>({ id: isId, name: text, base_unit: baseUnit })
const categoryGeneric = object<CategoryGeneric>({ id: isId, name: text, base_unit: baseUnit, products_count: nonNegativeInteger })
export const isCategoryDetail: Guard<CategoryDetail> = (value): value is CategoryDetail => isCategory(value)
  && object<{ children: Category[]; generic_products: CategoryGeneric[] }>({
    children: array(isCategory), generic_products: array(categoryGeneric),
  })(value)
export const isGenericProduct = object<GenericProduct>({
  id: isId, name: text, base_unit: baseUnit, products_count: nonNegativeInteger, category: categoryRef, countries: array(country),
})
const storeBrief = object<StoreBrief>({ id: isId, name: text, city: text, country })
const store = object<Store>({ id: isId, name: text, city: text, country, address: text, timezone: text })
export const isStoreEntry: Guard<StoreEntry> = (value): value is StoreEntry => store(value)
  && object<{ receipts_count: number }>({ receipts_count: nonNegativeInteger })(value)
const productStore: Guard<ProductStore> = (value): value is ProductStore => store(value)
  && object<{ observations: number; last_purchased_on: string }>({ observations: isId, last_purchased_on: isISODate })(value)
const normalizedShape = object<NormalizedPrice>({
  normalized_price: nullable(price), normalized_unit: nullable(normalizedUnit), comparable: bool,
})
function normalized(value: unknown): value is NormalizedPrice {
  return normalizedShape(value) && (value.normalized_price === null
    ? value.normalized_unit === null && !value.comparable : value.normalized_unit !== null)
}
function matchesBase(value: NormalizedPrice, base: BaseUnit): boolean {
  return value.comparable === (value.normalized_unit === base)
}
const lastPrice: Guard<LastProductPrice> = (value): value is LastProductPrice => normalized(value)
  && object<{ paid_unit_price: string; purchased_on: string; store_id: number }>({
    paid_unit_price: price, purchased_on: isISODate, store_id: isId,
  })(value)
const productPrice = object<ProductPrice>({ country, currency, observations: isId, last: lastPrice })
const productShape = object<Product>({
  id: isId, name: text, brand: nullable(named), model: text, gtin: text,
  package: nullable(object<{ quantity: string; unit: string }>({ quantity, unit })),
  generic: genericRef, category: categoryRef, last_observed_at: nullable(isISODateTime), prices: array(productPrice),
})
export const isProduct: Guard<Product> = (value): value is Product => productShape(value)
  && value.prices.every((group) => matchesBase(group.last, value.generic.base_unit))

function jsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(jsonValue)
  return record(value) && Object.values(value).every(jsonValue)
}
const alias = object<ProductAlias>({ store_name: text, raw_name: text, store_item_code: text })
export const isProductDetail: Guard<ProductDetail> = (value): value is ProductDetail => isProduct(value)
  && object<{ attributes: JsonValue; aliases: ProductAlias[]; stores: ProductStore[]; alternatives_count: number }>({
    attributes: jsonValue, aliases: array(alias), stores: array(productStore), alternatives_count: nonNegativeInteger,
  })(value)

export function results<T>(check: Guard<T>): Guard<Results<T>> {
  return object<Results<T>>({ results: array(check) })
}
export function page<T>(check: Guard<T>, maximum = 200): Guard<Page<T>> {
  const shape = object<Page<T>>({ count: nonNegativeInteger, page: isId, page_size: isId,
    pages: nonNegativeInteger, results: array(check) })
  return (value): value is Page<T> => shape(value) && value.page_size <= maximum
    && value.pages === Math.ceil(value.count / value.page_size) && value.page <= Math.max(1, value.pages)
    // COUNT and the page query may see different snapshots under READ COMMITTED.
    && value.results.length <= value.page_size
}

const priceProduct = object<PriceProduct>({ id: isId, name: text, base_unit: baseUnit })
const point: Guard<PricePoint> = (value): value is PricePoint => normalized(value)
  && object<Omit<PricePoint, keyof NormalizedPrice>>({
    observed_at: isISODateTime, purchased_on: isISODate, store: storeBrief, currency, quantity, unit,
    list_unit_price: price, paid_unit_price: price, discount_amount: amount,
    receipt_id: isId, position: nonNegativeInteger,
  })(value)
export const isPriceHistory: Guard<PriceHistory> = (value): value is PriceHistory => page(point, 500)(value)
  && object<{ product: PriceProduct }>({ product: priceProduct })(value)
  && value.results.every((item) => matchesBase(item, value.product.base_unit))

const datedPrice = object<DatedPrice>({ price, purchased_on: isISODate })
const total = object<PriceTotal>({
  count: isId, min: price, max: price, avg: price, first: datedPrice, last: datedPrice, change_percent: nullable(amount),
})
const bucket = object<PriceBucket>({ period_start: isISODate, count: isId, min: price, max: price, avg: price, last: price })
const group = object<PriceSummaryGroup>({ currency, unit, total, buckets: array(bucket) })
export const isPriceSummary: Guard<PriceSummary> = (value): value is PriceSummary => {
  if (!record(value) || !priceProduct(value.product) || !choice('paid', 'list', 'normalized')(value.price)
    || !choice('country', 'store', 'none')(value.group_by) || !choice('none', 'day', 'week', 'month')(value.interval)
    || !Array.isArray(value.groups)) return false
  if (value.price === 'normalized' ? !nonNegativeInteger(value.skipped_without_normalized)
    : Object.hasOwn(value, 'skipped_without_normalized')) return false
  return value.groups.every((item: unknown) => group(item)
    && (value.price !== 'normalized' || normalizedUnit(item.unit))
    && (value.interval !== 'none' || item.buckets.length === 0)
    && (value.group_by === 'country'
      ? object<{ country: string }>({ country })(item) && !Object.hasOwn(item, 'store')
      : value.group_by === 'store'
        ? object<{ store: Store }>({ store })(item) && !Object.hasOwn(item, 'country')
        : !Object.hasOwn(item, 'country') && !Object.hasOwn(item, 'store')))
}
