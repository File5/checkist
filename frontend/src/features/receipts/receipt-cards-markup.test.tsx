import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Discount, Line, Receipt, Tax } from '../../api/receipts'
import type { ReceiptImage } from '../../api/recognition'
import { publicFixture } from '../../api/recognition-test-support'
import type { Page } from '../../api/types'
import { ReceiptLines } from './ReceiptContent'
import ReceiptFilters from './ReceiptFilters'
import { ReceiptView } from './ReceiptPage'
import type { BlockRequest, ReceiptViewProps } from './ReceiptPage'

// There is no window in Node, so the hook answers "wide". The phone view is switched on here; the rest of lib/cards is real.
const screen = vi.hoisted(() => ({ narrow: false }))
vi.mock('../../lib/cards', async (original) => ({ ...(await original<typeof import('../../lib/cards')>()), useNarrow: () => screen.narrow }))
afterEach(() => { screen.narrow = false })

const receipt = publicFixture('receipt.json') as Receipt
const page = publicFixture('lines.json') as Page<Line>
const milk = page.results[0]
const bread: Line = { ...milk, id: 102, position: 2, product: null, matching_status: 'unmatched', name: 'ХЛЕБ', amount: '1.10', discount_amount: '0.00', paid_amount: '1.10' }
const deposit: Line = { ...bread, id: 103, position: 3, kind: 'deposit', parent_id: 101, name: 'PFAND', amount: '0.25', paid_amount: '0.25' }
const service: Line = { ...bread, id: 104, position: 4, kind: 'service', name: 'ДОСТАВКА', amount: '3.00', discount_amount: '0.50', paid_amount: '2.50' }
const returned: Line = { ...deposit, id: 105, position: 5, kind: 'deposit_return', parent_id: null, quantity: '-1.000', amount: '-0.25', paid_amount: '-0.25' }
const lines = [milk, bread, deposit, service, returned]

const table = (rows: Line[], currency: string | undefined = 'EUR') => renderToStaticMarkup(<ReceiptLines lines={rows} currency={currency} />)
const cards = (rows: Line[], currency: string | undefined = 'EUR') => {
  screen.narrow = true
  try { return renderToStaticMarkup(<ReceiptLines lines={rows} currency={currency} />) } finally { screen.narrow = false }
}
const text = (html: string) => html.replace(/<[^>]+>/g, '')
const headings = (html: string) => [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((match) => match[1])
const rows = (html: string) => [...html.matchAll(/<tr id="(receipt-line-\d+)" tabindex="-1"><th scope="row">([\s\S]*?)<\/th>([\s\S]*?)<\/tr>/g)]
  .map((match) => ({ id: match[1], heading: match[2], cells: [...match[3].matchAll(/<td class="receipt-number">([^<]*)<\/td>/g)].map((cell) => cell[1]) }))
const items = (html: string) => [...html.matchAll(/<li class="ck-card" id="(receipt-line-\d+)" tabindex="-1"><div class="ck-card-title">([\s\S]*?)<\/div>(?:<dl class="ck-card-facts">([\s\S]*?)<\/dl>)?<\/li>/g)]
  .map((match) => ({ id: match[1], heading: match[2],
    facts: [...(match[3] ?? '').matchAll(/<div class="ck-card-fact" data-kind="value"><dt>([^<]*)<\/dt><dd>([^<]*)<\/dd><\/div>/g)].map((fact) => [fact[1], fact[2]]) }))
const one = (line: Partial<Line>) => items(cards([{ ...milk, ...line }]))[0].facts
const labels = (facts: string[][]) => facts.map(([label]) => label)

describe('receipt line cards (Vitest/SSR of the phone view, not browser visual acceptance)', () => {
  it('draws the table on a wide screen and only the cards on a phone', () => {
    const wide = table(lines)
    expect(wide).toContain('<table class="receipt-lines-table">')
    expect(wide).not.toContain('ck-card')
    const narrow = cards(lines)
    expect(narrow).not.toContain('<table')
    expect(narrow).not.toContain('role="region"')
    expect(narrow).not.toContain('receipt-table-scroll')
    expect(narrow).toContain('<div class="ck-cards"><p class="ck-cards-caption">Строки в порядке печати на чеке</p><ul class="ck-cards-list" aria-label="Строки чека">')
    expect(narrow.match(/<li class="ck-card"/g)).toHaveLength(lines.length)
    expect(items(narrow)).toHaveLength(lines.length)
  })

  it('names the facts by the headings of the table columns, in the order of the columns, on the same data', () => {
    const columns = headings(table([milk]))
    expect(columns).toEqual(['Строка и товар каталога', 'Количество', 'Цена', 'Сумма', 'Скидка', 'Оплачено'])
    const [row] = rows(table([milk]))
    const [card] = items(cards([milk]))
    // The fixture line has a discount, so no fact is left out.
    expect(labels(card.facts)).toEqual(columns.slice(1))
    expect(card.facts.map(([, value]) => value)).toEqual(row.cells)
    expect(row.cells).toEqual(['2 шт', '1,29 EUR', '2,58 EUR', '0,20 EUR', '2,38 EUR'])
  })

  it('keeps every shown value equal to the cell of the same column', () => {
    const columns = headings(table(lines))
    const wide = rows(table(lines))
    const narrow = items(cards(lines))
    expect(wide).toHaveLength(lines.length)
    for (const [index, card] of narrow.entries()) {
      expect(card.facts.length).toBeGreaterThanOrEqual(3)
      for (const [label, value] of card.facts) expect(value).toBe(wide[index].cells[columns.indexOf(label) - 1])
      expect(labels(card.facts)).toEqual(columns.slice(1).filter((label) => labels(card.facts).includes(label)))
    }
  })

  it('moves the content of the row heading into the title: number, kind, printed name, catalog link, relations', () => {
    const wide = rows(table(lines))
    const narrow = items(cards(lines))
    expect(narrow.map((card) => card.heading)).toEqual(wide.map((row) => row.heading))
    expect(narrow[0].heading).toContain('<span class="receipt-note">Строка 1 · Товар</span><span class="receipt-printed-name">MILCH 1 L</span>')
    expect(narrow[0].heading).toContain('<a class="receipt-product-link" href="/catalog/products/61">Товар каталога: Молоко 1 л</a>')
    expect(narrow[0].heading).toContain('<span class="receipt-line-relation">Залог: <a href="#receipt-line-103">Строка 3: PFAND</a></span>')
    expect(narrow[1].heading).toContain('<span class="receipt-warning">Товар не сопоставлен</span>')
    expect(narrow[2].heading).toContain('Залог к <a href="#receipt-line-101">Строка 1: MILCH 1 L</a>')
    expect(narrow[3].heading).toContain('Строка 4 · Услуга')
    expect(narrow[4].heading).toContain('Возврат залога')
    expect(cards(lines).match(/Товар не сопоставлен/g)).toHaveLength(4)
  })

  it('makes the card the target of a line link: id and tabindex of the former row, once per line', () => {
    const wide = rows(table(lines))
    const narrow = cards(lines)
    expect(items(narrow).map((card) => card.id)).toEqual(wide.map((row) => row.id))
    for (const line of lines) expect(narrow.match(new RegExp(` id="receipt-line-${line.id}"`, 'g'))).toHaveLength(1)
    expect(narrow.match(/tabindex="-1"/g)).toHaveLength(lines.length)
    expect(narrow).not.toContain('tabindex="0"')
    // Every link of the list points at a card of the same list.
    for (const [, target] of narrow.matchAll(/href="#(receipt-line-\d+)"/g)) expect(narrow).toContain(`<li class="ck-card" id="${target}" tabindex="-1">`)
  })

  it('keeps the identity of a parent line that is on another page', () => {
    const html = cards([{ ...milk, kind: 'deposit', parent_id: 999 }])
    expect(html).toContain('Залог к <span>Строка ID 999 (на другой странице строк)</span>')
    expect(html).not.toContain('href="#receipt-line-999"')
  })

  it('leaves out a zero discount, in any spelling of the source value', () => {
    for (const discount_amount of ['0.00', '0', '0.0', '0.000', '00.00', '-0.00']) {
      expect(labels(one({ discount_amount, paid_amount: '2.00' }))).toEqual(['Количество', 'Цена', 'Сумма', 'Оплачено'])
    }
    for (const discount_amount of ['0.01', '-0.20', '0.001']) expect(labels(one({ discount_amount }))).toContain('Скидка')
    expect(rows(table([{ ...milk, discount_amount: '0.00' }]))[0].cells[3]).toBe('0,00 EUR')
  })

  it('leaves out the paid amount equal to the amount, comparing the source values and not the formatted text', () => {
    expect(labels(one({ amount: '2.58', paid_amount: '2.58' }))).toEqual(['Количество', 'Цена', 'Сумма', 'Скидка'])
    expect(labels(one({ amount: '2.5', paid_amount: '2.50' }))).not.toContain('Оплачено')
    expect(labels(one({ amount: '-0.25', paid_amount: '-0.25' }))).not.toContain('Оплачено')
    expect(labels(one({ amount: '0.00', paid_amount: '-0.00' }))).not.toContain('Оплачено')
    // Both read "2,58 EUR", but the values differ: the fact stays.
    const close = one({ amount: '2.58', paid_amount: '2.584' })
    expect(close.filter(([label]) => label === 'Сумма' || label === 'Оплачено')).toEqual([['Сумма', '2,58 EUR'], ['Оплачено', '2,58 EUR']])
    expect(labels(one({ amount: '0.25', paid_amount: '-0.25' }))).toContain('Оплачено')
  })

  it('shows only quantity, price and amount for a line without a discount', () => {
    expect(one({ amount: '2.58', discount_amount: '0.00', paid_amount: '2.58' })).toEqual([
      ['Количество', '2 шт'], ['Цена', '1,29 EUR'], ['Сумма', '2,58 EUR']])
    const [row] = rows(table([{ ...milk, discount_amount: '0.00', paid_amount: '2.58' }]))
    expect(row.cells).toHaveLength(5)
  })

  it('shows a value that was not read instead of hiding it', () => {
    const unread = one({ discount_amount: null as unknown as string, paid_amount: null as unknown as string })
    expect(unread.slice(3)).toEqual([['Скидка', 'Не распознано'], ['Оплачено', 'Не распознано']])
    const both = one({ amount: 'x', paid_amount: 'x' })
    expect(both.filter(([label]) => label === 'Сумма' || label === 'Оплачено')).toEqual([['Сумма', 'Не распознано'], ['Оплачено', 'Не распознано']])
  })

  it('keeps the notes above the list and the amounts without a currency while the receipt is not loaded', () => {
    screen.narrow = true
    const html = renderToStaticMarkup(<ReceiptLines lines={[milk]} />)
    expect(html).toContain('Валюта: Не распознано')
    expect(html.indexOf('«Оплачено» учитывает скидку строки')).toBeLessThan(html.indexOf('class="ck-cards"'))
    expect(items(html)[0].facts).toEqual([['Количество', '2 шт'], ['Цена', '1,29'], ['Сумма', '2,58'], ['Скидка', '0,20'], ['Оплачено', '2,38']])
  })

  it('has no date in a line: nothing of a date outside <time>, no foreign rows in an own receipt', () => {
    const html = cards(lines)
    expect(html).not.toContain('<time')
    expect(text(html)).not.toMatch(/\d{2}\.\d{2}\.\d{4}/)
  })
})

describe('receipt screen on a phone (Vitest/SSR)', () => {
  const noop = () => {}
  const loaded = <T,>(data: T): BlockRequest<T> => ({ state: { kind: 'ok', data }, retry: noop })
  const emptyPage = <T,>(): Page<T> => ({ count: 0, page: 1, page_size: 50, pages: 0, results: [] })
  const images = publicFixture('receipt-images.json') as Page<ReceiptImage>
  const view: ReceiptViewProps = {
    receiptId: 71, header: loaded(receipt), lines: loaded(page), images: loaded({ ...images, results: images.results.filter((image) => image.receipt_id === 71) }),
    discounts: loaded(publicFixture('discounts.json') as Page<Discount>), taxes: loaded(publicFixture('taxes.json') as Page<Tax>),
    pages: { images: 1, lines: 1, discounts: 1, taxes: 1 }, onPage: noop,
  }
  const narrow = (props: ReceiptViewProps) => {
    screen.narrow = true
    try { return renderToStaticMarkup(<ReceiptView {...props} />) } finally { screen.narrow = false }
  }

  it('leads the link of a discount to the card of its line', () => {
    const html = narrow(view)
    expect(html).toContain('Скидка к <a href="#receipt-line-101">')
    expect(html.match(/ id="receipt-line-101"/g)).toHaveLength(1)
    expect(html).toContain('<li class="ck-card" id="receipt-line-101" tabindex="-1">')
    expect(html).not.toContain('<table')
  })

  it.each([
    ['loading', { state: { kind: 'loading' as const }, retry: noop }, 'request-state-loading'],
    ['an error', { state: { kind: 'error' as const, reason: 'network' as const }, retry: noop }, 'data-request-retry'],
    ['an empty page', loaded(emptyPage<Line>()), 'В этом чеке нет строк.'],
  ])('does not choose a view while the lines block shows %s', (_name, lines, mark) => {
    const phone = narrow({ ...view, lines: lines as BlockRequest<Page<Line>> })
    expect(phone).toContain(mark)
    expect(phone).not.toContain('ck-card')
    expect(phone).toBe(renderToStaticMarkup(<ReceiptView {...view} lines={lines as BlockRequest<Page<Line>>} />))
  })
})

describe('receipt filters action bar (Vitest/SSR)', () => {
  const failure = { kind: 'error' as const, reason: 'invalid_parameter' as const, status: 400, fields: ['q'] }
  const html = renderToStaticMarkup(<ReceiptFilters query={{ page: 1, q: 'MILCH' }} failure={failure} />)

  it('adds the pinned bar as the second class of the former wrapper', () => {
    expect(html.match(/ck-action-bar/g)).toHaveLength(1)
    expect(html).toContain('<div class="receipt-actions ck-action-bar"><button type="submit">Применить фильтры</button><button type="button" class="receipt-secondary">Сбросить фильтры</button></div></form>')
  })

  it('keeps the explanation and the refusal outside the bar, before it', () => {
    const [before, bar] = html.split('<div class="receipt-actions ck-action-bar">')
    expect(before).toContain('Поиск: от 2 до 100 символов.')
    expect(before).toContain('<p class="receipt-field-error" role="alert">Исправьте поля фильтров.</p>')
    expect(bar).not.toContain('<p')
    expect(text(bar)).toBe('Применить фильтрыСбросить фильтры')
  })
})
