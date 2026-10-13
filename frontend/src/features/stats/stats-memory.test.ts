import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseRoute } from '../../navigation'
import { rememberStats, STATS_MEMORY_KEY, statsMenuHref, statsTabHref } from './stats-memory'

/** A `localStorage` of one page; `broken` throws on every call, like a private window with blocked site data. */
function storage(broken = false) {
  const values = new Map<string, string>()
  const fail = () => { throw new DOMException('blocked', 'SecurityError') }
  return {
    values,
    getItem: (key: string) => (broken ? fail() : values.get(key) ?? null),
    setItem: (key: string, value: string) => { if (broken) fail(); values.set(key, value) },
  }
}
const use = (store: ReturnType<typeof storage>) => vi.stubGlobal('window', { localStorage: store })
const at = (href: string) => parseRoute(href)

afterEach(() => vi.unstubAllGlobals())

describe('what «Статистика» remembers on the device (stats-memory.ts)', () => {
  it('leads the menu and every tab to its bare address before anything is remembered', () => {
    use(storage())
    expect(statsMenuHref(at('/'))).toBe('/stats')
    expect(statsTabHref('trends')).toBe('/stats/trends')
    expect(statsTabHref('stats-incomes')).toBe('/stats/incomes')
  })

  it('opens the last tab as it was left, and every tab with its own last address', () => {
    const store = storage()
    use(store)
    rememberStats(at('/stats?date_from=2026-01-01&date_to=2026-12-31&group_by=store'))
    rememberStats(at('/stats/trends?from=2026-01&to=2026-10&category=3'))
    rememberStats(at('/'))
    expect(statsMenuHref(at('/'))).toBe('/stats/trends?from=2026-01&to=2026-10&category=3')
    expect(statsTabHref('spending')).toBe('/stats?date_from=2026-01-01&date_to=2026-12-31&group_by=store')
    expect(statsTabHref('receipts-stats')).toBe('/stats/receipts')
    expect(JSON.parse(store.values.get(STATS_MEMORY_KEY)!).tab).toBe('trends')
  })

  it('lets a shown statistics address win over the memory', () => {
    use(storage())
    rememberStats(at('/stats?group_by=store'))
    const shown = at('/stats?group_by=product')
    expect(statsMenuHref(shown)).toBe('/stats?group_by=product')
    expect(statsTabHref('spending', shown)).toBe('/stats?group_by=product')
    // «Сбросить» leads to the bare tab, and the bare tab is what is remembered next.
    rememberStats(at('/stats'))
    expect(statsMenuHref(at('/'))).toBe('/stats')
  })

  it('reads a stored address like a typed one: a foreign or broken one leads to the bare tab', () => {
    const store = storage()
    use(store)
    store.values.set(STATS_MEMORY_KEY, JSON.stringify({ tab: 'spending', hrefs: { spending: 'https://example.invalid/stats?group_by=store', trends: '/receipts', 'stats-incomes': 7 } }))
    expect(statsMenuHref(at('/'))).toBe('/stats')
    expect(statsTabHref('trends')).toBe('/stats/trends')
    expect(statsTabHref('stats-incomes')).toBe('/stats/incomes')
    store.values.set(STATS_MEMORY_KEY, '{not json')
    expect(statsMenuHref(at('/'))).toBe('/stats')
    store.values.set(STATS_MEMORY_KEY, JSON.stringify({ tab: 'health', hrefs: null }))
    expect(statsMenuHref(at('/'))).toBe('/stats')
  })

  it('works as before without storage', () => {
    use(storage(true))
    expect(() => rememberStats(at('/stats?group_by=store'))).not.toThrow()
    expect(statsMenuHref(at('/'))).toBe('/stats')
    vi.unstubAllGlobals()
    // No window at all: the server render of the shell.
    expect(() => rememberStats(at('/stats/receipts?interval=year'))).not.toThrow()
    expect(statsTabHref('receipts-stats')).toBe('/stats/receipts')
  })
})
