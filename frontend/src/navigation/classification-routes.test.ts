import { describe, expect, it } from 'vitest'
import { createNavigation } from './controller'
import type { NavigationEnvironment } from './controller'
import { buildClassificationQuery, buildRoute, parseClassificationQuery, parseRoute } from './routes'
import type { NavigableRoute } from './routes'

describe('product classification routes', () => {
  it('parses the screen with its default, every status, a product and a page', () => {
    expect(parseRoute('/catalog/classification')).toEqual({ kind: 'classification', query: { page: 1 } })
    expect(parseRoute('/catalog/classification/')).toEqual({ kind: 'classification', query: { page: 1 } })
    expect(parseRoute('/catalog/classification?status=&product=&page=')).toEqual({ kind: 'classification', query: { page: 1 } })
    expect(parseRoute('/catalog/classification?status=confirmed&page=3')).toEqual({ kind: 'classification', query: { status: 'confirmed', page: 3 } })
    expect(parseRoute('/catalog/classification?status=rejected')).toEqual({ kind: 'classification', query: { status: 'rejected', page: 1 } })
    expect(parseRoute('/catalog/classification?status=superseded&product=13')).toEqual({ kind: 'classification', query: { status: 'superseded', product: 13, page: 1 } })
    expect(parseRoute('/catalog/classification?status=all&page=2')).toEqual({ kind: 'classification', query: { status: 'all', page: 2 } })
    expect(parseRoute('/catalog/classification?product=13')).toEqual({ kind: 'classification', query: { product: 13, page: 1 } })
  })
  it('keeps one address for the default list of pending records', () => {
    expect(parseRoute('/catalog/classification?status=pending&product=5&page=2')).toEqual({ kind: 'classification', query: { product: 5, page: 2 } })
    expect(buildRoute({ kind: 'classification', query: { page: 1 } })).toBe('/catalog/classification')
    expect(buildClassificationQuery({ status: 'all', page: 1 })).toBe('?status=all')
    expect(buildClassificationQuery({ product: 13, page: 1 })).toBe('?product=13')
    expect(buildClassificationQuery({ status: 'confirmed', product: 13, page: 4 })).toBe('?status=confirmed&product=13&page=4')
  })
  it('uses the last repeated value and ignores parameters of other screens', () => {
    expect(parseClassificationQuery('?status=all&status=rejected&product=1&product=7&q=milk&generic=5&page_size=10'))
      .toEqual({ query: { status: 'rejected', product: 7, page: 1 }, invalidFields: [] })
  })
  it.each([
    ['?status=done', ['status']], ['?status=cancelled', ['status']], ['?product=0', ['product']], ['?product=abc', ['product']],
    ['?product=9007199254740992', ['product']], ['?page=0', ['page']], ['?page=1.5', ['page']],
    ['?status=%00all&product=-1&page=x', ['status', 'product', 'page']],
  ])('reports the invalid query %s before any request', (search, fields) => {
    expect(parseClassificationQuery(search).invalidFields).toEqual(fields)
    expect(parseRoute(`/catalog/classification${search}`)).toEqual({ kind: 'invalid-query', path: '/catalog/classification', fields, resetTo: '/catalog/classification' })
  })
  it('has no page of a single record and does not shadow the other catalog routes', () => {
    expect(parseRoute('/catalog/classification/7').kind).toBe('not-found')
    expect(parseRoute('/catalog/classifications').kind).toBe('not-found')
    expect(parseRoute('/catalog').kind).toBe('catalog')
    expect(parseRoute('/catalog/merges').kind).toBe('merges')
    expect(parseRoute('/catalog/merges/3').kind).toBe('merge')
    expect(parseRoute('/catalog/categories/3').kind).toBe('category')
    expect(parseRoute('/catalog/products/5').kind).toBe('product')
  })
  it.each<NavigableRoute>([
    { kind: 'classification', query: { page: 1 } }, { kind: 'classification', query: { status: 'all', page: 5 } },
    { kind: 'classification', query: { status: 'superseded', product: 12, page: 1 } }, { kind: 'classification', query: { product: 12, page: 2 } },
  ])('round trips $kind $query', (route) => {
    expect(parseRoute(buildRoute(route))).toEqual(route)
  })
  it('refuses to build an unsafe product, page or status', () => {
    expect(() => buildClassificationQuery({ page: 0 })).toThrow(RangeError)
    expect(() => buildClassificationQuery({ product: Number.MAX_SAFE_INTEGER + 1, page: 1 })).toThrow(RangeError)
    expect(() => buildClassificationQuery({ status: 'done' as 'all', page: 1 })).toThrow(RangeError)
  })
})

describe('return from a product card to the classification screen', () => {
  function memory(start: string) {
    const entries: { href: string; state: unknown }[] = [{ href: `http://checkist.local${start}`, state: null }]
    const environment: NavigationEnvironment = {
      getHref: () => entries.at(-1)!.href,
      getState: () => entries.at(-1)!.state,
      pushState: (state, href) => { entries.push({ href: `http://checkist.local${href}`, state }) },
      replaceState: (state, href) => { entries[entries.length - 1] = { href: `http://checkist.local${href}`, state } },
      listenPopState: () => () => {},
    }
    return createNavigation(environment)
  }
  it('keeps the address of the screen with its filter in History state', () => {
    const navigation = memory('/catalog/classification?status=all&page=2')
    navigation.subscribe(() => {})
    navigation.navigate({ kind: 'product', productId: 13, query: { page: 1 } })
    expect(navigation.getSnapshot()).toMatchObject({ href: '/catalog/products/13', returnTo: '/catalog/classification?status=all&page=2' })
  })
  it('does not offer the screen as the list of a duplicate group', () => {
    const navigation = memory('/catalog/classification')
    navigation.subscribe(() => {})
    navigation.navigate({ kind: 'merge', groupId: 3 })
    expect(navigation.getSnapshot().returnTo).toBeUndefined()
  })
})
