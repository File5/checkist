import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ApiFailure, Product } from '../../api/types'
import { category, categoryDetail, pageOf, product } from '../../api/test-support'
import type { CatalogRoute } from '../../navigation'
import { CatalogPage } from './CatalogPage'
import { CategoryPage } from './CategoryPage'
import CatalogError from './CatalogError'
import CatalogSearch from './CatalogSearch'
import { CategoryBreadcrumbs, CategoryLinks } from './CategoryLinks'
import ProductList from './ProductList'
import ProductsSection from './ProductsSection'

const route: CatalogRoute = { kind: 'category', categoryId: 2, query: { q: 'молоко', generic: 5, page: 3 } }
const noop = () => {}

describe('catalog HTML semantics (Node, not visual or interactive acceptance)', () => {
  it('page exports conform to F2 props, mount loading and do not create another h1', () => {
    for (const html of [renderToStaticMarkup(<CatalogPage query={{ page: 1 }} />),
      renderToStaticMarkup(<CategoryPage categoryId={2} query={{ page: 1 }} />)]) {
      expect(html).toContain('Загружаем')
      expect(html).not.toContain('<h1')
      expect(html).not.toContain('<main')
    }
  })
  it('links every product and represents absent metadata/history explicitly', () => {
    const missing: Product = { ...product, brand: null, package: null, prices: [], last_observed_at: null }
    const html = renderToStaticMarkup(<ProductList products={[missing]} />)
    expect(html).toContain('href="/catalog/products/9"')
    expect(html.match(/Не указано/g)).toHaveLength(2)
    expect(html).toContain('Обобщённый продукт')
    expect(html).toContain('Покупок пока нет')
    expect(html).toContain('Последняя покупка')
  })
  it('keeps country/currency/date pairs, zero and exact large Decimal values visible', () => {
    const prices: Product['prices'] = [
      { ...product.prices[0], country: 'DE', currency: 'EUR', last: { ...product.prices[0].last, paid_unit_price: '0.0000' } },
      { ...product.prices[0], country: 'RU', currency: 'RUB', last: { ...product.prices[0].last, paid_unit_price: '9999999999999999.1234', purchased_on: '2026-09-28' } },
    ]
    const html = renderToStaticMarkup(<ProductList products={[{ ...product, prices }]} />)
    expect(html).toContain('>0,00 EUR<')
    expect(html).toContain('9 999 999 999 999 999,12 RUB')
    expect(html).toContain('Страна: DE')
    expect(html).toContain('Страна: RU')
    expect(html).toContain('<time dateTime="2026-09-28">28.09.2026</time>')
    // Every price is in the unbreakable price element, every date inside <time>.
    expect(html.match(/<span class="ck-catalog-price">/g)).toHaveLength(2)
    expect(html.match(/<time dateTime=/g)).toHaveLength(2)
    expect(html).toMatch(/<dd><span class="ck-catalog-value">[^<]+<\/span><\/dd>/)
  })
  it('uses native lists for categories, branch counters and the server breadcrumb path', () => {
    const links = renderToStaticMarkup(<CategoryLinks categories={[{ ...category, products_count: 1, products_total: 12 }]} />)
    expect(links).toContain('<ul')
    expect(links).toContain('href="/catalog/categories/2"')
    expect(links).toContain('Товаров в ветви: 12')
    expect(links).not.toContain('role="tree"')
    const crumbs = renderToStaticMarkup(<CategoryBreadcrumbs path={category.path} />)
    expect(crumbs).toContain('aria-label="Хлебные крошки"')
    expect(crumbs).toContain('href="/catalog/categories/1"')
    expect(crumbs).toContain('aria-current="page">Молочные продукты')
  })
  it('labels native form fields, restores URL values and identifies 400 fields locally', () => {
    const error: ApiFailure = { kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['q', 'generic'] }
    const html = renderToStaticMarkup(<CatalogSearch route={route} generics={categoryDetail.generic_products} error={error} />)
    expect(html).toContain('<form')
    expect(html).toContain('type="submit">Найти')
    expect(html).toContain('name="q"')
    expect(html).toContain('value="молоко"')
    expect(html).toContain('value="5" selected')
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2)
    expect(html).toContain('Исправьте запрос')
    expect(html).toContain('Выберите обобщённый продукт')
    expect(html).toContain('Сбросить фильтры')
  })
  it('represents unknown generic URL filter without silently selecting all products', () => {
    const html = renderToStaticMarkup(<CatalogSearch route={{ ...route, query: { page: 1, generic: 999 } }} generics={[]} />)
    expect(html).toContain('value="999" selected')
    expect(html).toContain('отсутствует в этой категории')
  })
  it('400 does not offer retry, and invalid page recovery keeps active filters', () => {
    const invalid = renderToStaticMarkup(<CatalogError route={route} error={{ kind: 'error', reason: 'invalid_parameter', status: 400 }} onRetry={noop} />)
    expect(invalid).toContain('Сбросить фильтры')
    expect(invalid).not.toContain('Повторить')
    const page = renderToStaticMarkup(<CatalogError route={route} error={{ kind: 'error', reason: 'page_out_of_range', status: 404 }} onRetry={noop} />)
    expect(page).toContain('generic=5')
    expect(page).not.toContain('page=3')
    expect(page).toContain('На первую страницу')
  })
  it('missing categories provide a catalog link; network errors provide local retry', () => {
    const missing = renderToStaticMarkup(<CatalogError route={route} error={{ kind: 'error', reason: 'not_found', status: 404 }} onRetry={noop} />)
    expect(missing).toContain('Не найдено')
    expect(missing).toContain('href="/catalog"')
    const error = renderToStaticMarkup(<CatalogError route={route} error={{ kind: 'error', reason: 'network' }} onRetry={noop} />)
    expect(error).toContain('Повторить')
  })
  it('distinguishes empty branch from no matches, with reset only for active filters', () => {
    const state = { kind: 'ok' as const, data: pageOf<Product>([]) }
    const branch = renderToStaticMarkup(<ProductsSection route={{ ...route, query: { page: 1 } }} state={state} childrenCount={2} onRetry={noop} />)
    expect(branch).toContain('Выберите подкатегорию')
    expect(branch).not.toContain('Сбросить фильтры')
    const filtered = renderToStaticMarkup(<ProductsSection route={route} state={state} childrenCount={2} onRetry={noop} />)
    expect(filtered).toContain('Ничего не найдено')
    expect(filtered).toContain('href="/catalog/categories/2"')
    expect(filtered).toContain('Сбросить фильтры')
  })
  it('renders server counts and pagination with retained search/generic', () => {
    const state = { kind: 'ok' as const, data: { ...pageOf([product]), count: 120, page: 3, pages: 3 } }
    const html = renderToStaticMarkup(<ProductsSection route={route} state={state} onRetry={noop} />)
    expect(html).toContain('Найдено товаров: 120')
    expect(html).toContain('Страница 3 из 3')
    expect(html).toContain('generic=5&amp;page=2')
    expect(html).toContain('aria-current="page"')
  })
})
