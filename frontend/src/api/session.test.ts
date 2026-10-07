/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { onAuthSignal } from './auth-signal'
import type { AuthSignal } from './auth-signal'
import { cancelJob, clearRecognitionCsrf } from './recognition'
import { publicFixture } from './recognition-test-support'
import { changePassword, clearAuthCsrf, getMe, login, logout } from './session'
import type { Me } from './session'
import { isAuthCsrf, isMe, isPasswordIssues, isRetryAfter } from './session-schema'

/** Read the backend's real answers; never maintain a second copy of them. A fresh object on every call. */
function authFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../backend/api/tests/fixtures/auth/${name}`, import.meta.url), 'utf8'))
}
const me = () => authFixture('me.json') as Me
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const fixture = (name: string, status = 200) => json(authFixture(name), status)
const csrf = () => json({ csrf_token: 'GuestToken1' })
const failure = (code: string, status: number, extra: object = {}) => json({ error: { code, message: 'private server phrase' }, ...extra }, status)
const credentials = { username: 'synthetic-reader', password: 'synthetic-secret-1' }
const passwords = { current_password: 'synthetic-secret-1', new_password: 'synthetic-secret-2' }

const fetchMock = vi.fn<typeof fetch>()
const urls = () => fetchMock.mock.calls.map(([url]) => url)
const signals: AuthSignal[] = []
let off: () => void
function forget() { for (const options of [{}, { baseUrl: '/other' }]) { clearAuthCsrf(options); clearRecognitionCsrf(options) } }
beforeEach(() => {
  forget(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock)
  signals.length = 0; off = onAuthSignal((signal) => { signals.push(signal) })
})
afterEach(() => { off(); forget(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('schema of «Я» on the backend fixtures', () => {
  it.each(['me.json', 'me_local_single.json'])('accepts %s', (name) => { expect(isMe(authFixture(name))).toBe(true) })
  it('keeps additive fields for forward compatibility', () => {
    expect(isMe({ ...me(), extra: 1, user: { ...me().user, email: 'synthetic@example.invalid' } })).toBe(true)
  })
  it.each([
    ['mode', 'other'], ['mode', null], ['user', null], ['user', { id: 0, username: 'a', is_staff: false }],
    ['user', { id: 1.5, username: 'a', is_staff: false }], ['user', { id: 1, username: '', is_staff: false }],
    ['user', { id: 1, username: 'a'.repeat(151), is_staff: false }], ['user', { id: 1, username: 'a', is_staff: 0 }],
    ['user', { id: 1, username: 'a' }], ['permissions', {}], ['permissions', { moderate_catalog: 'yes' }], ['permissions', null],
    ['csrf_token', ''], ['csrf_token', 'with space'], ['csrf_token', 'a'.repeat(129)], ['csrf_token', null],
  ])('rejects %s = %j', (key, value) => { expect(isMe({ ...me(), [key]: value })).toBe(false) })
  it.each(['mode', 'user', 'permissions', 'csrf_token'] as const)('rejects «Я» without %s', (key) => {
    const body: Partial<Me> = me()
    delete body[key]
    expect(isMe(body)).toBe(false)
  })
  it('validates the token before a sign-in, the delay and the password issues', () => {
    expect(isAuthCsrf({ csrf_token: me().csrf_token })).toBe(true)
    for (const invalid of [{}, { csrf_token: '' }, null, 'token']) expect(isAuthCsrf(invalid)).toBe(false)
    expect([1, 900].every(isRetryAfter)).toBe(true)
    for (const invalid of [0, -1, 1.5, '900', null, undefined, Number.MAX_SAFE_INTEGER + 1]) expect(isRetryAfter(invalid)).toBe(false)
    expect(isPasswordIssues(['too_short', 'too_common', 'entirely_numeric', 'too_similar'])).toBe(true)
    expect(isPasswordIssues([])).toBe(true)
    for (const invalid of [['other'], ['too_short', 'too_short'], 'too_short', null, [1]]) expect(isPasswordIssues(invalid)).toBe(false)
  })
})

describe('GET /api/me/', () => {
  it.each(['me.json', 'me_local_single.json'])('reads %s with the session cookie, the trailing slash and an explicit prefix', async (name) => {
    fetchMock.mockResolvedValue(fixture(name))
    expect(await getMe({ baseUrl: '/other/' })).toEqual({ kind: 'ok', data: authFixture(name) })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/other/me/', { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) })
  })
  it('answers not_authenticated for a guest without raising the session signal', async () => {
    fetchMock.mockResolvedValue(failure('not_authenticated', 401))
    const result = await getMe()
    expect(result).toEqual({ kind: 'error', reason: 'not_authenticated', status: 401 })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(signals).toEqual([])
    expect(urls()).toEqual(['/api/me/'])
  })
  it.each([
    [401, 'invalid_credentials'], [401, 'login_throttled'], [403, 'permission_denied'], [404, 'page_out_of_range'],
    [429, 'not_authenticated'], [503, 'database_unavailable'], [200, 'not_authenticated'],
  ])('rejects HTTP %s %s as outside the contract', async (status, code) => {
    fetchMock.mockResolvedValue(failure(code, status))
    expect(await getMe()).toEqual({ kind: 'error', reason: 'invalid_response', status })
    expect(signals).toEqual([])
  })
  it('distinguishes server, network, malformed and cancelled answers', async () => {
    fetchMock.mockResolvedValueOnce(failure('internal_error', 500))
    expect(await getMe()).toEqual({ kind: 'error', reason: 'server', status: 500 })
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    expect(await getMe()).toEqual({ kind: 'error', reason: 'network' })
    fetchMock.mockResolvedValueOnce(json({ ...me(), user: null }))
    expect(await getMe()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
    fetchMock.mockResolvedValueOnce(new Response('<html>', { status: 502 }))
    expect(await getMe()).toEqual({ kind: 'error', reason: 'invalid_response', status: 502 })
    const controller = new AbortController()
    controller.abort()
    expect(await getMe({ signal: controller.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
  it('settles at 15 seconds', async () => {
    vi.useFakeTimers()
    try {
      fetchMock.mockImplementation(() => new Promise(() => {}))
      const pending = getMe()
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('sign-in', () => {
  it('takes the token of auth/csrf/ and posts the credentials once as JSON', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('me.json'))
    expect(await login(credentials, { baseUrl: '/other' })).toEqual({ kind: 'ok', data: me() })
    expect(urls()).toEqual(['/other/auth/csrf/', '/other/auth/login/'])
    expect(fetchMock.mock.calls[0][1]).toEqual({ headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) })
    expect(fetchMock.mock.calls[1][1]).toEqual({
      method: 'POST', body: JSON.stringify(credentials), credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal),
      headers: { Accept: 'application/json', 'X-CSRFToken': 'GuestToken1', 'Content-Type': 'application/json' },
    })
  })
  it('sends only the two documented keys', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('me.json'))
    await login({ ...credentials, remember: true } as typeof credentials)
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual(credentials)
  })
  it('reports wrong credentials of login_invalid.json without the session signal, the phrase or a retry', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('login_invalid.json', 401))
    const result = await login(credentials)
    expect(result).toEqual({ kind: 'error', reason: 'invalid_credentials', status: 401 })
    expect(JSON.stringify(result)).not.toMatch(/Неверный|secret/)
    expect(signals).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The token is still valid: the next explicit attempt is one request.
    fetchMock.mockResolvedValueOnce(fixture('me.json'))
    expect((await login(credentials)).kind).toBe('ok')
    expect(urls().slice(2)).toEqual(['/api/auth/login/'])
  })
  it('reads the delay of login_throttled.json from the body', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('login_throttled.json', 429))
    const result = await login(credentials)
    expect(result).toEqual({ kind: 'error', reason: 'login_throttled', status: 429, retryAfter: 900 })
    expect(JSON.stringify(result)).not.toContain('Слишком')
    expect(signals).toEqual([])
  })
  it.each([{}, { retry_after: 0 }, { retry_after: '900' }, { retry_after: null }, { retry_after: 1.5 }])(
    'rejects a delay without a usable term %j', async (extra) => {
      fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure('login_throttled', 429, extra))
      expect(await login(credentials)).toEqual({ kind: 'error', reason: 'invalid_response', status: 429 })
    })
  it.each([
    [401, 'not_authenticated'], [400, 'invalid_credentials'], [429, 'invalid_credentials'], [403, 'permission_denied'],
    [415, 'unsupported_media_type'], [405, 'method_not_allowed'],
  ])('rejects HTTP %s %s as outside the contract', async (status, code) => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure(code, status, { retry_after: 900 }))
    expect(await login(credentials)).toEqual({ kind: 'error', reason: 'invalid_response', status })
    expect(signals).toEqual([])
  })
  it('keeps field names of invalid_parameter and nothing else of invalid_request', async () => {
    fetchMock.mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(json({ error: { code: 'invalid_parameter', message: 'private', fields: { password: ['private'] } } }, 400))
      .mockResolvedValueOnce(failure('invalid_request', 400))
    expect(await login(credentials)).toEqual({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['password'] })
    expect(await login(credentials)).toEqual({ kind: 'error', reason: 'invalid_request', status: 400 })
  })
  it('answers not_found where the server has no accounts (local_single)', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure('not_found', 404))
    expect(await login(credentials)).toEqual({ kind: 'error', reason: 'not_found', status: 404 })
  })
  it('drops a refused token, never replays the POST and asks for a new token on the next attempt', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure('csrf_failed', 403))
    expect(await login(credentials)).toEqual({ kind: 'error', reason: 'csrf_failed', status: 403 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    fetchMock.mockResolvedValueOnce(json({ csrf_token: 'GuestToken2' })).mockResolvedValueOnce(fixture('me.json'))
    expect((await login(credentials)).kind).toBe('ok')
    expect(urls().slice(2)).toEqual(['/api/auth/csrf/', '/api/auth/login/'])
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({ 'X-CSRFToken': 'GuestToken2' })
  })
  it.each([
    ['a broken connection', () => Promise.reject(new TypeError('offline')), { kind: 'error', reason: 'network' }],
    ['a malformed token', async () => json({ csrf_token: '' }), { kind: 'error', reason: 'invalid_response', status: 200 }],
    ['a refused token request', async () => failure('not_authenticated', 401), { kind: 'error', reason: 'invalid_response', status: 401 }],
  ])('does not post the password after %s of auth/csrf/', async (_name, answer, expected) => {
    fetchMock.mockImplementationOnce(answer)
    expect(await login(credentials)).toEqual(expected)
    expect(urls()).toEqual(['/api/auth/csrf/'])
    expect(signals).toEqual([])
  })
  it('does not fetch for a pre-aborted signal and stops between the token and the POST', async () => {
    const aborted = new AbortController()
    aborted.abort()
    expect(await login(credentials, { signal: aborted.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
    const controller = new AbortController()
    fetchMock.mockImplementationOnce(async () => { controller.abort(); return csrf() })
    expect(await login(credentials, { signal: controller.signal })).toEqual({ kind: 'aborted' })
    expect(urls()).toEqual(['/api/auth/csrf/'])
  })
  it('keeps tokens isolated by API prefix', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('login_invalid.json', 401))
      .mockResolvedValueOnce(json({ csrf_token: 'OtherToken' })).mockResolvedValueOnce(fixture('login_invalid.json', 401))
    await login(credentials)
    await login(credentials, { baseUrl: '/other' })
    expect(urls()).toEqual(['/api/auth/csrf/', '/api/auth/login/', '/other/auth/csrf/', '/other/auth/login/'])
    expect(fetchMock.mock.calls[3][1]?.headers).toMatchObject({ 'X-CSRFToken': 'OtherToken' })
  })
})

describe('the token after the session changed', () => {
  const recognitionCsrf = () => json(publicFixture('csrf.json'))
  const job = () => json(publicFixture('job.json'), 202)
  it('uses the token of «Я» for the next POST of the sign-in routes', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('me.json')).mockResolvedValueOnce(fixture('me.json'))
    await login(credentials)
    expect((await changePassword(passwords)).kind).toBe('ok')
    expect(urls()).toEqual(['/api/auth/csrf/', '/api/auth/login/', '/api/auth/password/'])
    expect(fetchMock.mock.calls[2][1]?.headers).toMatchObject({ 'X-CSRFToken': me().csrf_token })
  })
  it.each([
    ['a sign-in', () => login(credentials), () => fixture('me.json')],
    ['a password change', () => changePassword(passwords), () => fixture('me.json')],
    ['a sign-out', () => logout(), () => new Response(null, { status: 204 })],
  ])('forgets the token of the local API after %s', async (_name, call, answer) => {
    fetchMock.mockResolvedValueOnce(recognitionCsrf()).mockResolvedValueOnce(job())
    expect((await cancelJob(31)).kind).toBe('ok')
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(answer())
    expect((await call()).kind).toBe('ok')
    fetchMock.mockResolvedValueOnce(recognitionCsrf()).mockResolvedValueOnce(job())
    expect((await cancelJob(31)).kind).toBe('ok')
    expect(urls().slice(4)).toEqual(['/api/recognition/csrf/', '/api/recognition/jobs/31/cancel/'])
  })
  it('keeps the token of the local API after a refused sign-in', async () => {
    fetchMock.mockResolvedValueOnce(recognitionCsrf()).mockResolvedValueOnce(job())
    await cancelJob(31)
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('login_invalid.json', 401))
    await login(credentials)
    fetchMock.mockResolvedValueOnce(job())
    expect((await cancelJob(31)).kind).toBe('ok')
    expect(urls().slice(4)).toEqual(['/api/recognition/jobs/31/cancel/'])
  })
})

describe('sign-out', () => {
  it('posts {} and accepts 204 without a body, then asks for a new token', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await logout()).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}', credentials: 'same-origin', headers: { 'X-CSRFToken': 'GuestToken1', 'Content-Type': 'application/json' } })
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('login_invalid.json', 401))
    await login(credentials)
    expect(urls()).toEqual(['/api/auth/csrf/', '/api/auth/logout/', '/api/auth/csrf/', '/api/auth/login/'])
  })
  it('does not read the body of 204 at all', async () => {
    const read = vi.fn(() => Promise.reject(new TypeError('no body')))
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce({ status: 204, json: read } as unknown as Response)
    expect(await logout()).toEqual({ kind: 'ok', data: null })
    expect(read).not.toHaveBeenCalled()
  })
  it.each([[200, {}], [200, null], [201, {}]])('rejects HTTP %s with a body %j', async (status, body) => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(body, status))
    expect(await logout()).toEqual({ kind: 'error', reason: 'invalid_response', status })
  })
  it.each([[404, 'not_found', 'not_found'], [403, 'csrf_failed', 'csrf_failed'], [500, 'internal_error', 'server'], [400, 'invalid_request', 'invalid_request']])(
    'reports HTTP %s %s', async (status, code, reason) => {
      fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure(code, status))
      expect(await logout()).toEqual({ kind: 'error', reason, status })
    })
  it('is never repeated after a broken connection', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockRejectedValueOnce(new TypeError('offline'))
    expect(await logout()).toEqual({ kind: 'error', reason: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('password change', () => {
  it('posts both passwords and returns «Я» of the same session', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('me.json'))
    expect(await changePassword(passwords)).toEqual({ kind: 'ok', data: me() })
    expect(urls()).toEqual(['/api/auth/csrf/', '/api/auth/password/'])
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: JSON.stringify(passwords) })
  })
  it('reads the field and the issue codes of password_invalid.json without server phrases', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('password_invalid.json', 400))
    const result = await changePassword(passwords)
    expect(result).toEqual({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['new_password'], passwordIssues: ['too_short', 'entirely_numeric'] })
    expect(JSON.stringify(result)).not.toMatch(/Пароль|secret/)
  })
  it('reports a wrong current password by its field only', async () => {
    fetchMock.mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(json({ error: { code: 'invalid_parameter', message: 'private', fields: { current_password: ['private'] } } }, 400))
    expect(await changePassword(passwords)).toEqual({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['current_password'] })
  })
  it('accepts a refusal with an empty list of issues as a refusal without causes', async () => {
    fetchMock.mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(json({ error: { code: 'invalid_parameter', message: 'private', fields: { new_password: ['private'] } }, password_issues: [] }, 400))
    expect(await changePassword(passwords)).toEqual({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['new_password'] })
  })
  it.each([
    { password_issues: ['unknown'] }, { password_issues: 'too_short' }, { password_issues: null }, { password_issues: ['too_short', 'too_short'] },
  ])('rejects malformed issue codes %j', async (extra) => {
    fetchMock.mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(json({ error: { code: 'invalid_parameter', message: 'private', fields: { new_password: ['private'] } }, ...extra }, 400))
    expect(await changePassword(passwords)).toEqual({ kind: 'error', reason: 'invalid_response', status: 400 })
  })
  it('reads the delay shared with the sign-in', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('login_throttled.json', 429))
    expect(await changePassword(passwords)).toEqual({ kind: 'error', reason: 'login_throttled', status: 429, retryAfter: 900 })
  })
  it('treats a session that ended meanwhile like any other request: aborted and one signal', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure('not_authenticated', 401))
    expect(await changePassword(passwords)).toEqual({ kind: 'aborted' })
    expect(signals).toEqual(['unauthenticated'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
  it('does not take invalid_credentials for the end of the session', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(fixture('login_invalid.json', 401))
    expect(await changePassword(passwords)).toEqual({ kind: 'error', reason: 'invalid_response', status: 401 })
    expect(signals).toEqual([])
  })
})
