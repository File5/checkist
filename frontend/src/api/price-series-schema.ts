import { array, bool, choice, country, currency, isId, isISODate, named, nonNegativeInteger, nullable, object, price, text, unit } from './schema.ts'
import type { Guard } from './schema.ts'
import { priceSeriesIntervals, priceSeriesKinds, similarStatuses } from './price-series-types.ts'
import type { PriceSeries, PriceSeriesLine, PriceSeriesPoint } from './price-series-types.ts'
import type { GenericRef, StoreBrief } from './types.ts'

const point = object<PriceSeriesPoint>({ period_start: isISODate, count: isId, min: price, max: price, avg: price, last: price })
const storeBrief = object<StoreBrief>({ id: isId, name: text, city: text, country })
const lineShape = object<PriceSeriesLine>({
  role: choice('own', 'similar'), product: named, store: nullable(storeBrief), country, currency, unit, comparable: bool,
  observations: isId, points: array(point),
})
const line: Guard<PriceSeriesLine> = (value): value is PriceSeriesLine => lineShape(value)
  // Only the product's own series belongs to a store, and that store is in the series' country.
  && (value.role === 'own' ? value.store !== null && value.store.country === value.country : value.store === null)
  && value.points.every((item, index) => index === 0 || value.points[index - 1].period_start < item.period_start)
  && value.points.reduce((sum, item) => sum + item.count, 0) === value.observations
const generic = object<GenericRef>({ id: isId, name: text, base_unit: choice('pcs', 'kg', 'l') })
const similar = object<PriceSeries['similar']>({
  status: choice(...similarStatuses), products_total: nonNegativeInteger, products_shown: nonNegativeInteger,
})
const shape = object<PriceSeries>({
  product: generic, generic, price: choice(...priceSeriesKinds), interval: choice(...priceSeriesIntervals),
  skipped_without_normalized: nonNegativeInteger, series: array(line), own_truncated: bool, similar,
})
export const isPriceSeries: Guard<PriceSeries> = (value): value is PriceSeries => {
  if (!shape(value)) return false
  const { status, products_total: total, products_shown: shown } = value.similar
  const others = new Set(value.series.filter((item) => item.role === 'similar').map((item) => item.product.id))
  return value.product.base_unit === value.generic.base_unit
    && (value.price === 'normalized' || value.skipped_without_normalized === 0)
    && shown <= total && (status === 'ok' ? shown > 0 : total === 0)
    // The ranking and the rows are separate queries, so a shown product may arrive without a series.
    && others.size <= shown && !others.has(value.product.id)
    && value.series.every((item) => (item.role !== 'own' || item.product.id === value.product.id)
      && item.comparable === (value.price === 'normalized' && item.unit === value.generic.base_unit))
}
