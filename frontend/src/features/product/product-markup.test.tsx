import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { history, point, store, total } from '../../api/test-support'
import type { PriceSummary as SummaryData } from '../../api/types'
import PriceHistory from './PriceHistory'
import PriceSummary from './PriceSummary'
import ProductPage from './ProductPage'

const noop = () => {}
const buildPageHref = (page: number) => ({ kind: 'product' as const, productId: 9, query: { country: 'DE', currency: 'EUR', page } })

describe('price content and semantic markup (SSR in Node, not browser acceptance)', () => {
  it('renders row prices, unknown normalization, UTC fallback and a keyboard scroll region', () => {
    const html = renderToStaticMarkup(<PriceHistory state={{ kind: 'ok', data: history }} query={{ page: 1 }} stores={[]} retry={noop} reset={noop} buildPageHref={buildPageHref} />)
    expect(html).toContain('<caption>Наблюдения покупок из чеков</caption>')
    expect(html.match(/scope="col"/g)).toHaveLength(6)
    expect(html).toContain('scope="row"')
    expect(html).toContain('role="region" aria-label="История цен по магазинам"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('Нет данных для пересчёта')
    expect(html).toContain('Не сопоставимо с базовой единицей товара')
    expect(html).toContain('-1,05 EUR/шт')
    expect(html).toContain('04.10.2026')
    expect(html).toContain('UTC')
    expect(html).toContain('Учебный магазин · DE')
  })
  it('uses store ID for address/timezone and the actual normalized unit, including metres', () => {
    const data = { ...history, results: [{ ...point, normalized_price: '12.3456', normalized_unit: 'm' as const }] }
    const html = renderToStaticMarkup(<PriceHistory state={{ kind: 'ok', data }} query={{ page: 1 }} stores={[store]} retry={noop} reset={noop} buildPageHref={buildPageHref} />)
    expect(html).toContain('Учебная улица, 1')
    expect(html).toContain('12,3456 EUR/м')
    expect(html).not.toContain('UTC')
  })
  it('distinguishes no purchases from no matches and offers page recovery', () => {
    const data = { ...history, results: [], count: 0, pages: 0 }
    const base = { stores: [], retry: noop, reset: noop, buildPageHref }
    const noPurchases = renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'ok', data }} query={{ page: 1 }} />)
    const noMatches = renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'ok', data }} query={{ page: 1, currency: 'RUB' }} />)
    expect(noPurchases).toContain('Покупок этого товара пока нет')
    expect(noMatches).toContain('Нет записей по выбранным фильтрам')
    expect(noMatches).toContain('Сбросить фильтры')
    const missingPage = renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'error', reason: 'page_out_of_range', status: 404 }} query={{ page: 999 }} />)
    expect(missingPage).toContain('На первую страницу')
    expect(missingPage).toContain('href="/catalog/products/9?country=DE&amp;currency=EUR"')
    expect(missingPage).not.toContain('Товар не найден')
  })
  it('preserves currency/unit/store summary groups and nullable change; displays server totals', () => {
    const data: SummaryData = { product: history.product, group_by: 'store', price: 'paid', interval: 'none', groups: [
      { store, currency: 'EUR', unit: 'pcs', total: { ...total, count: 123 }, buckets: [] },
      { store, currency: 'RUB', unit: 'kg', total, buckets: [] },
      { store: { ...store, id: 8, address: 'Учебная улица, 2' }, currency: 'EUR', unit: 'pcs', total: { ...total, change_percent: '-5.25' }, buckets: [] },
    ] }
    const html = renderToStaticMarkup(<PriceSummary state={{ kind: 'ok', data }} retry={noop} reset={noop} />)
    expect(html.match(/<li /g)).toHaveLength(3)
    expect(html).toContain('EUR / шт')
    expect(html).toContain('RUB / кг')
    expect(html).toContain('Учебная улица, 2')
    expect(html).toContain('123')
    expect(html).toContain('Нет данных для расчёта')
    expect(html).toContain('-5,25 %')
    expect(html).toContain('03.10.2026')
    expect(html).toContain('04.10.2026')
  })
  it('offers correction/reset for HTTP 400 and local retry for a transport error', () => {
    const correction = renderToStaticMarkup(<PriceSummary state={{ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['currency'] }} retry={noop} reset={noop} />)
    expect(correction).toContain('Исправьте отмеченные фильтры')
    expect(correction).toContain('Сбросить фильтры')
    expect(correction).not.toContain('Повторить</button>')
    const retry = renderToStaticMarkup(<PriceSummary state={{ kind: 'error', reason: 'network' }} retry={noop} reset={noop} />)
    expect(retry).toContain('Повторить</button>')
  })
  it('fits the F2 shell contract and declares all four independent loading blocks', () => {
    const html = renderToStaticMarkup(<ProductPage productId={9} query={{ page: 1 }} />)
    expect(html).not.toContain('<h1')
    expect(html).not.toContain('<main')
    for (const text of ['Загружаем карточку товара', 'Загружаем историю покупок', 'Загружаем сводку цен', 'Загружаем справочник магазинов']) expect(html).toContain(text)
    expect(html).toContain('Налоговая база цен не указана')
    expect(html).toContain('Скидка всего чека не распределена')
    expect(html).toContain('for="product-date_from"')
    expect(html).toContain('<label for="product-store-search">Найти магазин по названию или городу</label>')
  })
})
