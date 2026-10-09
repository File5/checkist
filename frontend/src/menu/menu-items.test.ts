import { describe, expect, it } from 'vitest'
import type { Route } from '../navigation'
import type { Session } from '../session'
import { BAR_SLOTS, menuItems } from './menu-items'

const loading: Session = { kind: 'loading' }
const failed: Session = { kind: 'error' }
const guest: Session = { kind: 'guest', expired: false }
const reader: Session = { kind: 'user', mode: 'accounts', user: { id: 1, username: 'synthetic-reader', is_staff: false }, permissions: { moderate_catalog: false } }
const local: Session = { kind: 'user', mode: 'local_single', user: { id: 1, username: 'local', is_staff: false }, permissions: { moderate_catalog: true } }

const catalog: Route = { kind: 'catalog', query: { page: 1 } }
const health: Route = { kind: 'health' }
const labels = (items: { label: string }[]) => items.map((item) => item.label)
const current = (session: Session, route: Route) => {
  const { primary, more } = menuItems(session, route)
  return [...primary, ...more].filter((item) => item.current).map((item) => item.key)
}

describe('items of the main menu and their split for the bottom bar of a phone', () => {
  it.each<[string, Session]>([['while «Я» is being read', loading], ['when «Я» could not be read', failed]])('%s: the health page alone, no «Ещё»', (_name, session) => {
    const menu = menuItems(session, health)
    expect(labels(menu.primary)).toEqual(['Состояние сервисов'])
    expect(menu.more).toEqual([])
    expect(menu.primary[0]).toEqual({ key: 'health', to: '/health', label: 'Состояние сервисов', current: true })
  })

  it.each([false, true])('a guest (session ended: %s): the health page and the sign-in, no «Ещё»', (expired) => {
    const menu = menuItems({ kind: 'guest', expired }, health)
    expect(menu.primary.map((item) => [item.label, item.to, item.current])).toEqual([['Состояние сервисов', '/health', true], ['Войти', '/login', false]])
    expect(menu.more).toEqual([])
  })

  it('local_single: three sections in the bar, «Обработка» and the health page behind «Ещё»', () => {
    const menu = menuItems(local, catalog)
    expect(menu.primary.map((item) => [item.label, item.to])).toEqual([['Каталог', '/catalog'], ['Чеки', '/receipts'], ['Статистика', '/stats']])
    expect(menu.more.map((item) => [item.label, item.to])).toEqual([['Обработка', '/recognition/jobs'], ['Состояние сервисов', '/health']])
    expect([...menu.primary, ...menu.more].some((item) => item.account)).toBe(false)
  })

  it('accounts: the same and the name of the person, the last one behind «Ещё»', () => {
    const menu = menuItems(reader, catalog)
    expect(labels(menu.primary)).toEqual(['Каталог', 'Чеки', 'Статистика'])
    expect(labels(menu.more)).toEqual(['Обработка', 'Состояние сервисов', 'synthetic-reader'])
    expect(menu.more[2]).toEqual({ key: 'account', to: '/account', label: 'synthetic-reader', current: false, account: true })
  })

  it('never puts more into the bar than it holds, and keeps «Ещё» for at least two links', () => {
    for (const session of [loading, failed, guest, local, reader]) {
      const { primary, more } = menuItems(session, health)
      expect(primary.length + (more.length > 0 ? 1 : 0)).toBeLessThanOrEqual(BAR_SLOTS)
      expect(more.length).not.toBe(1)
      expect(new Set([...primary, ...more].map((item) => item.key)).size).toBe(primary.length + more.length)
    }
  })

  it.each<[Route, string]>([
    [catalog, 'catalog'], [{ kind: 'category', categoryId: 3, query: { page: 1 } }, 'catalog'],
    [{ kind: 'product', productId: 5, query: { page: 1 } }, 'catalog'], [{ kind: 'merges', query: { page: 1 } }, 'catalog'],
    [{ kind: 'merge', groupId: 2 }, 'catalog'], [{ kind: 'classification', query: { page: 1 } }, 'catalog'],
    [{ kind: 'receipts', query: { page: 1 } }, 'receipts'], [{ kind: 'upload' }, 'receipts'], [{ kind: 'receipt', receiptId: 7 }, 'receipts'],
    [{ kind: 'spending', query: {} }, 'stats'], [{ kind: 'receipts-stats', query: {} }, 'stats'],
    [{ kind: 'jobs', query: { page: 1 } }, 'jobs'], [{ kind: 'job', jobId: 9 }, 'jobs'],
    [health, 'health'], [{ kind: 'account' }, 'account'],
  ])('marks one current item at %j', (route, key) => {
    expect(current(reader, route)).toEqual([key])
  })

  it('marks nothing on a page outside of the menu, and no account in local_single', () => {
    expect(current(reader, { kind: 'not-found', path: '/missing' })).toEqual([])
    expect(current(local, { kind: 'account' })).toEqual([])
    expect(current(guest, { kind: 'login' })).toEqual([])
  })
})
