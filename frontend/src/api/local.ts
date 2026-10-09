import { apiUrl, refuse, requestJson } from './http.ts'
import type { Query } from './http.ts'
import { isRecognitionCsrf } from './recognition-schema.ts'
import type { Guard } from './schema.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'
import type { RecognitionCsrf } from './recognition-types.ts'
import { canReportProgress, sendUpload } from './upload-transport.ts'
import type { UploadProgress } from './upload-transport.ts'

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

/** One CSRF-protected POST of the local API, shared by recognition and product merges.
 * `onProgress` moves a multipart body to XMLHttpRequest where it exists: same refusals and session signal, the deadline
 * is «no movement» instead of the total 60 s. Without it, or without XMLHttpRequest (Node), the `fetch` path is unchanged.
 */
export async function mutate<T>(
  path: string, body: BodyInit, validate: Guard<T>, options: RequestOptions, multipart = false, onProgress?: UploadProgress,
): Promise<LocalApiResult<T>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  const key = csrfKey(options)
  let token = tokens.get(key)
  if (!token) {
    const csrf = await getRecognitionCsrf(options)
    if (csrf.kind !== 'ok') return csrf
    token = csrf.data.csrf_token
  }
  const result: LocalApiResult<T> = onProgress && body instanceof FormData && canReportProgress()
    ? await sendUpload(apiUrl(options.baseUrl ?? (import.meta.env.VITE_API_BASE_URL || '/api'), path), body, validate,
      { signal: options.signal, headers: { 'X-CSRFToken': token }, successStatuses: [200, 202], onProgress },
      (status, answer) => refuse(status, answer, true))
    : await requestJson(path, {}, validate, options, {
      local: true, method: 'POST', body, credentials: 'same-origin', timeoutMs: multipart ? 60_000 : 15_000,
      successStatuses: [200, 202], headers: { 'X-CSRFToken': token, ...(!multipart && { 'Content-Type': 'application/json' }) },
    })
  // Never replay a mutation implicitly. The next explicit attempt obtains a new token.
  if (result.kind === 'error' && result.reason === 'csrf_failed' && tokens.get(key) === token) tokens.delete(key)
  return result
}
