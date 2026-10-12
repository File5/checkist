import { describe, expect, it } from 'vitest'
import { limitFixture } from '../../api/budget-test-support'
import type { Category } from '../../api/types'
import {
  amountInput, isDuplicateCreate, limitCurrencies, limitFailureMessage, limitFor, limitMessages, limitTree, openByDefault, parseCurrency, parseLimitAmount,
  rowAction, subCategoriesText, visibleRows, withLimit, withoutLimit,
} from './limits-state'

const category = (id: number, name: string, parent: Category | null = null): Category => {
  const path = [...(parent?.path ?? []), { id, name }]
  return {
    id, name, path, parent_id: parent?.id ?? null, depth: path.length - 1,
    children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
  }
}
/** The prod example: «Жильё» → «Аренда», «Коммунальные услуги» → «Электричество», «Вода»; then «Кафе». */
const home = category(10, 'Жильё')
const rent = category(17, 'Аренда', home)
const utilities = category(21, 'Коммунальные услуги', home)
const power = category(22, 'Электричество', utilities)
const water = category(23, 'Вода', utilities)
const cafe = category(8, 'Кафе')
const tree = limitTree([home, rent, utilities, power, water, cafe])

describe('limits screen state', () => {
  it('keeps every category of the server order as a tree row under its top-level category', () => {
    expect(tree.map((row) => [row.category.id, row.depth, row.rootId, row.descendants])).toEqual([
      [10, 0, 10, 4], [17, 1, 10, 0], [21, 1, 10, 0], [22, 2, 10, 0], [23, 2, 10, 0], [8, 0, 8, 0],
    ])
  })
  it('opens a top-level category with a limit or an unsaved amount below it, and lists the open ones only', () => {
    expect([...openByDefault(tree, [], 'KZT')]).toEqual([])
    // A limit of the category itself does not open it; a limit of a sub-category at any depth does, in its currency.
    expect([...openByDefault(tree, [limitFixture({ category_id: 10 })], 'KZT')]).toEqual([])
    expect([...openByDefault(tree, [limitFixture({ category_id: 22 })], 'KZT')]).toEqual([10])
    expect([...openByDefault(tree, [limitFixture({ category_id: 22 })], 'USD')]).toEqual([])
    expect([...openByDefault(tree, [], 'KZT', { '17:KZT': '5' })]).toEqual([10])
    expect(visibleRows(tree, () => false).map((row) => row.category.id)).toEqual([10, 8])
    expect(visibleRows(tree, (root) => root === 10).map((row) => row.category.id)).toEqual([10, 17, 21, 22, 23, 8])
  })
  it('counts sub-categories in Russian', () => {
    expect([1, 2, 4, 5, 11, 21].map(subCategoriesText)).toEqual(
      ['1 подкатегория', '2 подкатегории', '4 подкатегории', '5 подкатегорий', '11 подкатегорий', '21 подкатегория'].map((text) => text.replace(' ', '\u00a0')))
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
    expect(limitFailureMessage({ reason: 'invalid_parameter', fields: ['category_id'] })).toBe('Этой категории уже нет. Обновите страницу.')
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
