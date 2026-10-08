// QA acceptance of the `accounts` mode: two people on one server, through a running Vite dev/preview proxy.
// Node 24 strips the real adapters' TypeScript. No browser, no mocked fetch: only a cookie jar per person.
// Needs a server with CHECKIST_AUTH_MODE=accounts and a fresh `migrate` + `seed_accounts_demo` database.
// The file with the JSON printed by the seed is the third argument; the two passwords come from the environment
// and are never printed. The password of demo_user is changed and put back: the scenario may be repeated
// (dev, then preview) on the same database.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { onAuthSignal } from '../src/api/auth-signal.ts'
import { getProduct, getProducts } from '../src/api/catalog.ts'
import { getHealth } from '../src/api/health.ts'
import { clearRecognitionCsrf, getRecognitionCsrf } from '../src/api/local.ts'
import { getProductPrices } from '../src/api/prices.ts'
import { requestProductClassificationRun } from '../src/api/product-classifications.ts'
import { confirmProductMerge, detectProductMerges, getProductMerge, getProductMergeLines, getProductMerges } from '../src/api/product-merges.ts'
import { getReceipt, getReceiptLines, getReceipts } from '../src/api/receipts.ts'
import { getJob, getJobs, getPhoto, getPhotos, getReceiptImage, getReceiptImages } from '../src/api/recognition.ts'
import { changePassword, clearAuthCsrf, getMe, login, logout } from '../src/api/session.ts'
import { getSpending } from '../src/api/stats.ts'
import { getStores } from '../src/api/stores.ts'

const usage = 'Usage: node frontend/scripts/check_accounts_proxy.mjs dev|preview <vite-origin, e.g. http://127.0.0.1:15173> <file with the JSON printed by seed_accounts_demo>'
const MODERATOR_PASSWORD = 'ACCOUNTS_DEMO_MODERATOR_PASSWORD', USER_PASSWORD = 'ACCOUNTS_DEMO_USER_PASSWORD'
const ROLES = ['moderator', 'user']
const SESSION_COOKIES = ['csrftoken', 'sessionid']
const NO_STORE = 'private, no-store'
const PNG = [0x89, 0x50, 0x4e, 0x47]
const originalFetch = globalThis.fetch
const requests = []
const signals = []
// One jar per browser profile: `second` is another device of demo_user, `stale` replays a cookie after sign-out.
const jars = { guest: new Map(), moderator: new Map(), user: new Map(), second: new Map(), stale: new Map() }
let who = 'guest'
let passed = 0
let restore

function loopback(value, name) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:', `${name}: only HTTP loopback QA origins are allowed`)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${name}: use a loopback host`)
  assert.equal(url.href, `${url.origin}/`, `${name}: use an origin without credentials, path or query`)
  assert.ok(url.port && !['8000', '5173', '5432', '15432'].includes(url.port), `${name}: do not use dev ports`)
  return url
}
/** PowerShell 5.1 writes redirected output as UTF-16 and `Out-File -Encoding utf8` with a BOM: both are read. */
function readSeed(path) {
  const bytes = readFileSync(path)
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^﻿/, '')
  let seed
  try { seed = JSON.parse(text) } catch { throw new Error(`${path}: not the JSON printed by seed_accounts_demo`) }
  const id = (value) => Number.isSafeInteger(value) && value > 0
  const perRole = (value, check) => typeof value === 'object' && value !== null && ROLES.every((role) => check(value[role]))
  assert.ok(seed?.created === true && id(seed.shared_product_id) && id(seed.store_id)
    && perRole(seed.users, (user) => id(user?.id) && typeof user.username === 'string')
    && perRole(seed.receipt_ids, id) && perRole(seed.own_product_ids, id)
    && id(seed.merge?.group_id) && id(seed.merge.target_product_id) && perRole(seed.merge.line_ids, (ids) => Array.isArray(ids) && ids.length > 0 && ids.every(id))
    && perRole(seed.media, (media) => ['photo_id', 'job_id', 'image_id'].every((key) => id(media?.[key]))
      && ['storage_uuid', 'original', 'prepared', 'crop'].every((key) => typeof media[key] === 'string' && media[key])),
  `${path}: unexpected shape; pass the whole JSON line printed by seed_accounts_demo`)
  return seed
}
const cookieHeader = (jar) => [...jar].map(([name, value]) => `${name}=${value}`).join('; ')
/** Keep `csrftoken` and `sessionid` like a browser profile would; a cookie deleted by the server is forgotten. */
function keepCookies(jar, response, path) {
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...attributes] = line.split(';').map((part) => part.trim())
    const at = pair.indexOf('=')
    const name = pair.slice(0, at), value = pair.slice(at + 1)
    if (!SESSION_COOKIES.includes(name)) continue
    if (value === '' || value === '""' || attributes.some((attribute) => /^max-age=0$/i.test(attribute))) { jar.delete(name); continue }
    if (name === 'sessionid') {
      assert.ok(attributes.some((attribute) => /^httponly$/i.test(attribute)), `${path}: sessionid must be HttpOnly`)
      assert.ok(attributes.some((attribute) => /^samesite=lax$/i.test(attribute)), `${path}: sessionid must be SameSite=Lax`)
    }
    jar.set(name, value)
  }
}
function ok(result, label = 'request') {
  assert.equal(result.kind, 'ok', `${label}: ${JSON.stringify(result).slice(0, 300)}`)
  return result.data
}
function fails(result, reason, status, label) {
  assert.equal(result.kind, 'error', `${label}: expected ${status} ${reason}, received ${JSON.stringify(result).slice(0, 300)}`)
  assert.deepEqual([result.reason, result.status], [reason, status], `${label}: ${JSON.stringify(result).slice(0, 300)}`)
  assert.equal(requests.at(-1).status, status, `${label}: HTTP status of the last request`)
  return result
}
function pass(message) {
  passed++
  console.log(`PASS ${message}`)
}

try {
  const [mode, viteOrigin, seedPath] = process.argv.slice(2)
  assert.ok(process.argv.length === 5 && ['dev', 'preview'].includes(mode), usage)
  assert.match(process.env.POSTGRES_DB ?? '', /^checkist_qa(?:_[a-zA-Z0-9]+)*$/, 'Apply the full QA environment first: this script signs in and changes a password')
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(process.env.POSTGRES_HOST), 'QA Postgres must be on loopback')
  assert.ok(process.env.POSTGRES_PORT && !['5432', '15432'].includes(process.env.POSTGRES_PORT), 'Do not use the dev Postgres port')
  assert.equal(process.env.VITE_API_BASE_URL, '/api', 'QA must use the /api prefix')
  assert.equal(process.env.CHECKIST_AUTH_MODE, 'accounts',
    'This script checks the sign-in: set CHECKIST_AUTH_MODE=accounts in this terminal and in the terminal of the API, then restart the API (local_single has no sign-in)')
  const origin = loopback(viteOrigin, 'Vite origin')
  const target = loopback(process.env.DEV_API_PROXY_TARGET, 'DEV_API_PROXY_TARGET')
  assert.notEqual(origin.origin, target.origin, 'API and Vite proxy must be separate origins')
  assert.ok((process.env.DJANGO_CSRF_TRUSTED_ORIGINS ?? '').split(',').includes(origin.origin), 'Trust this exact Vite Origin in Django')
  const passwords = { moderator: process.env[MODERATOR_PASSWORD], user: process.env[USER_PASSWORD] }
  assert.ok(passwords.moderator && passwords.user, `Set ${MODERATOR_PASSWORD} and ${USER_PASSWORD}: the passwords given to seed_accounts_demo`)
  assert.notEqual(passwords.moderator, passwords.user, 'The two demo accounts must have different passwords')
  // Refused by nobody's validators as long as the seed accepted the original one; put back before the end.
  const temporaryPassword = `${passwords.user}-Tmp7q`
  const seed = readSeed(seedPath)
  const other = { moderator: 'user', user: 'moderator' }
  const owner = { moderator: 'moderator', user: 'user', second: 'user' }
  const mediaPaths = (role) => ['original', 'prepared', 'crop'].map((key) => `/media/${seed.media[role][key]}`)

  /** Nothing a person receives may name a receipt or a file of the other one. A guest and a stale cookie get neither. */
  function assertNoForeign(body, path) {
    const foreign = owner[who] ? [other[owner[who]]] : ROLES
    const receipts = foreign.map((role) => seed.receipt_ids[role])
    const links = foreign.flatMap((role) => [
      new RegExp(`/receipts/${seed.receipt_ids[role]}/`), new RegExp(`[?&]receipt=${seed.receipt_ids[role]}(?:&|$)`), new RegExp(seed.media[role].storage_uuid, 'i'),
    ])
    const walk = (value, key) => {
      if (typeof value === 'string') assert.ok(!links.some((link) => link.test(value)), `${path} as ${who}: «${key}» leads to a foreign receipt or file`)
      else if (Array.isArray(value)) for (const item of value) walk(item, key)
      else if (typeof value === 'object' && value !== null) {
        for (const [name, item] of Object.entries(value)) {
          if (name === 'receipt_id') assert.ok(!receipts.includes(item), `${path} as ${who}: receipt_id ${item} of a foreign receipt`)
          walk(item, name)
        }
      }
    }
    walk(body, '')
  }

  // Node fetch has no browser cookie jar: carry the cookies of the current person and the page Origin explicitly.
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input, origin)
    assert.equal(url.origin, origin.origin, 'All acceptance requests must go through the Vite proxy')
    assert.ok(url.pathname.startsWith('/api/') && url.pathname.endsWith('/'), `Unexpected path ${url.pathname}`)
    const jar = jars[who]
    const headers = new Headers(init.headers)
    headers.set('Origin', origin.origin)
    const carried = init.credentials !== 'omit'
    if (carried && jar.size) headers.set('Cookie', cookieHeader(jar))
    const response = await originalFetch(url, { ...init, headers, redirect: 'error' })
    if (carried) keepCookies(jar, response, url.pathname)
    requests.push({ who, method: init.method ?? 'GET', path: url.pathname + url.search, status: response.status })
    if (response.status !== 204) {
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/, `${url.pathname}: expected JSON`)
      assertNoForeign(await response.clone().json(), url.pathname)
    }
    if (url.pathname !== '/api/health/' && !/^\/api\/(?:countries|currencies|stores|brands|categories|generic-products|products)\//.test(url.pathname)) {
      assert.match(response.headers.get('cache-control') ?? '', /no-store/, `${url.pathname}: expected Cache-Control: no-store`)
    }
    return response
  }
  const options = { baseUrl: `${origin.origin}/api` }
  onAuthSignal((signal) => { signals.push(signal) })
  /** Another person at the keyboard: no CSRF token read before belongs to them. */
  const as = (name) => {
    who = name
    clearAuthCsrf(options)
    clearRecognitionCsrf(options)
  }
  /** What the shell would be told during `action`. */
  async function signalled(action) {
    const before = signals.length
    const result = await action()
    return { result, raised: signals.slice(before) }
  }
  /** `401 not_authenticated` of an ordinary request: the screen gets `aborted`, the shell — one signal. */
  async function expired(action, label) {
    const { result, raised } = await signalled(action)
    assert.deepEqual(result, { kind: 'aborted' }, `${label}: ${JSON.stringify(result).slice(0, 300)}`)
    assert.equal(requests.at(-1).status, 401, `${label}: HTTP status`)
    assert.deepEqual(raised, ['unauthenticated'], `${label}: exactly one session signal`)
  }
  /** «Я» itself answers «guest» as an error of its own and raises no signal. */
  async function guest(label) {
    const { result, raised } = await signalled(() => getMe(options))
    fails(result, 'not_authenticated', 401, `${label}: GET /api/me/`)
    assert.deepEqual(raised, [], `${label}: GET /api/me/ must not raise the session signal`)
  }
  /** `403 permission_denied`: the screen keeps its error, the shell is told to re-read «Я». */
  async function forbidden(action, label) {
    const { result, raised } = await signalled(action)
    fails(result, 'permission_denied', 403, label)
    assert.deepEqual(raised, ['forbidden'], `${label}: exactly one «forbidden» signal`)
  }
  const plain = async (base, path, accept = 'application/json') => {
    const response = await originalFetch(new URL(path, base), { headers: { Accept: accept }, redirect: 'error', signal: AbortSignal.timeout(15_000) }).catch(() => {
      throw new Error(`GET ${new URL(path, base)}: unavailable; start the QA API and Vite, then check their addresses`)
    })
    return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() }
  }
  /** A file under /media/ with the cookies of `name`, through the proxy, as an <img> of that profile would ask. */
  async function media(name, path) {
    const jar = jars[name]
    const response = await originalFetch(new URL(path, origin), {
      headers: jar.size ? { Cookie: cookieHeader(jar) } : {}, redirect: 'error', signal: AbortSignal.timeout(15_000),
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    requests.push({ who: name, method: 'GET', path, status: response.status })
    return { status: response.status, type: response.headers.get('content-type') ?? '', cache: response.headers.get('cache-control') ?? '', bytes }
  }
  async function ownFile(name, path) {
    const file = await media(name, path)
    assert.deepEqual([file.status, file.type, file.cache], [200, 'image/png', NO_STORE], `${path} as ${name}: one's own file`)
    assert.deepEqual([...file.bytes.subarray(0, 4)], PNG, `${path} as ${name}: not a PNG`)
    return file.bytes
  }
  async function noFile(name, path) {
    const file = await media(name, path)
    assert.deepEqual([file.status, file.bytes.length, file.cache], [404, 0, NO_STORE], `${path} as ${name}: expected the empty 404`)
  }

  // The origin must be Vite in the named mode, serve the sign-in client, and its /api must be the same Django.
  const page = await plain(origin, '/', 'text/html')
  assert.equal(page.status, 200, `GET ${origin.origin}/: HTTP ${page.status}`)
  assert.match(page.body, /<div id="root">/, 'The origin must serve the SPA: start Vite dev or preview')
  assert.equal(page.body.includes('/@vite/client'), mode === 'dev', `The origin does not look like Vite ${mode}`)
  const script = mode === 'dev' ? '/src/api/session.ts' : /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1]
  assert.ok(script, 'The built page names no script: run npm.cmd run build before preview')
  assert.match((await plain(origin, script, '*/*')).body, /auth\/login\//, `${script}: the sign-in adapters are missing`)
  const account = await plain(origin, '/account', 'text/html')
  assert.equal(account.status, 200, '/account: the SPA fallback must answer 200')
  assert.match(account.body, /<div id="root">/, '/account: the SPA fallback must serve index.html')
  const [viaProxy, viaDjango] = [await plain(origin, '/api/me/'), await plain(target, '/api/me/')]
  assert.notEqual(viaDjango.status, 200, 'The API answers /api/me/ without a sign-in: it runs in local_single. Start it with CHECKIST_AUTH_MODE=accounts')
  assert.equal(viaDjango.status, 401, `GET ${target.origin}/api/me/: HTTP ${viaDjango.status}`)
  assert.deepEqual(viaProxy, viaDjango, 'Vite proxy and Django answer differently')
  assert.equal(JSON.parse(viaDjango.body).error.code, 'not_authenticated')
  pass(`${origin.origin} is Vite ${mode}, serves the sign-in client (${script}) and /account; proxy = Django in the accounts mode`)

  // A guest: health is open, «Я» says «guest», everything else ends the page and tells the shell.
  as('guest')
  const health = await getHealth(options)
  assert.ok(['ok', 'degraded'].includes(health.kind), `health for a guest: ${JSON.stringify(health)}`)
  await guest('guest')
  await expired(() => getProducts({}, options), 'guest: GET /api/products/')
  await expired(() => getProductPrices(seed.shared_product_id, {}, options), 'guest: price history')
  await expired(() => getReceipts({}, options), 'guest: GET /api/receipts/')
  await expired(() => getSpending({}, options), 'guest: GET /api/stats/spending/')
  await expired(() => getProductMerges({}, options), 'guest: GET /api/product-merges/')
  await expired(() => getRecognitionCsrf(options), 'guest: GET /api/recognition/csrf/')
  for (const role of ROLES) for (const path of mediaPaths(role)) await noFile('guest', path)
  assert.equal(jars.guest.has('sessionid'), false, 'A guest must not receive a session cookie')
  pass('guest: health answers; /api/me/ → 401 not_authenticated without a signal; catalog, prices, receipts, statistics, merges, recognition/csrf → aborted + one signal each; MEDIA → empty 404')

  // One wrong password: a second one is not sent, the counter of failures must stay far from the delay.
  as('user')
  fails(await login({ username: seed.users.user.username, password: `${passwords.user}-wrong` }, options), 'invalid_credentials', 401, 'sign-in with a wrong password')
  assert.equal(jars.user.has('sessionid'), false, 'A refused sign-in must not open a session')
  await guest('after a refused sign-in')
  pass('wrong password (once) → 401 invalid_credentials, no session cookie, still a guest')

  // Both sign in; a second device of demo_user for the password change below.
  const me = {}
  for (const name of ['moderator', 'user', 'second']) {
    as(name)
    const role = owner[name]
    const answer = ok(await login({ username: seed.users[role].username, password: passwords[role] }, options), `sign-in of ${name}`)
    assert.deepEqual(SESSION_COOKIES.filter((cookie) => jars[name].has(cookie)), SESSION_COOKIES, `${name}: both cookies after the sign-in`)
    const { csrf_token: _token, ...read } = ok(await getMe(options), `GET /api/me/ of ${name}`)
    const { csrf_token: _answerToken, ...signedIn } = answer
    assert.deepEqual(read, signedIn, `${name}: «Я» of the sign-in and of /api/me/ differ`)
    assert.deepEqual(read, {
      mode: 'accounts', user: { id: seed.users[role].id, username: seed.users[role].username, is_staff: false },
      permissions: { moderate_catalog: role === 'moderator' },
    }, `${name}: unexpected «Я»`)
    me[name] = read
  }
  assert.equal(new Set(Object.values(jars).map((jar) => jar.get('sessionid')).filter(Boolean)).size, 3, 'Three sign-ins — three different sessions')
  pass(`sign-in: ${me.moderator.user.username} (id ${me.moderator.user.id}, moderator) and ${me.user.user.username} (id ${me.user.user.id}, no right), two sessions of the latter; sessionid is HttpOnly, SameSite=Lax`)

  // Receipts, photos, jobs and crops: one's own only; a foreign id answers like a missing one.
  const receipt = {}, total = {}
  for (const role of ROLES) {
    as(role)
    const mine = seed.receipt_ids[role], theirs = seed.receipt_ids[other[role]]
    const own = seed.media[role], foreign = seed.media[other[role]]
    const list = ok(await getReceipts({}, options), `receipts of ${role}`)
    assert.deepEqual([list.count, list.results.map((item) => item.id)], [1, [mine]], `${role}: the list of receipts must hold one's own receipt only`)
    receipt[role] = ok(await getReceipt(mine, options))
    assert.deepEqual([receipt[role].id, receipt[role].total], [mine, list.results[0].total], `${role}: the receipt and its list entry differ`)
    assert.equal(ok(await getReceiptLines(mine, {}, options)).count, 3, `${role}: three lines of the demo receipt`)
    fails(await getReceipt(theirs, options), 'not_found', 404, `${role}: a foreign receipt`)
    fails(await getReceiptLines(theirs, {}, options), 'not_found', 404, `${role}: lines of a foreign receipt`)
    assert.equal(ok(await getReceipts({ product: seed.own_product_ids[other[role]] }, options)).count, 0, `${role}: no receipt with the product bought only by the other one`)
    const stores = ok(await getStores({}, options))
    assert.deepEqual(stores.results.map((store) => [store.id, store.receipts_count]), [[seed.store_id, 1]], `${role}: the store counts one's own receipts only`)

    const photos = ok(await getPhotos({}, options))
    assert.deepEqual([photos.count, photos.results.map((photo) => photo.id)], [1, [own.photo_id]], `${role}: the list of photos`)
    assert.deepEqual([photos.results[0].original_url, photos.results[0].preview_url], [`/media/${own.original}`, `/media/${own.prepared}`], `${role}: the files of the photo`)
    assert.deepEqual(ok(await getJobs({}, options)).results.map((job) => job.id), [own.job_id], `${role}: the list of jobs`)
    const images = ok(await getReceiptImages({}, options))
    assert.deepEqual(images.results.map((image) => [image.id, image.receipt_id, image.image_url]), [[own.image_id, mine, `/media/${own.crop}`]], `${role}: the list of crops`)
    assert.equal(ok(await getJob(own.job_id, options)).id, own.job_id)
    fails(await getPhoto(foreign.photo_id, options), 'not_found', 404, `${role}: a foreign photo`)
    fails(await getJob(foreign.job_id, options), 'not_found', 404, `${role}: a foreign job`)
    fails(await getReceiptImage(foreign.image_id, options), 'not_found', 404, `${role}: a foreign crop`)
    assert.equal(ok(await getReceiptImages({ receipt: theirs }, options)).count, 0, `${role}: no crops of a foreign receipt`)
    pass(`${role}: receipts [${mine}], photo ${own.photo_id}, job ${own.job_id}, crop ${own.image_id}; foreign receipt ${theirs}, photo, job and crop → 404 not_found`)
  }
  assert.notEqual(receipt.moderator.total, receipt.user.total, 'The demo receipts must differ in their totals')

  // The catalog is shared; a price observation of the other one carries the price without the receipt.
  const RECEIPT_FIELDS = ['observed_at', 'quantity', 'discount_amount', 'receipt_id', 'position']
  const history = {}, foreignOnly = {}
  for (const role of ROLES) {
    as(role)
    history[role] = ok(await getProductPrices(seed.shared_product_id, { ordering: '-observed_at' }, options), `price history of ${role}`)
    assert.equal(history[role].count, 2, `${role}: both purchases of the shared product are in the history`)
    const mine = history[role].results.filter((point) => point.own)
    assert.deepEqual(mine.map((point) => point.receipt_id), [seed.receipt_ids[role]], `${role}: exactly one own observation, with one's own receipt`)
    for (const point of history[role].results) {
      assert.ok(RECEIPT_FIELDS.every((field) => (point[field] !== null) === point.own), `${role}: «own» must decide the five receipt fields: ${JSON.stringify(point)}`)
    }
    foreignOnly[role] = ok(await getProductPrices(seed.own_product_ids[other[role]], {}, options))
    assert.deepEqual(foreignOnly[role].results.map((point) => point.own), [false], `${role}: the product bought only by the other one has one foreign observation`)
    assert.deepEqual(ok(await getProductPrices(seed.own_product_ids[role], {}, options)).results.map((point) => point.receipt_id), [seed.receipt_ids[role]])
    assert.equal(ok(await getProduct(seed.own_product_ids[other[role]], options)).last_observed_at, null, `${role}: the moment of a foreign purchase is hidden in the product`)
    assert.notEqual(ok(await getProduct(seed.own_product_ids[role], options)).last_observed_at, null, `${role}: the moment of one's own purchase is shown`)
  }
  const shared = (points) => points.map(({ own: _own, observed_at: _at, quantity: _quantity, discount_amount: _discount, receipt_id: _receipt, position: _position, ...rest }) => rest)
  assert.deepEqual(shared(history.user.results), shared(history.moderator.results), 'Both see the same prices, dates and stores in the same order')
  assert.deepEqual(history.user.results.map((point) => point.own), history.moderator.results.map((point) => !point.own), 'The history of one is the mirror of the other')
  // demo_user bought the shared product later: only for them the last observation is their own.
  as('moderator')
  assert.equal(ok(await getProduct(seed.shared_product_id, options)).last_observed_at, null, 'moderator: the last purchase of the shared product is foreign')
  as('user')
  assert.notEqual(ok(await getProduct(seed.shared_product_id, options)).last_observed_at, null, 'user: the last purchase of the shared product is their own')
  pass(`price history of product ${seed.shared_product_id}: 2 observations for each, own with receipt_id, foreign with five nulls, mirrored; products.last_observed_at is null when the last purchase is foreign`)

  // Purchases of the merge group: the moderator sees every line, foreign ones without the receipt; the other one — only their own.
  as('moderator')
  const group = ok(await getProductMerge(seed.merge.group_id, options))
  assert.deepEqual([group.status, group.target_product_id], ['pending', seed.merge.target_product_id], 'The demo group must still be pending')
  const everyLine = ok(await getProductMergeLines(group.id, {}, options))
  const lineIds = (lines) => lines.map((line) => line.line_id).sort((a, b) => a - b)
  assert.deepEqual(lineIds(everyLine.results), [...seed.merge.line_ids.moderator, ...seed.merge.line_ids.user].sort((a, b) => a - b), 'moderator: every line of the group')
  for (const line of everyLine.results) {
    const mine = seed.merge.line_ids.moderator.includes(line.line_id)
    assert.equal(line.receipt_id, mine ? seed.receipt_ids.moderator : null, `moderator: receipt_id of line ${line.line_id}`)
    assert.equal('own' in line, false, 'A purchase of a group has no «own» field')
    assert.ok(line.quantity && line.amount && line.name, 'A foreign purchase keeps its name, quantity and amount')
  }
  assert.deepEqual(ok(await detectProductMerges(options)), { created: 0, extended: 0, group_ids: [] }, 'moderator: a repeated detect is allowed and changes nothing')
  as('user')
  const ownLines = ok(await getProductMergeLines(group.id, {}, options))
  assert.deepEqual(lineIds(ownLines.results), [...seed.merge.line_ids.user].sort((a, b) => a - b), 'user: only their own lines of the group')
  assert.ok(ownLines.results.every((line) => line.receipt_id === seed.receipt_ids.user), 'user: their own lines lead to their own receipt')
  await forbidden(() => detectProductMerges(options), 'user: POST product-merges/detect/')
  await forbidden(() => confirmProductMerge(group.id, { version: group.version, target_product_id: group.target_product_id }, options), 'user: POST product-merges/{id}/confirm/')
  await forbidden(() => requestProductClassificationRun(options), 'user: POST product-classifications/runs/')
  as('moderator')
  assert.deepEqual(ok(await getProductMerge(group.id, options)), group, 'The refused requests changed nothing in the group')
  pass(`merge group ${group.id}: moderator — ${everyLine.count} lines, receipt_id only at their own; user — ${ownLines.count} own; user detect / confirm / classification run → 403 permission_denied + «forbidden» signal, group unchanged`)

  // Statistics: one's own spending only.
  for (const role of ROLES) {
    as(role)
    const spending = ok(await getSpending({ group_by: 'product' }, options), `spending of ${role}`)
    assert.equal(spending.currencies.length, 1, `${role}: one currency in the demo`)
    const [{ currency, totals, items }] = spending.currencies
    assert.deepEqual([currency, totals.receipts_count], [receipt[role].currency, 1], `${role}: one's own receipt only`)
    assert.equal(Number(totals.receipts_total), Number(receipt[role].total), `${role}: spending must equal one's own receipt`)
    const products = items.filter((item) => item.kind === 'product').map((item) => item.id)
    assert.ok(products.includes(seed.own_product_ids[role]) && products.includes(seed.shared_product_id), `${role}: one's own products are in the spending`)
    assert.equal(products.includes(seed.own_product_ids[other[role]]), false, `${role}: the product bought only by the other one is not in the spending`)
    total[role] = totals.receipts_total
  }
  assert.notEqual(Number(total.moderator), Number(total.user), 'The two people must see different spending')
  pass(`statistics: moderator ${total.moderator} ${receipt.moderator.currency}, user ${total.user} ${receipt.user.currency}, one receipt each, no product of the other one`)

  // MEDIA: one's own file, the same empty 404 for a foreign and for a missing one.
  const pictures = {}
  for (const role of ROLES) {
    pictures[role] = []
    for (const path of mediaPaths(role)) {
      pictures[role].push(Buffer.from(await ownFile(role, path)).toString('base64'))
      await noFile(other[role], path)
    }
    await noFile(role, `/media/originals/${seed.media[role].storage_uuid}/missing.png`)
    await noFile(role, '/media/demo/missing.png')
  }
  assert.notDeepEqual(pictures.moderator, pictures.user, 'The demo pictures of the two people must differ')
  pass('MEDIA: own original, prepared and crop → 200 image/png, private no-store; foreign, missing and outside the photo directories → the same empty 404')

  // A refused new password changes nothing; a change ends the other session of the same person, not this one.
  as('user')
  const weak = fails(await changePassword({ current_password: passwords.user, new_password: '12345678' }, options), 'invalid_parameter', 400, 'a weak new password')
  assert.deepEqual([weak.fields, [...(weak.passwordIssues ?? [])].sort()], [['new_password'], ['entirely_numeric', 'too_common']], 'a weak new password: fields and password_issues')
  as('second')
  ok(await getMe(options), 'the second session after a refused change')
  as('user')
  restore = { from: temporaryPassword, to: passwords.user }
  const changed = ok(await changePassword({ current_password: passwords.user, new_password: temporaryPassword }, options), 'password change')
  assert.deepEqual(changed.user, me.user.user, 'password change: «Я» of the same person')
  assert.equal(ok(await getReceipts({}, options)).count, 1, 'The session that changed the password stays signed in')
  as('second')
  await expired(() => getReceipts({}, options), 'the second session after the password change')
  await guest('the second session after the password change')
  await noFile('second', mediaPaths('user')[0])
  ok(await login({ username: seed.users.user.username, password: temporaryPassword }, options), 'sign-in with the new password')
  as('user')
  ok(await changePassword({ current_password: temporaryPassword, new_password: passwords.user }, options), 'putting the password back')
  restore = undefined
  as('second')
  await guest('the second session after the password was put back')
  as('moderator')
  ok(await getMe(options), 'the session of the other person')
  pass('password: weak → 400 invalid_parameter [new_password] with password_issues, nothing changed; change → this session lives, the second one gets 401 (signal, guest, MEDIA 404), the new password signs in; the password is put back; the moderator is not affected')

  // Sign-out: the cookie is gone and the session is dead on the server, even when replayed.
  as('user')
  jars.stale = new Map(jars.user)
  assert.deepEqual(ok(await logout(options), 'sign-out'), null)
  assert.equal(requests.at(-1).status, 204)
  assert.equal(jars.user.has('sessionid'), false, 'Sign-out must delete the session cookie')
  await guest('after the sign-out')
  await expired(() => getReceipts({}, options), 'after the sign-out: GET /api/receipts/')
  await expired(() => getProducts({}, options), 'after the sign-out: GET /api/products/')
  await noFile('user', mediaPaths('user')[0])
  assert.deepEqual(ok(await logout(options), 'sign-out of a guest'), null)
  as('stale')
  await guest('a replayed cookie of the ended session')
  await expired(() => getReceipts({}, options), 'a replayed cookie of the ended session')
  as('moderator')
  assert.equal(ok(await getReceipts({}, options)).count, 1, 'The sign-out of one person does not touch the other')
  assert.deepEqual(ok(await logout(options)), null)
  await guest('the moderator after the sign-out')
  pass('sign-out → 204, cookie deleted; /api/me/ → 401, receipts and catalog → aborted + signal, MEDIA → 404; the replayed cookie is refused; the other person stays signed in until their own sign-out')

  const posts = requests.filter((request) => request.method === 'POST')
  console.log(JSON.stringify({
    result: 'passed', mode, origin: origin.origin, database: process.env.POSTGRES_DB, checks: passed,
    requests: requests.length, posts: posts.length, statuses: [...new Set(requests.map((request) => request.status))].sort(),
    foreign_receipt_id_in_any_answer: false, password_restored: true, catalog_writes: 0,
    not_covered: ['429 login_throttled (needs 5 refused sign-ins; lasts 900 s)', 'withdrawing the right in the middle of a session', 'sign-in through /admin/', 'cookies in a real browser'],
  }))
} catch (error) {
  console.error(`Accounts check FAILED: ${error.message}`)
  const last = requests.at(-1)
  if (last) console.error(`Last request: ${last.method} ${last.path} as ${last.who} → ${last.status}`)
  if (restore) {
    // The scenario stopped between the change and its undoing: one attempt to leave the demo as it was.
    let restored = false
    try {
      who = 'user'
      const options = { baseUrl: `${new URL(process.argv[3]).origin}/api` }
      clearAuthCsrf(options)
      clearRecognitionCsrf(options)
      restored = (await changePassword({ current_password: restore.from, new_password: restore.to }, options)).kind === 'ok'
    } catch { /* reported below */ }
    console.error(restored ? 'The password of demo_user was put back.'
      : `The password of demo_user may be changed: it is the value of ${USER_PASSWORD} followed by «-Tmp7q». Reseed a fresh QA database before the next run.`)
  }
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
}
console.log('browser_ui: not tested')
