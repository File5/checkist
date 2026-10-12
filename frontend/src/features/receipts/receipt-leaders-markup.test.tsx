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
const factOrder = ['Количество и цена', 'Сумма', 'Скидка', 'Оплачено']
/** A row of the phone view: the name, the facts under it, the details, the amount at the right — the facts read back with the
 * amount in the order of the table columns. */
const items = (html: string) => [...html.matchAll(/<li id="(receipt-line-\d+)" tabindex="-1" class="receipt-leader"><div class="receipt-leader-main"><span class="receipt-printed-name">([^<]*)<\/span>(?:<dl class="receipt-leader-facts">([\s\S]*?)<\/dl>)?([\s\S]*?)<\/div><span class="receipt-leader-amount ck-figures"><span class="receipt-visually-hidden">Сумма: <\/span>([^<]*)<\/span><\/li>/g)]
  .map((match) => ({ id: match[1], name: match[2], details: match[4],
    facts: [...[...(match[3] ?? '').matchAll(/<div><dt(?: class="receipt-visually-hidden")?>([^<]*)<\/dt><dd class="receipt-number">([^<]*)<\/dd><\/div>/g)].map((fact) => [fact[1], fact[2]]), ['Сумма', match[5]]]
      .sort((a, b) => factOrder.indexOf(a[0]) - factOrder.indexOf(b[0])) }))
const one = (line: Partial<Line>) => items(cards([{ ...milk, ...line }]))[0].facts
const labels = (facts: string[][]) => facts.map(([label]) => label)
/** The value of the same line in the table, by the label of a fact of the phone row. */
const cellOf = (cells: string[], label: string) => label === 'Количество и цена' ? `${cells[0]} × ${cells[1]}`
  : cells[['Количество', 'Цена', 'Сумма', 'Скидка', 'Оплачено'].indexOf(label)]

describe('receipt line rows (Vitest/SSR of the phone view, not browser visual acceptance)', () => {
  it('draws the table on a wide screen and only the rows of the card on a phone', () => {
    const wide = table(lines)
    expect(wide).toContain('<table class="receipt-lines-table">')
    expect(wide).not.toContain('receipt-leader')
    const narrow = cards(lines)
    expect(narrow).not.toContain('<table')
    expect(narrow).not.toContain('role="region"')
    expect(narrow).not.toContain('receipt-table-scroll')
    // No dotted leaders any more: the amount stands at the right of the row like in the list of spends.
    expect(narrow).not.toContain('ck-leader')
    expect(narrow).toContain('<div class="receipt-leaders"><p class="receipt-note">Строки в порядке печати на чеке</p><ol class="receipt-leader-list" aria-label="Строки чека">')
    expect(narrow.match(/class="receipt-leader"/g)).toHaveLength(lines.length)
    expect(items(narrow)).toHaveLength(lines.length)
  })

  it('puts the printed name first, the facts under it, then the category as a chip, the amount at the right in the figures font', () => {
    const grocery: Line = { ...bread, category: { id: 3, name: 'Продукты' } } as Line
    const [row] = items(cards([grocery]))
    expect(row.name).toBe('ХЛЕБ')
    expect(row.details.startsWith('<span class="receipt-line-chip" data-tone="3"><span class="receipt-visually-hidden">Категория: </span>Продукты</span><span class="receipt-note">Строка 2 · Товар</span>')).toBe(true)
    expect(row.details).not.toContain('Категория: Продукты</span>')
    // A category instead of the unmatched mark, like in the table.
    expect(row.details).not.toContain('Товар не сопоставлен')
    // The table keeps its former words for the category.
    expect(table([grocery])).toContain('<span class="receipt-note receipt-line-category">Категория: Продукты</span>')
  })

  it('says the quantity and the price in one fact and the discount and the paid amount by the headings of the table', () => {
    expect(headings(table([milk]))).toEqual(['Строка и товар каталога', 'Количество', 'Цена', 'Сумма', 'Скидка', 'Оплачено'])
    const [row] = rows(table([milk]))
    const [card] = items(cards([milk]))
    // The fixture line has two pieces and a discount, so no fact is left out.
    expect(card.facts).toEqual([['Количество и цена', '2\u00a0шт × 1,29\u00a0€'], ['Сумма', '3\u00a0€'], ['Скидка', '1\u00a0€'], ['Оплачено', '3\u00a0€']])
    expect(row.cells).toEqual(['2\u00a0шт', '1,29\u00a0€', '3\u00a0€', '1\u00a0€', '3\u00a0€'])
    // The words of the quantity and the price are read by a screen reader only.
    expect(cards([milk])).toContain('<dt class="receipt-visually-hidden">Количество и цена</dt><dd class="receipt-number">2\u00a0шт × 1,29\u00a0€</dd>')
  })

  it('keeps every shown value equal to the cell of the same column', () => {
    const wide = rows(table(lines))
    const narrow = items(cards(lines))
    expect(wide).toHaveLength(lines.length)
    for (const [index, card] of narrow.entries()) {
      for (const [label, value] of card.facts) expect(value, `${card.id} ${label}`).toBe(cellOf(wide[index].cells, label))
    }
  })

  it('moves the content of the row heading under the name: number, kind, printed name, catalog link, relations', () => {
    const wide = rows(table(lines))
    const narrow = items(cards(lines))
    // The same pieces; the facts are the other cells of the table.
    const pieces = (html: string) => [...html.matchAll(/<(?:span|a)[^>]*>[^<]*/g)].map((match) => match[0]).sort()
    expect(narrow.map((card) => pieces(`<span class="receipt-printed-name">${card.name}</span>${card.details}`))).toEqual(wide.map((row) => pieces(row.heading)))
    expect(narrow[0].details).toContain('<span class="receipt-note">Строка 1 · Товар</span>')
    expect(narrow[0].details).toContain('<a class="receipt-product-link" href="/catalog/products/61">Товар каталога: Молоко 1 л</a>')
    expect(narrow[0].details).toContain('<span class="receipt-line-relation">Залог: <a href="#receipt-line-103">Строка\u00a03: PFAND</a></span>')
    expect(narrow[1].details).toContain('<span class="receipt-warning">Товар не сопоставлен</span>')
    expect(narrow[2].details).toContain('Залог к <a href="#receipt-line-101">Строка\u00a01: MILCH 1 L</a>')
    expect(narrow[3].details).toContain('Строка\u00a04 · Услуга')
    expect(narrow[4].details).toContain('Возврат залога')
    expect(cards(lines).match(/Товар не сопоставлен/g)).toHaveLength(4)
  })

  it('makes the row the target of a line link: id and tabindex of the former row, once per line', () => {
    const wide = rows(table(lines))
    const narrow = cards(lines)
    expect(items(narrow).map((card) => card.id)).toEqual(wide.map((row) => row.id))
    for (const line of lines) expect(narrow.match(new RegExp(` id="receipt-line-${line.id}"`, 'g'))).toHaveLength(1)
    expect(narrow.match(/tabindex="-1"/g)).toHaveLength(lines.length)
    expect(narrow).not.toContain('tabindex="0"')
    // Every link of the list points at a row of the same list.
    for (const [, target] of narrow.matchAll(/href="#(receipt-line-\d+)"/g)) expect(narrow).toContain(`<li id="${target}" tabindex="-1" class="receipt-leader">`)
  })

  it('keeps the identity of a parent line that is on another page', () => {
    const html = cards([{ ...milk, kind: 'deposit', parent_id: 999 }])
    expect(html).toContain('Залог к <span>Строка\u00a0ID\u00a0999 (на другой странице строк)</span>')
    expect(html).not.toContain('href="#receipt-line-999"')
  })

  it('leaves out a zero discount, in any spelling of the source value', () => {
    for (const discount_amount of ['0.00', '0', '0.0', '0.000', '00.00', '-0.00']) {
      expect(labels(one({ discount_amount, paid_amount: '2.00' }))).toEqual(['Количество и цена', 'Сумма', 'Оплачено'])
    }
    for (const discount_amount of ['0.01', '-0.20', '0.001']) expect(labels(one({ discount_amount }))).toContain('Скидка')
    expect(rows(table([{ ...milk, discount_amount: '0.00' }]))[0].cells[3]).toBe('0\u00a0€')
  })

  it('leaves out the paid amount equal to the amount, comparing the source values and not the formatted text', () => {
    expect(labels(one({ amount: '2.58', paid_amount: '2.58' }))).toEqual(['Количество и цена', 'Сумма', 'Скидка'])
    expect(labels(one({ amount: '2.5', paid_amount: '2.50' }))).not.toContain('Оплачено')
    expect(labels(one({ amount: '-0.25', paid_amount: '-0.25' }))).not.toContain('Оплачено')
    expect(labels(one({ amount: '0.00', paid_amount: '-0.00' }))).not.toContain('Оплачено')
    // Both read "3 €", but the values differ: the fact stays.
    const close = one({ amount: '2.58', paid_amount: '2.584' })
    expect(close.filter(([label]) => label === 'Сумма' || label === 'Оплачено')).toEqual([['Сумма', '3\u00a0€'], ['Оплачено', '3\u00a0€']])
    expect(labels(one({ amount: '0.25', paid_amount: '-0.25' }))).toContain('Оплачено')
  })

  it('leaves out the quantity and the price of a single piece: the price is the amount itself', () => {
    expect(one({ amount: '2.58', discount_amount: '0.00', paid_amount: '2.58' })).toEqual([['Количество и цена', '2\u00a0шт × 1,29\u00a0€'], ['Сумма', '3\u00a0€']])
    for (const quantity of ['1', '1.000', '01.0']) {
      expect(one({ quantity, amount: '1.29', discount_amount: '0.00', paid_amount: '1.29' }), quantity).toEqual([['Сумма', '2\u00a0€']])
    }
    // Nothing to say under the name: no empty list of facts.
    expect(cards([{ ...milk, quantity: '1.000', discount_amount: '0.00', paid_amount: milk.amount }])).not.toContain('receipt-leader-facts')
    expect(labels(one({ quantity: '0.532' }))).toContain('Количество и цена')
  })

  it('shows a value that was not read instead of hiding it', () => {
    const unread = one({ discount_amount: null as unknown as string, paid_amount: null as unknown as string })
    expect(unread.filter(([label]) => label === 'Скидка' || label === 'Оплачено')).toEqual([['Скидка', 'Не распознано'], ['Оплачено', 'Не распознано']])
    const both = one({ amount: 'x', paid_amount: 'x' })
    expect(both.filter(([label]) => label === 'Сумма' || label === 'Оплачено')).toEqual([['Сумма', 'Не распознано'], ['Оплачено', 'Не распознано']])
  })

  it('keeps the notes above the list and the amounts without a currency while the receipt is not loaded', () => {
    screen.narrow = true
    const html = renderToStaticMarkup(<ReceiptLines lines={[milk]} />)
    expect(html).toContain('Валюта: Не распознано')
    expect(html.indexOf('«Оплачено» учитывает скидку строки')).toBeLessThan(html.indexOf('class="receipt-leaders"'))
    expect(items(html)[0].facts).toEqual([['Количество и цена', '2\u00a0шт × 1,29'], ['Сумма', '3'], ['Скидка', '1'], ['Оплачено', '3']])
  })

  it('shows a spend typed by hand without the printed order, the numbers of its lines or an unmatched mark', () => {
    const coffee: Line = { ...bread, id: 201, position: 1, name: 'Капучино', quantity: '1.000', amount: '1500.00', paid_amount: '1500.00', category: { id: 2, name: 'Кафе' } } as Line
    const water: Line = { ...coffee, id: 202, position: 2, name: 'Вода', category: null }
    screen.narrow = true
    const html = renderToStaticMarkup(<ReceiptLines lines={[coffee, water]} currency="KZT" manual />)
    expect(html).not.toContain('Строки в порядке печати')
    expect(html).not.toContain('«Оплачено»')
    expect(html).not.toContain('Строка ')
    expect(html).not.toContain('Товар не сопоставлен')
    const [first, second] = items(html)
    expect(first.details).toBe('<span class="receipt-line-chip" data-tone="2"><span class="receipt-visually-hidden">Категория: </span>Кафе</span>')
    expect(first.facts).toEqual([['Сумма', '1 500 ₸']])
    expect(second.details).toBe('')
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

  it('leads the link of a discount to the leader row of its line', () => {
    const html = narrow(view)
    expect(html).toContain('Скидка к <a href="#receipt-line-101">')
    expect(html.match(/ id="receipt-line-101"/g)).toHaveLength(1)
    expect(html).toContain('<li id="receipt-line-101" tabindex="-1" class="receipt-leader">')
    expect(html).not.toContain('<table')
  })

  it.each([
    ['loading', { state: { kind: 'loading' as const }, retry: noop }, 'request-state-loading'],
    ['an error', { state: { kind: 'error' as const, reason: 'network' as const }, retry: noop }, 'data-request-retry'],
    ['an empty page', loaded(emptyPage<Line>()), 'В этом чеке нет строк.'],
  ])('does not choose a view while the lines block shows %s', (_name, lines, mark) => {
    const phone = narrow({ ...view, lines: lines as BlockRequest<Page<Line>> })
    expect(phone).toContain(mark)
    expect(phone).not.toContain('receipt-leader')
    expect(phone).toBe(renderToStaticMarkup(<ReceiptView {...view} lines={lines as BlockRequest<Page<Line>>} />))
  })
})

describe('receipt filters action bar (Vitest/SSR)', () => {
  const failure = { kind: 'error' as const, reason: 'invalid_parameter' as const, status: 400, fields: ['q'] }
  const html = renderToStaticMarkup(<ReceiptFilters query={{ page: 1, q: 'MILCH' }} failure={failure} />)

  it('adds the pinned bar as the second class of the former wrapper', () => {
    expect(html.match(/ck-action-bar/g)).toHaveLength(1)
    expect(html).toContain('<div class="receipt-actions ck-action-bar"><button type="submit">Применить</button><button type="button" class="receipt-secondary">Сбросить</button></div></form>')
  })

  it('keeps the explanation and the refusal outside the bar, before it', () => {
    const [before, bar] = html.split('<div class="receipt-actions ck-action-bar">')
    expect(before).toContain('Поиск: от 2 до 100 символов.')
    expect(before).toContain('<p class="receipt-field-error" role="alert">Исправьте поля фильтров.</p>')
    expect(bar).not.toContain('<p')
    expect(text(bar)).toBe('ПрименитьСбросить')
  })
})
