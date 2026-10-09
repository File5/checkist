import type { PhotoUpload, RecognitionCsrf, RecognitionLimits } from '../../api/recognition'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { glue } from '../../lib/text'
import { reductionPlan } from './image-reduce'
import type { ImageSize, Reduced } from './image-reduce'
import { errorText, uploadLabels } from './labels'

const extensions: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }
const types = new Set(Object.values(extensions))
type Picked = Pick<File, 'name'> & { type?: string }
/** The extension names the format; a file without a known one is judged by the type the browser reports. */
export function fileFormat(file: Picked) {
  const type = file.type?.toLowerCase() ?? ''
  return extensions[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? (types.has(type) ? type : null)
}
/** Format and emptiness: what no reduction can repair. */
export function validateFormat(file: Picked & Pick<File, 'size'>, limits?: RecognitionLimits): string | undefined {
  const format = fileFormat(file)
  if (!format || (limits && !limits.formats.includes(format as RecognitionLimits['formats'][number]))) return 'Формат не поддерживается. HEIC и другие форматы сохраните в JPEG или PNG.'
  if (file.size === 0) return 'Файл пуст. Выберите другое фото.'
}
/** The file exactly as it would be sent. */
export function validateFile(file: Picked & Pick<File, 'size'>, limits?: RecognitionLimits): string | undefined {
  const invalid = validateFormat(file, limits)
  if (invalid) return invalid
  if (limits && file.size > limits.max_bytes) return 'Файл слишком большой. Уменьшите его размер до лимита сервера.'
}
export function formatBytes(bytes: number) { return `${glue((bytes / 1048576).toLocaleString('ru-RU', { maximumFractionDigits: 2 }), 'МиБ')} (${glue(bytes.toLocaleString('ru-RU'), 'байт')})` }
const mib = (bytes: number) => (bytes / 1048576).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
/** «2,1 из 5,3 МиБ»: one value, never split. */
export function progressValue(sent: number, total: number) { return glue(mib(Math.min(sent, total)), 'из', mib(total), 'МиБ') }
/** Says only what happened to the photo. The worker line comes from the current job snapshot. */
export function uploadMessage(result: PhotoUpload) {
  return result.reused ? 'Это фото уже было загружено. Открыто последнее задание этого фото.' : 'Фото загружено. Задание принято.'
}

let notice: { id: number; message: string } | undefined
export function setJobNotice(id: number, message: string) { notice = { id, message } }
export const retryNotice = 'Создано новое задание обработки.'
export function getJobNotice(id: number) { return notice?.id === id ? notice.message : undefined }

/** `reducing` — the photo is drawn again; `uploading` — bytes leave the browser; `waiting` — all sent, no answer yet. */
export type UploadStage = 'reducing' | 'uploading' | 'waiting'
/** The reduced copy of `source`: made once and sent again on every repeat of the same photo. */
export type ReducedPhoto = Reduced & { source: File }
type Step =
  | { kind: 'idle' }
  | { kind: 'sending'; stage: UploadStage; sent?: number; total?: number }
  | { kind: 'cancelled'; message: string }
  | { kind: 'error'; message: string; error?: LocalApiFailure; csrfRefreshed?: boolean }
  | { kind: 'success'; data: PhotoUpload; message: string }
export type UploadState = Step & { reduced?: ReducedPhoto }

export function createUpload(
  send: (file: File, signal: AbortSignal, onProgress: (sent: number, total: number) => void) => Promise<LocalApiResult<PhotoUpload>>,
  refreshCsrf: (signal: AbortSignal) => Promise<LocalApiResult<RecognitionCsrf>>,
  success: (result: PhotoUpload) => void,
  limitsChanged: (data: RecognitionCsrf) => void,
  reduce?: (file: File, limits: RecognitionLimits, signal: AbortSignal) => Promise<Reduced>,
) {
  const initial: UploadState = { kind: 'idle' }
  let state: UploadState = initial
  let controller: AbortController | undefined
  let generation = 0
  let reduced: ReducedPhoto | undefined
  const listeners = new Set<() => void>()
  const publish = (next: Step) => { state = reduced ? { ...next, reduced } : next; listeners.forEach((listener) => listener()) }
  const stop = () => { generation++; controller?.abort(); controller = undefined }
  /** Another photo, or the screen is gone: the reduced copy is forgotten with it. */
  const reset = () => { stop(); reduced = undefined; publish(initial) }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    reset, dispose: reset,
    /** The person stops the sending. Nothing is replayed; the reduced copy stays for the repeat. */
    cancel: () => {
      if (!controller || state.kind !== 'sending') return
      const reducing = state.stage === 'reducing'
      stop()
      publish({ kind: 'cancelled', message: reducing ? uploadLabels.cancelledReducing : uploadLabels.cancelled })
    },
    /** `size` is the pixel size read from the preview; without it only the bytes decide about the reduction. */
    submit: async (file: File, limits: RecognitionLimits, size?: ImageSize) => {
      if (controller) return
      const unsupported = validateFormat(file, limits)
      if (unsupported) { publish({ kind: 'error', message: unsupported }); return }
      if (reduced && reduced.source !== file) reduced = undefined
      const mustReduce = !reduced && reductionPlan({ ...size, bytes: file.size }, limits).kind === 'reduce'
      // Without a way to reduce, the former refusal stands.
      if (mustReduce && !reduce) { publish({ kind: 'error', message: validateFile(file, limits) ?? errorText({ kind: 'error', reason: 'image_too_large' }) }); return }
      const current = new AbortController()
      controller = current
      const stamp = ++generation
      const stale = () => stamp !== generation || current.signal.aborted
      if (mustReduce && reduce) {
        publish({ kind: 'sending', stage: 'reducing' })
        let made: Reduced | undefined
        try { made = await reduce(file, limits, current.signal) }
        catch { made = undefined }
        if (stale()) return
        if (!made) { controller = undefined; publish({ kind: 'error', message: uploadLabels.reduceFailed }); return }
        reduced = { ...made, source: file }
      }
      const outgoing = reduced?.file ?? file
      // The limits may have changed since the copy was made.
      const invalid = validateFile(outgoing, limits)
      if (invalid) { controller = undefined; publish({ kind: 'error', message: reduced ? uploadLabels.reduceFailed : invalid }); return }
      publish({ kind: 'sending', stage: 'uploading' })
      const progress = (sent: number, total: number) => {
        if (stale() || state.kind !== 'sending' || state.stage === 'reducing') return
        publish({ kind: 'sending', stage: total > 0 && sent >= total ? 'waiting' : 'uploading', sent, total })
      }
      let result: LocalApiResult<PhotoUpload>
      try { result = await send(outgoing, current.signal, progress) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (stale()) return
      if (result.kind === 'error' && result.reason === 'csrf_failed') {
        let csrf: LocalApiResult<RecognitionCsrf>
        try { csrf = await refreshCsrf(current.signal) }
        catch { csrf = { kind: 'error', reason: 'network' } }
        if (stale()) return
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
