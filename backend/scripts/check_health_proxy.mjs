// Node 24 strips the adapter's TypeScript; no browser or mocked fetch is used.
import assert from 'node:assert/strict'
import { getHealth } from '../../frontend/src/api/health.ts'

const [state = 'healthy', proxyOrigin = 'http://127.0.0.1:15173'] = process.argv.slice(2)
assert.equal(process.env.POSTGRES_DB, 'checkist_qa', 'Apply the full QA environment first')
assert.equal(process.env.VITE_API_BASE_URL, '/api', 'QA must use the same-origin /api prefix')
assert.ok(['healthy', 'worker', 'postgres', 'redis'].includes(state), 'Unknown expected state')
assert.ok(process.argv.length <= 4, 'Usage: node check_health_proxy.mjs [state] [proxy-origin]')

function localOrigin(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:')
  assert.equal(url.hostname, '127.0.0.1')
  assert.equal(url.href, `${url.origin}/`, 'Use a loopback origin without credentials or path')
  return url.origin
}

const apiOrigin = localOrigin(process.env.DEV_API_PROXY_TARGET)
const proxy = localOrigin(proxyOrigin)
const checks = {
  database: { status: 'ok' }, redis: { status: 'ok' }, celery: { status: 'ok' },
}
if (state === 'worker') checks.celery = { status: 'error', code: 'worker_unavailable' }
if (state === 'postgres') checks.database = { status: 'error', code: 'database_unavailable' }
if (state === 'redis') {
  checks.redis = { status: 'error', code: 'redis_unavailable' }
  checks.celery = { status: 'error', code: 'broker_unavailable' }
}
const healthy = state === 'healthy'
const expectedBody = {
  status: healthy ? 'ok' : 'degraded', checks,
  ...(!healthy && { error: {
    code: 'dependency_unavailable', message: 'Один или несколько сервисов недоступны.',
  } }),
}

async function checkHttp(origin, options, status, body) {
  const started = performance.now()
  const response = await fetch(`${origin}/api/health/`, {
    headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store',
    ...options, signal: AbortSignal.timeout(15_000),
  })
  assert.equal(response.status, status)
  assert.equal(response.headers.get('content-type'), 'application/json')
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal(response.headers.get('allow'), 'GET, HEAD, OPTIONS')
  assert.deepEqual(await response.json(), body)
  const seconds = (performance.now() - started) / 1000
  if (status === 503) assert.ok(seconds <= 10, `503 took ${seconds}s; limit is 10s`)
  console.log(`${options.method || 'GET'} ${origin}/api/health/: ${status}, ${seconds.toFixed(3)}s`)
}

await checkHttp(apiOrigin, {}, healthy ? 200 : 503, expectedBody)
await checkHttp(proxy, {}, healthy ? 200 : 503, expectedBody)
assert.deepEqual(await getHealth({ baseUrl: `${proxy}/api` }), {
  kind: healthy ? 'ok' : 'degraded', checks,
})
console.log(`Real frontend adapter through proxy: ${healthy ? 'ok' : 'degraded'}, exact checks preserved`)

if (healthy) {
  await checkHttp(proxy, { method: 'POST' }, 405, {
    error: { code: 'method_not_allowed', message: 'Метод не поддерживается.' },
  })
  await checkHttp(proxy, { headers: { Accept: 'text/html' } }, 406, {
    error: { code: 'not_acceptable', message: 'Доступен только JSON.' },
  })
}
