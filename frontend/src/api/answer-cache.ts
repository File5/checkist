/**
 * The memory of API answers («мгновенные экраны»). No React and no imports: `http.ts` depends on it.
 *
 * Only the read endpoints of the list below are kept, in memory of this page (never on the device): a screen opened
 * again within 2 minutes shows its last answer at once, and an answer older than 10 seconds is also read again in the
 * background, so the next visit is fresh. Any write (POST, PATCH, DELETE), whatever its result, forgets everything —
 * the person's own changes are always seen at once; a change made by another member of the family may show up to
 * about 2 minutes later. The rules live in `sendJson` (`http.ts`); this module only keeps the entries.
 *
 * Rule for new code: a GET that must never be shown from memory (it is polled, it is a draft, it is one-off) is not
 * added to `REMEMBERED`; a form that loads an object to send it back whole reads it with `{ fresh: true }`.
 */

/** An entry younger than this is returned without asking the network again. */
export const ANSWER_FRESH_MS = 10_000
/** An entry older than this is never shown: the screen waits for the network, as without the memory. */
export const ANSWER_KEEP_MS = 120_000
/** At most this many answers; the oldest kept is dropped first. */
export const ANSWER_LIMIT = 300

/** Read endpoints whose answers may be shown from memory, by path under the API prefix (`receipts/12/lines/`).
 * Not here on purpose: `auth/*`, `me/*` (the session reads them), `recognition/*`, `receipts/manual/` and
 * `receipts/manual/parse/*`, `insights/*`, `push/*`, the drafts `statements/` and `statements/{id}/`, `export/`,
 * `health*`, `product-merges/*`, `product-classifications/*`, `categories/{id}/icon/` — they are polled, one-off or
 * the state of a form. */
const REMEMBERED: readonly RegExp[] = [
  /^dashboard\/$/,
  /^receipts\/$/,
  /^receipts\/\d+\/$/,
  /^receipts\/\d+\/(lines|discounts|taxes)\/$/,
  /^receipts\/manual\/suggest\/$/,
  /^stats\/[a-z0-9_/-]+\/$/,
  /^recurring\/$/,
  /^incomes\/$/,
  /^incomes\/(summary|categories)\/$/,
  /^incomes\/\d+\/$/,
  /^goals\/$/,
  /^goals\/\d+\/$/,
  /^categories\/$/,
  /^categories\/\d+\/$/,
  /^budget\/[a-z0-9_/-]+\/$/,
  /^family\/$/,
  /^stores\/$/,
  /^store-merges\/$/,
  /^statements\/rules\/$/,
  /^products\/$/,
  /^products\/\d+\/([a-z0-9_/-]+\/)?$/,
  /^generic-products\/$/,
  /^generic-products\/\d+\/$/,
  /^brands\/$/,
  /^countries\/$/,
]

/** May an answer of this read endpoint be kept? `path` — as the adapters pass it, without the prefix and the query. */
export function remembersPath(path: string): boolean {
  return REMEMBERED.some((pattern) => pattern.test(path))
}

/** One key per address whatever the order of its parameters: the screens and the warm-up build them differently. */
export function answerKey(url: string): string {
  const mark = url.indexOf('?')
  if (mark < 0) return url
  const params = new URLSearchParams(url.slice(mark + 1))
  params.sort()
  const search = params.toString()
  return search ? `${url.slice(0, mark)}?${search}` : url.slice(0, mark)
}

type Entry = { body: unknown; at: number }
const entries = new Map<string, Entry>()
/** Bumped by every write and every forgetting: an answer read before it is never kept after it. */
let generation = 0
/** Network reads in flight by key: another caller of the same address waits for it instead of asking twice. */
const reads = new Map<string, Promise<unknown>>()
/** The background refresh in flight by key: at most one per address. */
const refreshes = new Map<string, object>()

const copy = (value: unknown): unknown => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value))

export function answerGeneration(): number {
  return generation
}

/** A copy of the kept answer and its age; nothing for an unknown or a too old one. */
export function recallAnswer(key: string, now = Date.now()): { body: unknown; age: number } | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  const age = now - entry.at
  if (age >= ANSWER_KEEP_MS || age < 0) {
    entries.delete(key)
    return undefined
  }
  try {
    return { body: copy(entry.body), age }
  } catch {
    entries.delete(key)
    return undefined
  }
}

/** Keeps a copy of a validated answer, unless something was written or forgotten since `readGeneration`. */
export function keepAnswer(key: string, body: unknown, readGeneration: number, now = Date.now()): void {
  if (readGeneration !== generation) return
  let kept: unknown
  try { kept = copy(body) } catch { return }
  entries.delete(key)
  entries.set(key, { body: kept, at: now })
  while (entries.size > ANSWER_LIMIT) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
  }
}

/** The server refused to answer again (the object is gone, the right was withdrawn): the next visit asks the network. */
export function dropAnswer(key: string, readGeneration: number): void {
  if (readGeneration === generation) entries.delete(key)
}

/** A write, a sign-in, a sign-out or another person: nothing kept so far is shown again. */
export function forgetAnswers(): void {
  generation++
  entries.clear()
  reads.clear()
  refreshes.clear()
}

/** Marks a network read of `key` in flight until it settles. */
export function trackRead(key: string, read: Promise<unknown>): void {
  reads.set(key, read)
  const done = () => { if (reads.get(key) === read) reads.delete(key) }
  read.then(done, done)
}

export function pendingRead(key: string): Promise<unknown> | undefined {
  return reads.get(key)
}

/** Starts the one background refresh of `key`; `undefined` — one is already running. */
export function startRefresh(key: string): (() => void) | undefined {
  if (refreshes.has(key)) return undefined
  const token = {}
  refreshes.set(key, token)
  return () => { if (refreshes.get(key) === token) refreshes.delete(key) }
}

/** How many answers are kept. For tests only. */
export function answerCount(): number {
  return entries.size
}
