/** The spends waiting on the phone, for the screens: a store with a hook, the sending and the hand-off to the form. */
import { useEffect, useSyncExternalStore } from 'react'
import { requestJson } from '../api/http'
import { createManualSpend } from '../api/receipts'
import type { ManualSpendInput, Receipt } from '../api/receipts'
import { isReceipt } from '../api/receipts-schema'
import { page } from '../api/schema'
import type { Category, LocalApiResult, Page } from '../api/types'
import { amountText } from '../features/expense/expense-form'
import { lineFromBody } from '../features/expense/line-draft'
import type { ExpenseDraft } from '../features/expense/expense-form'
import { saveMessage } from '../features/expense/labels'
import { pendingStore } from './idb'
import { newPending, ownSpends, syncPending } from './pending'
import type { PendingSpend, PendingStore, SyncOutcome } from './pending'

export type PendingState = {
  owner: string | null
  items: PendingSpend[]
  syncing: boolean
  /** The result of the last run in words of the screen; `undefined` — nothing to say. */
  note?: string
}

let state: PendingState = { owner: null, items: [], syncing: false }
const listeners = new Set<() => void>()
let store: PendingStore | undefined
const storage = () => (store ??= pendingStore())

function set(patch: Partial<PendingState>): void {
  state = { ...state, ...patch }
  for (const listener of [...listeners]) listener()
}

export function getPendingState(): PendingState {
  return state
}
export function subscribePending(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
export function usePendingSpends(): PendingState {
  return useSyncExternalStore(subscribePending, getPendingState, getPendingState)
}

async function reload(): Promise<void> {
  const owner = state.owner
  const items = owner === null ? [] : ownSpends(await storage().list(), owner)
  if (state.owner === owner) set({ items })
}

/** Keep the spend on the phone after its save failed for want of network. */
export async function enqueueSpend(body: ManualSpendInput, owner: string): Promise<PendingSpend> {
  const spend = newPending(body, owner)
  await storage().put(spend)
  await reload()
  return spend
}

export async function discardPending(id: string): Promise<void> {
  await storage().remove(id)
  await reload()
}

/** Manual spends of that date straight from the server: the service worker never answers this read from its cache. */
function freshSpends(body: ManualSpendInput): Promise<LocalApiResult<Page<Receipt>>> {
  return requestJson('receipts/', { date_from: body.purchased_on, date_to: body.purchased_on, page_size: 200 }, page(isReceipt), {}, {
    local: true, credentials: 'same-origin', headers: { 'X-Checkist-Fresh': '1' },
  })
}

export function outcomeNote(outcome: SyncOutcome): string | undefined {
  if (outcome.stopped === 'network') return 'Сервер пока недоступен — отправим, когда появится сеть.'
  if (outcome.refused) return 'Сервер не принял часть трат: исправьте или удалите их.'
  const done = outcome.sent + outcome.matched
  return done ? `Отправлено трат: ${done.toLocaleString('ru-RU')}.` : undefined
}

let running: Promise<void> | undefined
/** Send the waiting spends of the current person one by one. Concurrent calls share one run. */
export function sendPendingNow(): Promise<void> {
  const owner = state.owner
  if (owner === null) return Promise.resolve()
  running ??= (async () => {
    set({ syncing: true, note: undefined })
    try {
      const outcome = await syncPending({
        store: storage(), owner, send: (body) => createManualSpend(body), recent: freshSpends, describe: saveMessage,
      })
      if (state.owner === owner) set({ note: outcomeNote(outcome) })
    } catch {
      if (state.owner === owner) set({ note: 'Не удалось прочитать траты на телефоне.' })
    } finally {
      await reload().catch(() => undefined)
      set({ syncing: false })
      running = undefined
    }
  })()
  return running
}

/** The shell: whose spends are shown, and their sending at start and whenever the network comes back. */
export function usePendingSync(owner: string | null): void {
  useEffect(() => {
    set({ owner, items: [], note: undefined })
    if (owner === null) return
    void reload().then(() => {
      if (navigator.onLine !== false && getPendingState().items.length) void sendPendingNow()
    }).catch(() => undefined)
    const online = () => { void sendPendingNow() }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [owner])
}

/** «Исправить»: the form of a new spend opens with this spend; it leaves the phone once the form saves it.
 * Read without taking: the form reads it in a state initializer, which React may call twice. */
let handoff: PendingSpend | undefined
export function handOff(spend: PendingSpend): void { handoff = spend }
export function peekHandoff(): PendingSpend | undefined { return handoff }
export function clearHandoff(): void { handoff = undefined }

/** The form draft of a waiting spend. A category that no longer exists is dropped: the person picks another. */
export function draftFromPending(body: ManualSpendInput, categories: Pick<Category, 'id'>[]): ExpenseDraft {
  const known = new Set(categories.map((category) => category.id))
  const category = (id: number | null | undefined) => id !== undefined && id !== null && known.has(id) ? id : null
  const lines = body.lines ?? []
  return {
    amount: lines.length || body.total === undefined ? '' : amountText(body.total),
    currency: body.currency ?? '',
    category: category(body.category),
    date: body.purchased_on ?? '',
    place: body.store_name ?? '',
    note: body.note ?? '',
    lines: lines.map((line) => lineFromBody(line, category(line.category))),
    method: body.payment_method,
    item: lines.length ? '' : body.item_name ?? '',
  }
}

/** Back to the state of a fresh page. For tests only. */
export function resetPending(next: { store?: PendingStore; owner?: string | null } = {}): void {
  store = next.store
  running = undefined
  handoff = undefined
  state = { owner: next.owner ?? null, items: [], syncing: false }
}
