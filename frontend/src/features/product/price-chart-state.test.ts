import { describe, expect, it } from 'vitest'
import { isPriceSeries } from '../../api/price-series-schema'
import type { OwnPriceSeries, PriceSeries, SimilarPriceSeries } from '../../api/price-series'
import { fixturesOf, statsFixture } from '../../api/stats-test-support'
import { buildRoute, parseRoute } from '../../navigation/routes'
import {
  chartFailureKind, chartInterval, chartNotes, chartPanels, chartPrice, emptyMessage, formatAxisValue, mixedPackagesWarning,
  periodFormats, pointText, priceSeriesParams, rangeTooLargeMessage, seriesLabel,
} from './price-chart-state'
import { withChartModes } from './state'

const fixture = (name: string) => statsFixture(`price-series-${name}.json`) as PriceSeries
const noteKeys = (data: PriceSeries) => chartNotes(data).map((note) => note.key)
const point = { period_start: '2026-09-01', count: 1, min: '1.0700', max: '1.0700', avg: '1.0700', last: '1.0700' }

describe('price chart request and address', () => {
  it('takes only the period from the card filters and always sends both modes', () => {
    expect(priceSeriesParams({ store: 7, country: 'DE', currency: 'EUR', date_from: '2025-01-01', date_to: '2026-09-30', page: 3 }, true))
      .toEqual({ date_from: '2025-01-01', date_to: '2026-09-30', interval: 'month', price: 'paid', similar: 'generic' })
    expect(priceSeriesParams({ price: 'normalized', interval: 'week', page: 1 }, false))
      .toEqual({ interval: 'week', price: 'normalized', similar: 'none' })
  })
  it('reads the defaults of an address without modes', () => {
    expect([chartPrice({ page: 1 }), chartInterval({ page: 1 })]).toEqual(['paid', 'month'])
    expect([chartPrice({ page: 1, price: 'normalized' }), chartInterval({ page: 1, interval: 'day' })]).toEqual(['normalized', 'day'])
  })
  it('keeps the chart modes when history filters are applied or reset, and drops the page', () => {
    const current = { store: 7, price: 'normalized' as const, interval: 'week' as const, page: 4 }
    expect(withChartModes({ country: 'DE', page: 9 }, current)).toEqual({ country: 'DE', price: 'normalized', interval: 'week', page: 1 })
    expect(withChartModes({ page: 1 }, { page: 2 })).toEqual({ page: 1 })
    const href = buildRoute({ kind: 'product', productId: 9, query: withChartModes({ date_from: '2026-01-01', page: 1 }, current) })
    expect(href).toBe('/catalog/products/9?date_from=2026-01-01&price=normalized&interval=week')
    expect(parseRoute(href)).toMatchObject({ kind: 'product', query: { price: 'normalized', interval: 'week' } })
  })
})

describe('panels of the backend fixtures', () => {
  it.each(fixturesOf('price-series-'))('%s: every series lands in exactly one panel of its currency and unit', (name) => {
    const data = statsFixture(name) as PriceSeries
    expect(isPriceSeries(data)).toBe(true)
    const panels = chartPanels(data)
    expect(panels.reduce((sum, panel) => sum + panel.series.length, 0)).toBe(data.series.length)
    expect(new Set(panels.map((panel) => panel.key)).size).toBe(panels.length)
    for (const panel of panels) {
      const lines = data.series.filter((line) => `${line.currency}:${line.unit}` === panel.key)
      expect(panel.series).toHaveLength(lines.length)
      expect(panel.own + panel.similar).toBe(lines.length)
      expect(new Set(panel.series.map((item) => item.key)).size).toBe(panel.series.length)
      panel.series.forEach((item, index) => {
        expect(item.points.map((entry) => entry.x)).toEqual(lines[index].points.map((entry) => entry.period_start))
        expect(item.points.map((entry) => entry.value)).toEqual(lines[index].points.map((entry) => Number(entry.avg)))
      })
    }
  })
  it('milk, paid: EUR and KZT never share an axis; the piece price of similar products is flagged', () => {
    const panels = chartPanels(fixture('milk-paid'))
    expect(panels.map((panel) => [panel.key, panel.title, panel.axisLabel, panel.own, panel.similar, panel.mixedPackages])).toEqual([
      ['EUR:pcs', 'EUR за шт', 'EUR/шт', 1, 1, true],
      ['KZT:pcs', 'KZT за шт', 'KZT/шт', 0, 1, true],
    ])
    expect(panels[0].series.map((item) => [item.key, item.label, item.note])).toEqual([
      ['own:1', 'Zahlenfrisch · Musterstadt', 'этот товар'],
      ['similar:2:DE', 'Demo Landmilch 3,5% 1L · DE', 'похожий товар'],
    ])
    expect(panels[1].series.map((item) => [item.key, item.label])).toEqual([['similar:3:KZ', 'Демо Молоко 2,5% 1 л · KZ']])
    expect(panels[0].series[0].points[0]).toEqual({ x: '2025-01-01', value: 1.05, valueText: '1,05 EUR/шт' })
    expect(panels[1].series[0].points[0].valueText).toBe('617,00 KZT/шт')
  })
  it('milk, normalized: litres are comparable, so there is no package warning', () => {
    const panels = chartPanels(fixture('milk-normalized'))
    expect(panels.map((panel) => [panel.key, panel.title, panel.mixedPackages])).toEqual([['EUR:l', 'EUR за л', false], ['KZT:l', 'KZT за л', false]])
  })
  it('apples, normalized: two own shops in one panel, the similar product of another country apart', () => {
    const panels = chartPanels(fixture('apples-normalized'))
    expect(panels.map((panel) => [panel.key, panel.own, panel.similar])).toEqual([['EUR:kg', 2, 0], ['KZT:kg', 0, 1]])
    expect(panels[0].series.map((item) => item.key)).toEqual(['own:1', 'own:2'])
    expect(panels[0].series[0].label).toMatch(/^Zahlenfrisch · /)
    expect(panels[0].series[1].label).toMatch(/^Beispielkorb · /)
  })
  it('an empty answer has no panels; own lines without similar ones carry no package warning', () => {
    expect(chartPanels(fixture('empty'))).toEqual([])
    expect(chartPanels(fixture('unassigned')).map((panel) => [panel.key, panel.own, panel.similar, panel.mixedPackages])).toEqual([['EUR:pcs', 2, 0, false]])
    expect(chartPanels(fixture('similar-none')).map((panel) => panel.mixedPackages)).toEqual([false])
  })
  it('splits one shop by unit and tells apart two points of one chain in one city by ID', () => {
    const data = fixture('unassigned')
    const [first, second] = data.series as OwnPriceSeries[]
    second.store = { ...first.store, id: 9 }
    const third: OwnPriceSeries = { ...first, unit: 'kg', points: [point] }
    const panels = chartPanels({ ...data, series: [first, second, third] })
    expect(panels.map((panel) => panel.key)).toEqual(['EUR:pcs', 'EUR:kg'])
    expect(panels[0].series.map((item) => item.label)).toEqual(['Zahlenfrisch · Musterstadt · ID 1', 'Zahlenfrisch · Musterstadt · ID 9'])
    expect(panels[1].series.map((item) => item.label)).toEqual(['Zahlenfrisch · Musterstadt'])
  })
})

describe('labels and texts', () => {
  it('labels own lines by shop and city and similar ones by product and country, with fallbacks', () => {
    const [own, similar] = fixture('milk-paid').series as [OwnPriceSeries, SimilarPriceSeries]
    expect(seriesLabel(own)).toBe('Zahlenfrisch · Musterstadt')
    expect(seriesLabel({ ...own, store: { ...own.store, name: ' ', city: '' } })).toBe('Не указано')
    expect(seriesLabel(similar)).toBe('Demo Landmilch 3,5% 1L · DE')
    expect(seriesLabel({ ...similar, product: { id: 2, name: '' } })).toBe('Не указано · DE')
  })
  it('names intervals in Russian without time zones', () => {
    expect([periodFormats.month.full('2026-09-01'), periodFormats.month.tick('2026-09-01'), periodFormats.month.header]).toEqual(['сентябрь 2026', 'сен 26', 'Месяц'])
    expect([periodFormats.week.full('2026-09-07'), periodFormats.week.tick('2026-09-07')]).toEqual(['неделя с 07.09.2026', '07.09.26'])
    expect([periodFormats.day.full('2026-01-31'), periodFormats.day.tick('2026-01-31')]).toEqual(['31.01.2026', '31.01.26'])
    expect(formatAxisValue(1.0725)).toBe('1,0725')
  })
  it('shows the spread of an interval next to its average', () => {
    expect(pointText(point, 'EUR', 'pcs')).toBe('1,07 EUR/шт')
    expect(pointText({ ...point, count: 3, min: '0.9900', max: '1.2000', avg: '1.0867' }, 'EUR', 'l')).toBe('1,09 EUR/л (мин. 0,99, макс. 1,20)')
  })
  it('explains every similar status of the fixtures', () => {
    expect(noteKeys(fixture('milk-paid'))).toEqual([])
    expect(chartNotes(fixture('unassigned'))).toEqual([{ key: 'generic_unassigned', tone: 'warning',
      text: 'Товар не отнесён к обобщённому продукту — назначьте его в админке, чтобы сравнивать с похожими товарами.' }])
    expect(chartNotes(fixture('empty'))).toEqual([{ key: 'none', tone: 'info',
      text: 'Других товаров обобщённого продукта «Молоко» с покупками за выбранный период нет — сравнивать не с чем.' }])
    expect(chartNotes(fixture('similar-none'))).toEqual([{ key: 'disabled', tone: 'info',
      text: 'Похожие товары скрыты. Включите «Показывать похожие товары», чтобы сравнить цены.' }])
  })
  it('reports truncation, skipped observations, a partial list and a chart of similar products only', () => {
    const data = fixture('milk-normalized')
    const similarOnly = { ...data, series: data.series.filter((line) => line.role === 'similar') }
    expect(noteKeys(similarOnly)).toEqual(['similar_only'])
    const full = { ...similarOnly, own_truncated: true, skipped_without_normalized: 21, similar: { status: 'ok' as const, products_total: 12, products_shown: 8 } }
    expect(noteKeys(full)).toEqual(['similar_only', 'similar_limited', 'own_truncated', 'skipped_without_normalized'])
    const texts = chartNotes(full).map((note) => note.text)
    expect(texts[1]).toBe('Показаны 8 из 12 похожих товаров — с наибольшим числом покупок.')
    expect(texts[3]).toMatch(/^21 покупка этого товара без нормализованной цены на график не попала\./)
    expect(chartNotes({ ...data, skipped_without_normalized: 3 })[0].text).toMatch(/^3 покупки .* не попали\./)
    expect(chartNotes({ ...data, skipped_without_normalized: 11 })[0].text).toMatch(/^11 покупок .* не попали\./)
    expect(chartNotes({ ...data, skipped_without_normalized: 11 })[0].tone).toBe('warning')
    expect(mixedPackagesWarning).toContain('цена за штуку у похожих товаров может относиться к разным фасовкам')
  })
  it('classifies refusals and words the empty and too-large states', () => {
    expect(chartFailureKind({ kind: 'error', reason: 'range_too_large', status: 400 })).toBe('range_too_large')
    expect(chartFailureKind({ kind: 'error', reason: 'not_found', status: 404 })).toBe('not_found')
    expect(chartFailureKind({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['date_from'] })).toBe('parameters')
    for (const reason of ['network', 'timeout', 'invalid_response', 'server'] as const) expect(chartFailureKind({ kind: 'error', reason })).toBe('retry')
    expect(rangeTooLargeMessage('day')).toContain('Выберите интервал крупнее')
    expect(rangeTooLargeMessage('month')).not.toContain('интервал крупнее')
    expect(emptyMessage({ page: 1, date_to: '2018-12-31' }, 'paid')).toBe('Нет наблюдений за выбранный период')
    expect(emptyMessage({ page: 1 }, 'normalized')).toBe('Нет наблюдений с нормализованной ценой')
    expect(emptyMessage({ page: 1 }, 'paid')).toContain('Покупок этого товара пока нет')
  })
})
