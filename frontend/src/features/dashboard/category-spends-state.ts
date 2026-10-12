/**
 * «Траты категории»: what the money of a category went on in a month. Pure functions only: the screen renders what they
 * return, the tests check them without a browser.
 */
import type { CategorySpendItem, CategorySpendPart, MonthCode } from '../../api/budget-types'
import { formatMoney } from '../../lib/money'
import { sourceMark, withoutSourceMark } from '../receipts/spends'
import { cents } from './dashboard-state'

/** `/spends/category/5?month=2026-10`: the same route builder as the shell, kept short here. */
export function categorySpendsHref(categoryId: number, month?: MonthCode): string {
  return `/spends/category/${categoryId}${month ? `?month=${month}` : ''}`
}

/** Where a spend came from: the bank statement named in its note, «по чеку» for a photo, «вручную» otherwise. */
export function spendSource(item: Pick<CategorySpendItem, 'source' | 'note'>): string {
  return sourceMark(item.source, item.note)
}

/** The note without the statement mark: what the person or the bank wrote about the spend. */
export const noteText = withoutSourceMark

/** The title of a row: the place; without one — the note, then the first line of the category, then «Без места». */
export function spendTitle(item: Pick<CategorySpendItem, 'store' | 'note' | 'lines'>): string {
  return item.store?.name.trim() || noteText(item.note) || item.lines[0]?.name.trim() || 'Без места'
}

/** The note under the title, when it says more than the title. */
export function spendNote(item: Pick<CategorySpendItem, 'store' | 'note' | 'lines'>): string | undefined {
  const note = noteText(item.note)
  return note && note !== spendTitle(item) ? note : undefined
}

/** «из 12 500 KZT по чеку» for a receipt that has lines in other categories too; nothing when the whole receipt is here. */
export function wholeReceipt(item: Pick<CategorySpendItem, 'category_amount' | 'receipt_total'>, currency: string): string | undefined {
  return cents(item.category_amount) === cents(item.receipt_total) ? undefined : `из ${formatMoney(item.receipt_total, currency)} по чеку`
}

/** The width of a part's bar, 0–100, against the total of its currency; a refund or an empty total gives none. */
export function partShare(part: Pick<CategorySpendPart, 'amount'>, total: string): number {
  const whole = cents(total)
  const own = cents(part.amount)
  if (whole <= 0n || own <= 0n) return 0
  return Number(own >= whole ? 100n : (own * 100n) / whole)
}

/** Lines are shown under a row when they say more than the row: a photo receipt, or more than one line. */
export function showsLines(item: Pick<CategorySpendItem, 'source' | 'lines'>): boolean {
  return item.lines.length > 1 || (item.source === 'photo' && item.lines.length > 0)
}
