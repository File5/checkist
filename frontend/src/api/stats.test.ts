import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getReceiptCompare, getReceiptSeries, getSpending, listParam, omitEmpty, statsFailureKind } from './stats'
import { statsErrorFixtures, statsFixture } from './stats-test-support'
import type { ReceiptCompareParams } from './stats'
import type { ApiFailure, LocalApiFailure, LocalApiResult, RequestOptions } from './types'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const response = (name: string, status = 200) => json(statsFixture(name), status)
const failure = (code: string, status: number, fields?: object) => json({ error: { code, message: 'private', ...(fields && { fields }) } }, status)
const urls = () => fetchMock.mock.calls.map(([url]) => url)
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

const periods: ReceiptCompareParams = { base_from: '2020-01-01', base_to: '2020-12-31', current_from: '2026-01-01', current_to: '2026-09-30' }
const periodsQuery = 'base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-09-30'
type Call = (options?: RequestOptions) => Promise<LocalApiResult<unknown>>
const readers: [string, Call, string, string][] = [
  ['stats/spending/', (o) => getSpending({}, o), 'spending-category.json', 'series-year.json'],
  ['stats/receipts/series/', (o) => getReceiptSeries({}, o), 'series-year.json', 'compare-2020-2026.json'],
  [`stats/receipts/compare/?${periodsQuery}`, (o) => getReceiptCompare(periods, o), 'compare-2020-2026.json', 'spending-category.json'],
]

describe.each(readers)('GET %s', (path, call, fixture, foreign) => {
  it('validates the backend fixture using same-origin credentials, the trailing slash and an explicit prefix', async () => {
    fetchMock.mockResolvedValue(response(fixture))
    expect(await call({ baseUrl: '/other/' })).toEqual({ kind: 'ok', data: statsFixture(fixture) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(`/other/${path}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) })
  })
  it('does not fetch for a pre-aborted caller and reports a later abort as aborted', async () => {
    const aborted = new AbortController(); aborted.abort()
    expect(await call({ signal: aborted.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const controller = new AbortController()
    const pending = call({ signal: controller.signal })
    await Promise.resolve(); controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })
  it('times out a stalled response at 15 seconds and releases the timer', async () => {
    vi.useFakeTimers(); fetchMock.mockImplementation(() => new Promise(() => {}))
    const pending = call()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a body of another endpoint and a spoiled body as an invalid response', async () => {
    fetchMock.mockResolvedValueOnce(response(foreign))
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
    const spoiled = statsFixture(fixture) as { currencies: { currency: unknown }[] }
    spoiled.currencies[0].currency = 978
    fetchMock.mockResolvedValueOnce(json(spoiled))
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 200 }))
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
  it.each([
    ['the local mode switched off', () => response('error-permission-denied.json', 403), { reason: 'permission_denied', status: 403 }, 'permission_denied'],
    ['a range that is too large', () => response('error-range-too-large.json', 400), { reason: 'range_too_large', status: 400 }, 'range_too_large'],
    ['an unavailable database', () => failure('database_unavailable', 503), { reason: 'database_unavailable', status: 503 }, 'unavailable'],
    ['an internal error', () => failure('internal_error', 500), { reason: 'server', status: 500 }, 'unavailable'],
    ['a proxy without backend', () => new Response('Bad Gateway', { status: 502 }), { reason: 'invalid_response', status: 502 }, 'invalid_response'],
    ['an unknown error code', () => failure('teapot', 418), { reason: 'invalid_response', status: 418 }, 'invalid_response'],
    ['an error body without message', () => json({ error: { code: 'permission_denied' } }, 403), { reason: 'invalid_response', status: 403 }, 'invalid_response'],
  ] as const)('tells apart %s', async (_, reply, expected, kind) => {
    fetchMock.mockImplementation(async () => reply())
    const result = await call()
    expect(result).toEqual({ kind: 'error', ...expected })
    expect(statsFailureKind(result as LocalApiFailure)).toBe(kind)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('reports a network failure without repeating the request', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'))
    const result = await call()
    expect(result).toEqual({ kind: 'error', reason: 'network' })
    expect(statsFailureKind(result as LocalApiFailure)).toBe('unavailable')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('error fixtures of the backend', () => {
  it('spending keeps the names of all rejected parameters and none of the server texts', async () => {
    const expected = statsErrorFixtures['error-invalid-parameter.json']
    fetchMock.mockResolvedValue(response('error-invalid-parameter.json', expected.status))
    const result = await getSpending({ date_from: '2026-13-01', country: 'de1', currency: 'E', store: [99], limit: 60 })
    expect(result).toEqual({ kind: 'error', ...expected })
    expect(JSON.stringify(result)).not.toMatch(/[А-я]/)
    expect(statsFailureKind(result as LocalApiFailure)).toBe('invalid_parameter')
  })
  it.each(['error-required-parameter.json', 'error-periods-overlap.json'])('comparison reads %s', async (name) => {
    const expected = statsErrorFixtures[name]
    fetchMock.mockResolvedValue(response(name, expected.status))
    const result = await getReceiptCompare({ ...periods, base_to: '2026-01-01' })
    expect(result).toEqual({ kind: 'error', ...expected })
    expect(statsFailureKind(result as LocalApiFailure)).toBe('invalid_parameter')
  })
  it.each(Object.entries(statsErrorFixtures))('%s is read at its status and at no other', async (name, expected) => {
    fetchMock.mockImplementation(async () => response(name, expected.status))
    expect(await getReceiptSeries()).toEqual({ kind: 'error', ...expected })
    fetchMock.mockImplementation(async () => response(name, 409))
    expect(await getReceiptSeries()).toEqual({ kind: 'error', reason: 'invalid_response', status: 409 })
  })
  it('rejects malformed fields instead of guessing', async () => {
    fetchMock.mockImplementation(async () => failure('invalid_parameter', 400, { date_from: 'bad' }))
    expect(await getSpending()).toEqual({ kind: 'error', reason: 'invalid_response', status: 400 })
  })
})

describe('query', () => {
  beforeEach(() => { fetchMock.mockImplementation(async () => response('spending-empty.json')) })
  it('sends nothing for absent and empty parameters', async () => {
    await getSpending()
    await getSpending({ date_from: '', date_to: '', country: '', currency: '', store: [], group_by: undefined, category: undefined, generic: undefined, limit: undefined })
    await getReceiptSeries({ date_from: '', country: '', store: [], interval: undefined })
    expect(urls()).toEqual(['/api/stats/spending/', '/api/stats/spending/', '/api/stats/receipts/series/'])
  })
  it('sends every spending parameter once, stores as one comma-separated value', async () => {
    await getSpending({
      date_from: '2026-01-01', date_to: '2026-09-30', country: 'DE', currency: 'EUR', store: [1, 2, 3],
      group_by: 'product', category: 2, generic: 1, limit: 3,
    })
    const url = new URL(urls()[0] as string, 'http://localhost')
    expect(url.pathname).toBe('/api/stats/spending/')
    expect([...url.searchParams]).toEqual([
      ['date_from', '2026-01-01'], ['date_to', '2026-09-30'], ['country', 'DE'], ['currency', 'EUR'], ['store', '1,2,3'],
      ['group_by', 'product'], ['category', '2'], ['generic', '1'], ['limit', '3'],
    ])
    expect(urls()[0]).toContain('store=1%2C2%2C3')
  })
  it('reads the category of the filter in `parent` under a grouping other than category', async () => {
    fetchMock.mockImplementation(async () => response('spending-category-generic.json'))
    const result = await getSpending({ category: 1, group_by: 'generic', currency: 'EUR' })
    expect(urls()).toEqual(['/api/stats/spending/?currency=EUR&group_by=generic&category=1'])
    expect(result).toEqual({ kind: 'ok', data: statsFixture('spending-category-generic.json') })
    expect(result).toMatchObject({ data: { group_by: 'generic', parent: { id: 1, name: 'Продукты питания' } } })
  })
  it('sends a single store without a comma and keeps a one-sided period', async () => {
    await getSpending({ store: [7], date_to: '2018-12-31' })
    expect(urls()).toEqual(['/api/stats/spending/?date_to=2018-12-31&store=7'])
  })
  it('sends the interval and the filters of the visit series', async () => {
    fetchMock.mockImplementation(async () => response('series-month.json'))
    await getReceiptSeries({ interval: 'quarter', currency: 'EUR', date_from: '2026-01-01', date_to: '2026-09-30', country: 'DE', store: [2, 1] })
    expect(urls()).toEqual(['/api/stats/receipts/series/?date_from=2026-01-01&date_to=2026-09-30&country=DE&currency=EUR&store=2%2C1&interval=quarter'])
  })
  it('sends the four dates of the comparison with its filters and limit', async () => {
    fetchMock.mockImplementation(async () => response('compare-empty.json'))
    await getReceiptCompare({ ...periods, country: 'KZ', currency: 'KZT', store: [3], limit: 5 })
    await getReceiptCompare({ ...periods, country: '', currency: '', store: [] })
    expect(urls()).toEqual([`/api/stats/receipts/compare/?${periodsQuery}&country=KZ&currency=KZT&store=3&limit=5`, `/api/stats/receipts/compare/?${periodsQuery}`])
  })
  it('leaves a missing mandatory date to the server, which names it in fields', async () => {
    fetchMock.mockImplementation(async () => response('error-required-parameter.json', 400))
    const result = await getReceiptCompare({ ...periods, base_from: '', current_to: '' })
    expect(urls()).toEqual(['/api/stats/receipts/compare/?base_to=2020-12-31&current_from=2026-01-01'])
    expect(result).toMatchObject({ reason: 'invalid_parameter', fields: ['base_from', 'base_to', 'current_from', 'current_to'] })
  })
  it('encodes values exactly once', async () => {
    await getSpending({ country: 'D&E', currency: 'E U' })
    expect(urls()).toEqual(['/api/stats/spending/?country=D%26E&currency=E+U'])
  })
  it.each([
    ['a fractional category', () => getSpending({ category: 1.5 }), ['category']],
    ['a zero generic product', () => getSpending({ generic: 0 }), ['generic']],
    ['an unsafe limit', () => getSpending({ limit: Number.MAX_SAFE_INTEGER + 1 }), ['limit']],
    ['a zero limit and a negative store', () => getSpending({ limit: 0, store: [1, -2] }), ['limit', 'store']],
    ['an unsafe store', () => getReceiptSeries({ store: [Number.MAX_SAFE_INTEGER + 1] }), ['store']],
    ['a store that is not a number', () => getReceiptCompare({ ...periods, store: [Number.NaN] }), ['store']],
    ['a fractional comparison limit', () => getReceiptCompare({ ...periods, limit: 2.5 }), ['limit']],
  ] as const)('refuses %s locally without a request', async (_, call, fields) => {
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_parameter', fields })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('prefers the abort of the caller to a local refusal', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await getSpending({ store: [0] }, { signal: controller.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('helpers', () => {
  it('joins lists and drops only what the server treats as absent', () => {
    expect([listParam(undefined), listParam([]), listParam([5]), listParam(['DE', 'KZ']), listParam([1, 2])]).toEqual([undefined, undefined, '5', 'DE,KZ', '1,2'])
    expect(omitEmpty({ a: '', b: undefined, c: 0, d: false, e: 'x' })).toEqual({ c: 0, d: false, e: 'x' })
  })
  it.each([
    ['invalid_parameter', 'invalid_parameter'], ['range_too_large', 'range_too_large'], ['permission_denied', 'permission_denied'],
    ['not_found', 'not_found'], ['network', 'unavailable'], ['timeout', 'unavailable'], ['server', 'unavailable'],
    ['database_unavailable', 'unavailable'], ['invalid_response', 'invalid_response'], ['csrf_failed', 'invalid_response'],
    ['method_not_allowed', 'invalid_response'], ['page_out_of_range', 'invalid_response'],
  ] as const)('classifies %s as %s', (reason, kind) => {
    const failed: ApiFailure | LocalApiFailure = { kind: 'error', reason }
    expect(statsFailureKind(failed)).toBe(kind)
  })
})
