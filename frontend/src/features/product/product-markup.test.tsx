import { renderToStaticMarkup } from 'react-dom/server'
import { isValidElement } from 'react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detail, history, pageOf, point, store, total } from '../../api/test-support'
import type { ApiFailure, ApiResult, Page, PriceSummary as SummaryData, Store, StoreEntry } from '../../api/types'
import PriceHistory from './PriceHistory'
import PriceSummary from './PriceSummary'
import ProductPage from './ProductPage'
import StoreFilter from './StoreFilter'
import * as requests from './useProductRequest'

const noop = () => {}
const buildPageHref = (page: number) => ({ kind: 'product' as const, productId: 9, query: { country: 'DE', currency: 'EUR', page } })

afterEach(() => { vi.restoreAllMocks() })

const firstFiftyStores = Array.from({ length: 50 }, (_, index) => ({
  ...detail.stores[0], id: index + 1, name: 'Same Chain', city: 'Berlin', address: `Example Street ${index + 1}`,
}))
const laterPoints = [51, 52].map((id) => ({
  ...point, receipt_id: id, store: { id, name: 'Same Chain', city: 'Berlin', country: 'DE' },
}))
const laterHistory = { ...history, count: 52, page: 2, page_size: 50, pages: 2, results: laterPoints }
const rowLabels = (html: string) => [...html.matchAll(/<th scope="row">([^<]+)<\/th>/g)].map((match) => match[1])

function renderLaterProduct(stores: Store[], directory: ApiResult<Page<StoreEntry>>, summaryFailure?: ApiFailure) {
  const summary: SummaryData = { product: history.product, group_by: 'store', price: 'paid', interval: 'none',
    groups: stores.map((store) => ({ store, currency: 'EUR', unit: 'pcs', total, buckets: [] })) }
  vi.spyOn(requests, 'useProductRequest')
    .mockReturnValueOnce({ state: { kind: 'ok', data: { ...detail, stores: firstFiftyStores } }, retry: noop })
    .mockReturnValueOnce({ state: { kind: 'ok', data: laterHistory }, retry: noop })
    .mockReturnValueOnce({ state: summaryFailure ?? { kind: 'ok', data: summary }, retry: noop })
    .mockReturnValueOnce({ state: directory.kind === 'aborted' ? { kind: 'loading' } : directory, retry: noop })
  return renderToStaticMarkup(<ProductPage productId={9} query={{ page: 2 }} />)
}

describe('store identities beyond the first 50 (SSR in Node)', () => {
  it('returns to the receipt during loading, on not_found and after product loading', () => {
    vi.spyOn(requests, 'useProductRequest').mockReturnValue({ state: { kind: 'loading' }, retry: noop })
    expect(renderToStaticMarkup(<ProductPage productId={9} query={{ page: 1 }} returnTo="/receipts/71" />))
      .toContain('href="/receipts/71">К чеку')
    vi.mocked(requests.useProductRequest).mockReturnValue({ state: { kind: 'error', reason: 'not_found' }, retry: noop })
    const missing = renderToStaticMarkup(<ProductPage productId={9} query={{ page: 1 }} returnTo="/receipts/71" />)
    expect(missing).toContain('href="/receipts/71">К чеку')
    vi.mocked(requests.useProductRequest).mockReturnValue({ state: { kind: 'loading' }, retry: noop })
    vi.mocked(requests.useProductRequest).mockReturnValueOnce({ state: { kind: 'ok', data: detail }, retry: noop })
    expect(renderToStaticMarkup(<ProductPage productId={9} query={{ page: 1 }} returnTo="/receipts/71" />))
      .toContain('href="/receipts/71">К чеку')
  })
  it('distinguishes identical chain/city/country points on the second history page without enrichment', () => {
    const html = renderToStaticMarkup(<PriceHistory state={{ kind: 'ok', data: laterHistory }} query={{ page: 2 }}
      stores={firstFiftyStores} retry={noop} reset={noop} buildPageHref={buildPageHref} />)
    const labels = rowLabels(html)
    expect(labels).toHaveLength(2)
    expect(labels[0]).not.toBe(labels[1])
    expect(labels).toEqual([51, 52].map((id) => `ID ${id} · Same Chain · Berlin · DE · адрес неизвестен`))
    expect(html).toContain('Наблюдений: 52')
  })
  it('keeps the card, both history rows and summary when the directory fails, with distinct fallback labels', () => {
    const html = renderLaterProduct(laterPoints.map(({ store }) => ({ ...store, address: '', timezone: '' })),
      { kind: 'error', reason: 'network' })
    const labels = rowLabels(html)
    expect(labels).toEqual([51, 52].map((id) => `ID ${id} · Same Chain · Berlin · DE · адрес неизвестен`))
    expect(labels[0]).not.toBe(labels[1])
    expect(html).toContain(detail.name)
    expect(html).toContain('Сводка по магазинам')
    for (const label of labels) expect(html).toContain(`<h3>${label}</h3>`)
    expect(html).toMatch(/<select id="product-store"[^>]*disabled=""/)
    expect(html).toContain('Фильтр магазина недоступен')
    expect(html).toContain('Не удалось загрузить справочник магазинов')
  })
  it('enriches later history by ID from the full summary stores', () => {
    const stores = laterPoints.map(({ store }) => ({ ...store, address: `Example Street ${store.id}`, timezone: 'Europe/Berlin' }))
    const html = renderLaterProduct(stores, { kind: 'ok', data: pageOf(firstFiftyStores.map((store) => ({ ...store, receipts_count: 1 }))) })
    const labels = rowLabels(html)
    expect(labels).toEqual(stores.map((store) => `ID ${store.id} · Same Chain · ${store.address} · Berlin · DE`))
    for (const label of labels) expect(html).toContain(`<h3>${label}</h3>`)
    expect(html).not.toContain('адрес неизвестен')
    expect(html).not.toContain('UTC')
  })
  it('keeps distinct history even when both summary and directory fail', () => {
    const html = renderLaterProduct([], { kind: 'error', reason: 'network' }, { kind: 'error', reason: 'server', status: 500 })
    const labels = rowLabels(html)
    expect(labels).toEqual([51, 52].map((id) => `ID ${id} · Same Chain · Berlin · DE · адрес неизвестен`))
    expect(html).toContain(detail.name)
    expect(html).toContain('Не удалось загрузить данные из-за ошибки сервера')
    expect(html).toContain('Фильтр магазина недоступен')
  })
  it('keeps the selected brief store recognizable when the directory fails and its ID is outside the options', () => {
    vi.spyOn(requests, 'useProductRequest').mockReturnValue({ state: { kind: 'error', reason: 'network' }, retry: noop })
    const html = renderToStaticMarkup(<StoreFilter country="DE" value="51" initial={firstFiftyStores}
      known={firstFiftyStores} selected={laterPoints[0].store} onChange={noop} onStores={noop} />)
    expect(html).toContain('<option value="51" selected="">ID 51 · Same Chain · Berlin · DE · адрес неизвестен</option>')
    expect(html).toMatch(/<select id="product-store"[^>]*disabled=""/)
    expect(html).toContain('Убрать магазин')
  })
  it('uses the same full store label for selected and available filter options, including an empty address', () => {
    const stores = laterPoints.map(({ store }, index) => ({ ...store, address: index === 0 ? 'Example Street 51' : '', timezone: 'Europe/Berlin' }))
    vi.spyOn(requests, 'useProductRequest').mockReturnValue({ state: { kind: 'ok', data: pageOf([{ ...stores[1], receipts_count: 1 }]) }, retry: noop })
    const html = renderToStaticMarkup(<StoreFilter country="DE" value="51" initial={firstFiftyStores}
      known={stores} onChange={noop} onStores={noop} />)
    expect(html).toContain('<option value="51" selected="">ID 51 · Same Chain · Example Street 51 · Berlin · DE</option>')
    expect(html).toContain('<option value="52">ID 52 · Same Chain · Berlin · DE · адрес неизвестен</option>')
  })
})

describe('price content and semantic markup (SSR in Node, not browser acceptance)', () => {
  it('renders position zero and gives every receipt/position pair a distinct React row key', () => {
    const data = { ...history, ...pageOf([
      { ...point, position: 0, paid_unit_price: '2.0000' },
      { ...point, position: 1, paid_unit_price: '3.0000' },
      { ...point, receipt_id: 13, position: 0, paid_unit_price: '4.0000' },
    ], 200) }
    let view: ReactNode = null
    function Capture() {
      view = PriceHistory({ state: { kind: 'ok', data }, query: { page: 1 }, stores: [],
        retry: noop, reset: noop, buildPageHref })
      return view
    }
    const html = renderToStaticMarkup(<Capture />)
    expect(rowLabels(html)).toHaveLength(3)
    for (const price of ['2', '3', '4']) expect(html).toContain(`${price}\u00a0EUR/шт`)
    const keys: string[] = []
    function collectRowKeys(node: ReactNode) {
      if (Array.isArray(node)) node.forEach(collectRowKeys)
      else if (isValidElement<{ children?: ReactNode }>(node)) {
        if (node.type === 'tr' && node.key !== null) keys.push(String(node.key))
        collectRowKeys(node.props.children)
      }
    }
    collectRowKeys(view)
    expect(keys).toEqual(['12:0', '12:1', '13:0'])
    expect(new Set(keys).size).toBe(3)
  })
  it('renders row prices, unknown normalization, UTC fallback and a keyboard scroll region', () => {
    const html = renderToStaticMarkup(<PriceHistory state={{ kind: 'ok', data: history }} query={{ page: 1 }} stores={[]} retry={noop} reset={noop} buildPageHref={buildPageHref} />)
    expect(html).toContain('<caption>Наблюдения покупок из чеков</caption>')
    expect(html.match(/scope="col"/g)).toHaveLength(6)
    expect(html).toContain('scope="row"')
    expect(html).toContain('role="region" aria-label="История цен по магазинам"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('Нет данных для пересчёта')
    expect(html).toContain('Не сопоставимо с базовой единицей товара')
    expect(html).toContain('-1,05 EUR/шт')
    expect(html).toContain('04.10.2026')
    expect(html).toContain('UTC')
    expect(html).toContain('Учебный магазин · DE')
  })
  it('uses store ID for address/timezone and the actual normalized unit, including metres', () => {
    const data = { ...history, results: [{ ...point, normalized_price: '12.3456', normalized_unit: 'm' as const }] }
    const html = renderToStaticMarkup(<PriceHistory state={{ kind: 'ok', data }} query={{ page: 1 }} stores={[store]} retry={noop} reset={noop} buildPageHref={buildPageHref} />)
    expect(html).toContain('Учебная улица, 1')
    expect(html).toContain('12,3456 EUR/м')
    expect(html).not.toContain('UTC')
  })
  it('distinguishes no purchases from no matches and offers page recovery', () => {
    const data = { ...history, results: [], count: 0, pages: 0 }
    const base = { stores: [], retry: noop, reset: noop, buildPageHref }
    const noPurchases = renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'ok', data }} query={{ page: 1 }} />)
    const noMatches = renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'ok', data }} query={{ page: 1, currency: 'RUB' }} />)
    expect(noPurchases).toContain('Покупок этого товара пока нет')
    expect(noMatches).toContain('Нет записей по выбранным фильтрам')
    expect(noMatches).toContain('Сбросить фильтры')
    const missingPage = renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'error', reason: 'page_out_of_range', status: 404 }} query={{ page: 999 }} />)
    expect(missingPage).toContain('На первую страницу')
    expect(missingPage).toContain('href="/catalog/products/9?country=DE&amp;currency=EUR"')
    expect(missingPage).not.toContain('Товар не найден')
  })
  it('preserves currency/unit/store summary groups and nullable change; displays server totals', () => {
    const data: SummaryData = { product: history.product, group_by: 'store', price: 'paid', interval: 'none', groups: [
      { store, currency: 'EUR', unit: 'pcs', total: { ...total, count: 123 }, buckets: [] },
      { store, currency: 'RUB', unit: 'kg', total, buckets: [] },
      { store: { ...store, id: 8, address: 'Учебная улица, 2' }, currency: 'EUR', unit: 'pcs', total: { ...total, change_percent: '-5.25' }, buckets: [] },
    ] }
    const html = renderToStaticMarkup(<PriceSummary state={{ kind: 'ok', data }} retry={noop} reset={noop} />)
    expect(html.match(/<li /g)).toHaveLength(3)
    expect(html).toContain('EUR / шт')
    expect(html).toContain('RUB / кг')
    expect(html).toContain('Учебная улица, 2')
    expect(html).toContain('123')
    expect(html).toContain('Нет данных для расчёта')
    expect(html).toContain('-5,25 %')
    expect(html).toContain('03.10.2026')
    expect(html).toContain('04.10.2026')
  })
  it('offers correction/reset for HTTP 400 and local retry for a transport error', () => {
    const correction = renderToStaticMarkup(<PriceSummary state={{ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['currency'] }} retry={noop} reset={noop} />)
    expect(correction).toContain('Исправьте отмеченные фильтры')
    expect(correction).toContain('Сбросить фильтры')
    expect(correction).not.toContain('Повторить</button>')
    const retry = renderToStaticMarkup(<PriceSummary state={{ kind: 'error', reason: 'network' }} retry={noop} reset={noop} />)
    expect(retry).toContain('Повторить</button>')
  })
  it('fits the F2 shell contract and declares all four independent loading blocks', () => {
    const html = renderToStaticMarkup(<ProductPage productId={9} query={{ page: 1 }} />)
    expect(html).not.toContain('<h1')
    expect(html).not.toContain('<main')
    for (const text of ['Загружаем карточку товара', 'Загружаем историю покупок', 'Загружаем сводку цен', 'Загружаем справочник магазинов']) expect(html).toContain(text)
    expect(html).toContain('Налоговая база цен не указана')
    expect(html).toContain('Скидка всего чека не распределена')
    expect(html).toContain('for="product-date_from"')
    expect(html).toContain('<label for="product-store-search">Найти магазин по названию или городу</label>')
  })
})
