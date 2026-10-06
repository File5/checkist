import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createServer } from 'vite'

// Explicit HTTP/CLI acceptance, never run by Vitest or against dev data.
// Prepare an empty isolated QA database and seed_recognition_demo first.
const root = fileURLToPath(new URL('../../../../', import.meta.url))
const port = Number(process.env.CHECKIST_HTTP_PORT ?? 15182)
const origin = `http://127.0.0.1:${port}`
assert.match(process.env.POSTGRES_DB ?? '', /^checkist_qa(?:_[a-zA-Z0-9]+)*$/)
assert.equal(process.env.RECEIPT_OCR_PROVIDER, 'fake')
assert.ok(process.env.MEDIA_ROOT)
assert.ok(process.env.RECEIPT_OCR_TEMP_ROOT)
assert.notEqual(process.env.MEDIA_ROOT, process.env.RECEIPT_OCR_TEMP_ROOT)
assert.ok(Number.isSafeInteger(port) && port > 1024 && port < 65536)
const target = new URL(process.env.DEV_API_PROXY_TARGET)
assert.equal(target.protocol, 'http:')
assert.ok(['127.0.0.1', 'localhost'].includes(target.hostname))
assert.ok((process.env.DJANGO_CSRF_TRUSTED_ORIGINS ?? '').split(',').includes(origin))
const server = await createServer({ root: join(root, 'frontend'), server: { port, strictPort: true }, logLevel: 'error' })
const originalFetch = globalThis.fetch
const requests = []
let cookie = ''
const workers = new Set()
const lifetimes = new Set()
function worker(scenario) {
  const child = spawn(join(root, 'backend/.venv/Scripts/python.exe'), ['-X', 'utf8', join(root, 'backend/manage.py'), 'recognition_worker', '--once', '--fake-scenario', scenario], { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  workers.add(child)
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => { workers.delete(child); code === 0 ? resolve(output.trim()) : reject(new Error(`Worker failed: ${code} ${output}`)) }) })
  completion.catch(() => {}) // Cleanup can kill a worker whose caller already failed.
  return { child, completion }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(read, condition, limit = 20000) {
  const end = Date.now() + limit
  while (Date.now() < end) { const result = await read(); if (condition(result)) return result; await delay(100) }
  throw new Error('Timed out waiting for expected state')
}
function ok(result) { assert.equal(result.kind, 'ok', JSON.stringify(result)); return result.data }
try {
  await server.listen()
  globalThis.fetch = async (path, options = {}) => {
    const url = new URL(path, origin)
    const headers = new Headers(options.headers)
    headers.set('Origin', origin)
    if (cookie) headers.set('Cookie', cookie)
    const response = await originalFetch(url, { ...options, headers })
    const setCookie = response.headers.get('set-cookie')
    if (setCookie) cookie = setCookie.split(';')[0]
    requests.push({ method: options.method ?? 'GET', path: url.pathname, status: response.status })
    return response
  }
  const api = await server.ssrLoadModule('/src/api/recognition.ts')
  const receipts = await server.ssrLoadModule('/src/api/receipts.ts')
  const { createPollingRequest } = await server.ssrLoadModule('/src/features/recognition/polling.ts')
  const { createUpload, uploadMessage } = await server.ssrLoadModule('/src/features/recognition/upload-state.ts')
  const { isActive, acceptJob } = await server.ssrLoadModule('/src/features/recognition/labels.ts')
  assert.equal(ok(await api.getJobs()).count, 0, 'Use an empty isolated QA database; no existing jobs will be changed')
  const config = ok(await api.getRecognitionCsrf())
  assert.equal(config.executor.available, false)
  assert.equal(config.executor.state, 'absent')
  const doubleBytes = await readFile(join(process.env.MEDIA_ROOT, 'demo/double.png'))
  const double = new File([doubleBytes], 'double.png', { type: 'image/png' })
  let uploaded
  const upload = createUpload((file, signal) => api.uploadPhoto(file, { signal }), (signal) => api.getRecognitionCsrf({ signal }), (data) => { uploaded = data }, () => {})
  lifetimes.add(upload)
  await upload.submit(double, config.limits)
  assert.equal(upload.getSnapshot().kind, 'success')
  assert.equal(uploaded.reused, false)
  assert.equal(uploaded.job.status, 'queued')
  assert.equal(uploaded.job.executor.state, 'absent')
  assert.equal(uploadMessage(uploaded), 'Фото загружено. Задание принято.')
  const poll = createPollingRequest((signal) => api.getJob(uploaded.job.id, { signal }), isActive, acceptJob)
  lifetimes.add(poll)
  poll.start()
  const firstWorker = worker('success2')
  console.log(await firstWorker.completion)
  const terminal = await until(() => poll.getSnapshot(), (state) => state.kind === 'ok' && !isActive(state.data))
  assert.equal(terminal.data.status, 'succeeded')
  assert.equal(terminal.data.progress.imported, 2)
  assert.equal(terminal.data.items.length, 2)
  const before = requests.filter((request) => request.path === `/api/recognition/jobs/${uploaded.job.id}/`).length
  await delay(2300)
  assert.equal(requests.filter((request) => request.path === `/api/recognition/jobs/${uploaded.job.id}/`).length, before)
  poll.dispose()
  const cuts = ok(await api.getReceiptImages({ job: uploaded.job.id }))
  assert.equal(cuts.results.length, 2)
  for (const item of cuts.results) {
    assert.equal(item.status, 'imported')
    assert.ok(item.receipt_id)
    assert.equal(ok(await receipts.getReceipt(item.receipt_id)).id, item.receipt_id)
    const imageResponse = await fetch(item.image_url)
    assert.equal(imageResponse.status, 200)
    assert.match(imageResponse.headers.get('content-type'), /^image\/png/)
    assert.ok((await imageResponse.arrayBuffer()).byteLength > 0)
  }
  const original = await fetch(uploaded.photo.original_url)
  assert.deepEqual(Buffer.from(await original.arrayBuffer()), doubleBytes)
  const source = ok(await api.getPhoto(uploaded.photo.id))
  assert.ok(source.preview_url)
  const preview = await fetch(source.preview_url)
  assert.equal(preview.status, 200)
  assert.match(preview.headers.get('content-type'), /^image\/png/)
  assert.ok((await preview.arrayBuffer()).byteLength > 0)
  const replay = ok(await api.uploadPhoto(double))
  assert.equal(replay.reused, true); assert.equal(replay.job.id, uploaded.job.id)
  assert.match(uploadMessage(replay), /уже было загружено/)
  assert.equal((await api.cancelJob(replay.job.id)).reason, 'job_terminal')
  assert.equal((await api.retryJob(replay.job.id)).reason, 'retry_not_allowed')
  console.log(`upload → polling → succeeded ${uploaded.job.id}: 2 crops/receipts/media, reused 200, terminal polling stopped`)

  const single = new File([await readFile(join(process.env.MEDIA_ROOT, 'demo/single.png'))], 'single.png', { type: 'image/png' })
  const queued = ok(await api.uploadPhoto(single))
  assert.equal(ok(await api.cancelJob(queued.job.id)).status, 'cancelled')
  const retry = ok(await api.retryJob(queued.job.id))
  assert.equal(retry.retry_of, queued.job.id)
  assert.equal((await api.retryJob(queued.job.id)).reason, 'job_active')
  const pausedWorker = worker('pause_recognize')
  const running = await until(async () => ok(await api.getJob(retry.id)), (job) => job.status === 'running' && job.stage === 'recognize')
  assert.equal(running.actions.can_cancel, true)
  const requested = ok(await api.cancelJob(retry.id))
  assert.equal(requested.status, 'cancel_requested')
  console.log(await pausedWorker.completion)
  assert.equal(ok(await api.getJob(retry.id)).status, 'cancelled')
  const reviewJob = ok(await api.retryJob(retry.id))
  console.log(await worker('partial_missing_quantity').completion)
  const review = ok(await api.getJob(reviewJob.id))
  assert.equal(review.status, 'partial_succeeded')
  const reviewCuts = ok(await api.getReceiptImages({ job: review.id }))
  assert.equal(reviewCuts.results.length, 2)
  assert.equal(reviewCuts.results[0].status, 'needs_review')
  assert.ok(reviewCuts.results[0].normalized_result)
  assert.ok(reviewCuts.results[0].issues.some((issue) => issue.code === 'missing_required'))
  const jobs = ok(await api.getJobs({ photo: queued.photo.id, status: 'cancelled', page_size: 1 }))
  assert.equal(jobs.count, 2); assert.equal(jobs.pages, 2)
  const csrfFailure = await fetch('/api/recognition/jobs/' + review.id + '/retry/', { method: 'POST', headers: { 'X-CSRFToken': 'invalid', 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(csrfFailure.status, 403)
  assert.equal((await csrfFailure.json()).error.code, 'csrf_failed')
  console.log('queued cancel 200; retry 202/409; running cancel 202 → cancelled; needs_review + issues; list filter/pages; actual CSRF 403 passed')
  console.log(JSON.stringify({ result: 'passed', database: process.env.POSTGRES_DB, requests: requests.map(({ method, status }) => ({ method, status })) }, null, 2))
} finally {
  for (const lifetime of lifetimes) lifetime.dispose()
  globalThis.fetch = originalFetch
  for (const child of workers) child.kill()
  await server.close()
}
