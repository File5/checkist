/** Visits over time as chart series. Pure: the numbers are for drawing only, the texts keep the wire decimals. */
import { decimalNumber } from '../../api/stats'
import type { ReceiptBucket, ReceiptInterval, ReceiptSeriesCurrency } from '../../api/stats'
import type { Decimal } from '../../api/types'
import { formatAmount, formatPurchasedOn, formatQuantity } from '../../lib/format'
import type { LineChartPoint, LineChartSeries } from '../../lib/charts'

const months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const shortMonths = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

/** Name of the interval that starts at `x`; the date is rearranged, never converted through a time zone. */
export function intervalName(x: string, interval: ReceiptInterval, short = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(x)
  if (!match) return x
  const [year, month] = [match[1], Number(match[2])]
  switch (interval) {
    case 'year': return year
    case 'quarter': return `${Math.ceil(month / 3)} кв. ${year}`
    case 'month': return `${(short ? shortMonths : months)[month - 1] ?? match[2]} ${year}`
    case 'week': return short ? formatPurchasedOn(x) : `неделя с ${formatPurchasedOn(x)}`
  }
}

function points(buckets: readonly ReceiptBucket[], pick: (bucket: ReceiptBucket) => Decimal | null, text: (value: Decimal) => string): LineChartPoint[] {
  return buckets.flatMap((bucket) => {
    const wire = pick(bucket)
    const value = decimalNumber(wire)
    return wire === null || value === null ? [] : [{ x: bucket.period_start, value, valueText: text(wire) }]
  })
}
export interface TrendCharts {
  /** Average and median receipt, in the block's currency. */
  receipts: LineChartSeries[]
  /** Product lines per receipt: the «quantity» side of the same story. */
  lines: LineChartSeries[]
}
/** One currency is one pair of panels; currencies are never drawn on a shared axis. */
export function trendCharts(block: ReceiptSeriesCurrency): TrendCharts {
  const money = (value: Decimal) => formatAmount(value, block.currency)
  return {
    receipts: [
      { key: 'avg', label: 'Средний чек', shortLabel: 'средний', points: points(block.buckets, (bucket) => bucket.avg_receipt, money) },
      { key: 'median', label: 'Медианный чек', shortLabel: 'медиана', points: points(block.buckets, (bucket) => bucket.median_receipt, money) },
    ],
    lines: [
      { key: 'lines', label: 'Позиций на чек', shortLabel: 'позиций', points: points(block.buckets, (bucket) => bucket.lines_per_receipt, (value) => formatQuantity(value)) },
    ],
  }
}
export const axisNumber = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
