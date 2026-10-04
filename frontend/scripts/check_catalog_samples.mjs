// Read-only HTTP assertions for the synthetic QA samples and F6 additions.
// This does not run React or visit the browser UI.
import assert from 'node:assert/strict'
import { isCategoryDetail, isPriceHistory, isPriceSummary, isProduct, isProductDetail, isStoreEntry, page, results, isCategory } from '../src/api/schema.ts'
import { formatPrice, formatPurchasedOn } from '../src/lib/format.ts'

async function main() {
  assert.equal(process.env.POSTGRES_DB, 'checkist_qa', 'Apply the full QA environment first')
  assert.equal(process.env.VITE_API_BASE_URL, '/api')
  const origin = new URL(process.argv[2] ?? 'http://127.0.0.1:15173')
  assert.equal(origin.protocol, 'http:')
  assert.equal(origin.hostname, '127.0.0.1')
  assert.equal(origin.href, `${origin.origin}/`)
  assert.ok(process.argv.length <= 3, 'Usage: node frontend/scripts/check_catalog_samples.mjs [proxy-origin]')

  async function get(path, verify, status = 200) {
    const response = await fetch(new URL(`/api/${path}`, origin), {
      headers: { Accept: 'application/json' }, credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    })
    assert.equal(response.status, status, path)
    assert.equal(response.headers.get('content-type'), 'application/json', path)
    const body = await response.json()
    verify(body)
    console.log(`PASS HTTP ${status} /api/${path}: JSON assertions passed`)
    return body
  }

  const first = await get('products/?page_size=1&page=1', b => assert.ok(page(isProduct)(b)))
  const second = await get('products/?page_size=1&page=2', b => assert.ok(page(isProduct)(b)))
  assert.equal(first.count, second.count)
  assert.equal(first.page, 1)
  assert.equal(second.page, 2)
  assert.equal(first.results.length, 1)
  assert.equal(second.results.length, 1)
  assert.notEqual(first.results[0].id, second.results[0].id)

  const products = await get('products/?page_size=200', b => assert.ok(page(isProduct)(b)))
  assert.equal(products.pages, 1, 'This sample check needs the small F6 QA dataset (at most 200 products)')
  const mixed = products.results.find(p => p.prices.some(g => g.country === 'RU' && g.currency === 'RUB')
    && p.prices.some(g => g.country === 'DE' && g.currency === 'EUR'))
  assert.ok(mixed, 'QA needs the F6 purchase of RU milk in Lidl for EUR')
  const detail = await get(`products/${mixed.id}/`, b => assert.ok(isProductDetail(b)))
  assert.equal(detail.package.quantity, '850.000')
  assert.equal(detail.package.unit, 'ml')
  const storeId = detail.prices.find(g => g.country === 'DE' && g.currency === 'EUR').last.store_id
  assert.ok(detail.stores.some(s => s.id === storeId && s.country === 'DE'))
  const filters = new URLSearchParams({ store: String(storeId), country: 'DE', currency: 'EUR', date_from: '2026-10-02', date_to: '2026-10-02' })
  await get(`products/${mixed.id}/prices/?${filters}&ordering=-observed_at&page_size=1`, b => {
    assert.ok(isPriceHistory(b))
    assert.equal(b.count, 1)
    const point = b.results[0]
    assert.equal(point.store.id, storeId)
    assert.equal(point.store.country, 'DE')
    assert.equal(point.currency, 'EUR')
    assert.equal(point.purchased_on, '2026-10-02')
    assert.equal(point.paid_unit_price, '1.2500')
    assert.equal(point.normalized_price, '1.4706')
    assert.equal(point.normalized_unit, 'l')
    assert.equal(formatPrice(point.normalized_price, point.currency, point.normalized_unit), '1,4706\u00a0EUR/л')
    assert.equal(formatPurchasedOn(point.purchased_on), '02.10.2026')
  })
  await get(`products/${mixed.id}/prices/summary/?group_by=store&price=paid&interval=none`, b => {
    assert.ok(isPriceSummary(b))
    assert.equal(b.groups.length, 2)
    assert.deepEqual(new Set(b.groups.map(g => g.currency)), new Set(['RUB', 'EUR']))
    assert.equal(b.groups.find(g => g.currency === 'RUB').total.min, '111.0000')
    assert.equal(b.groups.find(g => g.currency === 'EUR').total.min, '1.2500')
  })
  await get(`products/${mixed.id}/prices/summary/?${filters}&group_by=store&price=paid&interval=none`, b => {
    assert.ok(isPriceSummary(b))
    assert.equal(b.groups.length, 1)
    assert.equal(b.groups[0].store.id, storeId)
    assert.equal(b.groups[0].total.count, 1)
    assert.equal(b.groups[0].total.avg, '1.2500')
  })
  await get('stores/?country=DE&q=Lindau', b => {
    assert.ok(page(isStoreEntry)(b))
    assert.ok(b.results.some(s => s.id === storeId && s.country === 'DE'))
  })
  // q searches name/city, so the street-only fragment cannot find Lidl.
  await get('stores/?country=DE&q=Kemptener', b => {
    assert.ok(page(isStoreEntry)(b))
    assert.equal(b.count, 0)
  })
  const unused = await get('products/?q=F6+QA&has_prices=0', b => assert.ok(page(isProduct)(b)))
  const product = unused.results.find(p => p.name === 'F6 QA — Молоко без покупок')
  assert.ok(product, 'QA needs the F6 product without purchases')
  await get(`products/${product.id}/`, b => {
    assert.ok(isProductDetail(b))
    assert.equal(b.last_observed_at, null)
    assert.deepEqual(b.prices, [])
    assert.deepEqual(b.stores, [])
  })
  await get(`products/${product.id}/prices/`, b => {
    assert.ok(isPriceHistory(b))
    assert.equal(b.count, 0)
    assert.equal(b.pages, 0)
    assert.deepEqual(b.results, [])
  })
  await get(`products/${product.id}/prices/summary/`, b => {
    assert.ok(isPriceSummary(b))
    assert.deepEqual(b.groups, [])
  })
  const categories = await get('categories/', b => assert.ok(results(isCategory)(b)))
  const category = categories.results.find(c => c.name === 'F6 QA — Пустая категория')
  assert.ok(category, 'QA needs the F6 empty category')
  await get(`categories/${category.id}/`, b => {
    assert.ok(isCategoryDetail(b))
    assert.equal(b.products_total, 0)
    assert.deepEqual(b.children, [])
    assert.deepEqual(b.generic_products, [])
  })
  await get('products/?page_size=0', b => {
    assert.deepEqual(b, { error: { code: 'invalid_parameter', message: 'Некорректные параметры запроса.', fields: { page_size: ['Допустимо от 1 до 200.'] } } })
  }, 400)
  await get(`products/${product.id}/prices/?page=2`, b => {
    assert.deepEqual(b, { error: { code: 'page_out_of_range', message: 'Страница за пределами диапазона.' } })
  }, 404)
  const missingProductId = Math.max(...products.results.map(p => p.id)) + 1
  assert.ok(Number.isSafeInteger(missingProductId))
  await get(`products/${missingProductId}/`, b => {
    assert.deepEqual(b, { error: { code: 'not_found', message: 'Не найдено.' } })
  }, 404)
  console.log('Synthetic QA values, runtime schemas and formatting passed. Browser behavior was not tested.')
}

try {
  await main()
} catch (error) {
  console.error(`Sample check FAILED: ${error.message}`)
  process.exitCode = 1
}
