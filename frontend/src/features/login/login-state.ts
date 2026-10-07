/* Model of the `/login` screen: plain functions and a small store, no React and no browser.

   SEAM FOR THE AUTHORISATION TASK. The screen itself sends nothing: `LoginPage` calls a `LoginHandler` and shows
   the outcome it resolves with. Until authorisation exists the handler is `unavailableHandler`, which performs no
   request. The future task passes a real one (`<LoginPage onSubmit={…} />`) that posts the credentials and maps
   the answer to a `LoginOutcome`; nothing else on the screen has to change. The login and the password are handed
   to the handler and are never kept in the state, in storage or in a log. */

export const loginOutcomes = ['ok', 'invalid', 'throttled', 'unavailable', 'network'] as const
/** `ok` — signed in; `invalid` — wrong credentials; `throttled` — too many attempts; `unavailable` — sign-in is
    not connected; `network` — the server could not be reached. */
export type LoginOutcome = typeof loginOutcomes[number]
export type LoginFailure = Exclude<LoginOutcome, 'ok'>
export type LoginHandler = (login: string, password: string) => Promise<LoginOutcome>

export type LoginField = 'login' | 'password'
export type LoginState =
  | { kind: 'idle' }
  /** Submitted with empty fields: listed in the order of the form. */
  | { kind: 'empty'; fields: readonly LoginField[] }
  | { kind: 'submitting' }
  | { kind: 'failed'; outcome: LoginFailure }
  /** Signed in: the form stays locked while the catalog opens. */
  | { kind: 'entered' }

export type LoginTone = 'info' | 'warning' | 'error' | 'success'
export type LoginMessage = { tone: LoginTone; text: string; catalogLink: boolean }

export const initialLoginState: LoginState = { kind: 'idle' }

/** Default handler: there is no authorisation yet, so no request is made. */
export const unavailableHandler: LoginHandler = async () => 'unavailable'

/** A login of spaces is empty; a password is taken as typed, spaces may belong to it. */
export function emptyFields(login: string, password: string): LoginField[] {
  const fields: LoginField[] = []
  if (login.trim() === '') fields.push('login')
  if (password === '') fields.push('password')
  return fields
}

export function fieldError(state: LoginState, field: LoginField): string | undefined {
  if (state.kind !== 'empty' || !state.fields.includes(field)) return undefined
  return field === 'login' ? 'Введите логин' : 'Введите пароль'
}

/** The form accepts no new submission while one is in flight and after a successful one. */
export function isLocked(state: LoginState) {
  return state.kind === 'submitting' || state.kind === 'entered'
}

const failures: Record<LoginFailure, LoginMessage> = {
  unavailable: { tone: 'info', text: 'Вход пока не подключён: пропускной режим не введён', catalogLink: true },
  invalid: { tone: 'error', text: 'Неверный логин или пароль', catalogLink: false },
  throttled: { tone: 'warning', text: 'Слишком много попыток. Повторите позже', catalogLink: false },
  network: { tone: 'error', text: 'Не удалось связаться с сервером. Повторите попытку', catalogLink: false },
}

/** Message of the form's status region; empty fields are reported next to the fields instead. */
export function loginMessage(state: LoginState): LoginMessage | undefined {
  if (state.kind === 'failed') return failures[state.outcome]
  if (state.kind === 'entered') return { tone: 'success', text: 'Вход выполнен. Открываем каталог…', catalogLink: false }
  return undefined
}

/** Typing into a field marked empty removes its error; nothing else reacts to typing. */
export function afterEdit(state: LoginState, field: LoginField, value: string): LoginState {
  if (state.kind !== 'empty' || !state.fields.includes(field)) return state
  if (field === 'login' ? value.trim() === '' : value === '') return state
  const fields = state.fields.filter((item) => item !== field)
  return fields.length > 0 ? { kind: 'empty', fields } : initialLoginState
}

/** A handler that throws or answers with an unknown value did not reach a usable answer. */
export async function resolveOutcome(handler: LoginHandler, login: string, password: string): Promise<LoginOutcome> {
  try {
    const outcome = await handler(login, password)
    return loginOutcomes.includes(outcome) ? outcome : 'network'
  } catch {
    return 'network'
  }
}

export type LoginSubmission = {
  /** First empty field: the screen moves the focus there. */
  focus?: LoginField
  /** Resolves when the attempt is over, whether or not its outcome was shown. */
  settled: Promise<void>
}

export type LoginFlow = ReturnType<typeof createLoginFlow>

/** State of one mounted screen. When the last subscriber leaves (the screen unmounts) an attempt in flight is
    abandoned: its outcome changes nothing, notifies nobody and does not open the catalog. */
export function createLoginFlow() {
  let state = initialLoginState
  let attempt = 0
  const listeners = new Set<() => void>()
  const publish = (next: LoginState) => {
    if (next === state) return
    state = next
    for (const listener of listeners) listener()
  }

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        attempt += 1
        if (state.kind === 'submitting') state = initialLoginState
      }
    },
    edit(field: LoginField, value: string) {
      publish(afterEdit(state, field, value))
    },
    submit(login: string, password: string, handler: LoginHandler, onEnter: () => void): LoginSubmission {
      if (isLocked(state)) return { settled: Promise.resolve() }
      const fields = emptyFields(login, password)
      if (fields.length > 0) {
        publish({ kind: 'empty', fields })
        return { focus: fields[0], settled: Promise.resolve() }
      }
      publish({ kind: 'submitting' })
      const current = ++attempt
      const settled = resolveOutcome(handler, login, password).then((outcome) => {
        if (current !== attempt) return
        if (outcome !== 'ok') {
          publish({ kind: 'failed', outcome })
          return
        }
        publish({ kind: 'entered' })
        onEnter()
      })
      return { settled }
    },
  }
}
