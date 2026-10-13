import { describe, expect, it } from 'vitest'
import type { Line, Receipt } from '../../api/receipts'
import type { Category } from '../../api/types'
import {
  CHIPS_SHOWN, amountText, categoryChips, chipLabel, clearExpenseNotice, draftBody, draftFromReceipt, emptyDraft,
  getExpenseNotice, linesTotal, sentIndexes, messages, newLine, normalizeAmount, serverErrors, setExpenseNotice, todayISO, visibleChips,
  categoryTree, chipParent, chipToneId, dateChoice, dayBefore, fieldScrollDelta, itemizedTotal, saveLabel, shortDay, sumText,
} from './expense-form'
import type { ExpenseDraft, LineDraft } from './expense-form'

const category = (id: number, name: string, parent?: Category): Category => ({
  id, name, path: [...(parent ? parent.path : []), { id, name }], parent_id: parent?.id ?? null, depth: parent ? parent.depth + 1 : 0,
  children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})
const food = category(1, 'Еда')
const cafe = category(2, 'Кафе', food)
const transport = category(3, 'Транспорт')
const unassigned = category(9, 'Не разобрано')
const draft = (patch: Partial<ExpenseDraft> = {}): ExpenseDraft => ({ ...emptyDraft('KZT', '2026-10-12'), ...patch })
const line = (name: string, amount: string, lineCategory: number | null = null): LineDraft => ({ ...newLine(), name, amount, category: lineCategory })

describe('amounts typed on a phone', () => {
  it.each([
    ['450', '450'], ['1 250,50', '1250.50'], ['1 250', '1250'], [' 12.5 ', '12.5'], ['0,01', '0.01'],
  ])('reads %j as %j', (typed, value) => expect(normalizeAmount(typed)).toBe(value))
  it.each(['', '0', '0,00', '-5', '1.234', '1e3', 'abc', '12,5,0', '1234567890123'])('refuses %j', (typed) => {
    expect(normalizeAmount(typed)).toBeUndefined()
  })
  it('adds positions in cents without float errors', () => {
    expect(linesTotal([line('А', '0,1'), line('Б', '0.2')])).toBe('0.30')
    expect(linesTotal([line('А', '1250,50'), line('', ''), line('Б', '99.5')])).toBe('1350.00')
    expect(linesTotal([line('А', 'x')])).toBeUndefined()
    expect(linesTotal([line('', '')])).toBeUndefined()
  })
  it('shows a saved amount as a person types it', () => {
    expect(amountText('12500.00')).toBe('12500')
    expect(amountText('12.50')).toBe('12.50')
  })
  it('takes the local calendar date', () => {
    expect(todayISO(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
})

describe('the body of a save', () => {
  it('sends one amount in a category with an empty list of positions', () => {
    expect(draftBody(draft({ amount: '1 200,5', category: 2, place: '  Кофейня ', note: ' с другом ' }))).toEqual({ body: {
      currency: 'KZT', purchased_on: '2026-10-12', store_name: 'Кофейня', note: 'с другом', category: 2, total: '1200.5', lines: [],
      item_name: null,
    } })
  })
  it('sends «Что купили» of one amount and never with positions', () => {
    expect(draftBody(draft({ amount: '5000', category: 2, item: '  Стрижка ' }))).toMatchObject({ body: { item_name: 'Стрижка', lines: [] } })
    expect(draftBody(draft({ amount: '5000', category: 2, item: 'я'.repeat(201) }))).toEqual({ errors: { item: messages.item } })
    const itemized = draftBody(draft({ category: 1, item: 'Стрижка', lines: [line('Хлеб', '250')] }))
    expect('item_name' in (itemized as { body: object }).body).toBe(false)
  })
  it('sends no place as null', () => {
    const result = draftBody(draft({ amount: '5', category: 1 }))
    expect('body' in result && result.body.store_name).toBeNull()
  })
  it('asks for an amount and a category without positions', () => {
    expect(draftBody(draft())).toEqual({ errors: { amount: messages.amount, category: messages.category } })
  })
  it('lets positions carry the total and keeps their own categories', () => {
    const result = draftBody(draft({ amount: '999', category: 1, lines: [line('Хлеб', '250'), line('', ''), line('Такси', '1200', 3)] }))
    // Every position is a line of a receipt (2026-10-13): quantity, unit, sum before the discount, discount, category.
    expect(result).toEqual({ body: {
      currency: 'KZT', purchased_on: '2026-10-12', store_name: null, note: '', category: 1,
      lines: [{ name: 'Хлеб', quantity: '1', unit: 'pcs', amount: '250', discount_amount: '0', category: null },
        { name: 'Такси', quantity: '1', unit: 'pcs', amount: '1200', discount_amount: '0', category: 3 }],
    } })
  })
  it('marks the wrong position by its index among the typed ones', () => {
    expect(draftBody(draft({ lines: [line('', ''), line('', '5'), line('Сок', '0')] }))).toEqual({ errors: {
      'lines.0.name': messages.lineName, 'lines.1.amount': messages.lineAmount,
    } })
  })
  it('maps rows of the form to the sent positions', () => {
    expect(sentIndexes([line('', ''), line('', '5'), line('', ''), line('Сок', '0')])).toEqual([-1, 0, -1, 1])
  })
  it('checks currency, date, place and note', () => {
    const result = draftBody(draft({ amount: '1', category: 1, currency: 'K1', date: '', place: 'я'.repeat(101), note: 'я'.repeat(1001) }))
    expect(result).toEqual({ errors: { currency: messages.currency, date: messages.date, place: messages.place, note: messages.note } })
  })
  it('turns server field names into the messages of this form', () => {
    expect(serverErrors(['total', 'category', 'purchased_on', 'store_name', 'item_name', 'lines.2.amount', 'lines.0.name', 'lines.1.category', 'surprise']))
      .toEqual({
        amount: messages.total, category: messages.category, date: messages.date, place: messages.place, item: messages.item,
        'lines.2.amount': messages.lineAmount, 'lines.0.name': messages.lineName, 'lines.1.amount': messages.category, form: messages.unknown,
      })
  })
})

describe('a saved spend in the form', () => {
  const receipt = { id: 5, source: 'manual', store: null, note: 'кофе', currency: 'KZT', purchased_on: '2026-10-01', total: '450.00' } as Receipt
  let ids = 0
  const saved = (name: string, amount: string, lineCategory: { id: number; name: string } | null,
    product: { id: number; name: string } | null = null) => ({ id: ++ids, name, amount, category: lineCategory, product,
    quantity: '1.000', unit: 'pcs', unit_price: `${amount}00`, discount_amount: '0.00', paid_amount: amount }) as Line
  it('opens one line named after its category as one amount', () => {
    expect(draftFromReceipt(receipt, [saved('Кафе', '450.00', { id: 2, name: 'Кафе' })])).toEqual({
      amount: '450', currency: 'KZT', category: 2, date: '2026-10-01', place: '', note: 'кофе', lines: [], method: '', item: '',
      source: 'manual',
    })
    // The way of payment of the spend comes with it and goes back in the body; not said — not sent at all.
    const kaspi = draftFromReceipt({ ...receipt, payment_method: 'kaspi_gold' }, [saved('Кафе', '450.00', { id: 2, name: 'Кафе' })])
    expect(kaspi.method).toBe('kaspi_gold')
    expect(draftBody(kaspi)).toMatchObject({ body: { payment_method: 'kaspi_gold' } })
    expect('payment_method' in (draftBody({ ...kaspi, method: undefined }) as { body: object }).body).toBe(false)
  })
  it('opens one named line as one amount with «Что купили»', () => {
    const named = draftFromReceipt(receipt, [saved('Подписка Claude Max 20x', '450.00', { id: 2, name: 'Кафе' }, { id: 9, name: 'Подписка Claude Max 20x' })])
    expect([named.amount, named.category, named.item, named.lines]).toEqual(['450', 2, 'Подписка Claude Max 20x', []])
    // A product named like the category is still a named purchase; an older spend of one position opens the same way.
    expect(draftFromReceipt(receipt, [saved('Кафе', '450.00', { id: 2, name: 'Кафе' }, { id: 9, name: 'Кафе' })]).item).toBe('Кафе')
    expect(draftFromReceipt(receipt, [saved('Стрижка', '450.00', { id: 2, name: 'Кафе' })]).item).toBe('Стрижка')
  })
  it('opens any other spend with its positions', () => {
    const result = draftFromReceipt({ ...receipt, store: { id: 1, name: 'Рынок', city: '', country: 'KZ', address: '', timezone: 'Asia/Almaty' } },
      [saved('Хлеб', '250.00', { id: 1, name: 'Еда' }), saved('Такси', '200.50', null)])
    expect(result.place).toBe('Рынок')
    expect(result.category).toBeNull()
    expect(result.lines.map(({ name, amount, category: own }) => [name, amount, own])).toEqual([['Хлеб', '250', 1], ['Такси', '200.50', null]])
    // Saved lines go back with their ids: each keeps its product while its name stays.
    expect(result.lines.every((row) => typeof row.id === 'number')).toBe(true)
  })
  it('opens a photo receipt as its lines, with the discount of the whole receipt and the place required', () => {
    const photo = { ...receipt, source: 'photo', discount_total: '150.00', store: { id: 1, name: 'Магнум', city: '', country: 'KZ', address: '', timezone: 'Asia/Almaty' } } as Receipt
    const milk = { ...saved('Молоко', '1000.00', null, { id: 7, name: 'Молоко' }), quantity: '2.000', unit_price: '500.0000', discount_amount: '100.00', paid_amount: '900.00' } as Line
    const result = draftFromReceipt(photo, [milk])
    expect([result.source, result.extraDiscount, result.lines.length, result.lines[0].discount, result.lines[0].amount]).toEqual(['photo', '50', 1, '100', '900'])
    expect(itemizedTotal(result)).toBe('850.00')
    expect(draftBody({ ...result, place: ' ' })).toEqual({ errors: { place: messages.placeRequired } })
    expect(draftBody(result)).toMatchObject({ body: { store_name: 'Магнум', lines: [
      { id: milk.id, name: 'Молоко', quantity: '2', unit: 'pcs', unit_price: '500', amount: '1000', discount_amount: '100', category: null }] } })
  })
  it('opens a spend from a statement with its note without the mark', () => {
    const spend = { ...receipt, note: 'кофе · Выписка Kaspi Gold', payment_method: 'kaspi_gold', statement: { bank: 'kaspi_gold', label: 'Выписка Kaspi Gold' } } as Receipt
    const result = draftFromReceipt(spend, [saved('Кафе', '450.00', { id: 2, name: 'Кафе' })])
    expect([result.note, result.statement, result.method]).toEqual(['кофе', 'Выписка Kaspi Gold', 'kaspi_gold'])
  })
})

describe('category chips', () => {
  const all = [food, cafe, transport, unassigned]
  it('puts the categories of earlier spends first and never offers «Не разобрано»', () => {
    expect(categoryChips(all, [3, 99, 2]).map((item) => item.id)).toEqual([3, 2, 1])
    expect(categoryChips(all, []).map((item) => item.id)).toEqual([1, 2, 3])
  })
  it('names a nested category with its parent', () => {
    expect(chipLabel(cafe)).toBe('Еда › Кафе')
    expect(chipLabel(food)).toBe('Еда')
  })
  it('shows the first chips and the chosen one beyond them', () => {
    const many = Array.from({ length: CHIPS_SHOWN + 3 }, (_, index) => category(index + 10, `К${index}`))
    expect(visibleChips(many, null, false)).toHaveLength(CHIPS_SHOWN)
    expect(visibleChips(many, many.at(-1)!.id, false).at(-1)).toBe(many.at(-1))
    expect(visibleChips(many, null, true)).toHaveLength(many.length)
    // Six chips and «Все категории…»: the seven pills of the artifact.
    expect(CHIPS_SHOWN).toBe(6)
  })
})

describe('the notice after a save', () => {
  it('belongs to one spend until cleared', () => {
    setExpenseNotice(7, 'Трата сохранена.')
    expect(getExpenseNotice(8)).toBeUndefined()
    expect(getExpenseNotice(7)).toBe('Трата сохранена.')
    clearExpenseNotice()
    expect(getExpenseNotice(7)).toBeUndefined()
  })
})

describe('the mobile spend form', () => {
  it('names the rounded amount on the save button, the positions sum when there are any', () => {
    expect(saveLabel(emptyDraft('KZT'))).toBe('Сохранить')
    expect(saveLabel({ ...emptyDraft('KZT'), amount: '12 500,01' })).toBe('Сохранить · 12\u00a0501\u00a0₸')
    expect(saveLabel({ ...emptyDraft('KZT'), amount: '0' })).toBe('Сохранить')
    expect(saveLabel({ ...emptyDraft('kz'), amount: '10' })).toBe('Сохранить · 10')
    const lines = [{ ...newLine(), name: 'Хлеб', amount: '250' }, { ...newLine(), name: 'Сок', amount: '100,5' }]
    expect(saveLabel({ ...emptyDraft('KZT'), amount: '9', lines })).toBe('Сохранить · 351\u00a0₸')
  })
  it('chooses «Сегодня», «Вчера» or the calendar, across a month and a year', () => {
    expect(dateChoice('2026-10-12', '2026-10-12')).toBe('today')
    expect(dateChoice('2026-09-30', '2026-10-01')).toBe('yesterday')
    expect(dateChoice('2025-12-31', '2026-01-01')).toBe('yesterday')
    expect(dateChoice('2026-10-10', '2026-10-12')).toBe('other')
    expect(dayBefore('2024-03-01')).toBe('2024-02-29')
  })
  it('lists all categories as a tree and finds them by any word of the path, ё as е', () => {
    const cat = (id: number, path: string[]) => ({ id, name: path[path.length - 1], path: path.map((name, index) => ({ id: id * 10 + index, name })),
      parent_id: null, depth: path.length - 1, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0 })
    const all = [cat(3, ['Жильё', 'Коммунальные услуги', 'Интернет']), cat(1, ['Жильё']), cat(4, ['Ёлки']), cat(2, ['Жильё', 'Коммунальные услуги'])]
    expect(categoryTree(all).map((row) => [row.label, row.depth])).toEqual([['Ёлки', 0], ['Жильё', 0], ['Коммунальные услуги', 1], ['Интернет', 2]])
    expect(categoryTree(all, 'жилье интер').map((row) => row.label)).toEqual(['Жильё › Коммунальные услуги › Интернет'])
    expect(categoryTree(all, 'елки').map((row) => row.label)).toEqual(['Ёлки'])
    expect(categoryTree(all, 'нет такой')).toEqual([])
  })
  it('scrolls a focused field just above the save bar and the keyboard', () => {
    expect(fieldScrollDelta(300, 600, 80)).toBe(0)
    expect(fieldScrollDelta(560, 600, 80)).toBe(52)
    expect(fieldScrollDelta(508, 600, 80)).toBe(0)
  })
})

describe('the short texts of the artifact form', () => {
  it('names the calendar chip by day and month, with the year only for another year', () => {
    expect(shortDay('2026-09-02', '2026-10-13')).toBe('02.09')
    expect(shortDay('2025-12-31', '2026-01-02')).toBe('31.12.25')
    expect(shortDay('', '2026-10-13')).toBe('')
  })
  it('shows the sum of positions grouped and exact', () => {
    expect(sumText('21780.00')).toBe('21\u00a0780')
    expect(sumText('350.50')).toBe('350,50')
    expect(sumText('1234567.05')).toBe('1\u00a0234\u00a0567,05')
  })
  it('colours a chip by its root category and names its parent apart', () => {
    expect(chipToneId(cafe)).toBe(1)
    expect(chipToneId(transport)).toBe(3)
    expect(chipParent(cafe)).toBe('Еда')
    expect(chipParent(food)).toBeUndefined()
  })
})
