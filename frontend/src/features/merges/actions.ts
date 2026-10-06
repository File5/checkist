import type { MergeConfirmInput, MergeDetectResult, MergeExcludeInput, MergeGroup } from '../../api/product-merges'
import type { RecognitionCsrf } from '../../api/recognition'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { detectText, errorText } from './labels'

export type MergeAction =
  | { type: 'detect' }
  | { type: 'confirm'; id: number; input: MergeConfirmInput }
  | { type: 'cancel'; id: number }
  | { type: 'exclude'; id: number; input: MergeExcludeInput }
export type MergeOutcome = { action: Extract<MergeAction, { type: 'detect' }>; data: MergeDetectResult }
  | { action: Exclude<MergeAction, { type: 'detect' }>; data: MergeGroup }
export type ActionState = { kind: 'idle' } | { kind: 'pending'; action: MergeAction }
  | { kind: 'done'; action: MergeAction; message: string; detected?: MergeDetectResult }
  | { kind: 'failed'; action: MergeAction; message: string; error: LocalApiFailure }

/** The group a mutation answered with; a search answers with counters instead. */
export function outcomeGroup(outcome: MergeOutcome): MergeGroup | undefined {
  return outcome.action.type === 'detect' ? undefined : outcome.data as MergeGroup
}

function doneText(outcome: MergeOutcome): string {
  switch (outcome.action.type) {
    case 'detect': return detectText(outcome.data as MergeDetectResult)
    case 'confirm': return 'Слияние подтверждено. Поглощённые записи удалены, их покупки и написания принадлежат оставленному товару.'
    case 'cancel': return 'Слияние отменено: записи снова раздельны, покупки возвращены исходным товарам.'
    case 'exclude': return outcomeGroup(outcome)?.status === 'cancelled'
      ? 'Запись исключена. В группе осталось меньше двух записей, поэтому слияние отменено.'
      : 'Запись исключена из группы и снова является отдельным товаром.'
  }
}

/** One mutation at a time. Nothing is replayed: a refusal only asks the owner to read the state again. */
export function createMergeActions(
  mutate: (action: MergeAction, signal: AbortSignal) => Promise<LocalApiResult<MergeGroup | MergeDetectResult>>,
  refreshCsrf: (signal: AbortSignal) => Promise<LocalApiResult<RecognitionCsrf>>,
  lifecycle: { pause: () => void; success: (outcome: MergeOutcome) => void; failure: (error: LocalApiFailure, action: MergeAction) => void },
) {
  const initial: ActionState = { kind: 'idle' }
  let state: ActionState = initial
  let controller: AbortController | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: ActionState) => { state = next; listeners.forEach((listener) => listener()) }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    dispose: () => { generation++; controller?.abort(); controller = undefined },
    run: async (action: MergeAction) => {
      if (controller) return
      const stamp = ++generation
      const current = new AbortController()
      controller = current
      lifecycle.pause()
      publish({ kind: 'pending', action })
      let result: LocalApiResult<MergeGroup | MergeDetectResult>
      try { result = await mutate(action, current.signal) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (stamp !== generation || current.signal.aborted) return
      controller = undefined
      if (result.kind === 'ok') {
        const outcome = { action, data: result.data } as MergeOutcome
        lifecycle.success(outcome)
        publish({ kind: 'done', action, message: doneText(outcome), ...(action.type === 'detect' && { detected: outcome.data as MergeDetectResult }) })
      } else if (result.kind === 'error') {
        let message = errorText(result, true)
        if (result.reason === 'csrf_failed') {
          controller = current
          let csrf: LocalApiResult<RecognitionCsrf>
          try { csrf = await refreshCsrf(current.signal) }
          catch { csrf = { kind: 'error', reason: 'network' } }
          if (stamp !== generation || current.signal.aborted) return
          controller = undefined
          message = csrf.kind === 'ok' ? 'Токен безопасности обновлён. Действие не повторялось: выполните его снова.'
            : 'Не удалось обновить токен безопасности. Попробуйте действие позже.'
        }
        lifecycle.failure(result, action)
        publish({ kind: 'failed', action, error: result, message })
      } else publish(initial)
    },
  }
}
