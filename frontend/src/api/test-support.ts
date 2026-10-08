import type {
  Category, CategoryDetail, ForeignPricePoint, GenericProduct, OwnPricePoint, Page, PriceHistory, PriceSummary,
  PriceTotal, Product, ProductDetail, Store, StoreEntry,
} from './types'

export const category: Category = {
  id: 2, name: 'Молочные продукты', parent_id: 1, depth: 1,
  path: [{ id: 1, name: 'Продукты' }, { id: 2, name: 'Молочные продукты' }],
  children_count: 0, generic_products_count: 1, products_count: 1, products_total: 1,
}
export const generic: GenericProduct = {
  id: 5, name: 'Молоко', base_unit: 'l', category: { id: 2, name: category.name, path: category.path },
  products_count: 1, countries: ['DE', 'RU'],
}
export const categoryDetail: CategoryDetail = {
  ...category, children: [], generic_products: [{ id: 5, name: generic.name, base_unit: 'l', products_count: 1 }],
}
export const store: Store = {
  id: 7, name: 'Учебный магазин', city: '', address: 'Учебная улица, 1', country: 'DE', timezone: 'Europe/Berlin',
}
export const storeEntry: StoreEntry = { ...store, receipts_count: 2 }
export const product: Product = {
  id: 9, name: 'Молоко 850 мл', brand: { id: 3, name: 'Пример' }, model: '', gtin: '',
  package: { quantity: '850.000', unit: 'ml' },
  generic: { id: 5, name: 'Молоко', base_unit: 'l' }, category: generic.category,
  last_observed_at: '2026-10-03T22:30:00.123456Z',
  prices: [{
    country: 'DE', currency: 'EUR', observations: 2,
    last: { paid_unit_price: '-1.0500', normalized_price: '-1.2353', normalized_unit: 'l',
      comparable: true, purchased_on: '2026-10-04', store_id: 7 },
  }],
}
export const detail: ProductDetail = {
  ...product, attributes: { fat_percent: 2.5, tags: [null, true, { label: 'Пример' }] },
  aliases: [{ store_name: store.name, raw_name: 'МОЛОКО', store_item_code: '' }],
  stores: [{ ...store, observations: 2, last_purchased_on: '2026-10-04' }], alternatives_count: 0,
}
export const point: OwnPricePoint = {
  observed_at: '2026-10-03T22:30:00Z', purchased_on: '2026-10-04',
  store: { id: 7, name: store.name, city: '', country: 'DE' }, currency: 'EUR', quantity: '1.000', unit: 'pcs',
  list_unit_price: '0.0000', paid_unit_price: '-1.0500', discount_amount: '1.05',
  normalized_price: null, normalized_unit: null, comparable: false, receipt_id: 12, position: 2, own: true,
}
/** The same price seen by another user: the receipt behind it is hidden. */
export const foreignPoint: ForeignPricePoint = {
  ...point, own: false, observed_at: null, quantity: null, discount_amount: null, receipt_id: null, position: null,
}
export function pageOf<T>(results: T[], page_size = 50): Page<T> {
  return { count: results.length, page: 1, page_size, pages: results.length ? Math.ceil(results.length / page_size) : 0, results }
}
export const history: PriceHistory = { product: { id: 9, name: product.name, base_unit: 'l' }, ...pageOf([point], 200) }
export const total: PriceTotal = {
  count: 2, min: '-1.0500', max: '0.0000', avg: '-0.5250',
  first: { price: '0.0000', purchased_on: '2026-10-03' },
  last: { price: '-1.0500', purchased_on: '2026-10-04' }, change_percent: null,
}
export const summary: PriceSummary = {
  product: history.product, price: 'paid', group_by: 'country', interval: 'month',
  groups: [{ country: 'DE', currency: 'EUR', unit: 'pcs', total,
    buckets: [{ period_start: '2026-10-01', count: 2, min: '-1.0500', max: '0.0000', avg: '-0.5250', last: '-1.0500' }] }],
}
