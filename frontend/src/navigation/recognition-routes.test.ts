import { describe, expect, it } from 'vitest'
import { buildJobsQuery, buildReceiptsQuery, buildRoute, parseJobsQuery, parseReceiptsQuery, parseRoute } from './routes'
import type { NavigableRoute } from './routes'

describe('receipt and recognition routes', () => {
  it.each<NavigableRoute>([
    { kind: 'receipts', query: { page: 1 } }, { kind: 'upload' }, { kind: 'receipt', receiptId: 71 },
    { kind: 'jobs', query: { page: 1 } }, { kind: 'job', jobId: 31 },
    { kind: 'receipts', query: { q: 'Чек + 20% & молоко', store: 1, product: 2, country: 'DE', currency: 'EUR', operation: 'refund', date_from: '2026-10-01', date_to: '2026-10-04', page: 2, page_size: 1, ordering: 'purchased_at' } },
    { kind: 'jobs', query: { photo: 11, status: 'partial_succeeded', page: 2, page_size: 1, ordering: 'created_at' } },
  ])('round trips $kind and accepts trailing slash', (route) => {
    const href = buildRoute(route)
    expect(parseRoute(href)).toEqual(route)
    const url = new URL(href, 'http://local')
    url.pathname += '/'
    expect(parseRoute(url)).toEqual(route)
  })
  it('decodes safe IDs and ignores queries on upload/detail', () => {
    expect(parseRoute('/receipts/%37%31?unused=1')).toEqual({ kind: 'receipt', receiptId: 71 })
    expect(parseRoute('/recognition/jobs/9007199254740991#items')).toEqual({ kind: 'job', jobId: Number.MAX_SAFE_INTEGER })
    expect(parseRoute('/receipts/upload?page=0')).toEqual({ kind: 'upload' })
  })
  it.each(['0', '-1', '1.5', '1e3', '+1', '9007199254740992', '%2f', '%GG', '%20'])('rejects unsafe ID %s', (id) => {
    expect(parseRoute(`/receipts/${id}`).kind).toBe('not-found')
    expect(parseRoute(`/recognition/jobs/${id}`).kind).toBe('not-found')
  })
  it.each(['/receipts/1/lines', '/receipts//', '/recognition', '/recognition/jobs/1/extra'])('rejects unknown path %s', (url) => {
    expect(parseRoute(url).kind).toBe('not-found')
  })
  it('shows invalid-query with explicit reset for bad list parameters', () => {
    expect(parseRoute('/recognition/jobs?photo=0&status=unknown&page=0&page_size=201')).toEqual({ kind: 'invalid-query', path: '/recognition/jobs', fields: ['photo', 'status', 'page', 'page_size'], resetTo: '/recognition/jobs' })
    expect(parseRoute('/receipts?date_from=2026-10-04&date_to=2026-10-01&product=0&operation=unknown&q=x&ordering=name')).toMatchObject({ kind: 'invalid-query', resetTo: '/receipts' })
  })
  it('takes the last repeated parameter, normalizes codes and ignores foreign filters', () => {
    expect(parseJobsQuery('?photo=0&photo=11&status=failed&status=running&page=2&q=x')).toEqual({ query: { photo: 11, status: 'running', page: 2 }, invalidFields: [] })
    expect(parseReceiptsQuery('?q=старое&q=%20новое%20&country=de&currency=eur&status=failed')).toEqual({ query: { q: 'новое', country: 'DE', currency: 'EUR', page: 1 }, invalidFields: [] })
    expect(buildJobsQuery({ page: 1, status: 'failed' })).toBe('?status=failed')
    expect(buildReceiptsQuery({ page: 1, q: '  ' })).toBe('')
  })
  it.each(['q', 'country', 'currency', 'operation', 'ordering', 'product', 'page_size'])('rejects controls in receipt filter %s', (key) => {
    expect(parseReceiptsQuery(`?${key}=%00`).invalidFields).toContain(key)
  })
  it('refuses to build invalid queries/IDs rather than rounding or silently dropping them', () => {
    expect(() => buildRoute({ kind: 'receipt', receiptId: 0 })).toThrow(RangeError)
    expect(() => buildRoute({ kind: 'job', jobId: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError)
    expect(() => buildJobsQuery({ page: 1, photo: 1.2 })).toThrow(RangeError)
    expect(() => buildReceiptsQuery({ page: 1, page_size: 201 })).toThrow(RangeError)
    expect(() => buildReceiptsQuery({ page: 1, date_from: '2026-02-30' })).toThrow(RangeError)
  })
})
