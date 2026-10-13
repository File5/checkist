/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerCount, answerGeneration, keepAnswer } from '../api/answer-cache'
import { reportAuthSignal } from '../api/auth-signal'
import { cancelJob, clearRecognitionCsrf } from '../api/recognition'
import { publicFixture } from '../api/recognition-test-support'
import type { Me } from '../api/session'
import { writesHeld } from '../api/write-gate'
import { shellView } from '../features/auth/auth-state'
import { memoryStore, newPending } from '../offline/pending'
import { resetPending, sendPendingNow } from '../offline/pending-store'
import { applyMe, applySettings, getSession, loadSession, ME_KEY, resetSession } from './store'
import type { Session } from './store'

/** The backend's real answer of «Я»; a fresh object on every call. */
function me(change: Partial<Me> = {}): Me {
  const body = JSON.parse(readFileSync(new URL('../../../backend/api/tests/fixtures/auth/me.json', import.meta.url), 'utf8')) as Me
  return { ...body, ...change }
}
/** What the device keeps: «Я» without the token. */
function kept(change: Partial<Me> = {}): Omit<Me, 'csrf_token'> {
  const { csrf_token: _token, ...rest } = me(change)
  void _token
  return rest
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const guestAnswer = () => json({ error: { code: 'not_authenticated', message: 'Требуется вход.' } }, 401)
const reader: Session = { kind: 'user', mode: 'accounts', user: { id: 1, username: 'synthetic-reader', display_name: 'synthetic-reader', is_staff: false }, household: null, permissions: { moderate_catalog: false }, isHead: true, settings: { default_currency: null } }

/** The `localStorage` of a device; `broken` throws like a private window with blocked site data. */
function device(initial: Record<string, string> = {}, broken = false) {
  const data = new Map(Object.entries(initial))
  const fail = () => { throw new DOMException('blocked', 'SecurityError') }
  return {
    data,
    localStorage: {
      getItem: (key: string) => broken ? fail() : data.get(key) ?? null,
      setItem: (key: string, value: string) => { if (broken) fail(); data.set(key, String(value)) },
      removeItem: (key: string) => { if (broken) fail(); data.delete(key) },
    },
  }
}
const stored = (value: unknown) => ({ [ME_KEY]: JSON.stringify(value) })

const fetchMock = vi.fn<typeof fetch>()
const urls = () => fetchMock.mock.calls.map(([url]) => String(url))
let phone: ReturnType<typeof device>
/** The events of the window: `online`. */
let events: EventTarget
function open(initial: Record<string, string>, broken = false) {
  phone = device(initial, broken)
  events = new EventTarget()
  vi.stubGlobal('window', {
    localStorage: phone.localStorage,
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
  })
  resetSession()
}
/** A started write of the local API (cancelling a job): CSRF, then the POST. */
const write = () => cancelJob(31)
const answers = (meAnswer: () => Response | Promise<Response>) => fetchMock.mockImplementation(async (url) => {
  const address = String(url)
  if (address.endsWith('/me/')) return meAnswer()
  if (address.endsWith('/csrf/')) return json(publicFixture('csrf.json'))
  return json(publicFixture('job.json'), 202)
})

beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); resetSession(); clearRecognitionCsrf(); vi.restoreAllMocks() })

describe('the start of the application', () => {
  it('opens as the person remembered on the device at once, without a request', () => {
    open(stored(kept()))
    expect(getSession()).toEqual({ ...reader, provisional: true })
    // The screen is drawn at once: no «Проверяем вход…».
    expect(shellView(getSession(), { kind: 'dashboard' })).toBe('page')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(writesHeld()).toBe(true)
  })
  it.each([
    ['nothing kept', {}],
    ['broken JSON', { [ME_KEY]: '{"mode":' }],
    ['another shape', stored({ mode: 'accounts', user: null })],
    ['a kept token', stored(me())],
  ])('waits for «Я» as before with %s', (_name, initial) => {
    open(initial)
    expect(getSession()).toEqual({ kind: 'loading' })
    expect(shellView(getSession(), { kind: 'dashboard' })).toBe('loading')
    expect(writesHeld()).toBe(false)
  })
  it('waits for «Я» as before when the storage throws, and works on without it', async () => {
    open({}, true)
    expect(getSession()).toEqual({ kind: 'loading' })
    answers(() => json(me()))
    await loadSession()
    expect(getSession()).toEqual(reader)
  })
})

describe('the answer of /api/me/ after a start from the device', () => {
  it('confirms the same person, applies what changed and keeps «Я» without the token', async () => {
    open(stored(kept()))
    answers(() => json(me({ user: { id: 1, username: 'synthetic-reader', display_name: 'Читатель', is_staff: false } })))
    await loadSession()
    expect(getSession()).toEqual({ ...reader, user: { ...(reader as { user: object }).user, display_name: 'Читатель' } })
    const saved = phone.data.get(ME_KEY) ?? ''
    expect(JSON.parse(saved)).toEqual(kept({ user: { id: 1, username: 'synthetic-reader', display_name: 'Читатель', is_staff: false } }))
    expect(saved).not.toContain('csrf')
    expect(saved).not.toContain(me().csrf_token)
    expect(writesHeld()).toBe(false)
  })
  it('lets a write pressed before the answer go only after it, with the token of the session', async () => {
    open(stored(kept()))
    let answer!: (response: Response) => void
    answers(() => new Promise((resolve) => { answer = resolve }))
    const reading = loadSession()
    const saving = write()
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    expect(urls()).toEqual(['/api/me/'])
    answer(json(me()))
    await reading
    expect((await saving).kind).toBe('ok')
    expect(urls()).toEqual(['/api/me/', '/api/recognition/csrf/', '/api/recognition/jobs/31/cancel/'])
  })
  it('drops a waiting write when the server knows another person, and forgets what was read for the remembered one', async () => {
    open(stored(kept()))
    keepAnswer('/api/dashboard/', { month: '2026-10' }, answerGeneration())
    let answer!: (response: Response) => void
    answers(() => new Promise((resolve) => { answer = resolve }))
    const reading = loadSession()
    const saving = write()
    answer(json(me({ user: { id: 2, username: 'synthetic-other', is_staff: false } })))
    await reading
    expect(await saving).toEqual({ kind: 'aborted' })
    expect(urls()).toEqual(['/api/me/'])
    expect(answerCount()).toBe(0)
    expect(getSession()).toMatchObject({ kind: 'user', user: { id: 2 } })
    expect(JSON.parse(phone.data.get(ME_KEY) ?? 'null')).toMatchObject({ user: { id: 2, username: 'synthetic-other' } })
  })
  it('shows the sign-in for a guest answer, forgets the remembered person and the memory, and drops a waiting write', async () => {
    open(stored(kept()))
    keepAnswer('/api/dashboard/', { month: '2026-10' }, answerGeneration())
    let answer!: (response: Response) => void
    answers(() => new Promise((resolve) => { answer = resolve }))
    const reading = loadSession()
    const saving = write()
    answer(guestAnswer())
    await reading
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
    expect(shellView(getSession(), { kind: 'dashboard' })).toBe('login')
    expect(phone.data.has(ME_KEY)).toBe(false)
    expect(answerCount()).toBe(0)
    expect(await saving).toEqual({ kind: 'aborted' })
    expect(urls()).toEqual(['/api/me/'])
  })
})

describe('a failed read never confirms the remembered person', () => {
  const failures: [string, () => Promise<Response>][] = [
    ['a broken connection', () => Promise.reject(new TypeError('offline'))],
    ['a server failure', async () => json({ error: { code: 'internal_error', message: 'Ошибка' } }, 500)],
  ]
  it.each(failures)('keeps the person unconfirmed after %s: the screens read, the writes stay held', async (_name, failure) => {
    open(stored(kept()))
    answers(failure)
    await loadSession()
    expect(getSession()).toEqual({ ...reader, provisional: true })
    expect(shellView(getSession(), { kind: 'dashboard' })).toBe('page')
    expect(phone.data.has(ME_KEY)).toBe(true)
    expect(writesHeld()).toBe(true)
  })
  it.each(failures)('fails a write that waited like a lost network after %s, and sends nothing', async (_name, failure) => {
    open(stored(kept()))
    let answer!: () => void
    fetchMock.mockImplementation((url) => String(url).endsWith('/me/')
      ? new Promise<Response>((resolve, reject) => { answer = () => { void failure().then(resolve, reject) } })
      : Promise.resolve(json(publicFixture('job.json'), 202)))
    const reading = loadSession()
    const saving = write()
    answer()
    await reading
    expect(await saving).toEqual({ kind: 'error', reason: 'network' })
    expect(urls()).toEqual(['/api/me/'])
    expect(writesHeld()).toBe(true)
  })
  it('fails a write after 15 seconds when «Я» does not answer, instead of a spinning form', async () => {
    vi.useFakeTimers()
    try {
      open(stored(kept()))
      fetchMock.mockImplementation(() => new Promise(() => {}))
      const saving = write()
      // The write asked for «Я» itself.
      expect(urls()).toEqual(['/api/me/'])
      let settled = false
      void saving.then(() => { settled = true })
      await vi.advanceTimersByTimeAsync(14_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(await saving).toEqual({ kind: 'error', reason: 'network' })
      expect(urls()).toEqual(['/api/me/'])
    } finally {
      vi.useRealTimers()
    }
  })
  it('asks «Я» again for the next write and lets it go once the server confirms the person', async () => {
    open(stored(kept()))
    answers(() => Promise.reject(new TypeError('offline')))
    await loadSession()
    expect(await write()).toEqual({ kind: 'error', reason: 'network' })
    expect(urls()).toEqual(['/api/me/', '/api/me/'])
    answers(() => json(me()))
    expect((await write()).kind).toBe('ok')
    expect(urls().slice(2)).toEqual(['/api/me/', '/api/recognition/csrf/', '/api/recognition/jobs/31/cancel/'])
    expect(getSession()).toEqual(reader)
    expect(writesHeld()).toBe(false)
  })
  it('stops the next write when the read after the failure finds a guest', async () => {
    open(stored(kept()))
    answers(() => Promise.reject(new TypeError('offline')))
    await loadSession()
    answers(guestAnswer)
    expect(await write()).toEqual({ kind: 'aborted' })
    expect(urls()).toEqual(['/api/me/', '/api/me/'])
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
    expect(phone.data.has(ME_KEY)).toBe(false)
  })
  it('reads «Я» again when the network comes back', async () => {
    open(stored(kept()))
    answers(() => Promise.reject(new TypeError('offline')))
    await loadSession()
    answers(() => json(me()))
    events.dispatchEvent(new Event('online'))
    await vi.waitFor(() => { expect(getSession()).toEqual(reader) })
    expect(urls()).toEqual(['/api/me/', '/api/me/'])
    // A confirmed person is not read again for the network.
    events.dispatchEvent(new Event('online'))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('never sends the spends kept on the phone while the person is unconfirmed', async () => {
    open(stored(kept()))
    const body = { total: '1500.00', currency: 'KZT', purchased_on: '2026-10-13', store_name: 'Кофейня' }
    resetPending({ store: memoryStore([newPending(body, 'synthetic-reader')]), owner: 'synthetic-reader' })
    answers(() => json(me()))
    await sendPendingNow()
    expect(fetchMock).not.toHaveBeenCalled()
    await loadSession()
    fetchMock.mockClear()
    fetchMock.mockImplementation(async (url) => String(url).endsWith('/csrf/') ? json(publicFixture('csrf.json'))
      : json({ count: 0, page: 1, page_size: 200, pages: 0, results: [] }))
    await sendPendingNow()
    expect(urls()).toContain('/api/recognition/csrf/')
    resetPending()
  })
})

describe('what the device keeps afterwards', () => {
  it('keeps the person of a sign-in and their new settings, and forgets them at a sign-out', () => {
    open({})
    applyMe(me())
    expect(JSON.parse(phone.data.get(ME_KEY) ?? 'null')).toEqual(kept())
    applySettings({ default_currency: 'KZT' })
    expect(JSON.parse(phone.data.get(ME_KEY) ?? 'null')).toEqual(kept({ settings: { default_currency: 'KZT' } }))
    applyMe(null)
    expect(phone.data.has(ME_KEY)).toBe(false)
  })
  it('forgets the person when the session ended in the middle of work', () => {
    open(stored(kept()))
    reportAuthSignal('unauthenticated')
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
    expect(phone.data.has(ME_KEY)).toBe(false)
    expect(writesHeld()).toBe(false)
  })
  it('never fails a sign-in when the storage throws', () => {
    open({}, true)
    applyMe(me())
    expect(getSession()).toEqual(reader)
  })
})
