/** Named purchases of manual spends (2026-10-13): their prices are marked «вручную», a spend without a place is
 * «Без места», and «Что купили» is a row of the spend form. Vitest/SSR, not browser visual acceptance. */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isPriceSeries } from '../../api/price-series-schema'
import type { OwnPriceSeries, PriceSeries } from '../../api/price-series'
import { isPriceHistory, isProduct } from '../../api/schema'
import { history, point, product } from '../../api/test-support'
import { statsFixture } from '../../api/stats-test-support'
import ProductList, { ProductRows } from '../catalog/ProductList'
import { emptyDraft, newLine } from '../expense/expense-form'
import { ExpenseForm } from '../expense/ExpensePage'
import { chartPanels, seriesKey, seriesLabel } from './price-chart-state'
import PriceHistory from './PriceHistory'
import PriceHistoryCards from './PriceHistoryCards'
import { storeLabel } from './state'

const noop = () => {}
const manualPoint = { ...point, store: null, manual: true, paid_unit_price: '225.0000', list_unit_price: '225.0000', currency: 'USD' }
const manualProduct = { ...product, prices: [{ country: null, currency: 'USD', observations: 1,
  last: { paid_unit_price: '225.0000', normalized_price: null, normalized_unit: null, comparable: false, purchased_on: '2026-10-01',
    store_id: null, manual: true } }] }

describe('a manual price in the answers', () => {
  it('passes the schemas without a place', () => {
    expect(isPriceHistory({ ...history, results: [manualPoint] })).toBe(true)
    expect(isProduct(manualProduct)).toBe(true)
    expect(isProduct({ ...manualProduct, prices: [{ ...manualProduct.prices[0], last: { ...manualProduct.prices[0].last, manual: 'yes' } }] }))
      .toBe(false)
    const series = statsFixture('price-series-unassigned.json') as PriceSeries
    const [own] = series.series as OwnPriceSeries[]
    const placeless = { ...own, store: null, country: null, manual: true }
    expect(isPriceSeries({ ...series, series: [placeless] })).toBe(true)
    // A series without a place has no country either; one with a place keeps the country of its store.
    expect(isPriceSeries({ ...series, series: [{ ...placeless, country: 'DE' }] })).toBe(false)
    expect(isPriceSeries({ ...series, series: [{ ...own, manual: undefined }] })).toBe(false)
  })
})

describe('«вручную» and «Без места» on the screens', () => {
  it('marks the history row and the card of a typed price', () => {
    const table = renderToStaticMarkup(<PriceHistory state={{ kind: 'ok', data: { ...history, results: [manualPoint, point] } }}
      query={{ page: 1 }} stores={[]} retry={noop} reset={noop} buildPageHref={(page) => ({ kind: 'product', productId: 9, query: { page } })} />)
    expect(table).toContain('<th scope="row">Без места</th>')
    expect(table.match(/product-manual">вручную</g)).toHaveLength(1)
    const cards = renderToStaticMarkup(<PriceHistoryCards points={[manualPoint]} stores={new Map()}
      columns={{ store: 'М', date: 'Д', list: 'Л', paid: 'П', normalized: 'Н', purchase: 'Покупка' }} caption="c" label="l" />)
    expect(cards).toContain('Без места')
    expect(cards).toContain('product-manual">вручную</span>')
    expect(storeLabel(null)).toBe('Без места')
  })
  it('names a chart series of typed prices apart from the receipts of the same place', () => {
    const series = statsFixture('price-series-unassigned.json') as PriceSeries
    const [own] = series.series as OwnPriceSeries[]
    const typed = { ...own, manual: true }
    const placeless = { ...own, store: null, country: null, manual: true }
    expect(seriesLabel(typed)).toBe(`${seriesLabel(own)} · вручную`)
    expect(seriesLabel(placeless)).toBe('Без места · вручную')
    expect(new Set([own, typed, placeless].map(seriesKey)).size).toBe(3)
    const [panel] = chartPanels({ ...series, series: [own, placeless] })
    expect(panel.series.map((line) => line.label)).toContain('Без места · вручную')
  })
  it('marks the last price of a product in the catalogue', () => {
    expect(renderToStaticMarkup(<ProductList products={[manualProduct]} />)).toContain('Без места · <time dateTime="2026-10-01">')
    expect(renderToStaticMarkup(<ProductList products={[manualProduct]} />)).toContain(' · вручную</span>')
    expect(renderToStaticMarkup(<ProductRows products={[manualProduct]} />)).toContain(' · вручную</span>')
    expect(renderToStaticMarkup(<ProductList products={[product]} />)).not.toContain('вручную')
  })
})

describe('«Что купили» in the spend form', () => {
  const chips = [{ id: 1, name: 'Подписки', path: [{ id: 1, name: 'Подписки' }], parent_id: null, depth: 0, children_count: 0,
    generic_products_count: 0, products_count: 0, products_total: 0 }]
  const form = (draft = emptyDraft('KZT', '2026-10-13'), kind: 'spend' | 'income' = 'spend') => renderToStaticMarkup(
    <ExpenseForm draft={draft} chips={chips} errors={{}} saving={false} onChange={noop} onSubmit={noop} kind={kind} />)
  it('is a row of a spend without positions and says what it becomes', () => {
    const html = form({ ...emptyDraft('KZT', '2026-10-13'), item: 'Подписка Claude Max 20x' })
    expect(html).toContain('<span class="expense-row-label">Что купили</span>')
    expect(html).toMatch(/<input id="expense-item" class="expense-row-input" [^>]*aria-describedby="expense-item-note" value="Подписка Claude Max 20x"/)
    expect(html).toContain('Станет товаром каталога с ценой «вручную».')
    expect(form()).toContain('станет товаром каталога.')
  })
  it('is not there with positions and for an income', () => {
    expect(form({ ...emptyDraft('KZT', '2026-10-13'), lines: [{ ...newLine(), name: 'Хлеб', amount: '250' }] })).not.toContain('expense-item')
    expect(form(emptyDraft('KZT', '2026-10-13'), 'income')).not.toContain('expense-item')
  })
})
