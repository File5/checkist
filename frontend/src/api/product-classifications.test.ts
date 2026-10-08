import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGenericProducts } from './catalog'
import { clearRecognitionCsrf } from './local'
import {
  classificationErrorReasons, confirmProductClassification, confirmProductClassifications, getProductClassification,
  getProductClassificationRun, getProductClassificationRuns, getProductClassifications, getProductClassificationState,
  isClassificationError, rejectProductClassification, requestProductClassificationRun,
} from './product-classifications'
import { classificationFixture, errorFixtures } from './product-classifications-test-support'
import { cancelProductMerge } from './product-merges'
import { mergeFixture } from './product-merges-test-support'
import { publicFixture } from './recognition-test-support'
import type { ClassificationConfirmInput, ClassificationConfirmItem } from './product-classifications'
import type { LocalApiFailure, LocalApiResult, RequestOptions } from './types'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const response = (name: string, status = 200) => json(classificationFixture(name), status)
const csrf = () => json(publicFixture('csrf.json'))
const failure = (code: string, status: number, fields?: object) => json({ error: { code, message: 'private', ...(fields && { fields }) } }, status)
const posted = (index = 1) => fetchMock.mock.calls[index]
const request = (name: string) => JSON.stringify(classificationFixture(name))
beforeEach(() => { clearRecognitionCsrf(); clearRecognitionCsrf({ baseUrl: '/other' }); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); clearRecognitionCsrf({ baseUrl: '/other' }); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

type Call = (options?: RequestOptions) => Promise<LocalApiResult<unknown>>
const readers: [string, Call, string][] = [
  ['product-classifications/', (o) => getProductClassifications({}, o), 'classifications.json'],
  ['product-classifications/3/', (o) => getProductClassification(3, o), 'classification-pending.json'],
  ['product-classifications/status/', (o) => getProductClassificationState(o), 'status.json'],
  ['product-classifications/runs/', (o) => getProductClassificationRuns({}, o), 'runs.json'],
  ['product-classifications/runs/1/', (o) => getProductClassificationRun(1, o), 'run.json'],
]
const many = (classificationFixture('confirm-many-request.json') as { items: ClassificationConfirmItem[] }).items
/** The request examples of the backend are the bodies the adapters must send, byte for byte. */
const mutations: [string, Call, string, string][] = [
  ['product-classifications/4/confirm/', (o) => confirmProductClassification(4, { version: 1, generic_id: 92 }, o), request('confirm-request.json'), 'classification-confirmed.json'],
  ['product-classifications/6/confirm/', (o) => confirmProductClassification(6, { version: 1, generic_id: 95 }, o), request('confirm-other-request.json'), 'classification-confirmed-other.json'],
  ['product-classifications/3/reject/', (o) => rejectProductClassification(3, { version: 1 }, o), request('reject-request.json'), 'classification-rejected.json'],
  ['product-classifications/confirm/', (o) => confirmProductClassifications(many, o), request('confirm-many-request.json'), 'confirm-many.json'],
  ['product-classifications/runs/', (o) => requestProductClassificationRun(o), '{}', 'run-created.json'],
]

describe.each(readers)('GET %s', (path, call, fixture) => {
  it('validates the backend fixture using same-origin credentials, the trailing slash and an explicit prefix', async () => {
    fetchMock.mockResolvedValue(response(fixture))
    expect(await call({ baseUrl: '/other/' })).toEqual({ kind: 'ok', data: classificationFixture(fixture) })
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
  it('rejects a body of another shape', async () => {
    fetchMock.mockResolvedValue(response('run-nothing.json'))
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
})

describe('reading parameters', () => {
  it('sends the filters, the ordering and the page once and omits absent ones', async () => {
    fetchMock.mockImplementation(async () => response('classifications.json'))
    await getProductClassifications({ status: 'pending', product: 13, generic: 94, run: 1, ordering: 'generic', page: 2, page_size: 200 })
    await getProductClassifications({ status: 'superseded', ordering: '-id' })
    await getProductClassifications()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/product-classifications/?status=pending&product=13&generic=94&run=1&ordering=generic&page=2&page_size=200',
      '/api/product-classifications/?status=superseded&ordering=-id', '/api/product-classifications/',
    ])
    fetchMock.mockImplementation(async () => response('runs.json'))
    await getProductClassificationRuns({ status: 'queued', page: 3, page_size: 10 })
    expect(fetchMock.mock.calls[3][0]).toBe('/api/product-classifications/runs/?status=queued&page=3&page_size=10')
  })
  it('accepts an empty list and a state without any run', async () => {
    const empty = { count: 0, page: 1, page_size: 200, pages: 0, results: [] }
    fetchMock.mockResolvedValueOnce(json(empty)).mockResolvedValueOnce(response('status-empty.json'))
    expect(await getProductClassifications({ status: 'rejected' })).toEqual({ kind: 'ok', data: empty })
    expect(await getProductClassificationState()).toMatchObject({ kind: 'ok', data: { run: null, pending_count: 0 } })
  })
  it('reads the options of «выбрать другой» from the unchanged catalog list with the session cookie of this origin', async () => {
    fetchMock.mockResolvedValue(json({ count: 0, page: 1, page_size: 50, pages: 0, results: [] }))
    expect((await getGenericProducts({ q: 'сыр', page_size: 50 })).kind).toBe('ok')
    expect(fetchMock).toHaveBeenCalledWith(`/api/generic-products/?q=${encodeURIComponent('сыр')}&page_size=50`,
      { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) })
  })
})

describe.each(mutations)('POST %s', (path, call, body, fixture) => {
  it('obtains CSRF once, posts exactly the documented JSON body and parses the backend fixture', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockImplementation(async () => response(fixture))
    expect(await call()).toEqual({ kind: 'ok', data: classificationFixture(fixture) })
    expect((await call()).kind).toBe('ok')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', `/api/${path}`, `/api/${path}`])
    expect(posted()[1]).toEqual({
      method: 'POST', body, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRFToken': 'MASKED_CSRF_TOKEN' },
    })
  })
  it.each([['network', () => Promise.reject(new TypeError('offline'))], ['server', async () => failure('internal_error', 500)],
    ['classification_busy', async () => failure('classification_busy', 409)], ['classification_changed', async () => failure('classification_changed', 409)],
    ['database_unavailable', async () => failure('database_unavailable', 503)],
  ] as const)('never repeats the POST after %s', async (reason, reply) => {
    fetchMock.mockResolvedValueOnce(csrf()).mockImplementation(reply)
    expect(await call()).toMatchObject({ kind: 'error', reason })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('does not repeat a POST that timed out after 15 seconds', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValueOnce(csrf()).mockImplementation(() => new Promise(() => {}))
    const pending = call()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(posted()[1]?.signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('drops a rejected CSRF token without a hidden retry; the next explicit call gets a new one', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(response('error-csrf-failed.json', 403))
      .mockResolvedValueOnce(csrf()).mockResolvedValueOnce(response(fixture))
    expect(await call()).toEqual({ kind: 'error', reason: 'csrf_failed', status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await call()).kind).toBe('ok')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', `/api/${path}`, '/api/recognition/csrf/', `/api/${path}`])
  })
  it('does not post when the token cannot be obtained or the caller already left', async () => {
    fetchMock.mockResolvedValue(response('error-permission-denied.json', 403))
    expect(await call()).toEqual({ kind: 'error', reason: 'permission_denied', status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const controller = new AbortController(); controller.abort()
    expect(await call({ signal: controller.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('rejects a success body of another shape', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(response('runs.json'))
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
})

describe('mutation bodies and answers', () => {
  const body = (index = 1) => JSON.parse(posted(index)[1]!.body as string)
  it('always sends version and generic_id for confirm and never forwards keys the server does not know', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockImplementation(async () => response('classification-confirmed.json'))
    await confirmProductClassification(4, { version: 7, generic_id: 92, dry_run: true, name: 'Произвольный текст' } as ClassificationConfirmInput)
    expect(posted()[1]!.body).toBe('{"version":7,"generic_id":92}')
    fetchMock.mockImplementation(async () => response('classification-rejected.json'))
    await rejectProductClassification(3, { version: 2, generic_id: 92 } as Parameters<typeof rejectProductClassification>[1])
    expect(posted(2)[1]!.body).toBe('{"version":2}')
    fetchMock.mockImplementation(async () => response('confirm-many.json'))
    await confirmProductClassifications([{ id: 1, version: 1, generic_id: 93 }, { id: 2, version: 4 }] as ClassificationConfirmItem[])
    expect(body(3)).toEqual({ items: [{ id: 1, version: 1 }, { id: 2, version: 4 }] })
  })
  it('accepts 202 of a queued run and 200 of an existing run or of nothing to classify', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(response('run-created.json', 202))
      .mockResolvedValueOnce(response('run-existing.json')).mockResolvedValueOnce(response('run-nothing.json'))
    expect(await requestProductClassificationRun()).toMatchObject({ kind: 'ok', data: { created: true, run: { status: 'queued' } } })
    expect(await requestProductClassificationRun()).toMatchObject({ kind: 'ok', data: { created: false, run: { id: 2 } } })
    expect(await requestProductClassificationRun()).toEqual({ kind: 'ok', data: classificationFixture('run-nothing.json') })
  })
  it('shares the CSRF token with product merges under one API prefix', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(mergeFixture('group-cancelled.json'))).mockResolvedValueOnce(response('classification-rejected.json'))
    expect((await cancelProductMerge(3)).kind).toBe('ok')
    expect((await rejectProductClassification(3, { version: 1 })).kind).toBe('ok')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', '/api/product-merges/3/cancel/', '/api/product-classifications/3/reject/'])
  })
})

it('rejects unsafe ids, versions and item lists before CSRF or any fetch', async () => {
  const bad = Number.MAX_SAFE_INTEGER + 1
  const cases: [() => Promise<LocalApiResult<unknown>>, string[]][] = [
    [() => getProductClassification(0), ['id']], [() => getProductClassification(bad), ['id']], [() => getProductClassificationRun(-1), ['id']],
    [() => getProductClassifications({ product: 1.5, generic: 0, run: bad }), ['product', 'generic', 'run']],
    [() => confirmProductClassification(0, { version: 0, generic_id: bad }), ['id', 'version', 'generic_id']],
    [() => confirmProductClassification(1, { version: '1' as unknown as number, generic_id: true as unknown as number }), ['version', 'generic_id']],
    [() => confirmProductClassification(1, { version: 1 } as ClassificationConfirmInput), ['generic_id']],
    [() => rejectProductClassification(bad, { version: 1.5 }), ['id', 'version']],
    [() => rejectProductClassification(3, {} as Parameters<typeof rejectProductClassification>[1]), ['version']],
    [() => confirmProductClassifications([{ id: 1 }, { version: 1 }] as unknown as ClassificationConfirmItem[]), ['items.0.version', 'items.1.id']],
    [() => confirmProductClassifications([]), ['items']],
    [() => confirmProductClassifications(Array.from({ length: 101 }, (_, index) => ({ id: index + 1, version: 1 }))), ['items']],
    [() => confirmProductClassifications([{ id: 1, version: 1 }, { id: 0, version: 0 }]), ['items.1.id', 'items.1.version']],
    [() => confirmProductClassifications([{ id: 5, version: 1 }, { id: 5, version: 1 }]), ['items.1.id']],
  ]
  for (const [call, fields] of cases) expect(await call()).toEqual({ kind: 'error', reason: 'invalid_parameter', fields })
  expect(fetchMock).not.toHaveBeenCalled()
})
it('sends exactly 100 records of a mass confirmation in one request', async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, version: 1 }))
  fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json({ confirmed: 0, results: [] }))
  expect((await confirmProductClassifications(items)).kind).toBe('ok')
  expect(JSON.parse(posted()[1]!.body as string).items).toHaveLength(100)
})

describe('error envelopes of the classification API', () => {
  it.each(Object.entries(errorFixtures))('maps the backend example %s to its reason and field names only', async (name, { status, reason, fields }) => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(response(name, status))
    const result = await confirmProductClassifications([{ id: 1, version: 1 }, { id: 2, version: 1 }])
    expect(result).toEqual({ kind: 'error', reason, status, ...(fields && { fields }) })
    expect(JSON.stringify(result)).not.toMatch(/[А-Яа-я]/)
  })
  it.each([
    [400, 'invalid_parameter'], [400, 'invalid_request'], [403, 'csrf_failed'], [403, 'permission_denied'], [404, 'not_found'],
    [404, 'page_out_of_range'], [405, 'method_not_allowed'], [406, 'not_acceptable'], [409, 'classification_resolved'],
    [409, 'classification_changed'], [409, 'classification_busy'], [415, 'unsupported_media_type'], [503, 'database_unavailable'],
  ])('parses HTTP %s %s of a read and of a mutation', async (status, reason) => {
    const fields = { 'items.0': ['private'], generic_id: ['private', 'private'] }
    const expected = { kind: 'error', reason, status, fields: ['items.0', 'generic_id'] }
    fetchMock.mockResolvedValueOnce(failure(reason, status, fields))
    expect(await getProductClassification(1)).toEqual(expected)
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure(reason, status, fields))
    expect(await rejectProductClassification(1, { version: 1 })).toEqual(expected)
  })
  it('maps 500 internal_error to server', async () => {
    fetchMock.mockResolvedValue(failure('internal_error', 500))
    expect(await getProductClassifications()).toEqual({ kind: 'error', reason: 'server', status: 500 })
  })
  it.each([[400, 'classification_busy'], [403, 'classification_changed'], [404, 'classification_resolved'], [409, 'classification_unknown'], [500, 'classification_busy']])(
    'rejects a classification code under a foreign status or an unknown code (HTTP %s %s)', async (status, code) => {
      fetchMock.mockResolvedValue(failure(code, status))
      expect(await getProductClassification(1)).toEqual({ kind: 'error', reason: 'invalid_response', status })
    })
  it('keeps the three codes out of the old public GET handlers', async () => {
    fetchMock.mockResolvedValue(failure('classification_busy', 409))
    expect(await getGenericProducts()).toEqual({ kind: 'error', reason: 'invalid_response', status: 409 })
  })
  it('names exactly the three classification reasons', () => {
    const reasons: LocalApiFailure['reason'][] = ['classification_resolved', 'classification_changed', 'classification_busy']
    expect([...classificationErrorReasons]).toEqual(reasons)
    for (const reason of reasons) expect(isClassificationError({ kind: 'error', reason, status: 409 })).toBe(true)
    for (const reason of ['merge_busy', 'not_found', 'csrf_failed', 'network'] as const) expect(isClassificationError({ kind: 'error', reason })).toBe(false)
  })
})
