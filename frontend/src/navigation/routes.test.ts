import { describe, expect, it } from 'vitest'
import { buildCatalogQuery, buildHistoryQuery, buildRoute, parseCatalogQuery, parseHistoryQuery, parseRoute } from './routes'
import type { NavigableRoute } from './routes'

describe('route parsing', () => {
  it.each(['/', '/catalog', '/catalog/'])('opens the catalog at %s', (href) => {
    expect(parseRoute(href)).toEqual({ kind: 'catalog', query: { page: 1 } })
  })

  it('reads direct category/product URLs and ignores fragments', () => {
    expect(parseRoute('http://localhost/catalog/categories/%31%32?q=молоко&page=2#list')).toEqual({ kind: 'category', categoryId: 12, query: { q: 'молоко', page: 2 } })
    expect(parseRoute('/catalog/products/7/?store=5&country=de&currency=eur')).toEqual({ kind: 'product', productId: 7, query: { store: 5, country: 'DE', currency: 'EUR', page: 1 } })
    expect(parseRoute('/health?unknown=1')).toEqual({ kind: 'health' })
  })

  it.each(['0', '-1', '1.5', '1e3', '+1', 'NaN', '9007199254740992', '9999999999999999999', '%2F', '%GG', '%20', ''])('rejects path ID %s without rounding', (id) => {
    expect(parseRoute(`/catalog/products/${id}`).kind).toBe('not-found')
    expect(parseRoute(`/catalog/categories/${id}`).kind).toBe('not-found')
  })

  it.each(['/missing', '/catalog/other/1', '/catalog/products/1/extra', '/catalog//', '/Health'])('rejects unknown path %s', (href) => {
    expect(parseRoute(href)).toEqual({ kind: 'not-found', path: href })
  })

  it('opens the login screen at /login and leaves the neighbouring addresses alone', () => {
    expect(parseRoute('/login')).toEqual({ kind: 'login' })
    expect(parseRoute('/login/')).toEqual({ kind: 'login' })
    expect(parseRoute('http://localhost/login?next=%2Freceipts#form')).toEqual({ kind: 'login' })
    expect(buildRoute({ kind: 'login' })).toBe('/login')
    for (const href of ['/Login', '/login/reset', '/logins', '/catalog/login']) expect(parseRoute(href)).toEqual({ kind: 'not-found', path: href })
    expect(parseRoute('/')).toEqual({ kind: 'catalog', query: { page: 1 } })
    expect(parseRoute('/catalog')).toEqual({ kind: 'catalog', query: { page: 1 } })
  })

  it('accepts the largest safe ID', () => {
    expect(parseRoute('/catalog/products/9007199254740991')).toEqual({ kind: 'product', productId: Number.MAX_SAFE_INTEGER, query: { page: 1 } })
  })

  it('keeps a positive page for the API to detect page_out_of_range', () => {
    expect(parseRoute('/catalog?page=12345')).toEqual({ kind: 'catalog', query: { page: 12345 } })
  })

  it('offers an explicit reset instead of silently dropping invalid filters', () => {
    expect(parseRoute('/catalog/categories/9?generic=oops&page=0')).toEqual({
      kind: 'invalid-query', path: '/catalog/categories/9', fields: ['generic', 'page'], resetTo: '/catalog/categories/9',
    })
    expect(parseRoute('/catalog/products/5?date_from=2026-10-04&date_to=2026-10-03')).toEqual({
      kind: 'invalid-query', path: '/catalog/products/5', fields: ['date_from'], resetTo: '/catalog/products/5',
    })
  })
})

describe('query parsing and building', () => {
  it('round trips Unicode, literal plus/ampersand, percent and spaces', () => {
    const query = { q: 'Молоко + сыр & 2,5% 🥛', generic: 7, page: 3 }
    const search = buildCatalogQuery(query)
    expect(search).toContain('%2B')
    expect(search).toContain('%26')
    expect(search).toContain('%25')
    expect(parseCatalogQuery(search)).toEqual({ query, invalidFields: [] })
  })

  it('takes the last repeated value, trims empty filters and omits the default page', () => {
    expect(parseCatalogQuery('?q=old&q=%20новое%20&generic=3&generic=4&page=0&page=2')).toEqual({ query: { q: 'новое', generic: 4, page: 2 }, invalidFields: [] })
    expect(buildCatalogQuery({ q: '  ', page: 1 })).toBe('')
    expect(parseHistoryQuery('?store=&country=%20&currency=&date_from=&page=')).toEqual({ query: { page: 1 }, invalidFields: [] })
  })

  it('ignores extra parameters and route-inappropriate filters', () => {
    expect(parseCatalogQuery('?page=2&brand=9&store=1&country=RU&unknown=%00')).toEqual({ query: { page: 2 }, invalidFields: [] })
    expect(parseHistoryQuery('?page=3&q=молоко&generic=2&ordering=name')).toEqual({ query: { page: 3 }, invalidFields: [] })
    expect(buildCatalogQuery({ page: 2, unexpected: 'drop' } as { page: number })).toBe('?page=2')
  })

  it.each(['0', '-2', '1.2', '1e2', '9007199254740992', 'abc'])('rejects invalid numeric query %s', (value) => {
    expect(parseCatalogQuery(`?generic=${value}&page=${value}`).invalidFields).toEqual(['generic', 'page'])
    expect(parseHistoryQuery(`?store=${value}`).invalidFields).toEqual(['store'])
  })

  it('rejects controls before trimming and uses code point length for search', () => {
    expect(parseCatalogQuery('?q=%09молоко').invalidFields).toEqual(['q'])
    expect(parseCatalogQuery('?q=x').invalidFields).toEqual(['q'])
    expect(parseCatalogQuery(`?q=${'я'.repeat(101)}`).invalidFields).toEqual(['q'])
    expect(parseCatalogQuery(`?q=${'🥛'.repeat(100)}`).invalidFields).toEqual([])
  })

  it('normalizes only code syntax; the API validates membership in dictionaries', () => {
    expect(buildHistoryQuery({ country: ' de ', currency: 'eur', page: 2 })).toBe('?country=DE&currency=EUR&page=2')
    expect(parseHistoryQuery('?country=ZZ&currency=ZZZ').invalidFields).toEqual([])
    expect(parseHistoryQuery('?country=DE,RU&currency=EU').invalidFields).toEqual(['country', 'currency'])
  })

  it.each(['2026-02-29', '2026-04-31', '2026-13-01', '0000-01-01', '2026-1-01', 'yesterday'])('rejects impossible date %s', (date) => {
    expect(parseHistoryQuery(`?date_from=${date}`).invalidFields).toEqual(['date_from'])
  })

  it('keeps valid leap days and inclusive calendar bounds', () => {
    const query = { store: 4, country: 'DE', currency: 'EUR', date_from: '2024-02-29', date_to: '2026-10-04', page: 2 }
    expect(parseHistoryQuery(buildHistoryQuery(query))).toEqual({ query, invalidFields: [] })
  })

  it.each<NavigableRoute>([
    { kind: 'catalog', query: { q: 'молоко', generic: 2, page: 3 } },
    { kind: 'category', categoryId: 9, query: { page: 1 } },
    { kind: 'product', productId: 5, query: { store: 4, date_to: '2026-10-04', page: 2 } },
    { kind: 'health' },
  ])('round trips $kind', (route) => {
    expect(parseRoute(buildRoute(route))).toEqual(route)
  })

  it('refuses to build unsafe IDs and invalid query values', () => {
    expect(() => buildRoute({ kind: 'category', categoryId: Number.MAX_SAFE_INTEGER + 1, query: { page: 1 } })).toThrow(RangeError)
    expect(() => buildCatalogQuery({ page: 0 })).toThrow(RangeError)
    expect(() => buildHistoryQuery({ store: -1, page: 1 })).toThrow(RangeError)
    expect(() => buildHistoryQuery({ date_from: '2026-02-29', page: 1 })).toThrow(RangeError)
  })
})
