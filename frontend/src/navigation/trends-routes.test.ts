import { describe, expect, it } from 'vitest'
import { buildRoute, parseRoute, parseTrendsQuery, statsIncomesHref, trendsHref } from './routes'

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
  it('reads a period from … to that wins over the older months, in order and at most 60 months long', () => {
    expect(parseRoute('/stats/trends?from=2026-05&to=2026-10&months=24&category=3')).toEqual({
      kind: 'trends', query: { from: '2026-05', to: '2026-10', category: 3 } })
    expect(parseRoute('/stats/trends?from=2021-11&to=2026-10')).toEqual({ kind: 'trends', query: { from: '2021-11', to: '2026-10' } })
    expect(parseRoute('/stats/trends?from=2026-10&to=2026-10')).toEqual({ kind: 'trends', query: { from: '2026-10', to: '2026-10' } })
    expect(parseTrendsQuery('from=2021-10&to=2026-10')).toEqual({ query: {}, invalidFields: ['from'] })
    expect(parseTrendsQuery('from=2026-10&to=2026-05&months=6')).toEqual({ query: { months: 6 }, invalidFields: ['to'] })
    expect(parseTrendsQuery('from=2026-05')).toEqual({ query: {}, invalidFields: ['to'] })
    expect(parseTrendsQuery('from=1900-12&to=05.2026')).toEqual({ query: {}, invalidFields: ['from', 'to'] })
  })
  it('builds the period first and drops half of it', () => {
    expect(trendsHref({ category: 3, to: '2026-10', from: '2026-05', month: '2026-08' })).toBe('/stats/trends?from=2026-05&to=2026-10&category=3&month=2026-08')
    expect(trendsHref({ from: '2026-05' })).toBe('/stats/trends')
    expect(trendsHref({ from: '2026-05', to: '2026-10', months: 24 })).toBe('/stats/trends?from=2026-05&to=2026-10')
  })
  it('builds one stable address', () => {
    const href = '/stats/trends?months=24&category=12&month=2026-08'
    expect(trendsHref({ month: '2026-08', category: 12, months: 24 })).toBe(href)
    expect(buildRoute({ kind: 'trends', query: { month: '2026-08', category: 12, months: 24 } })).toBe(href)
    expect(parseRoute(href)).toEqual({ kind: 'trends', query: { months: 24, category: 12, month: '2026-08' } })
    expect(trendsHref()).toBe('/stats/trends')
  })
})

describe('«Доходы» of the statistics /stats/incomes (feature/stats-compact)', () => {
  it('reads the period of «Динамика» and drops what belongs to its blocks', () => {
    expect(parseRoute('/stats/incomes')).toEqual({ kind: 'stats-incomes', query: {} })
    expect(parseRoute('/stats/incomes?from=2026-01&to=2026-10&category=3&month=2026-05'))
      .toEqual({ kind: 'stats-incomes', query: { from: '2026-01', to: '2026-10' } })
    expect(parseRoute('/stats/incomes?months=24')).toEqual({ kind: 'stats-incomes', query: { months: 24 } })
    expect(parseRoute('/stats/incomes?from=2026-10&to=2026-01')).toEqual({ kind: 'stats-incomes', query: {} })
  })
  it('builds the canonical address', () => {
    expect(buildRoute({ kind: 'stats-incomes', query: { from: '2026-01', to: '2026-10' } })).toBe('/stats/incomes?from=2026-01&to=2026-10')
    expect(statsIncomesHref({ months: 6 })).toBe('/stats/incomes?months=6')
    expect(statsIncomesHref()).toBe('/stats/incomes')
  })
})
