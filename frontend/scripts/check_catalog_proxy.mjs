// Node 24 strips the real adapters' TypeScript. No browser or mocked fetch.
import assert from 'node:assert/strict'
import { getCategories, getCategory, getGenericProduct, getGenericProducts, getProduct, getProducts } from '../src/api/catalog.ts'
import { getProductPrices, getProductPriceSummary } from '../src/api/prices.ts'
import { getStores } from '../src/api/stores.ts'

function localOrigin(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:', 'Use an HTTP loopback origin')
  assert.equal(url.hostname, '127.0.0.1', 'Use 127.0.0.1')
  assert.equal(url.href, `${url.origin}/`, 'Use an origin without credentials, path or query')
  return url.origin
}

async function main() {
  const [state = 'healthy', proxyOrigin = 'http://127.0.0.1:15173'] = process.argv.slice(2)
  assert.equal(state, 'healthy', 'Usage: node frontend/scripts/check_catalog_proxy.mjs [healthy] [proxy-origin]')
  assert.ok(process.argv.length <= 4, 'Too many arguments')
  assert.equal(process.env.POSTGRES_DB, 'checkist_qa', 'Apply the full QA environment first')
  assert.equal(process.env.VITE_API_BASE_URL, '/api', 'QA must use the /api prefix')
  const origins = [localOrigin(process.env.DEV_API_PROXY_TARGET), localOrigin(proxyOrigin)]
  assert.notEqual(origins[0], origins[1], 'API and Vite proxy must be separate origins')

  async function http(origin, path, params, status) {
    const url = new URL(`/api/${path}`, origin)
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value))
    }
    let response
    let body
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store',
        redirect: 'error', signal: AbortSignal.timeout(15_000),
      })
      assert.equal(response.status, status, `GET ${url}: expected HTTP ${status}, received ${response.status}`)
      assert.equal(response.headers.get('content-type'), 'application/json', `GET ${url}: expected JSON`)
      assert.equal(response.headers.get('allow'), 'GET, HEAD, OPTIONS', `GET ${url}: unexpected Allow`)
      body = await response.json()
    } catch (error) {
      throw new Error(`GET ${url}: ${response ? error.message : 'API/proxy unavailable or request timed out; start the QA API and Vite, then check their addresses'}`)
    }
    return body
  }

  // Compare independent HTTP requests, then the actual adapters on both origins.
  async function check(path, params, adapter, expected = { status: 200 }) {
    const bodies = await Promise.all(origins.map((origin) => http(origin, path, params, expected.status)))
    assert.deepEqual(bodies[1], bodies[0], `${path}: direct/proxy JSON differs; keep QA data unchanged during the run`)
    const results = await Promise.all(origins.map((origin) => adapter({ baseUrl: `${origin}/api` })))
    for (const result of results) {
      if (expected.status === 200) {
        assert.deepEqual(result, { kind: 'ok', data: bodies[0] }, `${path}: adapter rejected or changed the HTTP response`)
      } else {
        assert.equal(bodies[0].error.code, expected.reason, `${path}: unexpected backend error code`)
        assert.equal(typeof bodies[0].error.message, 'string')
        const fields = bodies[0].error.fields ? Object.keys(bodies[0].error.fields) : undefined
        assert.deepEqual(result, { kind: 'error', reason: expected.reason, status: expected.status, ...(fields && { fields }) })
        if (expected.field) assert.ok(fields?.includes(expected.field), `${path}: missing error field ${expected.field}`)
      }
    }
    const search = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, typeof value === 'boolean' ? (value ? '1' : '0') : String(value)]))
    console.log(`PASS GET /api/${path}${search.size ? `?${search}` : ''}: HTTP ${expected.status}, direct = proxy = real adapter`)
    return bodies[0]
  }

  function twoPages(first, second, key, label) {
    assert.equal(first.page, 1)
    assert.equal(second.page, 2)
    assert.equal(first.page_size, 1)
    assert.equal(second.page_size, 1)
    assert.equal(first.count, second.count, `${label}: QA data changed during the run`)
    assert.equal(first.pages, second.pages)
    assert.equal(first.results.length, 1)
    assert.equal(second.results.length, 1)
    assert.notEqual(key(first.results[0]), key(second.results[0]), `${label}: pages repeat the same row`)
  }

  const categories = await check('categories/', {}, (options) => getCategories({}, options))
  assert.ok(categories.results.length, 'QA needs categories; load the synthetic samples in a fresh QA database')
  const listParams = { ordering: 'name', page: 1, page_size: 1 }
  const first = await check('products/', listParams, (options) => getProducts(listParams, options))
  assert.ok(first.count >= 2, 'QA needs at least two products for page_size=1')
  const secondParams = { ...listParams, page: 2 }
  const second = await check('products/', secondParams, (options) => getProducts(secondParams, options))
  twoPages(first, second, (row) => row.id, 'products')

  // Find a product with two observations using API metadata, without fixed IDs.
  let product
  for (let page = 1; !product; page++) {
    const params = { has_prices: true, ordering: 'name', page, page_size: 50 }
    const observed = await check('products/', params, (options) => getProducts(params, options))
    product = observed.results.find((item) => item.prices.reduce((count, group) => count + group.observations, 0) >= 2)
    if (page >= observed.pages) break
  }
  assert.ok(product, 'QA needs one product with at least two purchases for history pagination')
  const detail = await check(`products/${product.id}/`, {}, (options) => getProduct(product.id, options))
  assert.equal(detail.id, product.id)
  assert.ok(categories.results.some((category) => category.id === detail.category.id), 'Product category is missing from the tree')
  const category = await check(`categories/${detail.category.id}/`, {}, (options) => getCategory(detail.category.id, options))
  assert.equal(category.id, detail.category.id)
  const categoryParams = { category: category.id, generic: detail.generic.id, page_size: 1 }
  const branch = await check('products/', categoryParams, (options) => getProducts(categoryParams, options))
  assert.ok(branch.count > 0)
  assert.ok(branch.results.every((item) => item.category.path.some((node) => node.id === category.id) && item.generic.id === detail.generic.id))
  const genericParams = { category: category.id, page_size: 1 }
  await check('generic-products/', genericParams, (options) => getGenericProducts(genericParams, options))
  await check(`generic-products/${detail.generic.id}/`, {}, (options) => getGenericProduct(detail.generic.id, options))
  const q = Array.from(detail.name.trim()).slice(0, 100).join('')
  if (Array.from(q).length >= 2) {
    const params = { q, page_size: 1 }
    const found = await check('products/', params, (options) => getProducts(params, options))
    assert.ok(found.count > 0, 'Search for the API product name returned no products')
  }

  const historyPath = `products/${product.id}/prices/`
  const historyParams = { ordering: '-observed_at', page: 1, page_size: 1 }
  const history = await check(historyPath, historyParams, (options) => getProductPrices(product.id, historyParams, options))
  assert.ok(history.count >= 2, 'Selected product needs two observations; QA data may have changed')
  assert.equal(history.product.id, product.id)
  const nextHistoryParams = { ...historyParams, page: 2 }
  const nextHistory = await check(historyPath, nextHistoryParams, (options) => getProductPrices(product.id, nextHistoryParams, options))
  twoPages(history, nextHistory, (point) => `${point.receipt_id}:${point.position}`, 'history')
  assert.ok(Date.parse(history.results[0].observed_at) >= Date.parse(nextHistory.results[0].observed_at), 'History must show new purchases first')

  const summaryPath = `products/${product.id}/prices/summary/`
  const summaryParams = { group_by: 'store', price: 'paid', interval: 'none' }
  const summary = await check(summaryPath, summaryParams, (options) => getProductPriceSummary(product.id, summaryParams, options))
  assert.equal(summary.product.id, product.id)
  assert.equal(summary.group_by, 'store')
  assert.equal(summary.price, 'paid')
  assert.equal(summary.interval, 'none')
  assert.equal(summary.groups.reduce((count, group) => count + group.total.count, 0), history.count, 'Summary must cover the whole history, not its first page')

  const point = history.results[0]
  const filters = { store: point.store.id, country: point.store.country, currency: point.currency,
    date_from: point.purchased_on, date_to: point.purchased_on }
  const filteredParams = { ...historyParams, ...filters }
  const filtered = await check(historyPath, filteredParams, (options) => getProductPrices(product.id, filteredParams, options))
  assert.ok(filtered.count > 0)
  assert.ok(filtered.results.every((row) => row.store.id === filters.store && row.store.country === filters.country
    && row.currency === filters.currency && row.purchased_on === filters.date_from))
  const filteredSummaryParams = { ...summaryParams, ...filters }
  const filteredSummary = await check(summaryPath, filteredSummaryParams, (options) => getProductPriceSummary(product.id, filteredSummaryParams, options))
  assert.equal(filteredSummary.groups.reduce((count, group) => count + group.total.count, 0), filtered.count)
  assert.ok(filteredSummary.groups.every((group) => group.store.id === filters.store && group.currency === filters.currency))

  const storesParams = { page: 1, page_size: 1 }
  const stores = await check('stores/', storesParams, (options) => getStores(storesParams, options))
  assert.ok(stores.count >= 2, 'QA needs two stores for page_size=1')
  const nextStoresParams = { ...storesParams, page: 2 }
  const nextStores = await check('stores/', nextStoresParams, (options) => getStores(nextStoresParams, options))
  twoPages(stores, nextStores, (store) => store.id, 'stores')
  const countryParams = { country: point.store.country, page_size: 1 }
  const countryStores = await check('stores/', countryParams, (options) => getStores(countryParams, options))
  assert.ok(countryStores.count > 0)
  assert.ok(countryStores.results.every((store) => store.country === point.store.country))
  const storeQ = Array.from(countryStores.results[0].name.trim()).slice(0, 100).join('')
  if (Array.from(storeQ).length >= 2) {
    const params = { ...countryParams, q: storeQ }
    const found = await check('stores/', params, (options) => getStores(params, options))
    assert.ok(found.count > 0, 'Search for the API store name returned no stores')
  }

  const badSize = { page_size: 0 }
  await check('products/', badSize, (options) => getProducts(badSize, options), { status: 400, reason: 'invalid_parameter', field: 'page_size' })
  const badSearch = { q: 'a' }
  await check('products/', badSearch, (options) => getProducts(badSearch, options), { status: 400, reason: 'invalid_parameter', field: 'q' })
  const badDate = { date_from: 'not-a-date' }
  await check(historyPath, badDate, (options) => getProductPrices(product.id, badDate, options), { status: 400, reason: 'invalid_parameter', field: 'date_from' })
  const missingPage = { ...listParams, page: first.pages + 1 }
  await check('products/', missingPage, (options) => getProducts(missingPage, options), { status: 404, reason: 'page_out_of_range' })
  const missingHistoryPage = { ...historyParams, page: history.pages + 1 }
  await check(historyPath, missingHistoryPage, (options) => getProductPrices(product.id, missingHistoryPage, options), { status: 404, reason: 'page_out_of_range' })
  // categories/ contains the complete tree, so this ID is absent in stable QA.
  const missingCategoryId = Math.max(...categories.results.map((node) => node.id)) + 1
  assert.ok(Number.isSafeInteger(missingCategoryId), 'QA needs an absent category ID within the JS safe range')
  await check(`categories/${missingCategoryId}/`, {}, (options) => getCategory(missingCategoryId, options), { status: 404, reason: 'not_found' })
  console.log('Catalog HTTP/proxy and real adapters passed. React/browser behavior was not tested.')
}

try {
  await main()
} catch (error) {
  console.error(`Catalog check FAILED: ${error.message}`)
  process.exitCode = 1
}
