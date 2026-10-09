import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onAuthSignal } from './auth-signal'
import type { AuthSignal } from './auth-signal'
import { clearRecognitionCsrf, getRecognitionCsrf, retryJob, uploadPhoto } from './recognition'
import { publicFixture } from './recognition-test-support'
import { UPLOAD_IDLE_MS, UPLOAD_RESPONSE_MS, canReportProgress, fileProgress } from './upload-transport'

type Progress = { loaded: number; total: number; lengthComputable: boolean }

/** The part of XMLHttpRequest the transport uses; the test plays the network by hand. */
class FakeXhr {
  static instances: FakeXhr[] = []
  static failOnSend = false
  upload: { onprogress: ((event: Progress) => void) | null; onload: ((event: Progress) => void) | null } = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  status = 0
  responseText = ''
  withCredentials = false
  timeout = 0
  method = ''
  url = ''
  headers: Record<string, string> = {}
  body: unknown = undefined
  aborted = false
  constructor() { FakeXhr.instances.push(this) }
  open(method: string, url: string) { this.method = method; this.url = url }
  setRequestHeader(name: string, value: string) { this.headers[name] = value }
  send(body: unknown) {
    if (FakeXhr.failOnSend) throw new TypeError('synthetic')
    this.body = body
  }
  abort() { this.aborted = true; this.onabort?.() }
  progress(loaded: number, total = 2000, lengthComputable = true) { this.upload.onprogress?.({ loaded, total, lengthComputable }) }
  bodySent(total = 2000) { this.upload.onload?.({ loaded: total, total, lengthComputable: true }) }
  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body)
    this.onload?.()
  }
}

const fetchMock = vi.fn<typeof fetch>()
const csrf = () => new Response(JSON.stringify(publicFixture('csrf.json')), { status: 200 })
/** 1000 bytes of a file inside a 2000-byte multipart body: progress must be restated in bytes of the file. */
const file = () => new File([new Uint8Array(1000)], 'receipt.jpg', { type: 'image/jpeg' })
const envelope = (code: string) => ({ error: { code, message: 'private' } })
const signals: AuthSignal[] = []
let unsubscribe = () => {}

/** Starts an upload with progress. The token is obtained first, so the request leaves at once and no clock moves. */
async function start(options: { signal?: AbortSignal; onProgress?: (sent: number, total: number) => void } = {}) {
  const onProgress = vi.fn<(sent: number, total: number) => void>(options.onProgress)
  expect((await getRecognitionCsrf()).kind).toBe('ok')
  const pending = uploadPhoto(file(), { signal: options.signal, onProgress })
  expect(FakeXhr.instances).toHaveLength(1)
  return { pending, xhr: FakeXhr.instances[0], onProgress }
}

beforeEach(() => {
  clearRecognitionCsrf(); fetchMock.mockReset(); fetchMock.mockImplementation(async () => csrf())
  FakeXhr.instances = []; FakeXhr.failOnSend = false; signals.length = 0
  vi.stubGlobal('fetch', fetchMock); vi.stubGlobal('XMLHttpRequest', FakeXhr)
  unsubscribe = onAuthSignal((signal) => { signals.push(signal) })
})
afterEach(() => { unsubscribe(); clearRecognitionCsrf(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('upload through XMLHttpRequest', () => {
  it.each([['upload-new.json', 202], ['upload-reused.json', 200]] as const)('posts multipart with the CSRF token and parses %s with HTTP %s', async (fixture, status) => {
    const { pending, xhr } = await start()
    expect(xhr.method).toBe('POST')
    expect(xhr.url).toBe('/api/recognition/photos/')
    expect(xhr.headers).toEqual({ Accept: 'application/json', 'X-CSRFToken': 'MASKED_CSRF_TOKEN' })
    expect(xhr.withCredentials).toBe(false)
    expect(xhr.timeout).toBe(0)
    expect(xhr.body).toBeInstanceOf(FormData)
    expect([...(xhr.body as FormData).keys()]).toEqual(['file'])
    expect(((xhr.body as FormData).get('file') as File).name).toBe('receipt.jpg')
    xhr.respond(status, publicFixture(fixture))
    expect(await pending).toEqual({ kind: 'ok', data: publicFixture(fixture) })
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/'])
  })
  it('honours an explicit API prefix', async () => {
    expect((await getRecognitionCsrf({ baseUrl: '/other/' })).kind).toBe('ok')
    const pending = uploadPhoto(file(), { baseUrl: '/other/', onProgress: vi.fn() })
    expect(FakeXhr.instances[0].url).toBe('/other/recognition/photos/')
    FakeXhr.instances[0].respond(202, publicFixture('upload-new.json'))
    expect((await pending).kind).toBe('ok')
    clearRecognitionCsrf({ baseUrl: '/other/' })
  })
  it('reports progress in bytes of the file, never backwards, and ends at its size', async () => {
    const { pending, xhr, onProgress } = await start()
    expect(onProgress).not.toHaveBeenCalled()
    xhr.progress(500); xhr.progress(500); xhr.progress(300); xhr.progress(1500)
    xhr.progress(1700, 0, false)
    xhr.bodySent()
    xhr.progress(1999)
    xhr.respond(202, publicFixture('upload-new.json'))
    expect((await pending).kind).toBe('ok')
    expect(onProgress.mock.calls).toEqual([[250, 1000], [750, 1000], [1000, 1000]])
  })
  it('keeps the request alive when the progress listener throws', async () => {
    const { pending, xhr } = await start({ onProgress: () => { throw new Error('synthetic') } })
    xhr.progress(500); xhr.bodySent()
    xhr.respond(202, publicFixture('upload-new.json'))
    expect((await pending).kind).toBe('ok')
  })
})

describe('cancelling an upload', () => {
  it('aborts the request, releases the timer and ignores a late answer', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const { pending, xhr, onProgress } = await start({ signal: controller.signal })
    xhr.progress(500)
    controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' })
    expect(xhr.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    xhr.progress(1500); xhr.bodySent(); xhr.respond(202, publicFixture('upload-new.json'))
    expect(onProgress.mock.calls).toEqual([[250, 1000]])
    expect(vi.getTimerCount()).toBe(0)
  })
  it('cancels while the server is answering', async () => {
    const controller = new AbortController()
    const { pending, xhr } = await start({ signal: controller.signal })
    xhr.bodySent(); controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' })
    expect(xhr.aborted).toBe(true)
  })
  it('opens no request for a caller that is already gone', async () => {
    const controller = new AbortController(); controller.abort()
    expect(await uploadPhoto(file(), { signal: controller.signal, onProgress: vi.fn() })).toEqual({ kind: 'aborted' })
    expect(FakeXhr.instances).toHaveLength(0)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('the «no movement» deadline', () => {
  beforeEach(() => { vi.useFakeTimers() })
  it('times out after 30 s without a single byte', async () => {
    const { pending, xhr } = await start()
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1)
    expect(xhr.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(xhr.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('has no total deadline: a slow upload lives as long as bytes keep moving', async () => {
    const { pending, xhr } = await start()
    for (let step = 1; step <= 10; step++) {
      await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1)
      xhr.progress(step * 100)
    }
    expect(xhr.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
  })
  it('does not count a repeated event without new bytes as movement', async () => {
    const { pending, xhr } = await start()
    xhr.progress(500)
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1)
    xhr.progress(500); xhr.progress(400)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
  })
  it('counts movement even when the total is unknown', async () => {
    const { pending, xhr, onProgress } = await start()
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1)
    xhr.progress(500, 0, false)
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1)
    expect(xhr.aborted).toBe(false)
    expect(onProgress).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
  })
  it('gives the server 60 s to answer once the body is sent', async () => {
    const { pending, xhr } = await start()
    await vi.advanceTimersByTimeAsync(UPLOAD_IDLE_MS - 1)
    xhr.bodySent()
    await vi.advanceTimersByTimeAsync(UPLOAD_RESPONSE_MS - 1)
    // A stray event after the body is sent neither prolongs nor shortens the wait.
    xhr.progress(1999)
    expect(xhr.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
    expect(xhr.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('releases the timer after an answer', async () => {
    const { pending, xhr } = await start()
    xhr.bodySent(); xhr.respond(202, publicFixture('upload-new.json'))
    expect((await pending).kind).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('refusals of an upload', () => {
  it.each([
    [400, 'unsupported_format'], [400, 'invalid_image'], [400, 'image_too_large'], [400, 'invalid_request'],
    [413, 'upload_too_large'], [415, 'unsupported_media_type'], [503, 'storage_unavailable'], [503, 'database_unavailable'],
  ])('parses HTTP %s %s as the fetch path does', async (status, reason) => {
    const { pending, xhr } = await start()
    xhr.respond(status, envelope(reason))
    expect(await pending).toEqual({ kind: 'error', reason, status })
    expect(signals).toEqual([])
  })
  it('keeps the names of refused fields and hides server messages', async () => {
    const { pending, xhr } = await start()
    xhr.respond(400, { error: { code: 'invalid_request', message: 'private', fields: { file: ['private'] } } })
    expect(await pending).toEqual({ kind: 'error', reason: 'invalid_request', status: 400, fields: ['file'] })
  })
  it('turns 401 not_authenticated into the session signal, not an error of the screen', async () => {
    const { pending, xhr } = await start()
    xhr.respond(401, envelope('not_authenticated'))
    expect(await pending).toEqual({ kind: 'aborted' })
    expect(signals).toEqual(['unauthenticated'])
  })
  it('reports 403 permission_denied to the shell', async () => {
    const { pending, xhr } = await start()
    xhr.respond(403, envelope('permission_denied'))
    expect(await pending).toEqual({ kind: 'error', reason: 'permission_denied', status: 403 })
    expect(signals).toEqual(['forbidden'])
  })
  it('drops a rejected CSRF token without replaying the upload', async () => {
    const { pending, xhr } = await start()
    xhr.respond(403, envelope('csrf_failed'))
    expect(await pending).toEqual({ kind: 'error', reason: 'csrf_failed', status: 403 })
    expect(FakeXhr.instances).toHaveLength(1)
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(new Response(JSON.stringify(publicFixture('job.json')), { status: 202 }))
    expect((await retryJob(31)).kind).toBe('ok')
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', '/api/recognition/csrf/', '/api/recognition/jobs/31/retry/'])
  })
  it.each([[413, '<html>Request Entity Too Large</html>'], [502, ''], [202, 'not json']])('rejects a non-JSON answer at HTTP %s', async (status, text) => {
    const { pending, xhr } = await start()
    xhr.respond(status, text)
    expect(await pending).toEqual({ kind: 'error', reason: 'invalid_response', status })
  })
  it.each([[400, 'not_found'], [413, 'unsupported_format'], [401, 'permission_denied']])('rejects a mismatched HTTP %s / %s', async (status, code) => {
    const { pending, xhr } = await start()
    xhr.respond(status, envelope(code))
    expect(await pending).toEqual({ kind: 'error', reason: 'invalid_response', status })
    expect(signals).toEqual([])
  })
  it.each([200, 202])('rejects a malformed success body at HTTP %s', async (status) => {
    const { pending, xhr } = await start()
    xhr.respond(status, {})
    expect(await pending).toEqual({ kind: 'error', reason: 'invalid_response', status })
  })
  it('reports a broken connection as a network failure and releases the timer', async () => {
    vi.useFakeTimers()
    const { pending, xhr } = await start()
    xhr.progress(500); xhr.onerror?.()
    expect(await pending).toEqual({ kind: 'error', reason: 'network' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('reports a request the browser refused to send as a network failure', async () => {
    vi.useFakeTimers()
    FakeXhr.failOnSend = true
    expect(await uploadPhoto(file(), { onProgress: vi.fn() })).toEqual({ kind: 'error', reason: 'network' })
    expect(vi.getTimerCount()).toBe(0)
  })
  it('returns a CSRF failure without opening the upload', async () => {
    fetchMock.mockReset(); fetchMock.mockResolvedValue(new Response(JSON.stringify(envelope('permission_denied')), { status: 403 }))
    expect(await uploadPhoto(file(), { onProgress: vi.fn() })).toEqual({ kind: 'error', reason: 'permission_denied', status: 403 })
    expect(FakeXhr.instances).toHaveLength(0)
  })
})

describe('the fetch path stays the default', () => {
  it('uses fetch when no progress is asked for, even where XMLHttpRequest exists', async () => {
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(new Response(JSON.stringify(publicFixture('upload-new.json')), { status: 202 }))
    expect(await uploadPhoto(file())).toEqual({ kind: 'ok', data: publicFixture('upload-new.json') })
    expect(FakeXhr.instances).toHaveLength(0)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/recognition/csrf/', '/api/recognition/photos/'])
  })
  it('uses fetch where XMLHttpRequest is missing and never calls onProgress', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined)
    expect(canReportProgress()).toBe(false)
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(new Response(JSON.stringify(publicFixture('upload-new.json')), { status: 202 }))
    const onProgress = vi.fn()
    expect(await uploadPhoto(file(), { onProgress })).toEqual({ kind: 'ok', data: publicFixture('upload-new.json') })
    expect(onProgress).not.toHaveBeenCalled()
    const init = fetchMock.mock.calls[1][1]
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json', 'X-CSRFToken': 'MASKED_CSRF_TOKEN' } })
    expect(init?.body).toBeInstanceOf(FormData)
  })
  it('keeps the total 60 s deadline of the fetch path', async () => {
    vi.stubGlobal('XMLHttpRequest', undefined)
    vi.useFakeTimers()
    fetchMock.mockReset()
    fetchMock.mockResolvedValueOnce(csrf()).mockImplementationOnce(() => new Promise(() => {}))
    const pending = uploadPhoto(file(), { onProgress: vi.fn() })
    await vi.advanceTimersByTimeAsync(59_999)
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
  })
})

describe('fileProgress', () => {
  it.each([
    [0, 2000, 0], [1, 2000, 1], [1000, 2000, 500], [1999, 2000, 1000], [2000, 2000, 1000], [5, 0, 0],
  ])('restates %s of %s body bytes as %s of 1000 file bytes', (sent, total, expected) => {
    const onProgress = vi.fn()
    fileProgress(1000, onProgress)(sent, total)
    expect(onProgress).toHaveBeenCalledWith(expected, 1000)
  })
})
