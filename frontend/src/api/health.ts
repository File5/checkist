export type CheckCode =
  | 'database_unavailable'
  | 'redis_unavailable'
  | 'broker_unavailable'
  | 'worker_unavailable'

export type ServiceCheck = { status: 'ok' } | { status: 'error'; code: CheckCode }
export type HealthChecks = Record<'database' | 'redis' | 'celery', ServiceCheck>
export type HealthErrorReason =
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'server'
  | 'http'
  | 'invalid-json'
  | 'invalid-schema'
  | 'inconsistent-response'

export type HealthResult =
  | { kind: 'ok'; checks: HealthChecks }
  | { kind: 'degraded'; checks: HealthChecks }
  | { kind: 'error'; reason: HealthErrorReason }

type ApiError = { code: string; message: string }
type HealthPayload = { status: 'ok' | 'degraded'; checks: HealthChecks; error?: ApiError }
type HealthRequestOptions = { signal?: AbortSignal; baseUrl?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

function isApiError(value: unknown): value is ApiError {
  return isRecord(value) && hasKeys(value, ['code', 'message'])
    && typeof value.code === 'string' && value.code.length > 0
    && typeof value.message === 'string' && value.message.trim().length > 0
}

function isCheck(value: unknown, allowedCodes: CheckCode[]): value is ServiceCheck {
  if (!isRecord(value)) return false
  if (value.status === 'ok') return hasKeys(value, ['status'])
  return value.status === 'error' && hasKeys(value, ['status', 'code'])
    && allowedCodes.some((code) => code === value.code)
}

function isHealthPayload(value: unknown): value is HealthPayload {
  if (!isRecord(value) || !isRecord(value.checks)) return false
  if (!hasKeys(value.checks, ['database', 'redis', 'celery'])) return false
  if (!isCheck(value.checks.database, ['database_unavailable'])
    || !isCheck(value.checks.redis, ['redis_unavailable'])
    || !isCheck(value.checks.celery, ['broker_unavailable', 'worker_unavailable'])) return false
  if (value.status === 'ok') return hasKeys(value, ['status', 'checks'])
  return value.status === 'degraded' && hasKeys(value, ['status', 'checks', 'error'])
    && isApiError(value.error) && value.error.code === 'dependency_unavailable'
}

function readResponse(status: number, body: unknown): HealthResult {
  if (isHealthPayload(body)) {
    const allOk = Object.values(body.checks).every((check) => check.status === 'ok')
    if (status === 200 && body.status === 'ok' && allOk) {
      return { kind: 'ok', checks: body.checks }
    }
    if (status === 503 && body.status === 'degraded' && !allOk) {
      return { kind: 'degraded', checks: body.checks }
    }
    return { kind: 'error', reason: 'inconsistent-response' }
  }

  if (isRecord(body) && hasKeys(body, ['error']) && isApiError(body.error)) {
    const expectedCodes: Record<number, string> = {
      405: 'method_not_allowed', 406: 'not_acceptable', 500: 'internal_error',
    }
    if (expectedCodes[status] !== body.error.code) {
      return { kind: 'error', reason: 'inconsistent-response' }
    }
    return { kind: 'error', reason: status === 500 ? 'server' : 'http' }
  }

  return { kind: 'error', reason: 'invalid-schema' }
}

export function healthUrl(base: string): string {
  const normalized = base.trim().replace(/([^:]\/)\/+/g, '$1').replace(/\/+$/, '')
  return `${normalized}/health/`
}

export async function getHealth({
  signal,
  baseUrl = import.meta.env.VITE_API_BASE_URL || '/api',
}: HealthRequestOptions = {}): Promise<HealthResult> {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  if (signal?.aborted) return { kind: 'error', reason: 'cancelled' }
  signal?.addEventListener('abort', cancel, { once: true })
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 15_000)
  const abortResult = (): HealthResult => ({
    kind: 'error', reason: timedOut ? 'timeout' : 'cancelled',
  })

  try {
    const response = await fetch(healthUrl(baseUrl), {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    })
    if (controller.signal.aborted) return abortResult()
    let body: unknown
    try {
      // Read 503 JSON too: response.ok would discard useful service checks.
      body = await response.json()
    } catch (error) {
      if (controller.signal.aborted) return abortResult()
      // A disconnected dev/preview proxy returns a non-JSON gateway error.
      if (response.status === 502 || response.status === 504) {
        return { kind: 'error', reason: 'network' }
      }
      return { kind: 'error', reason: error instanceof SyntaxError ? 'invalid-json' : 'network' }
    }
    if (controller.signal.aborted) return abortResult()
    return readResponse(response.status, body)
  } catch {
    if (controller.signal.aborted) return abortResult()
    return { kind: 'error', reason: 'network' }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}
