import { describe, expect, it } from 'vitest'
import type { ReceiptListItem } from '../../api/receipts'
import { publicFixture } from '../../api/recognition-test-support'
import type { Session } from '../../session'
import {
  categoriesText, categoryTone, dayLabel, sourceMark, withoutSourceMark, groupByDay, localToday, ownerChips, positions, previousDay, reviewText, rowMeta, rowTitle,
  shortDate, sumAmounts, withOwner,
} from './spends'

const NBSP = ' '
// The rows of these tests name their categories themselves: the public example's own list is dropped.
const base: ReceiptListItem = { ...(publicFixture('receipts.json') as { results: ReceiptListItem[] }).results[0], categories: undefined }
let next = 100
const receipt = (fields: Partial<ReceiptListItem>): ReceiptListItem => ({ ...base, id: next++, ...fields })
const manual = (fields: Partial<ReceiptListItem>) => receipt({ source: 'manual', store: null, preview_image_url: null, ...fields })
const user = (household: { id: number; name: string; members: string[]; people?: { username: string; display_name: string }[] } | null): Session => ({
  kind: 'user', mode: 'accounts', user: { id: 1, username: 'andrey', is_staff: false }, household, permissions: { moderate_catalog: false },
})

describe('days of «Траты»', () => {
  it('names today, yesterday and older days, with the year only when it differs', () => {
    expect(dayLabel('2026-10-12', '2026-10-12')).toBe('Сегодня')
    expect(dayLabel('2026-10-11', '2026-10-12')).toBe(`Вчера, 11${NBSP}окт`)
    expect(dayLabel('2026-10-10', '2026-10-12')).toBe(`10${NBSP}окт`)
    expect(dayLabel('2026-05-01', '2026-10-12')).toBe(`1${NBSP}мая`)
    expect(dayLabel('2025-12-31', '2026-01-01')).toBe(`Вчера, 31${NBSP}дек${NBSP}2025`)
    expect(shortDate('2025-02-03', '2026-10-12')).toBe(`3${NBSP}фев${NBSP}2025`)
  })

  it('counts the previous day on the calendar across months, years and leap days', () => {
    expect(previousDay('2026-03-01')).toBe('2026-02-28')
    expect(previousDay('2028-03-01')).toBe('2028-02-29')
    expect(previousDay('2026-01-01')).toBe('2025-12-31')
    expect(previousDay('2026-03-30')).toBe('2026-03-29')
  })

  it('takes today from the device clock', () => {
    expect(localToday(new Date(2026, 9, 2, 23, 59))).toBe('2026-10-02')
    expect(localToday(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01')
  })

  it('adds money exactly and subtracts a refund', () => {
    expect(sumAmounts([{ amount: '0.10', sign: 1 }, { amount: '0.20', sign: 1 }])).toBe('0.30')
    expect(sumAmounts([{ amount: '18940.00', sign: 1 }, { amount: '1200.5', sign: -1 }])).toBe('17739.50')
    expect(sumAmounts([{ amount: '5.00', sign: -1 }])).toBe('-5.00')
    expect(sumAmounts([{ amount: '99999999999999.99', sign: 1 }, { amount: '0.01', sign: 1 }])).toBe('100000000000000.00')
    expect(sumAmounts([])).toBe('0.00')
    expect(sumAmounts([{ amount: '1,00', sign: 1 }])).toBeNull()
  })

  it('groups a page by purchase day in the API order, a total per currency and never across currencies', () => {
    const rows = [
      receipt({ purchased_on: '2026-10-12', currency: 'KZT', total: '18940.00' }),
      manual({ purchased_on: '2026-10-12', currency: 'KZT', total: '1060.00' }),
      receipt({ purchased_on: '2026-10-12', currency: 'EUR', total: '2.38' }),
      receipt({ purchased_on: '2026-10-11', currency: 'KZT', total: '500.00', operation: 'refund' }),
      receipt({ purchased_on: '2026-10-11', currency: 'KZT', total: '3000.00' }),
      receipt({ purchased_on: '2026-10-09', currency: 'RUB', total: '10.00' }),
    ]
    const days = groupByDay(rows, '2026-10-12')
    expect(days.map((day) => [day.day, day.label, day.receipts.length])).toEqual([
      ['2026-10-12', 'Сегодня', 3], ['2026-10-11', `Вчера, 11${NBSP}окт`, 2], ['2026-10-09', `9${NBSP}окт`, 1]])
    expect(days[0].totals).toEqual([{ currency: 'KZT', total: '20000.00' }, { currency: 'EUR', total: '2.38' }])
    expect(days[1].totals).toEqual([{ currency: 'KZT', total: '2500.00' }])
    expect(days[2].totals).toEqual([{ currency: 'RUB', total: '10.00' }])
  })

  it('keeps one group for a day that the ordering brought twice, and an empty page has no days', () => {
    const days = groupByDay([receipt({ purchased_on: '2026-10-01' }), receipt({ purchased_on: '2026-10-02' }), receipt({ purchased_on: '2026-10-01' })], '2026-10-12')
    expect(days.map((day) => [day.day, day.receipts.length])).toEqual([['2026-10-01', 2], ['2026-10-02', 1]])
    expect(groupByDay([], '2026-10-12')).toEqual([])
  })
})

describe('rows of «Траты»', () => {
  it('titles a receipt by its place and a spend without a place by its first line, then its category', () => {
    expect(rowTitle(receipt({}))).toBe('Тестовый магазин')
    expect(rowTitle(receipt({ store: { ...base.store!, name: ' ' } }))).toBe('Не распознано')
    expect(rowTitle(manual({ first_line: 'Такси до дома', category: { id: 3, name: 'Транспорт' } }))).toBe('Такси до дома')
    expect(rowTitle(manual({ first_line: null, category: { id: 3, name: 'Транспорт' } }))).toBe('Транспорт')
    expect(rowTitle(manual({ first_line: null, category: null }))).toBe('Без места')
    // An older server sends neither field.
    expect(rowTitle({ ...manual({}), first_line: undefined, category: undefined })).toBe('Без места')
  })

  it('says category, owner in a family, where it came from and the count of positions', () => {
    const row = receipt({ category: { id: 3, name: 'Продукты' }, owner: 'liza', owner_name: 'Лиза', lines_count: 23 })
    expect(rowMeta(row, true)).toEqual(['Продукты', 'Лиза', 'по чеку', `23${NBSP}позиции`])
    // A blank name or none at all (an older server): the username.
    expect(rowMeta({ ...row, owner_name: '  ' }, true)[1]).toBe('liza')
    expect(rowMeta({ ...row, owner_name: undefined }, true)[1]).toBe('liza')
    expect(rowMeta(row, false)).toEqual(['Продукты', 'по чеку', `23${NBSP}позиции`])
    expect(rowMeta(receipt({ category: null, lines_count: 1, operation: 'refund' }), false)).toEqual(['по чеку', `1${NBSP}позиция`, 'Возврат'])
    expect(rowMeta(receipt({ category: null, lines_count: 0 }), false)).toEqual(['по чеку', `0${NBSP}позиций`])
  })

  it('names every category of the lines and the bank statement a spend came from', () => {
    const categories = [{ id: 1, name: 'Интернет' }, { id: 2, name: 'Кафе' }, { id: 3, name: 'Связь' }, { id: 4, name: 'Такси' }]
    expect(categoriesText({ categories: categories.slice(0, 2), category: null })).toBe('Интернет, Кафе')
    expect(categoriesText({ categories, category: null })).toBe('Интернет, Кафе +2')
    expect(categoriesText({ categories: [], category: { id: 9, name: 'Жильё' } })).toBe('Жильё')
    expect(categoriesText({ category: null })).toBeUndefined()
    const steam = receipt({ source: 'manual', note: 'Steam purchase · Выписка Kaspi Gold', categories: [{ id: 7, name: 'Игры' }], lines_count: 1 })
    expect(rowMeta(steam, false)).toEqual(['Игры', 'Выписка Kaspi Gold'])
    expect(rowMeta(receipt({ source: 'manual', note: 'кофе', category: null, lines_count: 1 }), false)).toEqual(['вручную'])
    expect(sourceMark('manual', 'Такси · Выписка ForteBank ')).toBe('Выписка ForteBank')
    expect(withoutSourceMark('Такси · Выписка ForteBank')).toBe('Такси')
    expect(withoutSourceMark(null)).toBe('')
  })

  it('declines positions in Russian', () => {
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111, 1001].map(positions)).toEqual(
      ['1 позиция', '2 позиции', '5 позиций', '11 позиций', '12 позиций', '21 позиция', '22 позиции', '25 позиций', '111 позиций', `1${NBSP}001 позиция`]
        .map((text) => text.replace(/ (?=п)/, NBSP)))
  })

  it('gives every category one of six colours, the same each time', () => {
    expect([1, 2, 6, 7, 12, 13].map(categoryTone)).toEqual([1, 2, 6, 1, 6, 1])
    expect(categoryTone(81)).toBe(categoryTone(81))
  })
})

describe('family filter and review banner', () => {
  it('shows no chips without a household and «Вся семья» plus members within one', () => {
    expect(ownerChips(user(null), undefined)).toEqual([])
    expect(ownerChips({ kind: 'loading' }, undefined)).toEqual([])
    const family = user({ id: 4, name: 'Семья', members: ['andrey', 'liza'] })
    expect(ownerChips(family, undefined)).toEqual([
      { label: 'Вся семья', owner: undefined, current: true },
      { label: 'andrey', owner: 'andrey', current: false },
      { label: 'liza', owner: 'liza', current: false },
    ])
    expect(ownerChips(family, 'liza').map((chip) => chip.current)).toEqual([false, false, true])
    // With names from «Я»: the chip shows the name, the filter keeps the username.
    const named = user({ id: 4, name: 'Семья', members: ['andrey', 'liza'], people: [{ username: 'liza', display_name: 'Лиза' }] })
    expect(ownerChips(named, 'liza')).toEqual([
      { label: 'Вся семья', owner: undefined, current: false },
      { label: 'andrey', owner: 'andrey', current: false },
      { label: 'Лиза', owner: 'liza', current: true },
    ])
    // An owner from the address that is not in the family marks no chip.
    expect(ownerChips(family, 'other').some((chip) => chip.current)).toBe(false)
  })

  it('switches the owner, keeps the other filters and returns to the first page', () => {
    const query = { page: 3, q: 'MILCH', currency: 'KZT', owner: 'andrey' }
    expect(withOwner(query, 'liza')).toEqual({ page: 1, q: 'MILCH', currency: 'KZT', owner: 'liza' })
    expect(withOwner(query, undefined)).toEqual({ page: 1, q: 'MILCH', currency: 'KZT' })
    expect(query.owner).toBe('andrey')
  })

  it('counts photos waiting for a person', () => {
    expect(reviewText(1)).toBe(`1${NBSP}фото ждёт проверки`)
    expect(reviewText(2)).toBe(`2${NBSP}фото ждут проверки`)
    expect(reviewText(11)).toBe(`11${NBSP}фото ждут проверки`)
    expect(reviewText(21)).toBe(`21${NBSP}фото ждёт проверки`)
  })
})
