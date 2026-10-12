import { describe, expect, it } from 'vitest'
import { menuItems } from '../menu/menu-items'
import type { Session } from '../session'
import { buildRoute, parseRoute } from './routes'
import type { NavigableRoute } from './routes'

describe('«Добавить трату» routes', () => {
  it.each<NavigableRoute>([{ kind: 'expense-new' }, { kind: 'expense-edit', receiptId: 90 }])('round trips $kind and accepts trailing slash', (route) => {
    const href = buildRoute(route)
    expect(parseRoute(href)).toEqual(route)
    const url = new URL(href, 'http://local')
    url.pathname += '/'
    expect(parseRoute(url)).toEqual(route)
  })
  it('has stable addresses and ignores queries', () => {
    expect(buildRoute({ kind: 'expense-new' })).toBe('/receipts/new')
    expect(buildRoute({ kind: 'expense-edit', receiptId: 90 })).toBe('/receipts/90/edit')
    expect(parseRoute('/receipts/new?total=5')).toEqual({ kind: 'expense-new' })
    expect(parseRoute('/receipts/%39%30/edit')).toEqual({ kind: 'expense-edit', receiptId: 90 })
  })
  it('keeps receipt details and upload apart from the new spend', () => {
    expect(parseRoute('/receipts/90')).toEqual({ kind: 'receipt', receiptId: 90 })
    expect(parseRoute('/receipts/upload')).toEqual({ kind: 'upload' })
  })
  it.each(['0', '-1', '1.5', 'new', '9007199254740992', '%GG'])('rejects unsafe ID %s of an edit', (id) => {
    expect(parseRoute(`/receipts/${id}/edit`).kind).toBe('not-found')
  })
  it.each(['/receipts/new/edit/1', '/receipts/1/edit/x', '/receipts/edit'])('rejects unknown path %s', (path) => {
    expect(parseRoute(path).kind).toBe('not-found')
  })
  it('throws on an unsafe ID when building', () => {
    expect(() => buildRoute({ kind: 'expense-edit', receiptId: 0 })).toThrow(RangeError)
  })
  it('lights «Чеки» in the menu on both screens', () => {
    const session = { kind: 'user', mode: 'local_single', user: { username: 'local' } } as Session
    for (const route of [{ kind: 'expense-new' }, { kind: 'expense-edit', receiptId: 9 }] as NavigableRoute[]) {
      const { primary, more } = menuItems(session, route)
      expect([...primary, ...more].filter((item) => item.current).map((item) => item.key)).toEqual(['receipts'])
    }
  })
})
