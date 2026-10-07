import { useEffect, useState, useSyncExternalStore } from 'react'
import type { AuthFailure, AuthResult } from '../../api/session'
import type { Route } from '../../navigation'
import { canModerate } from '../../session'
import type { Session } from '../../session'
import type { Refusal } from './labels'

/** What the shell puts in place of the page.
 * `page` — the route's own screen; everything else makes no data request.
 */
export type ShellView = 'page' | 'loading' | 'error' | 'login' | 'forbidden' | 'not-found'

/** `/health` never waits for «Я». A guest sees the sign-in on the very address they opened. */
export function shellView(session: Session, route: Route): ShellView {
  if (route.kind === 'health') return 'page'
  if (session.kind === 'loading') return 'loading'
  if (session.kind === 'error') return 'error'
  if (session.kind === 'guest') return 'login'
  if (route.kind === 'account') return session.mode === 'accounts' ? 'page' : 'not-found'
  if ((route.kind === 'merges' || route.kind === 'merge' || route.kind === 'classification') && !canModerate(session)) return 'forbidden'
  return 'page'
}

/** The page is created again when another person appears on the same cookie: their data never mix on one screen. */
export function pageKey(session: Session): string {
  return session.kind === 'user' ? `${session.mode}:${session.user.id}` : session.kind
}

/** Reads «Я» at once and again every time the tab becomes visible: another tab may have signed out
 * or signed in as someone else meanwhile. Returns the cleanup.
 */
export function watchSession(
  read: (signal: AbortSignal) => unknown,
  page: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>,
): () => void {
  const controller = new AbortController()
  const onVisible = () => { if (page.visibilityState === 'visible') read(controller.signal) }
  read(controller.signal)
  page.addEventListener('visibilitychange', onVisible)
  return () => {
    controller.abort()
    page.removeEventListener('visibilitychange', onVisible)
  }
}

export type FormState =
  | { kind: 'idle' } | { kind: 'pending' }
  | { kind: 'failed'; message: string; fields: string[]; details: string[] }
  | { kind: 'done'; message: string }

export type AuthFormOptions<I, T> = {
  /** Refuses the input before any request. */
  check?: (input: I) => Refusal | undefined
  send: (input: I, signal: AbortSignal) => Promise<AuthResult<T>>
  refusal: (failure: AuthFailure) => Refusal
  /** Applies the answer to the session; the returned text is shown as the result. */
  success: (data: T) => string | void
}

/** One POST at a time and never a replay: a second press during a request does nothing. */
export function createAuthForm<I, T>({ check, send, refusal, success }: AuthFormOptions<I, T>) {
  const initial: FormState = { kind: 'idle' }
  let state: FormState = initial
  let controller: AbortController | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: FormState) => { state = next; listeners.forEach((listener) => listener()) }
  const fail = ({ message, fields = [], details = [] }: Refusal) => publish({ kind: 'failed', message, fields, details })
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    dispose: () => { generation++; controller?.abort(); controller = undefined },
    run: async (input: I) => {
      if (controller) return
      const refused = check?.(input)
      if (refused) { fail(refused); return }
      const stamp = ++generation
      const current = new AbortController()
      controller = current
      publish({ kind: 'pending' })
      let result: AuthResult<T>
      try { result = await send(input, current.signal) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (stamp !== generation || current.signal.aborted) return
      controller = undefined
      if (result.kind === 'ok') {
        const message = success(result.data)
        if (stamp === generation) publish(message ? { kind: 'done', message } : initial)
      } else if (result.kind === 'error') fail(refusal(result))
      // The session ended meanwhile: the shell already replaces the page with the sign-in.
      else publish(initial)
    },
  }
}

export function useAuthForm<I, T>(options: AuthFormOptions<I, T>) {
  // The options of a form never change during its life: the first ones are kept.
  const [form] = useState(() => createAuthForm(options))
  const state = useSyncExternalStore(form.subscribe, form.getSnapshot, form.getServerSnapshot)
  useEffect(() => form.dispose, [form])
  return { state, run: form.run }
}

export type LoginInput = { username: string; password: string }
export type PasswordInput = { current_password: string; new_password: string; repeat: string }

/** The name is sent as typed, without trimming: only an empty field is refused here. */
export function checkLogin({ username, password }: LoginInput): Refusal | undefined {
  const fields = [...(username.trim() ? [] : ['username']), ...(password ? [] : ['password'])]
  if (fields.length) return { message: 'Введите имя пользователя и пароль.', fields }
}

export function checkPassword({ current_password, new_password, repeat }: PasswordInput): Refusal | undefined {
  const fields = [...(current_password ? [] : ['current_password']), ...(new_password ? [] : ['new_password']), ...(repeat ? [] : ['repeat'])]
  if (fields.length) return { message: 'Заполните текущий пароль, новый пароль и его повтор.', fields }
  if (new_password !== repeat) return { message: 'Новый пароль и его повтор не совпадают.', fields: ['repeat'] }
}
