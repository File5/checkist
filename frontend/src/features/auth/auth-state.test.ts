/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecognitionCsrf } from '../../api/local'
import { changePassword, clearAuthCsrf, login, logout } from '../../api/session'
import type { AuthFailure, AuthResult, Me } from '../../api/session'
import type { Route } from '../../navigation'
import { applyMe, getSession } from '../../session'
import type { Session } from '../../session'
import { resetSession } from '../../session/store'
import { checkLogin, checkPassword, createAuthForm, pageKey, shellView, watchSession } from './auth-state'
import type { FormState, LoginInput, PasswordInput, ShellView } from './auth-state'
import { loginRefusal, logoutRefusal, passwordChangedText, passwordRefusal, waitText } from './labels'

/** The backend's real answers; never a second copy of them. */
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../../backend/api/tests/fixtures/auth/${name}`, import.meta.url), 'utf8'))
const me = () => fixture('me.json') as Me
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const failure = (reason: AuthFailure['reason'], extra: Partial<AuthFailure> = {}): AuthFailure => ({ kind: 'error', reason, ...extra })
const user = (id: number, moderate: boolean, mode: Me['mode'] = 'accounts'): Session => (
  { kind: 'user', mode, user: { id, username: `synthetic-${id}`, is_staff: false }, permissions: { moderate_catalog: moderate } })
const serverPhrases = ['Некорректные параметры запроса', 'Пароль слишком короткий', 'Пароль не может состоять только из цифр']

function form<I>(send: (input: I, signal: AbortSignal) => Promise<AuthResult<Me>>, check?: (input: I) => ReturnType<typeof checkLogin>) {
  const success = vi.fn<(data: Me) => string | void>()
  const result = createAuthForm({ check, send, refusal: loginRefusal, success })
  const states: FormState['kind'][] = []
  result.subscribe(() => states.push(result.getSnapshot().kind))
  return { ...result, success, states }
}
const credentials: LoginInput = { username: 'synthetic-reader', password: 'synthetic-password' }

describe('what the shell shows in place of the page', () => {
  const reader = user(1, false)
  const moderator = user(2, true)
  const local = user(1, true, 'local_single')
  const routes: Route[] = [
    { kind: 'catalog', query: { page: 1 } }, { kind: 'category', categoryId: 3, query: { page: 1 } },
    { kind: 'product', productId: 5, query: { page: 1 } }, { kind: 'spending', query: {} }, { kind: 'receipts-stats', query: {} },
    { kind: 'receipts', query: { page: 1 } }, { kind: 'upload' }, { kind: 'receipt', receiptId: 7 },
    { kind: 'jobs', query: { page: 1 } }, { kind: 'job', jobId: 9 },
    { kind: 'merges', query: { page: 1 } }, { kind: 'merge', groupId: 2 }, { kind: 'classification', query: { page: 1 } },
    { kind: 'account' }, { kind: 'login' }, { kind: 'not-found', path: '/missing' },
    { kind: 'invalid-query', path: '/catalog', fields: ['page'], resetTo: '/catalog' },
  ]
  const moderated = ['merges', 'merge', 'classification']

  it.each<[Session, ShellView]>([
    [{ kind: 'loading' }, 'loading'], [{ kind: 'error' }, 'error'],
    [{ kind: 'guest', expired: false }, 'login'], [{ kind: 'guest', expired: true }, 'login'],
  ])('%o replaces every page except health with %s', (session, view) => {
    for (const route of routes) expect(shellView(session, route), route.kind).toBe(view)
    expect(shellView(session, { kind: 'health' })).toBe('page')
  })
  it('opens every page for a moderator and hides only the moderator sections from a reader', () => {
    for (const route of routes) {
      expect(shellView(moderator, route), route.kind).toBe('page')
      expect(shellView(reader, route), route.kind).toBe(moderated.includes(route.kind) ? 'forbidden' : 'page')
    }
  })
  it('keeps local_single as before: every page, and neither an account page nor a sign-in address', () => {
    for (const route of routes) expect(shellView(local, route), route.kind).toBe(route.kind === 'account' || route.kind === 'login' ? 'not-found' : 'page')
    expect(shellView(local, { kind: 'health' })).toBe('page')
  })
  it('creates the page again for another person, another mode and after a sign-in, but not for a changed right', () => {
    expect(pageKey(reader)).not.toBe(pageKey(moderator))
    expect(pageKey(user(1, true, 'accounts'))).not.toBe(pageKey(local))
    expect(pageKey({ kind: 'guest', expired: true })).not.toBe(pageKey(reader))
    expect(pageKey(user(1, true))).toBe(pageKey(user(1, false)))
    expect(pageKey({ kind: 'guest', expired: true })).toBe(pageKey({ kind: 'guest', expired: false }))
  })
})

describe('re-reading «Я» when the tab comes back', () => {
  function page(visibilityState: DocumentVisibilityState) {
    const listeners = new Map<string, EventListenerOrEventListenerObject>()
    const target = {
      visibilityState,
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => { listeners.set(type, listener) }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => { if (listeners.get(type) === listener) listeners.delete(type) }),
    }
    const fire = () => { (listeners.get('visibilitychange') as (() => void) | undefined)?.() }
    return { target: target as unknown as Document, state: target, fire, listeners }
  }
  it('reads at once, again on every return to the tab and never while the tab is hidden', () => {
    const read = vi.fn()
    const { target, state, fire } = page('visible')
    const stop = watchSession(read, target)
    expect(read).toHaveBeenCalledTimes(1)
    state.visibilityState = 'hidden'; fire()
    expect(read).toHaveBeenCalledTimes(1)
    state.visibilityState = 'visible'; fire(); fire()
    expect(read).toHaveBeenCalledTimes(3)
    stop()
  })
  it('aborts its reads and stops listening on cleanup', () => {
    const read = vi.fn<(signal: AbortSignal) => void>()
    const { target, fire, listeners } = page('visible')
    const stop = watchSession(read, target)
    const signal = read.mock.calls[0][0]
    expect(signal.aborted).toBe(false)
    stop()
    expect(signal.aborted).toBe(true)
    expect(listeners.size).toBe(0)
    fire()
    expect(read).toHaveBeenCalledTimes(1)
  })
})

describe('checks before any request', () => {
  it.each<[LoginInput, string[] | undefined]>([
    [{ username: '', password: '' }, ['username', 'password']],
    [{ username: '   ', password: 'x' }, ['username']],
    [{ username: 'anna', password: '' }, ['password']],
    [{ username: ' anna ', password: ' ' }, undefined],
  ])('sign-in %o → %o', (input, fields) => {
    expect(checkLogin(input)?.fields).toEqual(fields)
  })
  it.each<[PasswordInput, string[] | undefined, string | undefined]>([
    [{ current_password: '', new_password: '', repeat: '' }, ['current_password', 'new_password', 'repeat'], 'Заполните'],
    [{ current_password: 'a', new_password: 'b', repeat: '' }, ['repeat'], 'Заполните'],
    [{ current_password: 'a', new_password: 'b', repeat: 'c' }, ['repeat'], 'не совпадают'],
    [{ current_password: 'a', new_password: 'b', repeat: 'b' }, undefined, undefined],
  ])('password change %o → %o', (input, fields, text) => {
    const refusal = checkPassword(input)
    expect(refusal?.fields).toEqual(fields)
    if (text) expect(refusal?.message).toContain(text)
  })
})

describe('one form, one POST', () => {
  it('sends nothing while a field is empty and marks the fields', async () => {
    const send = vi.fn(async (): Promise<AuthResult<Me>> => ({ kind: 'ok', data: me() }))
    const login = form(send, checkLogin)
    await login.run({ username: '', password: '' })
    expect(send).not.toHaveBeenCalled()
    expect(login.getSnapshot()).toEqual({ kind: 'failed', message: 'Введите имя пользователя и пароль.', fields: ['username', 'password'], details: [] })
    expect(login.states).toEqual(['failed'])
  })
  it('ignores a second press during the request', async () => {
    let finish!: (result: AuthResult<Me>) => void
    const send = vi.fn(() => new Promise<AuthResult<Me>>((resolve) => { finish = resolve }))
    const login = form(send, checkLogin)
    const first = login.run(credentials)
    await login.run(credentials)
    await login.run({ username: 'other', password: 'other' })
    expect(send).toHaveBeenCalledExactlyOnceWith(credentials, expect.any(AbortSignal))
    expect(login.getSnapshot()).toEqual({ kind: 'pending' })
    finish({ kind: 'ok', data: me() })
    await first
    expect(login.success).toHaveBeenCalledExactlyOnceWith(me())
    expect(login.states).toEqual(['pending', 'idle'])
  })
  it('never replays a refused POST and lets the person try again', async () => {
    const send = vi.fn<() => Promise<AuthResult<Me>>>()
      .mockResolvedValueOnce(failure('invalid_credentials', { status: 401 }))
      .mockResolvedValueOnce({ kind: 'ok', data: me() })
    const login = form(send, checkLogin)
    await login.run(credentials)
    expect(send).toHaveBeenCalledTimes(1)
    expect(login.getSnapshot()).toEqual({ kind: 'failed', message: 'Неверное имя пользователя или пароль.', fields: [], details: [] })
    expect(login.success).not.toHaveBeenCalled()
    await login.run(credentials)
    expect(send).toHaveBeenCalledTimes(2)
    expect(login.states).toEqual(['pending', 'failed', 'pending', 'idle'])
  })
  it('shows the text returned by a success', async () => {
    const result = createAuthForm({
      send: async (): Promise<AuthResult<Me>> => ({ kind: 'ok', data: me() }), refusal: passwordRefusal, success: () => passwordChangedText,
    })
    await result.run(null)
    expect(result.getSnapshot()).toEqual({ kind: 'done', message: passwordChangedText })
  })
  it('treats a thrown request as a lost answer', async () => {
    const login = form(async () => { throw new Error('offline') }, checkLogin)
    await login.run(credentials)
    expect(login.getSnapshot()).toMatchObject({ kind: 'failed', message: 'Нет ответа сервера. Проверьте соединение и повторите вход.' })
  })
  it('returns to rest without a message when the session ended meanwhile', async () => {
    const login = form(async () => ({ kind: 'aborted' }))
    await login.run(credentials)
    expect(login.getSnapshot()).toEqual({ kind: 'idle' })
    expect(login.states).toEqual(['pending', 'idle'])
  })
  it('aborts the request of a removed form, drops its answer and works again after a remount', async () => {
    let finish!: (result: AuthResult<Me>) => void
    const signals: AbortSignal[] = []
    const send = vi.fn((_input: LoginInput, signal: AbortSignal) => {
      signals.push(signal)
      return new Promise<AuthResult<Me>>((resolve) => { finish = resolve })
    })
    const login = form(send)
    const first = login.run(credentials)
    login.dispose()
    expect(signals[0].aborted).toBe(true)
    finish({ kind: 'ok', data: me() })
    await first
    expect(login.success).not.toHaveBeenCalled()
    const second = login.run(credentials)
    expect(send).toHaveBeenCalledTimes(2)
    finish({ kind: 'ok', data: me() })
    await second
    expect(login.success).toHaveBeenCalledTimes(1)
  })
})

describe('texts of refusals: local translations only', () => {
  it.each<[number | undefined, string]>([
    [1, 'Повторите через 1 минуту.'], [60, 'Повторите через 1 минуту.'], [61, 'Повторите через 2 минуты.'],
    [240, 'Повторите через 4 минуты.'], [300, 'Повторите через 5 минут.'], [660, 'Повторите через 11 минут.'],
    [900, 'Повторите через 15 минут.'], [1260, 'Повторите через 21 минуту.'], [undefined, 'Повторите позже.'],
  ])('a delay of %s s reads «%s»', (seconds, text) => {
    expect(waitText(seconds)).toBe(text)
  })
  it.each<[AuthFailure, string]>([
    [failure('invalid_credentials'), 'Неверное имя пользователя или пароль.'],
    [failure('login_throttled', { retryAfter: 900 }), 'Слишком много попыток входа. Повторите через 15 минут.'],
    [failure('csrf_failed'), 'Токен безопасности устарел. Вход не выполнен: нажмите «Войти» ещё раз.'],
    [failure('network'), 'Нет ответа сервера. Проверьте соединение и повторите вход.'],
    [failure('timeout'), 'Нет ответа сервера. Проверьте соединение и повторите вход.'],
    [failure('invalid_parameter', { fields: ['username'] }), 'Запрос отклонён: проверьте имя пользователя и пароль.'],
    [failure('server'), 'Сервис временно недоступен. Повторите позже.'],
    [failure('invalid_response'), 'Ответ сервера не соответствует ожидаемому формату. Повторите позже.'],
    [failure('not_found'), 'Вход по паролю на этом сервере не используется. Обновите страницу.'],
  ])('sign-in %o', (refused, text) => {
    expect(loginRefusal(refused)).toEqual({ message: text })
  })
  it('names a wrong current password, the refused rules of a new one, or all four rules without codes', () => {
    expect(passwordRefusal(failure('invalid_parameter', { fields: ['current_password'] })))
      .toEqual({ message: 'Текущий пароль неверный.', fields: ['current_password'] })
    expect(passwordRefusal(failure('invalid_parameter', { fields: ['new_password'], passwordIssues: ['entirely_numeric', 'too_short'] }))).toEqual({
      message: 'Новый пароль не подходит. Пароль:', fields: ['new_password'],
      details: ['не короче 8 символов', 'не должен состоять только из цифр'],
    })
    expect(passwordRefusal(failure('invalid_parameter', { fields: ['new_password'] })).details).toEqual([
      'не должен быть похож на имя пользователя', 'не короче 8 символов', 'не должен быть распространённым паролем', 'не должен состоять только из цифр',
    ])
    expect(passwordRefusal(failure('invalid_parameter', { fields: ['current_password', 'new_password'], passwordIssues: ['too_common'] }))).toEqual({
      message: 'Текущий пароль неверный, новый пароль не подходит. Новый пароль:', fields: ['current_password', 'new_password'],
      details: ['не должен быть распространённым паролем'],
    })
    expect(passwordRefusal(failure('invalid_parameter', { fields: ['unknown'] }))).toEqual({ message: 'Запрос отклонён: проверьте оба пароля.' })
  })
  it('warns that a lost answer may hide a completed change or sign-out', () => {
    expect(passwordRefusal(failure('timeout')).message).toContain('Пароль мог измениться')
    expect(passwordRefusal(failure('login_throttled', { retryAfter: 61 })).message).toBe('Слишком много попыток с неверным паролем. Повторите через 2 минуты.')
    expect(logoutRefusal(failure('network')).message).toContain('Выход мог выполниться')
    expect(logoutRefusal(failure('csrf_failed')).message).toContain('Выход не выполнен')
  })
})

describe('forms over the real adapters (mocked fetch, the backend\'s fixtures)', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const calls = () => fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`)
  const csrf = () => json({ csrf_token: 'SyntheticToken0123456789' })
  beforeEach(() => { clearAuthCsrf(); clearRecognitionCsrf(); resetSession(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { clearAuthCsrf(); clearRecognitionCsrf(); resetSession(); vi.unstubAllGlobals() })

  const loginForm = () => createAuthForm({
    check: checkLogin, send: (input: LoginInput, signal) => login(input, { signal }), refusal: loginRefusal, success: (data) => { applyMe(data) },
  })

  it('signs in with one POST and hands «Я» to the session', async () => {
    applyMe(null)
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(me()))
    const result = loginForm()
    await result.run(credentials)
    expect(calls()).toEqual(['GET /api/auth/csrf/', 'POST /api/auth/login/'])
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual(credentials)
    expect(getSession()).toEqual({ kind: 'user', mode: 'accounts', user: me().user, permissions: me().permissions })
    expect(result.getSnapshot()).toEqual({ kind: 'idle' })
  })
  it('shows the wrong password once, keeps the guest and does not repeat the POST', async () => {
    applyMe(null)
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(fixture('login_invalid.json'), 401))
    const result = loginForm()
    await result.run(credentials)
    expect(calls()).toEqual(['GET /api/auth/csrf/', 'POST /api/auth/login/'])
    expect(result.getSnapshot()).toEqual({ kind: 'failed', message: 'Неверное имя пользователя или пароль.', fields: [], details: [] })
    expect(getSession()).toEqual({ kind: 'guest', expired: false })
  })
  it('reads the delay of the sign-in from the body as minutes', async () => {
    applyMe(null)
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(fixture('login_throttled.json'), 429))
    const result = loginForm()
    await result.run(credentials)
    const state = result.getSnapshot()
    expect(state).toMatchObject({ kind: 'failed', message: 'Слишком много попыток входа. Повторите через 15 минут.' })
    expect(calls().filter((call) => call.startsWith('POST'))).toHaveLength(1)
  })
  it('translates a refused new password by its codes, never by the server\'s phrases', async () => {
    applyMe(me())
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(fixture('password_invalid.json'), 400))
    const result = createAuthForm({
      check: checkPassword,
      send: (input: PasswordInput, signal) => changePassword({ current_password: input.current_password, new_password: input.new_password }, { signal }),
      refusal: passwordRefusal, success: (data) => { applyMe(data); return passwordChangedText },
    })
    await result.run({ current_password: 'synthetic-old', new_password: '12345', repeat: '12345' })
    expect(JSON.parse(fetchMock.mock.calls[1][1]!.body as string)).toEqual({ current_password: 'synthetic-old', new_password: '12345' })
    const state = result.getSnapshot()
    expect(state).toEqual({ kind: 'failed', message: 'Новый пароль не подходит. Пароль:', fields: ['new_password'],
      details: ['не короче 8 символов', 'не должен состоять только из цифр'] })
    for (const phrase of serverPhrases) expect(JSON.stringify(state)).not.toContain(phrase)
  })
  it('keeps the session after a password change and reports it', async () => {
    applyMe(me())
    const before = getSession()
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(me()))
    const result = createAuthForm({
      check: checkPassword,
      send: (input: PasswordInput, signal) => changePassword({ current_password: input.current_password, new_password: input.new_password }, { signal }),
      refusal: passwordRefusal, success: (data) => { applyMe(data); return passwordChangedText },
    })
    await result.run({ current_password: 'synthetic-old', new_password: 'synthetic-new-9', repeat: 'synthetic-new-9' })
    expect(calls()).toEqual(['GET /api/auth/csrf/', 'POST /api/auth/password/'])
    expect(result.getSnapshot()).toEqual({ kind: 'done', message: passwordChangedText })
    // The same snapshot: the page of this person is not created again.
    expect(getSession()).toBe(before)
  })
  it('ends the session without a message of its own when the password change answers 401', async () => {
    applyMe(me())
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json({ error: { code: 'not_authenticated', message: 'Требуется вход.' } }, 401))
    const result = createAuthForm({
      send: (input: PasswordInput, signal) => changePassword({ current_password: input.current_password, new_password: input.new_password }, { signal }),
      refusal: passwordRefusal, success: (data: Me) => { applyMe(data) },
    })
    await result.run({ current_password: 'a', new_password: 'b', repeat: 'b' })
    expect(result.getSnapshot()).toEqual({ kind: 'idle' })
    expect(getSession()).toEqual({ kind: 'guest', expired: true })
  })
  it('signs out with one POST and leaves a guest whose session did not «expire»', async () => {
    applyMe(me())
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(new Response(null, { status: 204 }))
    const result = createAuthForm({ send: (_input: null, signal) => logout({ signal }), refusal: logoutRefusal, success: () => { applyMe(null) } })
    await result.run(null)
    expect(calls()).toEqual(['GET /api/auth/csrf/', 'POST /api/auth/logout/'])
    expect(getSession()).toEqual({ kind: 'guest', expired: false })
  })
  it('stays signed in when the sign-out is refused', async () => {
    applyMe(me())
    fetchMock.mockResolvedValueOnce(csrf()).mockRejectedValueOnce(new TypeError('offline'))
    const result = createAuthForm({ send: (_input: null, signal) => logout({ signal }), refusal: logoutRefusal, success: () => { applyMe(null) } })
    await result.run(null)
    expect(result.getSnapshot()).toMatchObject({ kind: 'failed', message: expect.stringContaining('Выход мог выполниться') })
    expect(getSession().kind).toBe('user')
  })
})
