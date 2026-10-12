import type { BudgetLimit } from '../../api/budget-types'
import type { Category, LocalApiFailure } from '../../api/types'
import { glue } from '../../lib/text'
import { plural } from './dashboard-state'

/** A row of the limits screen: a category of any level; its spends include those of its descendants. */
export type LimitTreeRow = {
  category: Category
  depth: number
  /** The top-level category the row is under (itself for a top-level row): it opens and closes its sub-categories. */
  rootId: number
  /** How many sub-categories (all levels) a top-level row has; 0 for the others. */
  descendants: number
}

/** The categories as a tree, in the order of `GET /api/categories/` (depth first, siblings by name). */
export function limitTree(categories: Category[]): LimitTreeRow[] {
  const rows = categories.map((category) => ({
    category, depth: category.depth, rootId: category.path[0]?.id ?? category.id, descendants: 0,
  }))
  const roots = new Map(rows.filter((row) => row.depth === 0).map((row) => [row.category.id, row]))
  for (const row of rows) {
    const root = roots.get(row.rootId)
    if (row.depth > 0 && root) root.descendants += 1
  }
  return rows
}

/** Top-level rows whose sub-categories are shown at first: those with a limit (or an unsaved amount) below them. */
export function openByDefault(rows: LimitTreeRow[], limits: BudgetLimit[], currency: string, drafts: Record<string, string> = {}): Set<number> {
  const open = new Set<number>()
  for (const row of rows) {
    if (row.depth === 0) continue
    if (limitFor(limits, row.category.id, currency) || drafts[`${row.category.id}:${currency}`] !== undefined) open.add(row.rootId)
  }
  return open
}

/** What the screen lists: every top-level row, and the sub-categories of the open ones. */
export function visibleRows(rows: LimitTreeRow[], open: (rootId: number) => boolean): LimitTreeRow[] {
  return rows.filter((row) => row.depth === 0 || open(row.rootId))
}

/** «3 подкатегории», «1 подкатегория». */
export function subCategoriesText(count: number): string {
  return glue(String(count), plural(count, 'подкатегория', 'подкатегории', 'подкатегорий'))
}

export const limitMessages = {
  empty: 'Введите сумму лимита.',
  format: 'Сумма — число, например 120000 или 1500,50.',
  places: 'Не больше двух знаков после запятой.',
  zero: 'Лимит должен быть больше нуля.',
  large: 'Слишком большая сумма.',
  currency: 'Валюта — три латинские буквы, например KZT.',
} as const

/** What a person typed into a limit: «120 000», «1500,5» → `120000.00`, `1500.50`. */
export function parseLimitAmount(input: string): { amount: string } | { error: string } {
  const value = input.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!value) return { error: limitMessages.empty }
  if (/^\d+\.\d{3,}$/.test(value)) return { error: limitMessages.places }
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(value)
  if (!match) return { error: limitMessages.format }
  const whole = match[1].replace(/^0+(?=\d)/, '')
  if (whole.length > 12) return { error: limitMessages.large }
  const fraction = (match[2] ?? '').padEnd(2, '0')
  if (/^0+$/.test(whole + fraction)) return { error: limitMessages.zero }
  return { amount: `${whole}.${fraction}` }
}

/** A currency code typed by a person: three Latin letters, any case. */
export function parseCurrency(input: string): { currency: string } | { error: string } {
  const value = input.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(value) ? { currency: value } : { error: limitMessages.currency }
}

/** The value of a limit as a person reads and types it: `120000.00` → «120000», `1500.50` → «1500,50». */
export function amountInput(amount: string): string {
  return amount.replace(/\.00$/, '').replace('.', ',')
}

/** The currencies of the screen: the one of the form defaults first, then those that already have limits, then added ones. */
export function limitCurrencies(defaultCurrency: string, limits: BudgetLimit[], added: string[] = []): string[] {
  const others = [...new Set(limits.map((limit) => limit.currency))].filter((code) => code !== defaultCurrency).sort()
  return [...new Set([defaultCurrency, ...others, ...added])]
}

export function limitFor(limits: BudgetLimit[], categoryId: number, currency: string): BudgetLimit | undefined {
  return limits.find((limit) => limit.category_id === categoryId && limit.currency === currency)
}

export type RowAction =
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'create'; amount: string }
  | { kind: 'update'; id: number; amount: string }

/** What «Сохранить» does for a row: nothing when unchanged, a new limit or a change of the existing one. */
export function rowAction(draft: string | undefined, limit: BudgetLimit | undefined): RowAction {
  if (draft === undefined) return { kind: 'none' }
  const parsed = parseLimitAmount(draft)
  if ('error' in parsed) return { kind: 'invalid', error: parsed.error }
  if (!limit) return { kind: 'create', amount: parsed.amount }
  return parsed.amount === limit.amount ? { kind: 'none' } : { kind: 'update', id: limit.id, amount: parsed.amount }
}

/** The list after the server answered with a saved limit. */
export function withLimit(limits: BudgetLimit[], saved: BudgetLimit): BudgetLimit[] {
  const others = limits.filter((limit) => limit.id !== saved.id
    && !(limit.category_id === saved.category_id && limit.currency === saved.currency))
  return [...others, saved]
}

export function withoutLimit(limits: BudgetLimit[], id: number): BudgetLimit[] {
  return limits.filter((limit) => limit.id !== id)
}

/**
 * A create refused at `category_id`: the screen offers only categories it has just read, so it is the pair «category
 * and currency» already taken — another family member saved a limit meanwhile (the server reports it at `category_id`).
 */
export function isDuplicateCreate(failure: Pick<LocalApiFailure, 'reason' | 'fields'>, creating: boolean): boolean {
  return creating && failure.reason === 'invalid_parameter' && (failure.fields ?? []).includes('category_id')
}

/** Local texts of a refused save or delete; field names only, never server messages. */
export function limitFailureMessage(failure: Pick<LocalApiFailure, 'reason' | 'fields'>, creating = false): string {
  if (isDuplicateCreate(failure, creating)) return 'Лимит для этой категории и валюты уже есть — показан сохранённый. Проверьте сумму и сохраните ещё раз.'
  switch (failure.reason) {
    case 'invalid_parameter': case 'invalid_request': {
      const fields = failure.fields ?? []
      if (fields.includes('amount')) return 'Сервер не принял сумму: нужна сумма больше нуля.'
      if (fields.includes('category_id') || fields.includes('category')) return 'Этой категории уже нет. Обновите страницу.'
      if (fields.includes('currency')) return 'Сервер не принял валюту.'
      if (fields.includes('non_field_errors') || fields.includes('__all__')) return 'Лимит для этой категории и валюты уже есть. Обновите страницу.'
      return 'Сервер не принял лимит. Проверьте сумму и повторите.'
    }
    case 'not_found': return 'Этого лимита уже нет. Обновите страницу.'
    case 'csrf_failed': return 'Сессия устарела. Повторите попытку.'
    case 'permission_denied': return 'Нет права менять лимиты.'
    case 'timeout': return 'Сервер не ответил вовремя. Повторите попытку.'
    case 'network': return 'Не удалось связаться с сервером. Проверьте соединение.'
    case 'database_unavailable': return 'Данные временно недоступны. Повторите попытку позже.'
    default: return 'Не удалось сохранить лимит. Повторите попытку.'
  }
}

/** The rows of this currency that «Сохранить» of the bar sends: a changed or a refused draft. A draft emptied again
 * on a row without a limit is no change. */
export function changedRows(categories: Category[], limits: BudgetLimit[], currency: string, drafts: Record<string, string>): Category[] {
  return categories.filter((category) => {
    const draft = drafts[`${category.id}:${currency}`]
    const limit = limitFor(limits, category.id, currency)
    if (draft !== undefined && !draft.trim() && !limit) return false
    return rowAction(draft, limit).kind !== 'none'
  })
}

/** «Сохранить · 2 изменения» on the bar; «Сохранить» while nothing changed. */
export function saveBarLabel(count: number): string {
  if (count <= 0) return 'Сохранить'
  return `Сохранить · ${glue(count.toLocaleString('ru-RU'), plural(count, 'изменение', 'изменения', 'изменений'))}`
}
