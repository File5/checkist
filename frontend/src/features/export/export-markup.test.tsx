import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AccountView } from '../auth/AccountPage'
import { ExportView } from './ExportPage'
import type { ExportViewProps } from './ExportPage'
import type { ExportPreview } from './export-api'

const data: ExportPreview = {
  people: [{ username: 'andrey', display_name: 'Андрей' }, { username: 'liza', display_name: 'Лиза' }],
  stores: [{ id: 12, name: 'Magnum', city: 'Алматы', country: 'KZ' }],
  summary: { receipts_count: 2, lines_count: 5, max_receipts: 20000, currencies: [{ currency: 'KZT', receipts_count: 2, lines_count: 5, total: '5790.00' }] },
}

const noop = () => {}
const props = (patch: Partial<ExportViewProps> = {}): ExportViewProps => ({
  query: {}, today: '2026-10-12', preview: { kind: 'ok', data }, people: data.people, categories: [{ id: 3, name: 'Молочное', depth: 1, path: 'Продукты / Молочное' }],
  storeNames: new Map([[12, 'Magnum']]), storeSearch: '', storeResults: [], categoriesOpen: false, categorySearch: '',
  onChange: noop, onStoreSearch: noop, onRememberStore: noop, onCategoriesOpen: noop, onCategorySearch: noop, ...patch,
})
const render = (patch: Partial<ExportViewProps> = {}) => renderToStaticMarkup(<ExportView {...props(patch)} />)

describe('«Выгрузка» markup (Vitest/SSR, not browser visual acceptance)', () => {
  it('offers the period presets with «Этот месяц» chosen and its dates', () => {
    const html = render()
    for (const label of ['Этот месяц', 'Прошлый месяц', '3 месяца', 'Год', 'Всё время', 'Свой период']) expect(html).toContain(`>${label}</button>`)
    expect(html).toContain('<button type="button" class="ck-chip" aria-pressed="true">Этот месяц</button>')
    expect(html).toContain('<time dateTime="2026-10-01">01.10.2026</time>')
    expect(html).not.toContain('type="date"')
  })

  it('shows two date fields for «Свой период»', () => {
    const html = render({ query: { period: 'custom', from: '2026-09-01' } })
    expect(html.match(/type="date"/g)).toHaveLength(2)
    expect(html).toContain('value="2026-09-01"')
  })

  it('chips of sources and people, chosen ones pressed', () => {
    const html = render({ query: { source: ['statement'], owner: ['liza'] } })
    expect(html).toContain('<button type="button" class="ck-chip" aria-pressed="true">Выписки</button>')
    expect(html).toContain('<button type="button" class="ck-chip" aria-pressed="false">Чеки с фото</button>')
    expect(html).toContain('<button type="button" class="ck-chip" aria-pressed="true">Лиза</button>')
    expect(html).toContain('<button type="button" class="ck-chip" aria-pressed="false">Андрей</button>')
  })

  it('hides the people of a single person', () => {
    expect(render({ people: [data.people[0]] })).not.toContain('Кто добавил')
  })

  it('names chosen categories and stores, each with a way to remove it', () => {
    const html = render({ query: { category: [3, 99], store: [12, 40] } })
    expect(html).toContain('aria-label="Убрать: Продукты / Молочное"')
    expect(html).toContain('aria-label="Убрать: Категория №99"')
    expect(html).toContain('aria-label="Убрать: Magnum"')
    expect(html).toContain('aria-label="Убрать: Магазин №40"')
  })

  it('opens the category tree in a sheet with a search', () => {
    const html = render({ categoriesOpen: true })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('<ul class="export-tree" aria-label="Дерево категорий">')
    expect(html).toContain('type="search"')
  })

  it('lists sections with the defaults checked and media off', () => {
    const html = render()
    expect(html).toMatch(/<input type="checkbox" checked=""\/><span>Строки чеков<\/span>/)
    expect(html).toMatch(/<input type="checkbox"\/><span>Ссылки на фото<\/span>/)
  })

  it('says what will be exported in figures and links the file', () => {
    const html = render()
    expect(html).toContain('<p class="export-preview" aria-live="polite"><span>Будет выгружено: </span><span class="ck-figures">2 чека</span>')
    expect(html).toContain('<span class="ck-figures">5 790 ₸</span>')
    expect(html).toContain('<div class="export-actions ck-action-bar">')
    expect(html).toContain('href="/api/export/?from=2026-10-01&amp;to=2026-10-31&amp;include=receipts%2Clines%2Ccategories%2Cstores%2Climits%2Csummary&amp;download=1" download="">Скачать JSON</a>')
    expect(html).toContain('target="_blank" rel="noopener">Открыть</a>')
  })

  it('refuses a too large file and survives a failed count', () => {
    const large = render({ preview: { kind: 'ok', data: { ...data, summary: { ...data.summary, receipts_count: 20001 } } } })
    expect(large).toContain('role="alert"')
    expect(large).toContain('<button type="button" class="export-download" disabled="">Скачать JSON</button>')
    expect(large).not.toContain('Открыть</a>')
    const failed = render({ preview: { kind: 'error' } })
    expect(failed).toContain('Не удалось посчитать')
    expect(failed).toContain('Скачать JSON</a>')
  })
})

describe('«Выгрузка» styles', () => {
  const css = readFileSync(new URL('./Export.css', import.meta.url), 'utf8')

  it('uses tokens only and keeps touch targets', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).toMatch(/\.export-check \{[^}]*min-height: 44px/)
    expect(css).toMatch(/a\.export-download \{[^}]*min-height: 52px/)
    for (const size of css.match(/font-size: [^;]+/g) ?? []) expect(size).toMatch(/var\(--ck-text-/)
  })
})

describe('the way to «Выгрузка» from the account page', () => {
  it('links /export', () => {
    const html = renderToStaticMarkup(<AccountView username="andrey" password={{ kind: 'idle' }} values={{ current_password: '', new_password: '', repeat: '' }}
      onChange={noop} onPassword={noop} signOut={{ kind: 'idle' }} onSignOut={noop} />)
    expect(html).toContain('<h2 id="account-export-heading">Выгрузка данных</h2>')
    expect(html).toMatch(/<a [^>]*href="\/export"[^>]*>Выгрузить в JSON<\/a>/)
  })
})
