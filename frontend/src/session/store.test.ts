/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reportAuthSignal } from '../api/auth-signal'
import { cancelJob, clearRecognitionCsrf } from '../api/recognition'
import { publicFixture } from '../api/recognition-test-support'
import type { Me } from '../api/session'
import { applyMe, canModerate, getSession, loadSession, permissionDeniedText, subscribeSession, useSession } from './index'
import type { Session } from './index'
import { resetSession } from './store'

/** Read the backend's real answers; never maintain a second copy of them. A fresh object on every call. */
function me(name = 'me.json', change: Partial<Me> = {}): Me {
  const body = JSON.parse(readFileSync(new URL(`../../../backend/api/tests/fixtures/auth/${name}`, import.meta.url), 'utf8')) as Me
  return { ...body, ...change }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const guestAnswer = () => json({ error: { code: 'not_authenticated', message: 'Требуется вход.' } }, 401)
const reader: Session = { kind: 'user', mode: 'accounts', user: { id: 1, username: 'synthetic-reader', is_staff: false }, permissions: { moderate_catalog: false } }
const local: Session = { kind: 'user', mode: 'local_single', user: { id: 1, username: 'local', is_staff: false }, permissions: { moderate_catalog: true } }

const fetchMock = vi.fn<typeof fetch>()
const urls = () => fetchMock.mock.calls.map(([url]) => url)
const seen: Session[] = []
let off: () => void
beforeEach(() => {
  clearRecognitionCsrf(); resetSession(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock)
  seen.length = 0; off = subscribeSession(() => { seen.push(getSession()) })
})
afterEach(() => { off(); resetSession(); clearRecognitionCsrf(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('reading «Я»', () => {
  it('starts as loading and becomes the user of GET /api/me/', async () => {
    expect(getSession()).toEqual({ kind: 'loading' })
    fetchMock.mockResolvedValue(json(me()))
    await loadSession()
    expect(getSession()).toEqual(reader)
    expect(seen).toEqual([reader])
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/me/', expect.objectContaining({ credentials: 'same-origin' }))
  })
  it('never keeps the CSRF token in the session', async () => {
    fetchMock.mockResolvedValue(json(me()))
    await loadSession()
    expect(JSON.stringify(getSession())).not.toContain(me().csrf_token)
  })
  it('reads the only user of local_single', async () => {
    fetchMock.mockResolvedValue(json(me('me_local_single.json')))
    await loadSession()
    expect(getSession()).toEqual(local)
  })
  it('takes 401 not_authenticated for a guest whose session did not expire', async () => {
    fetchMock.mockResolvedValue(guestAnswer())
    await loadSession()
    expect(getSession()).toEqual({ kind: 'guest', expired: false })
    expect(seen).toEqual([{ kind: 'guest', expired: false }])
  })
  it.each([
    ['a broken connection', () => Promise.reject(new TypeError('offline'))],
    ['a server failure', async () => json({ error: { code: 'internal_error', message: 'Ошибка' } }, 500)],
    ['a malformed answer', async () => json({ ...me(), user: null })],
    ['401 with another body', async () => json({ error: { code: 'invalid_credentials', message: 'Ошибка' } }, 401)],
  ])('becomes error after %s and loading again on the explicit retry', async (_name, answer) => {
    fetchMock.mockImplementationOnce(answer)
    await loadSession()
    expect(getSession()).toEqual({ kind: 'error' })
    fetchMock.mockResolvedValueOnce(json(me()))
    await loadSession()
    expect(seen).toEqual([{ kind: 'error' }, { kind: 'loading' }, reader])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('leaves the state alone when its owner cancelled the read', async () => {
    const controller = new AbortController()
    controller.abort()
    await loadSession(controller.signal)
    expect(getSession()).toEqual({ kind: 'loading' })
    expect(seen).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('applies only the newest of two overlapping reads', async () => {
    let first!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { first = resolve })).mockResolvedValueOnce(guestAnswer())
    const slow = loadSession()
    await loadSession()
    first(json(me()))
    await slow
    expect(getSession()).toEqual({ kind: 'guest', expired: false })
  })
})

describe('re-reading a known session', () => {
  beforeEach(() => { applyMe(me()); seen.length = 0 })
  it('keeps the same snapshot and wakes nobody up when nothing changed', async () => {
    const before = getSession()
    fetchMock.mockResolvedValue(json(me('me.json', { csrf_token: 'AnotherToken' })))
    await loadSession()
    expect(getSession()).toBe(before)
    expect(seen).toEqual([])
  })
  it('never shows loading and survives a failed read', async () => {
    const before = getSession()
    fetchMock.mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(json({ error: { code: 'internal_error', message: 'Ошибка' } }, 500))
    await loadSession()
    await loadSession()
    expect(getSession()).toBe(before)
    expect(seen).toEqual([])
  })
  it('becomes an expired guest when the session ended meanwhile, and stays expired on the next read', async () => {
    fetchMock.mockImplementation(async () => guestAnswer())
    await loadSession()
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
    await loadSession()
    expect(seen).toEqual([{ kind: 'guest', expired: true }])
  })
  it('keeps a guest during a failed read', async () => {
    applyMe(null)
    fetchMock.mockRejectedValue(new TypeError('offline'))
    await loadSession()
    expect(getSession()).toEqual({ kind: 'guest', expired: false })
  })
  it('applies a withdrawn or granted right, a new name and another person', async () => {
    fetchMock.mockResolvedValueOnce(json(me('me.json', { permissions: { moderate_catalog: true } })))
    await loadSession()
    expect(canModerate(getSession())).toBe(true)
    fetchMock.mockResolvedValueOnce(json(me('me.json', { user: { id: 1, username: 'renamed', is_staff: true } })))
    await loadSession()
    expect(getSession()).toEqual({ ...reader, user: { id: 1, username: 'renamed', is_staff: true } })
    fetchMock.mockResolvedValueOnce(json(me('me.json', { user: { id: 2, username: 'synthetic-other', is_staff: false } })))
    await loadSession()
    expect(getSession()).toMatchObject({ kind: 'user', user: { id: 2 } })
    expect(seen).toHaveLength(3)
  })
})

describe('after a sign-in, a sign-out and a password change', () => {
  it('applies «Я» of the answer without a request', () => {
    applyMe(me())
    expect(getSession()).toEqual(reader)
    applyMe(me('me_local_single.json'))
    expect(getSession()).toEqual(local)
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('makes a guest whose session did not expire after a sign-out', () => {
    applyMe(me())
    applyMe(null)
    expect(getSession()).toEqual({ kind: 'guest', expired: false })
    expect(seen).toEqual([reader, { kind: 'guest', expired: false }])
  })
  it('clears the expired mark with the next sign-in', () => {
    applyMe(me())
    reportAuthSignal('unauthenticated')
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
    applyMe(me())
    expect(getSession()).toEqual(reader)
  })
  it('discards an answer of /api/me/ asked before the sign-in', async () => {
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const pending = loadSession()
    applyMe(me())
    answer(guestAnswer())
    await pending
    expect(getSession()).toEqual(reader)
  })
})

describe('the CSRF token of the local API', () => {
  const csrf = () => json(publicFixture('csrf.json'))
  const job = () => json(publicFixture('job.json'), 202)
  async function tokenIsAskedAgain(): Promise<boolean> {
    const before = fetchMock.mock.calls.length
    fetchMock.mockImplementation(async (url) => (String(url).endsWith('/csrf/') ? csrf() : job()))
    expect((await cancelJob(31)).kind).toBe('ok')
    return urls().slice(before).includes('/api/recognition/csrf/')
  }
  beforeEach(async () => {
    applyMe(me())
    expect(await tokenIsAskedAgain()).toBe(true)
    expect(await tokenIsAskedAgain()).toBe(false)
  })
  it.each([['a sign-in or a password change', () => applyMe(me())], ['a sign-out', () => applyMe(null)]])('is forgotten after %s', async (_name, change) => {
    change()
    expect(await tokenIsAskedAgain()).toBe(true)
  })
  it('is forgotten when the session ended', async () => {
    reportAuthSignal('unauthenticated')
    expect(await tokenIsAskedAgain()).toBe(true)
  })
  it('is forgotten when a read finds another person or a guest, and kept for the same person', async () => {
    fetchMock.mockImplementation(async () => json(me()))
    await loadSession()
    expect(await tokenIsAskedAgain()).toBe(false)
    fetchMock.mockImplementation(async () => json(me('me.json', { user: { id: 2, username: 'synthetic-other', is_staff: false } })))
    await loadSession()
    expect(await tokenIsAskedAgain()).toBe(true)
    fetchMock.mockImplementation(async () => guestAnswer())
    await loadSession()
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
    expect(await tokenIsAskedAgain()).toBe(true)
  })
})

describe('signals of the transport', () => {
  it('ends the session of a user: an expired guest without a request', () => {
    applyMe(me())
    reportAuthSignal('unauthenticated')
    reportAuthSignal('unauthenticated')
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
    expect(seen).toEqual([reader, { kind: 'guest', expired: true }])
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('discards an answer of /api/me/ asked before the session ended', async () => {
    applyMe(me())
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const pending = loadSession()
    reportAuthSignal('unauthenticated')
    answer(json(me()))
    await pending
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
  })
  it('re-reads «Я» once for several refusals and applies the withdrawn right', async () => {
    applyMe(me('me.json', { permissions: { moderate_catalog: true } }))
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    reportAuthSignal('forbidden')
    reportAuthSignal('forbidden')
    expect(urls()).toEqual(['/api/me/'])
    expect(canModerate(getSession())).toBe(true)
    answer(json(me()))
    await vi.waitFor(() => { expect(getSession()).toEqual(reader) })
    // A refusal after the read finished starts the next one.
    fetchMock.mockImplementation(async () => json(me()))
    await vi.waitFor(() => { reportAuthSignal('forbidden'); expect(fetchMock.mock.calls.length).toBeGreaterThan(1) })
    expect(urls().every((url) => url === '/api/me/')).toBe(true)
  })
  it('turns a refusal into an expired guest when «Я» answers 401', async () => {
    applyMe(me())
    fetchMock.mockResolvedValueOnce(guestAnswer())
    reportAuthSignal('forbidden')
    await vi.waitFor(() => { expect(getSession()).toEqual({ kind: 'guest', expired: true }) })
  })
  it.each([
    ['loading', () => {}], ['a guest', () => applyMe(null)], ['local_single', () => applyMe(me('me_local_single.json'))],
  ])('ignores both signals for %s', (_name, prepare) => {
    prepare()
    const before = getSession()
    reportAuthSignal('unauthenticated')
    reportAuthSignal('forbidden')
    expect(getSession()).toBe(before)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('rights and texts', () => {
  const states: [Session, boolean][] = [
    [{ kind: 'loading' }, false], [{ kind: 'error' }, false], [{ kind: 'guest', expired: false }, false], [{ kind: 'guest', expired: true }, false],
    [reader, false], [{ ...reader, permissions: { moderate_catalog: true } }, true], [local, true],
    // A staff user without the right is not a moderator.
    [{ ...reader, user: { ...reader.user, is_staff: true } }, false],
  ]
  it.each(states)('canModerate(%j) is %s', (state, expected) => { expect(canModerate(state)).toBe(expected) })
  it('explains 403 as a missing right with accounts and as the switched off local API without them', () => {
    const right = permissionDeniedText(reader)
    expect(right).toBe('Нет права модератора каталога.')
    expect(permissionDeniedText({ ...reader, permissions: { moderate_catalog: true } })).toBe(right)
    for (const state of [local, { kind: 'loading' }, { kind: 'error' }, { kind: 'guest', expired: false }] as Session[]) {
      expect(permissionDeniedText(state)).toContain('ALLOW_LOCAL_RECOGNITION_API=1')
    }
    expect(right).not.toContain('ALLOW_LOCAL_RECOGNITION_API')
  })
})

describe('useSession', () => {
  const Probe = () => {
    const session = useSession()
    return createElement('p', null, session.kind === 'user' ? `${session.mode}:${session.user.username}` : session.kind)
  }
  it('renders the current session without window', () => {
    expect(typeof window).toBe('undefined')
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<p>loading</p>')
    applyMe(me())
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<p>accounts:synthetic-reader</p>')
    applyMe(null)
    expect(renderToStaticMarkup(createElement(Probe))).toBe('<p>guest</p>')
  })
  it('stops telling an unsubscribed listener', () => {
    off()
    applyMe(me())
    expect(seen).toEqual([])
  })
})
