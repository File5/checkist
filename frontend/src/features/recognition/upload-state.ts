import type { PhotoUpload, RecognitionCsrf, RecognitionLimits } from '../../api/recognition'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { glue } from '../../lib/text'
import { reductionPlan } from './image-reduce'
import type { ImageSize, Reduced } from './image-reduce'
import { errorText, uploadLabels } from './labels'

const extensions: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', heic: 'image/heic', heif: 'image/heif',
  pdf: 'application/pdf',
}
const types = new Set(Object.values(extensions))
/** The «Выбрать файл» picker: every format of `extensions`, by type and by extension. */
export const pickAccept = [...types, ...Object.keys(extensions).map((extension) => `.${extension}`)].join(',')
export const unsupportedFormat = 'Формат не поддерживается. Выберите фото в JPEG, PNG, WebP или HEIC либо PDF.'
type Picked = Pick<File, 'name'> & { type?: string }
/** The extension names the format; a file without a known one is judged by the type the browser reports. */
export function fileFormat(file: Picked) {
  const type = file.type?.toLowerCase() ?? ''
  return extensions[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? (types.has(type) ? type : null)
}
/** «JPEG», «HEIC», «PDF»: the name of a format for a person. */
export function formatName(format: string) { return format.replace(/^(?:image|application)\//, '').toUpperCase() }
/** A PDF bill or e-receipt: the server renders its pages into one image; the browser neither shows nor reduces it. */
export function isPdf(file: Picked) { return fileFormat(file) === 'application/pdf' }
/** Pages of a PDF read from its text, or null when they cannot be told (compressed object streams).
 * Each page object is counted once by its object number, so an incrementally saved PDF is not counted twice.
 * Only a hint for the person: the server counts the pages and refuses a longer PDF.
 */
export function pdfPageCount(text: string): number | null {
  const pages = new Set<string>()
  for (const match of text.matchAll(/(\d+)\s+\d+\s+obj\s*<<(?:(?!endobj)[\s\S]){0,4000}?\/Type\s*\/Page(?![A-Za-z])/g)) pages.add(match[1])
  return pages.size || null
}
/** «PDF, 2 стр.» or «PDF» when the pages are unknown. */
export function pdfSummary(pages: number | null) { return pages ? glue('PDF,', pages, 'стр.') : 'PDF' }
/** HEIF/HEIC: the server converts it to JPEG; many browsers cannot even show it. */
export function isHeif(file: Picked) { const format = fileFormat(file); return format === 'image/heic' || format === 'image/heif' }
/** Format and emptiness: what no reduction can repair. */
export function validateFormat(file: Picked & Pick<File, 'size'>, limits?: RecognitionLimits): string | undefined {
  const format = fileFormat(file)
  if (!format || (limits && !limits.formats.includes(format as RecognitionLimits['formats'][number]))) return unsupportedFormat
  if (file.size === 0) return 'Файл пуст. Выберите другое фото.'
}
/** The file exactly as it would be sent. */
export function validateFile(file: Picked & Pick<File, 'size'>, limits?: RecognitionLimits): string | undefined {
  const invalid = validateFormat(file, limits)
  if (invalid) return invalid
  if (limits && file.size > limits.max_bytes) return 'Файл слишком большой. Уменьшите его размер до лимита сервера.'
}
/** The photo taken with «Снять чек» goes by itself, once. `pending` is that photo until its turn has come.
 * `wait` — not yet sendable (conditions, preview size, a refresh or another sending); `drop` — its turn has come but
 * the format is refused, so the person sees the error and nothing goes; `send` — the same submit as the button.
 */
export function autoSendStep(
  { file, pending, limits, invalid, measuring, refreshing, idle }:
  { file?: File; pending?: File; limits?: RecognitionLimits; invalid?: string; measuring: boolean; refreshing: boolean; idle: boolean },
): 'none' | 'wait' | 'drop' | 'send' {
  if (!file || pending !== file) return 'none'
  if (!limits || measuring || refreshing || !idle) return 'wait'
  return invalid ? 'drop' : 'send'
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
      // A PDF goes as it is: its limit is the bytes, the server renders the pages.
      const mustReduce = !isPdf(file) && !reduced && reductionPlan({ ...size, bytes: file.size }, limits).kind === 'reduce'
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
        // A browser that cannot decode HEIC cannot reduce it either: the original goes and the server answers.
        if (made) reduced = { ...made, source: file }
        else if (!isHeif(file)) { controller = undefined; publish({ kind: 'error', message: uploadLabels.reduceFailed }); return }
      }
      const outgoing = reduced?.file ?? file
      // The limits may have changed since the copy was made. An unreduced HEIC over the bytes is the server's to refuse.
      const invalid = mustReduce && !reduced ? validateFormat(outgoing, limits) : validateFile(outgoing, limits)
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
