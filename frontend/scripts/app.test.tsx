import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NavigationSnapshot } from '../src/navigation'
import App from '../src/App'

const navigation = vi.hoisted(() => ({ snapshot: undefined as NavigationSnapshot | undefined }))
vi.mock('../src/navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/navigation')>(),
  useNavigation: () => navigation.snapshot,
}))

beforeEach(() => { navigation.snapshot = { href: '/catalog', route: { kind: 'catalog', query: { page: 1 } } } })

describe('App feature connections (Node server markup, not browser behavior)', () => {
  it('connects the catalog and passes the search query', () => {
    navigation.snapshot = { href: '/catalog?q=молоко&generic=42&page=2', route: { kind: 'catalog', query: { q: 'молоко', generic: 42, page: 2 } } }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('value="молоко"')
    expect(html).toContain('Выбран обобщённый продукт № 42')
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

  it('keeps invalid queries outside feature screens', () => {
    navigation.snapshot = { href: '/catalog?page=0', route: { kind: 'invalid-query', path: '/catalog', fields: ['page'], resetTo: '/catalog' } }
    const html = renderToStaticMarkup(<App />)
    expect(html).toContain('Сбросить параметры')
    expect(html).not.toContain('Загружаем товары…')
  })
})
