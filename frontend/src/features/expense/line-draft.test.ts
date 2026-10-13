import { describe, expect, it } from 'vitest'
import type { Line } from '../../api/receipts'
import { decimalText, editLine, lineFromBody, lineFromSaved, lineInput, lineMessages, linesCents, lineSummary, newLine, scaled, settleLine } from './line-draft'

const nbsp = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ')

describe('a line of the spend form is a line of a receipt', () => {
  it('reads and writes decimals without floats', () => {
    expect(scaled('1 790,5', 4)).toBe(17905000n)
    expect(scaled('-4', 3, true)).toBe(-4000n)
    expect(scaled('-4', 3)).toBeUndefined()
    expect(scaled('1.23456', 4)).toBeUndefined()
    expect(decimalText(17905000n, 4)).toBe('1790.5')
    expect(decimalText(-25n, 2)).toBe('-0.25')
  })
  it('counts the sum from quantity, price and discount', () => {
    let line = editLine({ ...newLine(), name: 'Панини' }, 'price', '1790')
    expect(line.amount).toBe('1790')
    line = editLine(line, 'quantity', '2')
    expect(line.amount).toBe('3580')
    line = editLine(line, 'discount', '80')
    expect(line.amount).toBe('3500')
    // 0,35 кг × 4 200 — the weight of a line.
    expect(editLine({ ...newLine(), unit: 'kg', quantity: '0,350' }, 'price', '4200').amount).toBe('1470')
    expect(editLine({ ...newLine(), quantity: '3' }, 'price', '0.3333').amount).toBe('1')
  })
  it('counts the price back from a typed sum and keeps the sum when the quantity changes', () => {
    let line = editLine({ ...newLine(), name: 'Панини' }, 'amount', '3580')
    expect(line.price).toBe('3580')
    line = editLine(line, 'quantity', '2')
    expect([line.amount, line.price]).toEqual(['3580', '1790'])
    line = editLine(line, 'amount', '1000')
    line = editLine(line, 'quantity', '3')
    expect(line.price).toBe('333.3333')
    // A typed price leads again: the sum follows it.
    expect(editLine(line, 'price', '300').amount).toBe('900')
    // «1200+350» is counted when the field is left.
    expect(settleLine(editLine({ ...newLine() }, 'amount', '1200+350')).amount).toBe('1550')
  })
  it('sends the sum before the discount, the price only when known, and the id of a saved line', () => {
    const line = editLine(editLine({ ...newLine(), id: 7, name: ' Панини ', quantity: '2' }, 'price', '1790'), 'discount', '80')
    expect(lineInput(line)).toEqual({ input: {
      id: 7, name: 'Панини', quantity: '2', unit: 'pcs', unit_price: '1790', amount: '3580', discount_amount: '80', category: null,
    } })
    expect(lineInput({ ...newLine(), name: 'Сок', amount: '450' })).toEqual({ input: {
      name: 'Сок', quantity: '1', unit: 'pcs', amount: '450', discount_amount: '0', category: null,
    } })
    expect(lineInput({ ...newLine(), name: '', quantity: '0', price: '1,23456', amount: '-5' })).toEqual({ errors: {
      name: lineMessages.name, quantity: lineMessages.quantity, price: lineMessages.price, amount: lineMessages.amount,
    } })
  })
  it('opens a saved line as it was printed, a returned deposit with its sign', () => {
    const saved = { id: 3, name: 'Pfandrückgabe', quantity: '-4.000', unit: 'pcs', unit_price: '0.2500', amount: '-1.00',
      discount_amount: '0.00', paid_amount: '-1.00', category: null } as Line
    const line = lineFromSaved(saved)
    expect([line.quantity, line.price, line.amount, line.discount, line.signed]).toEqual(['-4', '0.25', '-1', '', true])
    expect(lineInput(line)).toMatchObject({ input: { id: 3, quantity: '-4', unit_price: '0.25', amount: '-1', discount_amount: '0' } })
    const milk = lineFromSaved({ ...saved, id: 4, name: 'Молоко', quantity: '2.000', unit_price: '500.0000', amount: '1000.00',
      discount_amount: '100.00', paid_amount: '900.00' } as Line)
    expect([milk.amount, milk.discount, milk.signed]).toEqual(['900', '100', false])
    expect(linesCents([line, milk])).toBe(89900n)
  })
  it('opens a line of a draft (a parse, a past spend) with its quantity and price', () => {
    expect(lineFromBody({ name: 'Хлеб', amount: '230.50', quantity: '2', unit_price: '115.25' }, 1))
      .toMatchObject({ name: 'Хлеб', quantity: '2', price: '115.25', amount: '230.50', category: 1, lead: 'price' })
    expect(lineFromBody({ name: 'Кофе', amount: '900' }, null)).toMatchObject({ quantity: '1', price: '', amount: '900', lead: 'amount' })
  })
  it('folds a line into «Панини · 2 шт × 1 790,00 ₸ · 3 580 ₸»', () => {
    const line = editLine({ ...newLine(), name: 'Панини', quantity: '2' }, 'price', '1790')
    const summary = lineSummary(line, 'KZT')
    expect([summary.title, nbsp(summary.detail), nbsp(summary.sum)]).toEqual(['Панини', '2 шт × 1 790,00 ₸', '3 580 ₸'])
    expect(lineSummary({ ...newLine(), amount: '450' }, 'KZT').detail).toBe('')
    expect(lineSummary({ ...newLine(), amount: '450' }, 'KZT').title).toBe('Без названия')
  })
})
