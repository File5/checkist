import { describe, expect, it } from 'vitest'
import { readError } from './http'
import { isPriceSeries } from './price-series-schema'
import { isReceiptCompare, isReceiptSeries, isSpending } from './stats-schema'
import { fixturesOf, statsErrorFixtures, statsFixture, statsFixtureNames } from './stats-test-support'
import { dateMs, decimalNumber } from './stats-types'
import type { PriceSeries } from './price-series-types'
import type { ReceiptCompare, ReceiptSeries, Spending } from './stats-types'

type Validate = (value: unknown) => boolean
const families: [string, Validate][] = [
  ['spending-', isSpending], ['series-', isReceiptSeries], ['compare-', isReceiptCompare], ['price-series-', isPriceSeries],
]
const cases = families.flatMap(([prefix, validate]) => fixturesOf(prefix).map((name): [string, Validate] => [name, validate]))
/** Each mutation spoils a fresh copy of a real answer; the schema has to notice. */
type Spoil<T> = [string, (body: T) => void]
function rejects<T>(name: string, validate: Validate, spoils: Spoil<T>[]) {
  it.each(spoils)(`${name}: rejects %s`, (_, spoil) => {
    const body = statsFixture(name) as T
    expect(validate(body)).toBe(true)
    spoil(body)
    expect(validate(body)).toBe(false)
  })
}
const set = (target: object, key: string, value: unknown) => { (target as Record<string, unknown>)[key] = value }
const drop = (target: object, key: string) => { delete (target as Record<string, unknown>)[key] }

describe('public statistics fixtures', () => {
  it('covers every JSON supplied by backend, including future additions', () => {
    expect([...cases.map(([name]) => name), ...Object.keys(statsErrorFixtures)].sort()).toEqual(statsFixtureNames())
    expect(cases).toHaveLength(22)
  })
  it.each(cases)('validates %s and requires every root field', (name, validate) => {
    const body = statsFixture(name) as Record<string, unknown>
    expect(validate(body)).toBe(true)
    for (const key of Object.keys(body)) {
      const missing = { ...body }
      delete missing[key]
      expect(validate(missing), `${name} missing ${key}`).toBe(false)
    }
    expect(validate({ ...body, added_later: 1 }), 'additive field').toBe(true)
    for (const invalid of [null, [], true, 'body', 1, {}]) expect(validate(invalid)).toBe(false)
  })
  it.each(cases)('%s is accepted by its own schema only', (name, validate) => {
    for (const [, other] of families) expect(other(statsFixture(name))).toBe(other === validate)
  })
  it.each(cases)('%s: every nested documented field is required', (name, validate) => {
    // Remove each key of each nested object in turn: nothing in a real answer is optional.
    const paths: (string | number)[][] = []
    const walk = (value: unknown, path: (string | number)[]) => {
      if (Array.isArray(value)) { if (value.length) walk(value[0], [...path, 0]) } else if (value !== null && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) { paths.push([...path, key]); walk(child, [...path, key]) }
      }
    }
    walk(statsFixture(name), [])
    for (const path of paths) {
      const body = statsFixture(name)
      let parent = body as Record<string | number, unknown>
      for (const step of path.slice(0, -1)) parent = parent[step] as Record<string | number, unknown>
      delete parent[path.at(-1)!]
      expect(validate(body), `${name} without ${path.join('.')}`).toBe(false)
    }
  })
  it.each(Object.entries(statsErrorFixtures))('%s is an error body, not an answer, and keeps only field names', (name, expected) => {
    const body = statsFixture(name)
    for (const [, validate] of families) expect(validate(body)).toBe(false)
    expect(readError(expected.status, body, true)).toEqual({ kind: 'error', ...expected })
  })
})

describe('spending schema', () => {
  const block = (body: Spending) => body.currencies[0]
  rejects<Spending>('spending-category.json', isSpending, [
    ['a numeric amount', (body) => set(block(body).items[0], 'amount', 12.5)],
    ['an amount with three places', (body) => set(block(body).items[0], 'amount', '12.500')],
    ['a percent with four places', (body) => set(block(body).items[0], 'share_percent', '2.5700')],
    ['an unknown kind', (body) => set(block(body).items[0], 'kind', 'brand')],
    ['a kind of another grouping', (body) => set(block(body).items[0], 'kind', 'generic')],
    ['a regular item without id', (body) => set(block(body).items[0], 'id', null)],
    ['a regular item without name', (body) => set(block(body).items[0], 'name', null)],
    ['a special item with an id', (body) => set(block(body).items.find((item) => item.kind === 'unmatched')!, 'id', 3)],
    ['a special item with a name', (body) => set(block(body).items.find((item) => item.kind === 'deposit')!, 'name', 'Залог')],
    ['a negative count', (body) => set(block(body).items[0], 'lines_count', -1)],
    ['a quantity without unit', (body) => set(block(body).items[0], 'quantity', '1.000')],
    ['a unit without quantity', (body) => set(block(body).items[0], 'unit', 'kg')],
    ['a parent of a wrong shape', (body) => set(body, 'parent', { id: 1, name: 'Продукты' })],
    ['an unknown grouping', (body) => set(body, 'group_by', 'brand')],
    ['an impossible date', (body) => set(body, 'date_from', '2026-02-30')],
    ['a missing other', (body) => drop(block(body), 'other')],
    ['an empty other', (body) => set(block(body), 'other', { count: 0, amount: '0.00', share_percent: null })],
    ['a receipts total without difference', (body) => set(block(body).totals, 'difference', null)],
    ['null paid lines', (body) => set(block(body).totals, 'lines_paid', null)],
    ['a repeated currency', (body) => body.currencies.push(structuredClone(block(body)))],
    ['an empty currency code', (body) => set(block(body), 'currency', '')],
    ['currencies of a wrong type', (body) => set(body, 'currencies', {})],
  ])
  rejects<Spending>('spending-store.json', isSpending, [
    ['a store without city', (body) => drop(block(body).items[0], 'city')],
    ['a store with a three-letter country', (body) => set(block(body).items[0], 'country', 'DEU')],
    ['a special item among stores', (body) => Object.assign(block(body).items[0], { kind: 'service', id: null, name: null })],
  ])
  rejects<Spending>('spending-product.json', isSpending, [
    ['a quantity with two places', (body) => set(block(body).items[0], 'quantity', '18.00')],
    ['an unknown unit', (body) => set(block(body).items[0], 'unit', 'lb')],
    ['a direct product', (body) => set(block(body).items[0], 'direct', true)],
    ['an unassigned product', (body) => set(block(body).items[0], 'unassigned', true)],
    ['other of a wrong shape', (body) => set(block(body), 'other', { count: 25, amount: '1200.33' })],
  ])
  rejects<Spending>('spending-generic.json', isSpending, [
    ['a quantity of a generic product', (body) => Object.assign(block(body).items[0], { quantity: '1.000', unit: 'l' })],
    ['a direct generic product', (body) => set(block(body).items[0], 'direct', true)],
  ])
  describe('category filter under another grouping', () => {
    // The server names the category of the filter in `parent` under every grouping, not only `group_by=category`.
    const parent = (statsFixture('spending-category-drilldown.json') as Spending).parent
    const filtered = (name: string) => ({ ...(statsFixture(name) as Spending), parent: structuredClone(parent) })
    const answers: [string, string][] = [
      ['generic', 'spending-generic.json'], ['product', 'spending-product.json'], ['product', 'spending-generic-filter.json'],
      ['store', 'spending-store.json'],
    ]
    it.each(answers)('accepts `parent` with group_by=%s (%s)', (grouping, name) => {
      const body = filtered(name)
      expect(body.group_by).toBe(grouping)
      expect(body.parent).not.toBeNull()
      expect(isSpending(body)).toBe(true)
    })
    it.each(answers)('still checks `parent` and the rest of the answer with group_by=%s (%s)', (_, name) => {
      expect(isSpending({ ...filtered(name), parent: { id: 1, name: 'Продукты' } })).toBe(false)
      expect(isSpending({ ...filtered(name), parent: { ...parent, id: 0 } })).toBe(false)
      expect(isSpending({ ...filtered(name), parent: { ...parent, path: [{ id: 1 }] } })).toBe(false)
      expect(isSpending({ ...filtered(name), parent: 'Продукты' })).toBe(false)
      const missing: Record<string, unknown> = filtered(name)
      drop(missing, 'parent')
      expect(isSpending(missing)).toBe(false)
      const broken = filtered(name)
      set(broken.currencies[0].items[0], 'amount', '12,5')
      expect(isSpending(broken)).toBe(false)
      const foreign = filtered(name)
      set(foreign.currencies[0].items[0], 'kind', 'category')
      expect(isSpending(foreign)).toBe(false)
    })
    it('accepts an unknown category of the filter: no parent and no blocks under any grouping', () => {
      for (const group_by of ['category', 'generic', 'product', 'store']) {
        expect(isSpending({ ...(statsFixture('spending-empty.json') as Spending), group_by })).toBe(true)
      }
    })
  })
  it('keeps the nullable answers of the contract', () => {
    const drilldown = statsFixture('spending-category-drilldown.json') as Spending
    expect(drilldown.parent).toEqual({ id: 1, name: 'Продукты питания', path: [{ id: 1, name: 'Продукты питания' }] })
    expect(drilldown.currencies[0].totals).toMatchObject({ receipts_total: null, difference: null })
    expect(drilldown.currencies[0].items.filter((item) => item.direct)).toHaveLength(1)
    const refund = statsFixture('spending-refund-day.json') as Spending
    expect(refund.currencies[0].items[0]).toMatchObject({ amount: '-7.14', share_percent: null, unassigned: true })
    expect((statsFixture('spending-empty.json') as Spending).currencies).toEqual([])
    expect((statsFixture('spending-generic.json') as Spending).currencies[0].other).toEqual({ count: 9, amount: '3508.72', share_percent: '26.82' })
  })
})

describe('receipt series schema', () => {
  const bucket = (body: ReceiptSeries) => body.currencies[0].buckets[0]
  rejects<ReceiptSeries>('series-year.json', isReceiptSeries, [
    ['an interval of price series', (body) => set(body, 'interval', 'day')],
    ['an interval without visits', (body) => set(bucket(body), 'receipts_count', 0)],
    ['a null average', (body) => set(bucket(body), 'avg_receipt', null)],
    ['a numeric median', (body) => set(bucket(body), 'median_receipt', 25.46)],
    ['a two-place sum per line', (body) => set(bucket(body), 'paid_per_line', '2.37')],
    ['no sum per line despite lines', (body) => set(bucket(body), 'paid_per_line', null)],
    ['a sum per line without lines', (body) => set(bucket(body), 'lines_count', 0)],
    ['a period start with time', (body) => set(bucket(body), 'period_start', '2019-01-01T00:00:00Z')],
    ['intervals out of order', (body) => body.currencies[0].buckets.reverse()],
    ['a repeated interval', (body) => body.currencies[0].buckets.splice(1, 0, structuredClone(bucket(body)))],
    ['a block without intervals', (body) => set(body.currencies[0], 'buckets', [])],
    ['negative refunds', (body) => set(body.currencies[0], 'refunds_excluded', -1)],
    ['a repeated currency', (body) => body.currencies.push(structuredClone(body.currencies[0]))],
  ])
  it('accepts an interval of visits without product lines', () => {
    const body = statsFixture('series-month.json') as ReceiptSeries
    Object.assign(bucket(body), { lines_count: 0, lines_per_receipt: '0.00', paid_per_line: null })
    expect(isReceiptSeries(body)).toBe(true)
  })
})

describe('receipt comparison schema', () => {
  const block = (body: ReceiptCompare) => body.currencies[0]
  rejects<ReceiptCompare>('compare-2020-2026.json', isReceiptCompare, [
    ['a period without a bound', (body) => set(body.base, 'date_to', null)],
    ['a numeric effect', (body) => set(block(body).effects!, 'quantity', 8.65)],
    ['price without mix', (body) => set(block(body).effects!, 'mix', null)],
    ['a missing price_per_line', (body) => set(block(body).effects!, 'price_per_line', null)],
    ['a share of an unknown effect', (body) => Object.assign(block(body).effects!, { price: null, mix: null })],
    ['an index with two places', (body) => set(block(body).price_index!, 'fisher', '1.24')],
    ['a missing coverage', (body) => set(block(body).price_index!, 'coverage_current_percent', null)],
    ['an index over no products', (body) => set(block(body).price_index!, 'matched_products', 0)],
    ['a total that differs from the matched products', (body) => set(block(body), 'products_total', 25)],
    ['products without an index', (body) => set(block(body), 'price_index', null)],
    ['more products than the total', (body) => Object.assign(block(body), { products_total: 2, price_index: { ...block(body).price_index!, matched_products: 2 } })],
    ['a product without id', (body) => set(block(body).products[0].product, 'id', 0)],
    ['a purchase price with two places', (body) => set(block(body).products[0].base, 'price', '6.17')],
    ['a purchase quantity as a number', (body) => set(block(body).products[0].current, 'quantity', 18)],
    ['a null price change', (body) => set(block(body).products[0], 'price_change_percent', null)],
    ['an average without visits', (body) => set(block(body).base, 'receipts_count', 0)],
    ['visits without an average', (body) => set(block(body).current, 'avg_receipt', null)],
    ['effects without a change', (body) => set(block(body), 'change', { avg_receipt: null, avg_receipt_percent: null })],
    ['a repeated currency', (body) => body.currencies.push(structuredClone(block(body)))],
  ])
  rejects<ReceiptCompare>('compare-one-sided.json', isReceiptCompare, [
    ['effects of a wrong type', (body) => set(block(body), 'effects', [])],
    ['a block without visits in both periods', (body) => Object.assign(block(body).current, {
      receipts_count: 0, avg_receipt: null, median_receipt: null, lines_count: 0, lines_per_receipt: null, paid_per_line: null,
    })],
    ['a percent of an unknown change', (body) => set(block(body).change, 'avg_receipt_percent', '10.00')],
  ])
  it('keeps the nullable answers of the contract', () => {
    const oneSided = block(statsFixture('compare-one-sided.json') as ReceiptCompare)
    expect(oneSided).toMatchObject({ effects: null, price_index: null, products: [], products_total: 0, change: { avg_receipt: null, avg_receipt_percent: null } })
    expect(oneSided.base).toMatchObject({ receipts_count: 0, total: '0.00', avg_receipt: null, median_receipt: null, lines_per_receipt: null, paid_per_line: null })
    const unmatched = block(statsFixture('compare-no-matched-products.json') as ReceiptCompare)
    expect(unmatched.price_index).toBeNull()
    expect(unmatched.effects).toEqual({
      quantity: '8.02', price: null, mix: null, price_per_line: '13.34', quantity_percent: '37.55', price_percent: null, mix_percent: null,
    })
    expect((statsFixture('compare-empty.json') as ReceiptCompare).currencies).toEqual([])
  })
  it('accepts a zero change, whose shares are unknown', () => {
    const body = statsFixture('compare-2020-2026.json') as ReceiptCompare
    Object.assign(block(body).change, { avg_receipt: '0.00', avg_receipt_percent: '0.00' })
    Object.assign(block(body).effects!, { quantity_percent: null, price_percent: null, mix_percent: null })
    expect(isReceiptCompare(body)).toBe(true)
  })
})

describe('price series schema', () => {
  const own = (body: PriceSeries) => body.series.find((item) => item.role === 'own')!
  const similar = (body: PriceSeries) => body.series.find((item) => item.role === 'similar')!
  rejects<PriceSeries>('price-series-milk-normalized.json', isPriceSeries, [
    ['an own series without store', (body) => set(own(body), 'store', null)],
    ['a similar series with a store', (body) => set(similar(body), 'store', structuredClone(own(body).store))],
    ['an unknown role', (body) => set(own(body), 'role', 'other')],
    ['an own series of another product', (body) => set(own(body).product, 'id', 999)],
    ['the product among its similar ones', (body) => set(similar(body).product, 'id', body.product.id)],
    ['a store of another country', (body) => set(own(body), 'country', 'KZ')],
    ['a comparable series that lost the flag', (body) => set(own(body), 'comparable', false)],
    ['a point with a two-place price', (body) => set(own(body).points[0], 'avg', '1.05')],
    ['a point with a numeric price', (body) => set(own(body).points[0], 'last', 1.05)],
    ['a point without observations', (body) => set(own(body).points[0], 'count', 0)],
    ['observations that differ from the points', (body) => set(own(body), 'observations', own(body).observations + 1)],
    ['points out of order', (body) => own(body).points.reverse()],
    ['an unknown unit', (body) => set(own(body), 'unit', 'lb')],
    ['an unknown interval', (body) => set(body, 'interval', 'year')],
    ['a list price kind', (body) => set(body, 'price', 'list')],
    ['an unknown similar status', (body) => set(body.similar, 'status', 'hidden')],
    ['more shown than found', (body) => set(body.similar, 'products_total', 1)],
    ['similar series under a disabled status', (body) => set(body.similar, 'status', 'disabled')],
    ['more similar products than shown', (body) => set(body.similar, 'products_shown', 1)],
    ['a base unit other than the generic one', (body) => set(body.product, 'base_unit', 'kg')],
    ['a generic product without base unit', (body) => drop(body.generic, 'base_unit')],
    ['own_truncated of a wrong type', (body) => set(body, 'own_truncated', 0)],
    ['series of a wrong type', (body) => set(body, 'series', null)],
  ])
  rejects<PriceSeries>('price-series-milk-paid.json', isPriceSeries, [
    ['skipped observations for paid prices', (body) => set(body, 'skipped_without_normalized', 2)],
    ['a comparable paid series', (body) => set(own(body), 'comparable', true)],
  ])
  rejects<PriceSeries>('price-series-empty.json', isPriceSeries, [
    ['status ok without similar products', (body) => set(body.similar, 'status', 'ok')],
    ['found products under status none', (body) => set(body.similar, 'products_total', 3)],
  ])
  it('keeps the nullable and empty answers of the contract', () => {
    const milk = statsFixture('price-series-milk-paid.json') as PriceSeries
    expect(milk.series.filter((item) => item.role === 'similar').every((item) => item.store === null)).toBe(true)
    expect(new Set(milk.series.filter((item) => item.role === 'similar').map((item) => item.country))).toEqual(new Set(['DE', 'KZ']))
    expect(statsFixture('price-series-empty.json')).toMatchObject({ series: [], similar: { status: 'none' } })
    expect(statsFixture('price-series-unassigned.json')).toMatchObject({ similar: { status: 'generic_unassigned', products_total: 0 } })
    expect(statsFixture('price-series-similar-none.json')).toMatchObject({ interval: 'week', similar: { status: 'disabled' } })
    expect((statsFixture('price-series-apples-normalized.json') as PriceSeries).series.filter((item) => item.role === 'own')).toHaveLength(2)
  })
  it('accepts skipped observations of normalized prices and a metre series that is not comparable', () => {
    const body = statsFixture('price-series-milk-normalized.json') as PriceSeries
    body.skipped_without_normalized = 4
    Object.assign(similar(body), { unit: 'm', comparable: false })
    expect(isPriceSeries(body)).toBe(true)
  })
})

describe('chart helpers', () => {
  it('reads wire decimals without touching the strings of the answer', () => {
    expect([decimalNumber('45.72'), decimalNumber('-7.14'), decimalNumber('0.00'), decimalNumber('1.2404'), decimalNumber('18.000'), decimalNumber('7')])
      .toEqual([45.72, -7.14, 0, 1.2404, 18, 7])
    const body = statsFixture('compare-2020-2026.json') as ReceiptCompare
    const effects = body.currencies[0].effects!
    expect([effects.quantity, effects.price, effects.mix].map(decimalNumber)).toEqual([8.65, 7.39, 2.67])
    expect(effects.quantity).toBe('8.65')
  })
  it.each([null, undefined, '', ' ', 'NaN', 'Infinity', '1e3', '1,5', '.5', '5.', '+1', '0x10', '12abc', 12 as unknown as string])(
    'gives null instead of a number for %j', (value) => { expect(decimalNumber(value)).toBeNull() })
  it('places dates on a UTC axis regardless of the local time zone', () => {
    expect(dateMs('1970-01-01')).toBe(0)
    expect(dateMs('2026-09-30')).toBe(Date.UTC(2026, 8, 30))
    expect(dateMs('2024-02-29')).toBe(Date.UTC(2024, 1, 29))
    expect(dateMs('0099-12-31')).toBe(new Date('0099-12-31T00:00:00Z').getTime())
    const series = statsFixture('series-month.json') as ReceiptSeries
    const positions = series.currencies[0].buckets.map((bucket) => dateMs(bucket.period_start)!)
    expect(positions).toHaveLength(9)
    expect(positions.every((value, index) => index === 0 || positions[index - 1] < value)).toBe(true)
  })
  it.each([null, undefined, '', '2026-02-30', '2025-02-29', '2026-13-01', '2026-00-10', '2026-1-1', '2026-01-01T00:00:00Z', '01.02.2026'])(
    'gives null instead of a date for %j', (value) => { expect(dateMs(value)).toBeNull() })
})
