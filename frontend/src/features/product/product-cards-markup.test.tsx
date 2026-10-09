import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { foreignPoint, history, pageOf, point, store } from '../../api/test-support'
import type { PricePoint, Store } from '../../api/types'
import PriceHistory from './PriceHistory'
import PriceHistoryCards from './PriceHistoryCards'

// The texts the table shows; the cards are given the same ones by PriceHistory (checked below on its source).
const historyColumns = { store: 'Магазин и адрес', date: 'Дата', list: 'До скидки', paid: 'После скидки',
  normalized: 'За базовую единицу', purchase: 'Покупка' }
const historyCaption = 'Наблюдения покупок из чеков'
const historyLabel = 'История цен по магазинам'

const noop = () => {}
const buildPageHref = (page: number) => ({ kind: 'product' as const, productId: 9, query: { page } })
const text = (html: string) => html.replace(/<[^>]+>/g, '')

/** The table as the wide screen draws it (no `window` in Node: the hook answers «wide»). */
function tableOf(points: PricePoint[], stores: Store[] = []) {
  const html = renderToStaticMarkup(<PriceHistory state={{ kind: 'ok', data: { ...history, ...pageOf(points, 200) } }}
    query={{ page: 1 }} stores={stores} retry={noop} reset={noop} buildPageHref={buildPageHref} />)
  return {
    html,
    columns: [...html.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]),
    rows: [...html.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map((row) => ({
      title: row[1], cells: [...row[2].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1]),
    })),
  }
}

function cardsOf(points: PricePoint[], stores: Store[] = []) {
  const html = renderToStaticMarkup(<PriceHistoryCards points={points} stores={new Map(stores.map((item) => [item.id, item]))}
    columns={historyColumns} caption={historyCaption} label={historyLabel} />)
  return {
    html,
    cards: [...html.matchAll(/<li class="ck-card"><div class="ck-card-title">(.*?)<\/div><dl class="ck-card-facts">(.*?)<\/dl><\/li>/g)].map((card) => ({
      title: card[1],
      facts: [...card[2].matchAll(/<div class="ck-card-fact" data-kind="(\w+)"><dt>([^<]*)<\/dt><dd>(.*?)<\/dd><\/div>/g)]
        .map((fact) => ({ kind: fact[1], label: fact[2], value: fact[3] })),
    })),
  }
}

const foreign = { ...foreignPoint, list_unit_price: '1.1000', paid_unit_price: '1.2000',
  normalized_price: '1.3000', normalized_unit: 'l' as const, comparable: true }
const points: PricePoint[] = [
  point,
  foreign,
  { ...point, receipt_id: 13, position: 0, paid_unit_price: '130.5882', normalized_price: '12.3456', normalized_unit: 'm', comparable: true },
  { ...foreignPoint, store: { id: 51, name: 'Same Chain', city: 'Berlin', country: 'DE' } },
]

describe('price history cards against the table on the same data (SSR in Node, not browser acceptance)', () => {
  it('labels the facts with the headings of the columns, in the order of the columns', () => {
    const table = tableOf(points, [store])
    const { cards } = cardsOf(points, [store])
    expect(table.columns).toEqual(Object.values(historyColumns))
    expect(cards).toHaveLength(points.length)
    // The first column is the heading of the card, the other five are its facts.
    for (const card of cards) expect(card.facts.map((fact) => fact.label)).toEqual(table.columns.slice(1))
  })

  it('shows the same store and the same values as the row of the table', () => {
    for (const stores of [[], [store]]) {
      const table = tableOf(points, stores)
      const { cards } = cardsOf(points, stores)
      expect(table.rows).toHaveLength(points.length)
      expect(cards.map((card) => card.title)).toEqual(table.rows.map((row) => row.title))
      // The cell and the fact are the same markup: text, <time>, the link and the notes under the value.
      expect(cards.map((card) => card.facts.map((fact) => fact.value))).toEqual(table.rows.map((row) => row.cells))
    }
  })

  it('names the list and keeps the caption of the table above it', () => {
    const table = tableOf(points)
    const { html } = cardsOf(points)
    expect(table.html).toContain(`<caption>${historyCaption}</caption>`)
    expect(table.html).toContain(`role="region" aria-label="${historyLabel}"`)
    expect(html.startsWith(`<div class="ck-cards"><p class="ck-cards-caption">${historyCaption}</p><ul class="ck-cards-list" aria-label="${historyLabel}">`)).toBe(true)
    expect(html).not.toContain('<table')
    expect(html).not.toContain('role="region"')
    expect(html).not.toContain('tabindex')
  })

  it('keeps every date and moment whole inside <time>', () => {
    const { cards, html } = cardsOf([point])
    expect(cards[0].facts[0].value).toMatch(/^<time dateTime="2026-10-04">04\.10\.2026<\/time><span class="product-subtext"><time dateTime="2026-10-03T22:30:00Z">[^<]*UTC<\/time><\/span>$/)
    // No date outside <time>.
    expect(text(html.replace(/<time[^>]*>[^<]*<\/time>/g, ''))).not.toMatch(/\d{2}\.\d{2}\.\d{4}/)
    // The timezone of a known store replaces the UTC fallback, as in the table.
    expect(cardsOf([point], [store]).html).not.toContain('UTC')
  })

  it('marks my purchase with the link to its receipt', () => {
    const { cards, html } = cardsOf([point])
    expect(cards[0].facts[4]).toEqual({ kind: 'value', label: 'Покупка',
      value: expect.stringMatching(/^Моя · <a [^>]*href="\/receipts\/12"[^>]*>Чек\u00a0№12<\/a>$/) })
    expect(html.match(/<a /g)).toHaveLength(1)
    expect(html).not.toContain('Чужая')
  })

  it('shows a foreign purchase with its date and prices, without a moment or a receipt link', () => {
    const { cards, html } = cardsOf([foreign])
    expect(cards[0].title).toBe('ID 7 · Учебный магазин · DE · адрес неизвестен')
    expect(cards[0].facts.map((fact) => [fact.label, text(fact.value)])).toEqual([
      ['Дата', '04.10.2026'], ['До скидки', '1,10\u00a0EUR/шт'], ['После скидки', '1,20\u00a0EUR/шт'],
      ['За базовую единицу', '1,30\u00a0EUR/л'], ['Покупка', 'Чужая'],
    ])
    expect(cards[0].facts[0].value).toBe('<time dateTime="2026-10-04">04.10.2026</time>')
    for (const absent of ['<a ', '/receipts/', 'Моя', 'Чек', 'product-subtext', 'UTC', 'null']) expect(html).not.toContain(absent)
  })

  it('keeps my and foreign purchases in the server order', () => {
    const { cards, html } = cardsOf([foreignPoint, point, foreignPoint])
    expect(cards.map((card) => text(card.facts[4].value))).toEqual(['Чужая', 'Моя · Чек\u00a0№12', 'Чужая'])
    expect(html.match(/href="\/receipts\//g)).toHaveLength(1)
  })

  it('renders no empty fact: a missing normalization is said in words, a zero price is a number', () => {
    const { cards } = cardsOf(points)
    for (const card of cards) {
      expect(card.facts).toHaveLength(5)
      for (const fact of card.facts) {
        expect(fact.kind).toBe('value')
        expect(text(fact.value).trim()).not.toBe('')
      }
    }
    expect(cards[0].facts[1].value).toBe('0,00\u00a0EUR/шт')
    expect(cards[0].facts[3].value).toBe('<span class="product-cell-text">Нет данных для пересчёта</span>'
      + '<span class="product-subtext product-cell-text">Не сопоставимо с базовой единицей товара</span>')
    // Two decimals of a unit price, the actual normalized unit.
    expect(cards[2].facts.map((fact) => fact.value).slice(2, 4)).toEqual(['130,59\u00a0EUR/шт', '12,35\u00a0EUR/м'])
  })

  it('tells identical chain points apart by the store in the heading', () => {
    const later = [51, 52].map((id) => ({ ...point, receipt_id: id, store: { id, name: 'Same Chain', city: 'Berlin', country: 'DE' } }))
    expect(cardsOf(later).cards.map((card) => card.title))
      .toEqual([51, 52].map((id) => `ID ${id} · Same Chain · Berlin · DE · адрес неизвестен`))
  })
})

describe('the view is chosen only where there are purchases (text of the sources and SSR)', () => {
  const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')

  it('leaves loading, empty and error to the former blocks', () => {
    const base = { stores: [], retry: noop, reset: noop, buildPageHref, query: { page: 1 } }
    const empty = { ...history, results: [], count: 0, pages: 0 }
    for (const html of [
      renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'loading' }} />),
      renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'ok', data: empty }} />),
      renderToStaticMarkup(<PriceHistory {...base} state={{ kind: 'error', reason: 'network' }} />),
    ]) {
      expect(html).not.toContain('ck-card')
      expect(html).not.toContain('<table')
    }
  })

  it('draws the cards instead of the table and its scroll note, and keeps the count and the pages in both views', () => {
    const history = source('./PriceHistory.tsx')
    const choice = history.indexOf('{narrow ? <PriceHistoryCards points={state.data.results} stores={knownStores} columns={historyColumns} caption={historyCaption} label={historyLabel} /> : <>')
    expect(choice).toBeGreaterThan(-1)
    expect(history.match(/\buseNarrow\(/g)).toHaveLength(1)
    expect(history.match(/<PriceHistoryCards /g)).toHaveLength(1)
    expect(history.indexOf('Наблюдений:')).toBeLessThan(choice)
    for (const inside of ['id="product-history-scroll"', '<table className="product-table">']) expect(history.indexOf(inside)).toBeGreaterThan(choice)
    expect(history.indexOf('<Pagination ')).toBeGreaterThan(history.indexOf('</>}', choice))
    // One source of the texts: every heading, the caption and the name are written once and reach both views.
    for (const once of [...Object.values(historyColumns), historyCaption, historyLabel]) expect(history.split(`'${once}'`)).toHaveLength(2)
    for (const key of Object.keys(historyColumns)) expect(history).toContain(`{historyColumns.${key}}</th>`)
    expect(history).toContain('<caption>{historyCaption}</caption>')
    expect(history).toContain('aria-label={historyLabel}')
    // The cards bring no styles and no texts of the headings of their own.
    for (const label of Object.values(historyColumns)) expect(source('./PriceHistoryCards.tsx')).not.toContain(label)
    expect(source('./PriceHistoryCards.tsx')).not.toMatch(/\.css'|style=/)
  })

  it('pins the filter buttons with the second class of their wrapper only', () => {
    const page = source('./ProductPage.tsx')
    expect(page.match(/ck-action-bar/g)).toHaveLength(1)
    expect(page).toMatch(/<div className="product-actions ck-action-bar">\s*<button type="submit">Применить фильтры<\/button>\s*<button type="button" className="product-secondary"[^\n]*>Сбросить фильтры<\/button>\s*<\/div>/)
  })
})
