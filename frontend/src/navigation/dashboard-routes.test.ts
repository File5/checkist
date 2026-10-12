import { describe, expect, it } from 'vitest'
import { createNavigation } from './controller'
import { buildRoute, parseMonthParam, parseRoute } from './routes'
import type { NavigableRoute } from './routes'

describe('«Главная» and «Лимиты» routes', () => {
  it('opens the dashboard at the root, with or without a month', () => {
    expect(parseRoute('/')).toEqual({ kind: 'dashboard' })
    expect(parseRoute('http://localhost/?month=2026-09#top')).toEqual({ kind: 'dashboard', month: '2026-09' })
    expect(parseRoute('/?month=2026-08&month=2026-09')).toEqual({ kind: 'dashboard', month: '2026-09' })
    expect(parseRoute('/?month=%202026-09%20')).toEqual({ kind: 'dashboard', month: '2026-09' })
  })
  it.each(['2026-13', '2026-00', '2026-9', '26-09', '0000-01', '2026-09-01', '', 'сентябрь'])('drops a wrong month %j instead of refusing the address', (month) => {
    expect(parseRoute(`/?month=${encodeURIComponent(month)}`)).toEqual({ kind: 'dashboard' })
    expect(parseMonthParam(month)).toBeUndefined()
  })
  it.each<NavigableRoute>([{ kind: 'dashboard' }, { kind: 'dashboard', month: '2026-01' }, { kind: 'limits' }])('round trips %j', (route) => {
    expect(parseRoute(buildRoute(route))).toEqual(route)
  })
  it('has stable addresses', () => {
    expect(buildRoute({ kind: 'dashboard' })).toBe('/')
    expect(buildRoute({ kind: 'dashboard', month: '2026-10' })).toBe('/?month=2026-10')
    expect(buildRoute({ kind: 'dashboard', month: 'oops' })).toBe('/')
    expect(buildRoute({ kind: 'limits' })).toBe('/budget/limits')
    expect(parseRoute('/budget/limits/')).toEqual({ kind: 'limits' })
    expect(parseRoute('/budget/limits?currency=KZT')).toEqual({ kind: 'limits' })
  })
  it('keeps the catalog at its own address', () => {
    expect(parseRoute('/catalog')).toEqual({ kind: 'catalog', query: { page: 1 } })
    expect(parseRoute('/?q=молоко')).toEqual({ kind: 'dashboard' })
  })
  it.each(['/budget', '/budget/limits/1', '/Budget/limits', '/dashboard'])('rejects unknown path %s', (path) => {
    expect(parseRoute(path)).toEqual({ kind: 'not-found', path })
  })
  it('returns from a receipt opened on the dashboard to the same month', () => {
    let href = 'http://checkist.local/?month=2026-09'
    let state: unknown = null
    const navigation = createNavigation({
      getHref: () => href, getState: () => state,
      pushState: (next, url) => { href = new URL(url, href).href; state = next },
      replaceState: (next, url) => { href = new URL(url, href).href; state = next },
      listenPopState: () => () => {},
    })
    navigation.navigate('/receipts/12')
    expect(navigation.getSnapshot()).toEqual({ href: '/receipts/12', route: { kind: 'receipt', receiptId: 12 }, returnTo: '/?month=2026-09' })
  })
})
