import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { statsAnswer, statsFixture } from './stats-test-support'
import { getTrendsCategory, getTrendsLimits, getTrendsMonthly, getTrendsPrices } from './trends'
import { isTrendsCategory, isTrendsLimits, isTrendsMonthly, isTrendsPrices } from './trends-schema'
import type { TrendsLimits, TrendsMonthly, TrendsPrices } from './trends-types'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('trends readers', () => {
  it.each([
    ['stats/trends/monthly/?months=24', () => getTrendsMonthly({ months: 24 }), 'trends-monthly.json'],
    ['stats/trends/category/?months=6&category=3', () => getTrendsCategory({ months: 6, category: 3 }), 'trends-category.json'],
    ['stats/trends/prices/?months=12&month=2026-09', () => getTrendsPrices({ months: 12, month: '2026-09' }), 'trends-prices.json'],
    ['stats/trends/limits/', () => getTrendsLimits(), 'trends-limits.json'],
  ])('GET %s validates the backend example', async (path, call, fixture) => {
    fetchMock.mockResolvedValue(json(statsFixture(fixture)))
    expect(await call()).toEqual({ kind: 'ok', data: statsAnswer(fixture) })
    expect(fetchMock.mock.calls[0][0]).toBe(`/api/${path}`)
  })
  it('refuses a wrong window or category locally and an answer of another endpoint', async () => {
    expect(await getTrendsMonthly({ months: 0 })).toEqual({ kind: 'error', reason: 'invalid_parameter', fields: ['months'] })
    expect(await getTrendsCategory({ category: 1.5 })).toEqual({ kind: 'error', reason: 'invalid_parameter', fields: ['category'] })
    expect(fetchMock).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(json(statsFixture('trends-prices.json')))
    expect(await getTrendsMonthly()).toMatchObject({ kind: 'error', reason: 'invalid_response' })
  })
})

describe('trends schemas', () => {
  const monthly = () => statsFixture('trends-monthly.json') as TrendsMonthly
  const prices = () => statsFixture('trends-prices.json') as TrendsPrices
  const limits = () => statsFixture('trends-limits.json') as TrendsLimits
  it.each<[string, () => unknown]>([
    ['a skipped month', () => { const body = monthly(); body.currencies[0].months.splice(3, 1); return body }],
    ['months out of order', () => { const body = monthly(); body.currencies[0].months.reverse(); return body }],
    ['a month category outside the legend', () => { const body = monthly(); body.currencies[0].months[0].categories.push({ id: 999, amount: '1.00' }); return body }],
    ['a row without every month', () => { const body = monthly(); body.currencies[0].rows[0].amounts.pop(); return body }],
    ['a summary of another month', () => { const body = monthly(); body.currencies[0].summary.month = '2026-08'; return body }],
    ['a repeated currency', () => { const body = monthly(); body.currencies.push(body.currencies[0]); return body }],
    ['a numeric amount', () => { const body = monthly(); (body.currencies[0] as { total: unknown }).total = 15.4; return body }],
  ])('monthly: rejects %s', (_, spoil) => {
    expect(isTrendsMonthly(monthly())).toBe(true)
    expect(isTrendsMonthly(spoil())).toBe(false)
  })
  it('prices: a riser is a rise, counts hold the lists, index month and change go together', () => {
    const riser = prices(); riser.currencies[0].risers[0].change_percent = '-1.00'
    expect(isTrendsPrices(riser)).toBe(false)
    const counts = prices(); counts.currencies[0].risen_total = 1
    expect(isTrendsPrices(counts)).toBe(false)
    const change = prices(); change.currencies[0].index_month = null
    expect(isTrendsPrices(change)).toBe(false)
  })
  it('limits and category: every month of the window, a category to draw', () => {
    const short = limits(); short.limits[0].months.pop()
    expect(isTrendsLimits(short)).toBe(false)
    const lost = statsFixture('trends-category.json') as { category: unknown }
    lost.category = null
    expect(isTrendsCategory(lost)).toBe(false)
  })
})
