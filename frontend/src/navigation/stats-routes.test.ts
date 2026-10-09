import { describe, expect, it } from 'vitest'
import {
  buildProductQuery, buildReceiptsStatsQuery, buildRoute, buildSpendingQuery, parseProductQuery, parseReceiptsStatsQuery, parseRoute,
  parseSpendingQuery, receiptsStatsHref, spendingHref,
} from './routes'
import type { NavigableRoute, ReceiptsStatsQuery, SpendingQuery } from './routes'

const allSpending: SpendingQuery = {
  date_from: '2026-01-01', date_to: '2026-06-30', country: 'DE', currency: 'EUR', store: [3, 5], group_by: 'product', category: 2, generic: 7,
}
const allReceipts: ReceiptsStatsQuery = {
  base_from: '2020-01-01', base_to: '2020-12-31', current_from: '2026-01-01', current_to: '2026-10-06',
  country: 'DE', currency: 'EUR', store: [3, 5], interval: 'quarter',
}

describe('spending route /stats', () => {
  it('opens without filters, with a trailing slash and with empty values', () => {
    expect(parseRoute('/stats')).toEqual({ kind: 'spending', query: {} })
    expect(parseRoute('/stats/')).toEqual({ kind: 'spending', query: {} })
    expect(parseRoute('/stats?date_from=&date_to=%20&country=&currency=&store=&group_by=&category=&generic=')).toEqual({ kind: 'spending', query: {} })
  })
  it('reads every filter and normalizes codes and the store list', () => {
    expect(parseRoute('/stats?generic=7&category=2&group_by=product&store=5,%203,5&currency=eur&country=de&date_to=2026-06-30&date_from=2026-01-01#chart'))
      .toEqual({ kind: 'spending', query: allSpending })
  })
  it('builds one stable address whatever the order of the input', () => {
    const href = '/stats?date_from=2026-01-01&date_to=2026-06-30&country=DE&currency=EUR&store=3,5&group_by=product&category=2&generic=7'
    expect(spendingHref(allSpending)).toBe(href)
    expect(buildRoute({ kind: 'spending', query: { generic: 7, category: 2, group_by: 'product', store: [5, 3, 5], currency: 'eur', country: ' de ', date_to: '2026-06-30', date_from: '2026-01-01' } })).toBe(href)
    expect(parseRoute(href)).toEqual({ kind: 'spending', query: allSpending })
  })
  it('does not write defaults and empty values into the address', () => {
    expect(spendingHref()).toBe('/stats')
    expect(buildSpendingQuery({ group_by: 'category', store: [], country: '  ' })).toBe('')
    expect(parseRoute('/stats?group_by=category')).toEqual({ kind: 'spending', query: {} })
    expect(buildSpendingQuery({ group_by: 'store' })).toBe('?group_by=store')
  })
  it.each([
    ['?date_from=2026-02-29&date_to=2026-06-30', { date_to: '2026-06-30' }, ['date_from']],
    ['?date_from=2026-06-30&date_to=2026-01-01&country=DE', { country: 'DE' }, ['date_from']],
    ['?country=DEU&currency=EU&group_by=brand', {}, ['country', 'currency', 'group_by']],
    ['?store=3,abc&category=0&generic=1.5', {}, ['store', 'category', 'generic']],
    ['?store=3,,5&currency=EUR', { currency: 'EUR' }, ['store']],
    [`?store=${Array.from({ length: 21 }, (_, index) => index + 1).join(',')}`, {}, ['store']],
    ['?category=%002&generic=9007199254740992', {}, ['category', 'generic']],
  ])('drops wrong values of %s and keeps the rest', (search, query, fields) => {
    expect(parseSpendingQuery(search)).toEqual({ query, invalidFields: fields })
    expect(parseRoute(`/stats${search}`)).toEqual({ kind: 'spending', query })
  })
  it('accepts twenty stores, the last repeated value and ignores parameters of other screens', () => {
    const stores = Array.from({ length: 20 }, (_, index) => index + 1)
    expect(parseSpendingQuery(`?store=${stores.join(',')}`).query).toEqual({ store: stores })
    expect(parseSpendingQuery('?group_by=brand&group_by=generic&page=3&q=milk&limit=5&interval=week&base_from=2020-01-01'))
      .toEqual({ query: { group_by: 'generic' }, invalidFields: [] })
  })
  it('keeps an open «Прочее» as the last parameter and writes nothing for a closed one', () => {
    expect(parseRoute('/stats?other=open&group_by=generic')).toEqual({ kind: 'spending', query: { group_by: 'generic', other: 'open' } })
    expect(spendingHref({ other: 'open' })).toBe('/stats?other=open')
    expect(spendingHref({ other: 'open', ...allSpending })).toBe(`${spendingHref(allSpending)}&other=open`)
    expect(buildRoute(parseRoute(`${spendingHref(allSpending)}&other=open`) as NavigableRoute)).toBe(`${spendingHref(allSpending)}&other=open`)
    expect(spendingHref({ ...allSpending, other: undefined })).toBe(spendingHref(allSpending))
  })
  it.each(['1', 'true', 'OPEN', 'closed', 'open,open'])('drops other=%s silently: the canonical address does not hold it', (value) => {
    expect(parseSpendingQuery(`?country=DE&other=${value}`)).toEqual({ query: { country: 'DE' }, invalidFields: ['other'] })
    expect(buildRoute(parseRoute(`/stats?country=DE&other=${value}`) as NavigableRoute)).toBe('/stats?country=DE')
    expect(buildSpendingQuery({ country: 'DE', other: value as 'open' })).toBe('?country=DE')
  })
  it('reads an empty other as absent and takes the last repeated value', () => {
    expect(parseSpendingQuery('?other=')).toEqual({ query: {}, invalidFields: [] })
    expect(parseSpendingQuery('?other=1&other=open').query).toEqual({ other: 'open' })
  })
  it('drops wrong values when building instead of throwing', () => {
    expect(buildSpendingQuery({ date_from: 'yesterday', country: 'DE', store: [0], group_by: 'brand' as 'store', category: -1 })).toBe('?country=DE')
    expect(buildSpendingQuery({ ...allSpending, unexpected: 'drop' } as SpendingQuery)).toBe(buildSpendingQuery(allSpending))
  })
})

describe('average receipt route /stats/receipts', () => {
  it('opens without periods, with a trailing slash and with empty values', () => {
    expect(parseRoute('/stats/receipts')).toEqual({ kind: 'receipts-stats', query: {} })
    expect(parseRoute('/stats/receipts/')).toEqual({ kind: 'receipts-stats', query: {} })
    expect(parseRoute('/stats/receipts?base_from=&base_to=&current_from=%20&current_to=&store=&interval=')).toEqual({ kind: 'receipts-stats', query: {} })
  })
  it('builds one stable address and reads it back', () => {
    const href = '/stats/receipts?base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-10-06&country=DE&currency=EUR&store=3,5&interval=quarter'
    expect(receiptsStatsHref(allReceipts)).toBe(href)
    expect(buildRoute({ kind: 'receipts-stats', query: { interval: 'quarter', store: [5, 3], currency: 'eur', country: 'de', current_to: '2026-10-06', current_from: '2026-01-01', base_to: '2020-12-31', base_from: '2020-01-01' } })).toBe(href)
    expect(parseRoute(href)).toEqual({ kind: 'receipts-stats', query: allReceipts })
  })
  it('does not write the default interval and accepts every other one', () => {
    expect(receiptsStatsHref()).toBe('/stats/receipts')
    expect(buildReceiptsStatsQuery({ interval: 'month' })).toBe('')
    expect(parseRoute('/stats/receipts?interval=month')).toEqual({ kind: 'receipts-stats', query: {} })
    for (const interval of ['week', 'quarter', 'year'] as const) {
      expect(parseRoute(`/stats/receipts?interval=${interval}`)).toEqual({ kind: 'receipts-stats', query: { interval } })
    }
  })
  it.each([
    ['?base_from=2020-13-01&base_to=2020-12-31', { base_to: '2020-12-31' }, ['base_from']],
    ['?base_from=2020-12-31&base_to=2020-01-01&current_from=2026-01-01', { current_from: '2026-01-01' }, ['base_from']],
    ['?current_from=2026-10-06&current_to=2026-01-01&base_to=2020-12-31', { base_to: '2020-12-31' }, ['current_from']],
    ['?interval=day&country=D&currency=EURO&store=-1', {}, ['country', 'currency', 'store', 'interval']],
  ])('drops wrong values of %s and keeps the rest', (search, query, fields) => {
    expect(parseReceiptsStatsQuery(search)).toEqual({ query, invalidFields: fields })
    expect(parseRoute(`/stats/receipts${search}`)).toEqual({ kind: 'receipts-stats', query })
  })
  it('leaves overlapping or incomplete periods to the screen', () => {
    const query = { base_from: '2026-01-01', base_to: '2026-06-30', current_from: '2026-06-01' }
    expect(parseReceiptsStatsQuery(buildReceiptsStatsQuery(query))).toEqual({ query, invalidFields: [] })
  })
  it('ignores parameters of the spending screen and drops wrong values when building', () => {
    expect(parseReceiptsStatsQuery('?date_from=2026-01-01&group_by=store&category=2&generic=3&page=2')).toEqual({ query: {}, invalidFields: [] })
    expect(buildReceiptsStatsQuery({ base_from: '2020-02-30', interval: 'day' as 'week', currency: 'EUR' })).toBe('?currency=EUR')
  })
})

describe('statistics routes among the others', () => {
  it.each<NavigableRoute>([
    { kind: 'spending', query: {} }, { kind: 'spending', query: allSpending },
    { kind: 'spending', query: { group_by: 'store', store: [9] } }, { kind: 'spending', query: { category: 4 } },
    { kind: 'receipts-stats', query: {} }, { kind: 'receipts-stats', query: allReceipts },
    { kind: 'receipts-stats', query: { base_from: '2020-01-01', interval: 'year' } },
  ])('round trips %j', (route) => {
    expect(parseRoute(buildRoute(route))).toEqual(route)
  })
  it('does not accept deeper or differently cased paths', () => {
    for (const href of ['/stats/receipts/1', '/stats/spending', '/Stats', '/stats/receipts/compare']) {
      expect(parseRoute(href)).toEqual({ kind: 'not-found', path: href })
    }
  })
  it('does not shadow the receipt list, upload and receipt routes', () => {
    expect(parseRoute('/receipts').kind).toBe('receipts')
    expect(parseRoute('/receipts/upload').kind).toBe('upload')
    expect(parseRoute('/receipts/7')).toEqual({ kind: 'receipt', receiptId: 7 })
  })
})

describe('product card query with the price chart', () => {
  it('reads price and interval next to the history filters', () => {
    expect(parseRoute('/catalog/products/7?interval=week&price=normalized&store=5&country=de&page=2')).toEqual({
      kind: 'product', productId: 7, query: { store: 5, country: 'DE', price: 'normalized', interval: 'week', page: 2 },
    })
    expect(parseRoute('/catalog/products/7?interval=day')).toEqual({ kind: 'product', productId: 7, query: { interval: 'day', page: 1 } })
  })
  it('keeps one address for the defaults and a stable order', () => {
    expect(parseRoute('/catalog/products/7?price=paid&interval=month&price=&interval=')).toEqual({ kind: 'product', productId: 7, query: { page: 1 } })
    expect(parseRoute('/catalog/products/7?price=paid&interval=month')).toEqual({ kind: 'product', productId: 7, query: { page: 1 } })
    expect(buildProductQuery({ price: 'paid', interval: 'month', page: 1 })).toBe('')
    expect(buildProductQuery({ page: 3, interval: 'week', price: 'normalized', date_to: '2026-10-04', store: 4 }))
      .toBe('?store=4&date_to=2026-10-04&price=normalized&interval=week&page=3')
  })
  it('leaves addresses of the existing card filters unchanged', () => {
    const query = { store: 4, country: 'DE', currency: 'EUR', date_from: '2024-02-29', date_to: '2026-10-04', page: 2 }
    const href = '/catalog/products/5?store=4&country=DE&currency=EUR&date_from=2024-02-29&date_to=2026-10-04&page=2'
    expect(buildRoute({ kind: 'product', productId: 5, query })).toBe(href)
    expect(parseRoute(href)).toEqual({ kind: 'product', productId: 5, query })
    expect(buildRoute({ kind: 'product', productId: 5, query: { page: 1 } })).toBe('/catalog/products/5')
  })
  it('reports a wrong chart parameter like any other card filter', () => {
    expect(parseProductQuery('?price=gross&interval=quarter&store=x').invalidFields).toEqual(['store', 'price', 'interval'])
    expect(parseRoute('/catalog/products/5?price=gross&interval=year')).toEqual({
      kind: 'invalid-query', path: '/catalog/products/5', fields: ['price', 'interval'], resetTo: '/catalog/products/5',
    })
    expect(() => buildProductQuery({ price: 'gross' as 'paid', page: 1 })).toThrow(RangeError)
  })
  it.each<NavigableRoute>([
    { kind: 'product', productId: 5, query: { price: 'normalized', page: 1 } },
    { kind: 'product', productId: 5, query: { store: 4, currency: 'EUR', price: 'normalized', interval: 'day', page: 2 } },
  ])('round trips %j', (route) => {
    expect(parseRoute(buildRoute(route))).toEqual(route)
  })
  it('does not leak chart parameters into the receipt list or the catalog', () => {
    expect(parseRoute('/receipts?price=normalized&interval=week')).toEqual({ kind: 'receipts', query: { page: 1 } })
    expect(parseRoute('/catalog?price=gross')).toEqual({ kind: 'catalog', query: { page: 1 } })
  })
})
