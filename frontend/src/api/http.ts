import {
  ANSWER_FRESH_MS, answerGeneration, answerKey, dropAnswer, forgetAnswers, keepAnswer, pendingRead, recallAnswer, remembersPath,
  startRefresh, trackRead,
} from './answer-cache.ts'
import { reportAuthSignal } from './auth-signal.ts'
import { OFFLINE_HEADER, reportApiAnswer } from '../offline/status.ts'
import { isRecognitionIssue } from './recognition-schema.ts'
import type { ApiFailure, ApiResult, LocalApiFailure, LocalApiResult, RequestOptions } from './types.ts'

export type Query = Record<string, string | number | boolean | undefined>
type Validator<T> = (value: unknown) => value is T

/** Same public prefix normalization as health; encode every query value exactly once. */
export function apiUrl(base: string, path: string, query: Query = {}): string {
  const normalized = base.trim().replace(/([^:]\/)\/+/g, '$1').replace(/\/+$/, '')
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
  }
  const search = params.toString()
  return `${normalized}/${path}${search ? `?${search}` : ''}`
}

/** Code of a well-formed error envelope: `{"error": {"code", "message"}}` with a non-empty message. */
export function readErrorCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('error' in body)) return undefined
  const error = body.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)
    || !('code' in error) || !('message' in error)
    || typeof error.message !== 'string' || !error.message.trim()) return undefined
  return typeof error.code === 'string' ? error.code : undefined
}

export function readError(status: number, body: unknown, local: boolean): LocalApiFailure {
  const invalid: LocalApiFailure = { kind: 'error', reason: 'invalid_response', status }
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('error' in body)) return invalid
  const error = body.error
  if (typeof error !== 'object' || error === null || Array.isArray(error)
    || !('code' in error) || !('message' in error)
    || typeof error.message !== 'string' || !error.message.trim()) return invalid
  let fields: string[] | undefined
  if ('fields' in error) {
    if (typeof error.fields !== 'object' || error.fields === null || Array.isArray(error.fields)) return invalid
    if (!Object.values(error.fields).every((messages: unknown) => Array.isArray(messages)
      && messages.every((message: unknown) => typeof message === 'string'))) return invalid
    fields = Object.keys(error.fields)
  }
  const code = error.code
  if ((status === 400 && (code === 'invalid_parameter' || code === 'invalid_request' || code === 'range_too_large'))
    || (status === 404 && (code === 'not_found' || code === 'page_out_of_range'))) {
    return { kind: 'error', reason: code, status, ...(fields ? { fields } : {}) }
  }
  const localCodes = {
    400: ['unsupported_format', 'invalid_image', 'image_too_large', 'invalid_pdf', 'pdf_encrypted', 'pdf_too_many_pages',
      'statement_unsupported_bank', 'statement_empty', 'statement_too_large'],
    403: ['csrf_failed', 'permission_denied', 'ai_disabled'],
    405: ['method_not_allowed'], 406: ['not_acceptable'],
    409: ['job_active', 'job_terminal', 'retry_not_allowed', 'merge_conflict', 'merge_resolved', 'merge_changed', 'merge_busy',
      'review_unavailable', 'review_resolved', 'review_busy', 'review_invalid',
      'classification_resolved', 'classification_changed', 'classification_busy', 'receipt_read_only', 'photo_shared',
      'store_merge_conflict',
      'push_not_configured'],
    413: ['upload_too_large'], 415: ['unsupported_media_type'], 429: ['parse_limit', 'ai_quota'],
    503: ['storage_unavailable', 'database_unavailable'],
  }
  if (local && typeof code === 'string' && localCodes[status as keyof typeof localCodes]?.includes(code)) {
    if (code === 'review_invalid') {
      // The causes travel next to `error`; without them the refusal cannot be shown at its fields.
      const issues = 'issues' in body ? body.issues : undefined
      if (!Array.isArray(issues) || issues.length > 1000 || !issues.every(isRecognitionIssue)) return invalid
      return { kind: 'error', reason: code, status, issues }
    }
    if (code === 'ai_quota') {
      // When the quota starts again travels next to `error`; a refusal without a readable term still says «закончились».
      const resetsAt = 'resets_at' in body ? body.resets_at : undefined
      return { kind: 'error', reason: code, status, ...(typeof resetsAt === 'string' && !Number.isNaN(Date.parse(resetsAt)) ? { resetsAt } : {}) }
    }
    return { kind: 'error', reason: code as LocalApiFailure['reason'], status, ...(fields ? { fields } : {}) }
  }
  if (status === 500 && code === 'internal_error') return { kind: 'error', reason: 'server', status }
  return invalid
}

/** The session ended or the right is gone: the shell is told once, the screen keeps its own result types.
 * `401 not_authenticated` is not an error of the screen: the shell replaces the page with the sign-in.
 */
export function refuse(status: number, body: unknown, local: boolean): LocalApiFailure | { kind: 'aborted' } {
  if (status === 401 && readErrorCode(body) === 'not_authenticated') {
    reportAuthSignal('unauthenticated')
    return { kind: 'aborted' }
  }
  const failure = readError(status, body, local)
  if (failure.reason === 'permission_denied') reportAuthSignal('forbidden')
  return failure
}

/** Local unsafe IDs are rejected before a rounded number can be sent to the server. */
export function invalidIds(query: Query, signal?: AbortSignal): ApiFailure | { kind: 'aborted' } | undefined {
  if (signal?.aborted) return { kind: 'aborted' }
  const fields = Object.keys(query).filter((key) => query[key] !== undefined
    && (!Number.isSafeInteger(query[key]) || Number(query[key]) < 1))
  return fields.length ? { kind: 'error', reason: 'invalid_parameter', fields } : undefined
}

export async function getJson<T>(
  path: string,
  query: Query,
  validate: Validator<T>,
  { signal, baseUrl = import.meta.env.VITE_API_BASE_URL || '/api', fresh }: RequestOptions = {},
): Promise<ApiResult<T>> {
  return requestJson(path, query, validate, { signal, baseUrl, fresh })
}

export type JsonRequest = {
  local?: boolean
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: BodyInit
  headers?: Record<string, string>
  credentials?: RequestCredentials
  successStatuses?: readonly number[]
  /** Success statuses answered without a body (204): nothing is read, the validator receives `null`. */
  emptyStatuses?: readonly number[]
  timeoutMs?: number
  /** The request outlives a closed page: `fetch(…, { keepalive: true })`. */
  keepalive?: boolean
}
/** Failures the transport produces by itself; every result type of a caller includes them. */
export type TransportFailure = { kind: 'error'; reason: 'network' | 'timeout' | 'invalid_response'; status?: number }

/** A single deadline covers fetch and body, even when either ignores abort. */
export function requestJson<T>(
  path: string, query: Query, validate: Validator<T>, options: RequestOptions | undefined,
  requestOptions: JsonRequest & { local: true },
): Promise<LocalApiResult<T>>
export function requestJson<T>(
  path: string, query: Query, validate: Validator<T>, options?: RequestOptions,
  requestOptions?: JsonRequest & { local?: false },
): Promise<ApiResult<T>>
export async function requestJson<T>(
  path: string, query: Query, validate: Validator<T>, options: RequestOptions = {}, requestOptions: JsonRequest = {},
): Promise<LocalApiResult<T>> {
  const { local = false, ...rest } = requestOptions
  return sendJson(path, query, validate, options, rest, (status, body) => refuse(status, body, local))
}

type Refusal<F> = (status: number, body: unknown) => F
type Sent<T, F> = { kind: 'ok'; data: T } | F | TransportFailure | { kind: 'aborted' }

/** The transport itself. `refusal` reads a non-success answer: sign-in calls have their own codes
 * and never raise the session signal for their own refusals.
 *
 * The memory of answers (`answer-cache.ts`): a GET of a remembered endpoint younger than 2 minutes is answered at once,
 * after the caller's validator, and when it is older than 10 seconds it is also read again in the background for the
 * next visit. `fresh` skips the memory. Any other method forgets the memory before and after itself.
 */
export async function sendJson<T, F extends { kind: 'error' } | { kind: 'aborted' }>(
  path: string, query: Query, validate: Validator<T>,
  { signal, baseUrl = import.meta.env.VITE_API_BASE_URL || '/api', fresh = false }: RequestOptions,
  requestOptions: Omit<JsonRequest, 'local'>,
  refusal: Refusal<F>,
): Promise<Sent<T, F>> {
  if (signal?.aborted) return { kind: 'aborted' }
  const url = apiUrl(baseUrl, path, query)
  if ((requestOptions.method ?? 'GET') !== 'GET') {
    // A write: whatever it changes, no answer read before it is shown again, nor one read while it runs.
    forgetAnswers()
    try {
      return await transport(url, validate, signal, requestOptions, refusal)
    } finally {
      forgetAnswers()
    }
  }
  if (!remembersPath(path)) return transport(url, validate, signal, requestOptions, refusal)
  const key = answerKey(url)
  if (!fresh) {
    const hit = recalled(key, validate)
    if (hit) {
      if (hit.age >= ANSWER_FRESH_MS) refresh(key, url, validate, requestOptions)
      return { kind: 'ok', data: hit.data }
    }
    // The same address is already being read (a warm-up, another block of the screen): its answer serves both.
    const pending = pendingRead(key)
    if (pending) {
      if (await settledOrAborted(pending, signal)) return { kind: 'aborted' }
      const joined = recalled(key, validate)
      if (joined) return { kind: 'ok', data: joined.data }
    }
  }
  const readGeneration = answerGeneration()
  const read = transport(url, validate, signal, requestOptions, refusal, (body) => keepAnswer(key, body, readGeneration))
  trackRead(key, read)
  return read
}

/** A kept answer that passes the caller's validator; anything else goes to the network. */
function recalled<T>(key: string, validate: Validator<T>): { data: T; age: number } | undefined {
  const kept = recallAnswer(key)
  if (!kept) return undefined
  try {
    return validate(kept.body) ? { data: kept.body, age: kept.age } : undefined
  } catch {
    return undefined
  }
}

/** `true` — the caller gave up while waiting for the read of another one. */
function settledOrAborted(pending: Promise<unknown>, signal?: AbortSignal): Promise<boolean> {
  if (!signal) return pending.then(() => false, () => false)
  if (signal.aborted) return Promise.resolve(true)
  return new Promise((resolve) => {
    const abort = () => resolve(true)
    signal.addEventListener('abort', abort, { once: true })
    const done = () => { signal.removeEventListener('abort', abort); resolve(false) }
    pending.then(done, done)
  })
}

/** One background read of a kept answer, for the next visit: no caller waits for it, it outlives the screen that
 * started it and its failures are ignored — a refused answer is only forgotten, so the next visit asks the network.
 * It never raises the session signal: the next request of a screen does. */
function refresh<T>(key: string, url: string, validate: Validator<T>, requestOptions: Omit<JsonRequest, 'local'>): void {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return
  const end = startRefresh(key)
  if (!end) return
  const readGeneration = answerGeneration()
  const read = transport(url, validate, undefined, requestOptions, () => {
    dropAnswer(key, readGeneration)
    return { kind: 'aborted' } as const
  }, (body) => keepAnswer(key, body, readGeneration))
  trackRead(key, read)
  read.then(end, end)
}

/** A single deadline covers fetch and body, even when either ignores abort. `keep` receives a validated `200` that
 * did not come from the cache of the service worker. */
async function transport<T, F extends { kind: 'error' } | { kind: 'aborted' }>(
  url: string, validate: Validator<T>, signal: AbortSignal | undefined,
  requestOptions: Omit<JsonRequest, 'local'>, refusal: Refusal<F>, keep?: (body: unknown) => void,
): Promise<Sent<T, F>> {
  type Result = Sent<T, F>
  if (signal?.aborted) return { kind: 'aborted' }
  const { timeoutMs = 15_000, successStatuses = [200], emptyStatuses = [], credentials = 'same-origin', headers = {}, ...init } = requestOptions
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  let timedOut = false
  let settleAbort!: (result: Result) => void
  const stopped = new Promise<Result>((resolve) => { settleAbort = resolve })
  const cancel = () => {
    controller.abort()
    settleAbort(timedOut ? { kind: 'error', reason: 'timeout' } : { kind: 'aborted' })
  }
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => { timedOut = true; cancel() }, timeoutMs)
  const interrupted = (): Result | undefined => {
    if (controller.signal.aborted) return timedOut ? { kind: 'error', reason: 'timeout' } : { kind: 'aborted' }
    if (Date.now() >= deadline) {
      timedOut = true
      cancel()
      return { kind: 'error', reason: 'timeout' }
    }
  }
  const request = async (): Promise<Result> => {
    try {
      const response = await fetch(url, {
        ...init, headers: { Accept: 'application/json', ...headers }, credentials, cache: 'no-store', signal: controller.signal,
      })
      const afterFetch = interrupted()
      if (afterFetch) return afterFetch
      // The service worker marks an answer it took from the phone (src/offline, public/sw.js).
      const served = response.headers?.get?.(OFFLINE_HEADER) === '1'
      reportApiAnswer(served)
      let body: unknown = null
      try {
        if (!emptyStatuses.includes(response.status)) body = await response.json()
      } catch (error) {
        const interruption = interrupted()
        if (interruption) return interruption
        return { kind: 'error', reason: response.status === 502 || response.status === 504 || error instanceof SyntaxError
          ? 'invalid_response' : 'network', status: response.status }
      }
      const afterBody = interrupted()
      if (afterBody) return afterBody
      if (!successStatuses.includes(response.status) && !emptyStatuses.includes(response.status)) return refusal(response.status, body)
      try {
        if (!validate(body)) return { kind: 'error', reason: 'invalid_response', status: response.status }
      } catch {
        return { kind: 'error', reason: 'invalid_response', status: response.status }
      }
      // Never an answer of the phone: it may be days old, and the memory keeps answers of the server only.
      if (keep && response.status === 200 && !served) keep(body)
      return { kind: 'ok', data: body }
    } catch {
      return interrupted() ?? { kind: 'error', reason: 'network' }
    }
  }
  try {
    // The deadline also settles a fetch/body implementation that ignores its signal.
    return await Promise.race([stopped, request()])
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}
