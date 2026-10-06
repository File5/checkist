import { describe, expect, it } from 'vitest'
import { fixturesOf, statsFixture } from '../../api/stats-test-support'
import type { Spending } from '../../api/stats'
import { blockView, differenceText, itemKey, pieItems, plural, receiptsText } from './spending-view'

const read = (name: string) => statsFixture(name) as Spending
const nbsp = ' '
const money = (text: string) => text.replaceAll(' ', nbsp)
/** Exact cents of a wire amount: the check never goes through a float. */
const cents = (amount: string) => BigInt(amount.replace('.', ''))

describe('spending answer → chart and table rows (server fixtures)', () => {
  const category = read('spending-category.json')
  const [eur, kzt] = category.currencies

  it('keeps the order, the wire amounts and the shares of the server', () => {
    const items = pieItems(eur, 'category', {})
    expect(items.map((item) => [item.key, item.label, item.valueText, item.shareText])).toEqual([
      ['category:1', 'Продукты питания', money('5 590,75 EUR'), money('42,73 %')],
      ['category:6', 'Не разобрано', money('5 184,91 EUR'), money('39,63 %')],
      ['category:5', 'Бытовая химия', money('1 767,78 EUR'), money('13,51 %')],
      ['unmatched', 'Строки без товара', money('336,88 EUR'), money('2,57 %')],
      ['service', 'Услуги', money('75,84 EUR'), money('0,58 %')],
      ['deposit', 'Залог за тару', money('127,50 EUR'), money('0,97 %')],
    ])
    expect(items.map((item) => item.value)).toEqual([5590.75, 5184.91, 1767.78, 336.88, 75.84, 127.5])
  })
  it('links categories into the drill-down with the current filters and leaves special rows plain and muted', () => {
    const items = pieItems(eur, 'category', { date_from: '2026-01-01', country: 'DE' })
    expect(items.map((item) => item.href)).toEqual([
      '/stats?date_from=2026-01-01&country=DE&category=1', '/stats?date_from=2026-01-01&country=DE&category=6',
      '/stats?date_from=2026-01-01&country=DE&category=5', undefined, undefined, undefined,
    ])
    expect(items.map((item) => item.tone)).toEqual([undefined, undefined, undefined, 'muted', 'muted', 'muted'])
  })
  it('explains «Не разобрано» and the special rows next to their counts', () => {
    const notes = Object.fromEntries(pieItems(eur, 'category', {}).map((item) => [item.key, item.note]))
    expect(notes['category:1']).toBe(`2${nbsp}240 строк · 372 чека.`)
    expect(notes['category:6']).toBe(`Категорию и обобщённый продукт товару назначают в админке. 1${nbsp}832 строки · 373 чека.`)
    expect(notes.unmatched).toBe('Строки чеков, не сопоставленные с товаром каталога. Товар строке назначают в админке. 124 строки · 124 чека.')
    expect(notes.service).toBe('Строки услуг: в категории товаров не входят. 23 строки · 23 чека.')
    expect(notes.deposit).toBe('Залог и возврат тары, чистой суммой. 269 строк · 220 чеков.')
  })
  it('builds one independent block per currency and never adds them up', () => {
    const views = category.currencies.map((block) => blockView(block, 'category', {}))
    expect(views.map((view) => [view.currency, view.title, view.total, view.receipts, view.center])).toEqual([
      ['EUR', 'Траты по категориям, EUR', { label: 'Итого по чекам', text: money('13 041,07 EUR') }, '373 чека',
        { label: 'Сумма строк', value: money('13 083,66 EUR') }],
      ['KZT', 'Траты по категориям, KZT', { label: 'Итого по чекам', text: money('438 091,92 KZT') }, '93 чека',
        { label: 'Сумма строк', value: money('439 741,92 KZT') }],
    ])
    expect(views.every((view) => view.needsAdminHint)).toBe(true)
    expect(views[1].items.every((item) => item.valueText.endsWith('KZT'))).toBe(true)
    expect(kzt.items).toHaveLength(views[1].items.length)
  })
  it('explains the difference between the sum of receipts and the sum of lines', () => {
    expect(differenceText(eur)).toBe(`Сумма чеков — ${money('13 041,07 EUR')}, сумма строк — ${money('13 083,66 EUR')}, разница — ${money('-42,59 EUR')}. `
      + 'Разница — это скидки на весь чек, налог сверх цен и округление: по строкам они не распределяются.')
    const store = read('spending-store.json').currencies[0]
    expect(differenceText(store)).toBe(`Сумма чеков совпадает с суммой строк: ${money('13 041,07 EUR')}.`)
    const filtered = read('spending-generic-filter.json').currencies[0]
    expect(differenceText(filtered)).toContain('считаются только строки сопоставленных товаров')
    expect(blockView(filtered, 'product', { generic: 1, group_by: 'product' }).total).toEqual({ label: 'Сумма строк товаров', text: money('545,75 EUR') })
  })
  it('puts «Прочее» after the regular items and before the special rows', () => {
    const generic = read('spending-generic.json').currencies[0]
    const items = pieItems(generic, 'generic', {})
    expect(items.map((item) => item.key)).toEqual(['generic:15', 'generic:11', 'generic:13', 'generic:3', 'generic:6', 'other', 'unmatched', 'service', 'deposit'])
    expect(items[5]).toEqual({
      key: 'other', label: 'Прочее', value: 3508.72, tone: 'other', valueText: money('3 508,72 EUR'), shareText: money('26,82 %'),
      note: 'Ещё 9 обобщённых продуктов с меньшими суммами, одной строкой.',
    })
    expect(items[0].note).toContain('назначают в админке')
    expect(items[1].href).toBe('/stats?group_by=product&generic=11')
    // Without special rows «Прочее» is simply the last one.
    const plain = pieItems({ ...generic, items: generic.items.filter((item) => item.id !== null) }, 'generic', {})
    expect(plain.at(-1)?.key).toBe('other')
  })
  it('sends a product row to the product card and shows its quantity', () => {
    const product = read('spending-product.json')
    const items = pieItems(product.currencies[0], 'product', { date_from: '2026-01-01', date_to: '2026-09-30', group_by: 'product' })
    expect(items[0]).toMatchObject({ key: 'product:24', label: 'Demo Hähnchenbrust 600g', href: '/catalog/products/24', note: `18 строк · 18 чеков · 18${nbsp}шт.` })
    expect(items.find((item) => item.key === 'other')?.note).toBe('Ещё 25 товаров с меньшими суммами, одной строкой.')
    expect(blockView(product.currencies[0], 'product', {}).title).toBe('Траты по товарам, EUR')
  })
  it('tells stores of one chain apart and uses the sum of receipts', () => {
    const view = blockView(read('spending-store.json').currencies[0], 'store', { group_by: 'store' })
    expect(view.items.map((item) => [item.label, item.href])).toEqual([
      ['Zahlenfrisch · Musterstadt · DE · ID 1', undefined], ['Beispielkorb · Beispielhausen · DE · ID 2', undefined],
    ])
    expect(view.center.label).toBe('Сумма чеков')
    expect(view.needsAdminHint).toBe(false)
  })
  it('marks the category of the filter itself as products without a subcategory', () => {
    const drilldown = read('spending-category-drilldown.json')
    const items = pieItems(drilldown.currencies[0], 'category', { category: 1 })
    expect(items.map((item) => [item.key, item.label, item.href])).toEqual([
      ['category:2', 'Молочные продукты', '/stats?category=2'],
      ['direct:1', 'Продукты питания: товары без подкатегории', '/stats?group_by=generic&category=1'],
      ['category:4', 'Овощи и фрукты', '/stats?category=4'],
      ['category:3', 'Хлеб', '/stats?category=3'],
    ])
  })
  it('keeps an item that is not positive for the table only: no share, a value the chart will not draw', () => {
    const refund = read('spending-refund-day.json').currencies[0]
    const [item] = pieItems(refund, 'category', { date_from: '2026-03-14', date_to: '2026-03-14' })
    expect(item).toMatchObject({ key: 'category:6', value: -7.14, valueText: money('-7,14 EUR'), shareText: '—' })
    expect(blockView(refund, 'category', {}).receipts).toBe('1 чек')
  })
  it.each(fixturesOf('spending-'))('%s: rows are unique and their amounts still add up to the sum of lines', (name) => {
    const data = read(name)
    for (const block of data.currencies) {
      const items = pieItems(block, data.group_by, {})
      expect(new Set(items.map((item) => item.key)).size).toBe(items.length)
      expect(items).toHaveLength(block.items.length + (block.other ? 1 : 0))
      const sum = block.items.reduce((total, item) => total + cents(item.amount), 0n) + (block.other ? cents(block.other.amount) : 0n)
      expect(sum).toBe(cents(block.totals.lines_paid))
      expect(new Set(block.items.map(itemKey)).size).toBe(block.items.length)
      for (const [index, item] of block.items.entries()) {
        const row = items.find((entry) => entry.key === itemKey(item))
        expect(row?.value).toBe(Number(item.amount))
        expect(row?.shareText === '—').toBe(item.share_percent === null)
        expect(index).toBeLessThan(items.length)
      }
    }
  })
  it('counts in Russian', () => {
    expect([1, 2, 5, 11, 21, 22, 25, 111].map((count) => plural(count, 'чек', 'чека', 'чеков')))
      .toEqual(['чек', 'чека', 'чеков', 'чеков', 'чек', 'чека', 'чеков', 'чеков'])
    expect(receiptsText(1234)).toBe(`1${nbsp}234 чека`)
  })
})
