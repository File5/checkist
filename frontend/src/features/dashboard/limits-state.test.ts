import { describe, expect, it } from 'vitest'
import { limitFixture } from '../../api/budget-test-support'
import type { Category } from '../../api/types'
import {
  amountInput, isDuplicateCreate, limitCurrencies, limitFailureMessage, limitFor, limitMessages, parseCurrency, parseLimitAmount, rowAction, topLevelCategories,
  withLimit, withoutLimit,
} from './limits-state'

const category = (id: number, name: string, parent: number | null = null): Category => ({
  id, name, path: [{ id, name }], parent_id: parent, depth: parent === null ? 0 : 1,
  children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})

describe('limits screen state', () => {
  it('keeps top-level categories in the server order', () => {
    const categories = [category(3, 'Продукты'), category(4, 'Молочные', 3), category(8, 'Кафе'), category(1, 'Не разобрано')]
    expect(topLevelCategories(categories).map((item) => item.id)).toEqual([3, 8, 1])
  })
  it.each([
    ['120000', '120000.00'], ['120 000', '120000.00'], ['120\u00a0000,5', '120000.50'], ['1500,50', '1500.50'], ['0.01', '0.01'],
    ['007', '7.00'], ['15.', '15.00'],
  ])('reads %j as %s', (input, amount) => {
    expect(parseLimitAmount(input)).toEqual({ amount })
  })
  it.each([
    ['', limitMessages.empty], ['   ', limitMessages.empty], ['0', limitMessages.zero], ['0,00', limitMessages.zero],
    ['1,234', limitMessages.places], ['-5', limitMessages.format], ['12a', limitMessages.format], ['1e5', limitMessages.format],
    ['1 000,00,1', limitMessages.format], ['1234567890123', limitMessages.large],
  ])('refuses %j', (input, error) => {
    expect(parseLimitAmount(input)).toEqual({ error })
  })
  it('reads currency codes', () => {
    expect(parseCurrency(' usd ')).toEqual({ currency: 'USD' })
    expect(parseCurrency('US')).toEqual({ error: limitMessages.currency })
    expect(parseCurrency('ДОЛ')).toEqual({ error: limitMessages.currency })
  })
  it('shows a saved amount the way a person types it', () => {
    expect(amountInput('120000.00')).toBe('120000')
    expect(amountInput('1500.50')).toBe('1500,50')
  })
  it('lists the default currency first, then those with limits, then added', () => {
    const limits = [limitFixture({ currency: 'USD' }), limitFixture({ id: 9, currency: 'EUR' }), limitFixture({ id: 10 })]
    expect(limitCurrencies('KZT', limits, ['RUB', 'EUR'])).toEqual(['KZT', 'EUR', 'USD', 'RUB'])
    expect(limitCurrencies('KZT', [])).toEqual(['KZT'])
  })
  it('decides what «Сохранить» does', () => {
    const limit = limitFixture()
    expect(rowAction(undefined, limit)).toEqual({ kind: 'none' })
    expect(rowAction('120 000', limit)).toEqual({ kind: 'none' })
    expect(rowAction('90000', limit)).toEqual({ kind: 'update', id: 7, amount: '90000.00' })
    expect(rowAction('90000', undefined)).toEqual({ kind: 'create', amount: '90000.00' })
    expect(rowAction('', undefined)).toEqual({ kind: 'invalid', error: limitMessages.empty })
  })
  it('replaces and removes a limit in the list', () => {
    const first = limitFixture()
    const other = limitFixture({ id: 8, category_id: 8 })
    expect(withLimit([first, other], { ...first, amount: '1.00' })).toEqual([other, { ...first, amount: '1.00' }])
    // A limit created by another member of the family meanwhile is replaced by the one the server answered with.
    expect(withLimit([first], { ...first, id: 99 })).toEqual([{ ...first, id: 99 }])
    expect(withoutLimit([first, other], 7)).toEqual([other])
    expect(limitFor([first, other], 8, 'KZT')).toBe(other)
    expect(limitFor([first, other], 8, 'USD')).toBeUndefined()
  })
  it('explains refusals by field names with local texts', () => {
    expect(limitFailureMessage({ reason: 'invalid_parameter', fields: ['amount'] })).toContain('сумму')
    expect(limitFailureMessage({ reason: 'invalid_parameter', fields: ['category_id'] })).toContain('верхнего уровня')
    expect(limitFailureMessage({ reason: 'invalid_parameter', fields: ['non_field_errors'] })).toContain('уже есть')
    // The server reports a taken «category and currency» pair at category_id: on a create it is the duplicate.
    expect(limitFailureMessage({ reason: 'invalid_parameter', fields: ['category_id'] }, true)).toContain('уже есть')
    expect(isDuplicateCreate({ reason: 'invalid_parameter', fields: ['category_id'] }, true)).toBe(true)
    expect(isDuplicateCreate({ reason: 'invalid_parameter', fields: ['category_id'] }, false)).toBe(false)
    expect(isDuplicateCreate({ reason: 'invalid_parameter', fields: ['amount'] }, true)).toBe(false)
    expect(limitFailureMessage({ reason: 'not_found' })).toContain('Обновите страницу')
    expect(limitFailureMessage({ reason: 'invalid_response' })).toBe('Не удалось сохранить лимит. Повторите попытку.')
  })
})
