import { apiUrl, invalidIds, requestJson } from './http.ts'
import type { Query } from './http.ts'
import { isJob, isJobDetail, isPhoto, isPhotoUpload, isReceiptImage, isReceiptImageDetail, isRecognitionCsrf } from './recognition-schema.ts'
import { page } from './schema.ts'
import type { Guard } from './schema.ts'
import type { LocalApiResult, Page, RequestOptions } from './types.ts'
import type { Job, JobDetail, JobParams, Photo, PhotoParams, PhotoUpload, ReceiptImage, ReceiptImageDetail, ReceiptImageParams, RecognitionCsrf } from './recognition-types.ts'

export type * from './recognition-types.ts'

/** New local API always carries the anonymous CSRF cookie on this origin. */
export function getLocalJson<T>(path: string, query: Query, validate: Guard<T>, options: RequestOptions = {}): Promise<LocalApiResult<T>> {
  return requestJson(path, query, validate, options, { credentials: 'same-origin', local: true })
}

type CsrfPending = { controller: AbortController; subscribers: number; settled: boolean; promise: Promise<LocalApiResult<RecognitionCsrf>> }
const tokens = new Map<string, string>()
const pendingCsrf = new Map<string, CsrfPending>()
const csrfKey = (options: Pick<RequestOptions, 'baseUrl'>) => apiUrl(options.baseUrl ?? (import.meta.env.VITE_API_BASE_URL || '/api'), 'recognition/csrf/')

/** Explicit refresh also returns current limits/executor; concurrent callers share it.
 * Each caller can abort independently. The last caller aborts the shared fetch.
 */
export function getRecognitionCsrf(options: RequestOptions = {}): Promise<LocalApiResult<RecognitionCsrf>> {
  if (options.signal?.aborted) return Promise.resolve({ kind: 'aborted' })
  const key = csrfKey(options)
  let pending = pendingCsrf.get(key)
  if (!pending) {
    const controller = new AbortController()
    const entry: CsrfPending = { controller, subscribers: 0, settled: false, promise: Promise.resolve({ kind: 'aborted' }) }
    entry.promise = getLocalJson('recognition/csrf/', {}, isRecognitionCsrf, { baseUrl: options.baseUrl, signal: controller.signal }).then((result) => {
      entry.settled = true
      if (pendingCsrf.get(key) === entry) {
        pendingCsrf.delete(key)
        if (result.kind === 'ok' && !controller.signal.aborted) tokens.set(key, result.data.csrf_token)
      }
      return result
    })
    pendingCsrf.set(key, entry)
    pending = entry
  }
  const entry = pending
  entry.subscribers++
  return new Promise((resolve) => {
    let finished = false
    const finish = (result: LocalApiResult<RecognitionCsrf>) => {
      if (finished) return
      finished = true
      options.signal?.removeEventListener('abort', abort)
      entry.subscribers--
      if (!entry.settled && entry.subscribers === 0) {
        if (pendingCsrf.get(key) === entry) pendingCsrf.delete(key)
        entry.controller.abort()
      }
      resolve(result)
    }
    const abort = () => finish({ kind: 'aborted' })
    options.signal?.addEventListener('abort', abort, { once: true })
    entry.promise.then(finish)
  })
}

/** Useful after cookie/session changes. No tokens persist outside this module. */
export function clearRecognitionCsrf(options: Pick<RequestOptions, 'baseUrl'> = {}): void {
  const key = csrfKey(options)
  tokens.delete(key)
  const pending = pendingCsrf.get(key)
  pendingCsrf.delete(key)
  pending?.controller.abort()
}

async function mutate<T>(path: string, body: BodyInit, validate: Guard<T>, options: RequestOptions, multipart = false): Promise<LocalApiResult<T>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  const key = csrfKey(options)
  let token = tokens.get(key)
  if (!token) {
    const csrf = await getRecognitionCsrf(options)
    if (csrf.kind !== 'ok') return csrf
    token = csrf.data.csrf_token
  }
  const result = await requestJson(path, {}, validate, options, {
    local: true, method: 'POST', body, credentials: 'same-origin', timeoutMs: multipart ? 60_000 : 15_000,
    successStatuses: [200, 202], headers: { 'X-CSRFToken': token, ...(!multipart && { 'Content-Type': 'application/json' }) },
  })
  // Never replay a mutation implicitly. The next explicit attempt obtains a new token.
  if (result.kind === 'error' && result.reason === 'csrf_failed' && tokens.get(key) === token) tokens.delete(key)
  return result
}

export function uploadPhoto(file: File, options: RequestOptions = {}): Promise<LocalApiResult<PhotoUpload>> {
  const body = new FormData()
  body.append('file', file)
  return mutate('recognition/photos/', body, isPhotoUpload, options, true)
}
export function getPhotos(params: PhotoParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Photo>>> {
  return getLocalJson('recognition/photos/', params, page(isPhoto), options)
}
export async function getPhoto(id: number, options: RequestOptions = {}): Promise<LocalApiResult<Photo>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`recognition/photos/${id}/`, {}, isPhoto, options)
}
export async function getJobs(params: JobParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Job>>> {
  return invalidIds({ photo: params.photo }, options.signal) ?? getLocalJson('recognition/jobs/', params, page(isJob), options)
}
export async function getJob(id: number, options: RequestOptions = {}): Promise<LocalApiResult<JobDetail>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`recognition/jobs/${id}/`, {}, isJobDetail, options)
}
export async function cancelJob(id: number, options: RequestOptions = {}): Promise<LocalApiResult<JobDetail>> {
  return invalidIds({ id }, options.signal) ?? mutate(`recognition/jobs/${id}/cancel/`, '{}', isJobDetail, options)
}
export async function retryJob(id: number, options: RequestOptions = {}): Promise<LocalApiResult<JobDetail>> {
  return invalidIds({ id }, options.signal) ?? mutate(`recognition/jobs/${id}/retry/`, '{}', isJobDetail, options)
}
export async function getReceiptImages(params: ReceiptImageParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<ReceiptImage>>> {
  return invalidIds({ photo: params.photo, job: params.job, receipt: params.receipt }, options.signal)
    ?? getLocalJson('recognition/receipt-images/', params, page(isReceiptImage), options)
}
export async function getReceiptImage(id: number, options: RequestOptions = {}): Promise<LocalApiResult<ReceiptImageDetail>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`recognition/receipt-images/${id}/`, {}, isReceiptImageDetail, options)
}
