import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getHealth, healthUrl } from './health'

const healthy = {
  status: 'ok',
  checks: { database: { status: 'ok' }, redis: { status: 'ok' }, celery: { status: 'ok' } },
}
const degraded = {
  status: 'degraded',
  checks: {
    database: { status: 'ok' },
    redis: { status: 'ok' },
    celery: { status: 'error', code: 'worker_unavailable' },
  },
  error: { code: 'dependency_unavailable', message: 'Один или несколько сервисов недоступны.' },
}
const fetchMock = vi.fn<typeof fetch>()

function reply(body: unknown, status = 200) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }))
}

function pendingRequest() {
  fetchMock.mockImplementation((_url, options) => new Promise((_resolve, reject) => {
    options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  }))
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('health URL and request', () => {
  it.each([
    ['/api', '/api/health/'],
    ['/api/', '/api/health/'],
    [' /api/// ', '/api/health/'],
    ['/api//v1/', '/api/v1/health/'],
    ['/', '/health/'],
    ['http://127.0.0.1:18000/api///', 'http://127.0.0.1:18000/api/health/'],
  ])('normalizes %s', (base, expected) => {
    expect(healthUrl(base)).toBe(expected)
  })

  it('uses the public default base, anonymous JSON GET, and a cancellable signal', async () => {
    reply(healthy)
    expect(await getHealth()).toEqual({ kind: 'ok', checks: healthy.checks })
    expect(fetchMock).toHaveBeenCalledWith('/api/health/', {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      cache: 'no-store',
      signal: expect.any(AbortSignal),
    })
  })
})

describe('health contract', () => {
  it('accepts a valid 200', async () => {
    reply(healthy)
    expect(await getHealth()).toEqual({ kind: 'ok', checks: healthy.checks })
  })

  it('keeps every check from a valid 503', async () => {
    reply(degraded, 503)
    expect(await getHealth()).toEqual({ kind: 'degraded', checks: degraded.checks })
  })

  it.each([
    ['database', 'database_unavailable'],
    ['redis', 'redis_unavailable'],
    ['celery', 'broker_unavailable'],
    ['celery', 'worker_unavailable'],
  ])('accepts the documented %s failure %s', async (service, code) => {
    const body = {
      ...degraded,
      checks: { ...healthy.checks, [service]: { status: 'error', code } },
    }
    reply(body, 503)
    expect(await getHealth()).toEqual({ kind: 'degraded', checks: body.checks })
  })

  it('preserves simultaneous failures', async () => {
    const body = {
      ...degraded,
      checks: {
        database: { status: 'error', code: 'database_unavailable' },
        redis: { status: 'error', code: 'redis_unavailable' },
        celery: { status: 'error', code: 'broker_unavailable' },
      },
    }
    reply(body, 503)
    expect(await getHealth()).toEqual({ kind: 'degraded', checks: body.checks })
  })

  it.each([
    [405, 'method_not_allowed', 'http'],
    [406, 'not_acceptable', 'http'],
    [500, 'internal_error', 'server'],
  ])('handles documented HTTP %s without exposing its message', async (status, code, reason) => {
    reply({ error: { code, message: 'Не выводить адрес или стек из ответа.' } }, status)
    expect(await getHealth()).toEqual({ kind: 'error', reason })
  })

  it('rejects malformed JSON', async () => {
    fetchMock.mockResolvedValue(new Response('<html>ошибка</html>'))
    expect(await getHealth()).toEqual({ kind: 'error', reason: 'invalid-json' })
  })

  it.each([
    null,
    [],
    {},
    { status: 'unknown', checks: healthy.checks },
    { ...healthy, checks: { database: { status: 'ok' } } },
    { ...healthy, checks: { ...healthy.checks, extra: { status: 'ok' } } },
    { ...healthy, checks: { ...healthy.checks, redis: { status: 'ok', code: 'redis_unavailable' } } },
    { ...degraded, checks: { ...degraded.checks, celery: { status: 'error', code: 'unknown' } } },
    { ...degraded, checks: { ...degraded.checks, database: { status: 'error', code: 'redis_unavailable' } } },
    { status: 'degraded', checks: degraded.checks },
    { ...degraded, error: { code: 'other', message: 'Ошибка.' } },
    { ...degraded, error: { code: 'dependency_unavailable', message: 42 } },
    { ...healthy, secret: 'extra field' },
  ])('rejects invalid schema %#', async (body) => {
    reply(body, 503)
    expect(await getHealth()).toEqual({ kind: 'error', reason: 'invalid-schema' })
  })

  it.each([
    [200, degraded],
    [503, healthy],
    [500, healthy],
    [201, healthy],
    [200, { ...healthy, checks: degraded.checks }],
    [503, { ...degraded, checks: healthy.checks }],
    [200, { error: { code: 'internal_error', message: 'Ошибка.' } }],
    [503, { error: { code: 'dependency_unavailable', message: 'Ошибка.' } }],
    [500, { error: { code: 'method_not_allowed', message: 'Ошибка.' } }],
  ])('rejects inconsistent HTTP/body pair %#', async (status, body) => {
    reply(body, status)
    expect(await getHealth()).toEqual({ kind: 'error', reason: 'inconsistent-response' })
  })
})

describe('network, timeout and cancellation', () => {
  it('returns a safe network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed at private address'))
    expect(await getHealth()).toEqual({ kind: 'error', reason: 'network' })
  })

  it.each([502, 504])('handles a non-JSON proxy failure HTTP %s as unavailable connection', async (status) => {
    fetchMock.mockResolvedValue(new Response('', { status }))
    expect(await getHealth()).toEqual({ kind: 'error', reason: 'network' })
  })

  it('aborts at 15 seconds and releases the timer', async () => {
    vi.useFakeTimers()
    pendingRequest()
    const request = getHealth()
    await vi.advanceTimersByTimeAsync(14_999)
    const signal = fetchMock.mock.calls[0][1]?.signal
    expect(signal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await request).toEqual({ kind: 'error', reason: 'timeout' })
    expect(signal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('covers the response body read with the same deadline', async () => {
    vi.useFakeTimers()
    fetchMock.mockImplementation(async (_url, options) => ({
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      }),
    }) as Response)
    const request = getHealth()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await request).toEqual({ kind: 'error', reason: 'timeout' })
  })

  it('forwards external cancellation without treating it as a timeout', async () => {
    vi.useFakeTimers()
    pendingRequest()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    const request = getHealth({ signal: controller.signal })
    controller.abort()
    expect(await request).toEqual({ kind: 'error', reason: 'cancelled' })
    expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not fetch for an already cancelled caller', async () => {
    const controller = new AbortController()
    controller.abort()
    expect(await getHealth({ signal: controller.signal })).toEqual({ kind: 'error', reason: 'cancelled' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('discards a late response even if fetch ignored abort', async () => {
    let resolveFetch!: (response: Response) => void
    fetchMock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve }))
    const controller = new AbortController()
    const request = getHealth({ signal: controller.signal })
    controller.abort()
    resolveFetch(new Response(JSON.stringify(healthy)))
    expect(await request).toEqual({ kind: 'error', reason: 'cancelled' })
  })

  it('releases its timer/listener after success and sends a new request on repeat', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    reply(healthy)
    expect((await getHealth({ signal: controller.signal })).kind).toBe('ok')
    expect(vi.getTimerCount()).toBe(0)
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function))
    fetchMock.mockRejectedValue(new TypeError('network failure'))
    expect(await getHealth()).toEqual({ kind: 'error', reason: 'network' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
})
