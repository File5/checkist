// Mutating QA acceptance through real Vite dev/preview. No browser automation.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer, preview } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const mode = process.argv[2]
const originalFetch = globalThis.fetch
const workers = new Set()
const lifetimes = new Set()
const requests = []
let loader, proxy, cookie = ''

function loopback(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:', 'Only HTTP loopback QA origins are allowed')
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))
  assert.equal(url.pathname, '/')
  assert.equal(url.username + url.password + url.search + url.hash, '')
  assert.ok(url.port && !['8000', '5173', '5432', '15432'].includes(url.port), 'Do not use dev ports')
  return url
}
function ok(result) {
  assert.equal(result.kind, 'ok', JSON.stringify(result))
  return result.data
}
async function until(read, condition) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const result = await read()
    if (condition(result)) return result
    await delay(100)
  }
  throw new Error('Timed out waiting for the expected QA job state')
}
function worker(scenario) {
  const child = spawn(join(root, 'backend/.venv/Scripts/python.exe'), [
    '-X', 'utf8', join(root, 'backend/manage.py'), 'recognition_worker', '--once', '--fake-scenario', scenario,
  ], { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  let timeout
  const completion = new Promise((resolve, reject) => {
    timeout = setTimeout(() => { child.kill(); reject(new Error(`Fake worker ${scenario} timed out`)) }, 30_000)
    child.once('error', reject)
    child.once('exit', (code) => {
      code === 0 ? resolve(output.trim()) : reject(new Error(`Fake worker ${scenario}: exit ${code}; ${output.trim()}`))
    })
  }).finally(() => { clearTimeout(timeout); workers.delete(handle) })
  const handle = { child, completion }
  workers.add(handle)
  completion.catch(() => {}) // A failing assertion may trigger cleanup before awaiting the worker.
  return completion
}

try {
  assert.ok(['dev', 'preview'].includes(mode), 'Usage: node frontend/scripts/check_recognition_proxy.mjs dev|preview [http://127.0.0.1:15173]')
  assert.match(process.env.POSTGRES_DB ?? '', /^checkist_qa(?:_[a-zA-Z0-9]+)*$/)
  assert.equal(process.env.COMPOSE_PROJECT_NAME, process.env.POSTGRES_DB, 'Use a dedicated QA Compose project/database')
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.POSTGRES_HOST))
  assert.ok(process.env.POSTGRES_PORT && !['5432', '15432'].includes(process.env.POSTGRES_PORT))
  assert.equal(process.env.RECEIPT_OCR_PROVIDER, 'fake', 'Never invoke Codex from this script')
  assert.equal(process.env.DJANGO_DEBUG, '1')
  assert.equal(process.env.ALLOW_LOCAL_RECOGNITION_API, '1')
  assert.equal(process.env.VITE_API_BASE_URL, '/api')
  for (const key of ['MEDIA_ROOT', 'RECEIPT_OCR_TEMP_ROOT']) assert.ok(isAbsolute(process.env[key] ?? ''), `${key} must be absolute`)
  const media = resolve(process.env.MEDIA_ROOT), scratch = resolve(process.env.RECEIPT_OCR_TEMP_ROOT)
  const contains = (a, b) => { const path = relative(a, b); return !path || (!path.startsWith('..') && !isAbsolute(path)) }
  assert.ok(!contains(media, scratch) && !contains(scratch, media), 'MEDIA and scratch must not overlap')
  const origin = loopback(process.argv[3] ?? 'http://127.0.0.1:15173')
  const target = loopback(process.env.DEV_API_PROXY_TARGET)
  assert.notEqual(origin.origin, target.origin)
  assert.ok((process.env.DJANGO_CSRF_TRUSTED_ORIGINS ?? '').split(',').includes(origin.origin), 'Trust this exact Vite Origin in Django')
  const port = Number(origin.port)
  const viteRoot = join(root, 'frontend')
  loader = await createServer({ root: viteRoot, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' })
  if (mode === 'dev') {
    proxy = await createServer({ root: viteRoot, server: { host: origin.hostname, port, strictPort: true }, logLevel: 'error' })
    await proxy.listen()
  } else {
    proxy = await preview({ root: viteRoot, preview: { host: origin.hostname, port, strictPort: true }, logLevel: 'error' })
  }
  const fetchWithCookie = async (path, options = {}) => {
    const url = new URL(path, origin)
    assert.equal(url.origin, origin.origin, 'All acceptance requests must go through the Vite proxy')
    assert.ok(url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/'))
    const headers = new Headers(options.headers)
    headers.set('Origin', origin.origin)
    if (cookie && options.credentials !== 'omit') headers.set('Cookie', cookie)
    const response = await originalFetch(url, { ...options, headers, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(15_000) })
    if (options.credentials !== 'omit') {
      const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('csrftoken='))
      if (setCookie) cookie = setCookie.split(';')[0]
    }
    if (url.pathname.startsWith('/api/')) {
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/)
      if (url.pathname.startsWith('/api/recognition/') || url.pathname.startsWith('/api/receipts/')) assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    }
    requests.push({ method: options.method ?? 'GET', path: url.pathname, status: response.status })
    return response
  }
  // Node fetch has no browser cookie jar. Carry only the QA CSRF cookie explicitly.
  globalThis.fetch = fetchWithCookie
  const api = await loader.ssrLoadModule('/src/api/recognition.ts')
  const receipts = await loader.ssrLoadModule('/src/api/receipts.ts')
  const catalog = await loader.ssrLoadModule('/src/api/catalog.ts')
  const { createPollingRequest } = await loader.ssrLoadModule('/src/features/recognition/polling.ts')
  const { isActive, acceptJob } = await loader.ssrLoadModule('/src/features/recognition/labels.ts')
  const options = { baseUrl: `${origin.origin}/api` }
  for (const list of [await api.getJobs({}, options), await api.getPhotos({}, options), await receipts.getReceipts({}, options)]) {
    assert.equal(ok(list).count, 0, 'Start with a fresh QA database, no existing photos/jobs/receipts; no external worker')
  }
  const csrf = ok(await api.getRecognitionCsrf(options))
  assert.match(cookie, /^csrftoken=/)
  assert.equal(csrf.executor.available, false)
  const doubleBytes = await readFile(join(media, 'demo/double.png'))
  const singleBytes = await readFile(join(media, 'demo/single.png'))
  const double = new File([doubleBytes], 'double.png', { type: 'image/png' })
  const single = new File([singleBytes], 'single.png', { type: 'image/png' })
  const uploaded = ok(await api.uploadPhoto(double, options))
  assert.equal(uploaded.reused, false)
  assert.equal(uploaded.job.status, 'queued')
  assert.equal(requests.at(-1).status, 202)
  const poll = createPollingRequest((signal) => api.getJob(uploaded.job.id, { ...options, signal }), isActive, acceptJob)
  lifetimes.add(poll)
  poll.start()
  await until(() => poll.getSnapshot(), (state) => state.kind === 'ok' && state.data.status === 'queued')
  const firstWorker = worker('success2')
  const terminal = await until(() => poll.getSnapshot(), (state) => state.kind === 'ok' && !isActive(state.data))
  console.log(await firstWorker)
  assert.equal(terminal.data.status, 'succeeded')
  assert.equal(terminal.data.progress.imported, 2)
  assert.equal(terminal.data.items.length, 2)
  const jobPath = `/api/recognition/jobs/${uploaded.job.id}/`
  const before = requests.filter((request) => request.path === jobPath).length
  await delay(2300)
  assert.equal(requests.filter((request) => request.path === jobPath).length, before, 'Terminal job polling must stop')
  poll.dispose()

  async function image(url, bytes) {
    assert.ok(url?.startsWith('/media/'))
    const response = await fetch(url)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /^image\/png/)
    const actual = Buffer.from(await response.arrayBuffer())
    assert.ok(actual.length > 0)
    if (bytes) assert.deepEqual(actual, bytes)
  }
  const photo = ok(await api.getPhoto(uploaded.photo.id, options))
  await image(photo.original_url, doubleBytes)
  await image(photo.preview_url)
  const cuts = ok(await api.getReceiptImages({ job: uploaded.job.id }, options))
  assert.equal(cuts.count, 2)
  const productIds = new Set(), receiptIds = new Set(), totals = [], lineIds = new Map()
  let lineCount = 0
  for (const cut of cuts.results) {
    assert.equal(cut.status, 'imported')
    assert.ok(cut.receipt_id)
    assert.equal(ok(await api.getReceiptImage(cut.id, options)).id, cut.id)
    await image(cut.image_url)
    const receipt = ok(await receipts.getReceipt(cut.receipt_id, options))
    receiptIds.add(receipt.id); totals.push(receipt.total)
    const lines = ok(await receipts.getReceiptLines(receipt.id, {}, options))
    lineIds.set(receipt.id, lines.results.map((line) => line.id))
    lineCount += lines.count
    for (const line of lines.results.filter((line) => line.kind === 'product')) {
      assert.ok(line.product, 'Every product line in success2 must link to a real catalog product')
      assert.equal(ok(await catalog.getProduct(line.product.id, options)).id, line.product.id)
      productIds.add(line.product.id)
    }
    ok(await receipts.getReceiptDiscounts(receipt.id, {}, options))
    ok(await receipts.getReceiptTaxes(receipt.id, {}, options))
  }
  assert.deepEqual(totals.sort(), ['4.42', '6.00'])
  assert.equal(lineCount, 6); assert.equal(productIds.size, 5); assert.equal(receiptIds.size, 2)
  const first = ok(await receipts.getReceipts({ page_size: 1 }, options))
  const second = ok(await receipts.getReceipts({ page_size: 1, page: 2 }, options))
  assert.equal(first.count, 2); assert.notEqual(first.results[0].id, second.results[0].id)
  const replay = ok(await api.uploadPhoto(double, options))
  assert.equal(requests.at(-1).status, 200)
  assert.equal(replay.reused, true)
  assert.equal(replay.photo.id, uploaded.photo.id); assert.equal(replay.job.id, uploaded.job.id)
  assert.equal((await api.cancelJob(replay.job.id, options)).reason, 'job_terminal')
  assert.equal((await api.retryJob(replay.job.id, options)).reason, 'retry_not_allowed')
  console.log('double upload → client polling → 2 crops/receipts, 6 lines, 5 products; PNG MEDIA; replay 200 passed')

  const queued = ok(await api.uploadPhoto(single, options))
  assert.equal(queued.job.status, 'queued') // No worker between the controlled --once invocations.
  assert.equal(ok(await api.cancelJob(queued.job.id, options)).status, 'cancelled')
  assert.equal(requests.at(-1).status, 200)
  const retry = ok(await api.retryJob(queued.job.id, options))
  assert.equal(retry.retry_of, queued.job.id); assert.equal(retry.status, 'queued')
  assert.equal(requests.at(-1).status, 202)
  assert.equal((await api.retryJob(queued.job.id, options)).reason, 'job_active')
  const pausedWorker = worker('pause_recognize')
  await until(async () => ok(await api.getJob(retry.id, options)), (job) => job.status === 'running' && job.stage === 'recognize')
  assert.equal(ok(await api.cancelJob(retry.id, options)).status, 'cancel_requested')
  assert.equal(requests.at(-1).status, 202)
  console.log(await pausedWorker)
  assert.equal(ok(await api.getJob(retry.id, options)).status, 'cancelled')
  const retried = ok(await api.retryJob(retry.id, options))
  console.log(await worker('one_receipt'))
  const linked = ok(await api.getJob(retried.id, options))
  assert.equal(linked.status, 'succeeded'); assert.equal(linked.progress.reused, 1)
  assert.ok(receiptIds.has(linked.items[0].receipt_id), 'Another photo must reuse the same receipt')
  assert.equal(ok(await receipts.getReceipts({}, options)).count, 2)
  assert.equal(ok(await catalog.getProducts({}, options)).count, 5, 'Another photo must not create duplicate catalog products')
  for (const receiptId of receiptIds) {
    assert.deepEqual(ok(await receipts.getReceiptLines(receiptId, {}, options)).results.map((line) => line.id), lineIds.get(receiptId), 'Another photo must not duplicate or replace receipt lines')
  }
  const receiptImages = ok(await api.getReceiptImages({ receipt: linked.items[0].receipt_id }, options))
  assert.equal(new Set(receiptImages.results.map((item) => item.photo_id)).size, 2)
  const latest = ok(await api.uploadPhoto(single, options))
  assert.equal(latest.reused, true); assert.equal(latest.job.id, retried.id)

  // A synthetic PNG with trailing bytes is a distinct photo, without touching MEDIA fixtures.
  const reviewFile = new File([singleBytes, '\nI5 synthetic review'], 'review.png', { type: 'image/png' })
  const reviewUpload = ok(await api.uploadPhoto(reviewFile, options))
  console.log(await worker('partial_missing_quantity'))
  const review = ok(await api.getJob(reviewUpload.job.id, options))
  assert.equal(review.status, 'partial_succeeded'); assert.equal(review.progress.review, 2)
  const reviewCuts = ok(await api.getReceiptImages({ job: review.id }, options))
  for (const cut of reviewCuts.results) {
    assert.equal(cut.status, 'needs_review'); assert.ok(cut.normalized_result)
    assert.ok(cut.issues.some((issue) => issue.code === 'missing_required'))
    await image(cut.image_url)
  }
  console.log('queued cancel 200; retry 202/409; running cancel 202 → cancelled; different photo reused Receipt; needs_review passed')

  const missingCsrf = await fetch(`${jobPath}cancel/`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(missingCsrf.status, 403); assert.equal((await missingCsrf.json()).error.code, 'csrf_failed')
  const gif = new File([Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')], 'unsupported.gif', { type: 'image/gif' })
  const unsupported = await api.uploadPhoto(gif, options)
  assert.equal(unsupported.kind, 'error'); assert.equal(unsupported.reason, 'unsupported_format')
  assert.equal(requests.at(-1).status, 400)
  const invalid = await api.uploadPhoto(new File([singleBytes.subarray(0, 40)], 'broken.png', { type: 'image/png' }), options)
  assert.equal(invalid.kind, 'error'); assert.equal(invalid.reason, 'invalid_image')
  console.log(JSON.stringify({ result: 'passed', mode, database: process.env.POSTGRES_DB,
    receipts: 2, lines: 6, products: 5, requests: requests.length,
    statuses: [...new Set(requests.map((request) => request.status))].sort(), browser_ui: 'not tested' }))
} catch (error) {
  console.error(`Recognition check FAILED: ${error.message}`)
  process.exitCode = 1
} finally {
  for (const lifetime of lifetimes) lifetime.dispose()
  for (const { child } of workers) child.kill()
  await Promise.allSettled([...workers].map(({ completion }) => completion))
  globalThis.fetch = originalFetch
  await proxy?.close()
  await loader?.close()
}
