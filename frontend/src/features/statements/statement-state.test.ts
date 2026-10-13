import { describe, expect, it } from 'vitest'
import { rowFixture, statementFixture } from '../../api/statements-test-support'
import type { Category } from '../../api/types'
import {
  categoryOptions, defaultChecked, keepsPolling, missingCategory, periodText, reasonText, reviewNote, rowMeta, saveLabel, saveRows,
  sections, setCategory, setStore, syncEdits, toggleRow,
} from './statement-state'

const category = (id: number, name: string, parent?: { id: number; name: string }): Category => ({
  id, name, path: parent ? [parent, { id, name }] : [{ id, name }], parent_id: parent?.id ?? null, depth: parent ? 1 : 0,
  children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})

describe('the draft of a statement', () => {
  const detail = statementFixture()
  const rows = detail.rows

  it('checks recognised spends and questionable rows that have a category, nothing else', () => {
    const checked = rows.filter(defaultChecked).map((row) => row.id)
    expect(checked).toEqual([1, 2, 4, 5])
    // Waiting for the model, a duplicate, a saved row, a transfer, incomings: not checked.
    expect(defaultChecked(rows[5])).toBe(false)
    expect(defaultChecked(rows[6])).toBe(false)
    expect(defaultChecked(rows[7])).toBe(false)
  })

  it('splits the rows into the sections of the screen, newest first, incomings apart', () => {
    const parts = sections(rows)
    expect(parts.toSave.map((row) => row.id)).toEqual([1, 2, 4, 5, 6])
    expect(parts.duplicates.map((row) => row.id)).toEqual([7])
    expect(parts.saved.map((row) => row.id)).toEqual([8])
    expect(parts.skipped.map((row) => row.id)).toEqual([3, 9, 10])
    expect(parts.incomes.map((row) => row.id)).toEqual([11, 12])
  })

  it('saves checked rows with their category and place; the label counts them and sums one currency', () => {
    const edits = syncEdits(rows)
    expect(saveRows(rows, edits)).toEqual([
      { id: 1, category: 1, store_name: 'MAGNUM' }, { id: 2, category: 1, store_name: 'MAGNUM' },
      { id: 4, category: 3, store_name: 'ИП Кофейня Зерно' }, { id: 5, category: 3, store_name: 'ИП Кофейня Зерно' },
    ])
    expect(saveLabel(rows, edits)).toBe('Сохранить 4 траты · 30 150 ₸')
    expect(saveLabel(rows, toggleRow(toggleRow(toggleRow(toggleRow(edits, 1, false), 2, false), 4, false), 5, false))).toBe('Нечего сохранить')
    const other = [...rows, rowFixture({ id: 20, currency: 'USD', amount: '-20.00', spend: '20.00' })]
    expect(saveLabel(other, syncEdits(other))).toBe('Сохранить 5 трат')
  })

  it('asks for a category of a checked row without one', () => {
    const edits = toggleRow(syncEdits(rows), 6, true)
    expect(missingCategory(rows, edits).map((row) => row.id)).toEqual([6])
    expect(saveRows(rows, edits).map((item) => item.id)).not.toContain(6)
  })

  it('takes a category for every untouched row of the same payee and checks the chosen row', () => {
    const edits = syncEdits(rows)
    const { edits: next, followers } = setCategory(edits, rows, 4, 1)
    expect(followers).toBe(1)
    expect([next[4], next[5]].map((edit) => [edit.category, edit.checked])).toEqual([[1, true], [1, true]])
    expect(next[4].touched).toBe(true)
    expect(next[5].touched).toBe(false)
    // A transfer gets a category: it can be saved now.
    const transfer = setCategory(edits, rows, 9, 9).edits[9]
    expect([transfer.category, transfer.checked]).toEqual([9, true])
    // An incoming never.
    expect(setCategory(edits, rows, 11, 1).edits[11].checked).toBe(false)
  })

  it('keeps what the person touched when the draft is read again, follows the server elsewhere', () => {
    const edits = setStore(syncEdits(rows), 1, 'Магнум у дома')
    const answered = rows.map((row) => row.id === 6 ? { ...row, ai: 'done' as const, category: { id: 3, name: 'Кафе и рестораны', path: [{ id: 3, name: 'Кафе и рестораны' }] } } : row)
    const next = syncEdits(answered, edits)
    expect(next[1].store).toBe('Магнум у дома')
    expect([next[6].category, next[6].checked]).toEqual([3, true])
    const saved = answered.map((row) => row.id === 1 ? { ...row, receipt_id: 99 } : row)
    expect(syncEdits(saved, next)[1]).toEqual({ checked: false, category: 1, store: 'MAGNUM', touched: false })
  })

  it('names why a row is not checked', () => {
    expect(rows.map(reasonText)).toEqual([
      '', '', 'Возврат учтён в покупке того же дня', '', '', '', 'Уже внесена: 28 сент. · Кафе Дубль · 4 500 ₸', '',
      'Перевод человеку', 'Между своими счетами или в семье', 'Перевод вам', 'Поступление',
    ])
    expect(reasonText(rowFixture({ reason: 'refunded' }))).toBe('Покупку вернули полностью')
    expect(reasonText(rowFixture({ reason: 'bill', duplicate_of: { id: 1, purchased_on: '2026-10-02', total: '7700.72', currency: 'KZT', store_name: null } })))
      .toBe('Похоже на квитанцию: 2 окт. · 7 701 ₸')
  })

  it('tells what a questionable row waits for, until the person touches it', () => {
    const edits = syncEdits(rows)
    expect(reviewNote(rows[3], edits[4])).toBe('Категорию предложила модель — проверьте')
    expect(reviewNote(rows[5], edits[6])).toBe('Незнакомый получатель — спрашиваю модель')
    expect(reviewNote(rowFixture({ state: 'review', ai: 'off' }), undefined)).toBe('Незнакомый получатель — выберите категорию')
    expect(reviewNote(rows[3], { ...edits[4], touched: true })).toBe('')
    const names = new Map([[1, category(1, 'Еда и напитки')]])
    expect(rowMeta(rows[0], edits[1], names)).toBe('5 окт. · Еда и напитки')
    expect(rowMeta(rows[5], edits[6], names)).toBe('29 сент.')
  })

  it('polls while the model is asked and a worker is there', () => {
    expect(keepsPolling(detail)).toBe(true)
    expect(keepsPolling({ ...detail, ai: { ...detail.ai, waiting: 0 } })).toBe(false)
    expect(keepsPolling({ ...detail, ai: { ...detail.ai, executor: { available: false, state: 'absent', last_seen_at: null } } })).toBe(false)
  })

  it('orders the picker by the tree and indents nested categories', () => {
    const home = { id: 8, name: 'Жильё' }
    const options = categoryOptions([category(9, 'Аренда', home), category(1, 'Еда и напитки'), category(8, 'Жильё'), category(5, 'Не разобрано')])
    expect(options).toEqual([{ id: 1, label: 'Еда и напитки' }, { id: 8, label: 'Жильё' }, { id: 9, label: ' Аренда' }])
  })

  it('writes the period short', () => {
    expect(periodText(detail)).toBe('13.09 — 12.10.2026')
    expect(periodText({ date_from: '2025-12-20', date_to: '2026-01-19' })).toBe('20.12.2025 — 19.01.2026')
  })
})
