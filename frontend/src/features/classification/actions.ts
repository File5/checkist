import type {
  Classification, ClassificationConfirmInput, ClassificationConfirmItem, ClassificationConfirmMany, ClassificationRejectInput,
  ClassificationRunRequest,
} from '../../api/product-classifications'
import type { RecognitionCsrf } from '../../api/recognition-types'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { errorText, named, uncertain } from './labels'
import { batches } from './state'

export type ClassificationAction =
  /** `confirm` sends the suggested generic product, `choose` — another one picked by the person. */
  | { type: 'confirm' | 'choose'; id: number; input: ClassificationConfirmInput }
  | { type: 'reject'; id: number; input: ClassificationRejectInput }
  | { type: 'confirmAll'; genericId: number; items: ClassificationConfirmItem[] }
  | { type: 'run' }
/** What the server answered: the decided records and, for «Предложить категории», the run. */
export type ClassificationOutcome = { action: ClassificationAction; records: Classification[]; run?: ClassificationRunRequest }
export type ActionState = { kind: 'idle' } | { kind: 'pending'; action: ClassificationAction }
  | { kind: 'done'; action: ClassificationAction; message: string }
  | { kind: 'failed'; action: ClassificationAction; message: string; error: LocalApiFailure }

export interface ClassificationApi {
  confirm: (id: number, input: ClassificationConfirmInput, signal: AbortSignal) => Promise<LocalApiResult<Classification>>
  reject: (id: number, input: ClassificationRejectInput, signal: AbortSignal) => Promise<LocalApiResult<Classification>>
  confirmMany: (items: ClassificationConfirmItem[], signal: AbortSignal) => Promise<LocalApiResult<ClassificationConfirmMany>>
  requestRun: (signal: AbortSignal) => Promise<LocalApiResult<ClassificationRunRequest>>
  refreshCsrf: (signal: AbortSignal) => Promise<LocalApiResult<RecognitionCsrf>>
}
export interface ActionLifecycle {
  /** Reads stop before the server is touched: a late read never replaces the answer of the action. */
  pause: () => void
  success: (outcome: ClassificationOutcome) => void
  /** `records` — what earlier batches of a mass confirmation already saved. */
  failure: (error: LocalApiFailure, action: ClassificationAction, records: Classification[]) => void
  /** Reads the state the action may have changed; awaited before a new attempt is offered. */
  reread: (action: ClassificationAction, signal: AbortSignal) => Promise<void>
}

/** «Повторить» is offered only where nothing was saved for sure: a busy catalog. */
export function retryable(state: ActionState): state is Extract<ActionState, { kind: 'failed' }> {
  return state.kind === 'failed' && state.error.reason === 'classification_busy'
}
/** A refusal that leaves the open area as it is: the person repeats or picks another option there. */
export function keepsArea(error: LocalApiFailure, action: ClassificationAction): boolean {
  return error.reason === 'classification_busy' || error.reason === 'csrf_failed'
    || (action.type === 'choose' && (error.reason === 'invalid_parameter' || error.reason === 'invalid_request'))
}
export const bulkText = (confirmed: number, total: number) => `Подтверждено ${confirmed.toLocaleString('ru-RU')} из ${total.toLocaleString('ru-RU')}`

function doneText({ action, records, run }: ClassificationOutcome): string {
  const final = records[0]?.final_generic
  switch (action.type) {
    case 'confirm': return 'Категория подтверждена.'
    case 'choose': return final ? `Выбран другой обобщённый продукт: «${named(final)}».` : 'Выбран другой обобщённый продукт.'
    case 'reject': return `Предложение отклонено: товар возвращён в «${final ? named(final) : 'Не разобрано'}».`
    case 'confirmAll': return `${bulkText(records.length, action.items.length)}.`
    case 'run': return !run?.run ? 'Товаров без категории нет.'
      : run.created ? 'Запуск поставлен в очередь.' : 'Запуск уже в очереди или выполняется: новый не создан.'
  }
}

type Sent = { records: Classification[]; run?: ClassificationRunRequest; stopped?: LocalApiFailure | { kind: 'aborted' } }

/** One mutation at a time. Nothing is replayed: a refusal only makes the owner read the state again. */
export function createClassificationActions(api: ClassificationApi, lifecycle: ActionLifecycle) {
  const initial: ActionState = { kind: 'idle' }
  let state: ActionState = initial
  let controller: AbortController | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: ActionState) => { state = next; listeners.forEach((listener) => listener()) }
  const guarded = async <T,>(call: () => Promise<LocalApiResult<T>>): Promise<LocalApiResult<T>> => {
    try { return await call() } catch { return { kind: 'error', reason: 'network' } }
  }
  const send = async (action: ClassificationAction, signal: AbortSignal): Promise<Sent> => {
    if (action.type === 'run') {
      const result = await guarded(() => api.requestRun(signal))
      return result.kind === 'ok' ? { records: [], run: result.data } : { records: [], stopped: result }
    }
    if (action.type === 'confirmAll') {
      const records: Classification[] = []
      // Consecutive requests of at most 100 records; the first refusal stops the rest.
      for (const items of batches(action.items)) {
        const result = await guarded(() => api.confirmMany(items, signal))
        if (result.kind !== 'ok') return { records, stopped: result }
        records.push(...result.data.results)
        if (signal.aborted) return { records, stopped: { kind: 'aborted' } }
      }
      return { records }
    }
    const result = await guarded(() => action.type === 'reject' ? api.reject(action.id, action.input, signal) : api.confirm(action.id, action.input, signal))
    return result.kind === 'ok' ? { records: [result.data] } : { records: [], stopped: result }
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    dispose: () => { generation++; controller?.abort(); controller = undefined },
    run: async (action: ClassificationAction) => {
      if (controller) return
      const stamp = ++generation
      const current = new AbortController()
      controller = current
      const stale = () => stamp !== generation || current.signal.aborted
      lifecycle.pause()
      publish({ kind: 'pending', action })
      const { records, run, stopped } = await send(action, current.signal)
      if (stale()) return
      if (!stopped) {
        controller = undefined
        const outcome: ClassificationOutcome = { action, records, ...(run && { run }) }
        lifecycle.success(outcome)
        publish({ kind: 'done', action, message: doneText(outcome) })
        return
      }
      if (stopped.kind !== 'error') { controller = undefined; publish(initial); return }
      // The token is renewed for the next press; the refused request itself is never sent again.
      if (stopped.reason === 'csrf_failed') await guarded(() => api.refreshCsrf(current.signal))
      // The action may have been saved: its state is read before the person can try again.
      else if (uncertain(stopped)) await lifecycle.reread(action, current.signal).catch(() => {})
      if (stale()) return
      controller = undefined
      const text = errorText(stopped, action.type === 'choose' ? 'choose' : 'action')
      lifecycle.failure(stopped, action, records)
      publish({ kind: 'failed', action, error: stopped, message: action.type === 'confirmAll' ? `${bulkText(records.length, action.items.length)}. ${text}` : text })
    },
  }
}
