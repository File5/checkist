import { describe, expect, it } from 'vitest'
import type { Line, Receipt } from '../../api/receipts'
import type { Category } from '../../api/types'
import {
  CHIPS_SHOWN, amountText, categoryChips, chipLabel, clearExpenseNotice, draftBody, draftFromReceipt, emptyDraft,
  getExpenseNotice, linesTotal, sentIndexes, messages, newLine, normalizeAmount, serverErrors, setExpenseNotice, todayISO, visibleChips,
  categoryTree, dateChoice, dayBefore, fieldScrollDelta, saveLabel,
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
    } })
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
    expect(result).toEqual({ body: {
      currency: 'KZT', purchased_on: '2026-10-12', store_name: null, note: '', category: 1,
      lines: [{ name: 'Хлеб', amount: '250' }, { name: 'Такси', amount: '1200', category: 3 }],
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
    expect(serverErrors(['total', 'category', 'purchased_on', 'store_name', 'lines.2.amount', 'lines.0.name', 'lines.1.category', 'surprise']))
      .toEqual({
        amount: messages.total, category: messages.category, date: messages.date, place: messages.place,
        'lines.2.amount': messages.lineAmount, 'lines.0.name': messages.lineName, 'lines.1.amount': messages.category, form: messages.unknown,
      })
  })
})

describe('a saved spend in the form', () => {
  const receipt = { id: 5, source: 'manual', store: null, note: 'кофе', currency: 'KZT', purchased_on: '2026-10-01', total: '450.00' } as Receipt
  const saved = (name: string, amount: string, lineCategory: { id: number; name: string } | null) => ({ name, amount, category: lineCategory }) as Line
  it('opens one line named after its category as one amount', () => {
    expect(draftFromReceipt(receipt, [saved('Кафе', '450.00', { id: 2, name: 'Кафе' })])).toEqual({
      amount: '450', currency: 'KZT', category: 2, date: '2026-10-01', place: '', note: 'кофе', lines: [],
    })
  })
  it('opens any other spend with its positions', () => {
    const result = draftFromReceipt({ ...receipt, store: { id: 1, name: 'Рынок', city: '', country: 'KZ', address: '', timezone: 'Asia/Almaty' } },
      [saved('Хлеб', '250.00', { id: 1, name: 'Еда' }), saved('Такси', '200.50', null)])
    expect(result.place).toBe('Рынок')
    expect(result.category).toBeNull()
    expect(result.lines.map(({ name, amount, category: own }) => [name, amount, own])).toEqual([['Хлеб', '250', 1], ['Такси', '200.50', null]])
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
