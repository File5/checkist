import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { NavigationSnapshot } from '../navigation'
import { buildRoute } from '../navigation'
import type { NavigableRoute } from '../navigation'

const state = vi.hoisted(() => ({ snapshot: undefined as NavigationSnapshot | undefined }))
vi.mock('../navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../navigation')>(), useNavigation: () => state.snapshot!,
}))
// The shell is checked apart from what the screens show: their content belongs to the tests of features/stats.
vi.mock('../features/stats', () => ({
  SpendingPage: ({ query }: { query: unknown }) => <pre data-screen="spending">{JSON.stringify(query)}</pre>,
  ReceiptsStatsPage: ({ query }: { query: unknown }) => <pre data-screen="receipts-stats">{JSON.stringify(query)}</pre>,
}))

function render(route: NavigableRoute) {
  state.snapshot = { route, href: buildRoute(route) }
  return renderToStaticMarkup(<App />)
}

const activeLinks = (html: string) => html.match(/<a\b[^>]*aria-current="page"[^>]*>[^<]*/g) ?? []

describe('statistics section in the shell (SSR only, no browser interaction)', () => {
  it.each<[NavigableRoute, string, string, string]>([
    [{ kind: 'spending', query: {} }, 'Траты за период', 'Траты', '/stats'],
    [{ kind: 'receipts-stats', query: {} }, 'Средний чек', 'Средний чек', '/stats/receipts'],
  ])('mounts %j with the shell title, the active menu item and the active subsection', (route, title, section, href) => {
    const html = render(route)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain(`${title}</h1>`)
    expect(activeLinks(html)).toEqual([
      '<a aria-current="page" href="/stats">Статистика',
      `<a aria-current="page" href="${href}">${section}`,
    ])
    expect(html).toContain('aria-label="Раздел статистики"')
    expect(html.match(/<pre data-screen="[^"]*"/g)).toEqual([`<pre data-screen="${route.kind === 'spending' ? 'spending' : 'receipts-stats'}"`])
    expect(html).not.toContain('aria-label="Раздел каталога"')
  })
  it('keeps both subsections reachable as ordinary links', () => {
    const html = render({ kind: 'spending', query: {} })
    expect(html).toContain('<a href="/stats/receipts">Средний чек</a>')
    expect(render({ kind: 'receipts-stats', query: {} })).toContain('<a href="/stats">Траты</a>')
  })
  it('shows the menu item everywhere and the subsection only inside statistics', () => {
    for (const route of [{ kind: 'health' }, { kind: 'receipts', query: { page: 1 } }, { kind: 'merges', query: { page: 1 } }] as NavigableRoute[]) {
      const html = render(route)
      expect(html).toContain('<a href="/stats">Статистика</a>')
      expect(html).not.toContain('aria-label="Раздел статистики"')
    }
  })
  it('passes the parsed query of the address to the screen unchanged', () => {
    const screen = (html: string, name: string) => html.split(`<pre data-screen="${name}">`)[1]?.split('</pre>')[0].replaceAll('&quot;', '"')
    expect(screen(render({ kind: 'spending', query: {} }), 'spending')).toBe('{}')
    expect(screen(render({ kind: 'spending', query: { group_by: 'store', store: [3, 5] } }), 'spending')).toBe('{"group_by":"store","store":[3,5]}')
    expect(screen(render({ kind: 'receipts-stats', query: { base_from: '2020-01-01', interval: 'year' } }), 'receipts-stats'))
      .toBe('{"base_from":"2020-01-01","interval":"year"}')
  })
})
