import { afterEach, describe, expect, it, vi } from 'vitest'
import { getReceipt, getReceiptDiscounts, getReceiptLines, getReceiptTaxes, getReceipts } from '../../api/receipts'
import type { Receipt } from '../../api/receipts'
import { getReceiptImages } from '../../api/recognition'
import { publicFixture } from '../../api/recognition-test-support'
import type { LocalApiResult } from '../../api/types'
import { createReceiptRequest } from './request'
import { receiptParams } from './state'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.unstubAllGlobals())

describe('receipt request lifetime (Node, browser behaviour is manual)', () => {
  it.each<LocalApiResult<string>>([{ kind: 'ok', data: 'old' }, { kind: 'error', reason: 'server', status: 500 }])('ignores late $kind after a page change/retry', async (late) => {
    const old = deferred<LocalApiResult<string>>()
    const next = deferred<LocalApiResult<string>>()
    const signals: AbortSignal[] = []
    const request = createReceiptRequest((signal) => { signals.push(signal); return signals.length === 1 ? old.promise : next.promise })
    request.start()
    request.start()
    expect(signals[0].aborted).toBe(true)
    expect(signals[1].aborted).toBe(false)
    next.resolve({ kind: 'ok', data: 'current' })
    await flush()
    old.resolve(late)
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'current' })
    request.stop()
  })
  it('stop prevents updates from unmounted screens and permits a fresh StrictMode start', async () => {
    const old = deferred<LocalApiResult<string>>()
    const load = vi.fn<(signal: AbortSignal) => Promise<LocalApiResult<string>>>().mockImplementationOnce(() => old.promise).mockResolvedValue({ kind: 'ok', data: 'fresh' })
    const request = createReceiptRequest(load)
    const listener = vi.fn()
    const unsubscribe = request.subscribe(listener)
    request.start()
    request.stop()
    old.reject(new Error('private provider output'))
    await flush()
    expect(listener).toHaveBeenCalledTimes(1)
    request.start()
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'fresh' })
    expect(request.getSnapshot()).toBe(request.getSnapshot())
    unsubscribe()
    request.stop()
  })
  it('retries explicitly without an automatic repeat and suppresses abort as an error', async () => {
    const load = vi.fn<(signal: AbortSignal) => Promise<LocalApiResult<string>>>()
      .mockResolvedValueOnce({ kind: 'error', reason: 'network' }).mockResolvedValueOnce({ kind: 'ok', data: 'restored' })
    const request = createReceiptRequest(load)
    request.start()
    await flush()
    expect(request.getSnapshot().kind).toBe('error')
    expect(load).toHaveBeenCalledTimes(1)
    request.start()
    expect(request.getSnapshot().kind).toBe('loading')
    await flush()
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: 'restored' })
    request.stop()
    const aborted = createReceiptRequest(async () => ({ kind: 'aborted' as const }))
    aborted.start()
    await flush()
    expect(aborted.getSnapshot().kind).toBe('loading')
    aborted.stop()
  })
  it('keeps failure/retry independent from other loaded blocks', async () => {
    const headerLoad = vi.fn().mockResolvedValueOnce({ kind: 'error', reason: 'network' }).mockResolvedValueOnce({ kind: 'ok', data: 'header' })
    const linesLoad = vi.fn().mockResolvedValue({ kind: 'ok', data: 'lines' })
    const header = createReceiptRequest(headerLoad)
    const lines = createReceiptRequest(linesLoad)
    header.start(); lines.start()
    await flush()
    expect(header.getSnapshot().kind).toBe('error')
    expect(lines.getSnapshot()).toEqual({ kind: 'ok', data: 'lines' })
    header.start()
    await flush()
    expect(header.getSnapshot().kind).toBe('ok')
    expect(linesLoad).toHaveBeenCalledTimes(1)
    header.stop(); lines.stop()
  })
  it('passes URL filters, descending sort, abort and same-origin through the actual adapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(publicFixture('receipts.json')), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const request = createReceiptRequest((signal) => getReceipts(receiptParams({ page: 1, q: 'MILCH & хлеб', date_from: '2026-10-01', date_to: '2026-10-04' }), { signal, baseUrl: '/api' }))
    try {
      request.start()
      await vi.waitFor(() => expect(request.getSnapshot().kind).toBe('ok'))
      const [href, options] = fetchMock.mock.calls[0]
      const url = new URL(href, 'http://checkist.local')
      expect(url.pathname).toBe('/api/receipts/')
      expect(Object.fromEntries(url.searchParams)).toEqual({ page: '1', q: 'MILCH & хлеб', date_from: '2026-10-01', date_to: '2026-10-04', ordering: '-purchased_at' })
      expect(options.credentials).toBe('same-origin')
      expect(options.signal).toBeInstanceOf(AbortSignal)
    } finally { request.stop() }
  })
  it('calls all five real adapters with public fixtures and keeps a header HTTP failure local', async () => {
    const fetchMock = vi.fn(async (input: string) => {
      const url = new URL(input, 'http://checkist.local')
      const fixture = url.pathname.endsWith('/lines/') ? 'lines.json' : url.pathname.endsWith('/discounts/') ? 'discounts.json'
        : url.pathname.endsWith('/taxes/') ? 'taxes.json' : url.pathname.includes('receipt-images') ? 'receipt-images.json' : undefined
      return fixture ? new Response(JSON.stringify(publicFixture(fixture)), { status: 200 })
        : new Response(JSON.stringify({ error: { code: 'database_unavailable', message: 'Данные временно недоступны.' } }), { status: 503 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const options = { baseUrl: '/api' }
    const results = await Promise.all([
      getReceipt(71, options), getReceiptLines(71, { page: 2 }, options), getReceiptDiscounts(71, { page: 3 }, options),
      getReceiptTaxes(71, { page: 4 }, options), getReceiptImages({ receipt: 71, page: 2 }, options),
    ])
    expect(results.map((result) => result.kind)).toEqual(['error', 'ok', 'ok', 'ok', 'ok'])
    expect(results[0]).toEqual({ kind: 'error', reason: 'database_unavailable', status: 503 })
    const urls = fetchMock.mock.calls.map(([href]) => new URL(href, 'http://checkist.local'))
    expect(urls.at(-1)!.searchParams.get('receipt')).toBe('71')
    expect(urls.slice(1).map((url) => url.searchParams.get('page'))).toEqual(['2', '3', '4', '2'])
  })
  it('a different receipt lifetime begins loading rather than showing the previous receipt', async () => {
    const old = createReceiptRequest<Receipt>(async () => ({ kind: 'ok', data: publicFixture('receipt.json') as Receipt }))
    old.start(); await flush()
    const next = createReceiptRequest<Receipt>(() => deferred<LocalApiResult<Receipt>>().promise)
    expect(old.getSnapshot().kind).toBe('ok')
    expect(next.getSnapshot().kind).toBe('loading')
    old.stop(); next.stop()
  })
})
