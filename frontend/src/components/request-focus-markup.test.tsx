import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { category, categoryDetail, detail, history, pageOf, product, store } from '../api/test-support'
import type { CatalogRoute } from '../navigation'
import CatalogPage from '../features/catalog/CatalogPage'
import CategoryPage from '../features/catalog/CategoryPage'
import ProductsSection from '../features/catalog/ProductsSection'
import * as catalogRequests from '../features/catalog/use-catalog-request'
import PriceHistory from '../features/product/PriceHistory'
import PriceSummary from '../features/product/PriceSummary'
import ProductPage from '../features/product/ProductPage'
import StoreFilter from '../features/product/StoreFilter'
import * as productRequests from '../features/product/useProductRequest'
import RequestState from './RequestState'

const noop = () => {}
const route: CatalogRoute = { kind: 'catalog', query: { page: 1 } }
const buildPageHref = (page: number) => ({ kind: 'product' as const, productId: 9, query: { page } })
const loading = { kind: 'loading' as const }
const failure = { kind: 'error' as const, reason: 'network' as const }
const targets = (html: string) => [...html.matchAll(/<(h2|legend)\b([^>]*)>/g)]
  .filter((match) => match[2].includes('data-request-focus-target="true"'))
afterEach(() => vi.restoreAllMocks())

describe('stable local focus targets (SSR/Node, not interactive focus)', () => {
  it.each([loading, failure, { kind: 'ok' as const, data: pageOf([product]) }])('keeps the products target and exactly one status region for $kind', (state) => {
    const html = renderToStaticMarkup(<ProductsSection route={route} state={state} onRetry={noop} />)
    expect(targets(html)).toHaveLength(1)
    expect(targets(html)[0][2]).toContain('tabindex="-1"')
    expect(html).toContain(`aria-busy="${state.kind === 'loading'}"`)
    expect(html.match(/aria-live="polite"|role="status"/g)).toHaveLength(1)
    if (state.kind === 'error') expect(html).toContain('data-request-retry="true"')
  })
  it.each([loading, failure, { kind: 'ok' as const, data: history }])('keeps history and summary headings focusable for $kind', (state) => {
    const historyHtml = renderToStaticMarkup(<PriceHistory state={state} query={{ page: 1 }} stores={[]}
      retry={noop} reset={noop} buildPageHref={buildPageHref} />)
    const summaryState = state.kind === 'ok' ? { kind: 'ok' as const,
      data: { product: history.product, group_by: 'store' as const, price: 'paid' as const, interval: 'none' as const, groups: [] } } : state
    const summaryHtml = renderToStaticMarkup(<PriceSummary state={summaryState} retry={noop} reset={noop} />)
    for (const html of [historyHtml, summaryHtml]) {
      expect(targets(html)).toHaveLength(1)
      expect(targets(html)[0][2]).toContain('tabindex="-1"')
      expect(html).toContain(`aria-busy="${state.kind === 'loading'}"`)
      expect(html.match(/aria-live="polite"|role="status"/g)).toHaveLength(1)
      if (state.kind === 'error') expect(html).toContain('data-request-retry="true"')
    }
  })
  it.each([loading, failure, { kind: 'ok' as const, data: pageOf([store]) }])('keeps the store legend and input mounted for $kind', (state) => {
    vi.spyOn(productRequests, 'useProductRequest').mockReturnValue({ state, retry: noop })
    const html = renderToStaticMarkup(<StoreFilter country="" value="" initial={[]} onChange={noop} onStores={noop} />)
    expect(targets(html)).toHaveLength(1)
    expect(targets(html)[0][1]).toBe('legend')
    expect(targets(html)[0][2]).toContain('tabindex="-1"')
    expect(html).toContain('id="product-store-search" type="search"')
    expect(html.match(/aria-live="polite"|role="status"/g)).toHaveLength(1)
    if (state.kind === 'error') expect(html).toContain('data-request-retry="true"')
  })
  it.each([loading, failure, { kind: 'ok' as const, data: categoryDetail }])('keeps category and tree headings for $kind without including the product request in their scopes', (state) => {
    vi.spyOn(catalogRequests, 'useCatalogRequest')
      .mockReturnValueOnce({ state, retry: noop }).mockReturnValueOnce({ state: loading, retry: noop })
    const html = renderToStaticMarkup(<CategoryPage categoryId={2} query={{ page: 1 }} />)
    const section = html.match(/<section[^>]*aria-labelledby="ck-catalog-category-heading"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(targets(section)).toHaveLength(1)
    expect(targets(section)[0][2]).toContain('tabindex="-1"')
    expect(section).not.toContain('Загружаем товары')
    vi.spyOn(catalogRequests, 'useCatalogRequest')
      .mockReturnValueOnce({ state: state.kind === 'ok' ? { kind: 'ok', data: pageOf([category]) } : state, retry: noop })
      .mockReturnValueOnce({ state: loading, retry: noop })
    const treeHtml = renderToStaticMarkup(<CatalogPage query={{ page: 1 }} />)
    expect(treeHtml).toMatch(/<h2 id="ck-catalog-categories-heading"[^>]*tabindex="-1"/)
    expect(targets(treeHtml)).toHaveLength(2) // Tree and products have separate targets.
  })
  it.each([loading, failure, { kind: 'ok' as const, data: detail }, { kind: 'error' as const, reason: 'not_found' as const }])('keeps the card target for $kind/$reason including not_found after retry', (state) => {
    vi.spyOn(productRequests, 'useProductRequest')
      .mockReturnValueOnce({ state, retry: noop }).mockReturnValue({ state: loading, retry: noop })
    const html = renderToStaticMarkup(<ProductPage productId={9} query={{ page: 1 }} />)
    const card = html.match(/<section[^>]*aria-labelledby="product-heading"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ''
    expect(targets(card)).toHaveLength(1)
    expect(targets(card)[0][2]).toContain('tabindex="-1"')
    expect(card).not.toContain('Загружаем историю')
    expect(card.match(/aria-live="polite"/g)?.length ?? 0).toBe(state.kind === 'ok' ? 0 : 1)
    if (state.kind === 'error' && state.reason === 'not_found') expect(card.match(/<a /g)).toHaveLength(1)
  })
  it('marks retry without adding a second live region', () => {
    const html = renderToStaticMarkup(<RequestState kind="error" onRetry={noop} />)
    expect(html).toContain('data-request-retry="true"')
    expect(html.match(/aria-live="polite"/g)).toHaveLength(1)
  })
})
