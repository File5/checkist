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

function render(route: NavigableRoute) {
  state.snapshot = { route, href: buildRoute(route) }
  return renderToStaticMarkup(<App />)
}

const activeLinks = (html: string) => html.match(/<a\b[^>]*aria-current="page"[^>]*>[^<]*/g) ?? []

describe('statistics section in the shell (SSR only, no browser interaction)', () => {
  it.each<[NavigableRoute, string, string, string, string]>([
    [{ kind: 'spending', query: {} }, 'Траты за период', 'Траты', '/stats', 'Загружаем траты…'],
    [{ kind: 'receipts-stats', query: {} }, 'Средний чек', 'Средний чек', '/stats/receipts', 'Раздел в разработке'],
  ])('mounts %j with the shell title, the active menu item and the active subsection', (route, title, section, href, content) => {
    const html = render(route)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain(`${title}</h1>`)
    expect(activeLinks(html)).toEqual([
      '<a aria-current="page" href="/stats">Статистика',
      `<a aria-current="page" href="${href}">${section}`,
    ])
    expect(html).toContain('aria-label="Раздел статистики"')
    expect(html).toContain(content)
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
  it('passes the parsed query to the screens without inventing data', () => {
    const plain = render({ kind: 'spending', query: {} })
    expect(plain).not.toContain('Сбросить фильтры')
    const filtered = render({ kind: 'spending', query: { group_by: 'store', store: [3, 5] } })
    // The spending screen starts loading: the filters of the address are in its form, no numbers yet.
    expect(filtered).toContain('Траты по магазинам</h2>')
    expect(filtered).toContain('Выбрано: 2 из 20 возможных.')
    expect(filtered).toContain('<button type="button" class="spending-secondary">Сбросить фильтры</button>')
    const receipts = render({ kind: 'receipts-stats', query: { base_from: '2020-01-01', interval: 'year' } })
    expect(receipts).toContain('Периоды и фильтры из адреса сохранены.')
    expect(receipts).toContain('<a class="action-link" href="/stats/receipts">Сбросить фильтры</a>')
    for (const html of [plain, filtered, receipts]) expect(html).not.toMatch(/<svg class="(?!brand-mark)|<table|EUR|\d+[,.]\d{2}/)
  })
})
