import { onAuthSignal } from '../api/auth-signal.ts'
import { clearRecognitionCsrf } from '../api/local.ts'
import { getMe } from '../api/session.ts'
import { isRememberedMe } from '../api/session-schema.ts'
import { holdWrites, onWriteWaiting, releaseWrites } from '../api/write-gate.ts'
import { forgetCachedAnswers } from '../offline/service-worker.ts'
import type { Me, RememberedMe, UserSettings } from '../api/session.ts'

/** Who uses the application. No React here: the hook lives in `index.ts`.
 * `guest.expired` — the session ended in the middle of work, the sign-in explains it.
 * `error` — «Я» could not be read; nothing is known about the session.
 */
export type Session =
  | { kind: 'loading' } | { kind: 'error' }
  | { kind: 'guest'; expired: boolean }
  | {
    kind: 'user'; mode: Me['mode']; user: Me['user']; household: Me['household']; permissions: Me['permissions']
    /** The family head: hides and shows payments. An older server without the field — `false`. */
    isHead?: boolean
    settings?: UserSettings
    /** The person remembered on this device, until the first successful answer of `/api/me/` confirms them: the
     * screens already read (display only, the server checks every request), writes wait for that answer
     * (`api/write-gate.ts`), the spends kept on the phone are not sent. */
    provisional?: boolean
  }

/** The last «Я» of the server on this device — never the token: the next start opens the screen at once, without
 * waiting for `/api/me/`. A sign-out, the end of the session and a guest answer remove it. */
export const ME_KEY = 'checkist.me'

let session: Session = { kind: 'loading' }
/** A newer read, a sign-in or the end of the session makes every earlier answer of `/api/me/` stale. */
let generation = 0
let refreshing: Promise<void> | undefined
const listeners = new Set<() => void>()

const sameUser = (a: Session, b: Session) => a.kind === 'user' && b.kind === 'user'
  && a.mode === b.mode && a.user.id === b.user.id
const peopleKey = (household: NonNullable<Me['household']>) => (household.people ?? [])
  .map((person) => `${person.username}\t${person.display_name}`).join('\n')
const sameHousehold = (a: Me['household'], b: Me['household']) => a === b || (a !== null && b !== null
  && a.id === b.id && a.name === b.name && a.members.join('\n') === b.members.join('\n') && peopleKey(a) === peopleKey(b)
  && (a.head ?? null) === (b.head ?? null))
function same(a: Session, b: Session): boolean {
  if (a.kind === 'guest' && b.kind === 'guest') return a.expired === b.expired
  if (a.kind === 'user' && b.kind === 'user') {
    return sameUser(a, b) && a.user.username === b.user.username && a.user.display_name === b.user.display_name
      && a.user.is_staff === b.user.is_staff
      && a.permissions.moderate_catalog === b.permissions.moderate_catalog && sameHousehold(a.household, b.household)
      && (a.isHead ?? false) === (b.isHead ?? false)
      && (a.settings?.default_currency ?? null) === (b.settings?.default_currency ?? null)
      && (a.provisional ?? false) === (b.provisional ?? false)
  }
  return a.kind === b.kind
}
/** The snapshot keeps its identity while nothing changed: subscribers are not woken up in vain. */
function set(next: Session): void {
  if (same(session, next)) return
  session = next
  remember(next)
  for (const listener of [...listeners]) listener()
}
const userOf = (me: RememberedMe): Extract<Session, { kind: 'user' }> => ({
  kind: 'user', mode: me.mode,
  user: { id: me.user.id, username: me.user.username, is_staff: me.user.is_staff,
    ...(me.user.display_name !== undefined && { display_name: me.user.display_name }) },
  household: me.household === null ? null : {
    id: me.household.id, name: me.household.name, members: [...me.household.members],
    ...(me.household.people && { people: me.household.people.map((person) => ({ username: person.username, display_name: person.display_name })) }),
    ...(me.household.head !== undefined && { head: me.household.head }),
  },
  permissions: { moderate_catalog: me.permissions.moderate_catalog },
  // Older servers leave both out: the session then has neither (not the head, no main currency).
  ...(me.is_head !== undefined && { isHead: me.is_head }),
  ...(me.settings !== undefined && { settings: { default_currency: me.settings.default_currency } }),
})
/** The session back as «Я» to keep: the same fields `userOf` reads, nothing else. */
const meOf = (user: Extract<Session, { kind: 'user' }>): RememberedMe => ({
  mode: user.mode, user: user.user, household: user.household, permissions: user.permissions,
  ...(user.isHead !== undefined && { is_head: user.isHead }),
  ...(user.settings !== undefined && { settings: user.settings }),
})

/** A confirmed person is kept, a guest is forgotten; storage that throws (a private window) keeps nothing. */
function remember(next: Session): void {
  try {
    if (next.kind === 'user' && !next.provisional) window.localStorage.setItem(ME_KEY, JSON.stringify(meOf(next)))
    else if (next.kind === 'guest') window.localStorage.removeItem(ME_KEY)
  } catch {
    // Without storage the next start waits for «Я», as before.
  }
}

/** The person remembered on this device, if any; anything unreadable is no one.
 * Display only: the remembered rights (`permissions`, `is_staff`, `is_head`) choose what the menu and the screens show
 * until «Я» answers — they never decide anything. The server checks every request by its own session (a moderator
 * section answers `403`, a head-only action `403 head_only`), and no write leaves before a successful «Я». */
function remembered(): Session | undefined {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(ME_KEY) ?? 'null')
    return isRememberedMe(value) ? { ...userOf(value), provisional: true } : undefined
  } catch {
    return undefined
  }
}

/** The state of a fresh page: the remembered person at once (writes wait for «Я»), otherwise «loading». */
function start(): Session {
  const known = remembered()
  if (known) { holdWrites(); watchNetwork() }
  return known ?? { kind: 'loading' }
}

export function getSession(): Session {
  return session
}
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Read `GET /api/me/`. `401 not_authenticated` is a guest. A known session is re-read quietly:
 * it stays on the screen during the request and survives a failed one.
 * The person remembered on the device is confirmed only by a successful answer: a guest answer forgets them, another
 * person replaces them, and a failed read leaves them unconfirmed (`provisional`) with the writes still held — the
 * writes that waited get `retry` (an ordinary network failure, nothing sent).
 */
export async function loadSession(signal?: AbortSignal): Promise<void> {
  const token = {}
  reading.add(token)
  try {
    await readMe(signal)
  } finally {
    reading.delete(token)
  }
}

async function readMe(signal?: AbortSignal): Promise<void> {
  const current = ++generation
  const before = session
  if (before.kind === 'error') set({ kind: 'loading' })
  const result = await getMe({ signal })
  if (current !== generation || result.kind === 'aborted') return
  if (result.kind === 'ok') {
    const next = userOf(result.data)
    const other = before.kind === 'user' && !sameUser(before, next)
    // Another person or mode on the same cookie: no token or answer read before belongs to them.
    if (other) { clearRecognitionCsrf(); forgetCachedAnswers() }
    // What waited was typed for the remembered person: it never goes to another account.
    releaseWrites(other ? 'stop' : 'go')
    set(next)
  } else if (result.reason === 'not_authenticated') {
    if (before.kind === 'user') { clearRecognitionCsrf(); forgetCachedAnswers() }
    releaseWrites('stop')
    set({ kind: 'guest', expired: before.kind === 'user' || (before.kind === 'guest' && before.expired) })
  } else if (before.kind === 'user') {
    // Nothing new is known. A confirmed person stays as they are; the remembered one stays unconfirmed: the screens
    // keep reading (the server checks every request by its cookie), the writes stay held and those that waited fail
    // like without network. The next read comes with the network, the visible tab or the next write.
    if (before.provisional) releaseWrites('retry')
  } else if (before.kind !== 'guest') {
    set({ kind: 'error' })
  }
}

/** Reads in flight: a waiting write or the network coming back asks again only when none is on the way. */
let reading = new Set<object>()
function rereadIfUnconfirmed(): void {
  if (session.kind === 'user' && session.provisional && reading.size === 0) void loadSession()
}
onWriteWaiting(rereadIfUnconfirmed)

/** The network came back: the remembered person is confirmed (or not) before anything else is written. */
let network: { target: Pick<Window, 'addEventListener' | 'removeEventListener'>; listener: () => void } | undefined
function watchNetwork(): void {
  try {
    network?.target.removeEventListener('online', network.listener)
    network = undefined
    const target = window
    const listener = () => rereadIfUnconfirmed()
    target.addEventListener('online', listener)
    network = { target, listener }
  } catch {
    // No window (tests, scripts): the shell re-reads «Я» when the tab becomes visible.
  }
}

/** After a sign-in or a password change — «Я» of the answer; after a sign-out — `null`.
 * The CSRF token of the previous session is forgotten.
 */
export function applyMe(me: Me | null): void {
  generation++
  clearRecognitionCsrf()
  releaseWrites(me ? 'go' : 'stop')
  set(me ? userOf(me) : { kind: 'guest', expired: false })
}

/** The settings saved on `/account`: the session keeps them without reading «Я» again. */
export function applySettings(settings: UserSettings): void {
  if (session.kind !== 'user') return
  set({ ...session, settings: { default_currency: settings.default_currency } })
}

/** The family head (or a user without a family, or local_single): may hide and show payments. */
export function isHead(current: Session): boolean {
  return current.kind === 'user' && current.isHead === true
}

/** The main currency of the user from the settings; `null` — not chosen. */
export function defaultCurrency(current: Session): string | null {
  return current.kind === 'user' ? current.settings?.default_currency ?? null : null
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

/** Back to the state of a fresh page, the device included. For tests only. */
export function resetSession(): void {
  generation++
  refreshing = undefined
  reading = new Set()
  releaseWrites('stop')
  const next = start()
  if (!same(session, next)) {
    session = next
    for (const listener of [...listeners]) listener()
  }
}

onAuthSignal((signal) => {
  if (session.kind !== 'user' || session.mode !== 'accounts') return
  if (signal === 'unauthenticated') {
    generation++
    clearRecognitionCsrf()
    forgetCachedAnswers()
    releaseWrites('stop')
    set({ kind: 'guest', expired: true })
  } else if (!refreshing) {
    // The right may have been withdrawn: «Я» answers. Several refusals share one read.
    const read = loadSession().finally(() => { if (refreshing === read) refreshing = undefined })
    refreshing = read
  }
})

session = start()
