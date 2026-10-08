import type { PriceSeries, PriceSeriesInterval, PriceSeriesKind, PriceSeriesLine, PriceSeriesParams, PriceSeriesPoint } from '../../api/price-series'
import type { ApiFailure, CurrencyCode, Unit } from '../../api/types'
import { chartNumber } from '../../lib/charts'
import type { LineChartPoint, LineChartSeries } from '../../lib/charts'
import { formatAxisTick } from '../../lib/charts/scale'
import { formatPrice, formatPurchasedOn, formatUnit } from '../../lib/format'
import type { ProductQuery } from '../../navigation/routes'
import { counted } from '../merges/labels'

/** Chart modes of the card address; an absent value is the default. */
export const chartPrice = (query: ProductQuery): PriceSeriesKind => query.price ?? 'paid'
export const chartInterval = (query: ProductQuery): PriceSeriesInterval => query.interval ?? 'month'

export const priceOptions: { value: PriceSeriesKind; label: string }[] = [
  { value: 'paid', label: 'За единицу в чеке' },
  { value: 'normalized', label: 'За кг / л / шт' },
]
export const intervalOptions: { value: PriceSeriesInterval; label: string }[] = [
  { value: 'month', label: 'Месяц' },
  { value: 'week', label: 'Неделя' },
  { value: 'day', label: 'День' },
]

/**
 * Only the period comes from the card filters: the endpoint has no store filter, and a country or currency
 * filter would remove the similar products of other countries the chart exists to compare with.
 */
export function priceSeriesParams(query: ProductQuery, similar: boolean): PriceSeriesParams {
  return { ...(query.date_from && { date_from: query.date_from }), ...(query.date_to && { date_to: query.date_to }),
    interval: chartInterval(query), price: chartPrice(query), similar: similar ? 'generic' : 'none' }
}

export const hasPeriod = (query: ProductQuery) => Boolean(query.date_from || query.date_to)

const months = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const shortDate = (x: string) => `${x.slice(8, 10)}.${x.slice(5, 7)}.${x.slice(2, 4)}`
const monthOf = (x: string) => months[Number(x.slice(5, 7)) - 1]

/** Full and axis names of an interval by its `period_start`; calendar dates are rearranged without time zones. */
export const periodFormats: Record<PriceSeriesInterval, { full: (x: string) => string; tick: (x: string) => string; header: string }> = {
  month: { full: (x) => (monthOf(x) ? `${monthOf(x)} ${x.slice(0, 4)}` : x), tick: (x) => (monthOf(x) ? `${monthOf(x).slice(0, 3)} ${x.slice(2, 4)}` : x), header: 'Месяц' },
  week: { full: (x) => `неделя с ${formatPurchasedOn(x)}`, tick: shortDate, header: 'Неделя' },
  day: { full: formatPurchasedOn, tick: shortDate, header: 'День' },
}

/** Divisions of the price axis: whole or with two decimals, the same for every division of one axis. */
export const formatAxisValue = (value: number, step?: number) => formatAxisTick(value, step, true)

const named = (value: string) => value.trim() || 'Не указано'
const bare = (value: string) => formatPrice(value, '').trim()

/** The line follows the average of the interval; a spread inside the interval is spelled out next to it. */
export function pointText(point: PriceSeriesPoint, currency: CurrencyCode, unit: Unit): string {
  const average = formatPrice(point.avg, currency, unit)
  return point.min === point.max ? average : `${average} (мин. ${bare(point.min)}, макс. ${bare(point.max)})`
}

function chartPoints(line: PriceSeriesLine): LineChartPoint[] {
  return line.points.flatMap((point) => {
    const value = chartNumber(point.avg)
    return value === null ? [] : [{ x: point.period_start, value, valueText: pointText(point, line.currency, line.unit) }]
  })
}

/** Own: shop and city. Similar: product name and country. */
export function seriesLabel(line: PriceSeriesLine): string {
  return line.role === 'own'
    ? [named(line.store.name), line.store.city.trim()].filter(Boolean).join(' · ')
    : `${named(line.product.name)} · ${line.country}`
}
export const seriesKey = (line: PriceSeriesLine) => line.role === 'own' ? `own:${line.store.id}` : `similar:${line.product.id}:${line.country}`

export interface ChartPanel {
  /** `EUR:pcs` — one axis never mixes currencies or units. */
  key: string
  currency: CurrencyCode
  unit: Unit
  /** «EUR за шт» */
  title: string
  /** «EUR/шт» */
  axisLabel: string
  series: LineChartSeries[]
  own: number
  similar: number
  /** A similar line is not in the base unit of the generic product: its price may belong to another package. */
  mixedPackages: boolean
}

/** One panel per «currency, unit» in the order of the answer: panels with the product itself come first. */
export function chartPanels(data: PriceSeries): ChartPanel[] {
  const groups = new Map<string, PriceSeriesLine[]>()
  for (const line of data.series) {
    const key = `${line.currency}:${line.unit}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  }
  return [...groups].map(([key, lines]) => {
    const labels = lines.map(seriesLabel)
    const repeated = (label: string) => labels.filter((other) => other === label).length > 1
    const series = lines.map((line, index): LineChartSeries => ({
      key: seriesKey(line),
      // Two points of one chain in one city stay apart by the same ID the history table shows.
      label: line.role === 'own' && repeated(labels[index]) ? `${labels[index]} · ID ${line.store.id}` : labels[index],
      note: line.role === 'own' ? 'этот товар' : 'похожий товар',
      points: chartPoints(line),
    })).filter((item) => item.points.length > 0)
    const { currency, unit } = lines[0]
    return { key, currency, unit, title: `${currency} за ${formatUnit(unit)}`, axisLabel: `${currency}/${formatUnit(unit)}`, series,
      own: lines.filter((line) => line.role === 'own').length, similar: lines.filter((line) => line.role === 'similar').length,
      mixedPackages: lines.some((line) => line.role === 'similar' && !line.comparable) }
  }).filter((panel) => panel.series.length > 0)
}

export const mixedPackagesWarning = 'Цены в этой панели не приведены к базовой единице обобщённого продукта: '
  + 'цена за штуку у похожих товаров может относиться к разным фасовкам.'

export interface ChartNote { key: string; tone: 'info' | 'warning'; text: string }

/** Explanations the answer obliges the screen to show, in a fixed order. */
export function chartNotes(data: PriceSeries): ChartNote[] {
  const notes: ChartNote[] = []
  const { similar } = data
  if (data.series.length > 0 && data.series.every((line) => line.role === 'similar')) {
    notes.push({ key: 'similar_only', tone: 'info', text: 'У этого товара нет своих покупок за выбранный период — на графике только похожие товары.' })
  }
  if (similar.status === 'generic_unassigned') {
    notes.push({ key: 'generic_unassigned', tone: 'warning',
      text: 'Товар не отнесён к обобщённому продукту — назначьте его в админке, чтобы сравнивать с похожими товарами.' })
  } else if (similar.status === 'none') {
    const generic = data.generic.name.trim()
    notes.push({ key: 'none', tone: 'info',
      text: `Других товаров ${generic ? `обобщённого продукта «${generic}»` : 'того же обобщённого продукта'} с покупками за выбранный период нет — сравнивать не с чем.` })
  } else if (similar.status === 'disabled') {
    notes.push({ key: 'disabled', tone: 'info', text: 'Похожие товары скрыты. Включите «Показывать похожие товары», чтобы сравнить цены.' })
  } else if (similar.products_shown < similar.products_total) {
    notes.push({ key: 'similar_limited', tone: 'info',
      text: `Показаны ${similar.products_shown.toLocaleString('ru-RU')} из ${counted(similar.products_total, 'похожего товара', 'похожих товаров', 'похожих товаров')} — с наибольшим числом покупок.` })
  }
  if (data.own_truncated) {
    notes.push({ key: 'own_truncated', tone: 'warning',
      text: 'Магазинов слишком много: показаны 20 рядов этого товара с наибольшим числом покупок. Остальные есть в таблице истории.' })
  }
  if (data.skipped_without_normalized > 0) {
    notes.push({ key: 'skipped_without_normalized', tone: 'warning',
      text: `${counted(data.skipped_without_normalized, 'покупка', 'покупки', 'покупок')} этого товара без нормализованной цены на график не `
        + `${data.skipped_without_normalized % 10 === 1 && data.skipped_without_normalized % 100 !== 11 ? 'попала' : 'попали'}. Они видны в режиме «За единицу в чеке» и в таблице истории.` })
  }
  return notes
}

export type ChartFailureKind = 'range_too_large' | 'not_found' | 'parameters' | 'retry'

export function chartFailureKind(failure: ApiFailure): ChartFailureKind {
  if (failure.reason === 'range_too_large') return 'range_too_large'
  if (failure.reason === 'not_found') return 'not_found'
  return failure.status === 400 ? 'parameters' : 'retry'
}

export const rangeTooLargeMessage = (interval: PriceSeriesInterval) => interval === 'month'
  ? 'Слишком много точек для графика (больше 1000). Сократите период в фильтрах.'
  : 'Слишком много точек для графика (больше 1000). Выберите интервал крупнее или сократите период в фильтрах.'

export const emptyMessage = (query: ProductQuery, price: PriceSeriesKind) => hasPeriod(query)
  ? 'Нет наблюдений за выбранный период'
  : price === 'normalized' ? 'Нет наблюдений с нормализованной ценой' : 'Покупок этого товара пока нет — график появится после первой покупки'
