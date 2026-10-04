import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCategories, getCategory, getGenericProduct, getGenericProducts, getProduct, getProducts } from './catalog'
import { apiUrl } from './http'
import { getProductPrices, getProductPriceSummary } from './prices'
import { getStores } from './stores'
import { category, categoryDetail, detail, generic, history, pageOf, product, storeEntry, summary } from './test-support'
import type { ApiResult, RequestOptions } from './types'

const fetchMock = vi.fn<typeof fetch>()
function reply(body: unknown, status = 200) { fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status })) }
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const adapters: [string, (options?: RequestOptions) => Promise<ApiResult<unknown>>, unknown][] = [
  ['categories/', (options) => getCategories({}, options), { results: [category] }],
  ['categories/2/', (options) => getCategory(2, options), categoryDetail],
  ['generic-products/', (options) => getGenericProducts({}, options), pageOf([generic])],
  ['generic-products/5/', (options) => getGenericProduct(5, options), generic],
  ['products/', (options) => getProducts({}, options), pageOf([product])],
  ['products/9/', (options) => getProduct(9, options), detail],
  ['products/9/prices/', (options) => getProductPrices(9, {}, options), history],
  ['products/9/prices/summary/', (options) => getProductPriceSummary(9, {}, options), summary],
  ['stores/', (options) => getStores({}, options), pageOf([storeEntry])],
]

describe('common URL transport', () => {
  it.each([
    ['/api', '/api/products/'], ['/api/', '/api/products/'], [' /api/// ', '/api/products/'],
    ['/api//v1/', '/api/v1/products/'], ['/', '/products/'],
    ['http://127.0.0.1:18000/api///', 'http://127.0.0.1:18000/api/products/'],
  ])('normalizes base %s', (base, expected) => { expect(apiUrl(base, 'products/')).toBe(expected) })
  it('omits undefined values, preserves empty strings/zero, and encodes a query once', () => {
    const url = apiUrl('/api', 'products/', { q: '%26+', country: '', page: 0, brand: undefined })
    expect(url).toBe('/api/products/?q=%2526%2B&country=&page=0')
  })
})

describe.each(adapters)('transport for %s', (path, call, body) => {
  it('requests anonymous JSON using the public default prefix and cleans up after success', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    reply(body)
    expect(await call({ signal: controller.signal })).toEqual({ kind: 'ok', data: body })
    expect(fetchMock).toHaveBeenCalledWith(`/api/${path}`, {
      headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store', signal: expect.any(AbortSignal),
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
  })
  it('does not fetch for a pre-aborted signal and does not return an error', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await call({ signal: controller.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('cancels an in-flight fetch, ignores late resolution and removes its listener/timer', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve }))
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const pending = call({ signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function))
    resolveFetch(new Response(JSON.stringify(body)))
    reply(body)
    expect(await call()).toEqual({ kind: 'ok', data: body })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('settles a fetch ignoring its signal at exactly 15 seconds', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(() => new Promise(() => {}))
    const pending = call()
    await vi.advanceTimersByTimeAsync(14_999)
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('includes body read in the same 15-second deadline instead of restarting it', async () => {
    vi.useFakeTimers()
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve }))
    const pending = call()
    await vi.advanceTimersByTimeAsync(10_000)
    resolveFetch({ status: 200, json: () => new Promise(() => {}) } as Response)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels body reading and discards its late valid data', async () => {
    let resolveBody!: (body: unknown) => void
    fetchMock.mockResolvedValue({ status: 200, json: () => new Promise((resolve) => { resolveBody = resolve }) } as Response)
    const controller = new AbortController()
    const pending = call({ signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' })
    resolveBody(body)
  })
})

describe('safe errors and retries', () => {
  it.each([
    [400, 'invalid_parameter', 'invalid_parameter'], [400, 'invalid_request', 'invalid_request'],
    [400, 'range_too_large', 'range_too_large'], [404, 'not_found', 'not_found'],
    [404, 'page_out_of_range', 'page_out_of_range'], [500, 'internal_error', 'server'],
  ])('distinguishes HTTP %s code %s and hides all server messages', async (status, code, reason) => {
    reply({ error: { code, message: 'private stack or URL', fields: { page: ['private query value'] } } }, status)
    const result = await getProducts()
    expect(result).toEqual({ kind: 'error', reason, status, ...(status === 500 ? {} : { fields: ['page'] }) })
    expect(JSON.stringify(result)).not.toContain('private')
  })
  it.each([
    [200, { error: { code: 'internal_error', message: 'Ошибка' } }],
    [400, { error: { code: 'not_found', message: 'Ошибка' } }],
    [404, { error: { code: 'invalid_parameter', message: 'Ошибка' } }],
    [500, { error: { code: 'not_found', message: 'Ошибка' } }],
    [400, { error: { code: 'invalid_parameter', message: null } }],
    [400, { error: { code: 'invalid_parameter', message: 'Ошибка', fields: { page: 'invalid' } } }],
    [400, { error: { code: 'invalid_parameter', message: 'Ошибка', fields: { page: [1] } } }],
    [400, { error: { code: 'invalid_parameter', message: 'Ошибка', fields: null } }],
    [404, { detail: 'not found' }], [201, pageOf([])], [503, { error: { code: 'internal_error', message: 'Ошибка' } }],
  ])('rejects invalid error schema or status/body pair %#', async (status, body) => {
    reply(body, status)
    expect(await getProducts()).toEqual({ kind: 'error', reason: 'invalid_response', status })
  })
  it.each([502, 504])('treats proxy HTTP %s as invalid_response for both non-JSON and JSON bodies', async (status) => {
    fetchMock.mockResolvedValue(new Response('<html>Proxy error</html>', { status }))
    expect(await getProducts()).toEqual({ kind: 'error', reason: 'invalid_response', status })
    reply({ error: { code: 'internal_error', message: 'Proxy error' } }, status)
    expect(await getProducts()).toEqual({ kind: 'error', reason: 'invalid_response', status })
  })
  it.each(['', '<html>ошибка</html>', '{broken'])('rejects non-JSON/malformed JSON %s', async (body) => {
    fetchMock.mockResolvedValue(new Response(body))
    expect(await getProducts()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
  it('distinguishes a broken connection during fetch/body and permits a fresh successful request', async () => {
    vi.useFakeTimers()
    fetchMock.mockRejectedValue(new TypeError('private address'))
    expect(await getProducts()).toEqual({ kind: 'error', reason: 'network' })
    fetchMock.mockResolvedValue({ status: 200, json: () => Promise.reject(new TypeError('stream disconnected')) } as Response)
    expect(await getProducts()).toEqual({ kind: 'error', reason: 'network', status: 200 })
    reply(pageOf([]))
    expect(await getProducts()).toEqual({ kind: 'ok', data: pageOf([]) })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('handles fetch/body AbortError caused by the actual propagated signal', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }))
    const pending = getProducts()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    fetchMock.mockImplementation(async (_url, options) => ({ status: 200, json: () => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }) }) as Response)
    const controller = new AbortController()
    const body = getProducts({}, { signal: controller.signal })
    await Promise.resolve()
    controller.abort()
    expect(await body).toEqual({ kind: 'aborted' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects a body finishing past the deadline even before the timer callback could run', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue({ status: 200, json: async () => {
      vi.setSystemTime(Date.now() + 15_001)
      return pageOf([])
    } } as Response)
    expect(await getProducts()).toEqual({ kind: 'error', reason: 'timeout' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})
