import type { JobDetail, RecognitionCsrf } from '../../api/recognition'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { errorText } from './labels'

export type JobAction = 'cancel' | 'retry'
export type ActionState = { kind: 'idle' } | { kind: 'pending'; id: number; action: JobAction }
  | { kind: 'message'; id: number; message: string; error?: LocalApiFailure; cancelSubmitted?: boolean }
export function createJobActions(
  mutate: (id: number, action: JobAction, signal: AbortSignal) => Promise<LocalApiResult<JobDetail>>,
  refreshCsrf: (signal: AbortSignal) => Promise<LocalApiResult<RecognitionCsrf>>,
  lifecycle: { pause: () => void; resume: (immediate?: boolean) => void; success: (job: JobDetail, action: JobAction) => void },
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
    run: async (id: number, action: JobAction) => {
      if (controller) return
      const stamp = ++generation
      const current = new AbortController()
      controller = current
      lifecycle.pause()
      publish({ kind: 'pending', id, action })
      let result: LocalApiResult<JobDetail>
      try { result = await mutate(id, action, current.signal) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (stamp !== generation || current.signal.aborted) return
      if (result.kind === 'error' && result.reason === 'csrf_failed') {
        let csrf: LocalApiResult<RecognitionCsrf>
        try { csrf = await refreshCsrf(current.signal) }
        catch { csrf = { kind: 'error', reason: 'network' } }
        if (stamp !== generation || current.signal.aborted) return
        publish({ kind: 'message', id, error: result, message: csrf.kind === 'ok'
          ? 'Токен безопасности обновлён. Действие не повторялось; попробуйте снова.'
          : 'Не удалось обновить токен безопасности. Попробуйте действие позже.' })
      } else if (result.kind === 'ok') {
        lifecycle.success(result.data, action)
        publish({ kind: 'message', id, cancelSubmitted: action === 'cancel', message: action === 'cancel'
          ? 'Запрос отмены принят. Итоговый статус показывает сервер. Сохранённые чеки остаются доступными.'
          : 'Создано новое задание обработки.' })
      } else if (result.kind === 'error') {
        const conflict = result.status === 409
        publish({ kind: 'message', id, error: result, message: conflict
          ? `${errorText(result)} Запрашиваем актуальное состояние задания.`
          : errorText(result, true) })
      } else publish(initial)
      controller = undefined
      lifecycle.resume(result.kind !== 'ok')
    },
  }
}
