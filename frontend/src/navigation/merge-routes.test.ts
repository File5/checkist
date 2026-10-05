import { describe, expect, it } from 'vitest'
import { buildMergesQuery, buildRoute, parseMergesQuery, parseRoute } from './routes'
import type { NavigableRoute } from './routes'

describe('product merge routes', () => {
  it('parses the list with its default, every status and a page', () => {
    expect(parseRoute('/catalog/merges')).toEqual({ kind: 'merges', query: { page: 1 } })
    expect(parseRoute('/catalog/merges/')).toEqual({ kind: 'merges', query: { page: 1 } })
    expect(parseRoute('/catalog/merges?status=&page=')).toEqual({ kind: 'merges', query: { page: 1 } })
    expect(parseRoute('/catalog/merges?status=confirmed&page=3')).toEqual({ kind: 'merges', query: { status: 'confirmed', page: 3 } })
    expect(parseRoute('/catalog/merges?status=cancelled')).toEqual({ kind: 'merges', query: { status: 'cancelled', page: 1 } })
    expect(parseRoute('/catalog/merges?status=all&page=2')).toEqual({ kind: 'merges', query: { status: 'all', page: 2 } })
  })
  it('keeps one address for the default list of pending groups', () => {
    expect(parseRoute('/catalog/merges?status=pending&page=2')).toEqual({ kind: 'merges', query: { page: 2 } })
    expect(buildRoute({ kind: 'merges', query: { page: 1 } })).toBe('/catalog/merges')
    expect(buildMergesQuery({ status: 'all', page: 1 })).toBe('?status=all')
    expect(buildMergesQuery({ status: 'confirmed', page: 4 })).toBe('?status=confirmed&page=4')
  })
  it('uses the last repeated value and ignores parameters of other screens', () => {
    expect(parseMergesQuery('?status=all&status=cancelled&q=milk&product=5&page_size=10')).toEqual({ query: { status: 'cancelled', page: 1 }, invalidFields: [] })
  })
  it.each([
    ['?status=done', ['status']], ['?page=0', ['page']], ['?page=1.5', ['page']], ['?page=9007199254740992', ['page']],
    ['?status=%00all&page=-1', ['status', 'page']],
  ])('reports the invalid list query %s before any request', (search, fields) => {
    expect(parseMergesQuery(search).invalidFields).toEqual(fields)
    expect(parseRoute(`/catalog/merges${search}`)).toEqual({ kind: 'invalid-query', path: '/catalog/merges', fields, resetTo: '/catalog/merges' })
  })
  it('parses a group and rejects unsafe or malformed ids', () => {
    expect(parseRoute('/catalog/merges/7')).toEqual({ kind: 'merge', groupId: 7 })
    expect(parseRoute('/catalog/merges/7/?status=all')).toEqual({ kind: 'merge', groupId: 7 })
    for (const id of ['0', '-1', '1.5', 'abc', '9007199254740992', '%E0%A4%A', '7/lines']) {
      expect(parseRoute(`/catalog/merges/${id}`).kind).toBe('not-found')
    }
  })
  it('does not shadow catalog, category and product routes', () => {
    expect(parseRoute('/catalog').kind).toBe('catalog')
    expect(parseRoute('/catalog/categories/3').kind).toBe('category')
    expect(parseRoute('/catalog/products/5').kind).toBe('product')
    expect(parseRoute('/catalog/merge').kind).toBe('not-found')
  })
  it.each<NavigableRoute>([
    { kind: 'merges', query: { page: 1 } }, { kind: 'merges', query: { status: 'all', page: 5 } },
    { kind: 'merges', query: { status: 'cancelled', page: 1 } }, { kind: 'merge', groupId: 12 },
  ])('round trips $kind', (route) => {
    expect(parseRoute(buildRoute(route))).toEqual(route)
  })
  it('refuses to build an unsafe group id, page or status', () => {
    expect(() => buildRoute({ kind: 'merge', groupId: 0 })).toThrow(RangeError)
    expect(() => buildRoute({ kind: 'merge', groupId: Number.MAX_SAFE_INTEGER + 1 })).toThrow(RangeError)
    expect(() => buildMergesQuery({ page: 0 })).toThrow(RangeError)
    expect(() => buildMergesQuery({ status: 'done' as 'all', page: 1 })).toThrow(RangeError)
  })
})
