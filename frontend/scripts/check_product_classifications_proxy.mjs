// Mutating QA acceptance of the product-classification client through a running Vite dev/preview proxy.
// Node 24 strips the real adapters' TypeScript. No browser, no mocked fetch. Run on a fresh
// seed_product_classification_demo + `product_classifications suggest --fake-scenario mixed` database only:
// the scenario decides records, queues a run and executes it with its own fake worker, one batch of one product per pass.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getCategories, getGenericProduct, getGenericProducts, getProduct } from '../src/api/catalog.ts'
import { getRecognitionCsrf } from '../src/api/local.ts'
import {
  confirmProductClassification, confirmProductClassifications, getProductClassification, getProductClassificationRun,
  getProductClassificationRuns, getProductClassifications, getProductClassificationState, rejectProductClassification,
  requestProductClassificationRun,
} from '../src/api/product-classifications.ts'

const usage = 'Usage: node frontend/scripts/check_product_classifications_proxy.mjs <vite-origin, e.g. http://127.0.0.1:15173>'
const root = fileURLToPath(new URL('../../', import.meta.url))
const python = join(root, 'backend/.venv/Scripts/python.exe')
const originalFetch = globalThis.fetch
const requests = []
const workers = new Set()
let cookie = ''

function loopback(value, name) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:', `${name}: only HTTP loopback QA origins are allowed`)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${name}: use a loopback host`)
  assert.equal(url.href, `${url.origin}/`, `${name}: use an origin without credentials, path or query`)
  assert.ok(url.port && !['8000', '5173', '5432', '15432'].includes(url.port), `${name}: do not use dev ports`)
  return url
}
function ok(result, status = 200) {
  assert.equal(result.kind, 'ok', JSON.stringify(result))
  assert.equal(requests.at(-1).status, status)
  return result.data
}
/** One pass of the real host worker with the fake provider: at most one batch of one product, then it exits. */
function workerPass() {
  const child = spawn(python, [
    '-X', 'utf8', join(root, 'backend/manage.py'), 'recognition_worker', '--once', '--classification-fake-scenario', 'mixed',
  ], { cwd: root, env: { ...process.env, PRODUCT_CLASSIFICATION_BATCH_SIZE: '1' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  workers.add(child)
  let output = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { output += data })
  let timeout
  return new Promise((resolve, reject) => {
    timeout = setTimeout(() => { child.kill(); reject(new Error(`Fake worker timed out; ${output.trim()}`)) }, 60_000)
    child.once('error', reject)
    child.once('exit', (code) => { code === 0 ? resolve(output.trim()) : reject(new Error(`Fake worker: exit ${code}; ${output.trim()}`)) })
  }).finally(() => { clearTimeout(timeout); workers.delete(child) })
}
function fails(result, reason, status, fields) {
  assert.deepEqual(result, { kind: 'error', reason, status, ...(fields && { fields }) })
  assert.equal(requests.at(-1).status, status)
}

try {
  assert.equal(process.argv.length, 3, usage)
  assert.match(process.env.POSTGRES_DB ?? '', /^checkist_qa(?:_[a-zA-Z0-9]+)*$/, 'Apply the full QA environment first: this script changes data')
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.POSTGRES_HOST), 'QA Postgres must be on loopback')
  assert.ok(process.env.POSTGRES_PORT && !['5432', '15432'].includes(process.env.POSTGRES_PORT), 'Do not use the dev Postgres port')
  assert.equal(process.env.VITE_API_BASE_URL, '/api', 'QA must use the /api prefix')
  // The script starts recognition_worker itself: with codex_cli a batch would be a real model request.
  assert.equal(process.env.RECEIPT_OCR_PROVIDER, 'fake', 'Never invoke Codex from this script: set RECEIPT_OCR_PROVIDER=fake')
  assert.ok(existsSync(python), `No ${python}: prepare backend/.venv as docs/development.md says`)
  const origin = loopback(process.argv[2], 'Vite origin')
  const target = loopback(process.env.DEV_API_PROXY_TARGET, 'DEV_API_PROXY_TARGET')
  assert.notEqual(origin.origin, target.origin, 'API and Vite proxy must be separate origins')
  assert.ok((process.env.DJANGO_CSRF_TRUSTED_ORIGINS ?? '').split(',').includes(origin.origin), 'Trust this exact Vite Origin in Django')

  // Node fetch has no browser cookie jar. Carry only the QA CSRF cookie and the page Origin explicitly.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input, origin)
    assert.equal(url.origin, origin.origin, 'All acceptance requests must go through the Vite proxy')
    assert.ok(url.pathname.startsWith('/api/') && url.pathname.endsWith('/'), `Unexpected path ${url.pathname}`)
    const headers = new Headers(init.headers)
    headers.set('Origin', origin.origin)
    if (cookie && init.credentials !== 'omit') headers.set('Cookie', cookie)
    const response = await originalFetch(url, { ...init, headers, redirect: 'error' })
    if (init.credentials !== 'omit') {
      const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('csrftoken='))
      if (setCookie) cookie = setCookie.split(';')[0]
    }
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/, `${url.pathname}: expected JSON`)
    if (/^\/api\/(?:product-classifications|recognition)\//.test(url.pathname)) {
      assert.match(response.headers.get('cache-control') ?? '', /no-store/, `${url.pathname}: expected Cache-Control: no-store`)
    }
    requests.push({ method: init.method ?? 'GET', path: url.pathname + url.search, status: response.status, body: init.body })
    return response
  }
  const options = { baseUrl: `${origin.origin}/api` }
  const direct = async (base, path, accept = 'application/json') => {
    const response = await originalFetch(new URL(path, base), { headers: { Accept: accept }, redirect: 'error', signal: AbortSignal.timeout(15_000) })
    return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() }
  }

  // The origin must be Vite itself, and its /api must be the same Django as DEV_API_PROXY_TARGET.
  const spa = await direct(origin, '/', 'text/html')
  assert.equal(spa.status, 200); assert.match(spa.type, /^text\/html/, 'The origin must serve the SPA: start Vite dev or preview')
  assert.match(spa.body, /<div id="root">/)
  const [viaProxy, viaDjango] = [await direct(origin, '/api/product-classifications/'), await direct(target, '/api/product-classifications/')]
  assert.equal(viaDjango.status, 200, 'Start the QA API with DEBUG=1 and ALLOW_LOCAL_RECOGNITION_API=1')
  assert.deepEqual(viaProxy, viaDjango, 'Vite proxy and Django answer differently')

  ok(await getRecognitionCsrf(options))
  assert.match(cookie, /^csrftoken=/)
  const noToken = await originalFetch(new URL('/api/product-classifications/runs/', origin), {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Origin: origin.origin },
  })
  assert.equal(noToken.status, 403); assert.equal((await noToken.json()).error.code, 'csrf_failed')
  console.log('proxy = Django; CSRF cookie and token obtained; POST without a token → 403 csrf_failed')

  // State and the run of `suggest`.
  const fresh = 'Use a fresh QA database: migrate, seed_product_classification_demo, product_classifications suggest --fake-scenario mixed'
  const state = ok(await getProductClassificationState(options))
  assert.deepEqual([state.pending_count, state.unclassified_count, state.auto_suggest], [9, 1, false], fresh)
  assert.deepEqual([state.run?.status, state.run?.trigger, state.executor.state], ['succeeded', 'command', 'absent'], 'Stop the recognition worker of this QA database')
  assert.deepEqual(state.run.progress, { requested: 10, processed: 10, applied: 9, unknown: 1, skipped: 0 })
  const runs = ok(await getProductClassificationRuns({}, options))
  assert.deepEqual(runs.results, [state.run])
  assert.deepEqual(ok(await getProductClassificationRun(state.run.id, options)), state.run)
  assert.equal(ok(await getProductClassificationRuns({ status: 'queued' }, options)).count, 0)

  // List, groups, pages and filters.
  const screen = { status: 'pending', ordering: 'generic', page_size: 200 }
  const pending = ok(await getProductClassifications(screen, options))
  assert.equal(pending.count, 9, fresh)
  assert.deepEqual(ok(await getProductClassifications({}, options)).count, 9, 'Every demo record must still be pending: the scenario runs once per database')
  const names = pending.results.map((record) => record.suggested.generic.name)
  const groups = names.filter((name, index) => name !== names[index - 1])
  assert.equal(new Set(groups).size, groups.length, 'Records of one suggested generic product go together')
  assert.deepEqual([...groups].sort(), ['Кефир', 'Колбаса', 'Молоко', 'Сок', 'Средство для мытья посуды', 'Сыр', 'Хлеб'])
  for (const record of pending.results) {
    assert.deepEqual(record.actions, { can_confirm: true, can_choose: true, can_reject: true })
    assert.deepEqual(record.product.generic, { id: record.suggested.generic.id, name: record.suggested.generic.name, base_unit: record.suggested.generic.base_unit })
    assert.equal(record.suggested.pending_count, names.filter((name) => name === record.suggested.generic.name).length)
    assert.equal(record.suggested.generic.is_new, record.suggested.generic.name !== 'Молоко')
    assert.ok(record.product.aliases.length > 0 && record.source.provider === 'fake' && record.source.trigger === 'command')
  }
  const byNewest = ok(await getProductClassifications({ ordering: '-id' }, options)).results.map((record) => record.id)
  assert.deepEqual(byNewest, pending.results.map((record) => record.id).sort((a, b) => b - a), 'ordering=-id lists new records first')
  const second = ok(await getProductClassifications({ ...screen, page: 2, page_size: 4 }, options))
  assert.deepEqual([second.pages, second.results], [3, pending.results.slice(4, 8)])
  for (const status of ['confirmed', 'rejected', 'superseded']) assert.equal(ok(await getProductClassifications({ status }, options)).count, 0)
  fails(await getProductClassifications({ page: 99 }, options), 'page_out_of_range', 404)
  fails(await getProductClassifications({ status: 'done' }, options), 'invalid_parameter', 400, ['status'])
  fails(await getProductClassifications({ ordering: 'name' }, options), 'invalid_parameter', 400, ['ordering'])
  fails(await getProductClassification(999_999, options), 'not_found', 404)
  const of = (name) => pending.results.filter((record) => record.suggested.generic.name === name)
  const [milk] = of('Молоко'); const kefir = of('Кефир'); const [cheese] = of('Сыр'); const sausage = of('Колбаса'); const [bread] = of('Хлеб')
  assert.deepEqual([kefir.length, sausage.length], [2, 2])
  assert.deepEqual(ok(await getProductClassification(milk.id, options)), milk, 'The list and the record describe the same suggestion')
  assert.deepEqual(ok(await getProductClassifications({ product: milk.product.id }, options)).results, [milk])
  assert.deepEqual(ok(await getProductClassifications({ generic: kefir[0].suggested.generic.id, ordering: '-id' }, options)).results.map((record) => record.id), kefir.map((record) => record.id).reverse())
  assert.equal(ok(await getProductClassifications({ run: state.run.id }, options)).count, 9)
  const meat = sausage[0].suggested.category
  assert.deepEqual(meat.path.map((item) => [item.name, item.is_new]), [['Продукты питания', false], ['Мясные продукты', true]])
  console.log(`state 9 pending / 1 unclassified, worker absent; list of 9 in 7 groups (${groups.join(', ')}), pages, filters`)

  // Confirm «Молоко» and repeat.
  const milkInput = { version: milk.version, generic_id: milk.suggested.generic.id }
  const confirmed = ok(await confirmProductClassification(milk.id, milkInput, options))
  assert.equal(requests.at(-1).body, JSON.stringify(milkInput))
  assert.deepEqual([confirmed.status, confirmed.resolution, confirmed.version], ['confirmed', 'confirmed', milk.version + 1])
  assert.deepEqual(confirmed.final_generic, milk.product.generic)
  assert.deepEqual(confirmed.actions, { can_confirm: false, can_choose: false, can_reject: false })
  assert.deepEqual(ok(await confirmProductClassification(milk.id, milkInput, options)), confirmed, 'A repeated confirm answers 200 with the same record')
  assert.deepEqual(ok(await confirmProductClassification(milk.id, { ...milkInput, version: milk.version + 5 }, options)), confirmed, 'A repeat ignores a stale version')
  fails(await confirmProductClassification(milk.id, { ...milkInput, generic_id: cheese.suggested.generic.id }, options), 'classification_resolved', 409)
  fails(await rejectProductClassification(milk.id, { version: confirmed.version }, options), 'classification_resolved', 409)
  assert.deepEqual(ok(await getProductClassification(milk.id, options)), confirmed)
  assert.deepEqual(ok(await getProduct(milk.product.id, options)).generic, milk.product.generic)
  console.log(`record ${milk.id}: confirm → confirmed, repeat 200; another generic_id and reject → 409 classification_resolved`)

  // A stale version saves nothing.
  fails(await confirmProductClassification(bread.id, { version: bread.version + 1, generic_id: bread.suggested.generic.id }, options), 'classification_changed', 409)
  fails(await rejectProductClassification(bread.id, { version: bread.version + 1 }, options), 'classification_changed', 409)
  fails(await confirmProductClassifications([{ id: bread.id, version: bread.version + 1 }], options), 'classification_changed', 409, ['items.0'])
  assert.deepEqual(ok(await getProductClassification(bread.id, options)), bread, 'Rejected requests saved nothing')
  console.log(`record ${bread.id}: stale version → 409 classification_changed (confirm, reject, mass confirm with items.0)`)

  // Mass confirmation of the «Кефир» group and its repeat.
  const items = kefir.map((record) => ({ id: record.id, version: record.version }))
  const many = ok(await confirmProductClassifications(items, options))
  assert.equal(requests.at(-1).body, JSON.stringify({ items }))
  assert.equal(many.confirmed, 2)
  assert.ok(many.results.every((record) => record.status === 'confirmed' && record.resolution === 'confirmed' && !record.suggested.generic.is_new))
  assert.deepEqual(ok(await confirmProductClassifications(items, options)), many, 'A repeated mass confirmation answers 200')
  fails(await confirmProductClassifications([...items, { id: 999_999, version: 1 }], options), 'not_found', 404)
  assert.equal(ok(await getGenericProduct(kefir[0].suggested.generic.id, options)).name, 'Кефир')
  console.log(`group «Кефир» (${items.map((item) => item.id).join(', ')}): mass confirm → 2, repeat 200; the generic product is not «новый» any more`)

  // Another generic product for «Сыр»: the created «Сыр» is removed.
  const created = cheese.suggested.generic.id
  const offered = ok(await getGenericProducts({ q: 'Сыр' }, options)).results
  assert.ok(offered.some((item) => item.id === created), 'A new generic product is offered by the catalog list')
  const otherInput = { version: cheese.version, generic_id: milk.suggested.generic.id }
  const other = ok(await confirmProductClassification(cheese.id, otherInput, options))
  assert.equal(requests.at(-1).body, JSON.stringify(otherInput))
  assert.deepEqual([other.status, other.resolution, other.final_generic.name, other.suggested.generic.exists], ['confirmed', 'other', 'Молоко', false])
  assert.deepEqual(ok(await confirmProductClassification(cheese.id, otherInput, options)), other, 'A repeated choice answers 200')
  assert.ok(!ok(await getGenericProducts({ q: 'Сыр' }, options)).results.some((item) => item.id === created))
  fails(await getGenericProduct(created, options), 'not_found', 404)
  assert.equal(ok(await getProduct(cheese.product.id, options)).generic.name, 'Молоко')
  console.log(`record ${cheese.id}: another generic product → confirmed/other «Молоко», repeat 200; created «Сыр» (${created}) is gone`)

  // Reject both «Колбаса»: the created generic product and category live until the last record leaves.
  const hasMeat = async () => ok(await getCategories({ q: 'Мясные продукты' }, options)).results.some((item) => item.id === meat.id)
  assert.equal(await hasMeat(), true)
  const first = ok(await rejectProductClassification(sausage[0].id, { version: sausage[0].version }, options))
  assert.equal(requests.at(-1).body, JSON.stringify({ version: sausage[0].version }))
  assert.deepEqual([first.status, first.resolution, first.final_generic.name], ['rejected', 'rejected', 'Не разобрано'])
  assert.deepEqual(first.final_generic, sausage[0].previous_generic)
  assert.equal(ok(await getGenericProduct(sausage[0].suggested.generic.id, options)).name, 'Колбаса')
  assert.equal(await hasMeat(), true)
  const last = ok(await rejectProductClassification(sausage[1].id, { version: sausage[1].version }, options))
  assert.deepEqual([last.status, last.suggested.generic.exists, last.suggested.generic.is_new], ['rejected', false, false])
  fails(await getGenericProduct(sausage[0].suggested.generic.id, options), 'not_found', 404)
  assert.equal(await hasMeat(), false)
  assert.deepEqual(ok(await rejectProductClassification(sausage[1].id, { version: sausage[1].version }, options)), last, 'A repeated reject answers 200')
  fails(await confirmProductClassification(sausage[1].id, { version: last.version, generic_id: milk.suggested.generic.id }, options), 'classification_resolved', 409)
  assert.equal(ok(await getProduct(sausage[0].product.id, options)).generic.name, 'Не разобрано')
  console.log(`records ${sausage.map((record) => record.id).join(', ')}: reject → rejected, «Колбаса» stays after the first and goes with «Мясные продукты» after the second; repeat 200`)

  // A missing and the service generic product are refused.
  fails(await confirmProductClassification(bread.id, { version: bread.version, generic_id: 999_999 }, options), 'invalid_parameter', 400, ['generic_id'])
  fails(await confirmProductClassification(bread.id, { version: bread.version, generic_id: bread.previous_generic.id }, options), 'invalid_parameter', 400, ['generic_id'])
  assert.deepEqual(ok(await getProductClassification(bread.id, options)), bread)
  console.log(`record ${bread.id}: generic_id missing and «Не разобрано» → 400 invalid_parameter [generic_id]`)

  // Queue a run: no worker yet, so it stays queued.
  const queued = ok(await requestProductClassificationRun(options), 202)
  assert.equal(requests.at(-1).body, '{}')
  assert.deepEqual([queued.created, queued.run.status, queued.run.trigger, queued.executor.state], [true, 'queued', 'manual', 'absent'])
  const again = ok(await requestProductClassificationRun(options))
  assert.deepEqual(again, { ...queued, created: false }, 'A repeated request returns the active run')
  const after = ok(await getProductClassificationState(options))
  assert.deepEqual([after.pending_count, after.run, after.executor.state], [3, queued.run, 'absent'])
  assert.equal(ok(await getProductClassificationRuns({ status: 'queued' }, options)).results[0].id, queued.run.id)
  console.log(`run ${queued.run.id}: POST runs/ → 202 queued (${queued.run.progress.requested} products), repeat 200 created=false; state: queued, worker absent`)

  // Between batches: a real pass of the worker takes one product of three and puts the run back into the queue.
  const sameRun = (run, processed) => {
    assert.deepEqual([run.id, run.trigger, run.scope, run.created_at, run.remaining, run.error], [queued.run.id, 'manual', 'all', queued.run.created_at, 0, null])
    assert.deepEqual([run.progress.requested, run.progress.processed], [3, processed])
  }
  assert.deepEqual([queued.run.started_at, queued.run.progress.requested, queued.run.progress.processed], [null, 3, 0], fresh)
  const firstPass = await workerPass()
  assert.match(firstPass, new RegExp(`Classification run ${queued.run.id}: queued`), 'No recognition job may wait in this QA database: the pass must take the batch')
  const between = ok(await getProductClassificationState(options))
  assert.equal(between.run.status, 'queued', 'A run between its batches is queued')
  assert.ok(between.run.started_at !== null && between.run.finished_at === null, 'A run between its batches keeps started_at and has no finished_at')
  sameRun(between.run, 1)
  assert.ok(between.run.version > queued.run.version, 'Every transition raises the version')
  assert.equal(between.executor.state, 'absent', 'The worker of the pass has exited')
  assert.deepEqual(ok(await getProductClassificationRun(queued.run.id, options)), between.run)
  assert.deepEqual(ok(await getProductClassificationRuns({ status: 'queued' }, options)).results, [between.run])
  assert.equal(ok(await getProductClassificationRuns({ status: 'running' }, options)).count, 0)
  const pressed = ok(await requestProductClassificationRun(options))
  assert.deepEqual(pressed, { created: false, run: between.run, executor: between.executor }, 'The button returns the run between its batches as it is')
  console.log(`run ${queued.run.id} between batches: worker pass → queued, started_at ${between.run.started_at}, processed 1 of 3, version ${between.run.version}; POST runs/ → 200 created=false, the same run`)

  // The second pass leaves it between batches again, the third one closes it.
  await workerPass()
  const nextPass = ok(await getProductClassificationState(options))
  assert.deepEqual([nextPass.run.status, nextPass.run.started_at, nextPass.run.finished_at], ['queued', between.run.started_at, null])
  sameRun(nextPass.run, 2)
  assert.match(await workerPass(), new RegExp(`Classification run ${queued.run.id}: succeeded`))
  const finished = ok(await getProductClassificationState(options))
  assert.deepEqual([finished.run.status, finished.run.started_at, finished.executor.state], ['succeeded', between.run.started_at, 'absent'])
  assert.ok(finished.run.finished_at !== null)
  sameRun(finished.run, 3)
  // Both «Колбаса» variants were rejected and the model does not know «Demo Art. 4711»: nothing new is suggested.
  assert.deepEqual([finished.run.progress.applied, finished.pending_count, finished.unclassified_count], [0, 3, 3])
  assert.deepEqual(ok(await getProductClassificationRun(queued.run.id, options)), finished.run)
  assert.equal(ok(await getProductClassificationRuns({ status: 'queued' }, options)).count, 0)
  assert.deepEqual(ok(await getProductClassificationRuns({}, options)).results.map((run) => [run.id, run.status]), [[queued.run.id, 'succeeded'], [state.run.id, 'succeeded']])
  console.log(`run ${queued.run.id}: second pass → queued 2 of 3, third pass → succeeded 3 of 3, applied 0 (rejected variants are not offered again)`)

  const counts = {}
  for (const status of ['pending', 'confirmed', 'rejected', 'superseded']) counts[status] = ok(await getProductClassifications({ status }, options)).count
  assert.deepEqual(counts, { pending: 3, confirmed: 4, rejected: 2, superseded: 0 })
  const posts = requests.filter((request) => request.method === 'POST')
  console.log(JSON.stringify({ result: 'passed', origin: origin.origin, database: process.env.POSTGRES_DB,
    records: { pending: counts.pending, confirmed: counts.confirmed, rejected: counts.rejected }, unclassified: finished.unclassified_count,
    run: { status: finished.run.status, between_batches: [between.run.progress.processed, nextPass.run.progress.processed], progress: finished.run.progress },
    requests: requests.length, posts: posts.length, statuses: [...new Set(requests.map((request) => request.status))].sort(), browser_ui: 'not tested' }))
} catch (error) {
  console.error(`Product classification check FAILED: ${error.message}`)
  const last = requests.at(-1)
  if (last) console.error(`Last request: ${last.method} ${last.path} → ${last.status}${last.body ? ` ${last.body}` : ''}`)
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
  for (const child of workers) child.kill()
}
