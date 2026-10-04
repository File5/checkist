import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelJob, clearRecognitionCsrf, getJob, getJobs, getPhoto, getPhotos, getReceiptImage, getReceiptImages, getRecognitionCsrf, retryJob, uploadPhoto } from './recognition'
import { getReceipt, getReceiptDiscounts, getReceiptLines, getReceipts, getReceiptTaxes } from './receipts'
import { publicFixture } from './recognition-test-support'
import type { LocalApiResult, RequestOptions } from './types'

const fetchMock = vi.fn<typeof fetch>()
const response = (name: string, status = 200) => new Response(JSON.stringify(publicFixture(name)), { status })
const file = () => new File(['synthetic'], 'receipt.png', { type: 'image/png' })
beforeEach(() => { clearRecognitionCsrf(); clearRecognitionCsrf({ baseUrl: '/other' }); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); clearRecognitionCsrf({ baseUrl: '/other' }); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const adapters: [string, (options?: RequestOptions) => Promise<LocalApiResult<unknown>>, string][] = [
  ['recognition/csrf/', getRecognitionCsrf, 'csrf.json'],
  ['recognition/photos/', (o) => getPhotos({}, o), 'photos.json'], ['recognition/photos/11/', (o) => getPhoto(11, o), 'photo.json'],
  ['recognition/jobs/', (o) => getJobs({}, o), 'jobs.json'], ['recognition/jobs/31/', (o) => getJob(31, o), 'job.json'],
  ['recognition/receipt-images/', (o) => getReceiptImages({}, o), 'receipt-images.json'], ['recognition/receipt-images/42/', (o) => getReceiptImage(42, o), 'receipt-image.json'],
  ['receipts/', (o) => getReceipts({}, o), 'receipts.json'], ['receipts/71/', (o) => getReceipt(71, o), 'receipt.json'],
  ['receipts/71/lines/', (o) => getReceiptLines(71, {}, o), 'lines.json'], ['receipts/71/discounts/', (o) => getReceiptDiscounts(71, {}, o), 'discounts.json'], ['receipts/71/taxes/', (o) => getReceiptTaxes(71, {}, o), 'taxes.json'],
]

describe.each(adapters)('local GET %s', (path, call, fixture) => {
  it('validates the backend fixture using same-origin credentials and an explicit prefix', async () => {
    fetchMock.mockResolvedValue(response(fixture))
    expect(await call({ baseUrl: '/other/' })).toEqual({ kind: 'ok', data: publicFixture(fixture) })
    expect(fetchMock).toHaveBeenCalledWith(`/other/${path}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) })
  })
  it('does not fetch for a pre-aborted caller', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await call({ signal: controller.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('times out a stalled response at 15 seconds and releases the timer', async () => {
    vi.useFakeTimers(); fetchMock.mockImplementation(() => new Promise(() => {}))
    const pending = call()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('mutations and anonymous CSRF lifecycle', () => {
  it.each([['upload-new.json', 202], ['upload-reused.json', 200]] as const)('uploads multipart and parses %s with HTTP %s', async (fixture, status) => {
    fetchMock.mockResolvedValueOnce(response('csrf.json')).mockResolvedValueOnce(response(fixture, status))
    expect(await uploadPhoto(file())).toEqual({ kind: 'ok', data: publicFixture(fixture) })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/recognition/photos/')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', 'X-CSRFToken': 'MASKED_CSRF_TOKEN' } })
    expect(init?.headers).not.toHaveProperty('Content-Type')
    expect(init?.body).toBeInstanceOf(FormData)
    expect([...(init!.body as FormData).keys()]).toEqual(['file'])
    expect(((init!.body as FormData).get('file') as File).name).toBe('receipt.png')
    expect(init?.headers).not.toHaveProperty('Idempotency-Key')
  })
  it.each([cancelJob, retryJob])('posts JSON {} and reuses the in-memory token', async (call) => {
    fetchMock.mockResolvedValueOnce(response('csrf.json')).mockImplementation(async () => response('job.json', 202))
    expect((await call(31)).kind).toBe('ok'); expect((await call(31)).kind).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRFToken': 'MASKED_CSRF_TOKEN' } })
  })
  it('accepts HTTP 200 cancellation and keeps tokens isolated by API prefix', async () => {
    fetchMock.mockResolvedValueOnce(response('csrf.json')).mockResolvedValueOnce(response('job.json'))
      .mockResolvedValueOnce(response('csrf.json')).mockResolvedValueOnce(response('job.json'))
    expect((await cancelJob(31)).kind).toBe('ok')
    expect((await cancelJob(31, { baseUrl: '/other' })).kind).toBe('ok')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', '/api/recognition/jobs/31/cancel/', '/other/recognition/csrf/', '/other/recognition/jobs/31/cancel/'])
  })
  it('returns CSRF failure without posting or implicitly retrying', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'permission_denied', message: 'private' } }), { status: 403 }))
    expect(await uploadPhoto(file())).toEqual({ kind: 'error', reason: 'permission_denied', status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('invalidates rejected CSRF and reacquires only on the next explicit mutation', async () => {
    fetchMock.mockResolvedValueOnce(response('csrf.json')).mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'csrf_failed', message: 'private' } }), { status: 403 }))
      .mockResolvedValueOnce(response('csrf.json')).mockResolvedValueOnce(response('job.json', 202))
    expect(await retryJob(31)).toEqual({ kind: 'error', reason: 'csrf_failed', status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await retryJob(31)).kind).toBe('ok')
    expect(fetchMock.mock.calls[2][0]).toBe('/api/recognition/csrf/')
  })
  it('shares CSRF acquisition while one caller aborts independently', async () => {
    let resolve!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolve = r })).mockResolvedValue(response('job.json', 202))
    const controller = new AbortController()
    const first = cancelJob(31, { signal: controller.signal })
    const second = retryJob(31)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    controller.abort()
    expect(await first).toEqual({ kind: 'aborted' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(false)
    resolve(response('csrf.json'))
    expect((await second).kind).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('aborts an unobserved CSRF request and discards a late token', async () => {
    let resolve!: (value: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    const controller = new AbortController()
    const pending = uploadPhoto(file(), { signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    resolve(response('csrf.json'))
    fetchMock.mockResolvedValueOnce(response('csrf.json')).mockResolvedValueOnce(response('job.json', 202))
    expect((await retryJob(31)).kind).toBe('ok')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/recognition/csrf/')
  })
  it.each([[uploadPhoto, 60_000], [() => cancelJob(31), 15_000]] as const)('bounds mutation fetch AND body by its deadline (%#)', async (call, timeout) => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(response('csrf.json'))
    await getRecognitionCsrf()
    fetchMock.mockResolvedValueOnce({ status: 202, json: () => new Promise(() => {}) } as Response)
    const pending = call(file())
    await vi.advanceTimersByTimeAsync(timeout - 1)
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels an upload during body read and ignores a late success', async () => {
    fetchMock.mockResolvedValueOnce(response('csrf.json')); await getRecognitionCsrf()
    let resolve!: (value: unknown) => void
    fetchMock.mockResolvedValueOnce({ status: 202, json: () => new Promise((r) => { resolve = r }) } as Response)
    const controller = new AbortController()
    const pending = uploadPhoto(file(), { signal: controller.signal })
    await Promise.resolve(); controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' }); resolve(publicFixture('upload-new.json'))
  })
})

describe('local error envelopes', () => {
  it.each([
    [400, 'invalid_request'], [400, 'invalid_parameter'], [400, 'unsupported_format'], [400, 'invalid_image'], [400, 'image_too_large'],
    [403, 'csrf_failed'], [403, 'permission_denied'], [404, 'not_found'], [404, 'page_out_of_range'],
    [405, 'method_not_allowed'], [406, 'not_acceptable'], [409, 'job_active'], [409, 'job_terminal'], [409, 'retry_not_allowed'],
    [413, 'upload_too_large'], [415, 'unsupported_media_type'], [503, 'storage_unavailable'], [503, 'database_unavailable'],
  ])('parses HTTP %s %s without exposing server messages', async (status, reason) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: reason, message: 'private', fields: { file: ['private'] } } }), { status }))
    expect(await getJobs()).toEqual({ kind: 'error', reason, status, fields: ['file'] })
  })
  it.each([400, 403, 409, 413, 415, 503])('rejects mismatched HTTP %s/error and unexpected schema', async (status) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'not_found', message: 'error' } }), { status }))
    expect(await getJobs()).toEqual({ kind: 'error', reason: 'invalid_response', status })
  })
  it.each([200, 202])('rejects malformed success body at HTTP %s', async (status) => {
    fetchMock.mockResolvedValueOnce(response('csrf.json')).mockResolvedValueOnce(new Response('{}', { status }))
    expect(await uploadPhoto(file())).toEqual({ kind: 'error', reason: 'invalid_response', status })
  })
})

it('rejects unsafe IDs before any fetch/CSRF, including mutation targets and all filters', async () => {
  const bad = Number.MAX_SAFE_INTEGER + 1
  for (const call of [() => getPhoto(bad), () => getJob(bad), () => cancelJob(bad), () => retryJob(bad), () => getReceiptImage(bad), () => getJobs({ photo: bad }),
    () => getReceiptImages({ job: bad }), () => getReceiptImages({ receipt: bad }), () => getReceiptImages({ photo: bad }), () => getReceipts({ product: bad }),
    () => getReceipts({ store: bad }), () => getReceipt(bad), () => getReceiptLines(bad), () => getReceiptDiscounts(bad), () => getReceiptTaxes(bad)]) {
    expect(await call()).toMatchObject({ kind: 'error', reason: 'invalid_parameter' })
  }
  expect(fetchMock).not.toHaveBeenCalled()
})
it('encodes AND filters, sort/page parameters and Unicode search exactly once', async () => {
  fetchMock.mockResolvedValue(response('receipt-images.json'))
  await getReceiptImages({ photo: 11, job: 31, receipt: 71, page: 2, page_size: 1, ordering: 'created_at' })
  expect(fetchMock.mock.calls[0][0]).toBe('/api/recognition/receipt-images/?photo=11&job=31&receipt=71&page=2&page_size=1&ordering=created_at')
  fetchMock.mockResolvedValue(response('receipts.json'))
  await getReceipts({ q: 'Чек + 20%', store: 51, product: 61, country: 'DE', currency: 'EUR', operation: 'refund', date_from: '2026-10-01', date_to: '2026-10-04', page: 2 })
  const url = new URL(fetchMock.mock.calls[1][0] as string, 'http://local')
  expect(url.searchParams.get('q')).toBe('Чек + 20%'); expect(url.searchParams.get('product')).toBe('61')
  expect(url.searchParams.get('operation')).toBe('refund'); expect(url.searchParams.get('date_to')).toBe('2026-10-04')
  fetchMock.mockResolvedValue(response('lines.json'))
  await getReceiptLines(71, { matching: 'unmatched', kind: 'product', page: 2, page_size: 1 })
  expect(fetchMock.mock.calls[2][0]).toBe('/api/receipts/71/lines/?matching=unmatched&kind=product&page=2&page_size=1')
})
