import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CountryEntry } from '../../api/countries'
import { statsFixture } from '../../api/stats-test-support'
import type { Spending } from '../../api/stats'
import type { Page, StoreEntry } from '../../api/types'
import type { SpendingQuery } from '../../navigation'
import type { SpendingReference } from './spending-filters'
import { PeriodText } from './period'
import { SpendingView } from './SpendingPage'
import type { SpendingViewProps } from './SpendingPage'
import type { SpendingRequestState } from './spending-state'
import { shortAnswer } from './spending-tail-test-support'

const read = (name: string) => statsFixture(name) as Spending
const noop = () => {}
const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replaceAll(' ', ' ').replace(/\s+/g, ' ')

const countries: CountryEntry[] = [
  { code: 'DE', name: 'Германия', currencies: ['EUR'], stores_count: 2, products_count: 30 },
  { code: 'KZ', name: 'Казахстан', currencies: ['KZT'], stores_count: 1, products_count: 9 },
]
const store = (id: number, name: string, city: string, country: string): StoreEntry =>
  ({ id, name, city, country, address: '', timezone: 'Europe/Berlin', receipts_count: 1 })
const stores: Page<StoreEntry> = { count: 3, page: 1, page_size: 200, pages: 1, results: [
  store(1, 'Zahlenfrisch', 'Musterstadt', 'DE'), store(2, 'Beispielkorb', 'Beispielhausen', 'DE'), store(3, 'Статмаркет', 'Алматы', 'KZ'),
] }
const reference: SpendingReference = { countries: { kind: 'ok', data: { results: countries } }, stores: { kind: 'ok', data: stores }, retry: noop }
const ok = (name: string): SpendingRequestState => ({ kind: 'ok', data: read(name) })
const render = (query: SpendingQuery, state: SpendingRequestState, props: Partial<SpendingViewProps> = {}) =>
  renderToStaticMarkup(<SpendingView query={query} state={state} retry={noop} reference={reference} today="2026-10-07" {...props} />)

describe('spending screen markup (Vitest/SSR — not what the browser shows, focuses or animates)', () => {
  it('shows a block per currency with the total, the chart and the table of the same numbers', () => {
    const html = render({}, ok('spending-category.json'))
    expect(count(html, /<section class="spending-currency"/g)).toBe(2)
    expect(count(html, /<svg class="ck-pie-svg"/g)).toBe(2)
    expect(count(html, /<table class="ck-pie-legend"/g)).toBe(2)
    expect(html).toContain('<caption>Траты по категориям, EUR</caption>')
    expect(html).toContain('<caption>Траты по категориям, KZT</caption>')
    const plain = text(html)
    expect(plain).toContain('Итого по чекам 13 041,07 EUR')
    expect(plain).toContain('Чеков 373 чека')
    expect(plain).toContain('Итого по чекам 438 091,92 KZT')
    expect(plain).toContain('Продукты питания 2 240 строк · 372 чека. 5 590,75 EUR 42,73 %')
    expect(plain).toContain('Суммы в разных валютах не складываются и не пересчитываются')
    expect(plain).toContain('разница — -42,59 EUR')
    expect(plain).toContain('Категорию и обобщённый продукт товару назначают в админке.')
    expect(plain).toContain('Период: всё время.')
    expect(html).not.toContain('aria-busy="true"')
    // 6 rows are drawn in EUR and 3 in KZT; every one is also a table row.
    expect(count(html, /<g class="ck-pie-slice /g)).toBe(9)
    expect(count(html, /<tr><th scope="row">/g)).toBe(9)
  })
  it('makes a category a link in the chart and in the table, and keeps special rows plain', () => {
    const html = render({ country: 'DE' }, ok('spending-category.json'))
    // One sector link and one table link in each of the two currency blocks.
    expect(count(html, / href="\/stats\?country=DE&amp;category=1"/g)).toBe(4)
    expect(count(html, /<a class="ck-pie-link" tabindex="-1" href="\/stats\?country=DE&amp;category=1">/g)).toBe(2)
    expect(html).toContain('<a href="/stats?country=DE&amp;category=1">Продукты питания</a>')
    expect(html).not.toMatch(/<a [^>]*>Строки без товара/)
    expect(html).not.toMatch(/<a [^>]*>(Услуги|Залог за тару)/)
  })
  it('names the period of the answer with whole dates and one dash that never starts a line', () => {
    const period = (date_from: string | null, date_to: string | null) => renderToStaticMarkup(<PeriodText period={{ date_from, date_to }} />)
    expect(period(null, null)).toBe('Период: всё время.')
    // A non-breaking space before the dash and an ordinary one after it; each date is a `<time>`, which never wraps.
    expect(period('2026-01-01', '2026-09-30')).toBe('Период: <time dateTime="2026-01-01">01.01.2026</time>\u00a0— <time dateTime="2026-09-30">30.09.2026</time>, обе даты включительно.')
    expect(period('2026-01-01', null)).toBe('Период: с <time dateTime="2026-01-01">01.01.2026</time> включительно.')
    expect(period(null, '2026-09-30')).toBe('Период: по <time dateTime="2026-09-30">30.09.2026</time> включительно.')
  })
  it('offers the four breakdowns as links of the same filters', () => {
    const html = render({ date_from: '2026-01-01', group_by: 'product' }, ok('spending-product.json'))
    expect(html).toContain('<nav aria-label="Разбивка трат">')
    expect(html).toContain('<a href="/stats?date_from=2026-01-01">Категории</a>')
    expect(html).toContain('<a href="/stats?date_from=2026-01-01&amp;group_by=generic">Обобщённые продукты</a>')
    expect(html).toContain('<a aria-current="true" href="/stats?date_from=2026-01-01&amp;group_by=product">Товары</a>')
    expect(html).toContain('<a href="/stats?date_from=2026-01-01&amp;group_by=store">Магазины</a>')
    expect(html).toMatch(/<h2 [^>]*data-request-focus-target[^>]*>Траты по товарам<\/h2>/)
    expect(html).toContain('<a href="/catalog/products/24">Demo Hähnchenbrust 600g</a>')
    expect(text(html)).toContain('Прочее Ещё 25 товаров с меньшими суммами, одной строкой. Показать состав 1 200,33 EUR 73,17 %')
    expect(html).toContain('Период: <time dateTime="2026-01-01">01.01.2026</time>\u00a0— <time dateTime="2026-09-30">30.09.2026</time>, обе даты включительно.')
    expect(html).not.toContain('aria-label="Путь в тратах"')
  })
  it('shows the way back inside a category', () => {
    const html = render({ category: 1, currency: 'EUR' }, ok('spending-category-drilldown.json'))
    expect(html).toContain('<nav class="spending-path" aria-label="Путь в тратах">')
    expect(html).toContain('<li><a href="/stats?currency=EUR">Все траты</a></li><li><span aria-current="page">Продукты питания</span></li>')
    expect(html).toContain('<a class="action-link" href="/stats?currency=EUR">На уровень выше</a>')
    expect(html).toContain('<a href="/stats?currency=EUR&amp;group_by=generic&amp;category=1">Продукты питания: товары без подкатегории</a>')
    const plain = text(html)
    expect(plain).toContain('Сумма строк товаров 5 590,75 EUR')
    expect(plain).toContain('сумма чеков и её разница с суммой строк не показываются')
    expect(plain).not.toContain('Итого по чекам')
  })
  it('names the generic product of the filter once it is known', () => {
    const query: SpendingQuery = { generic: 1, group_by: 'product' }
    expect(render(query, ok('spending-generic-filter.json'), { genericName: 'Молоко' })).toContain('<span aria-current="page">Молоко</span>')
    expect(render(query, ok('spending-generic-filter.json'))).toContain('<span aria-current="page">Обобщённый продукт №1</span>')
  })
  it('keeps an amount that is not positive in the table only, with a mark', () => {
    const html = render({ date_from: '2026-03-14', date_to: '2026-03-14' }, ok('spending-refund-day.json'))
    expect(html).not.toContain('<svg class="ck-pie-svg"')
    const plain = text(html)
    expect(plain).toContain('Положительных сумм нет, диаграмма не построена.')
    expect(plain).toContain('Сумма не положительная: в диаграмму не входит, доля не считается.')
    expect(plain).toContain('-7,14 EUR —')
  })

  it('reserves the block while the first answer loads', () => {
    const html = render({}, { kind: 'loading' })
    expect(html).toMatch(/<section class="spending-panel" aria-labelledby="[^"]+" aria-busy="true">/)
    expect(html).toContain('<div class="request-state request-state-loading" aria-live="polite" aria-busy="true"><p>Загружаем траты…</p></div>')
    expect(html).toContain('<p class="spending-status" role="status"></p>')
    expect(html).not.toContain('spending-currency')
    // The filters and the breakdown switch are usable meanwhile.
    expect(html).toContain('Применить фильтры')
    expect(html).toContain('<a href="/stats?group_by=store">Магазины</a>')
  })
  it('keeps the previous answer in place, marked busy, while new filters load', () => {
    const last = { query: {}, data: read('spending-category.json') }
    const html = render({ group_by: 'store' }, { kind: 'loading' }, { last })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('<div class="spending-blocks" data-stale="true">')
    expect(html).toContain('<p class="spending-status" role="status">Обновляем данные по новым фильтрам…</p>')
    expect(html).not.toContain('request-state-loading')
    // Still the answer of the previous filters: its own caption and its own links.
    expect(html).toContain('<caption>Траты по категориям, EUR</caption>')
    expect(html).toContain('<a href="/stats?category=1">Продукты питания</a>')
    expect(html).toMatch(/<h2 [^>]*>Траты по магазинам<\/h2>/)
  })
  it('tells an empty base from filters without results and offers the fitting way out', () => {
    const empty: SpendingRequestState = { kind: 'ok', data: { ...read('spending-empty.json'), date_from: null, date_to: null } }
    const none = render({}, empty)
    expect(none).toContain('Чеков пока нет: статистике не из чего считать. Загрузите первое фото чека.')
    expect(none).toContain('<a class="action-link" href="/receipts/upload">Загрузить фото</a>')
    expect(none).not.toContain('По выбранным фильтрам')
    const filtered = render({ date_from: '2018-01-01', date_to: '2018-12-31', group_by: 'store' }, ok('spending-empty.json'))
    expect(filtered).toContain('По выбранным фильтрам трат нет.')
    expect(filtered).toContain('<a class="action-link" href="/stats?group_by=store">Сбросить фильтры</a>')
    expect(filtered).toContain('<button type="button" class="spending-secondary">Сбросить фильтры</button>')
    for (const html of [none, filtered]) expect(html).not.toMatch(/<svg|<table|spending-currency/)
  })
  it('offers a retry after a failure that can pass', () => {
    for (const reason of ['network', 'timeout', 'database_unavailable', 'invalid_response'] as const) {
      const html = render({}, { kind: 'error', reason })
      expect(html).toContain('request-state-error')
      expect(html).toContain('<button type="button" data-request-retry="true">Повторить</button>')
      expect(html).not.toContain('spending-currency')
    }
    expect(render({}, { kind: 'error', reason: 'network' })).toContain('Не удалось связаться с сервером.')
  })
  it('explains a switched-off local mode without a retry button', () => {
    const html = render({ country: 'DE' }, { kind: 'error', reason: 'permission_denied', status: 403 })
    expect(html).toContain('Локальный режим выключен: статистика трат недоступна.')
    expect(html).not.toContain('data-request-retry')
    expect(html).not.toContain('request-state-action')
    expect(html).not.toContain('Доступ запрещён')
  })
  it('marks the fields the server refused and never prints its message', () => {
    const html = render({ country: 'ZZ', store: [404] }, { kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['country', 'store'] })
    expect(html).toMatch(/<select [^>]*name="country"[^>]*aria-invalid="true"/)
    expect(html).toMatch(/<select [^>]*name="currency"[^>]*aria-invalid="false"/)
    expect(html).toContain('Выберите страну из списка или уберите фильтр страны.')
    expect(html).toContain('Выберите существующие магазины, не больше 20, или уберите фильтр магазинов.')
    expect(html).toContain('<p class="spending-field-error" role="alert">Исправьте отмеченные фильтры.</p>')
    expect(html).toContain('Сервер не принял параметры.')
    expect(html).not.toContain('data-request-retry')
    expect(html).not.toContain('Магазин не найден')
    // Both refused fields belong to the form, so the result block does not also reset the address.
    expect(html).not.toContain('class="action-link" href="/stats">Сбросить фильтры')
    const drill = render({ category: 5 }, { kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['category'] })
    expect(drill).toContain('<a class="action-link" href="/stats">Сбросить фильтры</a>')
    expect(drill).not.toContain('aria-invalid="true"')
  })
  it('asks to shorten a period that is too large', () => {
    const html = render({ date_from: '1000-01-01' }, { kind: 'error', reason: 'range_too_large', status: 400 })
    expect(html).toContain('Слишком большой период. Уменьшите его в фильтрах.')
    expect(html).toContain('<a class="action-link" href="/stats">Сбросить фильтры</a>')
  })
})

describe('composition of «Прочее» (Vitest/SSR — not what the browser shows, focuses or announces)', () => {
  const long = read('spending-product.json')
  const short = shortAnswer(long, 1)
  const closed: SpendingQuery = { date_from: '2026-01-01', date_to: '2026-09-30', group_by: 'product' }
  const open: SpendingQuery = { ...closed, other: 'open' }
  const base = '/stats?date_from=2026-01-01&amp;date_to=2026-09-30&amp;group_by=product'
  const state: SpendingRequestState = { kind: 'ok', data: short }
  const tail: SpendingRequestState = { kind: 'ok', data: long }
  const sectors = (html: string) => count(html, /<g class="ck-pie-slice /g)
  const topRows = (html: string) => count(html, /<tr><th scope="row">/g)
  const children = (html: string) => count(html, /<tr class="ck-pie-child">/g)

  it('offers «Показать состав» in every currency block with «Прочее», named by the currency', () => {
    const html = render(closed, state)
    expect(html).toContain(`<a class="ck-pie-action" aria-expanded="false" aria-label="Показать состав „Прочего“, EUR" href="${base}&amp;other=open">Показать состав</a>`)
    expect(html).toContain(`<a class="ck-pie-action" aria-expanded="false" aria-label="Показать состав „Прочего“, KZT" href="${base}&amp;other=open">Показать состав</a>`)
    expect(children(html)).toBe(0)
    expect(html).not.toContain('ck-pie-child-status')
    expect(html).not.toContain('spending-tail')
    expect(text(html)).toContain('Прочее Ещё 27 товаров с меньшими суммами, одной строкой. Показать состав')
  })
  it('shows the composition of every block from the long answer and leaves the rest of the block as it was', () => {
    const before = render(closed, state)
    const html = render(open, state, { tail })
    expect(html).toContain(`<a class="ck-pie-action" aria-expanded="true" aria-label="Скрыть состав „Прочего“, EUR" href="${base}">Скрыть состав</a>`)
    expect(html).toContain(`<a class="ck-pie-action" aria-expanded="true" aria-label="Скрыть состав „Прочего“, KZT" href="${base}">Скрыть состав</a>`)
    // Two regular items of the long answer and its remainder under «Прочее» of each currency.
    expect(children(html)).toBe(6)
    expect(sectors(html)).toBe(sectors(before))
    expect(topRows(html)).toBe(topRows(before))
    expect(html).toContain('<span class="ck-chart-hidden">В составе „Прочего“: </span><a href="/catalog/products/7">')
    const plain = text(html)
    expect(plain).toContain('Прочее 27 товаров с меньшими суммами. Скрыть состав')
    expect(plain).toContain('130,61 EUR 7,96 %')
    expect(plain).toContain('109,70 EUR 6,69 %')
    expect(plain).toContain('В составе „Прочего“: Ещё 25 товаров с меньшими суммами, одной строкой Чтобы увидеть их, сузьте период или откройте обобщённый продукт. 1 200,33 EUR 73,17 %')
    expect(plain).toContain('В составе „Прочего“: Ещё 8 товаров с меньшими суммами, одной строкой Чтобы увидеть их, сузьте период или откройте обобщённый продукт. 28 277,93 KZT 41,92 %')
    // The totals and the row of «Прочее» itself are those of the usual answer.
    for (const fact of ['Итого по чекам 1 638,94 EUR', 'Итого по чекам 67 312,93 KZT']) { expect(text(before)).toContain(fact); expect(plain).toContain(fact) }
    // Order: regular rows, «Прочее», its composition, then the special rows.
    const order = ['Demo Hähnchenbrust 600g', '>Прочее<', 'ck-pie-child"', 'Ещё 25 товаров', 'ck-pie-child-status', '>Строки без товара<'].map((part) => html.indexOf(part))
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(order.every((index) => index >= 0)).toBe(true)
    // Nothing to tell the eye: the status stays for a screen reader only.
    expect(html).toContain('<div class="spending-tail" data-kind="ok" data-quiet="true"><p class="spending-tail-status" role="status">Состав показан, строк: 3.</p></div>')
    expect(html).not.toContain('data-request-retry')
  })
  it('keeps the status paragraph while the composition loads and does not mark the block busy', () => {
    for (const html of [render(open, state, { tail: { kind: 'loading' } }), render(open, state)]) {
      expect(count(html, /<div class="spending-tail" data-kind="loading"><p class="spending-tail-status" role="status">Загружаем состав…<\/p><\/div>/g)).toBe(2)
      expect(children(html)).toBe(0)
      expect(html).toContain('aria-expanded="true"')
      expect(html).not.toContain('aria-busy="true"')
      expect(html).not.toContain('data-stale')
      expect(sectors(html)).toBe(sectors(render(closed, state)))
    }
  })
  it('reports a refusal of the composition under «Прочее» only, with a retry where it can help', () => {
    for (const reason of ['network', 'timeout', 'database_unavailable'] as const) {
      const html = render(open, state, { tail: { kind: 'error', reason }, retryTail: noop })
      expect(count(html, /<div class="spending-tail" data-kind="failed">/g)).toBe(2)
      expect(count(html, /<button type="button" class="spending-secondary">Повторить<\/button>/g)).toBe(2)
      // The block, its chart and its rows stay; the failure of the whole screen is not shown.
      expect(html).not.toContain('request-state-error')
      expect(count(html, /<svg class="ck-pie-svg"/g)).toBe(2)
      expect(topRows(html)).toBe(topRows(render(closed, state)))
      expect(children(html)).toBe(0)
    }
    expect(render(open, state, { tail: { kind: 'error', reason: 'network' }, retryTail: noop }))
      .toContain('<p class="spending-tail-status" role="status">Не удалось связаться с сервером. Проверьте соединение и повторите попытку.</p>')
    expect(render(open, state, { tail: { kind: 'error', reason: 'timeout' }, retryTail: noop })).toContain('Сервер не ответил за 15 секунд.')
    const denied = render(open, state, { tail: { kind: 'error', reason: 'permission_denied', status: 403 }, retryTail: noop })
    expect(denied).toContain('<div class="spending-tail" data-kind="failed"><p class="spending-tail-status" role="status">Локальный режим выключен')
    expect(denied).not.toContain('>Повторить<')
    const refused = render(open, state, { tail: { kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['limit'] }, retryTail: noop })
    expect(refused).toContain('Сервер не принял параметры.')
    expect(refused).not.toContain('>Повторить<')
    expect(refused).not.toContain('aria-invalid="true"')
  })
  it('does not show a composition that no longer fits the block and offers to refresh', () => {
    const moved = { ...long, currencies: long.currencies.map((block) => ({ ...block, totals: { ...block.totals, lines_paid: '1.00' } })) }
    const html = render(open, state, { tail: { kind: 'ok', data: moved } })
    expect(count(html, /<div class="spending-tail" data-kind="changed"><p class="spending-tail-status" role="status">Данные изменились\. Обновите\.<\/p><button type="button" class="spending-secondary">Обновить<\/button><\/div>/g)).toBe(2)
    expect(children(html)).toBe(0)
    // One currency of the long answer is gone: only that block is refused.
    const partial = render(open, state, { tail: { kind: 'ok', data: { ...long, currencies: [long.currencies[0]] } } })
    expect(count(partial, /data-kind="changed"/g)).toBe(1)
    expect(count(partial, /data-kind="ok"/g)).toBe(1)
    expect(children(partial)).toBe(3)
  })
  it('explains shares of another base under the composition', () => {
    const other = { ...short, currencies: short.currencies.map((block) => ({ ...block, items: block.items.map((item, index) => index ? item : { ...item, share_percent: '9.99' }) })) }
    const html = render(open, { kind: 'ok', data: other }, { tail })
    expect(count(html, /<div class="spending-tail" data-kind="ok"><p class="spending-tail-status" role="status">В „Прочем“ есть строки с неположительной суммой: доли состава посчитаны от суммы положительных строк полного списка\.<\/p><\/div>/g)).toBe(2)
    expect(children(html)).toBe(6)
  })
  it('ignores other=open where there is no «Прочее»: no link, no rows, no status', () => {
    const html = render({ group_by: 'store', other: 'open' }, ok('spending-store.json'), { tail: { kind: 'loading' } })
    expect(html).not.toContain('ck-pie-action')
    expect(html).not.toContain('spending-tail')
    expect(children(html)).toBe(0)
    expect(count(html, /<section class="spending-currency"/g)).toBe(2)
    // A block with «Прочее» next to a block without it: only the first one opens.
    const mixed: Spending = { ...short, currencies: [short.currencies[0], { ...short.currencies[1], other: null }] }
    const one = render(open, { kind: 'ok', data: mixed }, { tail })
    expect(count(one, /class="ck-pie-action" aria-expanded="true"/g)).toBe(1)
    expect(count(one, /class="ck-pie-action" aria-expanded="false"/g)).toBe(0)
    expect(count(one, /class="spending-tail"/g)).toBe(1)
    expect(count(one, /<tr class="ck-pie-child">/g)).toBe(3)
  })
  it('keeps other in the links that only change the data and drops it in the links to another list', () => {
    const html = render({ ...open, country: 'DE' }, state, { tail })
    expect(html).toContain('<a href="/stats?country=DE&amp;group_by=product&amp;other=open">Всё время</a>')
    expect(html).toContain('<a href="/stats?date_from=2025-01-01&amp;date_to=2025-12-31&amp;country=DE&amp;group_by=product&amp;other=open">Прошлый год</a>')
    expect(html).toContain('<a href="/stats?date_from=2026-01-01&amp;date_to=2026-09-30&amp;country=DE&amp;group_by=store">Магазины</a>')
    expect(html).toContain('<a aria-current="true" href="/stats?date_from=2026-01-01&amp;date_to=2026-09-30&amp;country=DE&amp;group_by=product">Товары</a>')
    const drill = render({ category: 1, currency: 'EUR', other: 'open' }, ok('spending-category-drilldown.json'))
    expect(drill).toContain('<a class="action-link" href="/stats?currency=EUR">На уровень выше</a>')
    expect(drill).toContain('<li><a href="/stats?currency=EUR">Все траты</a></li>')
    expect(drill).toContain('<a href="/stats?currency=EUR&amp;category=2">')
    const empty = render({ date_from: '2018-01-01', date_to: '2018-12-31', group_by: 'store', other: 'open' }, ok('spending-empty.json'))
    expect(empty).toContain('<a class="action-link" href="/stats?group_by=store">Сбросить фильтры</a>')
    expect(render({ category: 5, other: 'open' }, { kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['category'] }))
      .toContain('<a class="action-link" href="/stats">Сбросить фильтры</a>')
  })
  it('keeps the previous answer with its composition while new filters load, and shows no composition after a failure', () => {
    const last = { query: open, data: short }
    const html = render({ ...open, country: 'DE' }, { kind: 'loading' }, { last, tail })
    expect(html).toContain('<div class="spending-blocks" data-stale="true">')
    expect(children(html)).toBe(6)
    expect(html).toContain(`aria-expanded="true" aria-label="Скрыть состав „Прочего“, EUR" href="${base}"`)
    const failed = render(open, { kind: 'error', reason: 'network' }, { tail })
    expect(failed).toContain('request-state-error')
    expect(failed).not.toContain('spending-tail')
    expect(failed).not.toContain('ck-pie-action')
  })
})

describe('spending filters markup', () => {
  it('reads the applied filters from the address', () => {
    const html = render({ date_from: '2026-01-01', date_to: '2026-12-31', country: 'DE', currency: 'EUR', store: [2] }, ok('spending-category.json'))
    expect(html).toMatch(/<input [^>]*name="date_from"[^>]*value="2026-01-01"/)
    expect(html).toMatch(/<input [^>]*name="date_to"[^>]*value="2026-12-31"/)
    expect(html).toContain('<option value="DE" selected="">Германия (DE)</option>')
    expect(html).toContain('<option value="EUR" selected="">EUR</option>')
    // Currencies of the chosen country only; stores of that country only.
    expect(html).not.toContain('<option value="KZT">')
    expect(html).toMatch(/<input type="checkbox" name="store" checked="" value="2"\/><span>ID 2 · Beispielkorb/)
    expect(html).toMatch(/<input type="checkbox" name="store" value="1"\/>/)
    expect(html).not.toContain('Статмаркет · Алматы')
    expect(html).toContain('Выбрано: 1 из 20 возможных.')
    expect(html).toContain('Убрать все магазины')
  })
  it('marks the preset of the current period and links the others with the same filters', () => {
    const html = render({ date_from: '2026-01-01', date_to: '2026-12-31', country: 'DE' }, ok('spending-category.json'))
    expect(html).toContain('<nav aria-label="Быстрый выбор периода">')
    expect(html).toContain('<a aria-current="true" href="/stats?date_from=2026-01-01&amp;date_to=2026-12-31&amp;country=DE">Этот год</a>')
    expect(html).toContain('<a href="/stats?date_from=2026-10-01&amp;date_to=2026-10-31&amp;country=DE">Этот месяц</a>')
    expect(html).toContain('<a href="/stats?date_from=2026-09-01&amp;date_to=2026-09-30&amp;country=DE">Прошлый месяц</a>')
    expect(html).toContain('<a href="/stats?date_from=2025-01-01&amp;date_to=2025-12-31&amp;country=DE">Прошлый год</a>')
    expect(html).toContain('<a href="/stats?country=DE">Всё время</a>')
  })
  it('has no reset and no selection at the root', () => {
    const html = render({}, ok('spending-category.json'))
    expect(html).toContain('<a aria-current="true" href="/stats">Всё время</a>')
    expect(html).not.toContain('>Сбросить фильтры<')
    expect(html).toContain('Все магазины. Можно выбрать до 20.')
    expect(count(html, /<input type="checkbox" name="store"/g)).toBe(3)
    expect(html).not.toContain('aria-invalid="true"')
  })
  it('stays usable when the reference lists fail, keeping the values of the address removable', () => {
    const failed: SpendingReference = { countries: { kind: 'error', reason: 'network' }, stores: { kind: 'error', reason: 'server' }, retry: noop }
    const html = render({ country: 'DE', currency: 'EUR', store: [7] }, ok('spending-category.json'), { reference: failed })
    expect(html).toContain('Списки стран и магазинов не загрузились.')
    expect(html).toContain('<button type="button" class="spending-secondary">Повторить загрузку списков</button>')
    expect(html).toContain('<option value="DE" selected="">DE</option>')
    expect(html).toContain('<option value="EUR" selected="">EUR</option>')
    expect(html).toContain('<span>ID 7 · нет в загруженном справочнике</span>')
    expect(count(html, /<section class="spending-currency"/g)).toBe(2)
  })
  it('announces the lists while they load and a reference longer than one page', () => {
    const loading: SpendingReference = { countries: { kind: 'loading' }, stores: { kind: 'loading' }, retry: noop }
    expect(render({}, { kind: 'loading' }, { reference: loading })).toContain('Загружаем списки стран и магазинов…')
    const long: SpendingReference = { ...reference, stores: { kind: 'ok', data: { ...stores, count: 450, pages: 3 } } }
    expect(render({}, { kind: 'loading' }, { reference: long })).toContain('Показаны первые 3 магазинов справочника.')
  })
})
