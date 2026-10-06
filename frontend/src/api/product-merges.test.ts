import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecognitionCsrf } from './local'
import {
  cancelProductMerge, confirmProductMerge, detectProductMerges, excludeProductMerge, getProductMerge, getProductMergeLines,
  getProductMerges, isMergeError, mergeErrorReasons,
} from './product-merges'
import { errorFixtures, mergeFixture } from './product-merges-test-support'
import { cancelJob } from './recognition'
import { publicFixture } from './recognition-test-support'
import type { MergeConfirmInput, MergeResolutions } from './product-merges'
import type { LocalApiFailure, LocalApiResult, RequestOptions } from './types'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const response = (name: string, status = 200) => json(mergeFixture(name), status)
const csrf = () => json(publicFixture('csrf.json'))
const failure = (code: string, status: number, fields?: object) => json({ error: { code, message: 'private', ...(fields && { fields }) } }, status)
const posted = (index = 1) => fetchMock.mock.calls[index]
beforeEach(() => { clearRecognitionCsrf(); clearRecognitionCsrf({ baseUrl: '/other' }); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); clearRecognitionCsrf({ baseUrl: '/other' }); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

type Call = (options?: RequestOptions) => Promise<LocalApiResult<unknown>>
const readers: [string, Call, string][] = [
  ['product-merges/', (o) => getProductMerges({}, o), 'groups.json'],
  ['product-merges/2/', (o) => getProductMerge(2, o), 'group-pending.json'],
  ['product-merges/2/lines/', (o) => getProductMergeLines(2, {}, o), 'lines.json'],
]
const mutations: [string, Call, string, string][] = [
  ['product-merges/detect/', (o) => detectProductMerges(o), '{}', 'detect.json'],
  ['product-merges/1/confirm/', (o) => confirmProductMerge(1, { version: 1, target_product_id: 2 }, o), '{"version":1,"target_product_id":2}', 'group-confirmed.json'],
  ['product-merges/3/cancel/', (o) => cancelProductMerge(3, o), '{}', 'group-cancelled.json'],
  ['product-merges/2/exclude/', (o) => excludeProductMerge(2, { version: 1, product_id: 43 }, o), '{"version":1,"product_id":43}', 'group-pending.json'],
]

describe.each(readers)('GET %s', (path, call, fixture) => {
  it('validates the backend fixture using same-origin credentials, the trailing slash and an explicit prefix', async () => {
    fetchMock.mockResolvedValue(response(fixture))
    expect(await call({ baseUrl: '/other/' })).toEqual({ kind: 'ok', data: mergeFixture(fixture) })
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
    fetchMock.mockResolvedValue(response('detect.json'))
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
})

describe('reading parameters', () => {
  it('sends status, product and page parameters once and omits absent ones', async () => {
    fetchMock.mockImplementation(async () => response('groups.json'))
    await getProductMerges({ status: 'pending', product: 17, page: 2, page_size: 1 })
    await getProductMerges({ status: 'confirmed' })
    await getProductMerges()
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/product-merges/?status=pending&product=17&page=2&page_size=1', '/api/product-merges/?status=confirmed', '/api/product-merges/',
    ])
    fetchMock.mockImplementation(async () => response('lines.json'))
    await getProductMergeLines(2, { page: 3, page_size: 200 })
    expect(fetchMock.mock.calls[3][0]).toBe('/api/product-merges/2/lines/?page=3&page_size=200')
  })
  it('accepts an empty list of a cancelled group', async () => {
    const empty = { count: 0, page: 1, page_size: 50, pages: 0, results: [] }
    fetchMock.mockResolvedValue(json(empty))
    expect(await getProductMergeLines(3)).toEqual({ kind: 'ok', data: empty })
  })
})

describe.each(mutations)('POST %s', (path, call, body, fixture) => {
  it('obtains CSRF once, posts exactly the documented JSON body and parses the backend fixture', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockImplementation(async () => response(fixture))
    expect(await call()).toEqual({ kind: 'ok', data: mergeFixture(fixture) })
    expect((await call()).kind).toBe('ok')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', `/api/${path}`, `/api/${path}`])
    expect(posted()[1]).toEqual({
      method: 'POST', body, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRFToken': 'MASKED_CSRF_TOKEN' },
    })
  })
  it.each([['network', () => Promise.reject(new TypeError('offline'))], ['server', async () => failure('internal_error', 500)],
    ['merge_busy', async () => failure('merge_busy', 409)], ['database_unavailable', async () => failure('database_unavailable', 503)],
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
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure('csrf_failed', 403))
      .mockResolvedValueOnce(csrf()).mockResolvedValueOnce(response(fixture))
    expect(await call()).toEqual({ kind: 'error', reason: 'csrf_failed', status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect((await call()).kind).toBe('ok')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', `/api/${path}`, '/api/recognition/csrf/', `/api/${path}`])
  })
  it('does not post when the token cannot be obtained or the caller already left', async () => {
    fetchMock.mockResolvedValue(failure('permission_denied', 403))
    expect(await call()).toEqual({ kind: 'error', reason: 'permission_denied', status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const controller = new AbortController(); controller.abort()
    expect(await call({ signal: controller.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
  it('rejects a success body of another shape', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(response('lines.json'))
    expect(await call()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
})

describe('mutation bodies', () => {
  const body = () => JSON.parse(posted()[1]!.body as string)
  beforeEach(() => { fetchMock.mockResolvedValueOnce(csrf()).mockImplementation(async () => response('group-confirmed.json')) })
  it('sends name_product_id and resolutions only when given', async () => {
    await confirmProductMerge(1, { version: 3, target_product_id: 2, name_product_id: 14, resolutions: { generic: 2, brand: 36 } })
    expect(body()).toEqual({ version: 3, target_product_id: 2, name_product_id: 14, resolutions: { generic: 2, brand: 36 } })
    await confirmProductMerge(1, { version: 3, target_product_id: 2, name_product_id: undefined, resolutions: {} })
    expect(posted(2)[1]!.body).toBe('{"version":3,"target_product_id":2}')
    await confirmProductMerge(1, { version: 3, target_product_id: 2, resolutions: { generic: undefined } })
    expect(posted(3)[1]!.body).toBe('{"version":3,"target_product_id":2}')
  })
  it('never forwards keys the server does not know', async () => {
    const input = { version: 1, target_product_id: 2, dry_run: true, name: 'Произвольный текст' } as MergeConfirmInput
    await confirmProductMerge(1, input)
    expect(body()).toEqual({ version: 1, target_product_id: 2 })
    await excludeProductMerge(1, { version: 1, product_id: 14, target_product_id: 2 } as Parameters<typeof excludeProductMerge>[1])
    expect(JSON.parse(posted(2)[1]!.body as string)).toEqual({ version: 1, product_id: 14 })
  })
  it('shares the CSRF token with recognition under one API prefix', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(publicFixture('job.json'))).mockResolvedValueOnce(response('group-cancelled.json'))
    expect((await cancelJob(31)).kind).toBe('ok')
    expect((await cancelProductMerge(3)).kind).toBe('ok')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', '/api/recognition/jobs/31/cancel/', '/api/product-merges/3/cancel/'])
  })
})

it('rejects unsafe ids, versions and resolutions before CSRF or any fetch', async () => {
  const bad = Number.MAX_SAFE_INTEGER + 1
  const cases: [() => Promise<LocalApiResult<unknown>>, string[]][] = [
    [() => getProductMerge(0), ['id']], [() => getProductMerge(bad), ['id']], [() => getProductMergeLines(-1), ['id']],
    [() => getProductMerges({ product: 1.5 }), ['product']], [() => cancelProductMerge(bad), ['id']],
    [() => excludeProductMerge(0, { version: 0, product_id: bad }), ['id', 'version', 'product_id']],
    [() => confirmProductMerge(1, { version: 1.5, target_product_id: 0 }), ['version', 'target_product_id']],
    [() => confirmProductMerge(1, { version: 1, target_product_id: 2, name_product_id: null as unknown as number }), ['name_product_id']],
    [() => confirmProductMerge(1, { version: '1' as unknown as number, target_product_id: true as unknown as number }), ['version', 'target_product_id']],
    [() => confirmProductMerge(1, { version: 1, target_product_id: 2, resolutions: { generic: 0 } }), ['resolutions.generic']],
    [() => confirmProductMerge(1, { version: 1, target_product_id: 2, resolutions: { name: 2 } as MergeResolutions }), ['resolutions.name']],
  ]
  for (const [call, fields] of cases) expect(await call()).toEqual({ kind: 'error', reason: 'invalid_parameter', fields })
  expect(fetchMock).not.toHaveBeenCalled()
})

describe('error envelopes of the merge API', () => {
  it.each(Object.entries(errorFixtures))('maps the backend example %s to its reason and field names only', async (name, { status, reason, fields }) => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(response(name, status))
    const result = await confirmProductMerge(1, { version: 1, target_product_id: 2 })
    expect(result).toEqual({ kind: 'error', reason, status, ...(fields && { fields }) })
    expect(JSON.stringify(result)).not.toMatch(/[А-Яа-я]/)
  })
  it.each([
    [400, 'invalid_parameter'], [400, 'invalid_request'], [403, 'csrf_failed'], [403, 'permission_denied'], [404, 'not_found'],
    [404, 'page_out_of_range'], [405, 'method_not_allowed'], [406, 'not_acceptable'], [409, 'merge_conflict'], [409, 'merge_resolved'],
    [409, 'merge_changed'], [409, 'merge_busy'], [415, 'unsupported_media_type'], [503, 'database_unavailable'],
  ])('parses HTTP %s %s of a read and of a mutation', async (status, reason) => {
    const fields = { 'resolutions.generic': ['private'], name: ['private', 'private'] }
    const expected = { kind: 'error', reason, status, fields: ['resolutions.generic', 'name'] }
    fetchMock.mockResolvedValueOnce(failure(reason, status, fields))
    expect(await getProductMerge(1)).toEqual(expected)
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure(reason, status, fields))
    expect(await excludeProductMerge(1, { version: 1, product_id: 2 })).toEqual(expected)
  })
  it('maps 500 internal_error to server', async () => {
    fetchMock.mockResolvedValue(failure('internal_error', 500))
    expect(await getProductMerges()).toEqual({ kind: 'error', reason: 'server', status: 500 })
  })
  it.each([[400, 'merge_conflict'], [403, 'merge_busy'], [404, 'merge_resolved'], [409, 'not_found'], [409, 'merge_unknown'], [500, 'merge_changed']])(
    'rejects a merge code under a foreign status or an unknown code (HTTP %s %s)', async (status, code) => {
      fetchMock.mockResolvedValue(failure(code, status))
      expect(await getProductMerge(1)).toEqual({ kind: 'error', reason: 'invalid_response', status })
    })
  it.each([{ generic: 'private' }, { generic: [1] }, ['generic'], null])('rejects malformed fields of a conflict (%#)', async (fields) => {
    fetchMock.mockResolvedValue(json({ error: { code: 'merge_conflict', message: 'private', fields } }, 409))
    expect(await getProductMerge(1)).toEqual({ kind: 'error', reason: 'invalid_response', status: 409 })
  })
  it('names exactly the four merge reasons', () => {
    const reasons: LocalApiFailure['reason'][] = ['merge_conflict', 'merge_resolved', 'merge_changed', 'merge_busy']
    expect([...mergeErrorReasons]).toEqual(reasons)
    for (const reason of reasons) expect(isMergeError({ kind: 'error', reason, status: 409 })).toBe(true)
    for (const reason of ['job_active', 'not_found', 'csrf_failed', 'network'] as const) expect(isMergeError({ kind: 'error', reason })).toBe(false)
  })
})
