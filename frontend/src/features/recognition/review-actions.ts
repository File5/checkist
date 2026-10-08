import type { ReceiptImageDetail, RecognitionCsrf, ReviewConfirmInput, ReviewConfirmResult } from '../../api/recognition'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { NBSP } from '../../lib/text'
import { reviewErrorText, reviewKeepsState } from './labels'

export type ReviewActionState = { kind: 'idle' } | { kind: 'pending'; imageId: number }
  | { kind: 'done'; imageId: number; image: ReceiptImageDetail; message: string }
  | { kind: 'failed'; imageId: number; message: string; error: LocalApiFailure }
/** What the caller of `run` learns: the refusal to show at the fields, or nothing after a success, an abort or a busy store. */
export type ReviewOutcome = LocalApiFailure | undefined

/** Focus after the answer of a confirmation. The pressed button stays focusable during its request (aria-disabled)
 * and disappears with the form after a success: focus stays on it, or goes to the message of the card when it is gone.
 * Focus that the person moved elsewhere while waiting is never taken.
 */
export function reviewFocusTarget(active: 'pressed' | 'body' | 'elsewhere', pressedAvailable: boolean): 'pressed' | 'result' | undefined {
  if (active === 'elsewhere') return undefined
  return pressedAvailable ? 'pressed' : 'result'
}

/** The refusal printed in the form of a crop: the answer to its last request. It leaves for good when a later press
 * is stopped by the local check (`superseded` is the state at that press), and with the next request.
 */
export function refusalText(state: ReviewActionState, imageId: number, superseded: ReviewActionState | null): string | undefined {
  return state.kind === 'failed' && state.imageId === imageId && state !== superseded ? state.message : undefined
}

/** A pressed button that disappears with its own press names the lasting field that takes focus instead of it. */
export const focusAfterAttribute = 'data-review-focus'
export function focusAfterPress(target: { closest(selector: string): { getAttribute(name: string): string | null } | null }): string | null {
  return target.closest(`[${focusAfterAttribute}]`)?.getAttribute(focusAfterAttribute) ?? null
}
/** A field replaced by another element under the same id (the country input by the select of the loaded reference)
 * gets focus back only if it was the last focused control of the form and nothing else holds focus now.
 */
export function replacedFieldKeepsFocus(lastFocused: string | null, field: string, active: 'body' | 'elsewhere'): boolean {
  return active === 'body' && lastFocused === field
}

/** Answers of the confirmations of this screen by crop. A saved crop is shown from its answer until a list read brings it,
 * also while the next crop is being confirmed and the reads are paused.
 */
export type ConfirmedCrops = ReadonlyMap<number, ReceiptImageDetail>
export function rememberConfirmed(saved: ConfirmedCrops, state: ReviewActionState): ConfirmedCrops {
  return state.kind === 'done' && saved.get(state.imageId) !== state.image ? new Map(saved).set(state.imageId, state.image) : saved
}

function doneText(image: ReceiptImageDetail): string {
  const receipt = image.receipt_id === null ? '' : `${NBSP}№${image.receipt_id}`
  if (image.status === 'reused') return `Подтверждено. Вырезка привязана к уже сохранённому чеку${receipt}: его значения не изменены, исправления к нему не применены.`
  if (image.status === 'updated') return `Подтверждено. Вырезка привязана к уже сохранённому чеку${receipt}: дополнены только его пустые поля, заполненные значения не изменены.`
  return `Подтверждено. Чек${receipt} сохранён.`
}

/** One confirmation at a time for the whole job screen. Nothing is replayed: a refusal only tells the owner
 * whether the saved state has to be read again.
 */
export function createReviewActions(
  confirm: (imageId: number, input: ReviewConfirmInput, signal: AbortSignal) => Promise<LocalApiResult<ReviewConfirmResult>>,
  refreshCsrf: (signal: AbortSignal) => Promise<LocalApiResult<RecognitionCsrf>>,
  lifecycle: { pause: () => void; success: (result: ReviewConfirmResult) => void; failure: (error: LocalApiFailure, reread: boolean) => void },
) {
  const initial: ReviewActionState = { kind: 'idle' }
  let state: ReviewActionState = initial
  let controller: AbortController | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: ReviewActionState) => { state = next; listeners.forEach((listener) => listener()) }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    dispose: () => { generation++; controller?.abort(); controller = undefined },
    run: async (imageId: number, input: ReviewConfirmInput): Promise<ReviewOutcome> => {
      if (controller) return undefined
      const stamp = ++generation
      const current = new AbortController()
      controller = current
      lifecycle.pause()
      publish({ kind: 'pending', imageId })
      let result: LocalApiResult<ReviewConfirmResult>
      try { result = await confirm(imageId, input, current.signal) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (stamp !== generation || current.signal.aborted) return undefined
      if (result.kind === 'ok') {
        controller = undefined
        lifecycle.success(result.data)
        publish({ kind: 'done', imageId, image: result.data.image, message: doneText(result.data.image) })
        return undefined
      }
      // An adapter reports "aborted" only for this signal, which was checked above; treat anything else as a lost answer.
      const error: LocalApiFailure = result.kind === 'error' ? result : { kind: 'error', reason: 'network' }
      let message = reviewErrorText(error)
      if (error.reason === 'csrf_failed') {
        let csrf: LocalApiResult<RecognitionCsrf>
        try { csrf = await refreshCsrf(current.signal) }
        catch { csrf = { kind: 'error', reason: 'network' } }
        if (stamp !== generation || current.signal.aborted) return undefined
        message = csrf.kind === 'ok' ? 'Токен безопасности обновлён. Чек не сохранён, действие не повторялось: подтвердите снова.'
          : 'Не удалось обновить токен безопасности. Чек не сохранён; попробуйте подтвердить позже.'
      }
      controller = undefined
      lifecycle.failure(error, !reviewKeepsState(error))
      publish({ kind: 'failed', imageId, error, message })
      return error
    },
  }
}
