import { describe, expect, it } from 'vitest'
import type { DashboardCategory, DashboardSubCategory } from '../../api/budget-types'
import {
  collapsedHint, EXPANDED_STORAGE_KEY, hasOverspendBelow, isExpanded, readExpanded, subListId, withChoice, writeExpanded,
} from './limit-collapse-state'

const nb = (text: string) => text.replaceAll(' ', ' ')
const sub = (category_id: number, name: string, spent: string, limit: string | null, children: DashboardSubCategory[] = []): DashboardSubCategory =>
  ({ category_id, name, spent, limit, limit_id: limit === null ? null : category_id, children })
const top = (children: DashboardSubCategory[], category_id: number | null = 10): DashboardCategory =>
  ({ category_id, name: 'Жильё', spent: '251692.00', limit: '260000.00', limit_id: 1, children })

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

describe('folded sub-categories of «Лимиты» on «Главная»', () => {
  it('folds a row by default and opens it when a limited sub-category at any depth is overspent', () => {
    const calm = top([sub(17, 'Аренда', '220000.00', '220000.00'), sub(18, 'Интернет', '9000.00', null)])
    expect(hasOverspendBelow(calm)).toBe(false)
    expect(isExpanded(calm, {})).toBe(false)
    const deep = top([sub(21, 'Коммунальные услуги', '50000.00', null, [sub(22, 'Электричество', '18000.00', '15000.00')])])
    expect(hasOverspendBelow(deep)).toBe(true)
    expect(isExpanded(deep, {})).toBe(true)
    // The row's own overspend is said on the row itself; it does not open the sub-categories.
    expect(hasOverspendBelow({ ...calm, spent: '300000.00' })).toBe(false)
    // A zero limit has no bar and is never «over».
    expect(hasOverspendBelow(top([sub(17, 'Аренда', '10.00', '0.00')]))).toBe(false)
    // An older server sends no children.
    expect(isExpanded({ ...calm, children: undefined }, {})).toBe(false)
  })
  it('follows the choice of the person over the default, both ways, per category', () => {
    const deep = top([sub(22, 'Электричество', '18000.00', '15000.00')])
    const calm = top([sub(17, 'Аренда', '1.00', '220000.00')], 11)
    const choices = withChoice(withChoice({}, 10, false), 11, true)
    expect(choices).toEqual({ 10: false, 11: true })
    expect(isExpanded(deep, choices)).toBe(false)
    expect(isExpanded(calm, choices)).toBe(true)
    expect(isExpanded(top([], null), { 0: true })).toBe(false)
  })
  it('keeps the choices in this browser and falls back to none when storage fails', () => {
    const storage = new MemoryStorage()
    writeExpanded({ 10: true, 22: false }, storage)
    expect(storage.values.get(EXPANDED_STORAGE_KEY)).toBe('{"10":true,"22":false}')
    expect(readExpanded(storage)).toEqual({ 10: true, 22: false })
    expect(readExpanded(new MemoryStorage())).toEqual({})
    expect(readExpanded(undefined)).toEqual({})
    for (const raw of ['not json', '[1,2]', 'null', '"x"']) {
      storage.values.set(EXPANDED_STORAGE_KEY, raw)
      expect(readExpanded(storage), raw).toEqual({})
    }
    storage.values.set(EXPANDED_STORAGE_KEY, '{"10":true,"x":true,"11":"yes"}')
    expect(readExpanded(storage)).toEqual({ 10: true })
    const blocked = { getItem: () => { throw new Error('SecurityError') }, setItem: () => { throw new Error('QuotaExceededError') } }
    expect(readExpanded(blocked)).toEqual({})
    expect(() => writeExpanded({ 10: true }, blocked)).not.toThrow()
    // Node has no window: no storage, no failure.
    expect(readExpanded()).toEqual({})
    expect(() => writeExpanded({ 10: true })).not.toThrow()
  })
  it('sums up the limited direct sub-categories in one line, or gives only the count', () => {
    const one = top([sub(17, 'Аренда', '220000.00', '220000.00'), sub(18, 'Интернет', '9000.00', null)])
    expect(collapsedHint(one)).toBe(`Аренда ${nb('220 000')} / ${nb('220 000')}`)
    expect(collapsedHint(top([sub(18, 'Интернет', '9000.00', null)]))).toBeNull()
    expect(collapsedHint(top([]))).toBeNull()
    const two = top([sub(17, 'Аренда', '220000.00', '220000.00'), sub(19, 'Вода', '4000.00', '5000.00')])
    expect(collapsedHint(two)).toBeNull()
    expect(collapsedHint(two, 60)).toBe(`Аренда ${nb('220 000')} / ${nb('220 000')} · Вода ${nb('4 000')} / ${nb('5 000')}`)
    expect(collapsedHint(top([sub(20, 'Обслуживание дома и придомовой территории', '1.00', '2.00')]))).toBeNull()
    expect(subListId('KZT', 10)).toBe('dash-sub-KZT-10')
  })
})
