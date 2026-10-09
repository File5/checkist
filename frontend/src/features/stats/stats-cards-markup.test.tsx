import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isReceiptCompare } from '../../api/stats-schema'
import { statsFixture } from '../../api/stats-test-support'
import type { CompareCurrency, ReceiptCompare } from '../../api/stats'
import { NBSP } from '../../lib/text'
import CompareBlock from './receipts-compare'
import { EffectCards, ProductCards, effectsCaption, effectsTotalTitle } from './receipts-compare-cards'
import type { EffectColumns, ProductColumns } from './receipts-compare-cards'
import { verdict } from './receipts-wording'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const noop = () => {}
const periods = { base_from: '2020-01-01', base_to: '2020-12-31', current_from: '2026-01-01', current_to: '2026-09-30' }

function fixture(name: string): ReceiptCompare {
  const body = statsFixture(name)
  if (!isReceiptCompare(body)) throw new Error(`${name} does not match the runtime schema`)
  return body
}
/** Text of a piece of markup: tags out, entities back, spaces as they are (a non-breaking space stays itself). */
const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
const cells = (markup: string, tag: string) => [...markup.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => match[1])

/** The table of the wide view, as the screen renders it without `window`. */
function table(data: ReceiptCompare, currency: number, className: string) {
  const article = renderToStaticMarkup(<CompareBlock state={{ kind: 'ok', data }} query={periods} onRetry={noop} />).split('<article')[currency + 1]
  const markup = article.split(`${className}">`)[1].split('</table>')[0]
  const rows = (part: string) => cells(part, 'tr').map((row) => ({ heading: cells(row, 'th')[0], values: cells(row, 'td') }))
  return {
    caption: text(cells(markup, 'caption')[0]),
    headings: cells(markup.split('</thead>')[0], 'th').map(text),
    body: rows(markup.split('<tbody>')[1].split('</tbody>')[0]),
    foot: markup.includes('<tfoot>') ? rows(markup.split('<tfoot>')[1]) : [],
  }
}

interface CardView { tone: string | null; title: string; facts: { label: string; kind: string; value: string }[] }
function cards(markup: string) {
  const list: CardView[] = [...markup.matchAll(/<li class="ck-card"( data-tone="([a-z]+)")?>([\s\S]*?)<\/li>/g)].map((match) => ({
    tone: match[2] ?? null,
    title: /<div class="ck-card-title">([\s\S]*?)<\/div>/.exec(match[3])![1],
    facts: [...match[3].matchAll(/<div class="ck-card-fact" data-kind="([a-z]+)"><dt>([^<]*)<\/dt><dd>([\s\S]*?)<\/dd><\/div>/g)]
      .map((fact) => ({ kind: fact[1], label: fact[2], value: fact[3] })),
  }))
  return { caption: text(/<p class="ck-cards-caption">([\s\S]*?)<\/p>/.exec(markup)?.[1] ?? ''), list }
}

/** The headings the screen keeps for both views; the guard of the sources below checks that it passes these very objects. */
const effectColumns: EffectColumns = { term: 'Слагаемое', amount: 'Вклад', share: 'Доля изменения' }
const productColumns: ProductColumns = { product: 'Товар', price: 'Цена', priceChange: 'Изменение цены', quantity: 'Куплено', amount: 'Сумма' }

const eur = (data: ReceiptCompare): CompareCurrency => data.currencies[0]
const effectCards = (block: CompareCurrency) => renderToStaticMarkup(
  <EffectCards block={block} parts={verdict(block).parts} columns={effectColumns} labelledBy="terms" />,
)
const productCards = (block: CompareCurrency, caption = 'Подпись таблицы') => renderToStaticMarkup(
  <ProductCards block={block} columns={productColumns} caption={caption} labelledBy="products" />,
)

describe('cards of the terms of the change (Vitest/SSR, not browser acceptance)', () => {
  const data = fixture('compare-2020-2026.json')
  const wide = table(data, 0, 'stats-effects-table')
  const markup = effectCards(eur(data))
  const narrow = cards(markup)

  it('names the list by the heading of the section and keeps the caption of the table', () => {
    expect(markup.startsWith('<div class="ck-cards"><p class="ck-cards-caption">')).toBe(true)
    expect(markup).toContain('<ul class="ck-cards-list" aria-labelledby="terms">')
    expect(narrow.caption).toBe(wide.caption)
    expect(narrow.caption).toBe(effectsCaption)
  })

  it('labels the facts with the headings of the columns, in the order of the columns', () => {
    expect(wide.headings).toEqual([effectColumns.term, effectColumns.amount, effectColumns.share])
    for (const card of narrow.list) expect(card.facts.map((fact) => fact.label)).toEqual(wide.headings.slice(1))
  })

  it('gives a card per term with the same heading and the same values, the share of the change included', () => {
    expect(narrow.list).toHaveLength(wide.body.length + 1)
    wide.body.forEach((row, index) => {
      const card = narrow.list[index]
      expect(card.tone).toBeNull()
      // The swatch, the name and the explanation: the content of the row heading as it is.
      expect(card.title).toBe(row.heading)
      expect(card.facts.map((fact) => fact.value)).toEqual(row.values)
      expect(card.facts.map((fact) => fact.kind)).toEqual(['value', 'value'])
    })
    expect(narrow.list.map((card) => text(card.title))).toEqual([
      'Количество позицийстал покупать больше позиций за поход', 'Цены на те же товарывыросли цены на те же товары',
      'Состав покупокдругой состав покупок: позиции в среднем дороже', effectsTotalTitle,
    ])
    expect(narrow.list[0].facts.map((fact) => fact.value)).toEqual([`+8,65${NBSP}EUR`, `+46,23${NBSP}%`])
  })

  it('ends with the total of the table as the only total card', () => {
    const total = narrow.list.at(-1)!
    expect(narrow.list.map((card) => card.tone)).toEqual([null, null, null, 'total'])
    expect(wide.foot).toHaveLength(1)
    expect(total.title).toBe(wide.foot[0].heading)
    expect(total.facts.map((fact) => fact.value)).toEqual(wide.foot[0].values)
    expect(total.facts[1].value).toBe(`+69,27${NBSP}% <span class="stats-number-note">к базовому чеку</span>`)
  })

  it('writes signs, zeros and a missing share with the text of the table', () => {
    for (const name of ['compare-2020-2026.json', 'compare-no-matched-products.json']) {
      const changed = fixture(name)
      for (const [index, block] of changed.currencies.entries()) {
        if (verdict(block).parts.length === 0) continue
        const rows = table(changed, index, 'stats-effects-table')
        const list = cards(effectCards(block)).list
        expect(list.map((card) => [card.title, ...card.facts.map((fact) => fact.value)]))
          .toEqual([...rows.body, ...rows.foot].map((row) => [row.heading, ...row.values]))
      }
    }
    const flat = fixture('compare-2020-2026.json')
    const effects = flat.currencies[0].effects
    if (effects === null) throw new Error('the fixture has no terms')
    flat.currencies[0].change.avg_receipt_percent = null
    effects.quantity = '-3.10'
    effects.price = '0.00'
    const rows = table(flat, 0, 'stats-effects-table')
    const list = cards(effectCards(eur(flat))).list
    expect(list.map((card) => card.facts.map((fact) => fact.value))).toEqual([...rows.body, ...rows.foot].map((row) => row.values))
    // A dash is a value of the table, not an empty fact: the pair stays.
    expect(list.at(-1)!.facts.map((fact) => fact.value)).toEqual([rows.foot[0].values[0], '—'])
    const values = list.flatMap((card) => card.facts.map((fact) => fact.value))
    expect(values).toContain(`-3,10${NBSP}EUR`)
    expect(values).toContain(`0,00${NBSP}EUR`)
  })

  it('has no dates, links or buttons, as the table has none', () => {
    expect(markup).not.toMatch(/<a |<button|<time|\d{2}\.\d{2}\.\d{4}/)
  })
})

describe('cards of the products bought in both periods (Vitest/SSR, not browser acceptance)', () => {
  const data = fixture('compare-2020-2026.json')
  const block = eur(data)
  const wide = table(data, 0, 'stats-products-table')
  const markup = productCards(block, wide.caption)
  const narrow = cards(markup)

  it('names the list by the heading of the section and shows the caption it is given', () => {
    expect(markup).toContain('<ul class="ck-cards-list" aria-labelledby="products">')
    expect(narrow.caption).toBe(wide.caption)
    expect(narrow.caption).toBe('Показаны 5 из 24 совпавших товаров с наибольшим изменением суммы покупок. Цена — оплаченная сумма, делённая на количество за период.')
  })

  it('takes the labels from the headings of the columns: a pair of periods is two columns and one fact', () => {
    const { product, price, priceChange, quantity, amount } = productColumns
    expect(wide.headings).toEqual([
      product, `${price} было`, `${price} стало`, priceChange, `${quantity} было`, `${quantity} стало`, `${amount} было`, `${amount} стало`,
    ])
    expect(wide.headings).toEqual(['Товар', 'Цена было', 'Цена стало', 'Изменение цены', 'Куплено было', 'Куплено стало', 'Сумма было', 'Сумма стало'])
    for (const card of narrow.list) {
      expect(card.facts.map((fact) => fact.label)).toEqual([price, priceChange, quantity, amount])
      expect(card.facts.map((fact) => fact.kind)).toEqual(['text', 'value', 'text', 'text'])
    }
  })

  it('gives a card per product with the link of the table and the values of its row', () => {
    expect(narrow.list).toHaveLength(wide.body.length)
    expect(narrow.list).toHaveLength(block.products.length)
    wide.body.forEach((row, index) => {
      const card = narrow.list[index]
      const [priceBase, priceCurrent, change, quantityBase, quantityCurrent, amountBase, amountCurrent] = row.values
      // The same link element with the same address and name.
      expect(card.title).toBe(row.heading)
      expect(card.tone).toBeNull()
      expect(card.facts.map((fact) => text(fact.value))).toEqual([
        `${priceBase}${NBSP}→ ${priceCurrent}`, change, `${quantityBase}${NBSP}→ ${quantityCurrent}`, `${amountBase}${NBSP}→ ${amountCurrent}`,
      ])
    })
    expect(markup.match(/<a href="\/catalog\/products\/\d+">/g)).toEqual([24, 10, 21, 4, 17].map((id) => `<a href="/catalog/products/${id}">`))
    expect(markup).not.toContain('<button')
  })

  it('never tears a value: each side of a pair is one line, a break is possible only after the arrow', () => {
    const first = narrow.list[0].facts
    expect(first[0].value).toBe(`<span class="stats-number">6,17${NBSP}EUR/шт${NBSP}→</span> <span class="stats-number">7,87${NBSP}EUR/шт</span>`)
    expect(first[1].value).toBe(`+27,49${NBSP}%`)
    expect(first[2].value).toBe(`<span class="stats-number">19${NBSP}шт${NBSP}→</span> <span class="stats-number">18${NBSP}шт</span>`)
    expect(first[3].value).toBe(`<span class="stats-number">117,23${NBSP}EUR${NBSP}→</span> <span class="stats-number">141,59${NBSP}EUR</span>`)
    for (const fact of narrow.list.flatMap((card) => card.facts)) {
      // An ordinary space stands only between the two sides of a pair.
      expect(text(fact.value).split(' ').length, fact.value).toBe(fact.kind === 'text' ? 2 : 1)
    }
    expect(read('./ReceiptsStats.css')).toContain('.stats-number { font-variant-numeric: tabular-nums; white-space: nowrap; }')
  })

  it('writes a fall of the price, a missing change and large numbers with the text of the table', () => {
    const changed = fixture('compare-2020-2026.json')
    const [first, second] = changed.currencies[0].products
    first.price_change_percent = '-12.50'
    first.current.price = '189490.00'
    second.price_change_percent = '0.00'
    const rows = table(changed, 0, 'stats-products-table').body
    const list = cards(productCards(eur(changed))).list
    expect(list[0].facts[1].value).toBe(rows[0].values[2])
    expect(list[0].facts[1].value).toBe(`-12,50${NBSP}%`)
    expect(list[1].facts[1].value).toBe(rows[1].values[2])
    expect(text(list[0].facts[0].value)).toBe(`6,17${NBSP}EUR/шт${NBSP}→ 189${NBSP}490,00${NBSP}EUR/шт`)
    expect(markup).not.toMatch(/<time|\d{2}\.\d{2}\.\d{4}/)
  })
})

describe('choice of the view and pinned action bars (text of the sources, not rendering)', () => {
  const compare = read('./receipts-compare.tsx')

  it('draws the cards instead of the table only in the branch with data, the table stays for a wide screen', () => {
    expect(compare).toContain('{narrow ? <EffectCards block={block} parts={parts} columns={effectColumns} labelledBy={id} /> : <div className="stats-table-scroll" role="region" aria-labelledby={id} tabIndex={0}>')
    expect(compare).toContain('{narrow ? <ProductCards block={block} columns={productColumns} caption={caption} labelledBy={id} /> : <div className="stats-table-scroll" role="region" aria-labelledby={id} tabIndex={0}>')
    expect(compare.match(/\buseNarrow\(\)/g)).toHaveLength(2)
    // Without `window` the hook answers "wide": the screen renders its tables and no card.
    const wide = renderToStaticMarkup(<CompareBlock state={{ kind: 'ok', data: fixture('compare-2020-2026.json') }} query={periods} onRetry={noop} />)
    expect(wide).not.toContain('ck-card')
    expect(wide.match(/<table /g)).toHaveLength(4)
    for (const state of [{ kind: 'idle' as const }, { kind: 'loading' as const }]) {
      const markup = renderToStaticMarkup(<CompareBlock state={state} query={periods} onRetry={noop} />)
      expect(markup).not.toMatch(/ck-card|<table/)
    }
  })

  it('keeps one source of the headings and of the caption for the table and for the cards', () => {
    // The objects the cards get are the ones the `th` of the tables read, and they are written once.
    expect(compare).toContain(`const effectColumns: EffectColumns = { term: '${effectColumns.term}', amount: '${effectColumns.amount}', share: '${effectColumns.share}' }`)
    expect(compare).toContain(`const productColumns: ProductColumns = { product: '${productColumns.product}', price: '${productColumns.price}', priceChange: '${productColumns.priceChange}', quantity: '${productColumns.quantity}', amount: '${productColumns.amount}' }`)
    for (const key of ['term', 'amount', 'share']) expect(compare).toContain(`>{effectColumns.${key}}</th>`)
    expect(compare).toContain('<th scope="col">{productColumns.product}</th>')
    expect(compare).toContain('>{productColumns.priceChange}</th>')
    for (const key of ['price', 'quantity', 'amount']) {
      for (const side of ['base', 'current']) expect(compare).toContain(`>{pairHeading(productColumns.${key}, '${side}')}</th>`)
    }
    expect(compare).toContain('<caption>{caption}</caption>')
    expect(compare).toContain('<caption>{effectsCaption}</caption>')
    expect(compare).toContain('<th scope="row">{effectsTotalTitle}</th>')
    const literals = [...Object.values(effectColumns), ...Object.values(productColumns), effectsCaption, effectsTotalTitle]
    const sources = compare + read('./receipts-compare-cards.tsx')
    for (const literal of literals) expect(sources.split(`'${literal}'`).length - 1, literal).toBe(1)
  })

  it('writes no styles of its own for the cards', () => {
    const source = read('./receipts-compare-cards.tsx')
    expect(source).not.toMatch(/\.css'|style=|@media|font-size/)
    expect(source).not.toMatch(/toLocaleDateString|toFixed|Intl\./)
  })

  it('pins the buttons of both filter forms with the second class of their wrappers', () => {
    const receipts = read('./receipts-filters.tsx')
    const spending = read('./spending-filters.tsx')
    expect(receipts.match(/className="stats-actions[^"]*"/g)).toEqual(['className="stats-actions ck-action-bar"'])
    expect(spending.match(/className="spending-actions[^"]*"/g)).toEqual(['className="spending-actions ck-action-bar"'])
    expect([...receipts.matchAll(/ck-action-bar/g), ...spending.matchAll(/ck-action-bar/g)]).toHaveLength(2)
    // Only buttons inside a bar: the message of a refusal stays above it.
    const bar = (source: string) => source.split('ck-action-bar">')[1].split('</div>')[0]
    for (const source of [receipts, spending]) {
      expect(bar(source)).toContain('<button type="submit">')
      expect(bar(source)).not.toMatch(/<p\b|role="alert"|aria-describedby/)
    }
  })
})
