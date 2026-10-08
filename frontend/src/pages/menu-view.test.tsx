import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import { menuScrollLeft } from '../menu-view'
import type { NavigationSnapshot, Route } from '../navigation'
import type { Session } from '../session'

const state = vi.hoisted(() => ({
  snapshot: undefined as NavigationSnapshot | undefined, session: undefined as Session | undefined, keys: [] as string[],
}))
vi.mock('../navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../navigation')>(), useNavigation: () => state.snapshot!,
}))
vi.mock('../session', async (importOriginal) => ({
  ...await importOriginal<typeof import('../session')>(), useSession: () => state.session!,
}))
// The effect itself needs a browser. What is checked here is the key the shell hands to it:
// the effect runs again exactly when this key changes.
vi.mock('../menu-view', async (importOriginal) => ({
  ...await importOriginal<typeof import('../menu-view')>(),
  useCurrentItemInView: (key: string) => { state.keys.push(key); return { current: null } },
}))
vi.mock('../pages/HealthPage', () => ({ default: () => null }))
vi.mock('../features/catalog/CatalogPage', () => ({ default: () => null }))
vi.mock('../features/catalog/CategoryPage', () => ({ default: () => null }))
vi.mock('../features/product/ProductPage', () => ({ default: () => null }))
vi.mock('../features/recognition', () => ({ UploadPage: () => null, JobsPage: () => null, JobPage: () => null }))
vi.mock('../features/receipts', () => ({ ReceiptsPage: () => null, ReceiptPage: () => null }))
vi.mock('../features/merges', () => ({ MergesPage: () => null, MergePage: () => null }))
vi.mock('../features/classification', () => ({ ClassificationPage: () => null }))
vi.mock('../features/stats', () => ({ SpendingPage: () => null, ReceiptsStatsPage: () => null }))

const loading: Session = { kind: 'loading' }
const failed: Session = { kind: 'error' }
const guest: Session = { kind: 'guest', expired: false }
const reader: Session = { kind: 'user', mode: 'accounts', user: { id: 1, username: 'synthetic-reader', is_staff: false }, permissions: { moderate_catalog: false } }
const moderator: Session = { kind: 'user', mode: 'accounts', user: { id: 2, username: 'synthetic-moderator', is_staff: false }, permissions: { moderate_catalog: true } }
const local: Session = { kind: 'user', mode: 'local_single', user: { id: 1, username: 'local', is_staff: false }, permissions: { moderate_catalog: true } }
const sessions = [loading, failed, guest, { kind: 'guest', expired: true } as Session, reader, moderator, local]

const routes: [Route, string][] = [
  [{ kind: 'catalog', query: { page: 1 } }, '/catalog'],
  [{ kind: 'category', categoryId: 3, query: { page: 1 } }, '/catalog/categories/3'],
  [{ kind: 'product', productId: 5, query: { page: 1 } }, '/catalog/products/5'],
  [{ kind: 'merges', query: { page: 1 } }, '/catalog/merges'],
  [{ kind: 'classification', query: { page: 1 } }, '/catalog/classification'],
  [{ kind: 'spending', query: {} }, '/stats'],
  [{ kind: 'receipts-stats', query: {} }, '/stats/receipts'],
  [{ kind: 'receipts', query: { page: 1 } }, '/receipts'],
  [{ kind: 'upload' }, '/receipts/upload'],
  [{ kind: 'receipt', receiptId: 7 }, '/receipts/7'],
  [{ kind: 'jobs', query: { page: 1 } }, '/recognition/jobs'],
  [{ kind: 'job', jobId: 9 }, '/recognition/jobs/9'],
  [{ kind: 'health' }, '/health'],
  [{ kind: 'account' }, '/account'],
  [{ kind: 'login' }, '/login'],
  [{ kind: 'not-found', path: '/missing' }, '/missing'],
]
const narrow: [string, Route, string][] = [
  ['the name of the person', { kind: 'account' }, '/account'],
  ['«Обработка»', { kind: 'jobs', query: { page: 1 } }, '/recognition/jobs'],
  ['«Состояние сервисов»', { kind: 'health' }, '/health'],
]

/** One render of the shell: the markup of the header menu (nothing for the sign-in) and the key given to the effect. */
function render(session: Session, route: Route, href: string) {
  state.session = session
  state.snapshot = { route, href }
  state.keys = []
  const html = renderToStaticMarkup(<App />)
  expect(state.keys).toHaveLength(1)
  const menu = html.split('aria-label="Основная навигация">')[1]?.split('</nav>')[0]
  return { key: state.keys[0], menu }
}

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { expect(fetchMock).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

describe('current item of the header menu is brought into view again (SSR only, the scroll itself is checked by a person)', () => {
  it.each(narrow)('when «Я» is read on the same address: %s', (_item, route, href) => {
    const before = render(loading, route, href)
    const after = render(reader, route, href)
    expect(after.menu).toContain('aria-current="page"')
    expect(after.menu).not.toBe(before.menu)
    expect(after.key).not.toBe(before.key)
  })

  it.each(narrow.slice(0, 2))('after the sign-in on the same address, from the screen without the header: %s', (_item, route, href) => {
    const before = render(guest, route, href)
    expect(before.menu).toBeUndefined()
    const after = render(reader, route, href)
    expect(after.menu).toContain('aria-current="page"')
    expect(after.key).not.toBe(before.key)
  })

  it('after the sign-in of a guest who stood on the health page', () => {
    const before = render(guest, { kind: 'health' }, '/health')
    const after = render(reader, { kind: 'health' }, '/health')
    expect(after.menu).not.toBe(before.menu)
    expect(after.key).not.toBe(before.key)
  })

  it('when a retry reads «Я» after a failure, and when another person appears on the same address', () => {
    const route: Route = { kind: 'account' }
    expect(render(reader, route, '/account').key).not.toBe(render(failed, route, '/account').key)
    expect(render(moderator, route, '/account').key).not.toBe(render(reader, route, '/account').key)
  })

  it('on a transition to another section, as before', () => {
    expect(render(reader, { kind: 'jobs', query: { page: 1 } }, '/recognition/jobs').key)
      .not.toBe(render(reader, { kind: 'catalog', query: { page: 1 } }, '/catalog').key)
  })

  it('never keeps the key while the menu changes: every state of the session at every address', () => {
    const menus = new Map<string, string | undefined>()
    for (const session of sessions) for (const [route, href] of routes) {
      const { key, menu } = render(session, route, href)
      if (menus.has(key)) expect(menu, `${session.kind} ${href}`).toBe(menus.get(key))
      else menus.set(key, menu)
    }
    expect(menus.size).toBeGreaterThan(routes.length)
  })

  it('does not run again when only the query or the item of a list changes', () => {
    const first = render(reader, { kind: 'catalog', query: { page: 1 } }, '/catalog')
    expect(render(reader, { kind: 'catalog', query: { q: 'молоко', page: 2 } }, '/catalog?q=%D0%BC&page=2').key).toBe(first.key)
    expect(render(reader, { kind: 'receipt', receiptId: 8 }, '/receipts/8').key).toBe(render(reader, { kind: 'receipt', receiptId: 7 }, '/receipts/7').key)
  })
})

describe('scroll position of the header menu (arithmetic only)', () => {
  it('leaves the row alone when it fits', () => {
    expect(menuScrollLeft({ itemStart: 300, itemWidth: 120, viewWidth: 600, rowWidth: 600 })).toBeUndefined()
    expect(menuScrollLeft({ itemStart: 300, itemWidth: 120, viewWidth: 600, rowWidth: 420 })).toBeUndefined()
  })

  it('puts the current item in the middle of the visible part', () => {
    // 320 px wide: the item spans 400…500 of the row, the view becomes 290…610.
    expect(menuScrollLeft({ itemStart: 400, itemWidth: 100, viewWidth: 320, rowWidth: 900 })).toBe(290)
  })

  it('stays within the row for the first and the last item', () => {
    expect(menuScrollLeft({ itemStart: 0, itemWidth: 90, viewWidth: 320, rowWidth: 700 })).toBe(0)
    // The name of the person is the last item: the row is scrolled to its end, the name is whole in view.
    expect(menuScrollLeft({ itemStart: 560, itemWidth: 140, viewWidth: 320, rowWidth: 700 })).toBe(380)
  })

  it('shows the start of an item that is wider than the view no further than the row allows', () => {
    expect(menuScrollLeft({ itemStart: 300, itemWidth: 400, viewWidth: 320, rowWidth: 700 })).toBe(340)
  })
})
