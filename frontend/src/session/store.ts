import { onAuthSignal } from '../api/auth-signal.ts'
import { clearRecognitionCsrf } from '../api/local.ts'
import { getMe } from '../api/session.ts'
import type { Me } from '../api/session.ts'

/** Who uses the application. No React here: the hook lives in `index.ts`.
 * `guest.expired` — the session ended in the middle of work, the sign-in explains it.
 * `error` — «Я» could not be read; nothing is known about the session.
 */
export type Session =
  | { kind: 'loading' } | { kind: 'error' }
  | { kind: 'guest'; expired: boolean }
  | { kind: 'user'; mode: Me['mode']; user: Me['user']; permissions: Me['permissions'] }

let session: Session = { kind: 'loading' }
/** A newer read, a sign-in or the end of the session makes every earlier answer of `/api/me/` stale. */
let generation = 0
let refreshing: Promise<void> | undefined
const listeners = new Set<() => void>()

const sameUser = (a: Session, b: Session) => a.kind === 'user' && b.kind === 'user'
  && a.mode === b.mode && a.user.id === b.user.id
function same(a: Session, b: Session): boolean {
  if (a.kind === 'guest' && b.kind === 'guest') return a.expired === b.expired
  if (a.kind === 'user' && b.kind === 'user') {
    return sameUser(a, b) && a.user.username === b.user.username && a.user.is_staff === b.user.is_staff
      && a.permissions.moderate_catalog === b.permissions.moderate_catalog
  }
  return a.kind === b.kind
}
/** The snapshot keeps its identity while nothing changed: subscribers are not woken up in vain. */
function set(next: Session): void {
  if (same(session, next)) return
  session = next
  for (const listener of [...listeners]) listener()
}
const userOf = (me: Me): Session => ({
  kind: 'user', mode: me.mode,
  user: { id: me.user.id, username: me.user.username, is_staff: me.user.is_staff },
  permissions: { moderate_catalog: me.permissions.moderate_catalog },
})

export function getSession(): Session {
  return session
}
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Read `GET /api/me/`. `401 not_authenticated` is a guest. A known session is re-read quietly:
 * it stays on the screen during the request and survives a failed one.
 */
export async function loadSession(signal?: AbortSignal): Promise<void> {
  const current = ++generation
  const before = session
  if (before.kind === 'error') set({ kind: 'loading' })
  const result = await getMe({ signal })
  if (current !== generation || result.kind === 'aborted') return
  if (result.kind === 'ok') {
    const next = userOf(result.data)
    // Another person or mode on the same cookie: no token read before belongs to them.
    if (before.kind === 'user' && !sameUser(before, next)) clearRecognitionCsrf()
    set(next)
  } else if (result.reason === 'not_authenticated') {
    if (before.kind === 'user') clearRecognitionCsrf()
    set({ kind: 'guest', expired: before.kind === 'user' || (before.kind === 'guest' && before.expired) })
  } else if (before.kind !== 'user' && before.kind !== 'guest') {
    set({ kind: 'error' })
  }
}

/** After a sign-in or a password change — «Я» of the answer; after a sign-out — `null`.
 * The CSRF token of the previous session is forgotten.
 */
export function applyMe(me: Me | null): void {
  generation++
  clearRecognitionCsrf()
  set(me ? userOf(me) : { kind: 'guest', expired: false })
}

/** local_single always moderates; in accounts it is the right `catalog.moderate_catalog`. */
export function canModerate(current: Session): boolean {
  return current.kind === 'user' && current.permissions.moderate_catalog
}

/** Text of `403 permission_denied`: with accounts it is a missing right, without them — the switched off local API. */
export function permissionDeniedText(current: Session): string {
  return current.kind === 'user' && current.mode === 'accounts'
    ? 'Нет права модератора каталога.'
    : 'Локальный API выключен или недоступен с этого адреса. Запустите сервер с ALLOW_LOCAL_RECOGNITION_API=1 и откройте приложение с этого компьютера.'
}

/** Back to the state before the first read. For tests only. */
export function resetSession(): void {
  generation++
  refreshing = undefined
  set({ kind: 'loading' })
}

onAuthSignal((signal) => {
  if (session.kind !== 'user' || session.mode !== 'accounts') return
  if (signal === 'unauthenticated') {
    generation++
    clearRecognitionCsrf()
    set({ kind: 'guest', expired: true })
  } else if (!refreshing) {
    // The right may have been withdrawn: «Я» answers. Several refusals share one read.
    const read = loadSession().finally(() => { if (refreshing === read) refreshing = undefined })
    refreshing = read
  }
})
