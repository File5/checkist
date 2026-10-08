// Read-only QA acceptance of the statistics client: real fetch through the client adapters, straight to Django
// and through a running Vite dev/preview proxy. Node 24 strips the real adapters' TypeScript. No browser, no mocked fetch.
// Needs a fresh `migrate` + `seed_stats_demo` database: the answers are compared with the backend's example files.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { getProductPriceSeries } from '../src/api/price-series.ts'
import { getReceiptCompare, getReceiptSeries, getSpending } from '../src/api/stats.ts'
import { blockTail } from '../src/features/stats/spending-tail.ts'

const usage = 'Usage: node frontend/scripts/check_stats_proxy.mjs dev|preview <vite-origin, e.g. http://127.0.0.1:15173>'
const fixtureDir = new URL('../../backend/api/tests/fixtures/stats/', import.meta.url)
const fixture = (name) => JSON.parse(readFileSync(new URL(name, fixtureDir), 'utf8'))
// Ids of a fresh demo database (docs/api-contract.md): category «Продукты питания», generic «Молоко», products, stores.
const FOOD = 1, MILK_GENERIC = 1, MILK = 1, APPLES = 6, COOKIES = 11
// What the screen asks for the composition of «Прочее» (`spendingTailLimit` of the client); the server accepts 1–500.
const TAIL_LIMIT = 500
const periods = { base_from: '2020-01-01', base_to: '2020-12-31', current_from: '2026-01-01', current_to: '2026-09-30' }
let passed = 0

function loopback(value, name) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:', `${name}: only HTTP loopback QA origins are allowed`)
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), `${name}: use a loopback host`)
  assert.equal(url.href, `${url.origin}/`, `${name}: use an origin without credentials, path or query`)
  assert.ok(url.port && !['8000', '5173', '5432', '15432'].includes(url.port), `${name}: do not use dev ports`)
  return url.origin
}
/** Exact decimal arithmetic: a wire decimal as an integer of ten-thousandths. */
function units(value) {
  const parts = /^(-?)(\d+)(?:\.(\d{1,4}))?$/.exec(value)
  assert.ok(parts, `Not a decimal with at most 4 places: ${JSON.stringify(value)}`)
  return (parts[1] ? -1n : 1n) * (BigInt(parts[2]) * 10_000n + BigInt((parts[3] ?? '').padEnd(4, '0')))
}
const sum = (values) => values.reduce((total, value) => total + units(value), 0n)

/** `Σ items + other = lines_paid`; `lines_paid + difference = receipts_total`; no share for an amount ≤ 0. */
function spendingIdentities(body, label) {
  for (const { currency, totals, items, other } of body.currencies) {
    const parts = [...items, ...(other ? [other] : [])]
    assert.equal(sum(parts.map((part) => part.amount)), units(totals.lines_paid), `${label} ${currency}: Σ items + other ≠ lines_paid`)
    if (totals.receipts_total === null) assert.equal(totals.difference, null, `${label} ${currency}: difference without receipts_total`)
    else assert.equal(units(totals.lines_paid) + units(totals.difference), units(totals.receipts_total), `${label} ${currency}: lines_paid + difference ≠ receipts_total`)
    for (const part of parts) assert.equal(part.share_percent === null, units(part.amount) <= 0n, `${label} ${currency}: share of ${part.amount}`)
  }
}
/**
 * The usual answer (the server default of regular items) and the long one of the same request: the first items are
 * the same, and the regular items after them plus the remainder are exactly «прочее» of the usual answer —
 * by the count and, in exact decimals, by the amount. The client's own `blockTail` must read the pair the same way.
 * Returns how many blocks had «прочее».
 */
function tailIdentities(short, long, label) {
  assert.deepEqual(long.currencies.map((block) => block.currency), short.currencies.map((block) => block.currency), `${label}: currencies of the two answers differ`)
  let opened = 0
  for (const [index, block] of short.currencies.entries()) {
    const full = long.currencies[index]
    const name = `${label} ${block.currency}`
    const regular = (items) => items.filter((item) => item.id !== null)
    // Shares are left out: their base differs between the answers when «прочее» holds an item that is not positive.
    const bare = (items) => items.map((item) => ({ ...item, share_percent: null }))
    const head = regular(block.items), all = regular(full.items)
    assert.deepEqual(full.totals, block.totals, `${name}: totals of the two answers differ`)
    assert.deepEqual(bare(all.slice(0, head.length)), bare(head), `${name}: the first ${head.length} items of the two answers differ`)
    assert.deepEqual(bare(full.items.filter((item) => item.id === null)), bare(block.items.filter((item) => item.id === null)), `${name}: special rows of the two answers differ`)
    const tail = blockTail(block, full)
    if (block.other === null) {
      assert.deepEqual([full.other, all.length, tail], [null, head.length, undefined], `${name}: no «прочее» in the usual answer, but the long one is longer`)
      continue
    }
    opened++
    const rest = all.slice(head.length)
    assert.ok(rest.length > 0, `${name}: limit=${TAIL_LIMIT} added no items to the ${head.length} of the usual answer`)
    assert.equal(rest.length + (full.other?.count ?? 0), block.other.count, `${name}: items of the composition + remainder ≠ other.count`)
    assert.equal(sum([...rest, ...(full.other ? [full.other] : [])].map((part) => part.amount)), units(block.other.amount), `${name}: Σ composition + remainder ≠ other.amount`)
    assert.equal(tail?.kind, 'ok', `${name}: the client refused the pair of answers`)
    assert.deepEqual([tail.items, tail.rest], [rest, full.other], `${name}: the client cut another composition`)
    // With the whole composition in sight and every item of it positive, both answers count shares from one base.
    if (full.other === null && rest.every((item) => units(item.amount) > 0n)) {
      assert.equal(tail.sharesDiffer, false, `${name}: shares of the first items differ between the two answers`)
    }
  }
  return opened
}
/** `quantity + price + mix = change.avg_receipt`; without a price index only `quantity + price_per_line`. */
function compareIdentities(body, label) {
  for (const { currency, base, current, change, effects, price_index: index, products, products_total: total } of body.currencies) {
    if (change.avg_receipt !== null) assert.equal(units(current.avg_receipt) - units(base.avg_receipt), units(change.avg_receipt), `${label} ${currency}: change ≠ current − base`)
    if (effects === null) continue
    assert.equal(units(effects.quantity) + units(effects.price_per_line), units(change.avg_receipt), `${label} ${currency}: quantity + price_per_line ≠ change`)
    if (index === null) {
      assert.deepEqual([effects.price, effects.mix, products, total], [null, null, [], 0], `${label} ${currency}: price and mix without an index`)
    } else {
      assert.equal(sum([effects.quantity, effects.price, effects.mix]), units(change.avg_receipt), `${label} ${currency}: quantity + price + mix ≠ change`)
      assert.equal(units(effects.price) + units(effects.mix), units(effects.price_per_line), `${label} ${currency}: price + mix ≠ price_per_line`)
      assert.equal(index.matched_products, total, `${label} ${currency}: matched products`)
    }
  }
}
/** Own series first, then similar ones without a store; `observations = Σ points.count`. */
function priceSeriesIdentities(body, label) {
  const roles = body.series.map((line) => line.role)
  assert.deepEqual(roles, [...roles].sort(), `${label}: own series must come first`)
  for (const line of body.series) {
    assert.equal(line.store === null, line.role === 'similar', `${label}: store of a ${line.role} series`)
    assert.equal(line.points.reduce((count, point) => count + point.count, 0), line.observations, `${label}: observations ≠ Σ points.count`)
    for (const point of line.points) assert.ok(units(point.min) <= units(point.avg) && units(point.avg) <= units(point.max), `${label}: min ≤ avg ≤ max`)
  }
}

async function main() {
  const [mode, viteOrigin] = process.argv.slice(2)
  assert.ok(process.argv.length === 4 && ['dev', 'preview'].includes(mode), usage)
  assert.match(process.env.POSTGRES_DB ?? '', /^checkist_qa(?:_[a-zA-Z0-9]+)*$/, 'Apply the full QA environment first: POSTGRES_DB must be checkist_qa or checkist_qa_<suffix>')
  assert.equal(process.env.VITE_API_BASE_URL, '/api', 'QA must use the /api prefix')
  assert.equal(process.env.CHECKIST_AUTH_MODE, 'local_single', 'This script needs a server without a sign-in: set CHECKIST_AUTH_MODE=local_single in this terminal and in the terminal of the API, then restart the API (in the accounts mode every request here answers 401; that mode is checked by check_accounts_proxy.mjs)')
  const direct = loopback(process.env.DEV_API_PROXY_TARGET, 'DEV_API_PROXY_TARGET')
  const proxy = loopback(viteOrigin, 'Vite origin')
  assert.notEqual(direct, proxy, 'API and Vite proxy must be separate origins')
  const origins = [direct, proxy]

  const text = async (url) => {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) }).catch(() => {
      throw new Error(`GET ${url}: unavailable; start the QA API and Vite, then check their addresses`)
    })
    assert.equal(response.status, 200, `GET ${url}: HTTP ${response.status}`)
    return response.text()
  }
  // The origin must be Vite in the named mode, and what it serves must contain the statistics client.
  const page = await text(new URL('/', proxy))
  assert.match(page, /<div id="root">/, 'The origin must serve the SPA: start Vite dev or preview')
  assert.equal(page.includes('/@vite/client'), mode === 'dev', `The origin does not look like Vite ${mode}`)
  const script = mode === 'dev' ? '/src/api/stats.ts' : /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(page)?.[1]
  assert.ok(script, 'The built page names no script: run npm.cmd run build before preview')
  assert.match(await text(new URL(script, proxy)), /stats\/spending\//, `${script}: the statistics adapters are missing`)
  console.log(`PASS ${proxy} is Vite ${mode} and serves the statistics client (${script})`)

  async function http(origin, path, params, status) {
    const url = new URL(`/api/${path}`, origin)
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
    let response
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(15_000),
      })
      assert.equal(response.status, status, `expected HTTP ${status}, received ${response.status}`)
      assert.equal(response.headers.get('content-type'), 'application/json', 'expected JSON')
      assert.equal(response.headers.get('allow'), 'GET, HEAD, OPTIONS', 'unexpected Allow')
      if (path.startsWith('stats/')) assert.equal(response.headers.get('cache-control'), 'no-store', 'expected Cache-Control: no-store')
      return await response.json()
    } catch (error) {
      throw new Error(`GET ${url}: ${response ? error.message : 'API/proxy unavailable or request timed out; start the QA API and Vite, then check their addresses'}`)
    }
  }
  // Independent HTTP on both origins, then the real adapter on both; `params` are what the adapter is expected to send.
  async function check(path, params, adapter, expected = {}) {
    const status = expected.status ?? 200
    const bodies = []
    for (const origin of origins) bodies.push(await http(origin, path, params, status))
    assert.deepEqual(bodies[1], bodies[0], `${path}: direct/proxy JSON differs`)
    const search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]))
    const label = `GET /api/${path}${search.size ? `?${search}` : ''}`
    for (const origin of origins) {
      const result = await adapter({ baseUrl: `${origin}/api` })
      if (status === 200) {
        assert.deepEqual(result, { kind: 'ok', data: bodies[0] }, `${label}: the adapter rejected or changed the HTTP response: ${JSON.stringify(result).slice(0, 200)}`)
      } else {
        assert.equal(bodies[0].error.code, expected.reason, `${label}: unexpected backend error code`)
        const fields = bodies[0].error.fields ? Object.keys(bodies[0].error.fields) : undefined
        assert.deepEqual(result, { kind: 'error', reason: expected.reason, status, ...(fields && { fields }) }, `${label}: adapter failure`)
        if (expected.fields) assert.deepEqual(fields, expected.fields, `${label}: rejected fields`)
      }
    }
    if (expected.file) {
      assert.deepEqual(bodies[0], fixture(expected.file), `${label}: differs from ${expected.file}; use a fresh QA database: migrate, then seed_stats_demo`)
    }
    passed++
    console.log(`PASS ${label}: HTTP ${status}, direct = proxy = real adapter${expected.file ? ` = ${expected.file}` : ''}`)
    return bodies[0]
  }
  const spending = async (params, file) => {
    const body = await check('stats/spending/', params, (options) => getSpending(params, options), { file })
    spendingIdentities(body, `spending ${JSON.stringify(params)}`)
    return body
  }
  const series = (params, file) => check('stats/receipts/series/', params, (options) => getReceiptSeries(params, options), { file })
  const compare = async (params, file) => {
    const body = await check('stats/receipts/compare/', params, (options) => getReceiptCompare(params, options), { file })
    compareIdentities(body, `compare ${JSON.stringify(params)}`)
    return body
  }
  const prices = async (id, params, file) => {
    // The adapter sends countries as one value; nothing here needs more than the plain parameters.
    const body = await check(`products/${id}/prices/series/`, params, (options) => getProductPriceSeries(id, params, options), { file })
    priceSeriesIdentities(body, `prices ${id} ${JSON.stringify(params)}`)
    return body
  }

  // Spending: every grouping, drill-down, the category filter under another grouping, special shapes.
  const root = await spending({}, 'spending-category.json')
  assert.deepEqual(root.currencies.map((block) => block.currency), ['EUR', 'KZT'], 'One block per currency, never added together')
  assert.equal(root.parent, null)
  const drilldown = await spending({ category: FOOD, currency: 'EUR' }, 'spending-category-drilldown.json')
  assert.equal(drilldown.parent.id, FOOD)
  const underCategory = await spending({ category: FOOD, group_by: 'generic', currency: 'EUR' }, 'spending-category-generic.json')
  assert.deepEqual(underCategory.parent, drilldown.parent, 'The category of the filter is named in `parent` under any grouping')
  assert.equal(underCategory.group_by, 'generic')
  assert.ok(underCategory.currencies[0].items.length > 0 && underCategory.currencies[0].items.every((item) => item.kind === 'generic'))
  assert.equal(underCategory.currencies[0].totals.lines_paid, drilldown.currencies[0].totals.lines_paid, 'Same filter, same paid lines under both groupings')
  await spending({ group_by: 'generic', currency: 'EUR', limit: 5 }, 'spending-generic.json')
  await spending({ group_by: 'product', limit: 3, date_from: '2026-01-01', date_to: '2026-09-30' }, 'spending-product.json')
  await spending({ group_by: 'store' }, 'spending-store.json')
  await spending({ generic: MILK_GENERIC, group_by: 'product' }, 'spending-generic-filter.json')
  await spending({ date_from: '2026-03-14', date_to: '2026-03-14' }, 'spending-refund-day.json')
  assert.deepEqual((await spending({ date_from: '2018-01-01', date_to: '2018-12-31' }, 'spending-empty.json')).currencies, [])
  // The same lines cut differently give the same totals; a store is worth the sum of its receipts.
  const groupings = []
  for (const group_by of ['category', 'generic', 'product', 'store']) groupings.push((await spending({ group_by, currency: 'EUR', limit: 50 })).currencies[0].totals)
  const [byCategory, byGeneric, byProduct, byStore] = groupings
  assert.deepEqual([byGeneric, byProduct], [byCategory, byCategory], 'Groupings of one filter disagree in totals')
  assert.deepEqual(byStore, { ...byCategory, lines_paid: byCategory.receipts_total, difference: '0.00' }, 'Stores must add up to the receipts')
  // Composition of «Прочее»: the pair the screen asks with `other=open`. On the demo «прочее» exists for generic products
  // (EUR) and products (EUR and KZT); categories and stores have none in either answer.
  const tails = {}
  for (const currency of ['EUR', 'KZT']) {
    for (const group_by of ['category', 'generic', 'product', 'store']) {
      const short = await spending({ group_by, currency })
      const long = await spending({ group_by, currency, limit: TAIL_LIMIT })
      tails[`${group_by}/${currency}`] = tailIdentities(short, long, `tail ${group_by} ${currency}`)
    }
  }
  assert.deepEqual(
    [tails['category/EUR'], tails['store/EUR'], tails['category/KZT'], tails['store/KZT'], tails['generic/EUR'], tails['product/EUR'], tails['product/KZT']],
    [0, 0, 0, 0, 1, 1, 1], `«Прочее» of the demo is not where it is expected (${JSON.stringify(tails)}); use a fresh QA database: migrate, then seed_stats_demo`)
  // The refusal above the limit is the server's: the adapter does not check the upper bound.
  await check('stats/spending/', { limit: TAIL_LIMIT + 1 }, (options) => getSpending({ limit: TAIL_LIMIT + 1 }, options),
    { status: 400, reason: 'invalid_parameter', fields: ['limit'] })
  const stores = await check('stats/spending/', { store: '1,3', group_by: 'store', limit: 1 }, (options) => getSpending({ group_by: 'store', store: [1, 3], limit: 1 }, options))
  spendingIdentities(stores, 'spending store=1,3')
  assert.deepEqual(stores.currencies.map((block) => block.items.map((item) => item.id)), [[1], [3]], 'store=1,3 keeps one store per currency')

  // Visits over time.
  const years = await series({ interval: 'year' }, 'series-year.json')
  await series({ currency: 'EUR', date_from: '2026-01-01', date_to: '2026-09-30' }, 'series-month.json')
  assert.deepEqual((await series({ date_to: '2018-12-31' }, 'series-empty.json')).currencies, [])
  for (const interval of ['week', 'quarter']) {
    const body = await series({ interval, currency: 'EUR', date_from: '2026-01-01', date_to: '2026-09-30' })
    assert.equal(body.interval, interval)
    assert.ok(body.currencies[0].buckets.length > 0)
  }

  // Why the average receipt grew: the main question of the demo.
  const main = await compare({ ...periods, limit: 5 }, 'compare-2020-2026.json')
  const eur = main.currencies.find((block) => block.currency === 'EUR')
  assert.deepEqual(
    [eur.base.avg_receipt, eur.current.avg_receipt, eur.change.avg_receipt, eur.effects.quantity, eur.effects.price, eur.effects.mix, eur.price_index.fisher],
    ['27.01', '45.72', '18.71', '8.65', '7.39', '2.67', '1.2404'], 'Demo numbers of the main question changed')
  const year2020 = years.currencies.find((block) => block.currency === 'EUR').buckets.find((bucket) => bucket.period_start === '2020-01-01')
  assert.deepEqual([year2020.receipts_count, year2020.total, year2020.avg_receipt], [eur.base.receipts_count, eur.base.total, eur.base.avg_receipt],
    'The 2020 bucket of the series and the base side of the comparison disagree')
  await compare({ base_from: '2020-01-04', base_to: '2020-01-04', current_from: '2026-02-18', current_to: '2026-02-18', currency: 'EUR' }, 'compare-no-matched-products.json')
  await compare({ base_from: '2018-01-01', base_to: '2018-12-31', current_from: '2026-09-01', current_to: '2026-09-30', currency: 'KZT' }, 'compare-one-sided.json')
  await compare({ base_from: '2017-01-01', base_to: '2017-12-31', current_from: '2018-01-01', current_to: '2018-12-31' }, 'compare-empty.json')
  compareIdentities(await check('stats/receipts/compare/', { ...periods, store: 1 }, (options) => getReceiptCompare({ ...periods, store: [1] }, options)), 'compare store=1')

  // Price series of a product: open like the catalog.
  const milk = await prices(MILK, { date_from: '2025-01-01' }, 'price-series-milk-paid.json')
  assert.deepEqual([...new Set(milk.series.map((line) => `${line.country}/${line.currency}`))].sort(), ['DE/EUR', 'KZ/KZT'], '«Молоко» must have DE/EUR and KZ/KZT series')
  assert.equal(milk.similar.status, 'ok')
  await prices(MILK, { price: 'normalized', date_from: '2025-01-01' }, 'price-series-milk-normalized.json')
  await prices(APPLES, { price: 'normalized', date_from: '2026-01-01' }, 'price-series-apples-normalized.json')
  await prices(COOKIES, { date_from: '2026-01-01' }, 'price-series-unassigned.json')
  await prices(MILK, { similar: 'none', interval: 'week', date_from: '2026-09-01' }, 'price-series-similar-none.json')
  await prices(MILK, { date_to: '2018-12-31' }, 'price-series-empty.json')
  const german = await check(`products/${MILK}/prices/series/`, { country: 'DE', interval: 'day', similar_limit: 1 },
    (options) => getProductPriceSeries(MILK, { country: ['DE'], interval: 'day', similar_limit: 1 }, options))
  assert.ok(german.series.length > 0 && german.series.every((line) => line.country === 'DE'))

  // Refusals. Ids and limits the adapter refuses locally (category=x, limit=0) never reach the server and are not sent here.
  const bad = { date_from: '2026-13-01', country: 'de1', currency: 'E', store: 99, group_by: 'brand' }
  await check('stats/spending/', bad, (options) => getSpending({ ...bad, store: [99] }, options),
    { status: 400, reason: 'invalid_parameter', fields: ['date_from', 'country', 'currency', 'store', 'group_by'] })
  await check('stats/receipts/series/', { interval: 'day' }, (options) => getReceiptSeries({ interval: 'day' }, options),
    { status: 400, reason: 'invalid_parameter', fields: ['interval'] })
  await check('stats/receipts/compare/', {}, (options) => getReceiptCompare({ base_from: '', base_to: '', current_from: '', current_to: '' }, options),
    { status: 400, reason: 'invalid_parameter', fields: ['base_from', 'base_to', 'current_from', 'current_to'], file: 'error-required-parameter.json' })
  const overlap = { ...periods, base_to: '2026-01-01' }
  await check('stats/receipts/compare/', overlap, (options) => getReceiptCompare(overlap, options),
    { status: 400, reason: 'invalid_parameter', fields: ['current_from'], file: 'error-periods-overlap.json' })
  await check(`products/${MILK}/prices/series/`, { interval: 'year' }, (options) => getProductPriceSeries(MILK, { interval: 'year' }, options),
    { status: 400, reason: 'invalid_parameter', fields: ['interval'] })
  await check('products/999999/prices/series/', {}, (options) => getProductPriceSeries(999_999, {}, options),
    { status: 404, reason: 'not_found', file: 'error-not-found.json' })

  console.log(JSON.stringify({
    result: 'passed', mode, proxy, direct, database: process.env.POSTGRES_DB, checks: passed, writes: 0,
    not_covered: ['403 permission_denied (needs a server with ALLOW_LOCAL_RECOGNITION_API=0)', '400 range_too_large (not reachable on the demo)', '503'],
  }))
}

try {
  await main()
} catch (error) {
  console.error(`Statistics check FAILED: ${error.message}`)
  process.exitCode = 1
}
console.log('browser_ui: not tested')
