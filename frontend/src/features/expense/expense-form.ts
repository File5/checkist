/** «Добавить трату»: the draft of the form and its pure rules. No network, no React. */
import type { Line, ManualSpendInput, Receipt } from '../../api/receipts'
import type { Category } from '../../api/types'
import { formatMoney } from '../../lib/money'
import { evaluateAmount, hasOperator } from './amount-calc'

export type LineDraft = { key: number; name: string; amount: string; category: number | null }
export type ExpenseDraft = {
  /** The whole spend; ignored while there are positions: then the total is their sum. */
  amount: string
  currency: string
  category: number | null
  /** `YYYY-MM-DD`, today by default. */
  date: string
  place: string
  note: string
  lines: LineDraft[]
}
/** Messages by field: `amount`, `currency`, `category`, `date`, `place`, `note`, `lines.N.name`, `lines.N.amount`. */
export type ExpenseErrors = Record<string, string>

export const PLACE_MAX = 100
export const NOTE_MAX = 1000
export const NAME_MAX = 200
export const LINES_MAX = 100
/** How many chips are in sight before «Все категории». */
export const CHIPS_SHOWN = 6
const UNASSIGNED = 'Не разобрано'

export const messages = {
  amount: 'Введите сумму больше нуля, не больше двух знаков после запятой.',
  category: 'Выберите категорию.',
  currency: 'Код валюты — три буквы, например KZT.',
  date: 'Укажите дату покупки.',
  place: `Место — не длиннее ${PLACE_MAX} символов.`,
  note: `Комментарий — не длиннее ${NOTE_MAX} символов.`,
  lineName: 'Назовите позицию.',
  lineAmount: 'Сумма позиции больше нуля, не больше двух знаков после запятой.',
  lines: `Не больше ${LINES_MAX} позиций.`,
  total: 'Итог не совпадает с суммой позиций.',
  unknown: 'Проверьте значение.',
} as const

/** Local calendar date of `now`: the default of the date field. */
export function todayISO(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function emptyDraft(currency: string, today = todayISO()): ExpenseDraft {
  return { amount: '', currency, category: null, date: today, place: '', note: '', lines: [] }
}

/** A typed amount as the API decimal: spaces dropped, a comma is the decimal point; «1200+350» is counted
 * (`amount-calc.ts`). `undefined` — not a positive amount. */
export function normalizeAmount(text: string): string | undefined {
  if (hasOperator(text)) return evaluateAmount(text)
  const value = text.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!/^[0-9]{1,12}(?:\.[0-9]{1,2})?$/.test(value)) return undefined
  return /[1-9]/.test(value) ? value : undefined
}

const cents = (value: string) => {
  const [whole, fraction = ''] = value.split('.')
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'))
}

/** Positions with anything typed in them; an untouched empty row is not a position. */
export function filledLines(lines: LineDraft[]): LineDraft[] {
  return lines.filter((line) => line.name.trim() || line.amount.trim())
}

/** For each row of the form, its index in the sent `lines`; `-1` for an untouched empty row, which is not sent. */
export function sentIndexes(lines: LineDraft[]): number[] {
  let next = 0
  return lines.map((line) => line.name.trim() || line.amount.trim() ? next++ : -1)
}

/** The sum of the typed positions as a decimal string; `undefined` while any of them is not a valid amount or none is typed. */
export function linesTotal(lines: LineDraft[]): string | undefined {
  const filled = filledLines(lines)
  if (!filled.length) return undefined
  let total = 0
  for (const line of filled) {
    const amount = normalizeAmount(line.amount)
    if (amount === undefined) return undefined
    total += cents(amount)
  }
  return `${Math.floor(total / 100)}.${String(total % 100).padStart(2, '0')}`
}

/**
 * The body for `POST /api/receipts/manual/` or `PATCH /api/receipts/{id}/`, or the messages of the fields.
 * With positions the total is theirs and the category, if chosen, is the default of positions without their own.
 * `lines` is always sent: an empty list turns an itemized spend back into one amount.
 */
export function draftBody(draft: ExpenseDraft): { body: ManualSpendInput } | { errors: ExpenseErrors } {
  const errors: ExpenseErrors = {}
  const lines = filledLines(draft.lines)
  const currency = draft.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) errors.currency = messages.currency
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(draft.date)) errors.date = messages.date
  const place = draft.place.trim()
  if ([...place].length > PLACE_MAX) errors.place = messages.place
  const note = draft.note.trim()
  if ([...note].length > NOTE_MAX) errors.note = messages.note
  const body: ManualSpendInput = { currency, purchased_on: draft.date, store_name: place || null, note, category: draft.category }
  if (lines.length > LINES_MAX) errors.lines = messages.lines
  if (lines.length) {
    body.lines = lines.map((line, index) => {
      const name = line.name.trim()
      const amount = normalizeAmount(line.amount)
      if (!name) errors[`lines.${index}.name`] = messages.lineName
      else if ([...name].length > NAME_MAX) errors[`lines.${index}.name`] = messages.lineName
      if (amount === undefined) errors[`lines.${index}.amount`] = messages.lineAmount
      return { name, amount: amount ?? '', ...(line.category !== null && { category: line.category }) }
    })
  } else {
    const amount = normalizeAmount(draft.amount)
    if (amount === undefined) errors.amount = messages.amount
    if (draft.category === null) errors.category = messages.category
    body.total = amount
    body.lines = []
  }
  return Object.keys(errors).length ? { errors } : { body }
}

/** Server field names of a refused save, as messages of this form: the server's own texts never reach the screen. */
export function serverErrors(fields: string[]): ExpenseErrors {
  const errors: ExpenseErrors = {}
  for (const field of fields) {
    const line = /^lines\.([0-9]+)\.(name|amount|quantity|category)$/.exec(field)
    if (line) errors[`lines.${line[1]}.${line[2] === 'name' ? 'name' : 'amount'}`] = line[2] === 'name' ? messages.lineName
      : line[2] === 'category' ? messages.category : messages.lineAmount
    else if (field === 'total') errors.amount = messages.total
    else if (field === 'purchased_on') errors.date = messages.date
    else if (field === 'store_name') errors.place = messages.place
    else if (field in messages) errors[field] = messages[field as keyof typeof messages]
    else errors.form = messages.unknown
  }
  return errors
}

let lineKeys = 0
export function newLine(): LineDraft {
  lineKeys += 1
  return { key: lineKeys, name: '', amount: '', category: null }
}

/** «12500.00» -> «12500», «12.50» stays: the field shows what a person would type. */
export function amountText(value: string): string {
  return value.endsWith('.00') ? value.slice(0, -3) : value
}

/**
 * The draft of a saved manual spend. One line named after its category is a spend without positions;
 * anything else keeps its positions with their categories.
 */
export function draftFromReceipt(receipt: Receipt, lines: Line[]): ExpenseDraft {
  const base = { currency: receipt.currency, date: receipt.purchased_on, place: receipt.store?.name ?? '', note: receipt.note }
  const [only] = lines
  if (lines.length === 1 && only.category && only.name === only.category.name) {
    return { ...base, amount: amountText(receipt.total), category: only.category.id, lines: [] }
  }
  return {
    ...base, amount: '', category: null,
    lines: lines.map((line) => ({ ...newLine(), name: line.name, amount: amountText(line.amount), category: line.category?.id ?? null })),
  }
}

/** Chips: the categories of earlier manual spends by use, then every other one in the order of the tree. «Не разобрано» is not offered. */
export function categoryChips(categories: Category[], frequent: number[]): Category[] {
  const offered = categories.filter((category) => category.name !== UNASSIGNED)
  const byId = new Map(offered.map((category) => [category.id, category]))
  const first = frequent.map((id) => byId.get(id)).filter((category): category is Category => category !== undefined)
  const seen = new Set(first.map((category) => category.id))
  return [...first, ...offered.filter((category) => !seen.has(category.id))]
}

/** The label of a chip: a nested category carries its parent, «Еда › Кафе». */
export function chipLabel(category: Category): string {
  const names = category.path.map((step) => step.name)
  if (!names.length || names[names.length - 1] !== category.name) names.push(category.name)
  return names.slice(-2).join(' › ')
}

/** The parent named by a chip of a nested category, «Еда» of «Еда › Кафе»: the chip shows «Кафе» with the dot of the
 * family colour, the parent is said to a screen reader and in the tooltip. `undefined` for a root category. */
export function chipParent(category: Category): string | undefined {
  const [parent] = chipLabel(category).split(' › ').slice(-2, -1)
  return parent
}

/** The chips in sight: the first `CHIPS_SHOWN`, and the chosen one even when it lies further. */
export function visibleChips(chips: Category[], selected: number | null, expanded: boolean): Category[] {
  if (expanded) return chips
  const shown = chips.slice(0, CHIPS_SHOWN)
  const chosen = chips.find((category) => category.id === selected)
  return chosen && !shown.includes(chosen) ? [...shown, chosen] : shown
}

/** The sum of positions in the read-only amount: «21 780» for "21780.00", «350,50» for "350.50" — exact, as a person
 * would write it (the field is not a shown money amount and is not rounded). */
export function sumText(value: string): string {
  const [whole, fraction] = amountText(value).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
  return fraction === undefined ? grouped : `${grouped},${fraction}`
}

/** «Сохранить · 4 501 KZT»: the amount that will be saved, rounded up to whole units like every amount on screen
 * (`lib/money.ts`); just «Сохранить» while there is no valid amount yet. */
export function saveLabel(draft: ExpenseDraft): string {
  const itemized = filledLines(draft.lines).length > 0
  const amount = itemized ? linesTotal(draft.lines) : normalizeAmount(draft.amount)
  const currency = draft.currency.trim().toUpperCase()
  return amount ? `Сохранить · ${formatMoney(amount, /^[A-Z]{3}$/.test(currency) ? currency : '')}` : 'Сохранить'
}

/** The day before a calendar date, counted on the calendar (no time zone, no daylight saving). */
export function dayBefore(day: string): string {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10)
}

/** Which date chip is chosen: «Сегодня», «Вчера» or the calendar. */
export function dateChoice(date: string, today: string): 'today' | 'yesterday' | 'other' {
  if (date === today) return 'today'
  return date === dayBefore(today) ? 'yesterday' : 'other'
}

/** «12.09» for a day of the current year, «12.09.25» otherwise: the date chip of the calendar, short enough for the
 * row «Когда» of a phone. The full date stays in the field itself and in `<time dateTime>`. */
export function shortDay(day: string, today: string): string {
  const [year, month, date] = day.split('-')
  if (!year || !month || !date) return day
  return year === today.slice(0, 4) ? `${date}.${month}` : `${date}.${month}.${year.slice(2)}`
}

/** The colour of a chip (`--ck-cat-N`): the colour of its root category, the same family colour on every screen. */
export function chipToneId(category: Category): number {
  return category.path[0]?.id ?? category.id
}

/** Names from the root to the category itself. */
function pathNames(category: Category): string[] {
  const names = category.path.map((step) => step.name)
  if (!names.length || names[names.length - 1] !== category.name) names.push(category.name)
  return names
}

const fold = (text: string) => text.toLocaleLowerCase('ru-RU').replaceAll('ё', 'е').trim()

export type CategoryTreeRow = { category: Category; depth: number; label: string }

/**
 * «Все категории» in a sheet: the tree in the order of its paths, each row indented by its depth. With a search —
 * only the categories whose path has the words, flat, each named by its whole path («Еда › Кафе»).
 */
export function categoryTree(categories: Category[], search = ''): CategoryTreeRow[] {
  const rows = categories.map((category) => ({ category, names: pathNames(category) }))
    .sort((a, b) => {
      for (let index = 0; index < Math.min(a.names.length, b.names.length); index += 1) {
        const order = a.names[index].localeCompare(b.names[index], 'ru')
        if (order) return order
      }
      return a.names.length - b.names.length
    })
  const words = fold(search).split(/\s+/).filter(Boolean)
  if (!words.length) return rows.map(({ category, names }) => ({ category, depth: names.length - 1, label: category.name }))
  return rows.filter(({ names }) => { const text = fold(names.join(' ')); return words.every((word) => text.includes(word)) })
    .map(({ category, names }) => ({ category, depth: 0, label: names.join(' › ') }))
}

/**
 * How far to scroll so that a focused field stays above the save bar and the keyboard: `bottom` — the bottom of the
 * field, `visible` — the bottom of the visible part of the window, `reserved` — the height of the bar. 0 — in view.
 */
export function fieldScrollDelta(bottom: number, visible: number, reserved: number, margin = 12): number {
  const limit = visible - reserved - margin
  return bottom > limit ? Math.ceil(bottom - limit) : 0
}

/** Notice for the receipt page after a save, on the page of that spend. The page reads it into its state and clears it. */
let notice: { id: number; message: string } | undefined
export function setExpenseNotice(id: number, message: string) { notice = { id, message } }
export function getExpenseNotice(id: number): string | undefined { return notice?.id === id ? notice.message : undefined }
export function clearExpenseNotice() { notice = undefined }
export const savedNotice = 'Трата сохранена.'
export const updatedNotice = 'Изменения сохранены.'
