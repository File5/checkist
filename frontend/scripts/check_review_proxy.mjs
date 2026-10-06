// Mutating QA acceptance of the needs_review confirmation through a real Vite dev/preview proxy and a real Django.
// The request bodies are built by the form model of the client (review-state.ts) and sent by its adapters and its
// action store; the fake worker gives the incomplete results. No browser, no mocked fetch, never Codex.
// Run on a fresh QA database only: the scenario saves receipts.
// An optional third argument is a directory for static pages: the real view components rendered in Node from the
// answers of this run. Nothing is clicked there, so the pages do not replace the manual acceptance in a browser.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer, preview } from 'vite'

const root = fileURLToPath(new URL('../../', import.meta.url))
const mode = process.argv[2]
const pagesDir = process.argv[4] ? resolve(process.argv[4]) : undefined
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
function refused(result, reason, status) {
  assert.equal(result.kind, 'error', JSON.stringify(result))
  assert.deepEqual([result.reason, result.status], [reason, status], JSON.stringify(result))
  assert.equal(requests.at(-1).status, status)
  return result
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
  assert.ok(['dev', 'preview'].includes(mode), 'Usage: node frontend/scripts/check_review_proxy.mjs dev|preview [http://127.0.0.1:15173] [directory for static pages]')
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
  // Node fetch has no browser cookie jar. Carry only the QA CSRF cookie and the page Origin explicitly.
  globalThis.fetch = async (path, options = {}) => {
    const url = new URL(path, origin)
    assert.equal(url.origin, origin.origin, 'All acceptance requests must go through the Vite proxy')
    assert.ok(url.pathname.startsWith('/api/') && url.pathname.endsWith('/'), `Unexpected path ${url.pathname}`)
    const headers = new Headers(options.headers)
    headers.set('Origin', origin.origin)
    if (cookie && options.credentials !== 'omit') headers.set('Cookie', cookie)
    const response = await originalFetch(url, { ...options, headers, redirect: 'error', signal: options.signal ?? AbortSignal.timeout(15_000) })
    if (options.credentials !== 'omit') {
      const setCookie = response.headers.getSetCookie().find((value) => value.startsWith('csrftoken='))
      if (setCookie) cookie = setCookie.split(';')[0]
    }
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/, `${url.pathname}: expected JSON`)
    if (url.pathname.startsWith('/api/recognition/') || url.pathname.startsWith('/api/receipts/')) assert.match(response.headers.get('cache-control') ?? '', /no-store/)
    requests.push({ method: options.method ?? 'GET', path: url.pathname + url.search, status: response.status, body: options.body })
    return response
  }
  const load = (path) => loader.ssrLoadModule(path)
  const api = await load('/src/api/recognition.ts')
  const receipts = await load('/src/api/receipts.ts')
  const { getCountries } = await load('/src/api/countries.ts')
  const { getStores } = await load('/src/api/stores.ts')
  const { isReviewConfirmInput } = await load('/src/api/recognition-schema.ts')
  const review = await load('/src/features/recognition/review-state.ts')
  const { createReviewActions } = await load('/src/features/recognition/review-actions.ts')
  const { createPollingRequest } = await load('/src/features/recognition/polling.ts')
  const { isActive, acceptJob } = await load('/src/features/recognition/labels.ts')
  const { reviewErrorText } = await load('/src/features/recognition/labels.ts')
  const options = { baseUrl: `${origin.origin}/api` }

  // Static pages for the human reviewer, only when a directory is given.
  const { createElement: h } = await import('react')
  const { renderToStaticMarkup } = await import('react-dom/server')
  const ui = pagesDir && {
    ReceiptImages: (await load('/src/features/recognition/ReceiptImages.tsx')).default, ReviewForm: (await load('/src/features/recognition/ReviewForm.tsx')).default,
    Issues: (await load('/src/components/RecognitionIssues.tsx')).default, JobSummary: (await load('/src/features/recognition/JobSummary.tsx')).default,
    ReceiptCrops: (await load('/src/features/receipts/ReceiptContent.tsx')).ReceiptImages,
  }
  const pictures = new Map()
  const written = []
  if (pagesDir) {
    await mkdir(pagesDir, { recursive: true })
    const css = await Promise.all(['App.css', 'features/recognition/Recognition.css', 'features/receipts/Receipts.css'].map(async (path) => `/* ${path} */\n${await readFile(join(viteRoot, 'src', path), 'utf8')}`))
    await writeFile(join(pagesDir, 'preview.css'), `/* Generated by scripts/check_review_proxy.mjs from the application styles. Do not edit. */\n${css.join('\n')}\n.preview-note { margin: 16px 0 0; padding: 12px 14px; border: 1px dashed #8b9c8d; border-radius: 8px; color: #40564a; font-size: 0.85rem; }\n`)
  }
  const page = async (file, title, note, build) => {
    if (!pagesDir) return
    let markup = renderToStaticMarkup(await build())
    // The page must work offline: synthetic crops of this QA run are stored next to it.
    for (const [source] of markup.matchAll(/(?<=src=")\/media\/[^"]+(?=")/g)) {
      if (!pictures.has(source)) {
        const response = await originalFetch(new URL(source, origin))
        assert.equal(response.status, 200, source)
        const name = `crop-${pictures.size + 1}.png`
        await writeFile(join(pagesDir, name), Buffer.from(await response.arrayBuffer()))
        pictures.set(source, name)
      }
      markup = markup.replaceAll(`src="${source}"`, `src="./${pictures.get(source)}"`)
    }
    await writeFile(join(pagesDir, file), `<!doctype html>\n<html lang="ru">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>Checkist — ${title}</title>\n<link rel="stylesheet" href="./preview.css">\n</head>\n<body>\n<div class="page">\n<p class="preview-note">Статическая отрисовка настоящих компонентов экрана на ответах QA-сервера (синтетические данные fake-воркера). Поля, кнопки и ссылки здесь не работают: ${note}</p>\n<main><div class="intro"><h1>${title}</h1></div>\n${markup}\n</main>\n</div>\n</body>\n</html>\n`)
    written.push(file)
  }
  const panel = (title, ...content) => h('div', { className: 'ck-rec' }, h('section', { className: 'ck-rec-panel' }, h('h2', null, title), ...content))
  const idle = { state: { kind: 'idle' }, run: async () => undefined }
  /** The card of a crop in a state that only the reducer of the page reaches: the same components, put together here. */
  const formCard = (cut, state, references, message) => h('ol', { className: 'ck-rec-list' }, h('li', { className: 'ck-rec-card' },
    h('h3', null, `Чек ${cut.position} · Требует проверки`),
    h(ui.Issues, { issues: state.issues, status: 'needs_review' }),
    h(ui.ReviewForm, { imageId: cut.id, state, dispatch: () => {}, countries: references, pending: false, refusal: message, onConfirm: () => {} })))
  const edit = (state, ...edits) => edits.reduce(review.reviewReducer, state)
  /** The body exactly as the form would send it; every body is checked against the client's copy of the contract. */
  const body = (state, valid = true) => {
    const built = review.buildInput(state)
    assert.equal(isReviewConfirmInput(built.input), valid, JSON.stringify(built.input))
    return built
  }
  const confirm = (id, input) => api.confirmReceiptImage(id, input, options)
  const posts = () => requests.filter((request) => request.method === 'POST' && request.path.endsWith('/confirm/')).length
  const counts = async () => ({ receipts: ok(await receipts.getReceipts({}, options)).count, stores: ok(await getStores({}, options)).count })

  for (const list of [await api.getJobs({}, options), await api.getPhotos({}, options), await receipts.getReceipts({}, options)]) {
    assert.equal(ok(list).count, 0, 'Start with a fresh QA database, no existing photos/jobs/receipts; no external worker')
  }
  ok(await api.getRecognitionCsrf(options))
  assert.match(cookie, /^csrftoken=/)
  // The two reads behind the selects of the form.
  const countries = ok(await getCountries({ all: true }, options)).results
  assert.equal(requests.at(-1).path, '/api/countries/?all=1')
  assert.ok(countries.some((country) => country.code === 'DE'), 'The reference must contain DE')
  assert.equal(ok(await getStores({ q: 'TEST' }, options)).count, 0)

  // 1. partial_success: crop 1 is saved automatically, crop 2 needs review (quantity and unit price of line 1 unread).
  const doubleBytes = await readFile(join(media, 'demo/double.png'))
  const first = ok(await api.uploadPhoto(new File([doubleBytes], 'double.png', { type: 'image/png' }), options))
  console.log(await worker('partial_success'))
  const partial = ok(await api.getJob(first.job.id, options))
  assert.deepEqual([partial.status, partial.progress.imported, partial.progress.review, partial.review_required, partial.actions.can_retry], ['partial_succeeded', 1, 1, true, true])
  const cuts = ok(await api.getReceiptImages({ job: partial.id, ordering: 'created_at' }, options)).results
  const saved = cuts.find((cut) => cut.status === 'imported'), pendingCut = cuts.find((cut) => cut.status === 'needs_review')
  assert.ok(saved && pendingCut && saved.confirmed_at === null && pendingCut.confirmed_at === null && pendingCut.receipt_id === null)
  assert.equal(pendingCut.normalized_result.proposed_receipt.country, 'DE')
  const before = await counts()
  assert.deepEqual(before, { receipts: 1, stores: 1 })

  const form = review.createReview(pendingCut.normalized_result, pendingCut.issues)
  await page('01-needs-review.html', 'Задание: вырезка требует проверки', 'первый показ карточки, до загрузки справочника стран (страна — поле кода).',
    async () => panel(`Вырезки чеков (${cuts.length})`, h(ui.ReceiptImages, { images: cuts, finished: true, review: idle })))
  const [bread, cheese] = form.lines
  assert.deepEqual([form.header.storeName, form.header.country, form.header.currency, form.header.total, bread.quantity, bread.unitPrice, bread.amount], ['TESTSHOP', 'DE', 'EUR', '6,00', '', '', '1,50'])
  const unreadCause = ['Не удалось прочитать обязательное поле']
  assert.deepEqual(form.problems, { [`lines.${bread.key}.quantity`]: unreadCause, [`lines.${bread.key}.unit_price`]: unreadCause })
  assert.ok(form.unread.includes(`lines.${bread.key}.quantity`) && form.unread.includes(`lines.${bread.key}.unit_price`))
  // A body written by hand from nothing, for crops that show no recognized data.
  const manual = body(edit(review.createReview(null, []),
    { type: 'header', patch: { storeName: 'TESTSHOP', country: 'DE', currency: 'EUR', purchasedOn: '2026-10-04', localTime: '16:10', total: '1,50' } },
    { type: 'line', key: 1, patch: { name: 'BROT', amount: '1,5' } })).input

  // 2. Refusals that save nothing.
  refused(await confirm(saved.id, manual), 'review_unavailable', 409)
  refused(await confirm(999_999, manual), 'not_found', 404)
  const noToken = await originalFetch(new URL(`/api/recognition/receipt-images/${pendingCut.id}/confirm/`, origin), {
    method: 'POST', body: JSON.stringify(manual), headers: { 'Content-Type': 'application/json', Origin: origin.origin },
  })
  assert.equal(noToken.status, 403); assert.equal((await noToken.json()).error.code, 'csrf_failed')
  requests.push({ method: 'POST', path: new URL(noToken.url).pathname, status: noToken.status })
  const unknownKey = await fetch(`/api/recognition/receipt-images/${pendingCut.id}/confirm/`, {
    method: 'POST', credentials: 'same-origin', body: JSON.stringify({ ...manual, draft: true }),
    headers: { 'Content-Type': 'application/json', 'X-CSRFToken': ok(await api.getRecognitionCsrf(options)).csrf_token },
  })
  assert.equal(unknownKey.status, 400); assert.equal((await unknownKey.json()).error.code, 'invalid_request')

  const typos = edit(form, { type: 'header', patch: { total: 'шесть' } }, { type: 'line', key: bread.key, patch: { quantity: '1,2345' } })
  const badFormat = body(typos, false)
  const fields = refused(await confirm(pendingCut.id, badFormat.input), 'invalid_parameter', 400)
  assert.deepEqual(fields.fields.sort(), ['lines.0.quantity', 'receipt.total'])
  const typosMarked = review.reviewReducer(typos, { type: 'refused', error: fields, sent: badFormat.sent })
  assert.deepEqual(typosMarked.problems, { 'receipt.total': [review.problemTexts.field], [`lines.${bread.key}.quantity`]: [review.problemTexts.field] })
  await page('02-refused-format.html', 'Отказ: сервер не принял значения', 'состояние после ответа 400 invalid_parameter на итог «шесть» и количество «1,2345».',
    async () => panel('Вырезки чеков', formCard(pendingCut, typosMarked, countries, reviewErrorText(fields))))

  const wrongTotal = edit(form, { type: 'header', patch: { total: '9,99' } })
  const mismatch = body(wrongTotal)
  const invalid = refused(await confirm(pendingCut.id, mismatch.input), 'review_invalid', 409)
  assert.ok(invalid.issues.some((issue) => issue.reason === 'total_mismatch' && issue.severity === 'error' && issue.context.attribute === 'total'), JSON.stringify(invalid.issues))
  const marked = review.reviewReducer(wrongTotal, { type: 'refused', error: invalid, sent: mismatch.sent })
  assert.deepEqual(marked.problems['receipt.total'], ['Сумма строк не совпадает с итогом'])
  assert.deepEqual(marked.issues, invalid.issues); assert.deepEqual(marked.header, wrongTotal.header)
  await page('03-refused-rules.html', 'Отказ: данные не прошли проверку', 'состояние после ответа 409 review_invalid на итог 9,99; причины заменены причинами отказа.',
    async () => panel('Вырезки чеков', formCard(pendingCut, marked, countries, reviewErrorText(invalid))))
  assert.deepEqual(ok(await api.getReceiptImage(pendingCut.id, options)).issues, pendingCut.issues, 'A refusal keeps the causes of the recognition')
  assert.deepEqual(ok(await api.getJob(partial.id, options)), partial, 'Refusals leave the job untouched')
  assert.deepEqual(await counts(), before, 'Refusals save no receipt and no store')
  console.log('needs_review crop read by the form model; review_unavailable, not_found, csrf_failed, invalid_request, invalid_parameter [fields], review_invalid [issues] saved nothing')

  // 3. Corrections of a person: two numbers typed with a comma, a line removed and typed again, a discount added and removed.
  let fixed = edit(form, { type: 'line', key: bread.key, patch: { quantity: '1', unitPrice: '1,5' } },
    { type: 'remove', list: 'lines', key: cheese.key }, { type: 'add', list: 'lines' }, { type: 'add', list: 'discounts' })
  const typed = fixed.lines.at(-1)
  fixed = edit(fixed, { type: 'line', key: typed.key, patch: { name: 'KAESE 200 G', quantity: '2', unit: 'pcs', unitPrice: '2,25', amount: '4,50', taxKind: 'vat', taxCode: 'A' } },
    { type: 'line', key: typed.key, patch: { taxRate: '7' } }, { type: 'remove', list: 'discounts', key: fixed.discounts[0].key })
  assert.deepEqual(review.missingRequired(fixed), {})
  const good = body(fixed)
  assert.deepEqual(good.input.lines.map((line) => [line.position, line.source_position, line.name, line.quantity, line.unit_price, line.amount]),
    [[1, 1, 'BROT', '1.000', '1.5000', '1.50'], [2, null, 'KAESE 200 G', '2.000', '2.2500', '4.50']])
  assert.deepEqual([good.input.receipt.total, good.input.discounts.length], ['6.00', 0])
  await page('04-corrected.html', 'Исправленная форма перед подтверждением', 'количество и цена строки 1 введены, строка 2 удалена и набрана заново вручную.',
    async () => panel('Вырезки чеков', formCard(pendingCut, fixed, countries)))

  // The same store and polling objects as on the job screen: one POST, reads paused, the answer replaces the job.
  const poll = createPollingRequest((signal) => api.getJob(partial.id, { ...options, signal }), isActive, acceptJob)
  lifetimes.add(poll)
  poll.start()
  await until(() => poll.getSnapshot(), (state) => state.kind === 'ok')
  let reread = 0
  const actions = createReviewActions((id, input, signal) => api.confirmReceiptImage(id, input, { ...options, signal }), (signal) => api.getRecognitionCsrf({ ...options, signal }), {
    pause: poll.pause, success: (result) => { poll.setData(result.job); poll.resume(false) }, failure: (_error, again) => { reread += Number(again); poll.resume(again) },
  })
  lifetimes.add(actions)
  const sentBefore = posts()
  const outcome = actions.run(pendingCut.id, good.input)
  assert.equal(await actions.run(pendingCut.id, good.input), undefined, 'A second press while waiting sends nothing')
  assert.equal(await outcome, undefined)
  assert.equal(posts(), sentBefore + 1, 'Exactly one POST for one confirmation')
  assert.equal(requests.at(-1).status, 200)
  const done = actions.getSnapshot()
  assert.equal(done.kind, 'done', JSON.stringify(done))
  const { image } = done
  assert.deepEqual([image.status, image.normalized_result, typeof image.receipt_id, typeof image.confirmed_at], ['imported', null, 'number', 'string'])
  assert.ok(image.issues.every((issue) => issue.severity !== 'error'), JSON.stringify(image.issues))
  assert.equal(done.message, `Подтверждено. Чек №${image.receipt_id} сохранён.`)
  const job = poll.getSnapshot().data
  assert.deepEqual([job.status, job.version, job.progress.imported, job.progress.review, job.review_required, job.actions.can_retry, job.finished_at],
    ['succeeded', partial.version + 1, 2, 0, false, false, partial.finished_at])
  assert.deepEqual(ok(await api.getJob(partial.id, options)), job, 'The answer carries the job exactly as a read returns it')
  await page('05-saved.html', 'После подтверждения: чек сохранён', 'карточка вырезки и задание показаны по ответу подтверждения, до повторного чтения списка.',
    async () => h('div', { className: 'ck-rec' }, h('section', { className: 'ck-rec-panel' }, h('h2', null, `Задание №${job.id}`), h(ui.JobSummary, { job })),
      h('section', { className: 'ck-rec-panel' }, h('h2', null, `Вырезки чеков (${cuts.length})`), h(ui.ReceiptImages, { images: cuts, finished: true, review: { state: done, run: idle.run } }))))
  const stored = ok(await api.getReceiptImages({ job: partial.id, ordering: 'created_at' }, options)).results.find((cut) => cut.id === pendingCut.id)
  assert.deepEqual([stored.status, stored.receipt_id, stored.confirmed_at, stored.normalized_result], ['imported', image.receipt_id, image.confirmed_at, null])
  const receipt = ok(await receipts.getReceipt(image.receipt_id, options))
  assert.deepEqual([receipt.total, receipt.currency, receipt.store.name, receipt.lines_count, receipt.origin], ['6.00', 'EUR', 'TESTSHOP', 2, 'recognized'])
  const lines = ok(await receipts.getReceiptLines(receipt.id, {}, options)).results
  assert.deepEqual(lines.map((line) => [line.position, line.name, line.quantity, line.unit, line.unit_price, line.amount, line.tax_rate?.rate ?? null]),
    [[1, 'BROT', '1.000', 'pcs', '1.5000', '1.50', '7.00'], [2, 'KAESE 200 G', '2.000', 'pcs', '2.2500', '4.50', '7.00']])
  const byReceipt = ok(await api.getReceiptImages({ receipt: receipt.id }, options)).results
  assert.deepEqual(byReceipt.map((cut) => [cut.id, cut.confirmed_at]), [[pendingCut.id, image.confirmed_at]], 'The receipt screen reads the manual mark')
  assert.equal(ok(await getStores({ q: 'TESTSHOP' }, options)).count, 1, 'The new store is found by the store search of the form')
  await page('07-receipt-photo.html', `Чек №${receipt.id}: фото с пометкой`, 'блок изображений экрана чека после подтверждения.',
    async () => h('div', { className: 'receipts-page' }, h('section', { className: 'receipt-panel' }, h('h2', null, 'Изображения'), h(ui.ReceiptCrops, { images: byReceipt, receiptId: receipt.id }))))
  console.log(`confirm → 200 imported, receipt ${receipt.id} (6.00 EUR, typed line saved), job succeeded v${job.version}, can_retry false; one POST`)

  // 4. Repeat and a different body.
  const saveCounts = await counts()
  assert.deepEqual(saveCounts, { receipts: 2, stores: 2 })
  const again = ok(await confirm(pendingCut.id, good.input))
  assert.deepEqual([again.image.receipt_id, again.image.status, again.image.confirmed_at, again.job.version], [image.receipt_id, 'imported', image.confirmed_at, job.version])
  const other = body(edit(fixed, { type: 'line', key: typed.key, patch: { name: 'KAESE 250 G' } }))
  const resolved = await actions.run(pendingCut.id, other.input)
  refused(resolved, 'review_resolved', 409)
  assert.equal(reread, 1, 'review_resolved asks for one reread of the saved state')
  assert.match(actions.getSnapshot().message, /уже подтверждён с другими данными/)
  assert.deepEqual(await counts(), saveCounts, 'A repeat and a different body save nothing')
  assert.deepEqual(ok(await receipts.getReceiptLines(receipt.id, {}, options)).results, lines)
  console.log('same body → 200 without writes; other body → 409 review_resolved with a reread')

  // 5. Another photo of the same two receipts with a wrong total: the confirmation links the saved receipts.
  const second = ok(await api.uploadPhoto(new File([doubleBytes, '\nreview check: second photo'], 'double-2.png', { type: 'image/png' }), options))
  console.log(await worker('inconsistent_total'))
  const wrong = ok(await api.getJob(second.job.id, options))
  assert.deepEqual([wrong.status, wrong.progress.review], ['partial_succeeded', 2])
  const wrongCuts = ok(await api.getReceiptImages({ job: wrong.id, ordering: 'created_at' }, options)).results
  const linked = []
  for (const [index, cut] of wrongCuts.entries()) {
    assert.equal(cut.status, 'needs_review')
    const draft = review.createReview(cut.normalized_result, cut.issues)
    assert.equal(draft.header.total, '123,45'); assert.deepEqual(draft.problems['receipt.total'], ['Сумма строк не совпадает с итогом'])
    const untouched = body(draft)
    const refusedTotal = refused(await confirm(cut.id, untouched.input), 'review_invalid', 409)
    assert.ok(refusedTotal.issues.some((issue) => issue.reason === 'total_mismatch'))
    // The second crop also gets another name of its first line: a correction that the saved receipt must not take.
    const corrected = edit(draft, { type: 'header', patch: { total: index === 0 ? '4,42' : '6,00' } },
      ...(index === 1 ? [{ type: 'line', key: draft.lines[0].key, patch: { name: 'BROT GROSS' } }] : []))
    const result = ok(await confirm(cut.id, body(corrected).input))
    assert.ok(['reused', 'updated'].includes(result.image.status), `An existing receipt must be linked, got ${result.image.status}`)
    assert.equal(result.image.receipt_id, index === 0 ? saved.receipt_id : receipt.id)
    assert.equal(typeof result.image.confirmed_at, 'string')
    const conflicts = result.image.issues.filter((issue) => ['receipt_conflict', 'receipt_line_conflict', 'receipt_structure_conflict'].includes(issue.reason))
    assert.equal(conflicts.length > 0, index === 1, `Only the changed name is a correction that was not applied: ${JSON.stringify(result.image.issues)}`)
    assert.ok(conflicts.every((issue) => issue.severity === 'warning'))
    linked.push({ status: result.image.status, receipt: result.image.receipt_id, issues: result.image.issues.map((issue) => issue.reason) })
    assert.equal(result.job.progress.review, 1 - index)
  }
  assert.equal(ok(await api.getJob(wrong.id, options)).status, 'succeeded')
  await page('06-linked.html', 'После подтверждения: найден сохранённый чек', 'вторая фотография тех же чеков; после исправления итога вырезки привязаны к уже сохранённым чекам.',
    async () => panel(`Вырезки чеков (${wrongCuts.length})`, h(ui.ReceiptImages, { images: ok(await api.getReceiptImages({ job: wrong.id, ordering: 'created_at' }, options)).results, finished: true, review: idle })))
  assert.deepEqual(await counts(), saveCounts, 'Linking saves no new receipt and no new store')
  assert.deepEqual(ok(await receipts.getReceiptLines(receipt.id, {}, options)).results, lines, 'Filled values of the saved receipt are not overwritten')
  console.log(`second photo, total 123.45 → 409 review_invalid; corrected → ${JSON.stringify(linked)}; no new receipts or lines`)

  // 6. A job that is still running refuses the confirmation.
  const singleBytes = await readFile(join(media, 'demo/single.png'))
  const third = ok(await api.uploadPhoto(new File([singleBytes, '\nreview check: active job'], 'single-3.png', { type: 'image/png' }), options))
  const paused = worker('pause_recognize')
  await until(async () => ok(await api.getJob(third.job.id, options)), (item) => item.status === 'running' && item.stage === 'recognize')
  const runningCuts = ok(await api.getReceiptImages({ job: third.job.id }, options)).results
  assert.ok(runningCuts.length > 0, 'The paused job must already have crops')
  refused(await confirm(runningCuts[0].id, manual), 'job_active', 409)
  assert.equal(ok(await api.cancelJob(third.job.id, options)).status, 'cancel_requested')
  console.log(await paused)
  assert.equal(ok(await api.getJob(third.job.id, options)).status, 'cancelled')
  refused(await confirm(runningCuts[0].id, manual), 'review_unavailable', 409)
  assert.deepEqual(await counts(), saveCounts)

  console.log(JSON.stringify({ result: 'passed', mode, database: process.env.POSTGRES_DB, receipts: saveCounts.receipts, linked,
    requests: requests.length, confirm_posts: posts(), statuses: [...new Set(requests.map((request) => request.status))].sort(),
    ...(pagesDir && { pages: written.sort() }), not_covered: ['review_busy', 'browser UI'] }))
} catch (error) {
  console.error(`Review check FAILED: ${error.message}`)
  const last = requests.at(-1)
  if (last) console.error(`Last request: ${last.method} ${last.path} → ${last.status}${typeof last.body === 'string' ? ` ${last.body}` : ''}`)
  process.exitCode = 1
} finally {
  for (const lifetime of lifetimes) lifetime.dispose()
  for (const { child } of workers) child.kill()
  await Promise.allSettled([...workers].map(({ completion }) => completion))
  globalThis.fetch = originalFetch
  await proxy?.close()
  await loader?.close()
}
