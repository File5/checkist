import { describe, expect, it } from 'vitest'
import { buildRoute, parseRoute, parseTrendsQuery, trendsHref } from './routes'

describe('trends route /stats/trends', () => {
  it('opens without parameters, with a trailing slash and with empty values', () => {
    expect(parseRoute('/stats/trends')).toEqual({ kind: 'trends', query: {} })
    expect(parseRoute('/stats/trends/')).toEqual({ kind: 'trends', query: {} })
    expect(parseRoute('/stats/trends?months=&category=%20&month=')).toEqual({ kind: 'trends', query: {} })
  })
  it('reads the window, the category and the opened month; the default window never stands in the query', () => {
    expect(parseRoute('/stats/trends?month=2026-08&category=12&months=24')).toEqual({ kind: 'trends', query: { months: 24, category: 12, month: '2026-08' } })
    expect(parseRoute('/stats/trends?months=6')).toEqual({ kind: 'trends', query: { months: 6 } })
    expect(parseRoute('/stats/trends?months=12')).toEqual({ kind: 'trends', query: {} })
  })
  it('drops a wrong value instead of refusing the address', () => {
    expect(parseTrendsQuery('months=7&category=0&month=2026-13')).toEqual({ query: {}, invalidFields: ['months', 'category', 'month'] })
    expect(parseRoute('/stats/trends?months=36&month=0000-01&category=x')).toEqual({ kind: 'trends', query: {} })
  })
  it('builds one stable address', () => {
    const href = '/stats/trends?months=24&category=12&month=2026-08'
    expect(trendsHref({ month: '2026-08', category: 12, months: 24 })).toBe(href)
    expect(buildRoute({ kind: 'trends', query: { month: '2026-08', category: 12, months: 24 } })).toBe(href)
    expect(parseRoute(href)).toEqual({ kind: 'trends', query: { months: 24, category: 12, month: '2026-08' } })
    expect(trendsHref()).toBe('/stats/trends')
  })
})
