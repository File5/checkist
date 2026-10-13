import { describe, expect, it } from 'vitest'
import { readError } from './http'
import { publicFixture } from './recognition-test-support'
import { isLine, isManualDefaults, isReceipt } from './receipts-schema'
import { isSpending } from './stats-schema'
import { statsFixture } from './stats-test-support'
import type { Line, Receipt } from './receipts-types'
import type { Page } from './types'
import type { Spending } from './stats-types'

const photo = publicFixture('receipt.json') as Receipt
const line = (publicFixture('lines.json') as Page<Line>).results[0]

describe('manual spends on the wire', () => {
  it('accepts the photo fixtures with source, note and line category', () => {
    expect(photo.source).toBe('photo')
    expect(isReceipt(photo)).toBe(true)
    expect(isLine(line)).toBe(true)
    expect(line.category).toBeNull()
  })
  it('lets only a manual spend come without a store', () => {
    expect(isReceipt({ ...photo, source: 'manual', store: null })).toBe(true)
    expect(isReceipt({ ...photo, store: null })).toBe(false)
    expect(isReceipt({ ...photo, source: 'other' })).toBe(false)
    const withoutNote: Partial<Receipt> = { ...photo }
    delete withoutNote.note
    expect(isReceipt(withoutNote)).toBe(false)
  })
  it('reads a line category and the form defaults', () => {
    expect(isLine({ ...line, product: null, matching_status: 'unmatched', category: { id: 2, name: 'Кафе' } })).toBe(true)
    expect(isLine({ ...line, category: { id: 0, name: 'x' } })).toBe(false)
    expect(isManualDefaults({ currency: 'KZT', frequent_categories: [3, 2] })).toBe(true)
    expect(isManualDefaults({ currency: 'KZT', frequent_categories: [0] })).toBe(false)
  })
  it('knows the refusal of a photo receipt change', () => {
    const body = { error: { code: 'receipt_read_only', message: 'Чек с фото через API не меняется.' } }
    expect(readError(409, body, true)).toEqual({ kind: 'error', reason: 'receipt_read_only', status: 409 })
  })
})

describe('special items of manual spends in the statistics', () => {
  const special = { id: null, name: null, direct: false, unassigned: false, amount: '7.00', share_percent: null,
    lines_count: 2, receipts_count: 2, quantity: null, unit: null }
  const withItem = (groupBy: Spending['group_by'], kind: string) => {
    const body = statsFixture('spending-store.json') as Spending
    const withSpecial = (block: Spending['currencies'][number]) => ({
      ...block, items: [...block.items.filter((item) => item.kind === groupBy), { ...special, kind }] })
    return { ...body, group_by: groupBy, currencies: body.currencies.map(withSpecial), base: body.base && withSpecial(body.base) }
  }
  it('accepts «Без места» only by store and «Траты без товара» only elsewhere', () => {
    expect(isSpending(withItem('store', 'no_store'))).toBe(true)
    expect(isSpending(withItem('store', 'no_product'))).toBe(false)
    expect(isSpending(withItem('store', 'unmatched'))).toBe(false)
    expect(isSpending(withItem('generic', 'no_product'))).toBe(true)
    expect(isSpending(withItem('generic', 'no_store'))).toBe(false)
  })
})
