import { safeMediaUrl } from '../lib/media.ts'
import { amount, array, bool, choice, country, currency, isId, isISODate, isISODateTime, named, nonNegativeInteger, nullable, object, price, quantity, record, store, text, unit } from './schema.ts'
import type { Guard } from './schema.ts'
import type { Discount, Line, ManualDefaults, Receipt, Tax, TaxRate } from './receipts-types.ts'

export const receiptOperation = choice('sale', 'refund')
export const receiptSource = choice('photo', 'manual')
export const lineKind = choice('product', 'service', 'deposit', 'deposit_return')
export const taxKind = choice('vat', 'exempt')
export const mediaPath = (value: unknown) => safeMediaUrl(value) !== null
const apiPath = (value: unknown) => typeof value === 'string' && /^\/api\/(?:receipts\/\d+\/(?:lines|discounts|taxes)\/|recognition\/receipt-images\/\?receipt=\d+)$/.test(value)

export const isTaxRate = object<TaxRate>({ id: isId, country, kind: taxKind, rate: nullable(amount) })
const isReceiptShape = object<Receipt>({
  id: isId, owner: (value: unknown) => typeof value === 'string' && value.length > 0, source: receiptSource, store: nullable(store), note: text, currency, operation: receiptOperation, purchased_on: isISODate, purchased_at: isISODateTime,
  total: amount, discount_total: amount, prices_include_tax: bool, origin: choice('recognized', 'legacy/manual'), review_required: bool,
  lines_count: nonNegativeInteger, unmatched_products_count: nonNegativeInteger, receipt_images_count: nonNegativeInteger,
  preview_image_url: nullable(mediaPath), preview_thumb_url: nullable(mediaPath), created_at: isISODateTime, updated_at: isISODateTime,
  lines_url: apiPath, discounts_url: apiPath, taxes_url: apiPath, images_url: apiPath,
})
/** Only a manual spend may come without a store. */
export const isReceipt: Guard<Receipt> = (value): value is Receipt => isReceiptShape(value)
  && (value.store !== null || value.source === 'manual')
export const isManualDefaults = object<ManualDefaults>({ currency, frequent_categories: array(isId) })
const translations = (value: unknown) => record(value) && Object.entries(value).every(
  ([key, val]) => /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(key) && text(val),
)
const lineShape = object<Line>({
  id: isId, position: nonNegativeInteger, kind: lineKind, parent_id: nullable(isId), name: text, name_i18n: translations,
  store_item_code: text, barcode: text, quantity, unit, unit_price: price, amount, discount_amount: amount, paid_amount: amount,
  product: nullable(named), category: nullable(named), matching_status: choice('matched', 'unmatched'), tax_rate: nullable(isTaxRate),
  tax_code: text, tax_amount: nullable(amount), is_excise: bool, is_marked: bool,
})
export const isLine: Guard<Line> = (value): value is Line => lineShape(value)
  && value.matching_status === (value.product === null ? 'unmatched' : 'matched')
export const isDiscount = object<Discount>({ id: isId, position: nonNegativeInteger, line_id: nullable(isId), name: text, amount })
export const isTax = object<Tax>({ id: isId, tax_rate: isTaxRate, tax_code: text, net: amount, tax: amount, gross: amount })
