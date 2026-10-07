import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProductPriceSeries } from './price-series'
import { statsFailureKind } from './stats'
import { fixturesOf, statsErrorFixtures, statsFixture } from './stats-test-support'
import type { PriceSeries } from './price-series'
import type { ApiFailure } from './types'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const response = (name: string, status = 200) => json(statsFixture(name), status)
const failure = (code: string, status: number) => json({ error: { code, message: 'private' } }, status)
const urls = () => fetchMock.mock.calls.map(([url]) => url)
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

describe('product price series', () => {
  it.each(fixturesOf('price-series-'))('returns %s exactly as the server sent it', async (name) => {
    fetchMock.mockResolvedValue(response(name))
    expect(await getProductPriceSeries(1)).toEqual({ kind: 'ok', data: statsFixture(name) })
  })
  it('is an open request: no cookies, the trailing slash and an explicit prefix', async () => {
    fetchMock.mockResolvedValue(response('price-series-milk-paid.json'))
    await getProductPriceSeries(1, {}, { baseUrl: '/other/' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/other/products/1/prices/series/', { headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store', signal: expect.any(AbortSignal) })
  })
  it('keeps prices as strings and similar series without a store', async () => {
    fetchMock.mockResolvedValue(response('price-series-milk-normalized.json'))
    const result = await getProductPriceSeries(1, { price: 'normalized' })
    const data = (result as { data: PriceSeries }).data
    expect(data.series.map((line) => [line.role, line.store?.id ?? null, line.unit, line.comparable]).slice(0, 2)).toEqual([['own', 1, 'l', true], ['similar', null, 'l', true]])
    expect(data.series[0].points[0]).toEqual({ period_start: '2025-01-01', count: 3, min: '1.0500', max: '1.0500', avg: '1.0500', last: '1.0500' })
  })
  it('does not fetch for a pre-aborted caller and reports a later abort as aborted', async () => {
    const aborted = new AbortController(); aborted.abort()
    expect(await getProductPriceSeries(1, {}, { signal: aborted.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = getProductPriceSeries(1, {}, { signal: controller.signal })
    await Promise.resolve(); controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('times out a stalled response at 15 seconds and releases the timer', async () => {
    vi.useFakeTimers(); fetchMock.mockImplementation(() => new Promise(() => {}))
    const pending = getProductPriceSeries(1)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('price series query', () => {
  beforeEach(() => { fetchMock.mockImplementation(async () => response('price-series-empty.json')) })
  it('sends nothing for absent and empty parameters', async () => {
    await getProductPriceSeries(1)
    await getProductPriceSeries(1, { date_from: '', date_to: '', country: [], currency: '', interval: undefined, price: undefined, similar: undefined, similar_limit: undefined })
    expect(urls()).toEqual(['/api/products/1/prices/series/', '/api/products/1/prices/series/'])
  })
  it('sends every parameter once, countries as one comma-separated value', async () => {
    await getProductPriceSeries(6, {
      date_from: '2026-01-01', date_to: '2026-09-30', country: ['DE', 'KZ'], currency: 'EUR',
      interval: 'week', price: 'normalized', similar: 'none', similar_limit: 20,
    })
    const url = new URL(urls()[0] as string, 'http://localhost')
    expect(url.pathname).toBe('/api/products/6/prices/series/')
    expect([...url.searchParams]).toEqual([
      ['date_from', '2026-01-01'], ['date_to', '2026-09-30'], ['country', 'DE,KZ'], ['currency', 'EUR'],
      ['interval', 'week'], ['price', 'normalized'], ['similar', 'none'], ['similar_limit', '20'],
    ])
    expect(urls()[0]).toContain('country=DE%2CKZ')
  })
  it('sends a single country without a comma', async () => {
    await getProductPriceSeries(1, { country: ['KZ'], interval: 'day' })
    expect(urls()).toEqual(['/api/products/1/prices/series/?country=KZ&interval=day'])
  })
  it.each([
    ['a zero product', () => getProductPriceSeries(0), ['productId']],
    ['a fractional product', () => getProductPriceSeries(1.5), ['productId']],
    ['an unsafe product', () => getProductPriceSeries(Number.MAX_SAFE_INTEGER + 1), ['productId']],
    ['a zero similar limit', () => getProductPriceSeries(1, { similar_limit: 0 }), ['similar_limit']],
  ] as const)('refuses %s locally without a request', async (_, call, fields) => {
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_parameter', fields })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('price series failures', () => {
  it('reads the not_found fixture of an unknown or merged product', async () => {
    const expected = statsErrorFixtures['error-not-found.json']
    fetchMock.mockResolvedValue(response('error-not-found.json', expected.status))
    const result = await getProductPriceSeries(999999)
    expect(result).toEqual({ kind: 'error', ...expected })
    expect(statsFailureKind(result as ApiFailure)).toBe('not_found')
  })
  it('reads invalid_parameter with field names and range_too_large from the fixtures', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'invalid_parameter', message: 'private', fields: { interval: ['bad'], similar_limit: ['bad'] } } }, 400))
    expect(await getProductPriceSeries(1)).toEqual({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['interval', 'similar_limit'] })
    fetchMock.mockResolvedValueOnce(response('error-range-too-large.json', 400))
    const result = await getProductPriceSeries(1, { interval: 'day' })
    expect(result).toEqual({ kind: 'error', reason: 'range_too_large', status: 400 })
    expect(statsFailureKind(result as ApiFailure)).toBe('range_too_large')
  })
  it.each([
    ['an internal error', () => failure('internal_error', 500), { reason: 'server', status: 500 }, 'unavailable'],
    // The open endpoint has no local mode: these codes are not part of its contract.
    ['a permission error', () => response('error-permission-denied.json', 403), { reason: 'invalid_response', status: 403 }, 'invalid_response'],
    ['an unavailable database code', () => failure('database_unavailable', 503), { reason: 'invalid_response', status: 503 }, 'invalid_response'],
    ['a proxy without backend', () => new Response('Bad Gateway', { status: 502 }), { reason: 'invalid_response', status: 502 }, 'invalid_response'],
  ] as const)('tells apart %s', async (_, reply, expected, kind) => {
    fetchMock.mockImplementation(async () => reply())
    const result = await getProductPriceSeries(1)
    expect(result).toEqual({ kind: 'error', ...expected })
    expect(statsFailureKind(result as ApiFailure)).toBe(kind)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('reports a network failure without repeating the request', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    const result = await getProductPriceSeries(1)
    expect(result).toEqual({ kind: 'error', reason: 'network' })
    expect(statsFailureKind(result as ApiFailure)).toBe('unavailable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it.each([
    ['a body of another endpoint', () => statsFixture('series-year.json')],
    ['an own series without store', () => { const body = statsFixture('price-series-milk-paid.json') as PriceSeries; (body.series[0] as { store: unknown }).store = null; return body }],
    ['a numeric price', () => { const body = statsFixture('price-series-milk-paid.json') as PriceSeries; (body.series[0].points[0] as { avg: unknown }).avg = 1.07; return body }],
  ])('rejects %s as an invalid response', async (_, body) => {
    fetchMock.mockResolvedValue(json(body()))
    expect(await getProductPriceSeries(1)).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
})
