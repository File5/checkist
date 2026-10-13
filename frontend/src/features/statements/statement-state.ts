/** The draft of a bank statement without the network and React: what is checked, what the person changed, the sections
 * of the screen and the body of «Сохранить N трат». */
import type { StatementDetail, StatementRow, StatementRule, StatementRuleAction, StatementSaveRow, StatementSummary } from '../../api/statements'
import type { Category } from '../../api/types'
import { formatCents } from '../../lib/money'
import { glue } from '../../lib/text'

/** One row as the person sees it now: checked or not, the category and the place to save it with. `touched` — the
 * person changed it: answers of the model and new readings of the draft leave it as it is. */
export type RowEdit = { checked: boolean; category: number | null; store: string; touched: boolean }
export type Edits = Record<number, RowEdit>

/** A row that can become a spend or a contribution: money left the card, something is left after the refunds, not saved
 * yet. */
export const saveable = (row: StatementRow) => row.receipt_id === null && !row.contribution_id && row.amount.startsWith('-')
  && row.spend !== '0.00'

/** A contribution to a goal: a transfer by a rule «→ цель», or one whose contribution the goal already has. */
export const asGoal = (row: StatementRow) => Boolean(row.goal) && (row.state === 'goal' || row.reason === 'goal_duplicate')

/** A transfer the person may call a contribution to a goal («Это взнос в цель»). */
export const canBeGoal = (row: StatementRow) => saveable(row) && !asGoal(row) && (row.kind === 'transfer' || row.kind === 'own_move')

/** Checked from the start: a recognised spend, a contribution, and a questionable one that already has a category. */
export function defaultChecked(row: StatementRow): boolean {
  if (!saveable(row)) return false
  return row.state === 'spend' || row.state === 'goal' || (row.state === 'review' && row.category !== null)
}

const editOf = (row: StatementRow): RowEdit => ({
  checked: defaultChecked(row), category: row.category?.id ?? null, store: row.store_name ?? '', touched: false,
})

/** The edits of a draft just read; rows the person touched keep their edit, the rest follow the server. */
export function syncEdits(rows: StatementRow[], previous: Edits = {}): Edits {
  const next: Edits = {}
  for (const row of rows) {
    const kept = previous[row.id]
    next[row.id] = kept?.touched && row.receipt_id === null ? kept : editOf(row)
  }
  return next
}

/** The person checks or unchecks a row. */
export function toggleRow(edits: Edits, id: number, checked: boolean): Edits {
  return { ...edits, [id]: { ...edits[id], checked, touched: true } }
}

/** The person types the place of a row. */
export function setStore(edits: Edits, id: number, store: string): Edits {
  return { ...edits, [id]: { ...edits[id], store, touched: true } }
}

/**
 * The person picks a category for a row: it gets checked. Other unsaved, untouched rows of the same payee that had the
 * same category follow it — one choice per payee, as the rule the server learns from it. `followers` — how many.
 */
export function setCategory(edits: Edits, rows: StatementRow[], id: number, category: number | null): { edits: Edits; followers: number } {
  const row = rows.find((item) => item.id === id)
  if (!row) return { edits, followers: 0 }
  const before = edits[id]?.category ?? null
  const next: Edits = { ...edits, [id]: { ...edits[id], category, checked: category !== null && saveable(row), touched: true } }
  let followers = 0
  for (const other of rows) {
    const edit = edits[other.id]
    if (other.id === id || other.merchant !== row.merchant || !saveable(other) || !edit || edit.touched || edit.category !== before) continue
    if (other.state === 'duplicate' || other.state === 'skipped') continue
    next[other.id] = { ...edit, category, checked: category !== null }
    followers += 1
  }
  return { edits: next, followers }
}

/** The body of «Сохранить»: checked, saveable rows — a spend with its category, a contribution with its goal. */
export function saveRows(rows: StatementRow[], edits: Edits): StatementSaveRow[] {
  return rows.filter((row) => saveable(row) && edits[row.id]?.checked && (asGoal(row) || edits[row.id]?.category !== null))
    .map((row) => row.goal && asGoal(row) ? { id: row.id, goal: row.goal.id }
      : { id: row.id, category: edits[row.id].category as number, store_name: edits[row.id].store.trim() })
}

/** Checked rows still without a category: «Сохранить» waits for them. */
export function missingCategory(rows: StatementRow[], edits: Edits): StatementRow[] {
  return rows.filter((row) => saveable(row) && !asGoal(row) && edits[row.id]?.checked && edits[row.id]?.category === null)
}

/** Exact cents of a wire Decimal: the sum of the button is counted without rounding (`lib/money` rounds the display). */
function cents(value: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value)
  if (!match) return 0n
  const absolute = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0') || '0')
  return match[1] ? -absolute : absolute
}

/** «Сохранить 12 трат и 1 взнос · 245 300 ₸»: the sum only when every row is in one currency. */
export function saveLabel(rows: StatementRow[], edits: Edits): string {
  const chosen = saveRows(rows, edits)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const currencies = new Set(chosen.map((item) => byId.get(item.id)?.currency))
  const count = chosen.length
  const gifts = chosen.filter((item) => 'goal' in item).length
  const spends = count - gifts
  const parts = [spends ? glue(spends, spendWord(spends)) : '', gifts ? glue(gifts, giftWord(gifts)) : ''].filter(Boolean)
  const words = count === 0 ? 'Нечего сохранить' : `Сохранить ${parts.join(' и ')}`
  if (count === 0 || currencies.size !== 1) return words
  const total = chosen.reduce((sum, item) => sum + cents(byId.get(item.id)?.spend ?? '0'), 0n)
  return `${words} · ${formatCents(total, [...currencies][0] as string)}`
}

const plural = (count: number, one: string, few: string, many: string) => {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many
}
export const spendWord = (count: number) => plural(count, 'трату', 'траты', 'трат')
export const rowWord = (count: number) => plural(count, 'строка', 'строки', 'строк')
export const ruleWord = (count: number) => plural(count, 'правило', 'правила', 'правил')
export const giftWord = (count: number) => plural(count, 'взнос', 'взноса', 'взносов')

/** The sections of the screen, in their order. Saved rows and incomings never mix with the rest. */
export type Sections = {
  toSave: StatementRow[]; goals: StatementRow[]; duplicates: StatementRow[]; saved: StatementRow[]; skipped: StatementRow[]; incomes: StatementRow[]
}
export function sections(rows: StatementRow[]): Sections {
  const result: Sections = { toSave: [], goals: [], duplicates: [], saved: [], skipped: [], incomes: [] }
  // Newest first, like «Траты»; within a day the order of the bank.
  const ordered = [...rows].sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
  for (const row of ordered) {
    if (row.receipt_id !== null || row.contribution_id) result.saved.push(row)
    else if (row.kind === 'income') result.incomes.push(row)
    else if (row.state === 'goal') result.goals.push(row)
    else if (row.state === 'duplicate') result.duplicates.push(row)
    else if (row.state === 'skipped') result.skipped.push(row)
    else result.toSave.push(row)
  }
  return result
}

/** Why a row is not checked, in words of the screen. */
export function reasonText(row: StatementRow): string {
  switch (row.reason) {
    case 'duplicate': return row.duplicate_of ? `Уже внесена: ${duplicateText(row)}` : 'Уже внесена'
    case 'bill': return row.duplicate_of ? `Похоже на квитанцию: ${duplicateText(row)}` : 'Похоже на внесённую квитанцию'
    case 'transfer': return 'Перевод человеку'
    case 'cash': return 'Снятие наличных'
    case 'own_move': return 'Между своими счетами или в семье'
    case 'refund': return 'Возврат учтён в покупке того же дня'
    case 'refunded': return 'Покупку вернули полностью'
    case 'rule': return 'Пропускается по правилу'
    case 'goal_duplicate': return `Взнос в «${row.goal?.name ?? 'цель'}» уже есть`
    case 'income': return incomeText(row)
    default: return ''
  }
}

function incomeText(row: StatementRow): string {
  if (/^Перевод/i.test(row.operation)) return 'Перевод вам'
  if (/^(?:Покупка|Возврат)/i.test(row.operation)) return 'Возврат без покупки в тот же день'
  return 'Поступление'
}

/** «12 окт. · MAGNUM · 2 590 ₸» of an already entered spend. */
function duplicateText(row: StatementRow): string {
  const found = row.duplicate_of
  if (!found) return ''
  return [shortDate(found.purchased_on), found.store_name, formatMoneyText(found.total, found.currency)].filter(Boolean).join(' · ')
}

const formatMoneyText = (value: string, currency: string) => formatCents(cents(value), currency)

/** «12 окт.» of a calendar date, without a timezone shift. */
export function shortDate(value: string): string {
  const [year, month, day] = value.split('-').map(Number)
  if (!year || !month || !day) return value
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(Date.UTC(year, month - 1, day))
}

/** The line under the title of a row: the date, then the category or what is going on with it. */
export function rowMeta(row: StatementRow, edit: RowEdit | undefined, categories: Map<number, Category>): string {
  const parts = [shortDate(row.date)]
  const category = edit?.category ?? null
  if (row.receipt_id !== null || row.contribution_id) parts.push('сохранено')
  // Without a category the note under the row says what is going on with it.
  if (row.goal && asGoal(row)) parts.push(`взнос в цель «${row.goal.name}»`)
  else if (category !== null) parts.push(categoryLabel(categories.get(category)) ?? row.category?.name ?? '')
  return parts.filter(Boolean).join(' · ')
}

/** Whether a row asks for a look: no rule knew the payee (the model or nobody suggested its category). */
export const isQuestionable = (row: StatementRow) => row.state === 'review' && row.receipt_id === null

/** What the highlight of a questionable row says. */
export function reviewNote(row: StatementRow, edit: RowEdit | undefined): string {
  if (edit?.touched) return ''
  switch (row.ai) {
    case 'waiting': return 'Незнакомый получатель — спрашиваю модель'
    case 'done': return 'Категорию предложила модель — проверьте'
    case 'unknown': return 'Модель не узнала получателя — выберите категорию'
    case 'failed': return 'Модель не ответила — выберите категорию'
    case 'off': return 'Незнакомый получатель — выберите категорию'
    default: return 'Проверьте категорию'
  }
}

/** «Еда › Кафе»: a nested category with its parent. */
export function categoryLabel(category: Category | undefined): string | undefined {
  if (!category) return undefined
  const names = category.path.map((step) => step.name)
  if (!names.length || names[names.length - 1] !== category.name) names.push(category.name)
  return names.slice(-2).join(' › ')
}

/** Options of the category picker: the whole tree in the order of names, nested ones indented. */
export function categoryOptions(categories: Category[]): { id: number; label: string }[] {
  const pathNames = (category: Category) => {
    const names = category.path.map((step) => step.name)
    if (!names.length || names[names.length - 1] !== category.name) names.push(category.name)
    return names
  }
  return categories.filter((category) => category.name !== 'Не разобрано')
    .map((category) => ({ category, names: pathNames(category) }))
    .sort((a, b) => {
      for (let index = 0; index < Math.min(a.names.length, b.names.length); index += 1) {
        const order = a.names[index].localeCompare(b.names[index], 'ru')
        if (order) return order
      }
      return a.names.length - b.names.length
    })
    .map(({ category, names }) => ({ id: category.id, label: `${'\u2003'.repeat(names.length - 1)}${category.name}` }))
}

/** The draft still waits for the model and the worker is there to answer: read it again a moment later. */
export const keepsPolling = (detail: StatementDetail) => detail.ai.active && detail.ai.waiting > 0 && detail.ai.executor.state !== 'absent'

/** «1 сентября — 30 сентября 2026» is long for a phone: «01.09 — 30.09.2026». */
export function periodText(detail: Pick<StatementDetail, 'date_from' | 'date_to'>): string {
  const { date_from: from, date_to: to } = detail
  if (!from || !to) return ''
  const short = (value: string, year: boolean) => `${value.slice(8, 10)}.${value.slice(5, 7)}${year ? `.${value.slice(0, 4)}` : ''}`
  return `${short(from, from.slice(0, 4) !== to.slice(0, 4))}\u00a0— ${short(to, true)}`
}

/** «Сохранено 12 из 40 строк» under a statement of the history. */
export function historyMeta(item: StatementSummary): string {
  const period = periodText(item)
  const saved = item.saved_count ? `сохранено ${item.saved_count} из ${glue(item.rows_count, rowWord(item.rows_count))}`
    : glue(item.rows_count, rowWord(item.rows_count))
  return [period, saved].filter(Boolean).join(' · ')
}

export const actionLabels: Record<StatementRuleAction, string> = {
  category: 'Категория', skip: 'Пропускать', own: 'Свои счета и семья', goal: 'Взнос в цель',
}

/** «→ Жильё › Аренда · Съёмное жильё», «пропускать», «свои счета и семья». */
export function ruleMeta(rule: StatementRule, byId: Map<number, Category>): string {
  if (rule.action === 'skip') return 'пропускать'
  if (rule.action === 'own') return 'свои счета и семья — не трата'
  if (rule.action === 'goal') return `→ взнос в цель «${rule.goal?.name ?? ''}» · только ваши выписки`
  const category = rule.category ? categoryLabel(byId.get(rule.category.id)) ?? rule.category.name : ''
  return [category && `→ ${category}`, rule.store_name].filter(Boolean).join(' · ')
}
