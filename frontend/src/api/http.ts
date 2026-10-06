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
    400: ['unsupported_format', 'invalid_image', 'image_too_large'],
    403: ['csrf_failed', 'permission_denied'],
    405: ['method_not_allowed'], 406: ['not_acceptable'],
    409: ['job_active', 'job_terminal', 'retry_not_allowed', 'merge_conflict', 'merge_resolved', 'merge_changed', 'merge_busy',
      'review_unavailable', 'review_resolved', 'review_busy', 'review_invalid'],
    413: ['upload_too_large'], 415: ['unsupported_media_type'],
    503: ['storage_unavailable', 'database_unavailable'],
  }
  if (local && typeof code === 'string' && localCodes[status as keyof typeof localCodes]?.includes(code)) {
    if (code === 'review_invalid') {
      // The causes travel next to `error`; without them the refusal cannot be shown at its fields.
      const issues = 'issues' in body ? body.issues : undefined
      if (!Array.isArray(issues) || issues.length > 1000 || !issues.every(isRecognitionIssue)) return invalid
      return { kind: 'error', reason: code, status, issues }
    }
    return { kind: 'error', reason: code as LocalApiFailure['reason'], status, ...(fields ? { fields } : {}) }
  }
  if (status === 500 && code === 'internal_error') return { kind: 'error', reason: 'server', status }
  return invalid
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
  { signal, baseUrl = import.meta.env.VITE_API_BASE_URL || '/api' }: RequestOptions = {},
): Promise<ApiResult<T>> {
  return requestJson(path, query, validate, { signal, baseUrl })
}

export type JsonRequest = {
  local?: boolean
  method?: 'GET' | 'POST'
  body?: BodyInit
  headers?: Record<string, string>
  credentials?: RequestCredentials
  successStatuses?: readonly number[]
  timeoutMs?: number
}

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
  path: string, query: Query, validate: Validator<T>,
  { signal, baseUrl = import.meta.env.VITE_API_BASE_URL || '/api' }: RequestOptions = {},
  requestOptions: JsonRequest = {},
): Promise<LocalApiResult<T>> {
  if (signal?.aborted) return { kind: 'aborted' }
  const { timeoutMs = 15_000, successStatuses = [200], credentials = 'omit', headers = {}, local = false, ...init } = requestOptions
  const controller = new AbortController()
  const deadline = Date.now() + timeoutMs
  let timedOut = false
  let settleAbort!: (result: LocalApiResult<T>) => void
  const stopped = new Promise<LocalApiResult<T>>((resolve) => { settleAbort = resolve })
  const cancel = () => {
    controller.abort()
    settleAbort(timedOut ? { kind: 'error', reason: 'timeout' } : { kind: 'aborted' })
  }
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => { timedOut = true; cancel() }, timeoutMs)
  const interrupted = (): LocalApiResult<T> | undefined => {
    if (controller.signal.aborted) return timedOut ? { kind: 'error', reason: 'timeout' } : { kind: 'aborted' }
    if (Date.now() >= deadline) {
      timedOut = true
      cancel()
      return { kind: 'error', reason: 'timeout' }
    }
  }
  const request = async (): Promise<LocalApiResult<T>> => {
    try {
      const response = await fetch(apiUrl(baseUrl, path, query), {
        ...init, headers: { Accept: 'application/json', ...headers }, credentials, cache: 'no-store', signal: controller.signal,
      })
      const afterFetch = interrupted()
      if (afterFetch) return afterFetch
      let body: unknown
      try {
        body = await response.json()
      } catch (error) {
        const interruption = interrupted()
        if (interruption) return interruption
        return { kind: 'error', reason: response.status === 502 || response.status === 504 || error instanceof SyntaxError
          ? 'invalid_response' : 'network', status: response.status }
      }
      const afterBody = interrupted()
      if (afterBody) return afterBody
      if (!successStatuses.includes(response.status)) return readError(response.status, body, local)
      try {
        return validate(body) ? { kind: 'ok', data: body } : { kind: 'error', reason: 'invalid_response', status: response.status }
      } catch {
        return { kind: 'error', reason: 'invalid_response', status: response.status }
      }
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
