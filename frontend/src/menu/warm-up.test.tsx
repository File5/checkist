import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { answerKey, forgetAnswers, remembersPath } from '../api/answer-cache'
import { dashboardFixture } from '../api/budget-test-support'
import DashboardPage from '../features/dashboard/DashboardPage'
import IncomeSummary from '../features/incomes/IncomeSummary'
import RecurringDue from '../features/recurring/RecurringDue'
import ReceiptsPage from '../features/receipts/ReceiptsPage'
import SpendingPage from '../features/stats/SpendingPage'
import { parseRoute } from '../navigation'
import type { Route } from '../navigation'
import type { Session } from '../session'
import { warmUp, warmUpTargets } from './warm-up'

// The effects run during the server render here: every screen starts its requests the way it does in a browser.
// An effect that needs a browser (window, document) is skipped; the requests of the screens need none.
vi.mock('react', async (importOriginal) => {
  const react = await importOriginal<typeof import('react')>()
  return {
    ...react,
    useEffect: (effect: () => unknown) => {
      try { effect() } catch { /* a browser-only effect */ }
    },
  }
})

const reader: Session = { kind: 'user', mode: 'accounts', user: { id: 1, username: 'synthetic-reader', is_staff: false }, household: null, permissions: { moderate_catalog: false } }
const fetchMock = vi.fn<typeof fetch>()
/** The keys of the memory of answers the requests so far would use. */
const keys = () => fetchMock.mock.calls.map(([url]) => String(url))
  .filter((url) => remembersPath(url.replace(/^\/api\//, '').split('?')[0]))
  .map(answerKey)
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
const month = dashboardFixture().month

/** What the screens ask when they are opened: never answered, so they stay as they first asked. */
async function screenKeys(...screens: ReactElement[]): Promise<string[]> {
  const found: string[] = []
  for (const screen of screens) {
    forgetAnswers()
    fetchMock.mockReset()
    fetchMock.mockImplementation(() => new Promise(() => {}))
    renderToStaticMarkup(screen)
    // Some screens start their reads a microtask after the effect.
    await new Promise((resolve) => { setTimeout(resolve, 0) })
    found.push(...keys())
  }
  return found
}
async function warmKeys(route: Route): Promise<string[]> {
  forgetAnswers()
  fetchMock.mockReset()
  fetchMock.mockImplementation(async (url) => json(String(url).startsWith('/api/dashboard/') ? dashboardFixture() : {}))
  await warmUp(reader, route)
  return keys()
}
const bar = (href: string) => parseRoute(href) as Route & { query: never }

beforeEach(() => { vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals(); forgetAnswers() })

describe('the warm-up of the bar screens', () => {
  it('asks exactly what «Главная», «Траты» and «Статистика» ask when they are opened', async () => {
    const warm = await warmKeys({ kind: 'catalog', query: { page: 1 } })
    const home = bar('/')
    const spends = bar('/receipts')
    const stats = bar('/stats')
    expect(home.kind).toBe('dashboard')
    expect(spends.kind).toBe('receipts')
    expect(stats.kind).toBe('spending')
    const screens = await screenKeys(
      <DashboardPage />,
      // «Главная» draws these two with the month of its answer.
      <IncomeSummary month={month} />,
      <RecurringDue month={month} />,
      <ReceiptsPage query={spends.query} />,
      <SpendingPage query={stats.query} />,
    )
    expect([...warm].sort()).toEqual([
      '/api/countries/',
      '/api/dashboard/',
      `/api/incomes/summary/?month=${month}`,
      '/api/receipts/?ordering=-purchased_at&page=1',
      `/api/recurring/?month=${month}`,
      '/api/stats/spending/',
      '/api/stores/?page_size=200',
    ])
    for (const key of warm) expect(screens, key).toContain(key)
  })

  it('leaves out the screen on view, and warms nothing for a guest', async () => {
    expect((await warmKeys(bar('/receipts'))).some((key) => key.startsWith('/api/receipts/'))).toBe(false)
    expect((await warmKeys(bar('/'))).some((key) => key.startsWith('/api/dashboard/'))).toBe(false)
    expect((await warmKeys(bar('/stats'))).some((key) => key.startsWith('/api/stats/'))).toBe(false)
    // Another month of «Главная» on view: the bar leads to the current one, which is warmed.
    expect(await warmKeys(bar('/?month=2026-09'))).toContain('/api/dashboard/')
    forgetAnswers()
    fetchMock.mockReset()
    await warmUp({ kind: 'guest', expired: false }, { kind: 'catalog', query: { page: 1 } })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names the three screens of the bar as the targets', () => {
    expect(warmUpTargets(reader, { kind: 'catalog', query: { page: 1 } }).map((route) => route.kind)).toEqual(['dashboard', 'receipts', 'spending'])
  })
})
