/** Past spends to repeat with one tap (`GET /api/receipts/manual/suggest/`): how a row and a chip name them and the form
 * they fill. No network, no React. */
import type { ManualSuggestion } from '../../api/receipts'
import type { Category } from '../../api/types'
import { formatMoney } from '../../lib/money'
import { plural } from '../../lib/recognition-issues'
import { amountText, shortDay } from './expense-form'
import { lineFromBody } from './line-draft'
import type { ExpenseDraft } from './expense-form'

/** Wait after the last key before asking the server: one request per pause, not per letter. */
export const SUGGEST_DELAY_MS = 250

/** Whether the text has words the server looks for: two letters or more, not a number (`receipts.history.words`). */
export const hasSearchWords = (text: string) => text.split(/\s+/).some((word) => [...word].length >= 2 && !/[0-9]/.test(word))

/** The place, else «Что купили», else the note, else the category, else the first position. */
export function suggestionTitle(spend: ManualSuggestion): string {
  return spend.store_name || spend.item_name || spend.note.replace(/^[\s·]+/, '') || spend.category?.name || spend.lines[0]?.name
    || 'Трата'
}

/** «Связь и подписки · 12.09» — «Подписка Claude Max · 12.09» when the title is the place (an itemized spend — «3 позиции»),
 * the amount stands apart. */
export function suggestionMeta(spend: ManualSuggestion, today: string): string {
  const item = spend.store_name ? spend.item_name : undefined
  const what = item || (spend.category?.name
    ?? `${spend.lines.length} ${plural(spend.lines.length, 'позиция', 'позиции', 'позиций')}`)
  return `${what} · ${shortDay(spend.purchased_on, today)}`
}

/** «Yandex Go · 3 402 ₸»: the chip of a frequent spend. */
export const chipText = (spend: ManualSuggestion) => `${suggestionTitle(spend)} · ${formatMoney(spend.total, spend.currency)}`

/** The form as a repeat of `spend` today: its place, category, currency, amount, «Что купили», note and positions. A category
 * the form does not offer is left unchosen. */
export function draftFromSuggestion(spend: ManualSuggestion, chips: Category[], today: string): ExpenseDraft {
  const offered = new Set(chips.map((chip) => chip.id))
  const known = (id: number | null | undefined) => id != null && offered.has(id) ? id : null
  return {
    amount: spend.lines.length ? '' : amountText(spend.total),
    currency: spend.currency,
    category: known(spend.category?.id),
    date: today,
    place: spend.store_name ?? '',
    note: spend.note,
    lines: spend.lines.map((line) => lineFromBody(line, known(line.category))),
    item: spend.lines.length ? '' : spend.item_name ?? '',
  }
}
