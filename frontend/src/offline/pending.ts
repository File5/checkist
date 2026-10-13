/** Manual spends saved on the phone while there was no network, and how they are sent later. Pure: no React, no IndexedDB,
 * no fetch — the store and the requests are passed in (`SyncDeps`), so every rule is unit-tested.
 *
 * Duplicates. A spend whose save failed with `network`/`timeout` may have reached the server anyway (the answer was lost).
 * There is no idempotency key in the API, so before every resend the recent receipts of that date are read and a manual spend
 * of the same person with the same total, currency, date, place, note and number of lines, created within
 * `ATTEMPT_WINDOW_MS` of one of our own attempts, counts as already saved. Limits: two identical spends typed within a few
 * minutes of each other may be taken for one (the second is kept only if the first was sent in the same run); a spend
 * changed on the server meanwhile, or a phone clock off by more than the window, is sent again.
 */
import type { LocalApiResult, Page } from '../api/types'
import type { ManualSpendInput, Receipt } from '../api/receipts'

export type PendingSpend = {
  /** Client id; never sent to the server. */
  id: string
  /** Username of who saved it: only that person sees and sends it. */
  owner: string
  body: ManualSpendInput
  createdAt: string
  /** When a send of it may have reached the server (ISO). Empty — never left the phone. */
  attempts: string[]
  /** The last refusal of the server in words of the screen; `null` — none. */
  error: string | null
}

export interface PendingStore {
  list(): Promise<PendingSpend[]>
  put(spend: PendingSpend): Promise<void>
  remove(id: string): Promise<void>
}

export type SyncDeps = {
  store: PendingStore
  owner: string
  send: (body: ManualSpendInput) => Promise<LocalApiResult<Receipt>>
  /** Manual spends of the date of `body`, the newest first. */
  recent: (body: ManualSpendInput) => Promise<LocalApiResult<Page<Receipt>>>
  describe: (failure: Extract<LocalApiResult<never>, { kind: 'error' }>) => string
  now?: () => Date
}

export type SyncOutcome = {
  sent: number
  /** Found already saved on the server and removed without a resend. */
  matched: number
  /** Refused by the server and kept with the reason. */
  refused: number
  /** Why the run stopped before the end: no network or the session ended. */
  stopped?: 'network' | 'aborted'
}

/** Five minutes either side of an attempt: the request itself and a phone clock somewhat off. */
export const ATTEMPT_WINDOW_MS = 5 * 60_000
/** Attempts remembered per spend. */
const ATTEMPTS_KEPT = 20

let counter = 0
export function newPendingId(): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : ''
  counter += 1
  return random || `${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2)}`
}

/** A spend whose save just failed for want of network: that attempt may have reached the server. */
export function newPending(body: ManualSpendInput, owner: string, now = new Date(), id = newPendingId()): PendingSpend {
  const at = now.toISOString()
  return { id, owner, body, createdAt: at, attempts: [at], error: null }
}

/** The save failed because the server was not reached — the spend is kept on the phone. */
export function isNetworkFailure(result: LocalApiResult<unknown>): boolean {
  return result.kind === 'error' && (result.reason === 'network' || result.reason === 'timeout')
}

const toCents = (value: string): number | undefined => {
  const match = /^([0-9]+)(?:\.([0-9]{1,2}))?$/.exec(value.trim())
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : undefined
}

/** The total the server will store for this body, in cents: the sum of lines less their discounts, or `total` without them. */
export function spendCents(body: ManualSpendInput): number | undefined {
  if (body.lines?.length) {
    let sum = 0
    for (const line of body.lines) {
      const cents = toCents(line.amount)
      const discount = line.discount_amount === undefined ? 0 : toCents(line.discount_amount)
      if (cents === undefined || discount === undefined) return undefined
      sum += cents - discount
    }
    return sum
  }
  return body.total === undefined ? undefined : toCents(body.total)
}

/** The amount for the list on the screen, as the API decimal. */
export function spendAmount(body: ManualSpendInput): string | undefined {
  const cents = spendCents(body)
  return cents === undefined ? undefined : `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** Is `receipt` this spend, saved by an earlier attempt whose answer was lost? */
export function isSameSpend(spend: PendingSpend, receipt: Receipt): boolean {
  const { body } = spend
  if (receipt.source !== 'manual' || receipt.owner !== spend.owner) return false
  if (receipt.purchased_on !== body.purchased_on || receipt.currency !== body.currency) return false
  if (toCents(receipt.total) !== spendCents(body)) return false
  if ((receipt.store?.name ?? null) !== (body.store_name?.trim() || null)) return false
  if (receipt.note !== (body.note ?? '').trim()) return false
  if (receipt.lines_count !== (body.lines?.length || 1)) return false
  const created = Date.parse(receipt.created_at)
  return spend.attempts.some((at) => Math.abs(created - Date.parse(at)) <= ATTEMPT_WINDOW_MS)
}

export function findSaved(spend: PendingSpend, receipts: Receipt[], claimed: ReadonlySet<number> = new Set()): Receipt | undefined {
  return receipts.find((receipt) => !claimed.has(receipt.id) && isSameSpend(spend, receipt))
}

/** The spends of `owner`, the oldest first. */
export function ownSpends(all: PendingSpend[], owner: string): PendingSpend[] {
  return all.filter((spend) => spend.owner === owner).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** Send the spends of `deps.owner` one by one. A spend leaves the phone only on `201` or when found already saved;
 * a refusal is kept with its reason and the run goes on; no network or an ended session stop the run. */
export async function syncPending(deps: SyncDeps): Promise<SyncOutcome> {
  const now = deps.now ?? (() => new Date())
  const outcome: SyncOutcome = { sent: 0, matched: 0, refused: 0 }
  // Receipts made or matched in this run: a second identical spend is not taken for the first one.
  const claimed = new Set<number>()
  for (const spend of ownSpends(await deps.store.list(), deps.owner)) {
    if (spend.attempts.length) {
      const recent = await deps.recent(spend.body)
      if (recent.kind === 'aborted') return { ...outcome, stopped: 'aborted' }
      if (recent.kind === 'error') {
        if (isNetworkFailure(recent)) return { ...outcome, stopped: 'network' }
        // Without the check a resend could double the spend: keep it and say why.
        await deps.store.put({ ...spend, error: deps.describe(recent) })
        outcome.refused += 1
        continue
      }
      const saved = findSaved(spend, recent.data.results, claimed)
      if (saved) {
        claimed.add(saved.id)
        await deps.store.remove(spend.id)
        outcome.matched += 1
        continue
      }
    }
    const attempt = { ...spend, attempts: [...spend.attempts, now().toISOString()].slice(-ATTEMPTS_KEPT) }
    await deps.store.put(attempt)
    const result = await deps.send(spend.body)
    if (result.kind === 'ok') {
      claimed.add(result.data.id)
      await deps.store.remove(spend.id)
      outcome.sent += 1
    } else if (result.kind === 'aborted') {
      return { ...outcome, stopped: 'aborted' }
    } else if (isNetworkFailure(result)) {
      return { ...outcome, stopped: 'network' }
    } else {
      await deps.store.put({ ...attempt, error: deps.describe(result) })
      outcome.refused += 1
    }
  }
  return outcome
}

/** In-memory store: tests, and a browser without IndexedDB (the spends then live until the page is closed). */
export function memoryStore(initial: PendingSpend[] = []): PendingStore & { items: Map<string, PendingSpend> } {
  const items = new Map(initial.map((spend) => [spend.id, spend]))
  return {
    items,
    list: async () => [...items.values()].map((spend) => structuredClone(spend)),
    put: async (spend) => { items.set(spend.id, structuredClone(spend)) },
    remove: async (id) => { items.delete(id) },
  }
}
