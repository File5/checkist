// Mutating QA acceptance of the product-merge client through a running Vite dev/preview proxy.
// Node 24 strips the real adapters' TypeScript. No browser, no mocked fetch. Run on a fresh
// seed_product_merge_demo + `product_merges detect` database only: the scenario resolves groups.
import assert from 'node:assert/strict'
import { getProduct } from '../src/api/catalog.ts'
import { getRecognitionCsrf } from '../src/api/local.ts'
import {
  cancelProductMerge, confirmProductMerge, detectProductMerges, excludeProductMerge, getProductMerge, getProductMergeLines, getProductMerges,
} from '../src/api/product-merges.ts'

const usage = 'Usage: node frontend/scripts/check_product_merges_proxy.mjs <vite-origin, e.g. http://127.0.0.1:15173>'
const originalFetch = globalThis.fetch
const requests = []
let cookie = ''

function loopback(value, name) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:', `${name}: only HTTP loopback QA origins are allowed`)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${name}: use a loopback host`)
  assert.equal(url.href, `${url.origin}/`, `${name}: use an origin without credentials, path or query`)
  assert.ok(url.port && !['8000', '5173', '5432', '15432'].includes(url.port), `${name}: do not use dev ports`)
  return url
}
function ok(result) {
  assert.equal(result.kind, 'ok', JSON.stringify(result))
  return result.data
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
  assert.equal(process.env.CHECKIST_AUTH_MODE, 'local_single', 'This script needs a server without a sign-in: set CHECKIST_AUTH_MODE=local_single in this terminal and in the terminal of the API, then restart the API (in the accounts mode every request here answers 401; that mode is checked by check_accounts_proxy.mjs)')
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
    if (/^\/api\/(?:product-merges|recognition)\//.test(url.pathname)) {
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
  const page = await direct(origin, '/', 'text/html')
  assert.equal(page.status, 200); assert.match(page.type, /^text\/html/, 'The origin must serve the SPA: start Vite dev or preview')
  assert.match(page.body, /<div id="root">/)
  const [viaProxy, viaDjango] = [await direct(origin, '/api/product-merges/'), await direct(target, '/api/product-merges/')]
  assert.equal(viaDjango.status, 200, 'Start the QA API with DEBUG=1 and ALLOW_LOCAL_RECOGNITION_API=1')
  assert.deepEqual(viaProxy, viaDjango, 'Vite proxy and Django answer differently')

  ok(await getRecognitionCsrf(options))
  assert.match(cookie, /^csrftoken=/)
  const noToken = await originalFetch(new URL('/api/product-merges/detect/', origin), {
    method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Origin: origin.origin },
  })
  assert.equal(noToken.status, 403); assert.equal((await noToken.json()).error.code, 'csrf_failed')
  console.log('proxy = Django; CSRF cookie and token obtained; POST without a token → 403 csrf_failed')

  // List, pages and filters.
  const all = ok(await getProductMerges({}, options))
  const pending = ok(await getProductMerges({ status: 'pending' }, options))
  assert.equal(all.count, 7, 'Use a fresh QA database: migrate, seed_product_merge_demo, product_merges detect')
  assert.equal(pending.count, all.count, 'Every demo group must still be pending: the scenario runs once per database')
  assert.deepEqual(pending, all)
  assert.deepEqual(all.results.map((group) => group.id), all.results.map((group) => group.id).sort((a, b) => b - a), 'The list is ordered by -id')
  for (const status of ['confirmed', 'cancelled']) assert.equal(ok(await getProductMerges({ status }, options)).count, 0)
  const second = ok(await getProductMerges({ page: 2, page_size: 3 }, options))
  assert.deepEqual([second.pages, second.results.length], [3, 3])
  assert.deepEqual(second.results, all.results.slice(3, 6))
  fails(await getProductMerges({ page: 99 }, options), 'page_out_of_range', 404)
  fails(await getProductMerges({ status: 'merged' }, options), 'invalid_parameter', 400, ['status'])
  fails(await getProductMerge(999_999, options), 'not_found', 404)
  assert.deepEqual(ok(await detectProductMerges(options)), { created: 0, extended: 0, group_ids: [] }, 'A repeated detect changes nothing')

  const conflicting = all.results.filter((group) => group.has_conflicts)
  assert.equal(conflicting.length, 1, 'The demo has exactly one group with a conflict (milk)')
  const calm = all.results.filter((group) => !group.has_conflicts).sort((a, b) => a.id - b.id)
  const toCancel = calm.find((group) => group.members.length === 3)
  const toConfirm = calm.find((group) => group.members.length === 2)
  const toExclude = calm.findLast((group) => group.members.length === 3)
  assert.ok(toCancel && toConfirm && toExclude && toCancel.id !== toExclude.id, 'Unexpected demo groups')
  const sourcesOf = (group) => group.members.filter((member) => member.role === 'source').map((member) => member.product_id)

  // Group, purchases, catalog visibility of an absorbed product.
  const group = ok(await getProductMerge(toCancel.id, options))
  assert.deepEqual(group.members.map(({ aliases: _aliases, ...member }) => member), toCancel.members, 'The list and the group describe the same records')
  assert.ok(group.members.every((member) => member.aliases.length > 0 && member.exists && member.state === 'active'))
  const purchases = ok(await getProductMergeLines(group.id, {}, options))
  assert.equal(purchases.count, group.lines_count)
  assert.equal(purchases.count, group.members.reduce((sum, member) => sum + member.lines_count, 0) + group.new_lines_count)
  const memberIds = group.members.map((member) => member.product_id)
  assert.ok(purchases.results.every((line) => line.origin_product_id === null || memberIds.includes(line.origin_product_id)))
  assert.deepEqual(ok(await getProductMergeLines(group.id, { page: 2, page_size: 1 }, options)).results, purchases.results.slice(1, 2))
  const absorbed = sourcesOf(group)
  for (const id of absorbed) {
    fails(await getProduct(id, options), 'not_found', 404)
    assert.deepEqual(ok(await getProductMerges({ product: id }, options)).results.map((item) => item.id), [group.id])
  }
  assert.equal(ok(await getProduct(group.target_product_id, options)).id, group.target_product_id)
  console.log(`list 7 pending, pages, filters; group ${group.id} (${memberIds.join(', ')}) with ${purchases.count} purchases; absorbed ${absorbed.join(', ')} → 404 in /api/products/{id}/`)

  // Cancel one group and repeat.
  const cancelled = ok(await cancelProductMerge(group.id, options))
  assert.equal(requests.at(-1).body, '{}')
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.version, group.version); assert.equal(cancelled.lines_count, 0)
  assert.ok(cancelled.members.every((member) => member.lines_count === 0 && member.aliases.length === 0))
  assert.deepEqual(ok(await cancelProductMerge(group.id, options)), cancelled, 'A repeated cancel answers 200 with the same group')
  assert.deepEqual(ok(await getProductMerge(group.id, options)), cancelled)
  assert.equal(ok(await getProductMergeLines(group.id, {}, options)).count, 0)
  for (const id of memberIds) assert.equal(ok(await getProduct(id, options)).id, id, 'Cancelled records are visible again')
  fails(await confirmProductMerge(group.id, { version: cancelled.version, target_product_id: cancelled.target_product_id }, options), 'merge_resolved', 409)
  fails(await excludeProductMerge(group.id, { version: cancelled.version, product_id: absorbed[0] }, options), 'merge_resolved', 409)
  console.log(`group ${group.id}: cancel → cancelled, repeat 200, products ${memberIds.join(', ')} visible; confirm/exclude → 409 merge_resolved`)

  // Confirm another group and repeat.
  const before = ok(await getProductMerge(toConfirm.id, options))
  const [gone] = sourcesOf(before)
  const input = { version: before.version, target_product_id: before.target_product_id }
  fails(await confirmProductMerge(before.id, { ...input, version: before.version + 1 }, options), 'merge_changed', 409)
  fails(await confirmProductMerge(before.id, { ...input, target_product_id: 999_999 }, options), 'invalid_parameter', 400, ['target_product_id'])
  fails(await confirmProductMerge(before.id, { ...input, name_product_id: 999_999 }, options), 'invalid_parameter', 400, ['name_product_id'])
  assert.deepEqual(ok(await getProductMerge(before.id, options)), before, 'Rejected requests saved nothing')
  const confirmed = ok(await confirmProductMerge(before.id, input, options))
  assert.equal(requests.at(-1).body, JSON.stringify(input))
  assert.equal(confirmed.status, 'confirmed'); assert.equal(confirmed.new_lines_count, 0)
  assert.equal(confirmed.members.find((member) => member.product_id === gone).exists, false)
  assert.deepEqual(ok(await confirmProductMerge(before.id, input, options)), confirmed, 'A repeated confirm answers 200 with the same group')
  assert.deepEqual(ok(await confirmProductMerge(before.id, { ...input, version: input.version + 5 }, options)), confirmed, 'A repeat ignores a stale version')
  fails(await confirmProductMerge(before.id, { ...input, target_product_id: gone }, options), 'merge_resolved', 409)
  fails(await cancelProductMerge(before.id, options), 'merge_resolved', 409)
  fails(await getProduct(gone, options), 'not_found', 404)
  assert.deepEqual(ok(await getProductMerges({ product: gone }, options)).results.map((item) => item.id), [before.id])
  assert.equal(ok(await getProductMergeLines(before.id, {}, options)).count, confirmed.lines_count)
  console.log(`group ${before.id}: stale version → 409 merge_changed; confirm → confirmed, repeat 200; other target/cancel → 409 merge_resolved; product ${gone} → 404`)

  // The milk conflict: refused without resolutions, confirmed with them.
  const milk = ok(await getProductMerge(conflicting[0].id, options))
  assert.deepEqual(milk.conflicts.map((conflict) => conflict.field), ['generic'])
  const winner = milk.conflicts[0].product_ids[0]
  const milkInput = { version: milk.version, target_product_id: milk.target_product_id }
  fails(await confirmProductMerge(milk.id, milkInput, options), 'merge_conflict', 409, ['generic'])
  assert.deepEqual(ok(await getProductMerge(milk.id, options)), milk, 'A conflict saved nothing')
  fails(await confirmProductMerge(milk.id, { ...milkInput, resolutions: { brand: winner } }, options), 'invalid_parameter', 400, ['resolutions.brand'])
  const resolved = ok(await confirmProductMerge(milk.id, { ...milkInput, resolutions: { generic: winner } }, options))
  assert.equal(requests.at(-1).body, JSON.stringify({ ...milkInput, resolutions: { generic: winner } }))
  assert.equal(resolved.status, 'confirmed'); assert.deepEqual(resolved.conflicts, [])
  const generic = milk.members.find((member) => member.product_id === winner).generic
  assert.deepEqual(ok(await getProduct(milk.target_product_id, options)).generic, generic, 'The kept product takes the chosen value')
  for (const id of sourcesOf(milk)) fails(await getProduct(id, options), 'not_found', 404)
  console.log(`group ${milk.id}: confirm without resolutions → 409 merge_conflict [generic]; with resolutions.generic=${winner} → confirmed, generic «${generic.name}»`)

  // Exclude one record and repeat.
  const wide = ok(await getProductMerge(toExclude.id, options))
  const excludedId = sourcesOf(wide).at(-1)
  fails(await getProduct(excludedId, options), 'not_found', 404)
  const narrowed = ok(await excludeProductMerge(wide.id, { version: wide.version, product_id: excludedId }, options))
  assert.equal(requests.at(-1).body, JSON.stringify({ version: wide.version, product_id: excludedId }))
  assert.equal(narrowed.status, 'pending'); assert.equal(narrowed.version, wide.version + 1)
  const excluded = narrowed.members.find((member) => member.product_id === excludedId)
  assert.deepEqual([excluded.state, excluded.lines_count, excluded.aliases.length], ['excluded', 0, 0])
  assert.deepEqual(ok(await excludeProductMerge(wide.id, { version: wide.version, product_id: excludedId }, options)), narrowed, 'A repeated exclude answers 200')
  assert.equal(ok(await getProduct(excludedId, options)).id, excludedId)
  fails(await excludeProductMerge(wide.id, { version: wide.version, product_id: wide.target_product_id }, options), 'merge_changed', 409)
  console.log(`group ${wide.id}: exclude ${excludedId} → pending, version ${narrowed.version}, repeat 200; stale version → 409 merge_changed`)

  const counts = {}
  for (const status of ['pending', 'confirmed', 'cancelled']) counts[status] = ok(await getProductMerges({ status }, options)).count
  assert.deepEqual(counts, { pending: 4, confirmed: 2, cancelled: 1 })
  const posts = requests.filter((request) => request.method === 'POST')
  console.log(JSON.stringify({ result: 'passed', origin: origin.origin, database: process.env.POSTGRES_DB, groups: counts,
    requests: requests.length, posts: posts.length, statuses: [...new Set(requests.map((request) => request.status))].sort(), browser_ui: 'not tested' }))
} catch (error) {
  console.error(`Product merge check FAILED: ${error.message}`)
  const last = requests.at(-1)
  if (last) console.error(`Last request: ${last.method} ${last.path} → ${last.status}${last.body ? ` ${last.body}` : ''}`)
  process.exitCode = 1
} finally {
  globalThis.fetch = originalFetch
}
