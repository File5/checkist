import { afterEach, describe, expect, it, vi } from 'vitest'
import { afterEdit, createLoginFlow, emptyFields, fieldError, initialLoginState, isLocked, loginMessage, loginOutcomes, resolveOutcome, unavailableHandler } from './login-state'
import type { LoginFailure, LoginHandler, LoginOutcome, LoginState } from './login-state'

const secret = 'S3cret-пароль'
const noop = () => {}

/** A handler whose answer the test gives later. */
function deferred() {
  let resolve!: (outcome: LoginOutcome) => void
  let reject!: (reason: unknown) => void
  const calls: [string, string][] = []
  const handler: LoginHandler = (login, password) => {
    calls.push([login, password])
    return new Promise<LoginOutcome>((onResolve, onReject) => { resolve = onResolve; reject = onReject })
  }
  return { handler, calls, resolve: (outcome: LoginOutcome) => resolve(outcome), reject: (reason: unknown) => reject(reason) }
}

/** A mounted screen: one subscriber that records every published state. */
function mounted() {
  const flow = createLoginFlow()
  const seen: LoginState[] = []
  const unmount = flow.subscribe(() => seen.push(flow.getSnapshot()))
  return { flow, seen, unmount }
}

afterEach(() => { vi.restoreAllMocks() })

describe('empty fields', () => {
  it('lists them in the order of the form', () => {
    expect(emptyFields('', '')).toEqual(['login', 'password'])
    expect(emptyFields('agent', '')).toEqual(['password'])
    expect(emptyFields('', secret)).toEqual(['login'])
    expect(emptyFields('agent', secret)).toEqual([])
  })
  it('treats a login of spaces as empty and keeps a password of spaces', () => {
    expect(emptyFields('   ', ' ')).toEqual(['login'])
    expect(emptyFields('\t\n', secret)).toEqual(['login'])
  })
  it('names the error of each marked field only', () => {
    const state: LoginState = { kind: 'empty', fields: ['password'] }
    expect(fieldError(state, 'password')).toBe('Введите пароль')
    expect(fieldError(state, 'login')).toBeUndefined()
    expect(fieldError({ kind: 'empty', fields: ['login', 'password'] }, 'login')).toBe('Введите логин')
    for (const other of [initialLoginState, { kind: 'submitting' }, { kind: 'failed', outcome: 'invalid' }, { kind: 'entered' }] as LoginState[]) {
      expect(fieldError(other, 'login')).toBeUndefined()
      expect(fieldError(other, 'password')).toBeUndefined()
    }
  })
  it('drops the error of a field once something is typed into it', () => {
    const both: LoginState = { kind: 'empty', fields: ['login', 'password'] }
    expect(afterEdit(both, 'login', 'a')).toEqual({ kind: 'empty', fields: ['password'] })
    expect(afterEdit({ kind: 'empty', fields: ['password'] }, 'password', ' ')).toEqual(initialLoginState)
  })
  it('keeps the error while the field is still empty and ignores typing elsewhere', () => {
    const both: LoginState = { kind: 'empty', fields: ['login', 'password'] }
    expect(afterEdit(both, 'login', '  ')).toBe(both)
    expect(afterEdit(both, 'password', '')).toBe(both)
    const password: LoginState = { kind: 'empty', fields: ['password'] }
    expect(afterEdit(password, 'login', 'agent')).toBe(password)
    for (const other of [initialLoginState, { kind: 'submitting' }, { kind: 'failed', outcome: 'network' }, { kind: 'entered' }] as LoginState[]) {
      expect(afterEdit(other, 'login', 'agent')).toBe(other)
    }
  })
})

describe('message of the form', () => {
  const failed = (outcome: LoginFailure) => loginMessage({ kind: 'failed', outcome })
  it('says nothing before an answer', () => {
    expect(loginMessage(initialLoginState)).toBeUndefined()
    expect(loginMessage({ kind: 'empty', fields: ['login'] })).toBeUndefined()
    expect(loginMessage({ kind: 'submitting' })).toBeUndefined()
  })
  it('explains that sign-in is not connected and offers the catalog', () => {
    expect(failed('unavailable')).toEqual({ tone: 'info', text: 'Вход пока не подключён: пропускной режим не введён', catalogLink: true })
  })
  it('words every refusal exactly', () => {
    expect(failed('invalid')).toEqual({ tone: 'error', text: 'Неверный логин или пароль', catalogLink: false })
    expect(failed('throttled')).toEqual({ tone: 'warning', text: 'Слишком много попыток. Повторите позже', catalogLink: false })
    expect(failed('network')).toEqual({ tone: 'error', text: 'Не удалось связаться с сервером. Повторите попытку', catalogLink: false })
  })
  it('confirms a successful sign-in', () => {
    expect(loginMessage({ kind: 'entered' })).toEqual({ tone: 'success', text: 'Вход выполнен. Открываем каталог…', catalogLink: false })
  })
  it('covers every outcome', () => {
    expect([...loginOutcomes].sort()).toEqual(['invalid', 'network', 'ok', 'throttled', 'unavailable'])
    for (const outcome of loginOutcomes.filter((item): item is LoginFailure => item !== 'ok')) expect(failed(outcome)?.text).toBeTruthy()
  })
  it('locks the form only while submitting and after signing in', () => {
    expect(isLocked({ kind: 'submitting' })).toBe(true)
    expect(isLocked({ kind: 'entered' })).toBe(true)
    for (const open of [initialLoginState, { kind: 'empty', fields: ['login'] }, { kind: 'failed', outcome: 'invalid' }] as LoginState[]) expect(isLocked(open)).toBe(false)
  })
})

describe('handler seam', () => {
  it('answers unavailable by default and makes no request', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    try {
      expect(await unavailableHandler('agent', secret)).toBe('unavailable')
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
  it('passes every known outcome through', async () => {
    for (const outcome of loginOutcomes) expect(await resolveOutcome(async () => outcome, 'agent', secret)).toBe(outcome)
  })
  it('reads a rejected, throwing or unknown answer as a failed connection', async () => {
    expect(await resolveOutcome(() => Promise.reject(new Error('offline')), 'agent', secret)).toBe('network')
    expect(await resolveOutcome(() => { throw new Error('broken') }, 'agent', secret)).toBe('network')
    expect(await resolveOutcome((async () => 'maybe') as unknown as LoginHandler, 'agent', secret)).toBe('network')
    expect(await resolveOutcome((async () => undefined) as unknown as LoginHandler, 'agent', secret)).toBe('network')
  })
})

describe('flow of one screen', () => {
  it('starts idle', () => {
    expect(createLoginFlow().getSnapshot()).toBe(initialLoginState)
  })

  it('refuses empty fields without calling the handler and points at the first one', async () => {
    const { flow, seen } = mounted()
    const handler = vi.fn<LoginHandler>()
    const both = flow.submit('', '', handler, noop)
    expect(both.focus).toBe('login')
    expect(flow.getSnapshot()).toEqual({ kind: 'empty', fields: ['login', 'password'] })
    expect(flow.submit('agent', '', handler, noop).focus).toBe('password')
    expect(flow.getSnapshot()).toEqual({ kind: 'empty', fields: ['password'] })
    expect(flow.submit('  ', secret, handler, noop).focus).toBe('login')
    await both.settled
    expect(handler).not.toHaveBeenCalled()
    expect(seen).toHaveLength(3)
  })

  it('publishes a refusal again so that the focus can return to the field', () => {
    const { flow, seen } = mounted()
    expect(flow.submit('', secret, vi.fn<LoginHandler>(), noop).focus).toBe('login')
    expect(flow.submit('', secret, vi.fn<LoginHandler>(), noop).focus).toBe('login')
    expect(seen).toEqual([{ kind: 'empty', fields: ['login'] }, { kind: 'empty', fields: ['login'] }])
  })

  it('clears a field error on typing', () => {
    const { flow } = mounted()
    flow.submit('', '', vi.fn<LoginHandler>(), noop)
    flow.edit('login', 'agent')
    expect(flow.getSnapshot()).toEqual({ kind: 'empty', fields: ['password'] })
    flow.edit('password', secret)
    expect(flow.getSnapshot()).toBe(initialLoginState)
  })

  it('hands the typed values to the handler once and waits for it', async () => {
    const { flow, seen } = mounted()
    const answer = deferred()
    const submission = flow.submit(' agent ', secret, answer.handler, noop)
    expect(submission.focus).toBeUndefined()
    expect(flow.getSnapshot()).toEqual({ kind: 'submitting' })
    await Promise.resolve()
    expect(answer.calls).toEqual([[' agent ', secret]])
    answer.resolve('invalid')
    await submission.settled
    expect(seen).toEqual([{ kind: 'submitting' }, { kind: 'failed', outcome: 'invalid' }])
  })

  it('makes a repeated submission impossible while one is in flight', async () => {
    const { flow, seen } = mounted()
    const answer = deferred()
    const second = vi.fn<LoginHandler>()
    const first = flow.submit('agent', secret, answer.handler, noop)
    const repeated = flow.submit('agent', secret, second, noop)
    const emptyRepeated = flow.submit('', '', second, noop)
    expect(repeated.focus).toBeUndefined()
    expect(emptyRepeated.focus).toBeUndefined()
    await repeated.settled
    expect(flow.getSnapshot()).toEqual({ kind: 'submitting' })
    answer.resolve('throttled')
    await first.settled
    expect(second).not.toHaveBeenCalled()
    expect(answer.calls).toHaveLength(1)
    expect(seen).toEqual([{ kind: 'submitting' }, { kind: 'failed', outcome: 'throttled' }])
  })

  it.each(['unavailable', 'invalid', 'throttled', 'network'] as const)('shows the %s outcome and stays on the screen', async (outcome) => {
    const { flow } = mounted()
    const onEnter = vi.fn()
    await flow.submit('agent', secret, async () => outcome, onEnter).settled
    expect(flow.getSnapshot()).toEqual({ kind: 'failed', outcome })
    expect(loginMessage(flow.getSnapshot())?.text).toBeTruthy()
    expect(onEnter).not.toHaveBeenCalled()
  })

  it('answers unavailable with the default handler', async () => {
    const { flow } = mounted()
    await flow.submit('agent', secret, unavailableHandler, noop).settled
    expect(flow.getSnapshot()).toEqual({ kind: 'failed', outcome: 'unavailable' })
  })

  it('shows a failed connection when the handler rejects', async () => {
    const { flow } = mounted()
    const answer = deferred()
    const submission = flow.submit('agent', secret, answer.handler, noop)
    answer.reject(new Error('offline'))
    await submission.settled
    expect(flow.getSnapshot()).toEqual({ kind: 'failed', outcome: 'network' })
  })

  it('allows a new attempt after a refusal', async () => {
    const { flow } = mounted()
    await flow.submit('agent', 'wrong', async () => 'invalid', noop).settled
    const answer = deferred()
    const submission = flow.submit('agent', secret, answer.handler, noop)
    expect(flow.getSnapshot()).toEqual({ kind: 'submitting' })
    answer.resolve('network')
    await submission.settled
    expect(flow.getSnapshot()).toEqual({ kind: 'failed', outcome: 'network' })
  })

  it('opens the catalog once after ok and keeps the form locked', async () => {
    const { flow, seen } = mounted()
    const onEnter = vi.fn(() => { expect(flow.getSnapshot()).toEqual({ kind: 'entered' }) })
    await flow.submit('agent', secret, async () => 'ok', onEnter).settled
    expect(onEnter).toHaveBeenCalledTimes(1)
    expect(seen).toEqual([{ kind: 'submitting' }, { kind: 'entered' }])
    const again = vi.fn<LoginHandler>()
    await flow.submit('agent', secret, again, onEnter).settled
    expect(again).not.toHaveBeenCalled()
    expect(onEnter).toHaveBeenCalledTimes(1)
  })

  it.each(['ok', 'invalid', 'unavailable'] as const)('drops the %s answer that arrives after the screen is gone', async (outcome) => {
    const { flow, seen, unmount } = mounted()
    const answer = deferred()
    const onEnter = vi.fn()
    const submission = flow.submit('agent', secret, answer.handler, onEnter)
    unmount()
    expect(flow.getSnapshot()).toBe(initialLoginState)
    answer.resolve(outcome)
    await submission.settled
    expect(flow.getSnapshot()).toBe(initialLoginState)
    expect(seen).toEqual([{ kind: 'submitting' }])
    expect(onEnter).not.toHaveBeenCalled()
  })

  it('drops a rejection that arrives after the screen is gone, with nothing unhandled', async () => {
    const { flow, unmount } = mounted()
    const answer = deferred()
    const submission = flow.submit('agent', secret, answer.handler, noop)
    unmount()
    answer.reject(new Error('offline'))
    await expect(submission.settled).resolves.toBeUndefined()
    expect(flow.getSnapshot()).toBe(initialLoginState)
  })

  it('does not let an abandoned answer touch the screen mounted again (StrictMode remount)', async () => {
    const { flow, unmount } = mounted()
    const stale = deferred()
    const first = flow.submit('agent', secret, stale.handler, noop)
    unmount()
    const seen: LoginState[] = []
    flow.subscribe(() => seen.push(flow.getSnapshot()))
    const fresh = deferred()
    const second = flow.submit('agent', secret, fresh.handler, noop)
    stale.resolve('invalid')
    await first.settled
    expect(flow.getSnapshot()).toEqual({ kind: 'submitting' })
    fresh.resolve('throttled')
    await second.settled
    expect(seen).toEqual([{ kind: 'submitting' }, { kind: 'failed', outcome: 'throttled' }])
  })

  it('keeps the state while another subscriber remains', async () => {
    const flow = createLoginFlow()
    const stopFirst = flow.subscribe(() => {})
    flow.subscribe(() => {})
    const answer = deferred()
    const submission = flow.submit('agent', secret, answer.handler, noop)
    stopFirst()
    answer.resolve('invalid')
    await submission.settled
    expect(flow.getSnapshot()).toEqual({ kind: 'failed', outcome: 'invalid' })
  })

  it('never keeps or logs the credentials', async () => {
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(noop))
    for (const outcome of loginOutcomes) {
      const { flow, seen } = mounted()
      await flow.submit('agent-007', secret, async () => outcome, noop).settled
      const text = JSON.stringify([flow.getSnapshot(), seen])
      expect(text).not.toContain(secret)
      expect(text).not.toContain('agent-007')
    }
    const { flow } = mounted()
    await flow.submit('agent-007', secret, () => Promise.reject(new Error(secret)), noop).settled
    expect(JSON.stringify(flow.getSnapshot())).not.toContain(secret)
    for (const log of logs) expect(log).not.toHaveBeenCalled()
  })
})
