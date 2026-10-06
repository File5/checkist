import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PriceSeries } from '../../api/price-series'
import { statsFixture } from '../../api/stats-test-support'
import { detail, history } from '../../api/test-support'
import type { ApiFailure } from '../../api/types'
import type { ProductQuery } from '../../navigation'
import PriceChart, { PriceChartView } from './PriceChart'
import ProductPage from './ProductPage'
import type { RequestState } from './state'
import * as requests from './useProductRequest'

const noop = () => {}
const fixture = (name: string) => statsFixture(`price-series-${name}.json`) as PriceSeries
const ok = (name: string): RequestState<PriceSeries> => ({ kind: 'ok', data: fixture(name) })
function view(state: RequestState<PriceSeries>, query: ProductQuery = { page: 1 }, extra: { similar?: boolean; hidden?: Record<string, string[]> } = {}) {
  return renderToStaticMarkup(<PriceChartView state={state} query={query} similar={extra.similar ?? true} hidden={extra.hidden}
    onPrice={noop} onInterval={noop} onSimilar={noop} onHidden={noop} retry={noop} reset={noop} />)
}
const count = (html: string, text: string) => html.split(text).length - 1
const checked = (html: string, value: string) => new RegExp(`<input type="radio" name="[^"]+" checked="" value="${value}"`).test(html)

afterEach(() => { vi.restoreAllMocks() })

describe('price chart block (SSR in Node, not browser acceptance)', () => {
  it('keeps the heading, the explanation and the switches in every state', () => {
    const states: RequestState<PriceSeries>[] = [{ kind: 'loading' }, { kind: 'error', reason: 'network' }, ok('empty'), ok('milk-paid')]
    for (const state of states) {
      const html = view(state)
      expect(html).toContain('<h2 id="product-chart-heading" tabindex="-1" data-request-focus-target="true">График цен</h2>')
      expect(html).toContain('aria-labelledby="product-chart-heading"')
      expect(html).toContain('<legend>Цена</legend>')
      expect(html).toContain('<legend>Интервал</legend>')
      expect(count(html, 'type="radio"')).toBe(5)
      expect(html).toContain('Показывать похожие товары')
      expect(html).toContain('график берёт только период')
    }
    expect(view({ kind: 'loading' })).toMatch(/<section[^>]*aria-busy="true"/)
    expect(view(ok('empty'))).toMatch(/<section[^>]*aria-busy="false"/)
  })
  it('reflects the modes of the address and the similar switch', () => {
    const defaults = view({ kind: 'loading' })
    expect(checked(defaults, 'paid') && checked(defaults, 'month')).toBe(true)
    expect(checked(defaults, 'normalized') || checked(defaults, 'week') || checked(defaults, 'day')).toBe(false)
    expect(defaults).toMatch(/<input type="checkbox" checked=""/)
    const other = view({ kind: 'loading' }, { page: 1, price: 'normalized', interval: 'week' }, { similar: false })
    expect(checked(other, 'normalized') && checked(other, 'week')).toBe(true)
    expect(other).not.toMatch(/<input type="checkbox" checked=""/)
  })
  it('loading: a local message, no chart', () => {
    const html = view({ kind: 'loading' })
    expect(html).toContain('Загружаем график цен…')
    expect(html).not.toContain('ck-line')
  })
  it('milk, paid: a panel per currency with the package warning, labelled series and a text table', () => {
    const html = view(ok('milk-paid'))
    expect(count(html, '<section class="product-chart-panel"')).toBe(2)
    expect(html).toContain('<h3 id="product-chart-EUR-pcs">EUR за шт</h3>')
    expect(html).toContain('<h3 id="product-chart-KZT-pcs">KZT за шт</h3>')
    expect(count(html, 'цена за штуку у похожих товаров может относиться к разным фасовкам')).toBe(2)
    expect(html).toContain('Zahlenfrisch · Musterstadt')
    expect(html).toContain('Demo Landmilch 3,5% 1L · DE')
    expect(html).toContain('Демо Молоко 2,5% 1 л · KZ')
    expect(html).toContain('похожий товар')
    expect(html).toContain('Вертикальная ось: EUR/шт.')
    expect(html).toContain('Вертикальная ось: KZT/шт.')
    expect(html).toContain('<caption>Цены, EUR/шт</caption>')
    expect(html).toContain('<th scope="row">сентябрь 2026</th>')
    expect(html).toContain('1,07 EUR/шт')
    expect(html).toContain('695 KZT/шт')
    expect(html).toContain('<th scope="col">Месяц</th>')
    // The legend is offered only where there is something to switch.
    expect(count(html, '<legend>Серии на графике</legend>')).toBe(1)
    expect(html).not.toContain('product-chart-notes')
  })
  it('milk, normalized: litres, no package warning', () => {
    const html = view(ok('milk-normalized'), { page: 1, price: 'normalized' })
    expect(html).toContain('<h3 id="product-chart-EUR-l">EUR за л</h3>')
    expect(html).toContain('<h3 id="product-chart-KZT-l">KZT за л</h3>')
    expect(html).not.toContain('фасовкам')
  })
  it('restores the series switched off on the page after a reload of the block', () => {
    const html = view(ok('milk-paid'), { page: 1 }, { hidden: { 'EUR:pcs': ['similar:2:DE'] } })
    const start = html.indexOf('<legend>Серии на графике</legend>')
    const legend = html.slice(start, html.indexOf('</fieldset>', start))
    expect(count(legend, 'type="checkbox"')).toBe(2)
    expect(count(legend, 'checked=""')).toBe(1)
  })
  it('explains unassigned, none and disabled; a week answer names its interval', () => {
    const unassigned = view(ok('unassigned'))
    expect(unassigned).toContain('<li class="product-chart-warning">Товар не отнесён к обобщённому продукту — назначьте его в админке')
    expect(count(unassigned, '<section class="product-chart-panel"')).toBe(1)
    expect(unassigned).not.toContain('фасовкам')
    const disabled = view(ok('similar-none'), { page: 1, interval: 'week' }, { similar: false })
    expect(disabled).toContain('<li>Похожие товары скрыты.')
    expect(disabled).toContain('<th scope="col">Неделя</th>')
    expect(disabled).toContain('неделя с ')
  })
  it('no observations: an empty state with the reason, notes kept, reset only with a period', () => {
    const filtered = view(ok('empty'), { page: 1, date_to: '2018-12-31' })
    expect(filtered).toContain('Нет наблюдений за выбранный период')
    expect(filtered).toContain('Сбросить фильтры</button>')
    expect(filtered).toContain('Других товаров обобщённого продукта «Молоко»')
    expect(filtered).not.toContain('ck-line')
    const bare = view(ok('empty'))
    expect(bare).toContain('Покупок этого товара пока нет')
    expect(bare).not.toContain('Сбросить фильтры')
  })
  it('draws a chart of similar products only and says so', () => {
    const data = fixture('milk-paid')
    const html = view({ kind: 'ok', data: { ...data, series: data.series.filter((line) => line.role === 'similar') } })
    expect(html).toContain('У этого товара нет своих покупок за выбранный период')
    expect(count(html, '<section class="product-chart-panel"')).toBe(2)
    expect(html).toContain('Магазинов с этим товаром: 0. Рядов похожих товаров: 1.')
  })
  it('reports truncation and skipped observations as warnings', () => {
    const html = view({ kind: 'ok', data: { ...fixture('milk-normalized'), own_truncated: true, skipped_without_normalized: 5 } })
    expect(html).toContain('<li class="product-chart-warning">Магазинов слишком много')
    expect(html).toContain('<li class="product-chart-warning">5 покупок этого товара без нормализованной цены')
  })
  it('errors: retry for transport, a larger interval for range_too_large, reset for 400, the catalog for not_found', () => {
    const failure = (value: Omit<ApiFailure, 'kind'>, query?: ProductQuery) => view({ kind: 'error', ...value }, query)
    for (const reason of ['network', 'timeout', 'server', 'invalid_response'] as const) {
      const html = failure({ reason })
      expect(html).toContain('data-request-retry="true"')
      expect(html).toContain('Повторить</button>')
    }
    const tooLarge = failure({ reason: 'range_too_large', status: 400 }, { page: 1, interval: 'day' })
    expect(tooLarge).toContain('Слишком много точек для графика')
    expect(tooLarge).toContain('Показать по месяцам</button>')
    expect(tooLarge).not.toContain('Повторить</button>')
    const tooLargeMonth = failure({ reason: 'range_too_large', status: 400 })
    expect(tooLargeMonth).toContain('Сократите период в фильтрах')
    expect(tooLargeMonth).not.toContain('Показать по месяцам')
    const invalid = failure({ reason: 'invalid_parameter', status: 400, fields: ['date_from'] })
    expect(invalid).toContain('Сбросить фильтры</button>')
    expect(invalid).not.toContain('Повторить</button>')
    const missing = failure({ reason: 'not_found', status: 404 })
    expect(missing).toContain('Данные не найдены')
    expect(missing).toContain('href="/catalog"')
    expect(missing).not.toContain('Повторить</button>')
  })
  it('owns its request: the first server snapshot is loading', () => {
    const html = renderToStaticMarkup(<PriceChart productId={1} query={{ page: 1 }} reset={noop} />)
    expect(html).toContain('Загружаем график цен…')
  })
})

describe('the chart inside the product card', () => {
  const summary = { product: history.product, group_by: 'store' as const, price: 'paid' as const, interval: 'none' as const, groups: [] }
  function card(chart: RequestState<PriceSeries>) {
    vi.spyOn(requests, 'useProductRequest')
      .mockReturnValueOnce({ state: { kind: 'ok', data: detail }, retry: noop })
      .mockReturnValueOnce({ state: { kind: 'ok', data: history }, retry: noop })
      .mockReturnValueOnce({ state: { kind: 'ok', data: summary }, retry: noop })
      .mockReturnValueOnce({ state: { kind: 'loading' }, retry: noop })
      .mockReturnValueOnce({ state: chart, retry: noop })
    return renderToStaticMarkup(<ProductPage productId={9} query={{ page: 1 }} />)
  }
  it('stands between the filters and the history table', () => {
    const html = card(ok('milk-paid'))
    const order = ['product-filters-heading', 'product-chart-heading', 'product-history-heading', 'product-summary-heading'].map((id) => html.indexOf(`id="${id}"`))
    expect(order.every((index) => index > 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    expect(html).toContain('EUR за шт')
  })
  it.each<[string, RequestState<PriceSeries>]>([
    ['a transport error', { kind: 'error', reason: 'network' }],
    ['range_too_large', { kind: 'error', reason: 'range_too_large', status: 400 }],
    ['not_found', { kind: 'error', reason: 'not_found', status: 404 }],
    ['loading', { kind: 'loading' }],
  ])('%s of the chart leaves the card, the history table and the summary in place', (_name, chart) => {
    const html = card(chart)
    expect(html).toContain(detail.name)
    expect(html).toContain('<caption>Наблюдения покупок из чеков</caption>')
    expect(html).toContain('Сводка по магазинам')
    expect(html).toContain('График цен')
    expect(html).not.toContain('Товар не найден')
  })
  it('is not offered for a missing product', () => {
    vi.spyOn(requests, 'useProductRequest').mockReturnValue({ state: { kind: 'error', reason: 'not_found', status: 404 }, retry: noop })
    expect(renderToStaticMarkup(<ProductPage productId={9} query={{ page: 1 }} />)).not.toContain('График цен')
  })
})
