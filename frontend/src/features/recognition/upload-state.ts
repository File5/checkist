import type { PhotoUpload, RecognitionCsrf, RecognitionLimits } from '../../api/recognition'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { errorText, executorWarning } from './labels'

const extensions: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
export function fileFormat(file: Pick<File, 'name'>) { return extensions[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? null }
export function validateFile(file: Pick<File, 'name' | 'size'>, limits?: RecognitionLimits): string | undefined {
  const format = fileFormat(file)
  if (!format || (limits && !limits.formats.includes(format as RecognitionLimits['formats'][number]))) return 'Формат не поддерживается. HEIC и другие форматы сохраните в JPEG или PNG.'
  if (file.size === 0) return 'Файл пуст. Выберите другое фото.'
  if (limits && file.size > limits.max_bytes) return 'Файл слишком большой. Уменьшите его размер до лимита сервера.'
}
export function formatBytes(bytes: number) { return `${(bytes / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} МиБ (${bytes.toLocaleString('ru-RU')} байт)` }
export function uploadMessage(result: PhotoUpload) {
  return `${result.reused ? 'Это фото уже было загружено. Открыто последнее задание этого фото.' : 'Фото загружено. Задание принято.'}${!result.job.executor.available && result.job.status === 'queued' ? ` ${executorWarning}` : ''}`
}

let notice: { id: number; message: string } | undefined
export function setJobNotice(id: number, message: string) { notice = { id, message } }
export function getJobNotice(id: number) { return notice?.id === id ? notice.message : undefined }

export type UploadState =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'error'; message: string; error?: LocalApiFailure; csrfRefreshed?: boolean }
  | { kind: 'success'; data: PhotoUpload; message: string }

export function createUpload(
  send: (file: File, signal: AbortSignal) => Promise<LocalApiResult<PhotoUpload>>,
  refreshCsrf: (signal: AbortSignal) => Promise<LocalApiResult<RecognitionCsrf>>,
  success: (result: PhotoUpload) => void,
  limitsChanged: (data: RecognitionCsrf) => void,
) {
  const initial: UploadState = { kind: 'idle' }
  let state: UploadState = initial
  let controller: AbortController | undefined
  let generation = 0
  const listeners = new Set<() => void>()
  const publish = (next: UploadState) => { state = next; listeners.forEach((listener) => listener()) }
  const reset = () => { generation++; controller?.abort(); controller = undefined; publish(initial) }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    reset, dispose: reset,
    submit: async (file: File, limits: RecognitionLimits) => {
      if (controller) return
      const invalid = validateFile(file, limits)
      if (invalid) { publish({ kind: 'error', message: invalid }); return }
      const current = new AbortController()
      controller = current
      const stamp = ++generation
      publish({ kind: 'sending' })
      let result: LocalApiResult<PhotoUpload>
      try { result = await send(file, current.signal) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (stamp !== generation || current.signal.aborted) return
      if (result.kind === 'error' && result.reason === 'csrf_failed') {
        let csrf: LocalApiResult<RecognitionCsrf>
        try { csrf = await refreshCsrf(current.signal) }
        catch { csrf = { kind: 'error', reason: 'network' } }
        if (stamp !== generation || current.signal.aborted) return
        controller = undefined
        if (csrf.kind === 'ok') limitsChanged(csrf.data)
        publish({ kind: 'error', error: result, csrfRefreshed: csrf.kind === 'ok', message: csrf.kind === 'ok'
          ? 'Токен безопасности обновлён. Фото не отправлялось повторно. Нажмите «Повторить загрузку».'
          : 'Не удалось обновить токен безопасности. Обновите условия загрузки и попробуйте снова.' })
        return
      }
      controller = undefined
      if (result.kind === 'ok') {
        publish({ kind: 'success', data: result.data, message: uploadMessage(result.data) })
        success(result.data)
      } else if (result.kind === 'error') publish({ kind: 'error', error: result, message: errorText(result, true) })
      else publish(initial)
    },
  }
}
