import { describe, expect, it, vi } from 'vitest'
import { getProducts } from '../../api/catalog'
import type { ApiResult } from '../../api/types'
import { createCatalogRequest } from './catalog-request'
import { productsParams } from './catalog-state'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('request lifetimes (Node; React runtime is manual)', () => {
  it('starts loading, commits a response and exposes a stable snapshot', async () => {
    const pending = deferred<ApiResult<string>>()
    const request = createCatalogRequest(() => pending.promise)
    const notify = vi.fn()
    const unsubscribe = request.subscribe(notify)
    expect(request.getSnapshot().kind).toBe('loading')
    request.start()
    pending.resolve({ kind: 'ok', data: 'new' })
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'new' })
    expect(request.getSnapshot()).toBe(request.getSnapshot())
    expect(notify).toHaveBeenCalledTimes(2)
    unsubscribe()
    request.stop()
  })
  it.each<ApiResult<string>>([{ kind: 'ok', data: 'stale' }, { kind: 'error', reason: 'server', status: 500 }])('abort plus generation guard rejects a late $kind from a previous request', async (late) => {
    const first = deferred<ApiResult<string>>()
    const second = deferred<ApiResult<string>>()
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? first.promise : second.promise
    })
    const request = createCatalogRequest(load)
    request.start()
    request.start()
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    second.resolve({ kind: 'ok', data: 'latest' })
    await flush()
    first.resolve(late)
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'latest' })
    request.stop()
  })
  it('cleanup silences a late rejection and permits a fresh StrictMode start', async () => {
    const first = deferred<ApiResult<string>>()
    const load = vi.fn<(signal: AbortSignal) => Promise<ApiResult<string>>>()
      .mockImplementationOnce(() => first.promise).mockResolvedValue({ kind: 'ok', data: 'fresh' })
    const request = createCatalogRequest(load)
    const notify = vi.fn()
    request.subscribe(notify)
    request.start()
    request.stop()
    first.reject(new Error('private error must not be shown'))
    await flush()
    expect(notify).toHaveBeenCalledTimes(1)
    request.start()
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'fresh' })
    request.stop()
  })
  it('a new URL lifetime has loading rather than the old successful result', async () => {
    const old = createCatalogRequest(async () => ({ kind: 'ok' as const, data: 'old' }))
    old.start()
    await flush()
    const next = createCatalogRequest<string>(() => deferred<ApiResult<string>>().promise)
    expect(old.getSnapshot().kind).toBe('ok')
    expect(next.getSnapshot().kind).toBe('loading')
    old.stop()
    next.stop()
  })
  it('explicit retry clears an error, preserves the loader and commits success', async () => {
    const load = vi.fn<(signal: AbortSignal) => Promise<ApiResult<string>>>()
      .mockResolvedValueOnce({ kind: 'error', reason: 'network' }).mockResolvedValueOnce({ kind: 'ok', data: 'restored' })
    const request = createCatalogRequest(load)
    request.start()
    await flush()
    expect(request.getSnapshot().kind).toBe('error')
    expect(load).toHaveBeenCalledTimes(1) // No automatic retries.
    request.start()
    expect(request.getSnapshot().kind).toBe('loading')
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'restored' })
    expect(load).toHaveBeenCalledTimes(2)
    request.stop()
  })
  it('ignores a normal navigation abort instead of displaying an error', async () => {
    const request = createCatalogRequest(async () => ({ kind: 'aborted' as const }))
    request.start()
    await flush()
    expect(request.getSnapshot().kind).toBe('loading')
    request.stop()
  })
  it('maps unexpected loader rejection to a safe network error', async () => {
    const request = createCatalogRequest<string>(async () => { throw new Error('private text') })
    request.start()
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'error', reason: 'network' })
    request.stop()
  })
  it('sends category/search/generic/page through the real adapter with mocked fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ count: 0, page: 1, page_size: 50, pages: 0, results: [] }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const request = createCatalogRequest((signal) => getProducts(productsParams({ q: 'молоко & сыр', generic: 5, page: 1 }, 2), { signal, baseUrl: '/api' }))
    try {
      request.start()
      await vi.waitFor(() => expect(request.getSnapshot().kind).toBe('ok'))
      const [href, options] = fetchMock.mock.calls[0]
      const url = new URL(href, 'http://checkist.local')
      expect(url.pathname).toBe('/api/products/')
      expect(Object.fromEntries(url.searchParams)).toEqual({ category: '2', q: 'молоко & сыр', generic: '5', page: '1' })
      expect(options.signal).toBeInstanceOf(AbortSignal)
      expect(options.credentials).toBe('omit')
    } finally {
      request.stop()
      vi.unstubAllGlobals()
    }
  })
})
