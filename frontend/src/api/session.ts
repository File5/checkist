import { reportAuthSignal } from './auth-signal.ts'
import { apiUrl, readError, readErrorCode, sendJson } from './http.ts'
import type { JsonRequest } from './http.ts'
import { clearRecognitionCsrf } from './local.ts'
import type { Guard } from './schema.ts'
import { isAuthCsrf, isMe, isPasswordIssues, isRetryAfter } from './session-schema.ts'
import type { PASSWORD_ISSUES } from './session-schema.ts'
import type { RequestOptions } from './types.ts'

/** «Я»: the answer of `GET /api/me/`, of a sign-in and of a password change. */
export type Me = {
  mode: 'accounts' | 'local_single'
  user: { id: number; username: string; is_staff: boolean }
  permissions: { moderate_catalog: boolean }
  /** Token of the current session. Never render it. */
  csrf_token: string
}
export type AuthCsrf = { csrf_token: string }
export type PasswordIssue = (typeof PASSWORD_ISSUES)[number]
export type AuthFailureReason =
  | 'not_authenticated' | 'invalid_credentials' | 'login_throttled'
  | 'invalid_parameter' | 'invalid_request' | 'not_found' | 'csrf_failed'
  | 'network' | 'timeout' | 'server' | 'invalid_response'
export type AuthFailure = {
  kind: 'error'
  reason: AuthFailureReason
  status?: number
  /** Invalid field names only; server messages must never reach the UI. */
  fields?: string[]
  /** Only with login_throttled: seconds until the next attempt. */
  retryAfter?: number
  /** Only with invalid_parameter of a new password: why it was refused. */
  passwordIssues?: PasswordIssue[]
}
export type AuthResult<T> = { kind: 'ok'; data: T } | AuthFailure | { kind: 'aborted' }

type Refusal401 = 'not_authenticated' | 'invalid_credentials'

/** Refusals of the sign-in routes. Anything outside their contract is `invalid_response`. */
function readAuthError(status: number, body: unknown, refusal401: Refusal401 | undefined): AuthFailure {
  const invalid: AuthFailure = { kind: 'error', reason: 'invalid_response', status }
  const code = readErrorCode(body)
  if (status === 401) return code !== undefined && code === refusal401 ? { kind: 'error', reason: code, status } : invalid
  if (status === 429) {
    if (code !== 'login_throttled') return invalid
    // The term travels next to `error`: the transport does not read headers.
    const retryAfter = (body as { retry_after?: unknown }).retry_after
    return isRetryAfter(retryAfter) ? { kind: 'error', reason: code, status, retryAfter } : invalid
  }
  const { reason, fields } = readError(status, body, true)
  switch (reason) {
    case 'invalid_parameter': {
      const issues = (body as { password_issues?: unknown }).password_issues
      if (issues !== undefined && !isPasswordIssues(issues)) return invalid
      return { kind: 'error', reason, status, ...(fields ? { fields } : {}), ...(issues?.length ? { passwordIssues: issues } : {}) }
    }
    case 'invalid_request': case 'not_found': case 'csrf_failed': case 'server':
      return { kind: 'error', reason, status }
    default: return invalid
  }
}

function send<T>(
  path: string, validate: Guard<T>, options: RequestOptions, request: Omit<JsonRequest, 'local'>, refusal401?: Refusal401,
): Promise<AuthResult<T>> {
  return sendJson(path, {}, validate, options, request, (status, body) => readAuthError(status, body, refusal401))
}

const tokens = new Map<string, string>()
const csrfKey = (options: Pick<RequestOptions, 'baseUrl'>) => apiUrl(options.baseUrl ?? (import.meta.env.VITE_API_BASE_URL || '/api'), 'auth/csrf/')

/** Forget the token of the sign-in routes. The adapters do it themselves; this is for tests and scripts changing cookies. */
export function clearAuthCsrf(options: Pick<RequestOptions, 'baseUrl'> = {}): void {
  tokens.delete(csrfKey(options))
}

/** Django replaces the token at sign-in and the session at sign-out: no token read before survives. */
function sessionChanged(options: RequestOptions, token?: string): void {
  const key = csrfKey(options)
  if (token) tokens.set(key, token)
  else tokens.delete(key)
  clearRecognitionCsrf({ baseUrl: options.baseUrl })
}

/** One CSRF-protected POST. The token before a sign-in comes from the anonymous `auth/csrf/`. Never replayed. */
async function post<T>(
  path: string, body: object, validate: Guard<T>, options: RequestOptions,
  request: Pick<JsonRequest, 'successStatuses' | 'emptyStatuses'> = {}, refusal401?: Refusal401,
): Promise<AuthResult<T>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  const key = csrfKey(options)
  let token = tokens.get(key)
  if (!token) {
    const csrf = await send('auth/csrf/', isAuthCsrf, options, {})
    if (csrf.kind !== 'ok') return csrf
    token = csrf.data.csrf_token
    tokens.set(key, token)
  }
  const result = await send(path, validate, options, {
    ...request, method: 'POST', body: JSON.stringify(body), headers: { 'X-CSRFToken': token, 'Content-Type': 'application/json' },
  }, refusal401)
  // The next explicit attempt obtains a new token.
  if (result.kind === 'error' && result.reason === 'csrf_failed' && tokens.get(key) === token) tokens.delete(key)
  return result
}

/** `not_authenticated` is the answer «guest», not a failure of the session: no signal is raised. */
export function getMe(options: RequestOptions = {}): Promise<AuthResult<Me>> {
  return send('me/', isMe, options, {}, 'not_authenticated')
}

/** A wrong sign-in is `invalid_credentials`, a delay is `login_throttled` with `retryAfter`. In local_single — `not_found`. */
export async function login(input: { username: string; password: string }, options: RequestOptions = {}): Promise<AuthResult<Me>> {
  const result = await post('auth/login/', { username: input.username, password: input.password }, isMe, options, {}, 'invalid_credentials')
  if (result.kind === 'ok') sessionChanged(options, result.data.csrf_token)
  return result
}

/** `204` without a body, for a guest too. */
export async function logout(options: RequestOptions = {}): Promise<AuthResult<null>> {
  const isEmpty = (value: unknown): value is null => value === null
  const result = await post('auth/logout/', {}, isEmpty, options, { successStatuses: [], emptyStatuses: [204] })
  if (result.kind === 'ok') sessionChanged(options)
  return result
}

/** This session stays signed in. A session that ended meanwhile is reported like in any other request. */
export async function changePassword(
  input: { current_password: string; new_password: string }, options: RequestOptions = {},
): Promise<AuthResult<Me>> {
  const result = await post('auth/password/', { current_password: input.current_password, new_password: input.new_password },
    isMe, options, {}, 'not_authenticated')
  if (result.kind === 'ok') sessionChanged(options, result.data.csrf_token)
  if (result.kind === 'error' && result.reason === 'not_authenticated') {
    reportAuthSignal('unauthenticated')
    return { kind: 'aborted' }
  }
  return result
}
