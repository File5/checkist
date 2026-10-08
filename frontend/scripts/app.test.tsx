import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NavigationSnapshot } from '../src/navigation'
import App from '../src/App'

const navigation = vi.hoisted(() => ({ snapshot: undefined as NavigationSnapshot | undefined }))
vi.mock('../src/navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/navigation')>(),
  useNavigation: () => navigation.snapshot,
}))
// The shell needs to know who works: these tests check the unchanged interface of local_single.
vi.mock('../src/session', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/session')>(),
  useSession: () => ({ kind: 'user', mode: 'local_single', user: { id: 1, username: 'local', is_staff: false }, permissions: { moderate_catalog: true } }),
}))

beforeEach(() => { navigation.snapshot = { href: '/catalog', route: { kind: 'catalog', query: { page: 1 } } } })

describe('App feature connections (Node server markup, not browser behavior)', () => {
  it('connects the catalog and passes the search query', () => {
    navigation.snapshot = { href: '/catalog?q=молоко&generic=42&page=2', route: { kind: 'catalog', query: { q: 'молоко', generic: 42, page: 2 } } }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('value="молоко"')
    expect(html).toContain('Выбран обобщённый продукт №42.')
    expect(html).toContain('Загружаем категории…')
    expect(html).toContain('Загружаем товары…')
    expect(html.match(/<h1\b/g)).toHaveLength(1)
  })

  it('connects the category request screen', () => {
    navigation.snapshot = { href: '/catalog/categories/42', route: { kind: 'category', categoryId: 42, query: { page: 1 } } }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Загружаем категорию…')
    expect(html).not.toContain('Экран категории будет подключён')
  })

  it('connects independent product sections and preserves the original list URL', () => {
    navigation.snapshot = { href: '/catalog/products/73?currency=EUR&page=2',
      route: { kind: 'product', productId: 73, query: { currency: 'EUR', page: 2 } },
      returnTo: '/catalog/categories/42?q=milk&generic=17&page=3' }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Загружаем карточку товара…')
    expect(html).toContain('Загружаем историю покупок…')
    expect(html).toContain('id="product-history-heading" tabindex="-1"')
    expect(html).toContain('Загружаем сводку цен…')
    expect(html).toContain('href="/catalog/categories/42?q=milk&amp;generic=17&amp;page=3"')
    expect(html).toContain('<option value="EUR" selected="">EUR</option>')
    expect(html.match(/<h1\b/g)).toHaveLength(1)
  })

  it('offers the catalog exit on direct product entry', () => {
    navigation.snapshot = { href: '/catalog/products/73', route: { kind: 'product', productId: 73, query: { page: 1 } } }
    expect(renderToStaticMarkup(<App />)).toContain('href="/catalog"')
  })

  it('keeps health available independently', () => {
    navigation.snapshot = { href: '/health', route: { kind: 'health' } }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Проверяем соединение…')
    expect(html).toContain('Ручное исправление распознанных данных')
    expect(html).not.toContain('База данных фото чеков')
    expect(html).not.toContain('Распознавание магазина и адреса, товаров и их стоимостей')
  })

  it('draws the header bar with the brand, five sections and the theme switch; local_single has no sign-in link', () => {
    const html = renderToStaticMarkup(<App />)
    const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'))
    expect(header).toContain('<span>Чекист</span>')
    expect(header).toMatch(/<img class="brand-mark" src="[^"]*emblem-96[^"]*" srcSet="[^"]*emblem-96[^"]* 1x, [^"]*emblem-192[^"]* 2x" width="44" height="44" alt=""\/>/)
    expect(header.match(/<a\b[^>]*href="[^"]*"/g)).toEqual([
      '<a class="brand" aria-label="Чекист — каталог" href="/catalog"', '<a aria-current="page" href="/catalog"',
      '<a href="/receipts"', '<a href="/stats"', '<a href="/recognition/jobs"', '<a href="/health"',
    ])
    expect(html).not.toContain('href="/login"')
    expect(header.match(/<button\b[^>]*class="ck-theme-toggle ck-theme-toggle-header"/g)).toHaveLength(1)
    expect(html).toContain('<a class="skip-link" href="#page-heading">К содержимому</a>')
    expect(html).toContain('<h1 id="page-heading" tabindex="-1">Каталог продуктов</h1>')
  })

  it('has no sign-in address in local_single: /login is a missing page inside the shell', () => {
    // The sign-in itself, drawn without the shell, is checked in src/pages/session-shell.test.tsx.
    navigation.snapshot = { href: '/login', route: { kind: 'login' } }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Страница не найдена</h1>')
    expect(html).toContain('<header class="brand-bar">')
    for (const part of ['ck-login', 'ck-auth', 'login-username']) expect(html, part).not.toContain(part)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
  })

  it('keeps the old text of the missing page and adds one line under it', () => {
    navigation.snapshot = { href: '/missing', route: { kind: 'not-found', path: '/missing' } }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('<p>Такой страницы нет. Перейдите в каталог продуктов.</p>')
    expect(html).toContain('<p class="request-state-note">Наружное наблюдение результатов не дало.</p><a class="action-link" href="/catalog">В каталог</a>')
    expect(html).toContain('Страница не найдена</h1>')
  })

  it('keeps invalid queries outside feature screens', () => {
    navigation.snapshot = { href: '/catalog?page=0', route: { kind: 'invalid-query', path: '/catalog', fields: ['page'], resetTo: '/catalog' } }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Сбросить параметры')
    expect(html).not.toContain('Загружаем товары…')
  })
})
