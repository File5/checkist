import { afterEach, describe, expect, it, vi } from 'vitest'
import { getProductPrices, getProductPriceSummary } from '../../api/prices'
import { getStores } from '../../api/stores'
import { detail, history, pageOf, storeEntry } from '../../api/test-support'
import type { ApiResult, PriceHistory, PriceSummary } from '../../api/types'
import { buildRoute, parseRoute } from '../../navigation/routes'
import { createRequest, errorMessage, fieldMessages, filterDraft, filterOptions, hasFilters, historyParams, mergeStores, serverFieldErrors, storeLabel, storeParams, summaryParams, validateFilters } from './state'

afterEach(() => { vi.unstubAllGlobals() })

describe('product filters and URL state', () => {
  it('round-trips all applied filters and resets an old page', () => {
    const draft = { store: '7', country: 'de', currency: 'eur', date_from: '2024-02-29', date_to: '2026-10-04' }
    const result = validateFilters(draft)
    expect(result.errors).toEqual({})
    expect(result.query).toEqual({ store: 7, country: 'DE', currency: 'EUR', date_from: '2024-02-29', date_to: '2026-10-04', page: 1 })
    const href = buildRoute({ kind: 'product', productId: 9, query: result.query })
    expect(parseRoute(href)).toEqual({ kind: 'product', productId: 9, query: result.query })
    expect(href).not.toContain('page=')
  })
  it('rejects reversed ranges and nonexistent calendar dates before any request', () => {
    const reversed = validateFilters({ ...filterDraft({ page: 9 }), date_from: '2026-10-05', date_to: '2026-10-04' })
    expect(Object.keys(reversed.errors)).toEqual(['date_from', 'date_to'])
    expect(validateFilters({ ...filterDraft({ page: 1 }), date_from: '2025-02-29' }).errors).toHaveProperty('date_from')
    expect(validateFilters({ ...filterDraft({ page: 1 }), date_to: '2026-13-01' }).errors).toHaveProperty('date_to')
  })
  it('rejects unsafe store IDs, control characters and malformed codes', () => {
    expect(validateFilters({ ...filterDraft({ page: 1 }), store: '9007199254740993' }).errors).toHaveProperty('store')
    expect(validateFilters({ ...filterDraft({ page: 1 }), country: 'D\nE', currency: 'EURO' }).errors).toEqual({ country: fieldMessages.country, currency: fieldMessages.currency })
  })
  it('reset removes every filter; a later history page is not an active filter', () => {
    expect(validateFilters(filterDraft({ page: 20 }))).toEqual({ query: { page: 1 }, errors: {} })
    expect(hasFilters({ page: 20 })).toBe(false)
    expect(hasFilters({ page: 1, store: 7 })).toBe(true)
  })
  it('offers all countries and currencies from the card, independently of the history page', () => {
    const product = { ...detail, prices: [...detail.prices, { ...detail.prices[0], country: 'RU', currency: 'RUB' }, ...detail.prices] }
    expect(filterOptions(product)).toEqual({ countries: ['DE', 'RU'], currencies: ['EUR', 'RUB'] })
    expect(history.results.every((point) => point.currency === 'EUR')).toBe(true)
  })
  it('marks only named known server fields, and allows correction before resubmission', () => {
    const applied = filterDraft({ page: 1, store: 7, country: 'DE' })
    const failure = { kind: 'error' as const, reason: 'invalid_parameter' as const, status: 400, fields: ['store', 'country', 'private_field'] }
    expect(serverFieldErrors([failure], applied, applied)).toEqual({ store: fieldMessages.store, country: fieldMessages.country })
    expect(serverFieldErrors([failure], { ...applied, store: '', country: 'RU' }, applied)).toEqual({})
  })
  it('uses safe UI translations and distinguishes page out of range from not found', () => {
    expect(errorMessage({ kind: 'error', reason: 'page_out_of_range' })).toContain('первую страницу')
    expect(errorMessage({ kind: 'error', reason: 'not_found' })).toContain('каталог')
    expect(errorMessage({ kind: 'error', reason: 'server' })).toContain('ошибки сервера')
  })
})

describe('API request construction using the real F1 adapters with mocked fetch', () => {
  it('uses identical filters, descending history and an unpaginated paid/store summary', async () => {
    const summary: PriceSummary = { product: history.product, price: 'paid', group_by: 'store', interval: 'none', groups: [] }
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(history), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(summary), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const query = { store: 7, country: 'DE', currency: 'EUR', date_from: '2026-01-01', date_to: '2026-10-04', page: 3 }
    expect((await getProductPrices(9, historyParams(query), { baseUrl: '/api' })).kind).toBe('ok')
    expect((await getProductPriceSummary(9, summaryParams(query), { baseUrl: '/api' })).kind).toBe('ok')
    const urls = fetchMock.mock.calls.map(([url]) => new URL(url, 'http://checkist.local'))
    expect(urls[0].pathname).toBe('/api/products/9/prices/')
    expect(urls[0].searchParams.get('ordering')).toBe('-observed_at')
    expect(urls[0].searchParams.get('page')).toBe('3')
    expect(urls[1].pathname).toBe('/api/products/9/prices/summary/')
    expect(Object.fromEntries(urls[1].searchParams)).toEqual({ store: '7', country: 'DE', currency: 'EUR', date_from: '2026-01-01', date_to: '2026-10-04', group_by: 'store', price: 'paid', interval: 'none' })
    for (const field of ['store', 'country', 'currency', 'date_from', 'date_to']) expect(urls[0].searchParams.get(field)).toBe(urls[1].searchParams.get(field))
  })
  it('searches and paginates the complete store directory without product or currency parameters', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(pageOf([storeEntry])), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await getStores(storeParams('DE', 'Магазин & улица', 2), { baseUrl: '/api' })
    const url = new URL(fetchMock.mock.calls[0][0], 'http://checkist.local')
    expect(url.pathname).toBe('/api/stores/')
    expect(Object.fromEntries(url.searchParams)).toEqual({ country: 'DE', q: 'Магазин & улица', page: '2', page_size: '50' })
  })
})

describe('store enrichment and fallback', () => {
  it('merges by ID while retaining distinct points of the same network', () => {
    const other = { ...storeEntry, id: 8, address: 'Учебная улица, 2' }
    const merged = mergeStores([storeEntry, other], [{ ...storeEntry, address: 'Новый адрес' }])
    expect(merged).toHaveLength(2)
    expect(merged[0].address).toBe('Новый адрес')
    expect(merged[1].id).toBe(8)
  })
  it('retains name/city/country when address and timezone are unavailable', () => {
    expect(storeLabel({ id: 7, name: 'Магазин', city: 'Берлин', country: 'DE' })).toBe('Магазин · Берлин · DE')
    expect(storeLabel({ id: 7, name: '', city: '', country: 'DE' })).toBe('Не указано · DE')
  })
})

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

describe('independent request lifecycle (Node; no browser)', () => {
  it('drops old success and error even when a loader ignores abort', async () => {
    const first = pending<ApiResult<string>>()
    const second = pending<ApiResult<string>>()
    const third = pending<ApiResult<string>>()
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => { signals.push(signal); return [first, second, third][signals.length - 1].promise })
    const request = createRequest(load)
    request.run(); await flush()
    request.run(); await flush()
    expect(signals[0].aborted).toBe(true)
    second.resolve({ kind: 'ok', data: 'new' }); await flush()
    first.resolve({ kind: 'error', reason: 'server' }); await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'new' })
    request.run(); await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'loading' })
    request.dispose()
    third.resolve({ kind: 'ok', data: 'late after leaving' }); await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'loading' })
    expect(signals[2].aborted).toBe(true)
  })
  it('does not load after cleanup and safely restarts in StrictMode', async () => {
    const load = vi.fn().mockResolvedValue({ kind: 'ok', data: 'strict' })
    const request = createRequest<string>(load)
    request.run(); request.dispose(); await flush()
    expect(load).not.toHaveBeenCalled()
    request.run(); await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'strict' })
    request.dispose()
  })
  it('keeps the product and history after a summary/store failure and supports local retry', async () => {
    const product = createRequest(async () => ({ kind: 'ok' as const, data: detail }))
    const historyRequest = createRequest<PriceHistory>(async () => ({ kind: 'ok', data: history }))
    const summaryLoader = vi.fn().mockResolvedValueOnce({ kind: 'error', reason: 'timeout' }).mockResolvedValueOnce({ kind: 'ok', data: 'summary' })
    const summary = createRequest<string>(summaryLoader)
    const directory = createRequest(async () => ({ kind: 'error' as const, reason: 'network' as const }))
    product.run(); historyRequest.run(); summary.run(); directory.run(); await flush()
    expect(product.getSnapshot().kind).toBe('ok')
    expect(historyRequest.getSnapshot().kind).toBe('ok')
    expect(summary.getSnapshot()).toEqual({ kind: 'error', reason: 'timeout' })
    expect(directory.getSnapshot()).toEqual({ kind: 'error', reason: 'network' })
    summary.run(); expect(summary.getSnapshot()).toEqual({ kind: 'loading' }); await flush()
    expect(summary.getSnapshot()).toEqual({ kind: 'ok', data: 'summary' })
    expect(product.getSnapshot().kind).toBe('ok')
    for (const request of [product, historyRequest, summary, directory]) request.dispose()
  })
  it('drops an explicit aborted result and converts thrown transport errors safely', async () => {
    const load = vi.fn().mockResolvedValueOnce({ kind: 'aborted' }).mockRejectedValueOnce(new Error('private error'))
    const request = createRequest(load)
    request.run(); await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'loading' })
    request.run(); await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'error', reason: 'network' })
    request.dispose()
  })
})
