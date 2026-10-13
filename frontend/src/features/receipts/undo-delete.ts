/**
 * «Удалено · Отменить» on «Траты» (2026-10-13). A spend swiped away (or deleted by its button) leaves the list at once,
 * but the DELETE reaches the server only when the undo time is over — or at once when the person leaves the screen,
 * hides the tab or closes the page (the request is `keepalive`, it outlives the page). «Отменить» before that only shows
 * the row again: the server never saw anything, so nothing is restored and nothing can be lost. A refused DELETE shows
 * the row again with the reason, so no ghost stays either. One deletion waits at a time: the next one sends the previous.
 * Only spends typed by hand: a photo receipt keeps the confirmation of its own page (the photo, `with_photo`, the 409s).
 */
import { deleteReceipt } from '../../api/receipts'
import { getRecognitionCsrf } from '../../api/local'
import type { LocalApiResult } from '../../api/types'
import { deleteFailureMessage } from './delete-receipt'

export const UNDO_MS = 5000

export type Deletion = { id: number; title: string }
export type UndoSnapshot = {
  /** Waiting for its time; hidden from the list. */
  pending: Deletion | null
  /** Sent or deleted: hidden from the list; a refused one comes back. */
  gone: readonly number[]
  failure: { id: number; message: string } | null
}
export type UndoDelete = ReturnType<typeof createUndoDelete>

export function createUndoDelete(send: (id: number) => Promise<LocalApiResult<null>>, { delay = UNDO_MS, prepare = () => {} }: {
  delay?: number
  /** Called when a deletion is scheduled: the CSRF token must be at hand before the page may close. */
  prepare?: () => void
} = {}) {
  let snapshot: UndoSnapshot = { pending: null, gone: [], failure: null }
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const set = (next: Partial<UndoSnapshot>) => {
    snapshot = { ...snapshot, ...next }
    listeners.forEach((listener) => listener())
  }
  const stop = () => { clearTimeout(timer); timer = undefined }

  /** Sends the waiting deletion now. */
  const flush = () => {
    const item = snapshot.pending
    if (!item) return
    stop()
    set({ pending: null, gone: [...snapshot.gone, item.id] })
    void send(item.id).then((result) => {
      // Already gone is what the person wanted.
      if (result.kind === 'ok' || (result.kind === 'error' && result.reason === 'not_found')) return
      set({
        gone: snapshot.gone.filter((id) => id !== item.id),
        failure: { id: item.id, message: result.kind === 'error' ? deleteFailureMessage(result) : 'Не удалось удалить. Повторите попытку.' },
      })
    })
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    schedule(item: Deletion) {
      flush()
      prepare()
      set({ pending: item, failure: null })
      timer = setTimeout(flush, delay)
    },
    /** Shows the row again; nothing was sent. */
    undo() {
      if (!snapshot.pending) return
      stop()
      set({ pending: null })
    },
    flush,
    /** The undo bar has the focus: the time stops, so a keyboard or a screen reader is not hurried. */
    hold() {
      if (snapshot.pending) stop()
    },
    release() {
      if (snapshot.pending && timer === undefined) timer = setTimeout(flush, delay)
    },
    dismiss() {
      if (snapshot.failure) set({ failure: null })
    },
  }
}

/** The one of the app: a spend by hand, `keepalive` so that a closed page still sends it. */
export const undoDelete = createUndoDelete((id) => deleteReceipt(id, { keepalive: true }), {
  prepare: () => { void getRecognitionCsrf() },
})

/** Ids the list does not show: waiting, sent or deleted. */
export function hiddenIds(snapshot: UndoSnapshot): ReadonlySet<number> {
  return new Set(snapshot.pending ? [...snapshot.gone, snapshot.pending.id] : snapshot.gone)
}

export const SWIPE_REVEAL = 96

/** Where a row swiped to `offset` (px, ≤ 0) of its `width` lets go: past 40 % (at least 160 px) it is deleted, past half
 * of the «Удалить» behind it the row stays open on the button, otherwise it goes back. */
export function swipeEnd(offset: number, width: number): 'delete' | 'open' | 'close' {
  if (-offset >= Math.max(width * 0.4, 160)) return 'delete'
  if (-offset >= SWIPE_REVEAL / 2) return 'open'
  return 'close'
}
