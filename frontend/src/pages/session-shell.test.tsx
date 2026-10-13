import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../App'
import type { NavigationSnapshot, Route } from '../navigation'
import type { Session } from '../session'

const state = vi.hoisted(() => ({ snapshot: undefined as NavigationSnapshot | undefined, session: undefined as Session | undefined }))
vi.mock('../navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../navigation')>(), useNavigation: () => state.snapshot!,
}))
vi.mock('../session', async (importOriginal) => ({
  ...await importOriginal<typeof import('../session')>(), useSession: () => state.session!,
}))
// Every data screen is a marker: the shell is checked by which of them it mounts at all.
vi.mock('../pages/HealthPage', () => ({ default: () => <pre data-screen="health" /> }))
vi.mock('../features/catalog/CatalogPage', () => ({ default: () => <pre data-screen="catalog" /> }))
vi.mock('../features/catalog/CategoryPage', () => ({ default: () => <pre data-screen="category" /> }))
vi.mock('../features/product/ProductPage', () => ({ default: () => <pre data-screen="product" /> }))
vi.mock('../features/recognition', () => ({
  UploadPage: () => <pre data-screen="upload" />, JobsPage: () => <pre data-screen="jobs" />, JobPage: () => <pre data-screen="job" />,
}))
vi.mock('../features/receipts', () => ({ ReceiptsPage: () => <pre data-screen="receipts" />, ReceiptPage: () => <pre data-screen="receipt" /> }))
vi.mock('../features/merges', () => ({ MergesPage: () => <pre data-screen="merges" />, MergePage: () => <pre data-screen="merge" /> }))
vi.mock('../features/classification', () => ({ ClassificationPage: () => <pre data-screen="classification" /> }))
vi.mock('../features/dashboard', () => ({ DashboardPage: () => <pre data-screen="dashboard" />, LimitsPage: () => <pre data-screen="limits" /> }))
vi.mock('../features/stats', () => ({ SpendingPage: () => <pre data-screen="spending" />, ReceiptsStatsPage: () => <pre data-screen="receipts-stats" /> }))

const guest: Session = { kind: 'guest', expired: false }
const reader: Session = { kind: 'user', mode: 'accounts', user: { id: 1, username: 'synthetic-reader', is_staff: false }, household: null, permissions: { moderate_catalog: false } }
const moderator: Session = { kind: 'user', mode: 'accounts', user: { id: 2, username: 'synthetic-moderator', is_staff: false }, household: null, permissions: { moderate_catalog: true } }
const local: Session = { kind: 'user', mode: 'local_single', user: { id: 1, username: 'local', is_staff: false }, household: null, permissions: { moderate_catalog: true } }

/** Every data route with the address a person could open directly. */
const pages: [Route, string][] = [
  [{ kind: 'dashboard' }, '/'],
  [{ kind: 'dashboard', month: '2026-09' }, '/?month=2026-09'],
  [{ kind: 'limits' }, '/budget/limits'],
  [{ kind: 'catalog', query: { q: 'молоко', page: 2 } }, '/catalog?q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE&page=2'],
  [{ kind: 'category', categoryId: 3, query: { page: 1 } }, '/catalog/categories/3'],
  [{ kind: 'product', productId: 5, query: { currency: 'EUR', page: 1 } }, '/catalog/products/5?currency=EUR'],
  [{ kind: 'spending', query: { group_by: 'store' } }, '/stats?group_by=store'],
  [{ kind: 'receipts-stats', query: {} }, '/stats/receipts'],
  [{ kind: 'receipts', query: { store: 4, page: 1 } }, '/receipts?store=4'],
  [{ kind: 'upload' }, '/receipts/upload'],
  [{ kind: 'receipt', receiptId: 7 }, '/receipts/7'],
  [{ kind: 'jobs', query: { page: 1 } }, '/recognition/jobs'],
  [{ kind: 'job', jobId: 9 }, '/recognition/jobs/9'],
]
const moderated: [Route, string][] = [
  [{ kind: 'merges', query: { page: 1 } }, '/catalog/merges'],
  [{ kind: 'merge', groupId: 2 }, '/catalog/merges/2'],
  [{ kind: 'classification', query: { product: 5, page: 1 } }, '/catalog/classification?product=5'],
]
const other: [Route, string][] = [
  [{ kind: 'account' }, '/account'],
  [{ kind: 'not-found', path: '/missing' }, '/missing'],
  [{ kind: 'invalid-query', path: '/catalog', fields: ['page'], resetTo: '/catalog' }, '/catalog?page=0'],
]
const everywhere = [...pages, ...moderated, ...other]
const loginRoute: [Route, string] = [{ kind: 'login' }, '/login']
/** What only the application shell draws: the sign-in is shown without any of it. */
const shellParts = ['<header', 'brand-bar', 'main-navigation', '<nav', '<footer', 'skip-link', 'ck-theme-toggle', 'Доверяй, но проверяй чек']
/** The sign-in keeps one thing of the shell: the theme switch, drawn on the page and not on the header bar. */
const signInShellParts = [...shellParts.filter((part) => part !== 'ck-theme-toggle'), 'ck-theme-toggle-header']

function render(session: Session, route: Route, href: string) {
  state.session = session
  state.snapshot = { route, href }
  return renderToStaticMarkup(<App />)
}
const screens = (html: string) => (html.match(/<pre data-screen="[^"]*"/g) ?? []).map((item) => item.slice(18, -1))
const h1 = (html: string) => html.match(/<h1\b[^>]*>([^<]*)<\/h1>/)?.[1]
/** The pictures of the menu (the bottom bar of a phone) are left out: the words name the links. */
const noIcons = (html: string) => html.replace(/<svg\b.*?<\/svg>/g, '')
const mainNav = (html: string) => {
  const nav = noIcons(html).split('aria-label="Основная навигация">')[1].split('</nav>')[0]
  return [...nav.matchAll(/<a\b[^>]*>([^<]*)<\/a>/g)].map((match) => match[1])
}
const navLink = (html: string, text: string) => noIcons(html).match(new RegExp(`<a\\b[^>]*>${text}</a>`))?.[0] ?? ''
/** The links of the header row; «Добавить трату» lives in the «＋» sheet, which a server render draws closed. */
const fullMenu = ['Главная', 'Траты', 'Статистика', 'Платежи', 'Каталог', 'Обработка', 'Выгрузка', 'Состояние сервисов']

const fetchMock = vi.fn<typeof fetch>()
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { expect(fetchMock).not.toHaveBeenCalled(); vi.unstubAllGlobals() })

describe('session gate of the shell (SSR only, no browser interaction)', () => {
  it.each([...everywhere, loginRoute])('a guest at %j sees the sign-in alone on that very address: no shell and no data screen', (route, href) => {
    const html = render(guest, route, href)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(h1(html)).toBe('Вход')
    expect(screens(html)).toEqual([])
    expect(html).toContain('<label for="login-username">Имя пользователя</label>')
    expect(html.toLowerCase()).toContain('autocomplete="current-password"')
    expect(html).not.toContain('Сеанс завершён')
    // No redirect and no `next`: the address stays, so the page opens by itself after the sign-in.
    expect(html).not.toContain('next=')
    // Without the header, the menu and the footer; the only heading is the one the form is labelled by.
    for (const part of signInShellParts) expect(html, part).not.toContain(part)
    expect(html).toContain('<h1 id="page-heading" tabindex="-1">Вход</h1>')
    expect(html).toContain('<section class="ck-auth" aria-labelledby="page-heading">')
    // The only sign-in: the real form in the layout of the redesign, inside its own <main>, with the page theme switch.
    expect(html.match(/<main\b[^>]*>/g)).toEqual(['<main id="main" class="ck-login">'])
    expect(html.match(/<form\b/g)).toHaveLength(1)
    expect(html).toContain('data-auth-submit="true"')
    expect(html).not.toContain('Вход пока не подключён')
    expect(html.match(/<button\b[^>]*class="ck-theme-toggle[^"]*"/g)).toEqual(['<button type="button" class="ck-theme-toggle"'])
    expect(html.match(/<a\b/g)).toBeNull()
  })
  it('explains a session that ended in the middle of work', () => {
    const html = render({ kind: 'guest', expired: true }, { kind: 'receipt', receiptId: 7 }, '/receipts/7')
    expect(h1(html)).toBe('Вход')
    expect(html.split('Сеанс завершён. Войдите снова.')).toHaveLength(2)
    expect(screens(html)).toEqual([])
    for (const part of signInShellParts) expect(html, part).not.toContain(part)
  })
  it.each([...everywhere, loginRoute])('waits for «Я» at %j without mounting the page', (route, href) => {
    const html = render({ kind: 'loading' }, route, href)
    expect(h1(html)).toBe('Проверяем вход')
    expect(html).toContain('Проверяем вход…')
    expect(screens(html)).toEqual([])
    expect(mainNav(html)).toEqual(['Состояние сервисов'])
    expect(html).not.toContain('login-username')
  })
  it.each([...everywhere, loginRoute])('offers a retry at %j when «Я» could not be read', (route, href) => {
    const html = render({ kind: 'error' }, route, href)
    expect(h1(html)).toBe('Вход не проверен')
    expect(html).toContain('Не удалось проверить вход.')
    expect(html).toContain('data-request-retry="true"')
    expect(screens(html)).toEqual([])
    expect(mainNav(html)).toEqual(['Состояние сервисов'])
    expect(html).not.toContain('login-username')
  })
  it.each<[string, Session, string[]]>([
    ['loading', { kind: 'loading' }, ['Состояние сервисов']],
    ['error', { kind: 'error' }, ['Состояние сервисов']],
    ['guest', guest, ['Состояние сервисов', 'Войти']],
    ['guest after an ended session', { kind: 'guest', expired: true }, ['Состояние сервисов', 'Войти']],
    ['reader', reader, [...fullMenu, 'Семья', 'synthetic-reader']],
    ['moderator', moderator, [...fullMenu, 'Семья', 'synthetic-moderator']],
    ['local_single', local, fullMenu],
  ])('keeps health available for %s', (_name, session, menu) => {
    const html = render(session, { kind: 'health' }, '/health')
    expect(h1(html)).toBe('Состояние сервисов')
    expect(screens(html)).toEqual(['health'])
    expect(mainNav(html)).toEqual(menu)
    expect(navLink(html, 'Состояние сервисов')).toContain('aria-current="page"')
    // The only place where a guest sees the shell: its one sign-in link leads to the sign-in address.
    if (session.kind === 'guest') expect(navLink(html, 'Войти')).toBe('<a href="/login">Войти</a>')
    else expect(html).not.toContain('href="/login"')
    expect(html).toContain('<header class="brand-bar">')
    expect(html).not.toContain('login-username')
  })
})

describe('signed-in shell (SSR only, no browser interaction)', () => {
  it.each(pages)('opens %j for a reader', (route, href) => {
    const html = render(reader, route, href)
    expect(screens(html)).toEqual([route.kind])
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(mainNav(html)).toEqual([...fullMenu, 'Семья', 'synthetic-reader'])
    expect(navLink(html, 'synthetic-reader')).toBe('<a class="account-link" aria-label="Аккаунт: synthetic-reader" href="/account">synthetic-reader</a>')
    expect(html).not.toContain('login-username')
  })
  it('hides «Дубли» and «Категории» from a reader', () => {
    for (const [route, href] of pages) {
      const html = render(reader, route, href)
      expect(html).not.toContain('href="/catalog/merges"')
      expect(html).not.toContain('href="/catalog/classification"')
      expect(html).not.toContain('aria-label="Раздел каталога"')
    }
    expect(render(reader, { kind: 'spending', query: {} }, '/stats')).toContain('aria-label="Раздел статистики"')
  })
  it.each(moderated)('answers a reader at %j that the section belongs to the moderator, without the screen', (route, href) => {
    const html = render(reader, route, href)
    expect(screens(html)).toEqual([])
    expect(h1(html)).toBe('Раздел модератора каталога')
    expect(html.split('Раздел доступен модератору каталога')).toHaveLength(2)
    expect(html).toContain('<a class="action-link" href="/catalog">В каталог</a>')
    expect(html).not.toContain('href="/catalog/merges"')
    expect(html).not.toContain('href="/catalog/classification"')
    expect(html).not.toContain('login-username')
  })
  it.each(moderated)('opens %j for a moderator with the catalog subsections', (route, href) => {
    const html = render(moderator, route, href)
    expect(screens(html)).toEqual([route.kind])
    expect(html).toContain('aria-label="Раздел каталога"')
    expect(html).not.toContain('Раздел доступен модератору каталога')
  })
  it('offers «Снять чек» and «Добавить трату» behind «＋» of the menu to a signed-in person only', () => {
    for (const [route, href] of [[{ kind: 'catalog', query: { page: 1 } }, '/catalog'], [{ kind: 'upload' }, '/receipts/upload'], [{ kind: 'expense-new' }, '/receipts/new']] as const) {
      const html = render(reader, route, href)
      expect(html.match(/<div class="main-add">/g), route.kind).toHaveLength(1)
      // «Снять чек», «Из галереи» and «Добавить трату» are in the sheet (components/Sheet), closed until «＋» is pressed.
      expect(html).toContain('<button type="button" class="main-add-toggle" aria-haspopup="dialog" aria-expanded="false"')
      expect(html).not.toContain('role="dialog"')
      expect(html).toContain('class="ck-quick-shot-input"')
      // The floating stack of the former design is gone: its function lives in «＋».
      expect(html).not.toMatch(/ck-quick-(actions|expense)|class="ck-quick-shot"/)
    }
    expect(render(reader, { kind: 'expense-edit', receiptId: 9 }, '/receipts/9/edit')).toContain('Изменить трату</h1>')
    expect(render(guest, { kind: 'health' }, '/health')).not.toContain('main-add')
  })
  it('keeps the old jokes in the footer line only, with no eyebrow over the heading', () => {
    const html = render(reader, { kind: 'catalog', query: { page: 1 } }, '/catalog')
    expect(html).toContain('<footer>Чекист — семейный бюджет · Доверяй, но проверяй чек</footer>')
    expect(html).not.toContain('class="eyebrow"')
    expect(html).not.toContain('Совершенно несекретно')
    expect(html).toContain('<a class="brand" aria-label="Чекист — главная" href="/">')
  })
  it('shows the catalog subsections to a moderator on the catalog itself', () => {
    const html = render(moderator, { kind: 'catalog', query: { page: 1 } }, '/catalog')
    expect(html).toContain('<a href="/catalog/merges">Дубли</a>')
    expect(html).toContain('<a href="/catalog/classification">Категории</a>')
  })
  it('opens the account page with the name of the signed-in person', () => {
    for (const session of [reader, moderator]) {
      const html = render(session, { kind: 'account' }, '/account')
      const name = session.kind === 'user' ? session.user.username : ''
      expect(h1(html)).toBe('Аккаунт')
      expect(html).toContain(`data-auth-username="true">${name}</p>`)
      expect(html).toContain('data-auth-logout="true"')
      expect(html.toLowerCase()).toContain('autocomplete="new-password"')
      expect(navLink(html, name)).toContain('aria-current="page"')
      expect(screens(html)).toEqual([])
    }
  })
  it('mounts nothing at /login for a signed-in person: the shell sends them to «Главная»', () => {
    // The transition itself is a layout effect and is not run here; the person checks it by hand.
    for (const session of [reader, moderator]) {
      const html = render(session, { kind: 'login' }, '/login')
      expect(screens(html)).toEqual([])
      expect(html.match(/<h1\b/g)).toHaveLength(1)
      expect(html).not.toContain('login-username')
      expect(html).not.toContain('href="/login"')
      expect(html).toContain('<header class="brand-bar">')
    }
  })
  it('renders a name that looks like markup as text', () => {
    const tricky: Session = { kind: 'user', mode: 'accounts', user: { id: 3, username: '<i>x</i>', is_staff: false }, household: null, permissions: { moderate_catalog: false } }
    const html = render(tricky, { kind: 'catalog', query: { page: 1 } }, '/catalog')
    expect(noIcons(html)).toContain('aria-label="Аккаунт: &lt;i&gt;x&lt;/i&gt;" href="/account">&lt;i&gt;x&lt;/i&gt;</a>')
    expect(html).not.toContain('<i>x</i>')
  })
  it('keeps unknown and invalid addresses as before for a signed-in person', () => {
    expect(render(reader, { kind: 'not-found', path: '/missing' }, '/missing')).toContain('Такой страницы нет.')
    expect(render(reader, { kind: 'invalid-query', path: '/catalog', fields: ['page'], resetTo: '/catalog' }, '/catalog?page=0')).toContain('Сбросить параметры')
  })
})

describe('local_single keeps the previous interface (SSR only, no browser interaction)', () => {
  it.each([...pages, ...moderated])('opens %j with the full menu and nothing about accounts', (route, href) => {
    const html = render(local, route, href)
    expect(screens(html)).toEqual([route.kind])
    expect(mainNav(html)).toEqual(fullMenu)
    expect(html).not.toContain('href="/account"')
    expect(html).not.toContain('Войти')
    expect(html).not.toContain('Выйти')
    expect(html).not.toContain('login-username')
  })
  it('shows «Дубли» and «Категории» in the catalog', () => {
    const html = render(local, { kind: 'catalog', query: { page: 1 } }, '/catalog')
    expect(html).toContain('<a href="/catalog/merges">Дубли</a>')
    expect(html).toContain('<a href="/catalog/classification">Категории</a>')
  })
  it('has no sign-in address', () => {
    const html = render(local, { kind: 'login' }, '/login')
    expect(h1(html)).toBe('Страница не найдена')
    expect(html).toContain('Такой страницы нет.')
    expect(html).not.toContain('login-username')
    expect(mainNav(html)).toEqual(fullMenu)
  })
  it('has no account page', () => {
    const html = render(local, { kind: 'account' }, '/account')
    expect(h1(html)).toBe('Страница не найдена')
    expect(html).toContain('Такой страницы нет.')
    expect(html).not.toContain('data-auth-logout')
    expect(html.toLowerCase()).not.toContain('autocomplete="new-password"')
  })
})

describe('header row of a screen: «назад», the slots of a page, the heading, «✕» (SSR only; the pinning is CSS, checked by a person)', () => {
  const back = /<a class="ck-back ck-round" aria-label="([^"]*)" href="([^"]*)"><svg class="ck-icon" viewBox="0 0 24 24" width="20" height="20"/
  const slot = '<div class="intro-slot"></div>'
  /** The row up to its own end: after the heading come the slot of the page and, on a focus screen, «✕». */
  const intro = (html: string) => {
    const after = html.indexOf(`</h1>${slot}`) + `</h1>${slot}`.length
    return html.slice(html.indexOf('<div class="intro">'), html.indexOf('</div>', after) + 6)
  }

  it('leads a nested page back to its list, before the heading in the same row', () => {
    const html = render(reader, { kind: 'receipt', receiptId: 7 }, '/receipts/7')
    expect(intro(html)).toMatch(new RegExp(`^<div class="intro"><a class="ck-back ck-round" aria-label="Назад к тратам" href="/receipts"><svg[^>]*>.*</svg></a>${slot}<h1 id="page-heading" tabindex="-1">Чек</h1>${slot}</div>$`))
  })

  it('returns to the very list the person came from', () => {
    state.session = reader
    state.snapshot = { route: { kind: 'product', productId: 5, query: { page: 1 } }, href: '/catalog/products/5', returnTo: '/catalog/categories/4?page=3' }
    const html = renderToStaticMarkup(<App />)
    expect(back.exec(html)?.slice(1)).toEqual(['Назад к категории', '/catalog/categories/4?page=3'])
  })

  it('has no «назад» on a page of a section, nor in place of a page the person may not see', () => {
    for (const [route, href] of [[{ kind: 'dashboard' }, '/'], [{ kind: 'receipts', query: { page: 1 } }, '/receipts'], [{ kind: 'catalog', query: { page: 1 } }, '/catalog']] as const) {
      expect(render(reader, route, href)).not.toContain('ck-back')
    }
    // A merge group is a moderator's page: a reader sees the refusal of the shell and no way back into it.
    expect(render(reader, { kind: 'merge', groupId: 2 }, '/catalog/merges/2')).not.toContain('ck-back')
    expect(back.exec(render(moderator, { kind: 'merge', groupId: 2 }, '/catalog/merges/2'))?.slice(1)).toEqual(['Назад к дублям', '/catalog/merges'])
  })

  it('closes a focus screen with «✕» after the heading and no «назад»', () => {
    const fresh = intro(render(reader, { kind: 'expense-new' }, '/receipts/new'))
    expect(fresh).toMatch(new RegExp(`^<div class="intro">${slot}<h1 id="page-heading" tabindex="-1">Новая трата</h1>${slot}<a class="ck-close ck-round" aria-label="Закрыть" href="/"><svg[^>]*>.*</svg></a></div>$`))
    const edit = intro(render(reader, { kind: 'expense-edit', receiptId: 9 }, '/receipts/9/edit'))
    expect(edit).toContain('<h1 id="page-heading" tabindex="-1">Изменить трату</h1>')
    expect(edit).toContain('<a class="ck-close ck-round" aria-label="Закрыть" href="/receipts/9">')
    expect(edit).not.toContain('ck-back')
  })

  it('keeps the note of the health page out of the pinned row', () => {
    const html = render(reader, { kind: 'health' }, '/health')
    expect(intro(html)).not.toContain('intro-note')
    expect(html).toContain(`</h1>${slot}</div><p class="intro-note intro-note-after">Сводка о состоянии служб.</p>`)
  })
})
