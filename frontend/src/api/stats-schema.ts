import { amount, array, bool, choice, country, currency, isId, isISODate, named, nonNegativeInteger, nullable, object, price, quantity, text, unit } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import { receiptIntervals, spendingGroupings, spendingSpecialKinds } from './stats-types.ts'
import type {
  CompareChange, CompareCurrency, CompareEffects, ComparePeriod, ComparePriceIndex, CompareProduct, ComparePurchase, CompareSide,
  ReceiptBucket, ReceiptCompare, ReceiptSeries, ReceiptSeriesCurrency, Spending, SpendingCurrency, SpendingItem, SpendingOther,
  SpendingTotals,
} from './stats-types.ts'
import type { CategoryRef } from './types.ts'

const percent = amount
const special: Check = choice(...spendingSpecialKinds)
/** Blocks are keyed by the currency of the receipt: a repeated code would add up on a chart. */
const distinct = (blocks: { currency: string }[]) => new Set(blocks.map((block) => block.currency)).size === blocks.length
const ascending = (items: { period_start: string }[]) => items.every((item, index) => index === 0 || items[index - 1].period_start < item.period_start)

const itemShape = object<SpendingItem>({
  kind: choice(...spendingGroupings, ...spendingSpecialKinds), id: nullable(isId), name: nullable(text), direct: bool, unassigned: bool,
  amount, share_percent: nullable(percent), lines_count: nonNegativeInteger, receipts_count: nonNegativeInteger,
  quantity: nullable(quantity), unit: nullable(unit),
})
const place = object<{ city: string; country: string }>({ city: text, country })
const item: Guard<SpendingItem> = (value): value is SpendingItem => itemShape(value)
  // Special items carry neither id nor name; every other one carries both.
  && (special(value.kind) ? value.id === null && value.name === null : value.id !== null && value.name !== null)
  && (value.kind !== 'store' || place(value))
  && (!value.direct || value.kind === 'category')
  && (!value.unassigned || value.kind === 'category' || value.kind === 'generic')
  && (value.quantity === null) === (value.unit === null)
  && (value.quantity === null || value.kind === 'product')
const other = object<SpendingOther>({ count: isId, amount, share_percent: nullable(percent) })
const totalsShape = object<SpendingTotals>({
  receipts_count: nonNegativeInteger, receipts_total: nullable(amount), lines_paid: amount, difference: nullable(amount),
})
const totals: Guard<SpendingTotals> = (value): value is SpendingTotals => totalsShape(value)
  && (value.receipts_total === null) === (value.difference === null)
const spendingBlock = object<SpendingCurrency>({ currency, totals, items: array(item), other: nullable(other) })
const categoryRef = object<CategoryRef>({ id: isId, name: text, path: array(named) })
const spendingShape = object<Spending>({
  group_by: choice(...spendingGroupings), date_from: nullable(isISODate), date_to: nullable(isISODate),
  parent: nullable(categoryRef), currencies: array(spendingBlock),
})
export const isSpending: Guard<Spending> = (value): value is Spending => spendingShape(value)
  && distinct(value.currencies)
  && (value.parent === null || value.group_by === 'category')
  // Regular items are of the requested grouping; a store grouping has no special items.
  && value.currencies.every((block) => block.items.every((entry) => entry.kind === value.group_by
    || (value.group_by !== 'store' && special(entry.kind))))

const bucketShape = object<ReceiptBucket>({
  period_start: isISODate, receipts_count: isId, total: amount, avg_receipt: amount, median_receipt: amount,
  lines_count: nonNegativeInteger, lines_per_receipt: amount, paid_per_line: nullable(price),
})
const bucket: Guard<ReceiptBucket> = (value): value is ReceiptBucket => bucketShape(value)
  && (value.paid_per_line === null) === (value.lines_count === 0)
const seriesBlockShape = object<ReceiptSeriesCurrency>({ currency, refunds_excluded: nonNegativeInteger, buckets: array(bucket) })
/** A currency without visits gives no block; intervals without visits are left out. */
const seriesBlock: Guard<ReceiptSeriesCurrency> = (value): value is ReceiptSeriesCurrency => seriesBlockShape(value)
  && value.buckets.length > 0 && ascending(value.buckets)
const seriesShape = object<ReceiptSeries>({
  interval: choice(...receiptIntervals), date_from: nullable(isISODate), date_to: nullable(isISODate), currencies: array(seriesBlock),
})
export const isReceiptSeries: Guard<ReceiptSeries> = (value): value is ReceiptSeries => seriesShape(value) && distinct(value.currencies)

const period = object<ComparePeriod>({ date_from: isISODate, date_to: isISODate })
const sideShape = object<CompareSide>({
  receipts_count: nonNegativeInteger, months: amount, receipts_per_month: amount, refunds_excluded: nonNegativeInteger,
  total: amount, avg_receipt: nullable(amount), median_receipt: nullable(amount),
  lines_count: nonNegativeInteger, lines_per_receipt: nullable(amount), paid_per_line: nullable(price),
})
const side: Guard<CompareSide> = (value): value is CompareSide => {
  if (!sideShape(value)) return false
  const empty = value.receipts_count === 0
  return (value.avg_receipt === null) === empty && (value.median_receipt === null) === empty
    && (value.lines_per_receipt === null) === empty && (value.paid_per_line === null) === (value.lines_count === 0)
}
const change = object<CompareChange>({ avg_receipt: nullable(amount), avg_receipt_percent: nullable(percent) })
const effectsShape = object<CompareEffects>({
  quantity: amount, price: nullable(amount), mix: nullable(amount), price_per_line: amount,
  quantity_percent: nullable(percent), price_percent: nullable(percent), mix_percent: nullable(percent),
})
/** Price and mix are known or unknown together; a share cannot exist without its effect. */
const effects: Guard<CompareEffects> = (value): value is CompareEffects => effectsShape(value)
  && (value.price === null) === (value.mix === null)
  && (value.price !== null || (value.price_percent === null && value.mix_percent === null))
const priceIndex = object<ComparePriceIndex>({
  fisher: price, laspeyres: price, paasche: price, matched_products: isId,
  coverage_base_percent: percent, coverage_current_percent: percent,
})
const purchase = object<ComparePurchase>({ price, quantity, amount })
const compareProduct = object<CompareProduct>({ product: named, unit, base: purchase, current: purchase, price_change_percent: percent })
const compareBlockShape = object<CompareCurrency>({
  currency, base: side, current: side, change, effects: nullable(effects), price_index: nullable(priceIndex),
  products: array(compareProduct), products_total: nonNegativeInteger,
})
const compareBlock: Guard<CompareCurrency> = (value): value is CompareCurrency => compareBlockShape(value)
  // The block exists only with visits in at least one period.
  && value.base.receipts_count + value.current.receipts_count > 0
  && (value.change.avg_receipt !== null || (value.change.avg_receipt_percent === null && value.effects === null))
  && value.products_total === (value.price_index?.matched_products ?? 0)
  && value.products.length <= value.products_total
const compareShape = object<ReceiptCompare>({ base: period, current: period, currencies: array(compareBlock) })
export const isReceiptCompare: Guard<ReceiptCompare> = (value): value is ReceiptCompare => compareShape(value) && distinct(value.currencies)
